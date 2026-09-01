import { describe, it, expect } from "vitest";
import type { Action } from "../types/actions";
import { ActionHistory } from "./action-history";

const act = (type: string, params: Record<string, unknown> = {}): Action => ({
  type,
  id: `a-${Math.random().toString(36).slice(2)}`,
  timestamp: Date.now(),
  params,
});

const inv = (type: string, params: Record<string, unknown> = {}): Action =>
  act(type, params);

describe("ActionHistory group ownership (ADR 0004 Decision 12)", () => {
  it("keeps proximity grouping unchanged when no owner is used", () => {
    const history = new ActionHistory();
    history.beginGroup("batch");
    history.push(act("clip/add", { trackId: "t1" }), inv("clip/remove"));
    history.push(act("clip/add", { trackId: "t1" }), inv("clip/remove"));
    history.endGroup();

    expect(history.getUndoStackSize()).toBe(2);
    // One undoGroup reverts both — the legacy one-batch-one-unit behavior.
    expect(history.undoGroup()).toHaveLength(2);
    expect(history.getUndoStackSize()).toBe(0);
  });

  it("auto-closes the open group when a foreign-owner push lands mid-batch", () => {
    const history = new ActionHistory();
    history.setActiveOwner("agent");
    history.beginGroup("agent batch");
    history.push(act("track/add", { trackType: "text" }), inv("track/remove"));

    // A human edit (default owner) interleaves before the batch ends.
    history.setActiveOwner(undefined);
    history.push(act("track/add", { trackType: "video" }), inv("track/remove"));

    // The agent's remaining pushes must NOT swallow the human edit: they start
    // a new group of their own instead of rejoining the auto-closed one.
    history.setActiveOwner("agent");
    history.beginGroup("agent batch tail");
    history.push(act("track/add", { trackType: "audio" }), inv("track/remove"));
    history.endGroup();
    history.setActiveOwner(undefined);

    expect(history.getUndoStackSize()).toBe(3);

    // Newest unit = agent tail only.
    expect(history.undoGroup()).toHaveLength(1);
    // Next unit = the human edit, alone (not trapped in the agent batch).
    const humanUndo = history.undoGroup();
    expect(humanUndo).toHaveLength(1);
    // Oldest unit = the first agent push (auto-closed group).
    expect(history.undoGroup()).toHaveLength(1);
    expect(history.getUndoStackSize()).toBe(0);
  });

  it("groups same-owner pushes exactly as before", () => {
    const history = new ActionHistory();
    history.setActiveOwner("agent");
    history.beginGroup("agent batch");
    history.push(act("clip/add", { trackId: "t1" }), inv("clip/remove"));
    history.push(act("clip/add", { trackId: "t1" }), inv("clip/remove"));
    history.push(act("clip/add", { trackId: "t1" }), inv("clip/remove"));
    history.endGroup();
    history.setActiveOwner(undefined);

    expect(history.getUndoStackSize()).toBe(3);
    expect(history.undoGroup()).toHaveLength(3);
  });

  it("redo replays auto-closed units separately", () => {
    const history = new ActionHistory();
    history.setActiveOwner("agent");
    history.beginGroup("agent batch");
    history.push(act("track/add", { trackType: "text" }), inv("track/remove"));
    history.setActiveOwner(undefined);
    history.push(act("track/add", { trackType: "video" }), inv("track/remove"));
    history.setActiveOwner("agent");
    history.beginGroup("agent batch tail");
    history.push(act("track/add", { trackType: "audio" }), inv("track/remove"));
    history.endGroup();
    history.setActiveOwner(undefined);

    expect(history.undoGroup()).toHaveLength(1);
    expect(history.undoGroup()).toHaveLength(1);
    expect(history.undoGroup()).toHaveLength(1);
    expect(history.getRedoStackSize()).toBe(3);

    // Redo walks back in the same unit boundaries: first the oldest agent push…
    expect(history.redoGroup()).toHaveLength(1);
    // …then the human edit…
    expect(history.redoGroup()).toHaveLength(1);
    // …then the agent tail.
    expect(history.redoGroup()).toHaveLength(1);
    expect(history.getUndoStackSize()).toBe(3);
  });

  it("an explicit push owner overrides the active owner", () => {
    const history = new ActionHistory();
    history.beginGroup("human batch"); // default (human) owner
    history.push(act("clip/add", { trackId: "t1" }), inv("clip/remove"));
    // Agent push via the explicit parameter auto-closes the human group.
    history.push(act("clip/add", { trackId: "t1" }), inv("clip/remove"), "agent");

    expect(history.getUndoStackSize()).toBe(2);
    expect(history.undoGroup()).toHaveLength(1); // the agent push
    expect(history.undoGroup()).toHaveLength(1); // the human push
  });

  it("does not auto-group rapid updates across owners", () => {
    const history = new ActionHistory();
    const t1 = { clipId: "c1" };
    history.push(act("transform/update", t1), inv("transform/update", t1));
    history.setActiveOwner("agent");
    history.push(act("transform/update", t1), inv("transform/update", t1));
    history.setActiveOwner(undefined);

    // Same type + same target within the window would normally coalesce into
    // one entry group; across owners they must stay separate undo units.
    expect(history.getUndoStackSize()).toBe(2);
    expect(history.undoGroup()).toHaveLength(1);
    expect(history.undoGroup()).toHaveLength(1);
  });

  it("generates unique group ids for groups begun in the same millisecond", () => {
    const history = new ActionHistory();
    const first = history.beginGroup("a");
    history.endGroup();
    const second = history.beginGroup("b");
    history.endGroup();
    expect(first).not.toBe(second);
  });

  it("peekUndoOwner reports the top entry's owner without popping", () => {
    const history = new ActionHistory();
    expect(history.peekUndoOwner()).toBeUndefined();

    // Human (default-owner) edit on top.
    history.push(act("track/add", { trackType: "video" }), inv("track/remove"));
    expect(history.peekUndoOwner()).toBeUndefined();
    expect(history.getUndoStackSize()).toBe(1);

    // Agent edit on top — the rollback loops may undo this one.
    history.push(
      act("track/add", { trackType: "text" }),
      inv("track/remove"),
      "agent",
    );
    expect(history.peekUndoOwner()).toBe("agent");
    expect(history.getUndoStackSize()).toBe(2);

    // Peeking never pops: still the agent entry after repeated peeks.
    expect(history.peekUndoOwner()).toBe("agent");
    expect(history.getUndoStackSize()).toBe(2);
  });
});
