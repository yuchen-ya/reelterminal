import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Action } from "@openreel/core";
import type { TextClip } from "@openreel/core";
import { useProjectStore, getProjectRevision } from "../../stores/project-store";
import {
  getLiveEditorContext,
  markAgentReferences,
} from "../../stores/editor-context-store";
import {
  handleLiveBridgeRequest,
  installLiveBridge,
  type LiveBridgeRequest,
} from "./live-bridge";
import { getTransitionBridge } from "../../bridges/transition-bridge";
import { MAX_ACTIONS_PER_BATCH } from "../../stores/project/action-batch";

const { mockSaveMediaBlob, mockImportFile } = vi.hoisted(() => ({
  mockSaveMediaBlob: vi.fn(async () => undefined),
  mockImportFile: vi.fn(),
}));

vi.mock("../../services/media-storage", () => ({
  saveMediaBlob: mockSaveMediaBlob,
  deleteMediaBlob: vi.fn(async () => undefined),
  loadProjectMedia: vi.fn(async () => []),
  loadFileHandle: vi.fn(async () => null),
  loadDirectoryHandle: vi.fn(async () => null),
}));

vi.mock("../../bridges/media-bridge", () => ({
  getMediaBridge: vi.fn(() => ({
    isInitialized: vi.fn(() => true),
    importFile: mockImportFile,
  })),
  initializeMediaBridge: vi.fn(async () => undefined),
}));

const act = (type: string, params: Record<string, unknown>): Action => ({
  type,
  id: `a-${Math.random().toString(36).slice(2)}`,
  timestamp: Date.now(),
  params,
});

const textClip = (id: string, text: string, trackId = "track-text"): TextClip =>
  ({
    id,
    trackId,
    startTime: 1,
    duration: 2,
    text,
    style: {},
    transform: { position: { x: 0.5, y: 0.5 } },
    keyframes: [],
  }) as unknown as TextClip;

const req = (
  kind: LiveBridgeRequest["kind"],
  extra: Partial<LiveBridgeRequest> = {},
): LiveBridgeRequest => ({ callId: "c1", kind, ...extra });

const undoSize = (): number =>
  useProjectStore.getState().actionExecutor.getHistory().getUndoStackSize();

