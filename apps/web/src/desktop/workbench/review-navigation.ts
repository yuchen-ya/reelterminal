import type { ReviewContext } from "@reelterminal/core/review/types";
import { reviewService } from "../../services/review-workspace/service";
import { useWorkbenchUiStore } from "../../stores/workbench-ui-store";

export async function reviewItemFromProcess(target: ReviewContext["target"], itemId: string) {
  const { item } = await reviewService.getItem(target, itemId);
  const ui = useWorkbenchUiStore.getState();
  if (ui.scopeId !== `review:${target.nodeId}`) return;
  ui.setActiveBatchId(item.batchId);
  ui.setCursor(item.batchId, item.id);
  ui.setReviewView("content");
}
