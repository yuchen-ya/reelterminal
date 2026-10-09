import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../project-store";
import { loadMediaBlob } from "../../services/media-storage";

const { importFile, generateThumbnailsForMedia, saveMediaBlob, storedBlobs } = vi.hoisted(() => ({
  importFile: vi.fn(),
  generateThumbnailsForMedia: vi.fn(async () => [] as { timestamp: number; dataUrl: string }[]),
  saveMediaBlob: vi.fn(),
  storedBlobs: new Map<string, { projectId: string; blob: Blob; contentHash: string }>(),
}));

const hashBlob = async (blob: Blob): Promise<string> => {
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const readBlobText = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsText(blob);
});

beforeAll(() => {
  if (typeof Blob.prototype.arrayBuffer === "function") return;
  Object.defineProperty(Blob.prototype, "arrayBuffer", {
    configurable: true,
    value(this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    },
  });
});

vi.mock("../../services/media-storage", () => ({
  saveMediaBlob,
  deleteMediaBlob: vi.fn(async (mediaId: string) => { storedBlobs.delete(mediaId); }),
  loadMediaBlob: vi.fn(async (mediaId: string) => storedBlobs.get(mediaId)?.blob ?? null),
  loadMediaRecord: vi.fn(async (mediaId: string) => storedBlobs.get(mediaId) ?? null),
  getMediaIdsByProject: vi.fn(async (projectId: string) => [...storedBlobs.entries()]
    .filter(([, record]) => record.projectId === projectId).map(([mediaId]) => mediaId)),
  getAllStoredMedia: vi.fn(async () => [...storedBlobs.entries()].map(([id, record]) => ({
    id, ...record, sizeBytes: record.blob.size,
  }))),
  loadProjectMedia: vi.fn(async () => []),
  loadFileHandle: vi.fn(async () => null),
  loadDirectoryHandle: vi.fn(async () => null),
  withMediaReferenceWrite: async <T>(operation: () => Promise<T> | T) => operation(),
}));

vi.mock("../../services/project-media-gc", () => ({
  attachProjectMediaGc: vi.fn(),
  detachProjectMediaGc: vi.fn(),
  ensureProjectMediaGc: vi.fn(),
  reconcileProjectMediaBytes: vi.fn(async () => undefined),
  releaseUncommittedMediaBlob: vi.fn(),
  trackUncommittedMediaBlob: vi.fn(),
}));

vi.mock("../../bridges/media-bridge", () => ({
  getMediaBridge: vi.fn(() => ({
    isInitialized: vi.fn(() => true),
    importFile,
    generateThumbnailsForMedia,
  })),
  initializeMediaBridge: vi.fn(async () => undefined),
}));

