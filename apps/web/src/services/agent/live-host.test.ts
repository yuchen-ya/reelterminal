import { describe, it, expect, beforeEach } from "vitest";
import type { Action } from "@openreel/core";
import { executeTool } from "@openreel/agent";
import type { EditorStateView } from "@openreel/agent";
import { useProjectStore } from "../../stores/project-store";
import { LiveEditorHost } from "./live-host";

const act = (type: string, params: Record<string, unknown>): Action => ({
  type,
  id: `a-${type}`,
  timestamp: Date.now(),
  params,
});

describe("LiveEditorHost", () => {
  beforeEach(() => {
    useProjectStore.getState().createNewProject();
  });

  it("drives the live store through the agent executor", async () => {
    const host = new LiveEditorHost();
    const before = useProjectStore.getState().project.timeline.tracks.length;

    const res = await executeTool("add_track", { trackType: "video" }, host);
    expect(res.ok).toBe(true);
    expect(useProjectStore.getState().project.timeline.tracks.length).toBe(before + 1);

    const state = (await executeTool("get_editor_state", {}, host)).data as EditorStateView;
    expect(state.trackCount).toBe(before + 1);
  });

  it("requireOpenProject throws when no project is open", () => {
    useProjectStore.setState({ hasOpenProject: false });
    const host = new LiveEditorHost();
    expect(() => host.getProject()).toThrow(/No project is open/);
  });

  it("rolls a transaction back as one unit", async () => {
    const host = new LiveEditorHost();
    const before = useProjectStore.getState().project.timeline.tracks.length;

    const txn = host.beginTransaction("turn");
    await host.applyAction(act("track/add", { trackType: "text" }));
    await host.applyAction(act("track/add", { trackType: "graphics" }));
    expect(useProjectStore.getState().project.timeline.tracks.length).toBe(before + 2);

    await host.rollbackTransaction(txn);
    expect(useProjectStore.getState().project.timeline.tracks.length).toBe(before);
  });

  it("rollback reverts only the agent units above an interleaved human edit", async () => {
    const host = new LiveEditorHost();
    const store = () => useProjectStore.getState();
    const trackIds = () => store().project.timeline.tracks.map((t) => t.id);
    const addedId = (prior: string[], next: string[]) =>
      next.find((id) => !prior.includes(id));

    let ids = trackIds();
    const txn = host.beginTransaction("turn");
    await host.applyAction(act("track/add", { trackType: "text" }));
    const agentFirst = addedId(ids, trackIds());
    ids = trackIds();

    // A human edit lands mid-transaction (between agent batches the push
    // owner is the default human one; ADR 0004 Decision 12 auto-closes the
    // open agent group, so the human edit keeps its own undo unit).
    store().actionExecutor.setPushOwner(undefined);
    await store().executeAction(act("track/add", { trackType: "video" }));
    store().actionExecutor.setPushOwner("agent");
    const humanTrack = addedId(ids, trackIds());
    ids = trackIds();

    await host.applyAction(act("track/add", { trackType: "audio" }));
    const agentTail = addedId(ids, trackIds());

    await host.rollbackTransaction(txn);

    const remaining = trackIds();
    // The agent unit above the human edit is reverted...
    expect(remaining).not.toContain(agentTail);
    // ...the human unit is never eaten...
    expect(remaining).toContain(humanTrack);
    // ...and the agent unit below the human edit honestly stays applied —
    // undo is strictly LIFO, so reaching it would pop the human's unit.
    expect(remaining).toContain(agentFirst);
    // The human unit is on top of the undo stack, independently undoable.
    expect(store().actionExecutor.getHistory().peekUndoOwner()).toBeUndefined();
  });

  it("rollback does not eat a human edit that landed last in the transaction", async () => {
    const host = new LiveEditorHost();
    const store = () => useProjectStore.getState();
    const trackIds = () => store().project.timeline.tracks.map((t) => t.id);
    const addedId = (prior: string[], next: string[]) =>
      next.find((id) => !prior.includes(id));

    let ids = trackIds();
    const txn = host.beginTransaction("turn");
    await host.applyAction(act("track/add", { trackType: "text" }));
    const agentTrack = addedId(ids, trackIds());
    ids = trackIds();

    // The human edit is the LAST push before rollback: the old single-undo
    // rollback would have reverted the human's unit and left the agent's
    // applied.
    store().actionExecutor.setPushOwner(undefined);
    await store().executeAction(act("track/add", { trackType: "video" }));
    const humanTrack = addedId(ids, trackIds());

    await host.rollbackTransaction(txn);

    const remaining = trackIds();
    expect(remaining).toContain(humanTrack);
    // The agent unit below the human edit stays applied (partial rollback).
    expect(remaining).toContain(agentTrack);
  });

  it("exposes the capability manifest", () => {
    const host = new LiveEditorHost();
    expect(host.capabilities().blendModes.length).toBeGreaterThan(0);
  });
});
