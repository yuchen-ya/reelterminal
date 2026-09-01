import { describe, it, expect, vi } from "vitest";
import {
  isLiveStoreConflict,
  LiveStoreConflictError,
} from "@openreel/agent-facade";
import type { Action } from "@openreel/core/types/actions";
import { createLiveStoreBridge } from "./renderer-store-adapter";
import type { LiveBridgeRequest, LiveBridgeReply } from "../../shared/live";

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

  it("applyActions forwards actions, groupLabel and CAS preconditions", async () => {
    const { bridge, sent, validSender } = makeBridge();
    const pending = bridge.store.applyActions([fakeAction], {
      groupLabel: "agent: edit.apply",
      expectedRevision: 5,
      expectedContextRevision: 2,
    });
    expect(sent[0]).toMatchObject({
      callId: "call-1",
      kind: "applyActions",
      groupLabel: "agent: edit.apply",
      expectedRevision: 5,
      expectedContextRevision: 2,
    });
    expect((sent[0]!.actions as unknown[]).length).toBe(1);
    bridge.handleResponse(validSender, {
      callId: "call-1",
      ok: true,
      result: { revision: 6, createdIds: ["clip-1"] },
    });
    await expect(pending).resolves.toEqual({
      revision: 6,
      createdIds: ["clip-1"],
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