describe("immutable project media versions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storedBlobs.clear();
    importFile.mockImplementation(async (file: File) => ({
      success: true,
      media: {
        blob: file,
        thumbnails: [],
        waveformData: null,
        metadata: {
          duration: file.name.startsWith("short") ? 1 : 3,
          width: 640,
          height: 360,
          frameRate: 30,
          codec: "h264",
          sampleRate: 0,
          channels: 0,
          hasVideo: true,
          hasAudio: false,
        },
      },
    }));
    saveMediaBlob.mockImplementation(async (projectId: string, mediaId: string, blob: Blob) => {
      const contentHash = await hashBlob(blob);
      const existing = storedBlobs.get(mediaId);
      if (existing && (existing.projectId !== projectId || existing.contentHash !== contentHash)) {
        throw new Error("Media version is immutable");
      }
      storedBlobs.set(mediaId, { projectId, blob, contentHash });
      return { contentHash, created: !existing };
    });
    useProjectStore.getState().createNewProject("Immutable media");
  });

  async function importAsset(content: string, name: string): Promise<string> {
    const result = await useProjectStore.getState().importMedia(
      new File([content], name, { type: "video/mp4" }),
    );
    if (!result.success || !result.actionId) throw new Error("seed media import failed");
    return result.actionId;
  }

  it("replaces a source by creating a new media id and preserving old bytes", async () => {
    const oldMediaId = await importAsset("old-bytes", "clip-v1.mp4");
    const track = await useProjectStore.getState().addTrack("video");
    expect(track.success).toBe(true);
    const clip = await useProjectStore.getState().addClipToNewTrack(oldMediaId, 0);
    expect(clip.success).toBe(true);

    const result = await useProjectStore.getState().replaceMediaAsset(
      oldMediaId,
      new File(["new-bytes"], "clip-v2.mp4", { type: "video/mp4" }),
    );

    expect(result.success).toBe(true);
    expect(result.actionId).toBeTruthy();
    expect(result.actionId).not.toBe(oldMediaId);
    const oldBytes = await loadMediaBlob(oldMediaId);
    const newBytes = await loadMediaBlob(result.actionId!);
    expect(await readBlobText(oldBytes as Blob)).toBe("old-bytes");
    expect(await readBlobText(newBytes as Blob)).toBe("new-bytes");

    const project = useProjectStore.getState().project;
    expect(project.mediaLibrary.items.map((item) => item.id)).toEqual([oldMediaId, result.actionId]);
    expect(project.mediaLibrary.items.find((item) => item.id === result.actionId)?.versionSource)
      .toMatchObject({ supersedesMediaIdInProject: oldMediaId, replacedBy: "user" });
    expect(project.timeline.tracks.flatMap((entry) => entry.clips)[0]?.mediaId).toBe(result.actionId);
  });

  it("keeps the old version and commits nothing when replacement ranges are invalid", async () => {
    const oldMediaId = await importAsset("old-bytes", "clip-v1.mp4");
    await useProjectStore.getState().addTrack("video");
    await useProjectStore.getState().addClipToNewTrack(oldMediaId, 0);
    useProjectStore.setState((state) => ({
      project: {
        ...state.project,
        timeline: {
          ...state.project.timeline,
          tracks: state.project.timeline.tracks.map((track) => ({
            ...track,
            clips: track.clips.map((clip) => clip.mediaId === oldMediaId
              ? { ...clip, inPoint: 2, outPoint: 3, duration: 1 }
              : clip),
          })),
        },
      },
    }));
    const beforeCount = useProjectStore.getState().project.mediaLibrary.items.length;

    const result = await useProjectStore.getState().replaceMediaAsset(
      oldMediaId,
      new File(["short"], "short-replacement.mp4", { type: "video/mp4" }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_PARAMS");
    expect(useProjectStore.getState().project.mediaLibrary.items).toHaveLength(beforeCount);
    expect(await readBlobText((await loadMediaBlob(oldMediaId)) as Blob)).toBe("old-bytes");
  });

  it("relinks only identical bytes and preserves the media id", async () => {
    const mediaId = await importAsset("stable-bytes", "shot.mp4");
    useProjectStore.setState((state) => ({
      project: {
        ...state.project,
        mediaLibrary: {
          ...state.project.mediaLibrary,
          items: state.project.mediaLibrary.items.map((item) => item.id === mediaId
            ? { ...item, blob: null, isPlaceholder: true }
            : item),
        },
      },
    }));
    const before = await hashBlob((await loadMediaBlob(mediaId)) as Blob);

    const wrong = await useProjectStore.getState().relinkMediaAsset(
      mediaId,
      new File(["other-bytes"], "shot.mp4", { type: "video/mp4" }),
    );
    expect(wrong.success).toBe(false);
    expect(wrong.error?.message).toMatch(/do not match/i);

    const linked = await useProjectStore.getState().relinkMediaAsset(
      mediaId,
      new File(["stable-bytes"], "shot-moved.mp4", { type: "video/mp4" }),
      "Moved",
    );
    expect(linked.success).toBe(true);
    expect(useProjectStore.getState().project.mediaLibrary.items).toHaveLength(1);
    expect(useProjectStore.getState().getMediaItem(mediaId)).toMatchObject({
      id: mediaId,
      isPlaceholder: false,
      sourceFile: { name: "shot-moved.mp4", folder: "Moved" },
      contentHash: before,
    });
  });
});
