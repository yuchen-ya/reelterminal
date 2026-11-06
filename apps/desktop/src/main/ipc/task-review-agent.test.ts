import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { CHANNELS } from "../../shared/channels";
import type { TaskCompletionEvent, TaskCompletionRequest, TaskSemanticSearchResult } from "../../shared/task-review-runtime-types";
import type { TaskReviewRuntime } from "../task-review-runtime";

const state = vi.hoisted(() => ({ handlers: new Map<string, Function>(), editor: undefined as unknown }));
vi.mock("electron", () => ({ ipcMain: {
  handle: (channel: string, handler: Function) => state.handlers.set(channel, handler),
  removeHandler: (channel: string) => state.handlers.delete(channel),
} }));
vi.mock("../editor-window", () => ({ getEditorWebContents: () => state.editor }));
vi.mock("../protocol", () => ({ APP_INDEX: "app://reelterminal/index.html" }));
import { registerTaskAgentIpc } from "./task-review-agent";

function contents() {
  return Object.assign(new EventEmitter(), { mainFrame: { url: "app://reelterminal/index.html" }, send: vi.fn(), isDestroyed: () => false });
}
function fixture() {
  const editor = contents(); state.editor = editor;
  let listener: (event: TaskCompletionEvent) => void = () => {};
  const pending: { input: TaskCompletionRequest; resolve: () => void }[] = [];
  const unsubscribe = vi.fn();
  const runtime = {
    models: { get: vi.fn(async () => ({ endpoint: "https://model.example/v1", hasApiKey: true })), save: vi.fn() },
    onCompletion: (callback: typeof listener) => { listener = callback; return unsubscribe; },
    complete: vi.fn((input: TaskCompletionRequest) => new Promise<void>(resolve => pending.push({ input, resolve }))),
    cancelCompletion: vi.fn(async (_input: { taskId: string; generationId: string }) => {}),
    search: vi.fn(async (): Promise<TaskSemanticSearchResult> => ({ matches: [], searchedUnitCount: 0 })),
    cancelSearch: vi.fn(async () => {}),
    continueAnalysis: vi.fn(async () => ({ jobs: [] })),
  };
  const dispose = registerTaskAgentIpc(runtime as unknown as TaskReviewRuntime);
  const invoke = (method: string, input?: unknown, sender = editor) => state.handlers.get(CHANNELS.taskAgent)!({ sender, senderFrame: sender.mainFrame }, { method, input });
  const input = { root: "C:/task", taskId: randomUUID(), unitId: randomUUID(), sourceVersionId: randomUUID(), generationId: "renderer-generation", text: "Feedback draft" };
  return { editor, runtime, pending, invoke, input, emit: (event: TaskCompletionEvent) => listener(event), unsubscribe, dispose };
}
beforeEach(() => state.handlers.clear());

it("streams only the owning task/unit/generation and drops events after cancellation", async () => {
  const test = fixture();
  const completion = test.invoke("complete", test.input);
  const internal = test.pending[0].input;
  expect(internal.generationId).not.toBe(test.input.generationId);
  const event = { taskId: internal.taskId, unitId: internal.unitId, generationId: internal.generationId, delta: "suggestion", done: false };
  test.emit({ ...event, taskId: randomUUID() });
  test.emit({ ...event, unitId: randomUUID() });
  expect(test.editor.send).not.toHaveBeenCalled();
  test.emit(event);
  expect(test.editor.send).toHaveBeenLastCalledWith(CHANNELS.taskAgentCompletion, { ...event, generationId: test.input.generationId });
  await test.invoke("cancelCompletion", { taskId: test.input.taskId, generationId: "other-generation" });
  expect(test.runtime.cancelCompletion).not.toHaveBeenCalled();
  await test.invoke("cancelCompletion", { taskId: test.input.taskId, generationId: test.input.generationId });
  expect(test.runtime.cancelCompletion).toHaveBeenCalledWith({ taskId: internal.taskId, generationId: internal.generationId });
  test.editor.send.mockClear(); test.emit(event);
  expect(test.editor.send).not.toHaveBeenCalled();
  test.pending[0].resolve(); await completion;
  test.dispose(); expect(test.unsubscribe).toHaveBeenCalledOnce();
});

