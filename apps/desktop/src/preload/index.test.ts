import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const exposed = new Map<string, unknown>();
  return {
    contextBridge: {
      exposeInMainWorld: vi.fn((name: string, api: unknown) => {
        exposed.set(name, api);
      }),
    },
    ipcRenderer: {
      invoke: vi.fn(async (..._args: unknown[]) => ({})),
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(),
    },
    webUtils: { getPathForFile: vi.fn(() => "") },
    __exposed: exposed,
  };
});

vi.mock("electron", () => electron);

import { CHANNELS } from "../shared/channels";
import type { TaskReviewBridge, TaskReviewContextBridge } from "../shared/task-review-bridge";
import type { TaskReviewExportBridge } from "../shared/task-review-export";
import type { TaskReviewMediaBridge } from "../shared/task-review-media";
import type { TaskAgentBridge, TaskCompletionEvent } from "../shared/task-review-runtime-types";
// Importing the preload module performs the exposeInMainWorld calls.
import "./index";

type AnyApi = Record<string, unknown> & {
  probeHardware: () => Promise<unknown>;
};

const exposedApi = (name: string): AnyApi => {
  const api = electron.__exposed.get(name);
  if (!api) throw new Error(`preload did not expose "${name}"`);
  return api as AnyApi;
};

describe("preload bridge naming", () => {
  it("exposes the product bridge and the controlled performance surface", () => {
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      "reelterminal",
      expect.anything(),
    );
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      "reelterminalPerformance",
      expect.objectContaining({ start: expect.any(Function), stop: expect.any(Function) }),
    );
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(2);
  });


  it("a bridge call invokes the hardware channel exactly once", async () => {
    const viaNew = exposedApi("reelterminal");
    await viaNew.probeHardware();
    const probeCalls = electron.ipcRenderer.invoke.mock.calls.filter(
      ([channel]) => channel === CHANNELS.probeHardware,
    );
    expect(probeCalls).toHaveLength(1);
  });

  it("menu actions and the export port handoff come from the CHANNELS table", () => {
    // The preload must subscribe through the shared constant table, not
    // bypassing string literals (those are what drifted during the rename).
    expect(CHANNELS.menuAction).toBe("reelterminal:menu:action");
    expect(CHANNELS.exportPortHandoff).toBe("reelterminal:export-port");
  });

  it("routes task calls and removes the exact completion listener on unsubscribe", async () => {
    const api = exposedApi("reelterminal") as AnyApi & { taskReview: TaskReviewBridge; taskReviewContext: TaskReviewContextBridge; taskReviewExport: TaskReviewExportBridge; taskReviewMedia: TaskReviewMediaBridge; taskAgent: TaskAgentBridge };
    await api.taskReview.open("C:/task");
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(CHANNELS.taskReview, { method: "open", input: { root: "C:/task" } });
    const refresh = { root: "C:/task", taskId: "task", expectedRevision: 3 };
    await api.taskReview.refreshSources(refresh);
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(CHANNELS.taskReview, { method: "refreshSources", input: refresh });
    const decisionHistory = { ...refresh, unitId: "unit", sourceVersionId: "version", purpose: "review", policyRevision: 0, decisionId: "decision" };
    await api.taskReview.undoDecision(decisionHistory);
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(CHANNELS.taskReview, { method: "undoDecision", input: decisionHistory });
    await api.taskReview.redoDecision(decisionHistory);
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(CHANNELS.taskReview, { method: "redoDecision", input: decisionHistory });
    const criteria = { ...refresh, content: "Only this unit", scope: { kind: "units" as const, targets: [{ unitId: "unit", sourceVersionId: "version" }] }, purpose: "review", origin: { kind: "feedback" as const, decisionId: "decision" } };
    await api.taskReviewContext.adoptCriteria(criteria);
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(CHANNELS.taskReviewContext, { method: "adoptCriteria", input: criteria });
    const exportInput = { ...refresh, exportId: "export" };
    await api.taskReviewExport.execute(exportInput);
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(CHANNELS.taskReviewExport, { method: "execute", input: exportInput });
    // Media editing forwards each method verbatim on its own channel.
    const mediaTarget = { root: "C:/task", taskId: "task", sourceVersionId: "source", unitId: "unit" };
    const mediaImport = { root: mediaTarget.root, taskId: mediaTarget.taskId, expectedRevision: 3, entryId: "entry" };
    await api.taskReviewMedia.importFile(mediaImport);
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(CHANNELS.taskReviewMedia, { method: "importFile", input: mediaImport });
    await api.taskReviewMedia.open(mediaTarget);
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(CHANNELS.taskReviewMedia, { method: "open", input: mediaTarget });
    const capture = { ...mediaTarget, expectedRevision: 3, generationId: "generation", selection: { frameIndex: 2 } };
    await api.taskReviewMedia.captureFrame(capture);
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(CHANNELS.taskReviewMedia, { method: "captureFrame", input: capture });
    const segment = { ...mediaTarget, generationId: "generation", refinementId: "refinement", prompts: { points: [{ x: 0.5, y: 0.5, foreground: true }] } };
    await api.taskReviewMedia.segment(segment);
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(CHANNELS.taskReviewMedia, { method: "segment", input: segment });
    const mediaCancel = { root: mediaTarget.root, taskId: mediaTarget.taskId, generationId: "generation" };
    await api.taskReviewMedia.cancel(mediaCancel);
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(CHANNELS.taskReviewMedia, { method: "cancel", input: mediaCancel });
    const accept = { ...mediaTarget, expectedRevision: 3, generationId: "generation", label: "Subject" };
    await api.taskReviewMedia.acceptRegion(accept);
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(CHANNELS.taskReviewMedia, { method: "acceptRegion", input: accept });
    await api.taskAgent.getModelConfig();
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(CHANNELS.taskAgent, { method: "getModelConfig" });
    const target = { root: refresh.root, taskId: refresh.taskId };
    const search = { ...target, query: "Find evidence", scope: { kind: "units" as const, targets: [{ unitId: "unit", sourceVersionId: "version" }] } };
    await api.taskAgent.search(search);
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(CHANNELS.taskAgent, { method: "search", input: search });
    await api.taskAgent.cancelSearch(target);
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(CHANNELS.taskAgent, { method: "cancelSearch", input: target });
    await api.taskAgent.continueAnalysis(target);
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(CHANNELS.taskAgent, { method: "continueAnalysis", input: target });
    const listener = vi.fn();
    const unsubscribe = api.taskAgent.onCompletion(listener);
    const call = electron.ipcRenderer.on.mock.calls.at(-1)! as unknown as [string, (event: unknown, value: TaskCompletionEvent) => void];
    const value = { taskId: "task", unitId: "unit", generationId: "generation", delta: "next", done: false };
    call[1]({}, value);
    expect(listener).toHaveBeenCalledWith(value);
    unsubscribe();
    expect(electron.ipcRenderer.removeListener).toHaveBeenLastCalledWith(CHANNELS.taskAgentCompletion, call[1]);
  });

  it("sends only the renderer error category over the crash IPC channel", () => {
    const crash = exposedApi("reelterminal").crash as {
      report(payload: { type?: string }): void;
    };

    crash.report({
      type: "react-error",
      message: "private project data",
      stack: "private stack",
      context: { path: "private" },
    } as unknown as { type?: string });

    expect(electron.ipcRenderer.send).toHaveBeenCalledWith(
      CHANNELS.crashReport,
      { type: "react-error" },
    );
  });
});
