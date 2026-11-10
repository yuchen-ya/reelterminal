import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../project-store";

const { importFile, generateThumbnailsForMedia, saveMediaBlob } = vi.hoisted(() => ({
  importFile: vi.fn(),
  generateThumbnailsForMedia: vi.fn(),
  saveMediaBlob: vi.fn(),
}));
vi.mock("../../bridges/media-bridge", () => ({
  getMediaBridge: () => ({ isInitialized: () => true, importFile, generateThumbnailsForMedia }),
  initializeMediaBridge: vi.fn(),
}));
vi.mock("../../services/media-storage", () => ({
  saveMediaBlob,
  withMediaReferenceWrite: async <T>(fn: () => Promise<T> | T) => fn(),
  getMediaIdsByProject: vi.fn(async () => []),
  loadProjectMedia: vi.fn(async () => []),
  loadFileHandle: vi.fn(async () => null),
  loadDirectoryHandle: vi.fn(async () => null),
}));
vi.mock("../../services/project-media-gc", () => ({
  attachProjectMediaGc: vi.fn(), detachProjectMediaGc: vi.fn(), ensureProjectMediaGc: vi.fn(),
  reconcileProjectMediaBytes: vi.fn(), releaseUncommittedMediaBlob: vi.fn(), trackUncommittedMediaBlob: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const saved = { contentHash: "a".repeat(64), created: true, contentUrl: "/controlled/clip.mp4" };
const thumbs = [{ timestamp: 0, dataUrl: "data:image/jpeg;base64,preview" }];
function videoFile(size = 300 * 1024 * 1024): File {
  const file = new File(["fixture"], "large.mp4", { type: "video/mp4" });
  // Size selects behavior only; these are scheduling/contract tests, not a
  // real import throughput benchmark. The desktop E2E generates actual bytes.
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("quick media import preview scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    useProjectStore.getState().createNewProject("Quick import");
    importFile.mockImplementation(async (file: File) => ({ success: true, media: {
      blob: file, thumbnails: [], waveformData: null,
      metadata: { duration: 24, width: 1280, height: 720, frameRate: 24, codec: "h264", hasVideo: true, hasAudio: true },
    } }));
    saveMediaBlob.mockResolvedValue(saved);
    generateThumbnailsForMedia.mockResolvedValue(thumbs);
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("publishes a durable large import before starting thumbnails", async () => {
    const file = videoFile();
    const persistence = deferred<typeof saved>();
    saveMediaBlob.mockReturnValue(persistence.promise);
    const resultPromise = useProjectStore.getState().importMedia(file, { historyOwner: "human" });
    await vi.waitFor(() => expect(saveMediaBlob).toHaveBeenCalledOnce());
    expect(importFile).toHaveBeenCalledWith(file, true, true);
    expect(generateThumbnailsForMedia).not.toHaveBeenCalled();
    expect(useProjectStore.getState().project.mediaLibrary.items).toHaveLength(0);
    persistence.resolve(saved);
    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(useProjectStore.getState().project.mediaLibrary.items[0]).toMatchObject({ blob: file, contentHash: saved.contentHash, thumbnailUrl: null });
    expect(generateThumbnailsForMedia).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(generateThumbnailsForMedia).toHaveBeenCalledExactlyOnceWith(file, "video");
    expect(useProjectStore.getState().project.mediaLibrary.items[0].thumbnailUrl).toBe(thumbs[0].dataUrl);
    await useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.mediaLibrary.items).toHaveLength(0);
    await useProjectStore.getState().redo();
    expect(useProjectStore.getState().project.mediaLibrary.items[0]).toMatchObject({ id: result.actionId, contentHash: saved.contentHash, blob: file });
  });

  it("keeps the existing synchronous thumbnail fallback for small videos", async () => {
    const file = videoFile(50 * 1024 * 1024);
    const preview = deferred<typeof thumbs>();
    generateThumbnailsForMedia.mockReturnValue(preview.promise);
    const importing = useProjectStore.getState().importMedia(file);
    await vi.waitFor(() => expect(generateThumbnailsForMedia).toHaveBeenCalledOnce());
    expect(importFile).toHaveBeenCalledWith(file, true, false);
    expect(saveMediaBlob).not.toHaveBeenCalled();
    preview.resolve(thumbs);
    expect((await importing).success).toBe(true);
  });

  it.each(["project", "revision"])("rejects an import if its %s changes during persistence", async (change) => {
    const persistence = deferred<typeof saved>();
    saveMediaBlob.mockReturnValue(persistence.promise);
    const store = useProjectStore.getState();
    const importing = store.importMedia(videoFile(), { expectedRevision: store.projectRevision });
    await vi.waitFor(() => expect(saveMediaBlob).toHaveBeenCalledOnce());
    if (change === "project") useProjectStore.getState().createNewProject("Other project");
    else await useProjectStore.getState().addTrack("video");
    persistence.resolve(saved);
    expect((await importing).success).toBe(false);
    expect(useProjectStore.getState().project.mediaLibrary.items).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(generateThumbnailsForMedia).not.toHaveBeenCalled();
  });

  it.each(["project", "undo", "blob"])("does not apply a late thumbnail after %s changes", async (change) => {
    const preview = deferred<typeof thumbs>();
    generateThumbnailsForMedia.mockReturnValue(preview.promise);
    const result = await useProjectStore.getState().importMedia(videoFile(), { historyOwner: "human" });
    expect(result.success).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(generateThumbnailsForMedia).toHaveBeenCalledOnce();
    if (change === "project") useProjectStore.getState().createNewProject("Other project");
    else if (change === "undo") await useProjectStore.getState().undo();
    else useProjectStore.setState(state => ({ project: { ...state.project, mediaLibrary: { ...state.project.mediaLibrary,
      items: state.project.mediaLibrary.items.map(item => ({ ...item, blob: new Blob(["other"]) })),
    } } }));
    const before = useProjectStore.getState().project;
    preview.resolve(thumbs);
    await Promise.resolve();
    await Promise.resolve();
    expect(useProjectStore.getState().project).toBe(before);
  });

  it("does not publish or schedule previews when persistence fails", async () => {
    saveMediaBlob.mockRejectedValue(new Error("disk full"));
    expect((await useProjectStore.getState().importMedia(videoFile())).success).toBe(false);
    expect(useProjectStore.getState().project.mediaLibrary.items).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(generateThumbnailsForMedia).not.toHaveBeenCalled();
  });
});
