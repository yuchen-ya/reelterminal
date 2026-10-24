import { v4 as uuidv4 } from "uuid";
import type { StoreApi } from "zustand";
import type {
  Action,
  ActionResult,
  WorkbenchContentRevision,
  WorkbenchDataPatch,
  WorkbenchDecision,
  WorkbenchFeedback,
  WorkbenchPixelStroke,
  WorkbenchProjectState,
  WorkbenchSpatialAnnotation,
  WorkbenchVideoMarker,
} from "@reelterminal/core";
import {
  buildWorkbenchDataPatchActions,
  buildWorkbenchDecideAction,
  buildWorkbenchHandoffPublishAction,
  buildWorkbenchImageRepairAction,
  buildWorkbenchIngestActions,
  buildWorkbenchMarkDataReworkActions,
  buildWorkbenchReworkIngestActions,
  buildWorkbenchTextRevisionActions,
  emptyWorkbenchState,
  isActiveReworkFeedback,
  type WorkbenchBuilderResult,
  type WorkbenchIngestInput,
  type WorkbenchMarkDataReworkInput,
  type WorkbenchReworkResult,
} from "@reelterminal/core";
import { nextWorkbenchContentVersion } from "@reelterminal/core/actions/workbench-actions";
import { recoverReviewMigration } from "../../services/review-workspace/migration-records";
import type { ProjectState } from "../project-store";

type Get = StoreApi<ProjectState>["getState"];
type Set = StoreApi<ProjectState>["setState"];

export type WorkbenchMutationOutcome =
  | {
      readonly ok: true;
      /** Publish identity (replayed or newly created). */
      readonly handoffId?: string;
      readonly replayed?: boolean;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

export type WorkbenchSlice = Pick<
  ProjectState,
  | "ingestWorkbenchBatch"
  | "decideWorkbenchItems"
  | "saveWorkbenchTextRevision"
  | "saveWorkbenchDataPatches"
  | "commitWorkbenchImageRepair"
  | "setWorkbenchAnnotations"
  | "saveWorkbenchFeedback"
  | "saveWorkbenchIssueFeedback"
  | "markWorkbenchDataRework"
  | "clearWorkbenchDataRework"
  | "revertWorkbenchItems"
  | "setWorkbenchUserTags"
  | "dismissWorkbenchDuplicate"
  | "publishWorkbenchHandoff"
  | "ackWorkbenchHandoff"
  | "ingestWorkbenchRework"
>;

export function currentWorkbenchState(project: {
  workbench?: WorkbenchProjectState;
}): WorkbenchProjectState {
  return project.workbench ?? emptyWorkbenchState();
}

function resultToOutcome(
  result: ActionResult,
  fallbackLabel: string,
): WorkbenchMutationOutcome {
  if (result.success) return { ok: true };
  return {
    ok: false,
    code: result.error?.code ?? "INVALID_PARAMS",
    message: result.error?.message ?? `${fallbackLabel} failed`,
  };
}

function builderFailure(failure: Extract<WorkbenchBuilderResult, { ok: false }>): WorkbenchMutationOutcome {
  return { ok: false, code: failure.code, message: failure.message };
}

const isBuilderFailure = (
  result: WorkbenchBuilderResult,
): result is Extract<WorkbenchBuilderResult, { ok: false }> => !result.ok;

function revisionIdOf(actions: readonly Action[]): string | undefined {
  const update = actions.find((action) => action.type === "workbench/content.update");
  const revision = (update?.params as { revision?: WorkbenchContentRevision } | undefined)?.revision;
  return revision?.id;
}

/**
 * Decide action to run in the SAME batch after a content.update: the item
 * version inside the batch is parentVersion + 1 (the produced version), and
 * the decision revision is one past the item's current last entry.
 */
function buildDecideAfterRevision(
  state: WorkbenchProjectState,
  itemId: string,
  decision: WorkbenchDecision,
  contentRevisionId: string | undefined,
  operator: "human" | "agent",
): Action | null {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) return null;
  const lastRevision = item.decisionLog[item.decisionLog.length - 1];
  return {
    type: "workbench/decide",
    id: uuidv4(),
    timestamp: Date.now(),
    params: {
      batchId: item.batchId,
      decisions: [
        {
          itemId,
          baseVersion: nextWorkbenchContentVersion(item),
          decision,
          decisionRevision: (lastRevision?.decisionRevision ?? 0) + 1,
          decidedAt: Date.now(),
          operator,
          ...(contentRevisionId ? { contentRevisionId } : {}),
        },
      ],
    },
  };
}

