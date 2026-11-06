import { randomUUID } from "node:crypto";
import { ipcMain, type WebContents } from "electron";
import { z } from "zod";
import { CHANNELS } from "../../shared/channels";
import { taskAgentSchemas } from "../../shared/task-review-runtime-types";
import type { TaskCompletionEvent } from "../../shared/task-review-runtime-types";
import type { TaskReviewRuntime } from "../task-review-runtime";
import { assertEditorIpcSender } from "./index";

const envelopeSchema = z.object({
  method: z.enum(Object.keys(taskAgentSchemas) as [keyof typeof taskAgentSchemas, ...(keyof typeof taskAgentSchemas)[]]),
  input: z.unknown().optional(),
}).strict();

type CompletionOwner = {
  contents: WebContents;
  taskId: string;
  unitId: string;
  generationId: string;
};

/** Owner-scoped transport; renderer generation IDs never become runtime identities. */
export function registerTaskAgentIpc(runtime: TaskReviewRuntime): () => void {
  const owners = new Map<string, CompletionOwner>();
  const attached = new WeakSet<WebContents>();
  const cancel = (runtimeGenerationId: string, owner: CompletionOwner) => {
    owners.delete(runtimeGenerationId);
    return runtime.cancelCompletion({ taskId: owner.taskId, generationId: runtimeGenerationId });
  };
  const cancelContents = (contents: WebContents) => {
    for (const [generationId, owner] of owners) {
      if (owner.contents === contents) void cancel(generationId, owner);
    }
  };
  const receive = (event: TaskCompletionEvent) => {
    const owner = owners.get(event.generationId);
    if (!owner || owner.taskId !== event.taskId || owner.unitId !== event.unitId) return;
    if (owner.contents.isDestroyed()) { void cancel(event.generationId, owner); return; }
    owner.contents.send(CHANNELS.taskAgentCompletion, { ...event, generationId: owner.generationId });
    if (event.done) owners.delete(event.generationId);
  };
  const unsubscribe = runtime.onCompletion(receive);

  ipcMain.handle(CHANNELS.taskAgent, async (event, raw) => {
    assertEditorIpcSender(event);
    const request = envelopeSchema.parse(raw);
    switch (request.method) {
      case "getModelConfig":
        taskAgentSchemas.getModelConfig.parse(request.input);
        return runtime.models.get();
      case "configureModel": return runtime.models.save(taskAgentSchemas.configureModel.parse(request.input));
      case "authorize": return runtime.authorize(taskAgentSchemas.authorize.parse(request.input));
      case "revoke": return runtime.revoke(taskAgentSchemas.revoke.parse(request.input));
      case "getState": return runtime.getState(taskAgentSchemas.getState.parse(request.input));
      case "startPreflight": return runtime.startPreflight(taskAgentSchemas.startPreflight.parse(request.input));
      case "continueAnalysis": return runtime.continueAnalysis(taskAgentSchemas.continueAnalysis.parse(request.input));
      case "cancelJob": return runtime.cancelJob(taskAgentSchemas.cancelJob.parse(request.input));
      case "retryJob": return runtime.retryJob(taskAgentSchemas.retryJob.parse(request.input));
      case "search": return runtime.search(taskAgentSchemas.search.parse(request.input));
      case "cancelSearch": return runtime.cancelSearch(taskAgentSchemas.cancelSearch.parse(request.input));
      case "cancelCompletion": {
        const input = taskAgentSchemas.cancelCompletion.parse(request.input);
        for (const [generationId, owner] of owners) {
          if (owner.contents === event.sender && owner.taskId === input.taskId && owner.generationId === input.generationId) {
            await cancel(generationId, owner);
          }
        }
        return;
      }
      case "complete": {
        const input = taskAgentSchemas.complete.parse(request.input);
        const contents = event.sender;
        if (!attached.has(contents)) {
          attached.add(contents);
          contents.once("destroyed", () => cancelContents(contents));
          contents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
            if (isMainFrame && !isInPlace) cancelContents(contents);
          });
        }
        for (const [generationId, owner] of owners) {
          if (owner.contents === contents && owner.taskId === input.taskId) await cancel(generationId, owner);
        }
        const generationId = randomUUID();
        owners.set(generationId, { contents, taskId: input.taskId, unitId: input.unitId, generationId: input.generationId });
        try { await runtime.complete({ ...input, generationId }); }
        finally { owners.delete(generationId); }
        return;
      }
    }
  });

  return () => {
    unsubscribe();
    for (const [generationId, owner] of owners) void cancel(generationId, owner);
    ipcMain.removeHandler(CHANNELS.taskAgent);
  };
}
