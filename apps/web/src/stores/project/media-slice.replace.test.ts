import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../project-store";
import { loadMediaBlob } from "../../services/media-storage";

// In-memory stand-in for the IndexedDB media store. saveMediaBlob writes the
// exact Blob handed in by the slice, loadMediaBlob reads it back, so the
// assertions exercise the same "replace -> read persisted bytes" contract the
// recovery path performs after a save/reload. No real storage is touched.
const {
  importFile,
  generateThumbnailsForMedia,
  saveMediaBlob,
  deleteMediaBlob,
  storedBlobs,
} = vi.hoisted(
  () => ({
    importFile: vi.fn(),
    generateThumbnailsForMedia: vi.fn(async (_blob: Blob) =>
      [] as { timestamp: number; dataUrl: string }[],
    ),
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
  getMediaIdsByProject: vi.fn(async () => []),
  loadProjectMedia: vi.fn(async () => []),
  loadFileHandle: vi.fn(async () => null),
  loadDirectoryHandle: vi.fn(async () => null),
}));

vi.mock("../../bridges/media-bridge", () => ({
  getMediaBridge: vi.fn(() => ({
    isInitialized: vi.fn(() => true),
    importFile,
    generateThumbnailsForMedia,
  })),
  initializeMediaBridge: vi.fn(async () => undefined),
}));

