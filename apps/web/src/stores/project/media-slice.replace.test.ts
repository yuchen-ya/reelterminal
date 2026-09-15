import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../project-store";
import { loadMediaBlob } from "../../services/media-storage";

// In-memory stand-in for the IndexedDB media store. saveMediaBlob writes the
// exact Blob handed in by the slice, loadMediaBlob reads it back, so the
// assertions exercise the same "replace -> read persisted bytes" contract the
// recovery path performs after a save/reload. No real storage is touched.
const { importFile, saveMediaBlob, deleteMediaBlob, storedBlobs } = vi.hoisted(
  () => ({
    importFile: vi.fn(),
    saveMediaBlob: vi.fn(),
    deleteMediaBlob: vi.fn(),
    storedBlobs: new Map<string, Blob>(),
  }),
);

// jsdom's Blob does not implement .text(); read persisted content via the
// FileReader the recovery/preview paths also rely on.
const readBlobText = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

vi.mock("../../services/media-storage", () => ({
  saveMediaBlob,
  deleteMediaBlob,
  loadMediaBlob: vi.fn(
    async (mediaId: string) => storedBlobs.get(mediaId) ?? null,
  ),
  loadProjectMedia: vi.fn(async () => []),
  loadFileHandle: vi.fn(async () => null),
  loadDirectoryHandle: vi.fn(async () => null),
}));

vi.mock("../../bridges/media-bridge", () => ({
  getMediaBridge: vi.fn(() => ({
    isInitialized: vi.fn(() => true),
    importFile,
  })),
  initializeMediaBridge: vi.fn(async () => undefined),
}));

describe("replaceMediaAsset persistence", () => {
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
          duration: 3,
          width: 640,
          height: 360,
          frameRate: 0,
          codec: "",
          sampleRate: 0,
          channels: 0,
          hasVideo: false,
          hasAudio: false,
        },
      },
    }));
    saveMediaBlob.mockImplementation(
      async (_projectId: string, mediaId: string, blob: Blob) => {
        storedBlobs.set(mediaId, blob);
      },
    );
    deleteMediaBlob.mockImplementation(async (mediaId: string) => {
      storedBlobs.delete(mediaId);
    });
    useProjectStore.getState().createNewProject("Replace persistence");
  });

  const importExistingAsset = async (content: string, name: string) => {
    const imported = await useProjectStore
      .getState()
      .importMedia(new File([content], name, { type: "image/png" }));
    if (!imported.success || !imported.actionId) {
      throw new Error("seed import failed");
    }
    return imported.actionId;
  };

  it("persists the replacement bytes under the same media id before publishing the new entry", async () => {
    const mediaId = await importExistingAsset("old-bytes", "clip-v1.png");

    const replacement = new File(["new-bytes"], "clip-v2.png", {
      type: "image/png",
    });
    const result = await useProjectStore
      .getState()
      .replaceMediaAsset(mediaId, replacement);

    expect(result.success).toBe(true);

    // What project recovery reads back after save/reload must be the new file.
    const persisted = await loadMediaBlob(mediaId);
    expect(persisted).not.toBeNull();
    expect(await readBlobText(persisted as Blob)).toBe("new-bytes");

    const item = useProjectStore
      .getState()
      .project.mediaLibrary.items.find((media) => media.id === mediaId);
    expect(item?.name).toBe("clip-v2.png");
    expect(item?.metadata.fileSize).toBe(replacement.size);
  });

  it("keeps the previous entry and stored bytes when persisting the replacement fails", async () => {
    const mediaId = await importExistingAsset("old-bytes", "clip-v1.png");

    saveMediaBlob.mockRejectedValueOnce(new Error("quota exceeded"));

    const result = await useProjectStore
      .getState()
      .replaceMediaAsset(
        mediaId,
        new File(["new-bytes"], "clip-v2.png", { type: "image/png" }),
      );

    expect(result.success).toBe(false);
    const item = useProjectStore
      .getState()
      .project.mediaLibrary.items.find((media) => media.id === mediaId);
    expect(item?.name).toBe("clip-v1.png");
    const persisted = await loadMediaBlob(mediaId);
    expect(persisted).not.toBeNull();
    expect(await readBlobText(persisted as Blob)).toBe("old-bytes");
  });

  it("keeps the lifecycle placeholder relink path durable", async () => {
    // Simulate a project reloaded from disk: entry exists, blob is missing and
    // the item is flagged as a placeholder (lifecycle-slice reconnects it via
    // replaceMediaAsset, see lifecycle-slice.ts Tier 1/Tier 2 relink).
    const mediaId = await importExistingAsset("old-bytes", "clip-v1.png");
    useProjectStore.setState((state) => ({
      project: {
        ...state.project,
        mediaLibrary: {
          ...state.project.mediaLibrary,
          items: state.project.mediaLibrary.items.map((media) =>
            media.id === mediaId
              ? {
                  ...media,
                  isPlaceholder: true,
                  sourceFile: {
                    name: "clip-v2.png",
                    size: 9,
                    lastModified: 1,
                    folder: "Assets",
                  },
                }
              : media,
          ),
        },
      },
    }));

    // Exact call shape used by the lifecycle auto-reconnect.
    const result = await useProjectStore
      .getState()
      .replaceMediaAsset(
        mediaId,
        new File(["new-bytes"], "clip-v2.png", { type: "image/png" }),
        "Assets",
      );

    expect(result.success).toBe(true);
    const persisted = await loadMediaBlob(mediaId);
    expect(persisted).not.toBeNull();
    expect(await readBlobText(persisted as Blob)).toBe("new-bytes");

    const item = useProjectStore
      .getState()
      .project.mediaLibrary.items.find((media) => media.id === mediaId);
    expect(item?.isPlaceholder).toBe(false);
    expect(item?.sourceFile?.folder).toBe("Assets");
  });
});
