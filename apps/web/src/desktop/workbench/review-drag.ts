import type { CollectionExportTarget } from "./useCollectionExport";
import { UUID } from "../../services/review-workspace/guards";

export const REVIEW_ITEM_DRAG = "application/x-reelterminal-review-items";
export const REVIEW_NODE_DRAG = "application/x-reelterminal-review-node";
export interface ReviewItemDrag extends CollectionExportTarget { batchId: string; itemIds: string[] }
export const isReviewDrop = (data: DataTransfer) => data.types.includes(REVIEW_ITEM_DRAG) || data.types.includes("Files");

export function readReviewItemDrag(data: DataTransfer): ReviewItemDrag {
  const value = JSON.parse(data.getData(REVIEW_ITEM_DRAG)) as ReviewItemDrag;
  if (!value || !value.target || value.target.kind !== "review" || !UUID.test(value.target.reviewWorkspaceId) ||
    !UUID.test(value.target.instanceId) || !value.target.nodeId || !UUID.test(value.target.nodeId) ||
    !Number.isInteger(value.revision) || value.revision < 0 || !UUID.test(value.batchId) ||
    !Array.isArray(value.itemIds) || !value.itemIds.length || value.itemIds.some(id => typeof id !== "string" || !UUID.test(id))) {
    throw new Error("无效的审阅拖放数据");
  }
  if (value.itemIds.length > 500) throw new Error("每次最多拖动 500 个审阅条目，请分批归类");
  return value;
}
