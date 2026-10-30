import type { ReviewContext } from "@reelterminal/core/review/types";
import { buildWorkbenchPlacementActions } from "@reelterminal/core/review/placement";
import { reviewError } from "./guards";
import { reviewService } from "./service";

export async function moveReviewItems(target: ReviewContext["target"], expectedNodeRevision: number,
  input: Parameters<typeof buildWorkbenchPlacementActions>[1]) {
  const snapshot = await reviewService.getNode(target);
  if (snapshot.node.revision !== expectedNodeRevision) throw reviewError("CONFLICT", "审阅任务已更新，请刷新后重新拖放");
  if (!buildWorkbenchPlacementActions(snapshot.state, input).length) return false;
  await reviewService.commit({ target, expectedNodeRevision, requestId: crypto.randomUUID(), actor: "human", label: "归类审阅条目", request: input,
    build: state => buildWorkbenchPlacementActions(state, input) });
  return true;
}