it("binds cancellation to the original webContents and cancels on navigation or destruction", async () => {
  const test = fixture();
  const completion = test.invoke("complete", test.input);
  const secondEditor = contents(); state.editor = secondEditor;
  await test.invoke("cancelCompletion", { taskId: test.input.taskId, generationId: test.input.generationId }, secondEditor);
  expect(test.runtime.cancelCompletion).not.toHaveBeenCalled();
  test.editor.emit("did-start-navigation", {}, "app://reelterminal/index.html", false, true);
  expect(test.runtime.cancelCompletion).toHaveBeenCalledWith({ taskId: test.input.taskId, generationId: test.pending[0].input.generationId });
  test.pending[0].resolve(); await completion;
  const second = test.invoke("complete", test.input, secondEditor);
  secondEditor.emit("destroyed");
  expect(test.runtime.cancelCompletion).toHaveBeenCalledTimes(2);
  test.pending[1].resolve(); await second;
  test.dispose();
});

it("guards the sender and validates configuration through the shared schema", async () => {
  const test = fixture();
  await expect(test.invoke("getModelConfig", undefined, contents())).rejects.toThrow("main editor frame");
  await expect(test.invoke("configureModel", { endpoint: "https://model.example", backgroundModel: "model", completionModel: "model", encryptedApiKey: "secret" })).rejects.toThrow();
  expect(test.runtime.models.save).not.toHaveBeenCalled();
  await test.invoke("getModelConfig");
  expect(test.runtime.models.get).toHaveBeenCalledOnce();
  test.dispose();
});

it("forwards explicit search scope and truthful coverage metadata, cancellation and budget continuation", async () => {
  const test = fixture();
  const { root, taskId, unitId, sourceVersionId } = test.input;
  const target = { root, taskId };
  const ref = { unitId, sourceVersionId, start: 0, end: 4, text: "line" };
  const result: TaskSemanticSearchResult = {
    matches: [{ unitId, sourceVersionId, reason: "Related evidence", sourceRefs: [ref], inputSourceVersionIds: [sourceVersionId] }],
    searchedUnitCount: 1, scope: { kind: "units", targets: [{ unitId, sourceVersionId }] },
    scopeUnitCount: 3, locallyScannedUnitCount: 3, candidateUnitCount: 1, modelInputRanges: [ref],
    coverage: "candidates", truncated: true, omittedUnitCount: 2, cached: false,
  };
  test.runtime.search.mockResolvedValue(result);
  for (const scope of [{ kind: "task" }, { kind: "sources", sourceVersionIds: [sourceVersionId] }, result.scope]) {
    const input = { ...target, query: "Find related evidence", scope };
    await expect(test.invoke("search", input)).resolves.toBe(result);
    expect(test.runtime.search).toHaveBeenLastCalledWith(input);
  }
  await test.invoke("cancelSearch", target);
  expect(test.runtime.cancelSearch).toHaveBeenCalledWith(target);
  await expect(test.invoke("continueAnalysis", target)).resolves.toEqual({ jobs: [] });
  expect(test.runtime.continueAnalysis).toHaveBeenCalledWith(target);
  test.runtime.search.mockRejectedValueOnce(new Error("Task identity mismatch"));
  await expect(test.invoke("search", { ...target, query: "Find evidence" })).rejects.toThrow("Task identity mismatch");
  test.dispose();
});

it("rejects untrusted search controls and malformed scopes before invoking the runtime", async () => {
  const test = fixture();
  const target = { root: test.input.root, taskId: test.input.taskId };
  for (const method of ["search", "cancelSearch", "continueAnalysis"]) {
    await expect(test.invoke(method, { ...target, query: "private" }, contents())).rejects.toThrow("main editor frame");
  }
  for (const scope of [
    { kind: "sources", sourceVersionIds: [] },
    { kind: "sources", sourceVersionIds: ["../private"] },
    { kind: "units", targets: [{ unitId: test.input.unitId }] },
    { kind: "task", sourceVersionIds: [test.input.sourceVersionId] },
  ]) {
    await expect(test.invoke("search", { ...target, query: "Find evidence", scope })).rejects.toThrow();
  }
  await expect(test.invoke("cancelSearch", { ...target, jobId: "unrelated" })).rejects.toThrow();
  await expect(test.invoke("continueAnalysis", { ...target, budget: 1000 })).rejects.toThrow();
  expect(test.runtime.search).not.toHaveBeenCalled();
  expect(test.runtime.cancelSearch).not.toHaveBeenCalled();
  expect(test.runtime.continueAnalysis).not.toHaveBeenCalled();
  test.dispose();
});
