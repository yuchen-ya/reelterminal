import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Action } from "@openreel/core";
import { useProjectStore } from "../project-store";

const { deleteMediaBlob, importFile, saveMediaBlob } = vi.hoisted(() => ({
  deleteMediaBlob: vi.fn(async () => undefined),
  importFile: vi.fn(),
  saveMediaBlob: vi.fn(async () => undefined),
}));

vi.mock("../../services/media-storage", () => ({
  saveMediaBlob,
  deleteMediaBlob,
  getMediaIdsByProject: vi.fn(async () => []),
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

const action = (type: string, params: Record<string, unknown>): Action => ({
  type,
  id: `${type}-${Math.random().toString(36).slice(2)}`,
  timestamp: Date.now(),
  params,
});

describe("compound media import transaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    importFile.mockImplementation(async (file: File) => ({
      success: true,
      media: {
        blob: file,
        thumbnails: [],
        waveformData: null,
        metadata: {
          duration: 5,
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
    useProjectStore.getState().createNewProject("Atomic import");
  });

  it("commits import, track, and clip as one undo unit", async () => {
    let clipId: string | undefined;
    const result = await useProjectStore.getState().importMedia(
      new File(["video"], "segment.mp4", { type: "video/mp4" }),
      {
        historyOwner: "agent",
        historyGroupLabel: "agent: material.attach",
        atomicFollowUpActions: (mediaId) => [
          action("track/add", { trackType: "video", trackId: "material-track" }),
          action("clip/add", {
            trackId: "material-track",
            mediaId,
            startTime: 0,
            inPoint: 1,
            outPoint: 3,
            duration: 2,
          }),
        ],
        onAtomicBatchCommitted: (created) => {
          clipId = created.clips[0];
        },
      },
    );
    expect(result.success).toBe(true);
    expect(clipId).toBeTruthy();
    expect(useProjectStore.getState().project.mediaLibrary.items).toHaveLength(1);
    expect(useProjectStore.getState().project.timeline.tracks[0]?.clips).toHaveLength(1);

    const entries = useProjectStore
      .getState()
      .actionExecutor.getHistory()
      .getHistoryEntries();
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((entry) => entry.groupId)).size).toBe(1);

    const undone = await useProjectStore.getState().undo();
    expect(undone.success).toBe(true);
    expect(useProjectStore.getState().project.mediaLibrary.items).toHaveLength(0);
    expect(useProjectStore.getState().project.timeline.tracks).toHaveLength(0);

    const redone = await useProjectStore.getState().redo();
    expect(redone.success).toBe(true);
    const restoredClip = useProjectStore
      .getState()
      .project.timeline.tracks.flatMap((track) => track.clips)[0];
    expect(restoredClip?.id).toBe(clipId);
    expect(restoredClip?.mediaId).toBe(result.actionId);
  });

  it("discards persisted bytes and publishes nothing when a follow-up fails", async () => {
    const result = await useProjectStore.getState().importMedia(
      new File(["video"], "bad-segment.mp4", { type: "video/mp4" }),
      {
        historyOwner: "agent",
        historyGroupLabel: "agent: material.attach",
        atomicFollowUpActions: (mediaId) => [
          // No such track: the complete draft must be rejected.
          action("clip/add", {
            trackId: "missing-track",
            mediaId,
            startTime: 0,
            duration: 1,
          }),
        ],
      },
    );
    expect(result.success).toBe(false);
    expect(useProjectStore.getState().project.mediaLibrary.items).toHaveLength(0);
    expect(useProjectStore.getState().project.timeline.tracks).toHaveLength(0);
    expect(
      useProjectStore.getState().actionExecutor.getHistory().getUndoStackSize(),
    ).toBe(0);
    expect(saveMediaBlob).toHaveBeenCalledTimes(1);
    expect(deleteMediaBlob).toHaveBeenCalledTimes(1);
  });
});
