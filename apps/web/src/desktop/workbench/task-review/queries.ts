import { t } from "../../../i18n";
import type {
  TaskDecisionStatus,
  TaskReviewSnapshot,
  TaskSourceVersion,
  TaskVisit,
  TaskSceneSuggestion,
} from "../../../../../desktop/src/shared/task-review";
import { isCurrentTaskUnit } from "../../../../../desktop/src/shared/task-review";
import type {
  TaskContextHistory,
  TaskCriteriaScope,
  TaskCriteriaVersion,
} from "../../../../../desktop/src/shared/task-review-context";
import {
  selectAdoptedTaskContext,
  selectTaskContextForPlanning,
} from "../../../../../desktop/src/shared/task-review-context";
import {
  selectTaskDecision,
  selectTaskDecisionHistory,
  isTaskIssueCurrent,
  isTaskPlanStepCurrent,
  isTaskSceneCurrent,
} from "../../../../../desktop/src/shared/task-review-selectors";

/**
 * The built-in agent and the reviewer share the canonical review purpose.
 * Decisions, plan steps and exports must all quote the same purpose for the
 * "same task, source version and purpose" deduplication to hold.
 */
export const REVIEW_PURPOSE = "review";

export interface UnitStats {
  total: number;
  decided: number;
  kept: number;
  rework: number;
  discarded: number;
  pending: number;
}

export interface UnitDecisionState {
  /** null means the unit awaits review (possibly again, after undo/recheck). */
  status: TaskDecisionStatus | null;
  /** Prior decisions exist but none apply under the current policy/source. */
  needsRecheck: boolean;
  canUndo: boolean;
  canRedo: boolean;
  replacementText?: string;
  /** Applied decision identity + note, for the explicit criteria-adoption entry. */
  decisionId?: string;
  note?: string;
}

export function findUnit(
  snapshot: TaskReviewSnapshot,
  unitId: string | undefined,
) {
  return snapshot.units.find((unit) => unit.id === unitId) ?? null;
}

/**
 * Current source versions only: the latest version of an entry whose file is
 * still `available` and whose `currentVersionId` matches it. Superseded,
 * missing and invalid versions remain history — they never re-enter current
 * progress, the skim path or the export list.
 */
export function currentSources(snapshot: TaskReviewSnapshot): TaskSourceVersion[] {
  const latest = new Map<string, TaskSourceVersion>();
  for (const source of snapshot.sources) latest.set(source.entryId, source);
  const current: TaskSourceVersion[] = [];
  for (const source of latest.values()) {
    const file = snapshot.sourceFiles.find(
      (item) => item.entryId === source.entryId,
    );
    if (file?.status === "available" && file.currentVersionId === source.id)
      current.push(source);
  }
  return current;
}

export function currentSourceIds(snapshot: TaskReviewSnapshot): Set<string> {
  return new Set(currentSources(snapshot).map((source) => source.id));
}

/**
 * Decision state through the shared selector: the applied decision stack
 * after undo/redo actions, filtered by the current policy and an available
 * source. Navigation and drafts never participate.
 */
export function unitDecisionState(
  snapshot: TaskReviewSnapshot,
  unitId: string,
  purpose: string = REVIEW_PURPOSE,
): UnitDecisionState {
  const unit = findUnit(snapshot, unitId);
  if (!unit) {
    return { status: null, needsRecheck: false, canUndo: false, canRedo: false };
  }
  const history = selectTaskDecisionHistory(snapshot, {
    unitId,
    sourceVersionId: unit.sourceVersionId,
    purpose,
  });
  return {
    status: history.current?.status ?? null,
    needsRecheck: history.needsRecheck,
    canUndo: Boolean(history.undo),
    canRedo: Boolean(history.redo),
    ...(history.current?.replacementText !== undefined
      ? { replacementText: history.current.replacementText }
      : {}),
    ...(history.current
      ? { decisionId: history.current.id, note: history.current.note }
      : {}),
  };
}

export function decisionStatus(
  snapshot: TaskReviewSnapshot,
  unitId: string,
  purpose: string = REVIEW_PURPOSE,
): TaskDecisionStatus | null {
  return unitDecisionState(snapshot, unitId, purpose).status;
}

export function planSteps(snapshot: TaskReviewSnapshot) {
  return planScenes(snapshot).flatMap((scene) => scene.targets.map((target) => ({
    ...target, purpose: scene.purpose, reason: scene.reason,
  })));
}

/** Formal scenes own ordering. Steps are only an adapter for pre-scene tasks. */
export function planScenes(snapshot: TaskReviewSnapshot): TaskSceneSuggestion[] {
  const plan = snapshot.planRevisions.at(-1);
  if (!plan) return [];
  if (plan.scenes) return plan.scenes.filter((scene) => isTaskSceneCurrent(snapshot, scene, plan.policyRevision));
  return plan.steps.filter((step) => isTaskPlanStepCurrent(snapshot, step, plan.policyRevision)).map((step) => ({
    id: `legacy:${plan.id}:${step.unitId}:${step.purpose}`, kind: "single", targets: [{ unitId: step.unitId, sourceVersionId: step.sourceVersionId }],
    purpose: step.purpose, decisionMode: "per-unit", checkIntent: t("Review each item"), reason: step.reason,
    issueIds: [], criteriaRefs: step.criteriaBasis?.criteriaVersionIds ?? [], sourceRefs: step.sourceRefs ?? [], criteriaBasis: step.criteriaBasis ? [step.criteriaBasis] : [],
  }));
}

