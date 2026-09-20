import { ActionExecutor } from "@reelterminal/core/actions/action-executor";
import { ActionHistory } from "@reelterminal/core/actions/action-history";
import type { Project } from "@reelterminal/core/types/project";
import { FacadeError } from "./errors";
import {
  applyClipIdOverride,
  collectEntityIds,
  diffCreatedIds,
  opToCoreActions,
} from "./ops";
import { diffProjectChanges } from "./project-changes";
import { timelineDurationSec } from "./projection";
import type {
  EditOp,
  EditValidationIssue,
  EditValidateResult,
} from "./types";

export interface ValidateEditPlanOptions {
  readonly mode: "headless" | "live";
  readonly revision: number;
  readonly expectedRevision?: number;
  readonly contextRevision?: number;
  readonly expectedContextRevision?: number;
}

function issue(error: unknown, opIndex?: number): EditValidationIssue {
  const facade = error instanceof FacadeError ? error : null;
  return {
    code: facade?.code ?? "ACTION_FAILED",
    message: error instanceof Error ? error.message : String(error),
    ...(opIndex !== undefined ? { opIndex } : {}),
    ...(facade?.details !== undefined ? { details: facade.details } : {}),
  };
}

/**
 * Execute the exact op translator and core handlers against an isolated clone.
 * The clone is discarded unconditionally: edit.validate can never mutate the
 * canonical project or history.
 */
export async function validateEditPlan(
  project: Project,
  ops: readonly EditOp[],
  options: ValidateEditPlanOptions,
): Promise<EditValidateResult> {
  const conflicts: EditValidationIssue[] = [];
  const warnings: EditValidationIssue[] = [];
  if (
    options.expectedRevision !== undefined &&
    options.expectedRevision !== options.revision
  ) {
    conflicts.push({
      code: "CONFLICT",
      message: `revision conflict: expected ${options.expectedRevision}, current is ${options.revision}`,
      details: { currentRevision: options.revision },
    });
  }
  if (options.mode === "headless" && options.expectedContextRevision !== undefined) {
    conflicts.push({
      code: "INVALID_PARAMS",
      message:
        "context revision unavailable in headless mode — expectedContextRevision requires a live editor",
    });
  }
  if (
    options.mode === "live" &&
    options.expectedContextRevision !== undefined &&
    options.expectedContextRevision !== options.contextRevision
  ) {
    conflicts.push({
      code: "CONFLICT",
      message: `editor context revision conflict: expected ${options.expectedContextRevision}, current is ${options.contextRevision}`,
      details: { currentContextRevision: options.contextRevision },
    });
  }
  for (const [opIndex, op] of ops.entries()) {
    if (options.mode === "live" && op.op === "clip.add" && op.clipId !== undefined) {
      conflicts.push({
        code: "INVALID_PARAMS",
        message:
          "clip.add with an explicit clipId is unavailable live because the canonical store mints clip ids",
        opIndex,
      });
    }
  }

  const draft = structuredClone(project);
  const executor = new ActionExecutor(new ActionHistory());
  if (conflicts.length === 0) {
    for (const [opIndex, op] of ops.entries()) {
      try {
        const beforeIds = collectEntityIds(draft);
        const replacementBefore = op.op === "media.replace"
          ? draft.timeline.tracks.flatMap((track) => track.clips.map((clip) => ({
              trackId: track.id, clipId: clip.id, mediaId: clip.mediaId,
              startTime: clip.startTime, duration: clip.duration, outPoint: clip.outPoint,
            })))
          : [];
        const actions = opToCoreActions(op, draft);
        for (const action of actions) {
          const result = await executor.execute(action, draft);
          if (!result.success) {
            throw new FacadeError(
              "ACTION_FAILED",
              result.error?.message ?? `core rejected ${op.op}`,
              { coreCode: result.error?.code },
            );
          }
        }
        const created = diffCreatedIds(beforeIds, collectEntityIds(draft));
        applyClipIdOverride(op, draft, created);
        if (op.op === "media.replace") {
          const clips = draft.timeline.tracks.flatMap((track) => track.clips);
          const impacts = replacementBefore.flatMap((before) => {
            const after = clips.find((clip) => clip.id === before.clipId);
            if (!after || before.mediaId === after.mediaId) return [];
            const shortenedBySec = Math.max(0, before.duration - after.duration);
            return [{ ...before, newMediaId: after.mediaId, newDurationSec: after.duration,
              newOutPointSec: after.outPoint, shortenedBySec,
              vacatedTimelineRange: shortenedBySec > 0
                ? { startSec: after.startTime + after.duration, endSec: before.startTime + before.duration }
                : null }];
          });
          warnings.push({ code: impacts.some((item) => item.shortenedBySec > 0)
            ? "REPLACEMENT_SHORTENS_CLIPS" : "REPLACEMENT_IMPACT",
            message: impacts.some((item) => item.shortenedBySec > 0)
              ? "Replacement shortens clips and may leave timeline gaps. Inspect per-clip vacated ranges before applying."
              : "Replacement preserves clip timing. Per-clip source changes are listed in details.",
            opIndex, details: { clips: impacts } });
        }
      } catch (error) {
        conflicts.push(issue(error, opIndex));
        break;
      }
    }
  }

  const changes = conflicts.length === 0
    ? diffProjectChanges(project, draft, options.revision + 1)
    : [];
  const affected = changes.map((change) => ({
    entityType: change.entityType,
    entityId: change.entityId,
    fields: change.fields,
  }));
  const created = changes
    .filter((change) => change.change === "added")
    .map((change) => ({ entityType: change.entityType, entityId: change.entityId }));
  const deleted = changes
    .filter((change) => change.change === "removed")
    .map((change) => ({ entityType: change.entityType, entityId: change.entityId }));

  if (ops.length > 50) {
    warnings.push({
      code: "LARGE_BATCH",
      message: "This batch is valid but contains more than 50 ops; keep recovery points around broad edits.",
    });
  }
  return {
    valid: conflicts.length === 0,
    normalizedOps: structuredClone(ops),
    conflicts,
    warnings,
    affected,
    created,
    deleted,
    estimatedDuration: conflicts.length === 0
      ? timelineDurationSec(draft)
      : timelineDurationSec(project),
    estimatedRevision: conflicts.length === 0
      ? options.revision + 1
      : options.revision,
  };
}
