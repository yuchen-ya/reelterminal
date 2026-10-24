/**
 * Stable identity and latest-selection helpers for workbench feedback.
 *
 * Feedback identity is (itemId, itemVersion, targetKey), never just an
 * annotation/marker id: a new content revision may reuse an issue id and must
 * not overwrite the previous version's opinion. Composite ids are length
 * guarded because the core validator caps ids at 200 characters.
 */
import type { WorkbenchFeedback, WorkbenchFeedbackTarget } from "@reelterminal/core";
import {
  workbenchFeedbackId,
  workbenchFeedbackTargetKey,
} from "@reelterminal/core";

export interface FeedbackIssueLike {
  readonly id: string;
  readonly kind: "annotation" | "marker";
}

/** Stable identity key for a feedback target (no display strings). */
export function feedbackTargetKey(
  target: WorkbenchFeedbackTarget | undefined,
): string | null {
  return workbenchFeedbackTargetKey(target);
}

/**
 * Deterministic id for one issue feedback record. The core helper is shared
 * with handoff snapshots so a saved record and its published issue id can
 * never drift.
 */
export function feedbackIdFor(
  itemId: string,
  itemVersion: number,
  targetKey: string,
): string {
  return workbenchFeedbackId(itemId, itemVersion, targetKey);
}

/** Latest record by updatedAt (createdAt/id are deterministic tie-breakers). */
export function pickLatestFeedback<T extends Pick<WorkbenchFeedback, "updatedAt" | "createdAt" | "id">>(
  records: readonly T[],
): T | undefined {
  let latest: T | undefined;
  for (const record of records) {
    if (!latest) {
      latest = record;
      continue;
    }
    if (
      record.updatedAt > latest.updatedAt ||
      (record.updatedAt === latest.updatedAt && record.createdAt > latest.createdAt) ||
      (record.updatedAt === latest.updatedAt &&
        record.createdAt === latest.createdAt &&
        record.id > latest.id)
    ) {
      latest = record;
    }
  }
  return latest;
}

/**
 * Existing record for the same item + version + target. The latest record is
 * reused (including a legacy random id) so a save upgrades it in place.
 * Records without a target are never merged with targeted records.
 */
export function findExistingIssueFeedback(
  feedback: readonly WorkbenchFeedback[],
  itemId: string,
  itemVersion: number,
  target: WorkbenchFeedbackTarget | undefined,
): WorkbenchFeedback | undefined {
  const key = feedbackTargetKey(target);
  const matches = feedback.filter(
    (record) =>
      record.itemId === itemId &&
      record.itemVersion === itemVersion &&
      feedbackTargetKey(record.target) === key,
  );
  return pickLatestFeedback(matches);
}

/** Whether a feedback record targets the given issue (annotation or marker). */
export function feedbackMatchesIssue(
  feedback: Pick<WorkbenchFeedback, "target">,
  issue: FeedbackIssueLike,
): boolean {
  const target = feedback.target;
  if (!target) return false;
  if (issue.kind === "marker") {
    return target.kind === "video-marker" && target.markerId === issue.id;
  }
  return target.kind === "pixel-region" && target.annotationId === issue.id;
}
