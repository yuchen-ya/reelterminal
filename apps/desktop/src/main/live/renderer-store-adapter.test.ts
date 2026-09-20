import { describe, it, expect, vi } from "vitest";
import {
  isLiveStoreConflict,
  LiveStoreConflictError,
} from "@reelterminal/agent-facade";
import type { Action } from "@reelterminal/core/types/actions";
import { createLiveStoreBridge } from "./renderer-store-adapter";
import type {
  LiveBridgeRequest,
  LiveBridgeReply,
  LiveMediaImportRequest,
} from "../../shared/live";

function makeBridge() {
  const sent: LiveBridgeRequest[] = [];
  let n = 0;
  const validSender = { name: "main-webContents" };
  const bridge = createLiveStoreBridge({
    send: (req) => sent.push(req),
    isValidSender: (sender) => sender === validSender,
    genId: () => `call-${++n}`,
  });
  return { bridge, sent, validSender };
}

const fakeAction = {
  type: "track/add",
  id: "a1",
  timestamp: 1,
  params: { trackType: "video" },
} as unknown as Action;

describe("createLiveStoreBridge", () => {
  it("correlates getState back to its request by callId", async () => {
    const { bridge, sent, validSender } = makeBridge();
    const pending = bridge.store.getState();
    expect(sent).toEqual([{ callId: "call-1", kind: "getState" }]);
    expect(bridge.pendingCount).toBe(1);

    const reply: LiveBridgeReply = {
      callId: "call-1",
      ok: true,
      result: { project: { id: "p1" }, revision: 3 },
    };
    bridge.handleResponse(validSender, reply);
    await expect(pending).resolves.toEqual({ project: { id: "p1" }, revision: 3 });
    expect(bridge.pendingCount).toBe(0);
  });

  it("sends the four read kinds and requestSave with no payload", async () => {
    const { bridge, sent, validSender } = makeBridge();
    const identity = bridge.store.getIdentity();
    const context = bridge.store.getContext();
    const save = bridge.store.requestSave();
    bridge.handleResponse(validSender, {
      callId: "call-1",
      ok: true,
      result: { projectId: "p", projectName: "P", windowId: "main" },
    });
    bridge.handleResponse(validSender, {
      callId: "call-2",
      ok: true,
      result: { contextRevision: 2 },
    });
    bridge.handleResponse(validSender, {
      callId: "call-3",
      ok: true,
      result: { revision: 9 },
    });
    await expect(identity).resolves.toEqual({
      projectId: "p",
      projectName: "P",
      windowId: "main",
    });
    await expect(context).resolves.toEqual({ contextRevision: 2 });
    await expect(save).resolves.toEqual({ revision: 9 });
    expect(sent.map((r) => r.kind)).toEqual([
      "getIdentity",
      "getContext",
      "requestSave",
    ]);
  });

  it("forwards bounded change/history reads and CAS/idempotent history control", async () => {
    const { bridge, sent, validSender } = makeBridge();
    const changes = bridge.store.getProjectChanges({ sinceRevision: 4, limit: 10, cursor: "pc" });
    const history = bridge.store.getHistory({ limit: 8 });
    const control = bridge.store.historyControl("undo", {
      expectedRevision: 7,
      idempotencyKey: "undo-7",
    });
    expect(sent).toEqual([
      { callId: "call-1", kind: "getProjectChanges", sinceRevision: 4, limit: 10, cursor: "pc" },
      { callId: "call-2", kind: "getHistory", limit: 8 },
      { callId: "call-3", kind: "historyControl", historyAction: "undo", expectedRevision: 7, idempotencyKey: "undo-7" },
    ]);
    bridge.handleResponse(validSender, {
      callId: "call-1",
      ok: true,
      result: { fromRevision: 4, toRevision: 7, changes: [], nextCursor: null, requiresFullRefresh: false },
    });
    bridge.handleResponse(validSender, {
      callId: "call-2",
      ok: true,
      result: { revision: 7, available: true, canUndo: true, canRedo: false, undoCount: 1, redoCount: 0, entries: [] },
    });
    bridge.handleResponse(validSender, {
      callId: "call-3",
      ok: true,
      result: { revision: 8, canUndo: false, canRedo: true, replayed: false },
    });
    await expect(changes).resolves.toMatchObject({ fromRevision: 4, toRevision: 7 });
    await expect(history).resolves.toMatchObject({ available: true, undoCount: 1 });
    await expect(control).resolves.toMatchObject({ revision: 8, canRedo: true });
  });

  it("applyActions forwards actions, groupLabel and CAS preconditions", async () => {
    const { bridge, sent, validSender } = makeBridge();
    const pending = bridge.store.applyActions([fakeAction], {
      groupLabel: "agent: edit.apply",
      expectedRevision: 5,
      expectedContextRevision: 2,
      idempotencyKey: "edit-batch-5",
    });
    expect(sent[0]).toMatchObject({
      callId: "call-1",
      kind: "applyActions",
      groupLabel: "agent: edit.apply",
      expectedRevision: 5,
      expectedContextRevision: 2,
      idempotencyKey: "edit-batch-5",
    });
    expect((sent[0]!.actions as unknown[]).length).toBe(1);
    bridge.handleResponse(validSender, {
      callId: "call-1",
      ok: true,
      // The renderer diffs created ids per category (LiveCreatedIds).
      result: {
        revision: 6,
        createdIds: { tracks: [], clips: ["clip-1"], textClips: [] },
      },
    });
    await expect(pending).resolves.toEqual({
      revision: 6,
      createdIds: { tracks: [], clips: ["clip-1"], textClips: [] },
    });
  });

  it("applyActions omits idempotencyKey from the bridge request when the caller sends none", async () => {
    const { bridge, sent } = makeBridge();
    const pending = bridge.store.applyActions([fakeAction], {
      groupLabel: "agent: edit.apply",
      expectedRevision: 3,
    });
    expect(sent[0]).toMatchObject({
      kind: "applyActions",
      groupLabel: "agent: edit.apply",
      expectedRevision: 3,
    });
    expect("idempotencyKey" in sent[0]!).toBe(false);
    bridge.teardown("test finished");
    await expect(pending).rejects.toThrow("test finished");
  });

  it("editorControl forwards ephemeral action and target/CAS fields", async () => {
    const { bridge, sent, validSender } = makeBridge();
    const pending = bridge.store.editorControl({
      action: "select",
      targets: [
        { kind: "clip", id: "clip-1" },
        { kind: "media", id: "media-1" },
      ],
      selectionMode: "add",
      expectedContextRevision: 4,
    });
    expect(sent[0]).toEqual({
      callId: "call-1",
      kind: "editorControl",
      action: "select",
      targets: [
        { kind: "clip", id: "clip-1" },
        { kind: "media", id: "media-1" },
      ],
      selectionMode: "add",
      expectedContextRevision: 4,
    });
    bridge.handleResponse(validSender, {
      callId: "call-1",
      ok: true,
      result: {
        action: "select",
        playbackState: "paused",
        playheadSeconds: 2,
        selectedClipIds: ["clip-1"],
        selectedTextIds: [],
        selectedMediaIds: ["media-1"],
        revealedTargets: [
          { kind: "clip", id: "clip-1" },
          { kind: "media", id: "media-1" },
        ],
        contextRevision: 5,
      },
    });
    await expect(pending).resolves.toMatchObject({
      action: "select",
      selectedClipIds: ["clip-1"],
      selectedMediaIds: ["media-1"],
    });
  });

  it("importMedia forwards the complete request and CAS/group options", async () => {
    const { bridge, sent, validSender } = makeBridge();
    const request: LiveMediaImportRequest = {
      path: "/media-root/agent-shot.mp4",
      name: "Agent shot",
      type: "video",
      metadata: {
        durationSec: 2,
        width: 1920,
        height: 1080,
        frameRate: 30,
        codec: "h264",
        fileSize: 42,
      },
      sourceFile: {
        name: "agent-shot.mp4",
        size: 42,
        lastModified: 123,
      },
    };
    const pending = bridge.store.importMedia(request, {
      groupLabel: "agent: media.import",
      expectedRevision: 5,
      expectedContextRevision: 2,
    });
    expect(sent[0]).toEqual({
      callId: "call-1",
      kind: "importMedia",
      ...request,
      groupLabel: "agent: media.import",
      expectedRevision: 5,
      expectedContextRevision: 2,
    });

    bridge.handleResponse(validSender, {
      callId: "call-1",
      ok: true,
      result: { revision: 6, mediaId: "media-1" },
    });
    await expect(pending).resolves.toEqual({
      revision: 6,
      mediaId: "media-1",
    });
  });

  it("maps a renderer CONFLICT reply to LiveStoreConflictError with details", async () => {
    const { bridge, validSender } = makeBridge();
    const pending = bridge.store.applyActions([fakeAction], {
      groupLabel: "agent: edit.apply",
      expectedRevision: 5,
    });
    bridge.handleResponse(validSender, {
      callId: "call-1",
      ok: false,
      error: {
        code: "CONFLICT",
        message: "Project revision mismatch: expected 5, current 7.",
        details: { currentRevision: 7 },
      },
    });
    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LiveStoreConflictError);
    expect(isLiveStoreConflict(failure)).toBe(true);
    expect((failure as LiveStoreConflictError).details).toEqual({
      currentRevision: 7,
    });
  });

  it("maps other error codes to a generic Error with the message", async () => {
    const { bridge, validSender } = makeBridge();
    const pending = bridge.store.getState();
    bridge.handleResponse(validSender, {
      callId: "call-1",
      ok: false,
      error: { code: "NO_PROJECT", message: "No project is open" },
    });
    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(LiveStoreConflictError);
    expect((failure as Error).message).toBe("No project is open");
    expect((failure as { code?: string }).code).toBe("NO_PROJECT");
  });

  it("drops responses from a foreign sender (DESK-06); the right sender still resolves", async () => {
    const { bridge, validSender } = makeBridge();
    const pending = bridge.store.getState();
    bridge.handleResponse({ name: "evil-webContents" }, {
      callId: "call-1",
      ok: true,
      result: { project: { id: "forged" }, revision: 0 },
    });
    expect(bridge.pendingCount).toBe(1);
    bridge.handleResponse(validSender, {
      callId: "call-1",
      ok: true,
      result: { project: { id: "real" }, revision: 1 },
    });
    await expect(pending).resolves.toEqual({
      project: { id: "real" },
      revision: 1,
    });
  });

  it("times out a read after 10s and cleans the pending map", async () => {
    vi.useFakeTimers();
    try {
      const { bridge } = makeBridge();
      const pending = bridge.store.getState();
      const assertion = expect(pending).rejects.toThrow(/timed out after 10000ms/);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(bridge.pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives applyActions a 30s timeout", async () => {
    vi.useFakeTimers();
    try {
      const { bridge } = makeBridge();
      const pending = bridge.store.applyActions([fakeAction], {
        groupLabel: "agent: edit.apply",
      });
      const assertion = expect(pending).rejects.toThrow(/timed out after 30000ms/);
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(bridge.pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects synchronously when the window is gone (send throws)", async () => {
    const bridge = createLiveStoreBridge({
      send: () => {
        throw new Error("No editor window is open");
      },
      isValidSender: () => true,
    });
    await expect(bridge.store.getState()).rejects.toThrow(
      "No editor window is open",
    );
    expect(bridge.pendingCount).toBe(0);
  });

  it("teardown rejects every pending call honestly", async () => {
    const { bridge } = makeBridge();
    const a = bridge.store.getState();
    const b = bridge.store.requestSave();
    bridge.teardown("live collaboration disabled");
    await expect(a).rejects.toThrow("live collaboration disabled");
    await expect(b).rejects.toThrow("live collaboration disabled");
    expect(bridge.pendingCount).toBe(0);
  });
});
