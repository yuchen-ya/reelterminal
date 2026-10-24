import type { Action } from "@reelterminal/core/types/actions";
import type { WorkbenchProjectState, WorkbenchDataPatch } from "@reelterminal/core/types/workbench";
import { buildWorkbenchDataPatchActions, buildWorkbenchDecideAction, buildWorkbenchReworkIngestActions, buildWorkbenchTextRevisionActions, type WorkbenchBuilderResult } from "@reelterminal/core/actions/workbench-actions";
import { FacadeError } from "./errors";
import { workbenchBuilderError, workbenchReworkResult } from "./workbench";
import type { WorkbenchContentUpdateOp, WorkbenchDecideOp, WorkbenchFeedbackSaveOp, WorkbenchHandoffAckOp, WorkbenchReworkOp } from "./types";

export type WorkbenchAgentOp = WorkbenchContentUpdateOp | WorkbenchDecideOp | WorkbenchFeedbackSaveOp | WorkbenchHandoffAckOp | WorkbenchReworkOp;
function makeAction(type: string, params: Record<string, unknown>): Action {
  return { type, params, id: crypto.randomUUID(), timestamp: Date.now() };
}

/** Shared agent-channel planning for legacy project and independent review stores. */
export function workbenchOpActions(op: WorkbenchAgentOp, state: WorkbenchProjectState): Action[] {
  switch (op.op) {
    case "workbench.decide": {
      const wb = state;
      for (const decision of op.decisions) {
        const item = wb.items.find((candidate) => candidate.id === decision.itemId);
        if (!item) {
          throw new FacadeError(
            "NOT_FOUND",
            `workbench.decide: item "${decision.itemId}" not found`,
            { itemId: decision.itemId },
          );
        }
        if (decision.expectedItemVersion !== undefined && decision.expectedItemVersion !== item.version) {
          throw new FacadeError(
            "CONFLICT",
            `workbench.decide: item "${item.id}" is at version ${item.version}, the decision expected ${decision.expectedItemVersion} — re-read workbench.get and re-derive`,
            {
              itemId: item.id,
              currentVersion: item.version,
              expectedVersion: decision.expectedItemVersion,
            },
          );
        }
        if (decision.decision === "modified" && decision.contentRevisionId === undefined) {
          throw new FacadeError(
            "INVALID_PARAMS",
            `workbench.decide: decision "modified" for "${decision.itemId}" requires contentRevisionId (no real change, no modified status)`,
            { itemId: decision.itemId },
          );
        }
      }
      let built: WorkbenchBuilderResult;
      try {
        // Operator is pinned to the agent channel: agents can never author
        // human decisions, and no input can change that.
        built = buildWorkbenchDecideAction(wb, op.batchId, op.decisions, "agent");
      } catch (error) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `workbench.decide: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!built.ok) throw workbenchBuilderError("workbench.decide", built);
      return [...built.actions];
    }

    case "workbench.feedback.save":
      return [
        makeAction("workbench/feedback.save", {
          feedback: {
            ...op.feedback,
            referencedTagIds: [...op.feedback.referencedTagIds],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        }),
      ];

    case "workbench.handoff.ack":
      return [
        makeAction("workbench/handoff.ack", {
          handoffId: op.handoffId,
          ackedAt: Date.now(),
        }),
      ];

    case "workbench.rework": {
      const wb = state;
      const handoff = wb.handoffs.find((candidate) => candidate.handoffId === op.handoffId);
      if (!handoff) {
        throw new FacadeError(
          "NOT_FOUND",
          `workbench.rework: handoff "${op.handoffId}" not found`,
          { handoffId: op.handoffId },
        );
      }
      const results = op.results.map((result) => {
        const item = wb.items.find((candidate) => candidate.id === result.sourceItemId);
        if (!item) {
          throw new FacadeError(
            "NOT_FOUND",
            `workbench.rework: item "${result.sourceItemId}" not found`,
            { itemId: result.sourceItemId },
          );
        }
        const handoffItem = handoff.items.find(
          (candidate) => candidate.itemId === item.id,
        );
        if (!handoffItem || handoffItem.decision !== "rework") {
          throw new FacadeError(
            "CONFLICT",
            `workbench.rework: item "${item.id}" is not a rework task of ${op.handoffId}`,
            { itemId: item.id, handoffId: op.handoffId },
          );
        }
        if ((handoff.returnedItemIds ?? []).includes(item.id)) {
          throw new FacadeError(
            "CONFLICT",
            `workbench.rework: item "${item.id}" was already returned by ${op.handoffId}`,
            { itemId: item.id, handoffId: op.handoffId },
          );
        }
        if (
          item.version !== result.previousVersion ||
          handoffItem.itemVersion !== result.previousVersion
        ) {
          // A human revision wins: the stale rework fails loudly instead of
          // overwriting the human's version.
          throw new FacadeError(
            "CONFLICT",
            `workbench.rework: item "${item.id}" is at version ${item.version}, the handoff task is v${handoffItem.itemVersion}, the rework parents v${result.previousVersion} — re-read the handoff and re-derive`,
            {
              itemId: item.id,
              currentVersion: item.version,
              handoffVersion: handoffItem.itemVersion,
              previousVersion: result.previousVersion,
            },
          );
        }
        const decisionRevision = item.decisionLog.length
          ? item.decisionLog[item.decisionLog.length - 1].decisionRevision
          : 0;
        if (
          item.status !== "rework" ||
          decisionRevision !== handoffItem.decisionRevision
        ) {
          throw new FacadeError(
            "CONFLICT",
            `workbench.rework: item "${item.id}" moved to ${item.status} (decision revision ${decisionRevision}) since ${op.handoffId} was published — the task was retrieved or re-decided`,
            {
              itemId: item.id,
              status: item.status,
              decisionRevision,
              expectedDecisionRevision: handoffItem.decisionRevision,
            },
          );
        }
        return workbenchReworkResult(result, item, Date.now());
      });
      const built = buildWorkbenchReworkIngestActions(wb, op.handoffId, results);
      if (!built.ok) throw workbenchBuilderError("workbench.rework", built);
      return [...built.actions];
    }

    case "workbench.content.update": {
      const wb = state;
      const item = wb.items.find((candidate) => candidate.id === op.itemId);
      if (!item) {
        throw new FacadeError(
          "NOT_FOUND",
          `workbench.content.update: item "${op.itemId}" not found`,
          { itemId: op.itemId },
        );
      }
      if (item.version !== op.expectedItemVersion) {
        throw new FacadeError(
          "CONFLICT",
          `workbench.content.update: item "${item.id}" is at version ${item.version}, the revision was derived from v${op.expectedItemVersion} — re-read workbench.get and re-derive`,
          {
            itemId: item.id,
            currentVersion: item.version,
            expectedVersion: op.expectedItemVersion,
          },
        );
      }
      const guard = { expectedItemVersion: op.expectedItemVersion };
      const built =
        op.kind === "text"
          ? buildWorkbenchTextRevisionActions(wb, op.itemId, op.text as string, Date.now(), guard)
          : buildWorkbenchDataPatchActions(
              wb,
              op.itemId,
              op.patches as readonly WorkbenchDataPatch[],
              Date.now(),
              guard,
            );
      if (!built.ok) throw workbenchBuilderError("workbench.content.update", built);
      return [...built.actions];
    }
  }
}
