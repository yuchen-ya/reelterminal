import { describe, expect, it } from "vitest";
import type { Action } from "@reelterminal/core";
import { createProjectStore, type ProjectState } from "../project-store";
import { createEmptyProject } from "./project-helpers";
import { workbenchHistoryAvailability } from "./workbench-history";

const action = (type: string, params: Record<string, unknown> = {}): Action => ({
  id: crypto.randomUUID(), timestamp: Date.now(), type, params,
});
const textItem = (id: string) => ({
  id, title: id, type: "text" as const,
  content: { type: "text" as const, entryId: id, title: id, speakerOrContext: "",
    versions: [{ version: 1, text: `Body ${id}`, createdAt: 1, origin: "ingest" as const }] },
});
const createStore = () => createProjectStore({ initialProject: createEmptyProject("History acceptance"), isForeground: false });
async function ingest(store: ReturnType<typeof createStore>) {
  expect(await store.getState().ingestWorkbenchBatch({ batchId: "batch", name: "Review", items: [textItem("a"), textItem("b")] })).toEqual({ ok: true });
}
function snapshot(store: ReturnType<typeof createStore>) {
  const state = store.getState();
  return { project: structuredClone(state.project), undo: [...state.actionHistory.getHistoryEntries()],
    redo: [...state.actionHistory.getRedoEntries()], journal: [...state.redoJournal] };
}

describe("legacy workbench history boundaries", () => {
  it("undoes and redoes the complete pure review unit while retaining older video history", async () => {
    const store = createStore();
    expect((await store.getState().renameProject("Video edit")).success).toBe(true);
    await ingest(store);
    expect((await store.getState().decideWorkbenchItems("batch", [{ itemId: "a", decision: "rework" }, { itemId: "b", decision: "rework" }], "human", "Fix both")).ok).toBe(true);
    const decided = structuredClone(store.getState().project.workbench);
    expect((await store.getState().undo({ scope: "workbench" })).success).toBe(true);
    expect(store.getState().project.workbench?.items.map(item => item.status)).toEqual(["pending", "pending"]);
    expect(store.getState().project.workbench?.feedback).toEqual([]);
    expect((await store.getState().redo({ scope: "workbench" })).success).toBe(true);
    expect(store.getState().project.workbench).toEqual(decided);
    expect(store.getState().project.name).toBe("Video edit");
    expect((await store.getState().undo({ scope: "workbench" })).success).toBe(true);
    expect((await store.getState().undo({ scope: "workbench" })).success).toBe(true);
    const before = snapshot(store);
    expect((await store.getState().undo({ scope: "workbench" })).success).toBe(false);
    expect(snapshot(store)).toEqual(before);
  });

  it("blocks video at the top and a mixed group whose newest action is review", async () => {
    const store = createStore();
    await ingest(store);
    expect((await store.getState().renameProject("Video top")).success).toBe(true);
    let before = snapshot(store);
    expect((await store.getState().undo({ scope: "workbench" })).success).toBe(false);
    expect(snapshot(store)).toEqual(before);
    await store.getState().undo();
    const mixed = await store.getState().submitActionBatch([
      action("project/rename", { name: "Mixed video" }),
      action("workbench/feedback.save", { feedback: {
        id: "mixed-feedback", itemId: "a", itemVersion: 1, text: "Mixed review", referencedTagIds: [],
        state: "confirmed", createdAt: 1, updatedAt: 1,
      } }),
    ], { groupLabel: "Mixed edit" });
    expect(mixed.result.success).toBe(true);
    before = snapshot(store);
    expect((await store.getState().undo({ scope: "workbench" })).success).toBe(false);
    expect(snapshot(store)).toEqual(before);
    expect((await store.getState().undo()).success).toBe(true);
    before = snapshot(store);
    expect((await store.getState().redo({ scope: "workbench" })).success).toBe(false);
    expect(snapshot(store)).toEqual(before);
  });

  it("rejects an inverse that would edit video, even when the forward action is review", async () => {
    const store = createStore();
    store.getState().actionHistory.push(action("workbench/restore"), action("project/rename", { name: "Unexpected video change" }));
    const before = snapshot(store);
    expect((await store.getState().undo({ scope: "workbench" })).success).toBe(false);
    expect(snapshot(store)).toEqual(before);
  });

  it("respects template sequence and the actual next redo journal branch", async () => {
    const store = createStore();
    await ingest(store);
    const sequence = store.getState().actionHistory.nextSequence();
    const template = { sequence } as ProjectState["templateUndoStack"][number];
    store.setState({ templateUndoStack: [template] });
    let before = snapshot(store);
    expect((await store.getState().undo({ scope: "workbench" })).success).toBe(false);
    expect(snapshot(store)).toEqual(before);
    store.setState({ templateUndoStack: [] });
    expect((await store.getState().undo({ scope: "workbench" })).success).toBe(true);
    store.setState({ templateRedoStack: [template], redoJournal: ["action", "template"] });
    before = snapshot(store);
    expect((await store.getState().redo({ scope: "workbench" })).success).toBe(false);
    expect(snapshot(store)).toEqual(before);
    store.setState({ redoJournal: ["template", "action"] });
    expect(workbenchHistoryAvailability(store.getState(), "redo").allowed).toBe(true);
    expect((await store.getState().redo({ scope: "workbench" })).success).toBe(true);
    expect(store.getState().project.workbench?.items).toHaveLength(2);
    expect(store.getState().templateRedoStack).toEqual([template]);
  });

  it("blocks migrated read-only backups and rechecks the top unit inside the mutation queue", async () => {
    const store = createStore();
    await ingest(store);
    const project = store.getState().project;
    store.setState({ project: { ...project, reviewMigration: {} as NonNullable<typeof project.reviewMigration> } });
    const before = snapshot(store);
    expect((await store.getState().undo({ scope: "workbench" })).success).toBe(false);
    expect(snapshot(store)).toEqual(before);
    store.setState({ project });
    let queued: (() => unknown) | undefined;
    store.setState({ submitWorkspaceMutation: operation => new Promise(resolve => { queued = () => resolve(operation()); }) });
    expect(workbenchHistoryAvailability(store.getState(), "undo").allowed).toBe(true);
    const pending = store.getState().undo({ scope: "workbench" });
    store.getState().actionHistory.push(action("project/rename", { name: "queued" }), action("project/rename", { name: "prior" }));
    const queuedState = snapshot(store);
    queued!();
    expect((await pending).success).toBe(false);
    expect(snapshot(store)).toEqual(queuedState);
  });
});
