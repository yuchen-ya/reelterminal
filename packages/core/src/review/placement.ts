import type { Action } from "../types/actions";
import type { WorkbenchItem, WorkbenchProjectState } from "../types/workbench";

export function validWorkbenchPlacement(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const groupId = record.groupId;
  return Object.keys(record).length === 1 && (groupId === null ||
    (typeof groupId === "string" && groupId.trim().length > 0 && groupId.length <= 500 &&
      groupId !== "__ungrouped__" && !groupId.startsWith("group:")));
}

export function workbenchPlacementGroup(item: Pick<WorkbenchItem, "placement" | "lineage">): string | null {
  return item.placement ? item.placement.groupId : item.lineage?.upstreamGroupId ?? null;
}

/** Classification moves the visible placement subtree without changing its source graph. */
export function buildWorkbenchPlacementActions(state: WorkbenchProjectState, input: {
  batchId: string;
  itemIds: readonly string[];
  groupId: string | null;
  targetItemId?: string;
}, now = Date.now()): readonly Action[] {
  const fail = (message: string): never => {
    throw Object.assign(new Error(message), { code: "INVALID_PARAMS" });
  };
  if (!validWorkbenchPlacement({ groupId: input.groupId })) fail("归类目标无效");
  const batch = state.batches.find(entry => entry.id === input.batchId);
  if (!batch || !input.itemIds.length) fail("归类需要当前批次中的条目");
  const items = state.items.filter(item => item.batchId === input.batchId);
  if (input.groupId !== null && !items.some(item =>
    item.lineage?.upstreamGroupId === input.groupId || item.placement?.groupId === input.groupId)) {
    fail("归类目标必须是当前完整批次中已有的组");
  }
  const moving = new Set(input.itemIds);
  const itemById = new Map(items.map(item => [item.id, item]));
  if (input.itemIds.some(id => !items.some(item => item.id === id))) fail("不能跨任务或批次移动条目");
  for (let size = -1; size !== moving.size;) {
    size = moving.size;
    for (const item of items) {
      const parent = item.lineage?.parentNodeId ? itemById.get(item.lineage.parentNodeId) : undefined;
      if (parent && moving.has(parent.id) && workbenchPlacementGroup(item) === workbenchPlacementGroup(parent)) moving.add(item.id);
    }
  }
  if (input.targetItemId && (moving.has(input.targetItemId) || !items.some(item => item.id === input.targetItemId))) {
    fail("不能拖到自身、后代或其他批次");
  }
  const changed = items.filter(item => moving.has(item.id) && workbenchPlacementGroup(item) !== input.groupId)
    .map(item => ({ ...item, placement: { groupId: input.groupId }, updatedAt: now }));
  return changed.length
    ? [{ type: "workbench/restore", id: crypto.randomUUID(), timestamp: now, params: { items: changed } }]
    : [];
}
