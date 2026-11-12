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
    if (request.method === 'getDecisionOutcome') {
      if (!store.getDecisionOutcome) throw new Error('Decision outcome query unavailable');
      return store.getDecisionOutcome(taskReviewSchemas.getDecisionOutcome.parse(request.input));
    }
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
      case "decide":
      case "decideBatch": {
        const parsed = request.method === 'decideBatch' ? taskReviewSchemas.decideBatch.safeParse(request.input) : taskReviewSchemas.decide.safeParse(request.input);
        if (!parsed.success) {
          const rawInput = request.input as Record<string, unknown>;
          const identity = taskReviewSchemas.getDecisionOutcome.parse({ root: rawInput?.root, taskId: rawInput?.taskId, decisionId: request.method === 'decideBatch' ? rawInput?.batchId : rawInput?.decisionId });
          const current = await store.open(identity.root);
          if (current.taskId !== identity.taskId || current.decisions.some(item => item.id === identity.decisionId) || current.decisionBatches?.some(item => item.id === identity.decisionId)) throw new Error('Decision identity requires verification');
          return { ...current, decisionReceipt: { decisionId: identity.decisionId, outcome: 'not-committed', rejection: 'validation' } };
        }
        const input = parsed.data;
        const decisionId = 'batchId' in input ? input.batchId : input.decisionId;
        try {
          if ('batchId' in input) {
            if (!store.decideBatch) throw new Error('Batch decisions are unavailable');
            snapshot = await store.decideBatch(input);
          } else snapshot = await store.decide(input);
        }
        catch (problem) {
          if (!decisionId || !store.getDecisionOutcome) throw problem;
          const checked = await store.getDecisionOutcome({ root: input.root, taskId: input.taskId, decisionId });
          if (checked.outcome === 'unknown') throw new Error('Decision result requires verification');
          return { ...checked.snapshot, decisionReceipt: { decisionId, outcome: checked.outcome } };
        }
        let notificationFailed = false, refreshFailed = false;
        try { await onTaskChanged({ root: snapshot.root, taskId: snapshot.taskId }); }
        catch { notificationFailed = true; }
        let latest = snapshot;
        try { latest = await store.open(snapshot.root); }
        catch { refreshFailed = true; }
        if (latest.root !== snapshot.root || latest.taskId !== snapshot.taskId) throw new Error('Review target changed after decision commit');
        return decisionId || notificationFailed || refreshFailed ? { ...latest, decisionReceipt: {
          decisionId: decisionId ?? snapshot.decisions.at(-1)!.id, outcome: 'committed',
          ...(notificationFailed ? { notificationFailed: true } : {}), ...(refreshFailed ? { refreshFailed: true } : {}),
        } } : latest;
      }
      case "undoDecisionBatch": {
        if (!store.undoDecisionBatch) throw new Error('Batch undo is unavailable');
        snapshot = await store.undoDecisionBatch(taskReviewSchemas.undoDecisionBatch.parse(request.input)); break;
      }
      case "redoDecisionBatch": {
        if (!store.redoDecisionBatch) throw new Error('Batch redo is unavailable');
        snapshot = await store.redoDecisionBatch(taskReviewSchemas.redoDecisionBatch.parse(request.input)); break;
      }
      case "undoDecision": snapshot = await store.undoDecision(taskReviewSchemas.undoDecision.parse(request.input)); break;
      case "redoDecision": snapshot = await store.redoDecision(taskReviewSchemas.redoDecision.parse(request.input)); break;
      case "saveDraft": snapshot = await store.saveDraft(taskReviewSchemas.saveDraft.parse(request.input)); break;
      case "visit": snapshot = await store.visit(taskReviewSchemas.visit.parse(request.input)); break;
      case "publishAnalysis": snapshot = await store.publishAnalysis(taskReviewSchemas.publishAnalysis.parse(request.input)); break;
      case "exportSource": snapshot = await store.exportSource(taskReviewSchemas.exportSource.parse(request.input)); break;
    }
    if (refreshedInputsChanged || ["setGoal", "importText", "importFile", "undoDecisionBatch", "redoDecisionBatch", "undoDecision", "redoDecision"].includes(request.method)) {
      await onTaskChanged({ root: snapshot.root, taskId: snapshot.taskId });
      // Local planning can publish another revision during notification. Return
      // that authoritative state so the next human action does not start stale.
      const latest = await store.open(snapshot.root);
      if (latest.root !== snapshot.root || latest.taskId !== snapshot.taskId) throw new Error('Review target changed after task notification');
      return latest;
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
