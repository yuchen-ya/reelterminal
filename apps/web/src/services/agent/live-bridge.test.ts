import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Action } from "@openreel/core";
import type { TextClip } from "@openreel/core";
import { useProjectStore, getProjectRevision } from "../../stores/project-store";
import { getLiveEditorContext } from "../../stores/editor-context-store";
import {
  handleLiveBridgeRequest,
  installLiveBridge,
  type LiveBridgeRequest,
} from "./live-bridge";

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

  it("getContext returns the live editor context", async () => {
    const res = await handleLiveBridgeRequest(req("getContext"));
    expect(res.ok).toBe(true);
    expect(res.result).toEqual(getLiveEditorContext());
  });

  it("applyActions routes plain actions through executeAction as one undo unit", async () => {
    const tracksBefore =
      useProjectStore.getState().project.timeline.tracks.length;
    const res = await handleLiveBridgeRequest(
      req("applyActions", {
        groupLabel: "agent batch",
        actions: [
          act("track/add", { trackType: "video" }),
          act("track/add", { trackType: "audio" }),
        ],
      }),
    );
    expect(res.ok).toBe(true);
    const { revision, createdIds } = res.result as {
      revision: number;
      createdIds: string[];
    };
    expect(revision).toBe(getProjectRevision());
    // createdIds is the before/after diff of the canonical project — the two
    // genuinely-created tracks, not translator guesses.
    const trackIds = useProjectStore
      .getState()
      .project.timeline.tracks.map((t) => t.id);
    expect(createdIds).toEqual(trackIds.slice(-2));
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

  it("applyActions routes text/create engine-aware and preserves the facade id", async () => {
    const res = await handleLiveBridgeRequest(
      req("applyActions", {
        groupLabel: "add title",
        actions: [act("text/create", { clip: textClip("text-facade-1", "Hello") })],
      }),
    );
    expect(res.ok).toBe(true);
    const { createdIds } = res.result as { createdIds: string[] };
    // The facade-minted clip id survives; the auto-created text track id is
    // part of the diff too.
    expect(createdIds).toContain("text-facade-1");

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

  it("requestSave routes through the GUI save path and returns the revision", async () => {
    const forceSave = vi.fn(async () => {});
    useProjectStore.setState({ forceSave });
    const res = await handleLiveBridgeRequest(req("requestSave"));
    expect(forceSave).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ revision: getProjectRevision() });
  });

  it("installLiveBridge wires onRequest → respond with the call id", async () => {
    const replies: unknown[] = [];
    let handler:
      | ((request: { callId: string; kind: string }) => Promise<void>)
      | null = null;
    (window as { openreel?: unknown }).openreel = {
      platform: "desktop",
      liveBridge: {
        onRequest: (h: typeof handler) => {
          handler = h;
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
  });

  it("installLiveBridge is a no-op without the desktop bridge", () => {
    expect(() => installLiveBridge()).not.toThrow();
  });
});
