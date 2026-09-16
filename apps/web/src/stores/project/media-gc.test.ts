import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@openreel/core";
import { useProjectStore } from "../project-store";
import { createEmptyProject } from "./index";
import { loadMediaBlob } from "../../services/media-storage";
import {
  releaseUncommittedMediaBlob,
  sweepOrphanProjectMedia,
  trackUncommittedMediaBlob,
} from "../../services/project-media-gc";

const { importFile, saveMediaBlob, deleteMediaBlob, storedMedia } = vi.hoisted(
  () => ({
    importFile: vi.fn(),
    saveMediaBlob: vi.fn(),
    deleteMediaBlob: vi.fn(),
    storedMedia: new Map<string, { projectId: string; blob: Blob }>(),
  }),
);

saveMediaBlob.mockImplementation(
  async (projectId: string, mediaId: string, blob: Blob) => {
    storedMedia.set(mediaId, { projectId, blob });
  },
);
deleteMediaBlob.mockImplementation(async (mediaId: string) => {
  storedMedia.delete(mediaId);
});

vi.mock("../../services/media-storage", () => ({
  saveMediaBlob,
  deleteMediaBlob,
  loadMediaBlob: vi.fn(async (mediaId: string) =>
    storedMedia.get(mediaId)?.blob ?? null,
  ),
  getMediaIdsByProject: vi.fn(async (projectId: string) =>
    [...storedMedia.entries()]
      .filter(([, record]) => record.projectId === projectId)
      .map(([mediaId]) => mediaId),
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

// Eviction/flush/sweep reclamation runs fire-and-forget; one macrotask drains
// the awaited mock storage calls.
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

const readBlobText = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

describe("project media byte reclamation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storedMedia.clear();
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
    useProjectStore.getState().createNewProject("Media GC");
  });

  const importAsset = async (
    content: string,
    name: string,
    options: Parameters<
      ReturnType<typeof useProjectStore.getState>["importMedia"]
    >[1] = undefined,
  ) => {
    const imported = await useProjectStore
      .getState()
      .importMedia(new File([content], name, { type: "video/mp4" }), options);
    if (!imported.success || !imported.actionId) {
      throw new Error("seed import failed");
    }
    return imported.actionId;
  };

  const hasItem = (mediaId: string) =>
    useProjectStore
      .getState()
      .project.mediaLibrary.items.some((item) => item.id === mediaId);

  it("keeps bytes readable when a delete is undone", async () => {
    const mediaId = await importAsset("kept-bytes", "clip.mp4");

    const deleted = await useProjectStore.getState().deleteMedia(mediaId);
    expect(deleted.success).toBe(true);
    expect(hasItem(mediaId)).toBe(false);
    await drain();
    expect(storedMedia.has(mediaId)).toBe(true);

    const undone = await useProjectStore.getState().undo();
    expect(undone.success).toBe(true);
    expect(hasItem(mediaId)).toBe(true);

    const bytes = await loadMediaBlob(mediaId);
    expect(bytes).not.toBeNull();
    expect(await readBlobText(bytes as Blob)).toBe("kept-bytes");
  });

  it("keeps bytes when a delete is undone and redone", async () => {
    const mediaId = await importAsset("roundtrip", "clip.mp4");
    await useProjectStore.getState().deleteMedia(mediaId);
    await useProjectStore.getState().undo();
    await drain();

    const redone = await useProjectStore.getState().redo();
    expect(redone.success).toBe(true);
    expect(hasItem(mediaId)).toBe(false);
    await drain();
    expect(storedMedia.has(mediaId)).toBe(true);
  });

  it("reclaims bytes once the delete entry leaves the history for good", async () => {
    const mediaId = await importAsset("doomed", "clip.mp4");
    await useProjectStore.getState().deleteMedia(mediaId);
    await drain();
    expect(storedMedia.has(mediaId)).toBe(true);

    useProjectStore.getState().actionExecutor.getHistory().clear();
    await drain();
    expect(storedMedia.has(mediaId)).toBe(false);
    expect(await loadMediaBlob(mediaId)).toBeNull();
  });

  it("keeps bytes for an undone agent import and redoes with data", async () => {
    const mediaId = await importAsset("agent-import", "clip.mp4", {
      historyOwner: "agent",
      historyGroupLabel: "agent: import",
    });
    expect(hasItem(mediaId)).toBe(true);

    const undone = await useProjectStore.getState().undo();
    expect(undone.success).toBe(true);
    expect(hasItem(mediaId)).toBe(false);
    await drain();
    // The import entry sits on the redo stack: its bytes must survive.
    expect(storedMedia.has(mediaId)).toBe(true);

    const redone = await useProjectStore.getState().redo();
    expect(redone.success).toBe(true);
    expect(hasItem(mediaId)).toBe(true);
    const bytes = await loadMediaBlob(mediaId);
    expect(await readBlobText(bytes as Blob)).toBe("agent-import");
  });

  it("reclaims bytes of an undone import once it can no longer be redone", async () => {
    const mediaId = await importAsset("orphan-to-be", "clip.mp4", {
      historyOwner: "agent",
      historyGroupLabel: "agent: import",
    });
    await useProjectStore.getState().undo();
    await drain();
    expect(storedMedia.has(mediaId)).toBe(true);

    // Any new history push drops the redo stack, taking the import entry with
    // it. The item is gone and nothing can restore it, so the bytes go too.
    await useProjectStore.getState().renameProject("Another name");
    await drain();
    expect(storedMedia.has(mediaId)).toBe(false);
  });

  it("reclaims a deleted project's unclaimed bytes when the project is switched", async () => {
    const mediaId = await importAsset("switched-away", "clip.mp4");
    await useProjectStore.getState().deleteMedia(mediaId);
    await drain();
    // The open history still restores it, so the bytes are kept while the
    // project stays open.
    expect(storedMedia.has(mediaId)).toBe(true);

    useProjectStore.getState().createNewProject("Next project");
    await drain();
    // The switch destroyed that history: nothing restores the item anymore.
    expect(storedMedia.has(mediaId)).toBe(false);
  });

  it("sweeps load-time orphans without touching the loaded media", async () => {
    const mediaId = await importAsset("loaded-and-kept", "clip.mp4");
    const current = useProjectStore.getState().project;
    storedMedia.set("orphan-1", { projectId: current.id, blob: new Blob(["orphan"]) });

    const incoming = {
      ...createEmptyProject("Reloaded"),
      id: current.id,
      mediaLibrary: {
        ...current.mediaLibrary,
        items: [...current.mediaLibrary.items],
      },
    } as Project;
    useProjectStore.getState().loadProject(incoming);
    await drain();

    expect(storedMedia.has("orphan-1")).toBe(false);
    expect(storedMedia.has(mediaId)).toBe(true);
    expect(hasItem(mediaId)).toBe(true);
  });

  it("treats an in-flight import's bytes as live during sweeps", async () => {
    const mediaId = await importAsset("committed", "clip.mp4");
    const current = useProjectStore.getState().project;

    // Simulate bytes persisted by an import whose entry is not published yet.
    const pendingId = "pending-import";
    storedMedia.set(pendingId, { projectId: current.id, blob: new Blob(["pending"]) });
    trackUncommittedMediaBlob(pendingId);
    // ...and a plain orphan with no protection for contrast.
    storedMedia.set("plain-orphan", { projectId: current.id, blob: new Blob(["orphan"]) });

    await sweepOrphanProjectMedia(useProjectStore.getState().project);
    expect(storedMedia.has("plain-orphan")).toBe(false);
    expect(storedMedia.has(pendingId)).toBe(true);
    expect(storedMedia.has(mediaId)).toBe(true);

    releaseUncommittedMediaBlob(pendingId);
    await sweepOrphanProjectMedia(useProjectStore.getState().project);
    expect(storedMedia.has(pendingId)).toBe(false);
  });

  it("resolves even when reclaiming an already-gone blob fails", async () => {
    const mediaId = await importAsset("vanishing", "clip.mp4");
    await useProjectStore.getState().deleteMedia(mediaId);
    storedMedia.clear();
    deleteMediaBlob.mockRejectedValueOnce(new Error("record already gone"));

    useProjectStore.getState().actionExecutor.getHistory().clear();
    await drain();
    // The reclaim attempt for the already-missing blob failed and was
    // swallowed; the scan resolves instead of leaking a rejection.
    expect(deleteMediaBlob).toHaveBeenCalledWith(mediaId);
    expect(storedMedia.has(mediaId)).toBe(false);
  });
});