describe("replaceMediaAsset persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storedBlobs.clear();
    generateThumbnailsForMedia.mockResolvedValue([]);
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

  it("preserves edits made while decoding a replacement", async () => {
    const mediaId = await importExistingAsset("old-bytes", "clip-v1.png");
    let finishDecode!: () => void;
    const decoding = new Promise<void>((resolve) => { finishDecode = resolve; });
    const decode = importFile.getMockImplementation()!;
    importFile.mockImplementationOnce(async (file: File) => {
      await decoding;
      return decode(file);
    });

    const pending = useProjectStore.getState().replaceMediaAsset(
      mediaId,
      new File(["new-bytes"], "clip-v2.png", { type: "image/png" }),
    );
    useProjectStore.setState((state) => ({
      project: { ...state.project, name: "Edited during decoding" },
    }));
    finishDecode();

    expect((await pending).success).toBe(true);
    expect(useProjectStore.getState().project.name).toBe("Edited during decoding");
    expect(useProjectStore.getState().getMediaItem(mediaId)?.name).toBe("clip-v2.png");
  });

  it("does not restore a project that was closed while decoding a replacement", async () => {
    const mediaId = await importExistingAsset("old-bytes", "clip-v1.png");
    let finishDecode!: () => void;
    const decoding = new Promise<void>((resolve) => { finishDecode = resolve; });
    const decode = importFile.getMockImplementation()!;
    importFile.mockImplementationOnce(async (file: File) => {
      await decoding;
      return decode(file);
    });

    const pending = useProjectStore.getState().replaceMediaAsset(
      mediaId,
      new File(["new-bytes"], "clip-v2.png", { type: "image/png" }),
    );
    useProjectStore.getState().createNewProject("Other project");
    const otherProjectId = useProjectStore.getState().project.id;
    saveMediaBlob.mockClear();
    finishDecode();

    expect((await pending).success).toBe(false);
    expect(useProjectStore.getState().project.id).toBe(otherProjectId);
    expect(saveMediaBlob).not.toHaveBeenCalled();
  });

  it("does not replace media in a reopened session with the same project id", async () => {
    const mediaId = await importExistingAsset("old-bytes", "clip-v1.png");
    let finishDecode!: () => void;
    const decoding = new Promise<void>((resolve) => { finishDecode = resolve; });
    const decode = importFile.getMockImplementation()!;
    importFile.mockImplementationOnce(async (file: File) => {
      await decoding;
      return decode(file);
    });

    const previousState = useProjectStore.getState();
    const pending = previousState.replaceMediaAsset(
      mediaId,
      new File(["new-bytes"], "clip-v2.png", { type: "image/png" }),
    );
    useProjectStore.getState().loadProject({ ...previousState.project });
    const reopenedState = useProjectStore.getState();
    expect(reopenedState.project.id).toBe(previousState.project.id);
    expect(reopenedState.actionExecutor).not.toBe(previousState.actionExecutor);
    saveMediaBlob.mockClear();
    finishDecode();

    expect((await pending).success).toBe(false);
    expect(useProjectStore.getState().project.id).toBe(previousState.project.id);
    expect(saveMediaBlob).not.toHaveBeenCalled();
    expect(useProjectStore.getState().getMediaItem(mediaId)?.name).toBe("clip-v1.png");
  });

  it("restores the saved bytes when the project changes during replacement persistence", async () => {
    const mediaId = await importExistingAsset("old-bytes", "clip-v1.png");
    let finishSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    saveMediaBlob.mockClear();
    saveMediaBlob.mockImplementationOnce(
      async (_projectId: string, id: string, blob: Blob) => {
        storedBlobs.set(id, blob);
        await saveGate;
      },
    );

    const pending = useProjectStore.getState().replaceMediaAsset(
      mediaId,
      new File(["new-bytes"], "clip-v2.png", { type: "image/png" }),
    );
    await vi.waitFor(() => expect(saveMediaBlob).toHaveBeenCalledTimes(1));
    useProjectStore.getState().createNewProject("Other project");
    const otherProjectId = useProjectStore.getState().project.id;
    finishSave();

    expect((await pending).success).toBe(false);
    expect(useProjectStore.getState().project.id).toBe(otherProjectId);
    const persisted = await loadMediaBlob(mediaId);
    expect(persisted).not.toBeNull();
    expect(await readBlobText(persisted as Blob)).toBe("old-bytes");
  });

  it("serializes concurrent replacements for the same media id", async () => {
    const mediaId = await importExistingAsset("old-bytes", "clip-v1.png");
    let finishFirstSave!: () => void;
    const firstSaveGate = new Promise<void>((resolve) => {
      finishFirstSave = resolve;
    });
    saveMediaBlob.mockClear();
    saveMediaBlob.mockImplementation(
      async (_projectId: string, id: string, blob: Blob) => {
        storedBlobs.set(id, blob);
        if (saveMediaBlob.mock.calls.length === 1) await firstSaveGate;
      },
    );

    const first = useProjectStore.getState().replaceMediaAsset(
      mediaId,
      new File(["first-replacement"], "clip-v2.png", { type: "image/png" }),
    );
    await vi.waitFor(() => expect(saveMediaBlob).toHaveBeenCalledTimes(1));
    const second = useProjectStore.getState().replaceMediaAsset(
      mediaId,
      new File(["second-replacement"], "clip-v3.png", { type: "image/png" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveMediaBlob).toHaveBeenCalledTimes(1);

    finishFirstSave();
    expect((await first).success).toBe(true);
    expect((await second).success).toBe(true);

    const persisted = await loadMediaBlob(mediaId);
    expect(persisted).not.toBeNull();
    expect(await readBlobText(persisted as Blob)).toBe("second-replacement");
    expect(useProjectStore.getState().getMediaItem(mediaId)?.name).toBe("clip-v3.png");
  });

  it("does not attach a decoded import to a project opened during decoding", async () => {
    let finishDecode!: () => void;
    const decoding = new Promise<void>((resolve) => {
      finishDecode = resolve;
    });
    const decode = importFile.getMockImplementation()!;
    importFile.mockImplementationOnce(async (file: File) => {
      await decoding;
      return decode(file);
    });
    saveMediaBlob.mockClear();

    const previousState = useProjectStore.getState();
    const pending = previousState.importMedia(
      new File(["media-bytes"], "import.png", { type: "image/png" }),
    );
    useProjectStore.getState().loadProject({ ...previousState.project });
    const reopenedState = useProjectStore.getState();
    expect(reopenedState.project.id).toBe(previousState.project.id);
    expect(reopenedState.actionExecutor).not.toBe(previousState.actionExecutor);
    finishDecode();

    expect((await pending).success).toBe(false);
    expect(useProjectStore.getState().project.id).toBe(previousState.project.id);
    expect(saveMediaBlob).not.toHaveBeenCalled();
  });

  it("discards imported bytes when the project session changes during persistence", async () => {
    let finishSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    saveMediaBlob.mockClear();
    saveMediaBlob.mockImplementationOnce(
      async (_projectId: string, id: string, blob: Blob) => {
        storedBlobs.set(id, blob);
        await saveGate;
      },
    );

    const previousState = useProjectStore.getState();
    const pending = previousState.importMedia(
      new File(["media-bytes"], "import.png", { type: "image/png" }),
    );
    await vi.waitFor(() => expect(saveMediaBlob).toHaveBeenCalledTimes(1));
    useProjectStore.getState().loadProject({ ...previousState.project });
    const reopenedState = useProjectStore.getState();
    expect(reopenedState.project.id).toBe(previousState.project.id);
    expect(reopenedState.actionExecutor).not.toBe(previousState.actionExecutor);
    const mediaId = saveMediaBlob.mock.calls[0][1];
    finishSave();

    expect((await pending).success).toBe(false);
    expect(deleteMediaBlob).toHaveBeenCalledWith(mediaId);
    expect(storedBlobs.has(mediaId)).toBe(false);
    expect(useProjectStore.getState().project.mediaLibrary.items).toHaveLength(0);
  });

  it("does not apply a delayed import thumbnail after the media id is replaced", async () => {
    let finishThumbnail!: (thumbnails: { timestamp: number; dataUrl: string }[]) => void;
    const thumbnailGate = new Promise<{ timestamp: number; dataUrl: string }[]>(
      (resolve) => {
        finishThumbnail = resolve;
      },
    );
    let signalDelayedThumbnailStarted!: () => void;
    const delayedThumbnailStarted = new Promise<void>((resolve) => {
      signalDelayedThumbnailStarted = resolve;
    });
    const oldFile = new File(["old-video"], "clip-v1.mp4", { type: "video/mp4" });
    const replacement = new File(["new-video"], "clip-v2.mp4", { type: "video/mp4" });
    let oldFileThumbnailCalls = 0;
    importFile.mockImplementation(async (file: File) => ({
      success: true,
      media: {
        blob: file,
        thumbnails: [],
        waveformData: null,
        metadata: {
          duration: 2,
          width: 320,
          height: 180,
          frameRate: 30,
          codec: "h264",
          sampleRate: 0,
          channels: 0,
          hasVideo: true,
          hasAudio: false,
        },
      },
    }));
    generateThumbnailsForMedia.mockImplementation(async (blob: Blob) => {
      if (blob === oldFile) {
        oldFileThumbnailCalls += 1;
        if (oldFileThumbnailCalls === 1) return [];
        signalDelayedThumbnailStarted();
        return thumbnailGate;
      }
      return [];
    });

    const imported = await useProjectStore.getState().importMedia(oldFile);
    if (!imported.success || !imported.actionId) {
      throw new Error("video import failed");
    }
    const result = await useProjectStore
      .getState()
      .replaceMediaAsset(imported.actionId, replacement);
    expect(result.success).toBe(true);

    await delayedThumbnailStarted;
    finishThumbnail([{ timestamp: 0, dataUrl: "old-thumbnail" }]);
    await Promise.resolve();
    await Promise.resolve();

    const item = useProjectStore.getState().getMediaItem(imported.actionId);
    expect(item?.blob).toBe(replacement);
    expect(item?.thumbnailUrl).toBeNull();
  });
});
