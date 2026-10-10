import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, Clip, MediaItem, Project } from "@reelterminal/core";
import { useProjectStore } from "../project-store";
import { captureTimelineClipboard } from "./timeline-clipboard";

const {
  deleteMediaBlob,
  importFile,
  saveMediaBlob,
  releaseUncommittedMediaBlob,
  trackUncommittedMediaBlob,
} = vi.hoisted(() => ({
  deleteMediaBlob: vi.fn(async () => undefined),
  importFile: vi.fn(),
  saveMediaBlob: vi.fn(async () => ({ contentHash: "a".repeat(64), created: true })),
  releaseUncommittedMediaBlob: vi.fn(),
  trackUncommittedMediaBlob: vi.fn(),
}));

vi.mock("../../services/media-storage", () => ({
  saveMediaBlob,
  deleteMediaBlob,
  withMediaReferenceWrite: async <T>(operation: () => Promise<T> | T) => operation(),
  getMediaIdsByProject: vi.fn(async () => []),
  loadProjectMedia: vi.fn(async () => []),
  loadFileHandle: vi.fn(async () => null),
  loadDirectoryHandle: vi.fn(async () => null),
}));

vi.mock("../../services/project-media-gc", () => ({
  attachProjectMediaGc: vi.fn(),
  detachProjectMediaGc: vi.fn(),
  ensureProjectMediaGc: vi.fn(),
  reconcileProjectMediaBytes: vi.fn(async () => undefined),
  releaseUncommittedMediaBlob,
  trackUncommittedMediaBlob,
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

  it("publishes nothing and keeps bytes for GC when a follow-up fails", async () => {
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
    expect(deleteMediaBlob).not.toHaveBeenCalled();
  });

  it("tracks pasted bytes as uncommitted when the paste loses a revision race", async () => {
    await useProjectStore.getState().addTrack("video");
    const destinationTrack = useProjectStore
      .getState()
      .project.timeline.tracks.find((track) => track.type === "video")!;
    const targetProjectId = useProjectStore.getState().project.id;
    const expectedRevision = useProjectStore.getState().projectRevision;

    const media = {
      id: "orphan-media",
      name: "pasted.mp4",
      type: "video",
      blob: new Blob(["pasted bytes"]),
      fileHandle: null,
      metadata: {
        duration: 2,
        width: 320,
        height: 180,
        frameRate: 30,
        codec: "h264",
        sampleRate: 48000,
        channels: 2,
        fileSize: 13,
      },
      thumbnailUrl: null,
      waveformData: null,
    } as MediaItem;
    const clip = {
      id: "clipboard-clip",
      mediaId: media.id,
      trackId: "video-track",
      startTime: 0,
      duration: 2,
      inPoint: 0,
      outPoint: 2,
      effects: [],
      audioEffects: [],
      transform: {
        position: { x: 0.5, y: 0.5 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      volume: 1,
      keyframes: [],
    } as Clip;
    const captured = useProjectStore.getState().project;
    captureTimelineClipboard(
      {
        ...captured,
        mediaLibrary: { items: [media] },
        timeline: {
          ...captured.timeline,
          tracks: [
            {
              id: "video-track",
              type: "video",
              name: "Video",
              clips: [clip],
              transitions: [],
              locked: false,
              hidden: false,
              muted: false,
              solo: false,
            },
          ],
        },
      } as Project,
      [{ kind: "media", clip }],
      false,
    );

    // A human edit lands while the bytes are being persisted: the post-save
    // revision re-check must lose the race and paste nothing.
    saveMediaBlob.mockImplementationOnce(async () => {
      await useProjectStore.getState().addTrack("video");
      return { contentHash: "b".repeat(64), created: true };
    });

    const results = await useProjectStore
      .getState()
      .pasteClips(destinationTrack.id, 0, { expectedRevision });

    expect(results[0].success).toBe(false);
    expect(
      useProjectStore
        .getState()
        .project.timeline.tracks.flatMap((track) => track.clips),
    ).toHaveLength(0);
    expect(trackUncommittedMediaBlob).toHaveBeenCalledWith(
      media.id,
      targetProjectId,
    );
    expect(saveMediaBlob).toHaveBeenCalledTimes(1);
    // The window is over: committed bytes would be project-owned, and this
    // lost race's bytes stay on disk as GC-visible orphans.
    expect(releaseUncommittedMediaBlob).toHaveBeenCalledWith(media.id);
    expect(deleteMediaBlob).not.toHaveBeenCalled();
  });
});
