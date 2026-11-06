import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskAgentState } from "../../../../../desktop/src/shared/task-review-runtime-types";
import { createFakeTaskAgentBridge, fakeJob } from "./testing";
import { useTaskAgentState } from "./useTaskAgentState";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const coverage = (taskId: string, unitIds: string[]): TaskAgentState => ({ jobs: [{ ...fakeJob("finished", "completed", ["unit-1"]), taskId, completedUnitIds: unitIds }] });

describe("task agent state refresh", () => {
  it("coalesces revisions arriving during a terminal-job read and fetches current criteria coverage once", async () => {
    const agent = createFakeTaskAgentBridge();
    const oldRead = deferred<TaskAgentState>();
    const currentRead = deferred<TaskAgentState>();
    const getState = vi.spyOn(agent, "getState").mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(currentRead.promise);
    const target = { root: "root", taskId: "task-1" };
    const hook = renderHook(({ revision, target }) => useTaskAgentState(agent, target, revision), { initialProps: { revision: 1, target } });
    expect(getState).toHaveBeenCalledTimes(1);
    hook.rerender({ revision: 2, target });
    hook.rerender({ revision: 3, target });
    expect(getState).toHaveBeenCalledTimes(1);
    // Policy stays unchanged; only local criteria invalidated the old checkpoint.
    await act(async () => { oldRead.resolve(coverage("task-1", ["unit-1"])); });
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(2));
    expect(hook.result.current.state).toBeNull();
    await act(async () => { currentRead.resolve(coverage("task-1", [])); });
    expect(hook.result.current.state?.jobs[0]?.completedUnitIds).toEqual([]);
    // A new target object at the same identity/revision must not read on every render.
    hook.rerender({ revision: 3, target: { ...target } });
    hook.rerender({ revision: 3, target: { ...target } });
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it.each(["resolve", "reject"] as const)("ignores a late %s after switching tasks", async (outcome) => {
    const agent = createFakeTaskAgentBridge();
    const oldRead = deferred<TaskAgentState>();
    const currentRead = deferred<TaskAgentState>();
    const getState = vi.spyOn(agent, "getState").mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(currentRead.promise);
    const hook = renderHook(({ target }) => useTaskAgentState(agent, target, 1), { initialProps: { target: { root: "root", taskId: "task-a" } } });
    hook.rerender({ target: { root: "root", taskId: "task-b" } });
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(2));
    await act(async () => { currentRead.resolve(coverage("task-b", [])); });
    await act(async () => {
      if (outcome === "resolve") oldRead.resolve(coverage("task-a", ["unit-1"]));
      else oldRead.reject(new Error("old task read failed"));
    });
    expect(hook.result.current.state?.jobs[0]?.taskId).toBe("task-b");
    expect(hook.result.current.error).toBeNull();
  });

  it("does not issue a queued revision refresh after unmount", async () => {
    const agent = createFakeTaskAgentBridge();
    const read = deferred<TaskAgentState>();
    const getState = vi.spyOn(agent, "getState").mockReturnValueOnce(read.promise);
    const target = { root: "root", taskId: "task-1" };
    const hook = renderHook(({ revision }) => useTaskAgentState(agent, target, revision), { initialProps: { revision: 1 } });
    hook.rerender({ revision: 2 });
    hook.unmount();
    await act(async () => { read.resolve(coverage("task-1", ["unit-1"])); });
    expect(getState).toHaveBeenCalledTimes(1);
  });
});
