import { ipcMain } from "electron";
import { z } from "zod";
import { CHANNELS } from "../../shared/channels";
import type { TaskReviewBridge, TaskReviewContextBridge } from "../../shared/task-review-bridge";
import { taskReviewContextSchemas, taskReviewSchemas } from "../../shared/task-review-schema";
import type { TaskReviewSnapshot } from "../../shared/task-review";
import { assertEditorIpcSender } from "./index";

const envelopeSchema = z.object({
  method: z.enum(Object.keys(taskReviewSchemas) as [keyof typeof taskReviewSchemas, ...(keyof typeof taskReviewSchemas)[]]),
  input: z.unknown(),
}).strict();

const contextEnvelopeSchema = z.object({
  method: z.enum(Object.keys(taskReviewContextSchemas) as [keyof typeof taskReviewContextSchemas, ...(keyof typeof taskReviewContextSchemas)[]]),
  input: z.unknown(),
}).strict();

const activeSourceVersions = (snapshot: TaskReviewSnapshot) => snapshot.sourceFiles
  .filter(file => file.status === "available")
  .map(file => file.currentVersionId)
  .sort()
  .join();

/** Local editor transport. No live/remote Agent authority is implied by registration. */
export function registerTaskReviewIpc(
  store: TaskReviewBridge & TaskReviewContextBridge,
  onTaskChanged: (target: { root: string; taskId: string }) => Promise<void>,
): void {
  ipcMain.handle(CHANNELS.taskReview, async (event, raw) => {
    assertEditorIpcSender(event);
    const request = envelopeSchema.parse(raw);
    let snapshot: TaskReviewSnapshot;
    let refreshedInputsChanged = false;
    switch (request.method) {
      case "open": snapshot = await store.open(taskReviewSchemas.open.parse(request.input).root); break;
      case "refreshSources": {
        const input = taskReviewSchemas.refreshSources.parse(request.input);
        const previous = await store.open(input.root);
        snapshot = await store.refreshSources(input);
        refreshedInputsChanged = previous.policyRevision !== snapshot.policyRevision ||
          activeSourceVersions(previous) !== activeSourceVersions(snapshot);
        break;
      }
      case "setGoal": snapshot = await store.setGoal(taskReviewSchemas.setGoal.parse(request.input)); break;
      case "importText": snapshot = await store.importText(taskReviewSchemas.importText.parse(request.input)); break;
      case "importFile": snapshot = await store.importFile(taskReviewSchemas.importFile.parse(request.input)); break;
      case "decide": snapshot = await store.decide(taskReviewSchemas.decide.parse(request.input)); break;
      case "undoDecision": snapshot = await store.undoDecision(taskReviewSchemas.undoDecision.parse(request.input)); break;
      case "redoDecision": snapshot = await store.redoDecision(taskReviewSchemas.redoDecision.parse(request.input)); break;
      case "saveDraft": snapshot = await store.saveDraft(taskReviewSchemas.saveDraft.parse(request.input)); break;
      case "visit": snapshot = await store.visit(taskReviewSchemas.visit.parse(request.input)); break;
      case "publishAnalysis": snapshot = await store.publishAnalysis(taskReviewSchemas.publishAnalysis.parse(request.input)); break;
      case "exportSource": snapshot = await store.exportSource(taskReviewSchemas.exportSource.parse(request.input)); break;
    }
    if (refreshedInputsChanged || ["setGoal", "importText", "importFile", "decide", "undoDecision", "redoDecision"].includes(request.method)) {
      await onTaskChanged({ root: snapshot.root, taskId: snapshot.taskId });
    }
    return snapshot;
  });
  ipcMain.handle(CHANNELS.taskReviewContext, async (event, raw) => {
    assertEditorIpcSender(event);
    const request = contextEnvelopeSchema.parse(raw);
    let snapshot: TaskReviewSnapshot;
    switch (request.method) {
      case "proposeContext": snapshot = await store.proposeContext(taskReviewContextSchemas.proposeContext.parse(request.input)); break;
      case "adoptContext": snapshot = await store.adoptContext(taskReviewContextSchemas.adoptContext.parse(request.input)); break;
      case "adoptCriteria": snapshot = await store.adoptCriteria(taskReviewContextSchemas.adoptCriteria.parse(request.input)); break;
      case "setCriterionActive": snapshot = await store.setCriterionActive(taskReviewContextSchemas.setCriterionActive.parse(request.input)); break;
    }
    await onTaskChanged({ root: snapshot.root, taskId: snapshot.taskId });
    return snapshot;
  });
}