export function pendingSceneTargets(snapshot: TaskReviewSnapshot, scene: TaskSceneSuggestion) {
  return scene.targets.filter((target) => !selectTaskDecision(snapshot, { ...target, purpose: scene.purpose }));
}

/** Pick a fresh scene's reading focus; this never changes its future order. */
export function initialSceneTarget(snapshot: TaskReviewSnapshot, scene: TaskSceneSuggestion, targets = pendingSceneTargets(snapshot, scene)) {
  const candidates = targets.length ? targets : scene.targets;
  const severity = { high: 3, medium: 2, low: 1 };
  const risk = (unitId: string) => Math.max(0, ...issuesForUnit(snapshot, unitId, scene.purpose).map((issue) => severity[issue.severity]));
  return candidates.reduce((best, candidate) => risk(candidate.unitId) > risk(best.unitId) ? candidate : best);
}

export function remainingScenes(snapshot: TaskReviewSnapshot) {
  return planScenes(snapshot).filter((scene) => pendingSceneTargets(snapshot, scene).length > 0);
}

/**
 * Future plan steps that still await an applied human decision. A step the
 * reviewer already finished manually is skipped only when task, source
 * version and purpose all match; mere navigation never removes a step.
 * Steps bound to a superseded, missing or invalid source version are history:
 * desktop main would reject a decision against them, so they are not offered.
 */
export function remainingPlanSteps(snapshot: TaskReviewSnapshot) {
  const current = currentSourceIds(snapshot);
  return planSteps(snapshot).filter(
    (step) =>
      current.has(step.sourceVersionId) &&
      unitDecisionState(snapshot, step.unitId, step.purpose).status === null &&
      findUnit(snapshot, step.unitId) !== null,
  );
}

/** Progress counts only units of current source versions. */
export function unitStats(snapshot: TaskReviewSnapshot): UnitStats {
  const current = currentSourceIds(snapshot);
  let kept = 0;
  let rework = 0;
  let discarded = 0;
  let total = 0;
  for (const unit of snapshot.units) {
    if (!current.has(unit.sourceVersionId) || !isCurrentTaskUnit(snapshot, unit)) continue;
    total++;
    const status = unitDecisionState(snapshot, unit.id).status;
    if (status === "kept") kept++;
    else if (status === "rework") rework++;
    else if (status === "discarded") discarded++;
  }
  return {
    total,
    decided: kept + rework + discarded,
    kept,
    rework,
    discarded,
    pending: total - kept - rework - discarded,
  };
}

export function issuesForUnit(snapshot: TaskReviewSnapshot, unitId: string, purpose = REVIEW_PURPOSE) {
  return snapshot.issues.filter((issue) => issue.unitId === unitId && (issue.purpose ?? REVIEW_PURPOSE) === purpose && isTaskIssueCurrent(snapshot, issue));
}

export function planStepForUnit(snapshot: TaskReviewSnapshot, unitId: string) {
  return planSteps(snapshot).find((step) => step.unitId === unitId) ?? null;
}

export function recentVisits(snapshot: TaskReviewSnapshot, limit = 30): TaskVisit[] {
  return snapshot.history.slice(-limit).reverse();
}

export { selectTaskDecision };

export { selectAdoptedTaskContext, selectTaskContextForPlanning };

/** Current source versions the trusted editor may authorize for evidence. */
export function currentAuthorizedSourceVersionIds(snapshot: TaskReviewSnapshot): string[] {
  return [
    ...new Set(
      snapshot.sourceFiles
        .filter((file) => file.status === "available" && file.currentVersionId)
        .map((file) => file.currentVersionId!),
    ),
  ];
}

export interface CriterionDisplayState {
  version: TaskCriteriaVersion;
  active: boolean;
}

/**
 * Effective criterion per identity by replaying the append-only action log:
 * the latest adopted version of each criterion, active unless a later
 * deactivate/reactivate action toggled it. Superseded versions and their
 * contents stay history in the store; the default surfaces only what applies.
 */
export function criterionStates(history: TaskContextHistory | undefined): CriterionDisplayState[] {
  if (!history) return [];
  const versions = new Map(history.criteriaVersions.map((version) => [version.id, version]));
  const byCriterion = new Map<string, CriterionDisplayState>();
  for (const action of history.criteriaActions) {
    const version = versions.get(action.versionId);
    if (!version) continue;
    if (action.kind === "adopt") byCriterion.set(version.criterionId, { version, active: true });
    else if (byCriterion.get(version.criterionId)?.version.id === action.versionId)
      byCriterion.set(version.criterionId, { version, active: action.kind === "reactivate" });
  }
  return [...byCriterion.values()];
}

/** Human-readable scope label; never widens the stored scope. */
export function describeCriteriaScope(snapshot: TaskReviewSnapshot, scope: TaskCriteriaScope): string {
  if (scope.kind === "task")
    return scope.versions === "future" ? t("Entire task (including future versions)") : t("Entire task (current versions)");
  if (scope.kind === "sources") {
    const names = scope.entryIds
      .map((entryId) => snapshot.sourceFiles.find((file) => file.entryId === entryId)?.relativePath)
      .filter((name): name is string => Boolean(name));
    const label = scope.versions === "future" ? t("Related sources (including future versions)") : t("Related sources (current versions)");
    return `${label}：${names.join("、") || t("Unknown source")}`;
  }
  const ordinals = scope.targets
    .map((target) => snapshot.units.find((unit) => unit.id === target.unitId && unit.sourceVersionId === target.sourceVersionId)?.ordinal)
    .map((ordinal) => `#${ordinal ?? "?"}`);
  return t("reviewUi.Selected_items_v0_315", { v0: ordinals.join("、") });
}
