import type { ModelObservation, WorkbenchFeedback } from "@reelterminal/core/types/workbench";
import { workbenchFeedbackId } from "@reelterminal/core/types/workbench";
import type { ReviewContext } from "@reelterminal/core/review/types";
import { buildWorkbenchDecideAction } from "@reelterminal/core/actions/workbench-actions";
import type { Action } from "@reelterminal/core/types/actions";
import { prepareReviewBlob } from "./files";
import { reviewService, reviewError } from "./service";

export interface SaveModelObservation {
  itemId: string; itemVersion: number; resourceId: string; observationId: string;
  blob: Blob; observation: ModelObservation; text: string; rework: boolean;
}
export async function saveModelObservation(target: ReviewContext["target"], expectedNodeRevision: number, input: SaveModelObservation) {
  const requestId = crypto.randomUUID(), screenshotResourceId = crypto.randomUUID();
  const now = Date.now();
  return reviewService.commit({ target, expectedNodeRevision, requestId, actor: "human", label: "保存模型观察反馈",
    request: { ...input, blob: { size: input.blob.size, type: input.blob.type } },
    prepareResources: async () => [await prepareReviewBlob(input.blob, "model-observation.png", requestId, screenshotResourceId)],
    build: state => {
      const item = state.items.find(item => item.id === input.itemId);
      if (!item || item.version !== input.itemVersion || item.content.type !== "model3d" || item.content.resourceId !== input.resourceId) throw reviewError("CONFLICT", "模型版本已变化，请重新截图");
      const id = workbenchFeedbackId(item.id, item.version, `model-${input.observationId}`);
      const previous = state.feedback.find(feedback => feedback.id === id);
      const feedback: WorkbenchFeedback = { id, itemId: item.id, itemVersion: item.version, text: input.text,
        referencedTagIds: [], state: "confirmed", intent: input.rework ? "rework" : "note", createdAt: previous?.createdAt ?? now, updatedAt: now,
        target: { kind: "model-view", observationId: input.observationId, resourceId: input.resourceId, screenshotResourceId, observation: input.observation } };
      const actions: Action[] = [{ id: crypto.randomUUID(), type: "workbench/feedback.save", timestamp: now, params: { feedback } }];
      if (input.rework) {
        const decision = buildWorkbenchDecideAction(state, item.batchId, [{ itemId: item.id, decision: "rework" }], "human", now);
        if (!decision.ok) throw reviewError(decision.code, decision.message);
        actions.push(...decision.actions);
      }
      return actions;
    },
  });
}