describe("live-bridge (ADR 0004 Decision 1 seam)", () => {
  beforeEach(() => {
    mockImportFile.mockImplementation(async (file: File) => ({
      success: true,
      media: {
        blob: file,
        thumbnails: [],
        waveformData: null,
        metadata: {
          duration: 7,
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
    useProjectStore.getState().createNewProject();
  });

  afterEach(() => {
    delete (window as { openreel?: unknown }).openreel;
    vi.restoreAllMocks();
  });

  it("getIdentity returns the open project identity", async () => {
    const res = await handleLiveBridgeRequest(req("getIdentity"));
    const project = useProjectStore.getState().project;
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({
      projectId: project.id,
      projectName: project.name,
      windowId: "main",
    });
  });

  it("getIdentity errors honestly when no project is open", async () => {
    useProjectStore.setState({ hasOpenProject: false });
    const res = await handleLiveBridgeRequest(req("getIdentity"));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("NO_PROJECT");
  });

  it("getState returns the full project plus the current revision", async () => {
    await useProjectStore
      .getState()
      .executeAction(act("track/add", { trackType: "video" }));
    const res = await handleLiveBridgeRequest(req("getState"));
    expect(res.ok).toBe(true);
    const { project, revision } = res.result as {
      project: { id: string };
      revision: number;
    };
    expect(project.id).toBe(useProjectStore.getState().project.id);
    expect(revision).toBe(getProjectRevision());
  });

  it("commits a ranged clip/add with source-span timeline duration", async () => {
    const initial = useProjectStore.getState().project;
    useProjectStore.setState({
      project: {
        ...initial,
        mediaLibrary: {
          ...initial.mediaLibrary,
          items: [
            ...initial.mediaLibrary.items,
            {
              id: "media-ranged",
              name: "long.mp4",
              type: "video",
              fileHandle: null,
              blob: null,
              metadata: {
                duration: 340.117,
                width: 1920,
                height: 1080,
                frameRate: 30,
                codec: "h264",
                sampleRate: 48_000,
                channels: 2,
                fileSize: 1,
              },
              thumbnailUrl: null,
              waveformData: null,
            },
          ],
        },
      },
    });

    const result = await handleLiveBridgeRequest(
      req("applyActions", {
        actions: [
          act("track/add", { trackType: "video", trackId: "v-range" }),
          act("clip/add", {
            trackId: "v-range",
            mediaId: "media-ranged",
            startTime: 0,
            inPoint: 8,
            outPoint: 12,
          }),
        ],
      }),
    );

    expect(result.ok).toBe(true);
    const clip = useProjectStore.getState().project.timeline.tracks
      .find((track) => track.id === "v-range")?.clips[0];
    expect(clip).toMatchObject({ inPoint: 8, outPoint: 12, duration: 4 });
  });

  it("exposes GUI changes and controls the canonical undo/redo history with CAS + replay", async () => {
    const base = getProjectRevision();
    await useProjectStore.getState().executeAction(
      act("track/add", { trackType: "video", trackId: "human-v1" }),
    );
    const changed = await handleLiveBridgeRequest(
      req("getProjectChanges", { sinceRevision: base, limit: 20 }),
    );
    expect(changed.ok).toBe(true);
    expect((changed.result as { changes: Array<Record<string, unknown>> }).changes)
      .toContainEqual(expect.objectContaining({ entityType: "track", entityId: "human-v1" }));

    const history = await handleLiveBridgeRequest(req("getHistory", { limit: 10 }));
    expect(history.ok).toBe(true);
    expect(history.result).toMatchObject({ available: true, canUndo: true });

    const revision = getProjectRevision();
    const undo = await handleLiveBridgeRequest(
      req("historyControl", {
        historyAction: "undo",
        expectedRevision: revision,
        idempotencyKey: "undo-human-v1",
      }),
    );
    expect(undo.ok).toBe(true);
    expect(useProjectStore.getState().project.timeline.tracks)
      .not.toContainEqual(expect.objectContaining({ id: "human-v1" }));

    const replay = await handleLiveBridgeRequest(
      req("historyControl", {
        historyAction: "undo",
        expectedRevision: revision,
        idempotencyKey: "undo-human-v1",
      }),
    );
    expect(replay.ok).toBe(true);
    expect(replay.result).toMatchObject({ replayed: true });

    const redoRevision = getProjectRevision();
    const redo = await handleLiveBridgeRequest(
      req("historyControl", {
        historyAction: "redo",
        expectedRevision: redoRevision,
        idempotencyKey: "redo-human-v1",
      }),
    );
    expect(redo.ok).toBe(true);
    expect(useProjectStore.getState().project.timeline.tracks)
      .toContainEqual(expect.objectContaining({ id: "human-v1" }));
  });

  it("getContext returns the live editor context", async () => {
    const res = await handleLiveBridgeRequest(req("getContext"));
    expect(res.ok).toBe(true);
    expect(res.result).toEqual(getLiveEditorContext());
  });

  it("getContext carries detached machine-readable agent references", async () => {
    markAgentReferences([
      {
        kind: "video",
        entityId: "clip-reference-1",
        label: "Opening shot",
        timing: { startSeconds: 2, endSeconds: 5 },
        trackOrder: 0,
      },
    ]);

    const res = await handleLiveBridgeRequest(req("getContext"));
    expect(res.ok).toBe(true);
    const result = res.result as {
      references: Record<string, {
        number: number;
        kind: string;
        entityId: string;
        label: string;
        timing: { startSeconds: number | null; endSeconds: number | null };
        revisionAtMark: number;
        stale: boolean;
      }>;
    };
    expect(result.references["1"]).toMatchObject({
      number: 1,
      kind: "video",
      entityId: "clip-reference-1",
      label: "Opening shot",
      timing: { startSeconds: 2, endSeconds: 5 },
      stale: true,
    });
  });

  it("imports an agent path into the canonical media library and one agent undo unit", async () => {
    mockSaveMediaBlob.mockClear();
    const readFileBytes = vi.fn(async () => new ArrayBuffer(4));
    (window as unknown as { openreel: unknown }).openreel = {
      fs: { readFileBytes },
    };
    const beforeRevision = getProjectRevision();
    const sourcePath = "/media-root/agent-shot.mp4";
    const res = await handleLiveBridgeRequest(
      req("importMedia", {
        path: sourcePath,
        name: "Agent shot",
        type: "video",
        metadata: {
          durationSec: 7,
          width: 640,
          height: 360,
          frameRate: 30,
          codec: "h264",
          fileSize: 4,
        },
        sourceFile: {
          name: "agent-shot.mp4",
          size: 4,
          lastModified: 123,
        },
        expectedRevision: beforeRevision,
      }),
    );

    expect(res.ok).toBe(true);
    const imported = res.result as {
      revision: number;
      mediaId: string;
      name: string;
      type: string;
    };
    expect(imported.revision).toBe(beforeRevision + 1);
    expect(imported.name).toBe("Agent shot");
    expect(imported.type).toBe("video");
    expect(readFileBytes).toHaveBeenCalledWith(sourcePath, 256 * 1024 * 1024);
    const item = useProjectStore.getState().getMediaItem(imported.mediaId);
    expect(item).toMatchObject({
      id: imported.mediaId,
      name: "Agent shot",
      type: "video",
      originalUrl: sourcePath,
      sourceFile: { name: "agent-shot.mp4", size: 4, lastModified: 123 },
      metadata: { duration: 7, width: 640, height: 360, fileSize: 4 },
    });
    expect(mockSaveMediaBlob).toHaveBeenCalledWith(
      useProjectStore.getState().project.id,
      imported.mediaId,
      expect.any(File),
      expect.objectContaining({ fileSize: 4 }),
    );

    const lastEntry = useProjectStore
      .getState()
      .actionExecutor
      .getHistory()
      .peekUndo();
    expect(lastEntry?.owner).toBe("agent");
    expect(lastEntry?.groupId).toBeTruthy();

    const undone = await useProjectStore.getState().undo();
    expect(undone.success).toBe(true);
    expect(useProjectStore.getState().getMediaItem(imported.mediaId)).toBeUndefined();
    expect(getProjectRevision()).toBe(beforeRevision + 2);

    const redone = await useProjectStore.getState().redo();
    expect(redone.success).toBe(true);
    expect(useProjectStore.getState().getMediaItem(imported.mediaId)).toMatchObject({
      id: imported.mediaId,
      originalUrl: sourcePath,
      sourceFile: { name: "agent-shot.mp4", size: 4, lastModified: 123 },
      metadata: { duration: 7, width: 640, height: 360, fileSize: 4 },
    });
    expect(getProjectRevision()).toBe(beforeRevision + 3);
  });

  it("does not commit media or history when durable blob persistence fails", async () => {
    const readFileBytes = vi.fn(async () => new ArrayBuffer(4));
    (window as unknown as { openreel: unknown }).openreel = {
      fs: { readFileBytes },
    };
    mockSaveMediaBlob.mockRejectedValueOnce(new Error("simulated storage failure"));
    const revisionBefore = getProjectRevision();
    const historyBefore = undoSize();

    const result = await handleLiveBridgeRequest(
      req("importMedia", {
        path: "/media-root/not-durable.mp4",
        name: "Not durable",
        type: "video",
        metadata: {
          durationSec: 7,
          width: 640,
          height: 360,
          frameRate: 30,
          codec: "h264",
          fileSize: 4,
        },
        sourceFile: {
          name: "not-durable.mp4",
          size: 4,
          lastModified: 123,
        },
        expectedRevision: revisionBefore,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      code: "DECODE_ERROR",
      message: "Failed to persist imported media for project recovery",
    });
    expect(getProjectRevision()).toBe(revisionBefore);
    expect(undoSize()).toBe(historyBefore);
    expect(useProjectStore.getState().project.mediaLibrary.items).toHaveLength(0);
  });

  it("keeps an intervening edit when a manual media decode finishes later", async () => {
    let finishDecode!: (value: unknown) => void;
    mockImportFile.mockImplementationOnce(
      (file: File) =>
        new Promise((resolve) => {
          finishDecode = (value) => resolve(value);
          // Keep the File reachable in the closure just like the real bridge.
          void file;
        }),
    );
    const file = new File([new Uint8Array([1, 2, 3, 4])], "human.mp4", {
      type: "video/mp4",
    });
    const pendingImport = useProjectStore.getState().importMedia(file);
    await vi.waitFor(() => expect(mockImportFile).toHaveBeenCalledTimes(1));

    const track = await useProjectStore
      .getState()
      .executeAction(act("track/add", { trackType: "video" }));
    expect(track.success).toBe(true);
    const trackId = useProjectStore.getState().project.timeline.tracks.at(-1)!.id;

    finishDecode({
      success: true,
      media: {
        blob: file,
        thumbnails: [],
        waveformData: null,
        metadata: {
          duration: 7,
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
    });
    const imported = await pendingImport;

    expect(imported.success).toBe(true);
    expect(
      useProjectStore.getState().project.timeline.tracks.some((item) => item.id === trackId),
    ).toBe(true);
    expect(useProjectStore.getState().project.mediaLibrary.items).toHaveLength(1);
  });

  it("records the native source path for a manual desktop media import", async () => {
    const sourcePath = "/Users/editor/Footage/human-shot.mp4";
    const getPathForFile = vi.fn(() => sourcePath);
    (window as unknown as { openreel: unknown }).openreel = {
      fs: { getPathForFile },
    };
    const file = new File([new Uint8Array([1, 2, 3, 4])], "human-shot.mp4", {
      type: "video/mp4",
      lastModified: 456,
    });

    const imported = await useProjectStore.getState().importMedia(file);

    expect(imported.success).toBe(true);
    expect(getPathForFile).toHaveBeenCalledWith(file);
    expect(useProjectStore.getState().getMediaItem(imported.actionId!)).toMatchObject({
      originalUrl: sourcePath,
      sourceFile: { name: "human-shot.mp4", size: 4, lastModified: 456 },
    });
  });

  it("keeps browser and synthetic File imports blob-only", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "generated.mp4", {
      type: "video/mp4",
    });

    const imported = await useProjectStore.getState().importMedia(file);

    expect(imported.success).toBe(true);
    expect(useProjectStore.getState().getMediaItem(imported.actionId!)).not.toHaveProperty(
      "originalUrl",
    );
  });

  it("rejects an explicit relative sourcePath instead of persisting it", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "untrusted.mp4", {
      type: "video/mp4",
    });

    const imported = await useProjectStore.getState().importMedia(file, {
      sourcePath: "../untrusted.mp4",
    });

    expect(imported.success).toBe(false);
    expect(imported.error?.code).toBe("INVALID_PARAMS");
    expect(mockImportFile).not.toHaveBeenCalled();
    expect(useProjectStore.getState().project.mediaLibrary.items).toHaveLength(0);
  });

  it("replays a committed import key without reading or inserting the file twice", async () => {
    const readFileBytes = vi.fn(async () => new ArrayBuffer(4));
    (window as unknown as { openreel: unknown }).openreel = {
      fs: { readFileBytes },
    };
    const beforeRevision = getProjectRevision();
    const request = req("importMedia", {
      path: "/media-root/idempotent.mp4",
      name: "Idempotent shot",
      type: "video",
      metadata: {
        durationSec: 7,
        width: 640,
        height: 360,
        frameRate: 30,
        codec: "h264",
        fileSize: 4,
      },
      sourceFile: {
        name: "idempotent.mp4",
        size: 4,
        lastModified: 123,
      },
      expectedRevision: beforeRevision,
      idempotencyKey: "renderer-import-1",
    });

    const first = await handleLiveBridgeRequest(request);
    const replay = await handleLiveBridgeRequest({
      ...request,
      callId: "c2",
      // A committed replay wins over a now-stale transport guard.
      expectedRevision: beforeRevision + 999,
    });

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(replay.result).toMatchObject({
      mediaId: (first.result as { mediaId: string }).mediaId,
      revision: (first.result as { revision: number }).revision,
      replayed: true,
    });
    expect(readFileBytes).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().project.mediaLibrary.items).toHaveLength(1);

    const conflict = await handleLiveBridgeRequest({
      ...request,
      callId: "c3",
      path: "/media-root/different.mp4",
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.error?.code).toBe("CONFLICT");
    expect(readFileBytes).toHaveBeenCalledTimes(1);
  });

  it("replays a committed applyActions key without applying the batch twice", async () => {
    const beforeRevision = getProjectRevision();
    const undoBefore = undoSize();
    const tracksBefore =
      useProjectStore.getState().project.timeline.tracks.length;
    const request = req("applyActions", {
      groupLabel: "agent retry batch",
      actions: [act("track/add", { trackType: "video" })],
      idempotencyKey: "apply-retry-1",
    });

    const first = await handleLiveBridgeRequest(request);
    expect(first.ok).toBe(true);

    // The reply was lost after the renderer commit (timeout/reload); the
    // facade-guided retry carries the same idempotencyKey and a now-stale
    // transport guard. The committed replay must win over both.
    const replay = await handleLiveBridgeRequest({
      ...request,
      callId: "c2",
      expectedRevision: beforeRevision + 999,
    });

    expect(replay.ok).toBe(true);
    expect(replay.result).toMatchObject({
      revision: (first.result as { revision: number }).revision,
      replayed: true,
    });
    expect(replay.result).toMatchObject({
      createdIds: (first.result as { createdIds: unknown }).createdIds,
    });
    // Exactly one application: one revision bump, one undo group, one track.
    expect(getProjectRevision()).toBe(beforeRevision + 1);
    expect(undoSize()).toBe(undoBefore + 1);
    expect(
      useProjectStore.getState().project.timeline.tracks.length,
    ).toBe(tracksBefore + 1);

    // Same key with a different payload is a CONFLICT, not a blind replay.
    const conflict = await handleLiveBridgeRequest({
      ...request,
      callId: "c3",
      actions: [act("track/add", { trackType: "audio" })],
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.error?.code).toBe("CONFLICT");
    expect(getProjectRevision()).toBe(beforeRevision + 1);
  });

  it("applyActions routes plain actions through executeAction as one undo unit", async () => {
    const tracksBefore =
      useProjectStore.getState().project.timeline.tracks.length;
    const revisionBefore = getProjectRevision();
    let projectCommits = 0;
    const unsubscribe = useProjectStore.subscribe((state, previous) => {
      if (state.project !== previous.project) projectCommits += 1;
    });
    const res = await handleLiveBridgeRequest(
      req("applyActions", {
        groupLabel: "agent batch",
        actions: [
          act("track/add", { trackType: "video" }),
          act("track/add", { trackType: "audio" }),
        ],
      }),
    ).finally(unsubscribe);
    expect(res.ok).toBe(true);
    const { revision, createdIds } = res.result as {
      revision: number;
      createdIds: { tracks: string[]; clips: string[]; textClips: string[] };
    };
    expect(revision).toBe(getProjectRevision());
    expect(revision).toBe(revisionBefore + 1);
    expect(projectCommits).toBe(1);
    // createdIds is the before/after diff of the canonical project, per
    // category — the two genuinely-created tracks, not translator guesses.
    const trackIds = useProjectStore
      .getState()
      .project.timeline.tracks.map((t) => t.id);
    expect(createdIds.tracks).toEqual(trackIds.slice(-2));
    expect(createdIds.clips).toEqual([]);
    expect(createdIds.textClips).toEqual([]);
    expect(useProjectStore.getState().project.timeline.tracks.length).toBe(
      tracksBefore + 2,
    );

    // The batch is one history group owned by the agent…
    const entries = useProjectStore
      .getState()
      .actionExecutor.getHistory()
      .getHistoryEntries();
    expect(entries.at(-1)?.owner).toBe("agent");
    expect(entries.at(-1)?.groupId).toBeTruthy();
    expect(entries.at(-2)?.groupId).toBe(entries.at(-1)?.groupId);

    // …so a single GUI undo reverts the whole batch.
    await useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.timeline.tracks.length).toBe(
      tracksBefore,
    );
  });

  it("rejects empty and oversized store batches without a revision or history change", () => {
    const store = useProjectStore.getState();
    const revisionBefore = getProjectRevision();
    const undoBefore = undoSize();
    const options = { groupLabel: "invalid", historyOwner: "agent" };

    expect(store.executeActionBatch([], options).result.success).toBe(false);
    expect(
      store.executeActionBatch(
        Array.from({ length: MAX_ACTIONS_PER_BATCH + 1 }, () =>
          act("track/add", { trackType: "video" }),
        ),
        options,
      ).result.success,
    ).toBe(false);
    expect(getProjectRevision()).toBe(revisionBefore);
    expect(undoSize()).toBe(undoBefore);
  });

  it("keeps a committed batch successful when a history observer throws", async () => {
    const revisionBefore = getProjectRevision();
    const off = useProjectStore
      .getState()
      .actionExecutor.getHistory()
      .subscribe(() => {
        throw new Error("broken history observer");
      });
    try {
      const res = await handleLiveBridgeRequest(
        req("applyActions", {
          actions: [act("track/add", { trackType: "video" })],
        }),
      );
      expect(res.ok).toBe(true);
      expect(getProjectRevision()).toBe(revisionBefore + 1);
    } finally {
      off();
    }
  });

  it("does not misreport a commit when a derived transition refresh throws", async () => {
    const transitionBridge = getTransitionBridge();
    transitionBridge.initialize(320, 180);
    vi.spyOn(transitionBridge, "setTransitionsForTrack").mockImplementationOnce(
      () => {
        throw new Error("derived refresh failed");
      },
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const revisionBefore = getProjectRevision();

    const res = await handleLiveBridgeRequest(
      req("applyActions", {
        actions: [act("track/add", { trackType: "video" })],
      }),
    );

    expect(res.ok).toBe(true);
    expect(getProjectRevision()).toBe(revisionBefore + 1);
    expect(undoSize()).toBeGreaterThan(0);
  });

  it("applyActions dispatches openreel:preview-invalidate after a successful batch", async () => {
    const seen: string[] = [];
    const listener = () => seen.push("openreel:preview-invalidate");
    window.addEventListener("openreel:preview-invalidate", listener);
    try {
      const res = await handleLiveBridgeRequest(
        req("applyActions", {
          actions: [act("track/add", { trackType: "video" })],
        }),
      );
      expect(res.ok).toBe(true);
      expect(seen).toEqual(["openreel:preview-invalidate"]);
    } finally {
      window.removeEventListener("openreel:preview-invalidate", listener);
    }
  });

  it("returns created clip ids in action order across different tracks", async () => {
    const initial = useProjectStore.getState().project;
    useProjectStore.setState({
      project: {
        ...initial,
        mediaLibrary: {
          ...initial.mediaLibrary,
          items: [
            ...initial.mediaLibrary.items,
            {
              id: "media-1",
              name: "seed.mp4",
              type: "video",
              fileHandle: null,
              blob: null,
              metadata: {
                duration: 6,
                width: 320,
                height: 180,
                frameRate: 30,
                codec: "h264",
                sampleRate: 48000,
                channels: 2,
                fileSize: 1024,
              },
              thumbnailUrl: null,
              waveformData: null,
            },
          ],
        },
      },
    });
    const tracks = await handleLiveBridgeRequest(
      req("applyActions", {
        actions: [
          act("track/add", { trackType: "video", trackId: "v1" }),
          act("track/add", { trackType: "video", trackId: "v2" }),
        ],
      }),
    );
    expect(tracks.ok).toBe(true);

    // Create on the later project track first. A single post-batch project
    // diff would return v1's clip before v2's and reverse these ids.
    const clips = await handleLiveBridgeRequest(
      req("applyActions", {
        actions: [
          act("clip/add", {
            trackId: "v2",
            mediaId: "media-1",
            startTime: 0,
          }),
          act("clip/add", {
            trackId: "v1",
            mediaId: "media-1",
            startTime: 0,
          }),
        ],
      }),
    );
    expect(clips.ok).toBe(true);
    const createdIds = (clips.result as {
      createdIds: { clips: string[] };
    }).createdIds.clips;
    const project = useProjectStore.getState().project;
    expect(createdIds).toEqual([
      project.timeline.tracks.find((track) => track.id === "v2")?.clips[0]?.id,
      project.timeline.tracks.find((track) => track.id === "v1")?.clips[0]?.id,
    ]);
  });

  it("keeps agent transition actions synchronized with the preview bridge", async () => {
    const initial = useProjectStore.getState().project;
    useProjectStore.setState({
      project: {
        ...initial,
        mediaLibrary: {
          ...initial.mediaLibrary,
          items: [{
            id: "media-transition",
            name: "transition.mp4",
            type: "video",
            fileHandle: null,
            blob: null,
            metadata: {
              duration: 6,
              width: 320,
              height: 180,
              frameRate: 30,
              codec: "h264",
              sampleRate: 48000,
              channels: 2,
              fileSize: 1024,
            },
            thumbnailUrl: null,
            waveformData: null,
          }],
        },
      },
    });
    const seeded = await handleLiveBridgeRequest(
      req("applyActions", {
        actions: [
          act("track/add", { trackType: "video", trackId: "v-transition" }),
          act("clip/add", {
            trackId: "v-transition",
            mediaId: "media-transition",
            startTime: 0,
            duration: 3,
            outPoint: 3,
          }),
          act("clip/add", {
            trackId: "v-transition",
            mediaId: "media-transition",
            startTime: 3,
            duration: 3,
            outPoint: 3,
          }),
        ],
      }),
    );
    expect(seeded.ok).toBe(true);
    const clipIds = (seeded.result as {
      createdIds: { clips: string[] };
    }).createdIds.clips;
    expect(clipIds).toHaveLength(2);

    const bridge = getTransitionBridge();
    bridge.initialize(320, 180);
    const transition = {
      id: "transition-live-1",
      clipAId: clipIds[0]!,
      clipBId: clipIds[1]!,
      type: "crossfade" as const,
      duration: 0.5,
      params: { curve: "ease" },
    };
    const applied = await handleLiveBridgeRequest(
      req("applyActions", {
        actions: [
          act("transition/set", { transition }),
          act("transition/update", {
            transitionId: transition.id,
            type: "dipToBlack",
            duration: 0.75,
            params: { holdDuration: 0.1 },
          }),
        ],
      }),
    );
    expect(applied.ok).toBe(true);
    expect((applied.result as {
      createdIds: { transitions: string[] };
    }).createdIds.transitions).toEqual([transition.id]);
    expect(bridge.getTransition(transition.id)).toMatchObject({
      type: "dipToBlack",
      duration: 0.75,
      params: { holdDuration: 0.1 },
    });

    const removed = await handleLiveBridgeRequest(
      req("applyActions", {
        actions: [act("transition/remove", { transitionId: transition.id })],
      }),
    );
    expect(removed.ok).toBe(true);
    expect(bridge.getTransition(transition.id)).toBeUndefined();
  });

  it("applyActions routes text/create engine-aware and preserves the facade id", async () => {
    const res = await handleLiveBridgeRequest(
      req("applyActions", {
        groupLabel: "add title",
        actions: [act("text/create", { clip: textClip("text-facade-1", "Hello") })],
      }),
    );
    expect(res.ok).toBe(true);
    const { createdIds } = res.result as {
      createdIds: { tracks: string[]; clips: string[]; textClips: string[] };
    };
    // The facade-minted clip id survives in the textClips bucket; the
    // auto-created text track id lands in the tracks bucket.
    expect(createdIds.textClips).toContain("text-facade-1");
    expect(createdIds.tracks).toHaveLength(1);

    // Engine-aware: the TitleEngine (what the Preview renders) holds the clip…
    const clip = useProjectStore.getState().getTextClip("text-facade-1");
    expect(clip?.text).toBe("Hello");
    // …and the project mirror carries it too.
    expect(
      useProjectStore.getState().getFullProject().textClips?.some((c) => c.id === "text-facade-1"),
    ).toBe(true);
    // A text track was materialized for the overlay.
    expect(
      useProjectStore.getState().project.timeline.tracks.some((t) => t.type === "text"),
    ).toBe(true);
  });

  it("applyActions routes text/update and text/remove engine-aware", async () => {
    await handleLiveBridgeRequest(
      req("applyActions", {
        actions: [act("text/create", { clip: textClip("t1", "Before") })],
      }),
    );

    const update = await handleLiveBridgeRequest(
      req("applyActions", {
        actions: [
          act("text/update", {
            clipId: "t1",
            updates: { text: "After", style: { fontSize: 48 } },
          }),
        ],
      }),
    );
    expect(update.ok).toBe(true);
    const clip = useProjectStore.getState().getTextClip("t1");
    expect(clip?.text).toBe("After");
    expect(clip?.style.fontSize).toBe(48);

    const remove = await handleLiveBridgeRequest(
      req("applyActions", { actions: [act("text/remove", { clipId: "t1" })] }),
    );
    expect(remove.ok).toBe(true);
    expect(useProjectStore.getState().getTextClip("t1")).toBeUndefined();
    expect(
      useProjectStore.getState().getFullProject().textClips?.some((c) => c.id === "t1"),
    ).toBe(false);
  });

  it("rejects a stale expectedRevision with CONFLICT and applies nothing", async () => {
    const tracksBefore =
      useProjectStore.getState().project.timeline.tracks.length;
    const undoBefore = undoSize();
    const res = await handleLiveBridgeRequest(
      req("applyActions", {
        actions: [act("track/add", { trackType: "video" })],
        expectedRevision: getProjectRevision() + 99,
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("CONFLICT");
    expect(res.error?.details?.currentRevision).toBe(getProjectRevision());
    expect(useProjectStore.getState().project.timeline.tracks.length).toBe(
      tracksBefore,
    );
    expect(undoSize()).toBe(undoBefore);
  });

  it("rejects a stale expectedContextRevision with CONFLICT and applies nothing", async () => {
    const tracksBefore =
      useProjectStore.getState().project.timeline.tracks.length;
    const res = await handleLiveBridgeRequest(
      req("applyActions", {
        actions: [act("track/add", { trackType: "video" })],
        expectedContextRevision: getLiveEditorContext().contextRevision + 99,
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("CONFLICT");
    expect(res.error?.details?.currentContextRevision).toBe(
      getLiveEditorContext().contextRevision,
    );
    expect(useProjectStore.getState().project.timeline.tracks.length).toBe(
      tracksBefore,
    );
  });

  it("passes when expected revisions match", async () => {
    const res = await handleLiveBridgeRequest(
      req("applyActions", {
        actions: [act("track/add", { trackType: "video" })],
        expectedRevision: getProjectRevision(),
        expectedContextRevision: getLiveEditorContext().contextRevision,
      }),
    );
    expect(res.ok).toBe(true);
  });

  it("rolls back the whole batch as one unit on a mid-batch error", async () => {
    const tracksBefore =
      useProjectStore.getState().project.timeline.tracks.length;
    const undoBefore = undoSize();
    const revisionBefore = getProjectRevision();
    const res = await handleLiveBridgeRequest(
      req("applyActions", {
        groupLabel: "doomed batch",
        actions: [
          act("track/add", { trackType: "video" }),
          act("text/update", { clipId: "missing", updates: { text: "x" } }),
        ],
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("APPLY_FAILED");
    expect(res.error?.details?.appliedBeforeError).toBe(1);
    // The successful first action was rolled back…
    expect(useProjectStore.getState().project.timeline.tracks.length).toBe(
      tracksBefore,
    );
    // …and the failed batch left no entries on the undo stack.
    expect(undoSize()).toBe(undoBefore);
    expect(getProjectRevision()).toBe(revisionBefore);
  });

  it("does not undo user history when the batch fails before applying anything", async () => {
    await useProjectStore
      .getState()
      .executeAction(act("track/add", { trackType: "video" }));
    const tracksBefore =
      useProjectStore.getState().project.timeline.tracks.length;
    const undoBefore = undoSize();
    const res = await handleLiveBridgeRequest(
      req("applyActions", {
        actions: [act("text/update", { clipId: "missing", updates: {} })],
      }),
    );
    expect(res.ok).toBe(false);
    expect(undoSize()).toBe(undoBefore);
    expect(useProjectStore.getState().project.timeline.tracks.length).toBe(
      tracksBefore,
    );
  });

  it("a failed draft never calls GUI undo or leaks an Agent push owner", async () => {
    const originalUndo = useProjectStore.getState().undo;
    const undo = vi.fn(async () => {
      throw new Error("GUI undo must not run for an isolated draft");
    });
    useProjectStore.setState({ undo });
    let res: Awaited<ReturnType<typeof handleLiveBridgeRequest>>;
    try {
      res = await handleLiveBridgeRequest(
        req("applyActions", {
          groupLabel: "doomed batch",
          actions: [
            act("track/add", { trackType: "video" }),
            act("text/update", { clipId: "missing", updates: { text: "x" } }),
          ],
        }),
      );
    } finally {
      useProjectStore.setState({ undo: originalUndo });
    }
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("APPLY_FAILED");
    expect(undo).not.toHaveBeenCalled();
    expect(
      useProjectStore.getState().actionExecutor.getPushOwner(),
    ).toBeUndefined();
    // A later human edit keeps its own (human) undo unit.
    await useProjectStore
      .getState()
      .executeAction(act("track/add", { trackType: "audio" }));
    const entries = useProjectStore
      .getState()
      .actionExecutor.getHistory()
      .getHistoryEntries();
    expect(entries.at(-1)?.owner).toBeUndefined();
  });

  it("requestSave routes through the GUI save path and returns the revision", async () => {
    const forceSave = vi.fn(async () => {});
    useProjectStore.setState({ forceSave });
    const res = await handleLiveBridgeRequest(req("requestSave"));
    expect(forceSave).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ revision: getProjectRevision() });
  });

  it("requestSave reports a durable-save failure instead of acknowledging it", async () => {
    const forceSave = vi.fn(async () => {
      throw new Error("IndexedDB transaction aborted");
    });
    useProjectStore.setState({ forceSave });

    const res = await handleLiveBridgeRequest(req("requestSave"));

    expect(forceSave).toHaveBeenCalledOnce();
    expect(res).toMatchObject({
      ok: false,
      error: {
        code: "BRIDGE_ERROR",
        message: "IndexedDB transaction aborted",
      },
    });
  });

  it("installLiveBridge wires onRequest → respond with the call id", async () => {
    const replies: unknown[] = [];
    let subscribed = true;
    let handler:
      | ((request: { callId: string; kind: string }) => Promise<void>)
      | null = null;
    (window as { openreel?: unknown }).openreel = {
      platform: "desktop",
      liveBridge: {
        onRequest: (h: typeof handler) => {
          handler = h;
          return () => {
            subscribed = false;
            handler = null;
          };
        },
        respond: (reply: unknown) => replies.push(reply),
      },
    };

    const cleanup = installLiveBridge();
    expect(handler).not.toBeNull();
    await handler!({ callId: "call-42", kind: "getIdentity" });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ callId: "call-42", ok: true });
    cleanup();
    expect(subscribed).toBe(false);
    expect(handler).toBeNull();
  });

  it("installLiveBridge is a no-op without the desktop bridge", () => {
    expect(() => installLiveBridge()).not.toThrow();
  });
});
