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

  it("keeps overlapping owner groups isolated when pushes interleave", () => {
    const history = new ActionHistory();
    history.setActiveOwner("agent");
    const agentGroup = history.beginGroup("agent batch");
    history.push(act("track/add", { trackType: "text" }), inv("track/remove"));

    // A human gesture overlaps the still-open Agent transaction.
    history.setActiveOwner(undefined);
    const humanGroup = history.beginGroup("human drag");
    history.push(act("track/add", { trackType: "video" }), inv("track/remove"));

    // The Agent continues in its own group, then closes exactly its handle.
    history.setActiveOwner("agent");
    history.push(act("track/add", { trackType: "audio" }), inv("track/remove"));
    history.endGroup(agentGroup);

    // The human gesture remains open and its tail keeps the human group.
    history.setActiveOwner(undefined);
    history.push(act("track/add", { trackType: "video" }), inv("track/remove"));
    history.endGroup(humanGroup);

    expect(history.getUndoStackSize()).toBe(4);
    expect(history.getDisplayHistory()).toHaveLength(4);

    // Undo remains chronological. Non-contiguous fragments never jump across
    // the foreign entry, but both owners keep their intended attribution.
    expect(history.undoGroup()).toHaveLength(1); // human tail
    expect(history.undoGroup()).toHaveLength(1); // agent tail
    expect(history.undoGroup()).toHaveLength(1); // human head
    expect(history.undoGroup()).toHaveLength(1); // agent head
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

  it("redo replays interleaved units separately", () => {
    const history = new ActionHistory();
    history.setActiveOwner("agent");
    const firstAgentGroup = history.beginGroup("agent batch");
    history.push(act("track/add", { trackType: "text" }), inv("track/remove"));
    history.setActiveOwner(undefined);
    history.push(act("track/add", { trackType: "video" }), inv("track/remove"));
    history.setActiveOwner("agent");
    const agentTailGroup = history.beginGroup("agent batch tail");
    history.push(act("track/add", { trackType: "audio" }), inv("track/remove"));
    history.endGroup(agentTailGroup);
    history.endGroup(firstAgentGroup);
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
    // Agent push via the explicit parameter stays outside the human group.
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

  it("an owner-scoped end never closes another owner's newer group", () => {
    const history = new ActionHistory();
    const humanGroup = history.beginGroup("human drag");
    const agentGroup = history.beginGroup("agent batch", "agent");

    // A legacy human caller omits its handle; owner scoping still closes the
    // human frame rather than popping the newer Agent frame.
    history.endGroup();
    history.push(
      act("track/add", { trackType: "text" }),
      inv("track/remove"),
      "agent",
    );
    history.endGroup(agentGroup);
    history.push(act("track/add", { trackType: "video" }), inv("track/remove"));

    const entries = history.getHistoryEntries();
    expect(entries[0]?.groupId).toBe(agentGroup);
    expect(entries[1]?.groupId).toBeUndefined();
    expect(humanGroup).not.toBe(agentGroup);
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

  it("publishes a complete pushed group once and isolates faulty observers", () => {
    const history = new ActionHistory();
    let healthyCalls = 0;
    history.subscribe(() => {
      healthyCalls += 1;
    });
    history.subscribe(() => {
      throw new Error("broken history observer");
    });

    expect(() =>
      history.pushGroup(
        [
          {
            action: act("track/add", { trackType: "video" }),
            inverseAction: inv("track/remove"),
          },
          {
            action: act("track/add", { trackType: "audio" }),
            inverseAction: inv("track/remove"),
          },
        ],
        "two tracks",
        "agent",
      ),
    ).not.toThrow();
    expect(healthyCalls).toBe(1);
    expect(history.undoGroup()).toHaveLength(2);
  });

  it("trims complete oldest groups instead of retaining a partial undo unit", () => {
    const history = new ActionHistory(3);
    const entries = (kind: "video" | "audio") => [
      {
        action: act("track/add", { trackType: kind }),
        inverseAction: inv("track/remove"),
      },
      {
        action: act("track/add", { trackType: kind }),
        inverseAction: inv("track/remove"),
      },
    ];
    history.pushGroup(entries("video"), "old group");
    history.pushGroup(entries("audio"), "new group");

    expect(history.getUndoStackSize()).toBe(2);
    expect(history.undoGroup()).toHaveLength(2);
    expect(history.canUndo()).toBe(false);
  });
});