/**
 * Project-scoped workbench state (`project.workbench`). Every method commits
 * through submitActionBatch so GUI and CLI share the same history, revision
 * guards and persistence path; content+decision pairs commit as ONE undoable
 * group. Derived repair media flows through the normal media import (its own
 * history group) before the repair revision references it.
 */
export function createWorkbenchSlice(_set: Set, get: Get): WorkbenchSlice {
  return createWorkbenchCommands(() => currentWorkbenchState(get().project), async (actions, groupLabel, actor) => {
    await recoverReviewMigration({ getState: get, setState: _set });
    if (get().project.reviewMigration) return { ok: false, code: "CONFLICT", message: "MIGRATED: 此项目工作台已迁移，请使用独立审阅节点；旧数据为只读备份。" };
    if (!actions.length) return { ok: true };
    const batch = await get().submitActionBatch([...actions], { groupLabel, historyOwner: actor });
    return resultToOutcome(batch.result, groupLabel);
  });
}

/** Reuse the same human review operations with either persistence host. */
export function createWorkbenchCommands(
  getWorkbench: () => WorkbenchProjectState,
  submit: (actions: readonly Action[], label: string, actor: "human" | "agent") => Promise<WorkbenchMutationOutcome>,
): WorkbenchSlice {
  const commit = (actions: readonly Action[], label: string) => submit(actions, label, "human");
  const commitAsAgent = (actions: readonly Action[], label: string) => submit(actions, label, "agent");
  return {
    ingestWorkbenchBatch: async (input: WorkbenchIngestInput) => {
      const built = buildWorkbenchIngestActions(
        getWorkbench(),
        input,
      );
      if (isBuilderFailure(built)) return builderFailure(built);
      return commit(built.actions, `Ingest workbench batch "${input.name}"`);
    },

    decideWorkbenchItems: async (
      batchId: string,
      targets: ReadonlyArray<{ itemId: string; decision: WorkbenchDecision; contentRevisionId?: string }>,
      operator: "human" | "agent" = "human",
    ) => {
      let built: WorkbenchBuilderResult;
      try {
        built = buildWorkbenchDecideAction(
          getWorkbench(),
          batchId,
          targets,
          operator,
        );
      } catch (error) {
        return {
          ok: false,
          code: "NOT_FOUND",
          message: error instanceof Error ? error.message : "workbench decide failed",
        };
      }
      if (isBuilderFailure(built)) return builderFailure(built);
      const label =
        targets.length === 1
          ? `Workbench decision: ${targets[0].decision}`
          : `Workbench decision (${targets.length} items)`;
      return operator === "agent"
        ? commitAsAgent(built.actions, label)
        : commit(built.actions, label);
    },

    saveWorkbenchTextRevision: async (itemId: string, newText: string) => {
      const built = buildWorkbenchTextRevisionActions(
        getWorkbench(),
        itemId,
        newText,
      );
      if (isBuilderFailure(built)) return builderFailure(built);
      const decide = buildDecideAfterRevision(
        getWorkbench(),
        itemId,
        "modified",
        revisionIdOf(built.actions),
        "human",
      );
      return commit(
        decide ? [...built.actions, decide] : built.actions,
        "Workbench text revision",
      );
    },

    saveWorkbenchDataPatches: async (
      itemId: string,
      patches: readonly WorkbenchDataPatch[],
      expectedVersion?: number,
      markModified: boolean = true,
    ) => {
      const state = getWorkbench();
      const built = buildWorkbenchDataPatchActions(
        state,
        itemId,
        patches,
        Date.now(),
        expectedVersion !== undefined ? { expectedItemVersion: expectedVersion } : undefined,
      );
      if (isBuilderFailure(built)) return builderFailure(built);
      const item = state.items.find((candidate) => candidate.id === itemId)!;
      // Accepting one cell is not a final decision on the remaining tasks.
      // Match the cells cleared by the content action; other active markers
      // migrate to the new version and must remain executable as rework.
      const hasRemainingRework = state.feedback.some((record) => {
        const target = record.target;
        return record.itemId === itemId &&
          isActiveReworkFeedback(record, item.version) &&
          target?.kind === "data-cell" &&
          !patches.some((patch) =>
            patch.rowId === target.rowId &&
            patch.columnId === target.columnId &&
            (patch.proposalOutcome === "accepted" || patch.proposalOutcome === "modified"),
          );
      });
      const decide = markModified
        ? buildDecideAfterRevision(
            getWorkbench(),
            itemId,
            hasRemainingRework ? "rework" : "modified",
            revisionIdOf(built.actions),
            "human",
          )
        : null;
      return commit(
        decide ? [...built.actions, decide] : built.actions,
        markModified ? "Workbench data update" : "Workbench proposal decision",
      );
    },

    markWorkbenchDataRework: async (input: WorkbenchMarkDataReworkInput) => {
      const built = buildWorkbenchMarkDataReworkActions(
        getWorkbench(),
        input,
      );
      if (isBuilderFailure(built)) return builderFailure(built);
      return commit(built.actions, `Mark data rework (${input.cells.length} cells)`);
    },

    clearWorkbenchDataRework: async (
      itemId: string,
      itemVersion: number,
      cells: readonly { rowId: string; columnId: string }[],
    ) => {
      if (!cells.length) return { ok: false, code: "INVALID_PARAMS", message: "没有要取消的返工标记" };
      return commit(
        [
          {
            type: "workbench/rework.clear",
            id: uuidv4(),
            timestamp: Date.now(),
            params: {
              itemId,
              itemVersion,
              cells: [...cells],
              clearedBy: "cancelled",
              clearedAt: Date.now(),
            } as Record<string, unknown>,
          },
        ],
        `Cancel data rework (${cells.length} cells)`,
      );
    },

    commitWorkbenchImageRepair: async (
      itemId: string,
      derivedMediaId: string,
      strokes: readonly WorkbenchPixelStroke[],
      base?: import("@reelterminal/core").WorkbenchRepairBase,
    ) => {
      const built = buildWorkbenchImageRepairAction(
        getWorkbench(),
        itemId,
        derivedMediaId,
        strokes,
        base,
      );
      if (isBuilderFailure(built)) return builderFailure(built);
      const decide = buildDecideAfterRevision(
        getWorkbench(),
        itemId,
        "modified",
        revisionIdOf(built.actions),
        "human",
      );
      return commit(
        decide ? [...built.actions, decide] : built.actions,
        "Workbench image repair",
      );
    },

    setWorkbenchAnnotations: async (
      itemId: string,
      itemVersion: number,
      update: {
        annotations?: readonly WorkbenchSpatialAnnotation[];
        strokes?: readonly WorkbenchPixelStroke[];
        markers?: readonly WorkbenchVideoMarker[];
      },
    ) => {
      return commit(
        [
          {
            type: "workbench/annotations.set",
            id: uuidv4(),
            timestamp: Date.now(),
            params: { itemId, itemVersion, ...update } as Record<string, unknown>,
          },
        ],
        "Workbench annotations",
      );
    },

    saveWorkbenchFeedback: async (feedback: WorkbenchFeedback) => {
      return commit(
        [
          {
            type: "workbench/feedback.save",
            id: uuidv4(),
            timestamp: Date.now(),
            params: { feedback } as Record<string, unknown>,
          },
        ],
        feedback.state === "confirmed" ? "Confirm workbench feedback" : "Save workbench feedback draft",
      );
    },

    /**
     * Explicit issue-feedback save: content update, feedback record and the
     * optional rework decision are committed as ONE history group. The
     * batch executor works on an isolated draft and publishes only after every
     * action validates, so a rejected feedback record cannot leave the
     * annotation edit or the decision behind.
     */
    saveWorkbenchIssueFeedback: async (
      itemId: string,
      itemVersion: number,
      update: {
        annotations?: readonly WorkbenchSpatialAnnotation[];
        markers?: readonly WorkbenchVideoMarker[];
        feedback: WorkbenchFeedback;
        decision?: "rework";
      },
    ) => {
      const state = getWorkbench();
      const item = state.items.find((candidate) => candidate.id === itemId);
      if (!item) {
        return { ok: false, code: "NOT_FOUND", message: "workbench item not found" };
      }
      // Identity preflight: the composed batch must never target a different
      // item/version or carry an invalid feedback id.
      if (update.feedback.itemId !== itemId) {
        return { ok: false, code: "INVALID_PARAMS", message: "feedback itemId does not match" };
      }
      if (update.feedback.itemVersion !== itemVersion) {
        return { ok: false, code: "INVALID_PARAMS", message: "feedback version does not match" };
      }
      if (itemVersion !== item.version) {
        return {
          ok: false,
          code: "CONFLICT",
          message: `workbench item is at v${item.version}, feedback targets v${itemVersion}`,
        };
      }
      if (
        typeof update.feedback.id !== "string" ||
        update.feedback.id.length === 0 ||
        update.feedback.id.length > 200
      ) {
        return { ok: false, code: "INVALID_PARAMS", message: "feedback id is invalid" };
      }
      if (update.decision !== undefined && update.decision !== "rework") {
        return { ok: false, code: "INVALID_PARAMS", message: "only rework is allowed here" };
      }
      const actions: Action[] = [];
      if (update.annotations !== undefined || update.markers !== undefined) {
        actions.push({
          type: "workbench/annotations.set",
          id: uuidv4(),
          timestamp: Date.now(),
          params: {
            itemId,
            itemVersion,
            ...(update.annotations !== undefined ? { annotations: update.annotations } : {}),
            ...(update.markers !== undefined ? { markers: update.markers } : {}),
          } as Record<string, unknown>,
        });
      }
      actions.push({
        type: "workbench/feedback.save",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { feedback: update.feedback } as Record<string, unknown>,
      });
      if (update.decision) {
        let built: WorkbenchBuilderResult;
        try {
          built = buildWorkbenchDecideAction(
            state,
            item.batchId,
            [{ itemId, decision: update.decision }],
            "human",
          );
        } catch (error) {
          return {
            ok: false,
            code: "NOT_FOUND",
            message: error instanceof Error ? error.message : "workbench decide failed",
          };
        }
        if (isBuilderFailure(built)) return builderFailure(built);
        actions.push(...built.actions);
      }
      return commit(actions, "Save workbench issue feedback");
    },

    revertWorkbenchItems: async (itemIds: readonly string[]) => {
      return commit(
        [
          {
            type: "workbench/revert",
            id: uuidv4(),
            timestamp: Date.now(),
            params: { itemIds: [...itemIds] } as Record<string, unknown>,
          },
        ],
        `Retrieve workbench items (${itemIds.length})`,
      );
    },

    setWorkbenchUserTags: async (itemId: string, tags: readonly string[]) => {
      return commit(
        [
          {
            type: "workbench/tags.set",
            id: uuidv4(),
            timestamp: Date.now(),
            params: { itemId, tags: [...tags] } as Record<string, unknown>,
          },
        ],
        "Workbench tags",
      );
    },

    dismissWorkbenchDuplicate: async (itemId: string) => {
      return commit(
        [
          {
            type: "workbench/duplicateProposal.dismiss",
            id: uuidv4(),
            timestamp: Date.now(),
            params: { itemId } as Record<string, unknown>,
          },
        ],
        "Dismiss duplicate proposal",
      );
    },

    publishWorkbenchHandoff: async (
      batchId: string,
      itemIds?: readonly string[],
      idempotencyKey?: string,
    ) => {
      const built = buildWorkbenchHandoffPublishAction(
        getWorkbench(),
        batchId,
        { ...(itemIds ? { itemIds } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) },
      );
      if (isBuilderFailure(built)) return builderFailure(built);
      if (built.actions.length === 0) {
        // Identical publication retry: reuse the existing snapshot identity.
        return { ok: true, handoffId: built.handoffId, replayed: true };
      }
      const outcome = await commit(built.actions, "Publish workbench handoff");
      return outcome.ok
        ? { ok: true, handoffId: built.handoffId, replayed: false }
        : outcome;
    },

    ackWorkbenchHandoff: async (handoffId: string) => {
      return commitAsAgent(
        [
          {
            type: "workbench/handoff.ack",
            id: uuidv4(),
            timestamp: Date.now(),
            params: { handoffId, ackedAt: Date.now() } as Record<string, unknown>,
          },
        ],
        "Acknowledge workbench handoff",
      );
    },

    ingestWorkbenchRework: async (
      handoffId: string,
      results: readonly WorkbenchReworkResult[],
    ) => {
      const built = buildWorkbenchReworkIngestActions(
        getWorkbench(),
        handoffId,
        results,
      );
      if (isBuilderFailure(built)) return builderFailure(built);
      return commitAsAgent(built.actions, "Workbench rework return");
    },
  };
}
