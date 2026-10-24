import type { Action, WorkbenchAction } from "../types/actions";
import type { WorkbenchProjectState, WorkbenchItem } from "../types/workbench";
import { applyWorkbenchAction, invertWorkbenchAction, validateWorkbenchAction } from "../actions/workbench-actions";
import type { WorkbenchReworkClearParams } from "../actions/workbench-actions";

type ReviewWorkbenchAction = WorkbenchAction | {
  type: "workbench/rework.clear";
  params: WorkbenchReworkClearParams;
};

function affectedItemIds(action: ReviewWorkbenchAction): readonly string[] {
  switch (action.type) {
    case "workbench/ingest": return action.params.items.map(item => item.id);
    case "workbench/decide": return action.params.decisions.map(entry => entry.itemId);
    case "workbench/content.update": return [action.params.revision.itemId];
    case "workbench/annotations.set":
    case "workbench/tags.set":
    case "workbench/duplicateProposal.dismiss":
    case "workbench/rework.clear": return [action.params.itemId];
    case "workbench/revert": return action.params.itemIds;
    case "workbench/rework.ingest": return action.params.results.map(result => result.sourceItemId);
    case "workbench/restore": return [...(action.params.items ?? []).map(item => item.id), ...(action.params.removeItemIds ?? [])];
    case "workbench/feedback.save":
    case "workbench/handoff.publish":
    case "workbench/handoff.ack": return [];
  }
}

/** One domain implementation for legacy projects and independent review nodes. */
export function reduceReviewActions(state: WorkbenchProjectState, actions: readonly Action[]): {
  state: WorkbenchProjectState;
  inverse: readonly Action[];
  contentVersions: readonly WorkbenchItem[];
  changedItemIds: ReadonlySet<string>;
  contentIntegrityItemIds: ReadonlySet<string>;
} {
  const host = { workbench: structuredClone(state) };
  const inverse: Action[] = [];
  const contentVersions: WorkbenchItem[] = [];
  const itemVersions = new Map(host.workbench.items.map(item => [item.id, item.version]));
  const changedItemIds = new Set<string>();
  const contentIntegrityItemIds = new Set<string>();
  for (const action of actions) {
    if (!action.type.startsWith("workbench/")) throw new Error("Review nodes only accept workbench actions");
    const validation = validateWorkbenchAction(action, host);
    if (!validation.valid) {
      throw Object.assign(new Error(validation.errors[0].message), { code: "INVALID_PARAMS" });
    }
    const undo = invertWorkbenchAction(action, host);
    if (undo) inverse.unshift(undo);
    const workbenchAction = action as ReviewWorkbenchAction;
    const affected = affectedItemIds(workbenchAction);
    for (const id of affected) changedItemIds.add(id);
    const previousVersions = new Map(affected.map(id => [id, itemVersions.get(id)]));
    applyWorkbenchAction(action, host);

    if (workbenchAction.type === "workbench/ingest") {
      for (const item of workbenchAction.params.items) {
        if (previousVersions.get(item.id) !== item.version) contentVersions.push(structuredClone(item));
        itemVersions.set(item.id, item.version);
      }
    } else if (workbenchAction.type === "workbench/content.update") {
      const item = host.workbench.items.find(candidate => candidate.id === workbenchAction.params.revision.itemId);
      if (item) {
        if (previousVersions.get(item.id) !== item.version) contentVersions.push(structuredClone(item));
        itemVersions.set(item.id, item.version);
      }
    } else if (workbenchAction.type === "workbench/rework.ingest") {
      const ids = new Set(workbenchAction.params.results.map(result => result.sourceItemId));
      for (const item of host.workbench.items) {
        if (!ids.has(item.id)) continue;
        if (previousVersions.get(item.id) !== item.version) contentVersions.push(structuredClone(item));
        itemVersions.set(item.id, item.version);
      }
    } else if (workbenchAction.type === "workbench/restore") {
      for (const id of workbenchAction.params.removeItemIds ?? []) itemVersions.delete(id);
      for (const item of workbenchAction.params.items ?? []) {
        contentIntegrityItemIds.add(item.id);
        if (previousVersions.get(item.id) !== item.version) contentVersions.push(structuredClone(item));
        itemVersions.set(item.id, item.version);
      }
    }
  }
  return { state: host.workbench, inverse, contentVersions, changedItemIds, contentIntegrityItemIds };
}
