import type { TaskDecision, TaskIssue, TaskPlanStep, TaskReviewSnapshot, TaskSceneSuggestion, TaskUnitTarget } from './task-review';
import { isCurrentTaskUnit } from './task-review';
import { isTaskCriteriaBasisCurrent, resolveUnitCriteriaBasis } from './task-review-context';

type DecisionTarget = TaskUnitTarget & { purpose: string };

/** Navigation and draft history never participate in the human decision stack. */
function decisionHistory(snapshot: TaskReviewSnapshot, target: DecisionTarget, withCriteria: boolean): {
  current: TaskDecision | undefined;
  undo: TaskDecision | undefined;
  redo: TaskDecision | undefined;
  needsRecheck: boolean;
} {
  const source = snapshot.sourceFiles.find(file => file.currentVersionId === target.sourceVersionId && file.status === 'available');
  const matches = snapshot.decisions.filter(decision => decision.unitId === target.unitId && decision.sourceVersionId === target.sourceVersionId && decision.purpose === target.purpose);
  const unit = snapshot.units.find(unit => unit.id === target.unitId && unit.sourceVersionId === target.sourceVersionId);
  if (!source || !unit || !isCurrentTaskUnit(snapshot, unit)) return { current: undefined, undo: undefined, redo: undefined, needsRecheck: matches.length > 0 };
  const validBasis = (decision: TaskDecision) => {
    if (!withCriteria || !snapshot.contextHistory) return true;
    if (decision.criteriaBasis) return isTaskCriteriaBasisCurrent(snapshot, snapshot.contextHistory, decision.criteriaBasis);
    return resolveUnitCriteriaBasis(snapshot, snapshot.contextHistory, decision).basis.criteriaVersionIds.length === 0;
  };
  const decisions = new Map(matches.filter(decision => decision.policyRevision === snapshot.policyRevision && validBasis(decision)).map(decision => [decision.id, decision]));
  const applied: TaskDecision[] = [];
  const undone: TaskDecision[] = [];
  const recorded = new Set<string>();
  for (const action of snapshot.decisionActions) {
    const decision = decisions.get(action.decisionId);
    if (!decision) continue;
    if (action.kind === 'decide') {
      if (recorded.has(decision.id)) throw new Error('Duplicate task decision action');
      recorded.add(decision.id);
      applied.push(decision);
      undone.length = 0;
    } else if (action.kind === 'undo' && applied.at(-1)?.id === decision.id) {
      applied.pop();
      undone.push(decision);
    } else if (action.kind === 'redo' && undone.at(-1)?.id === decision.id) {
      undone.pop();
      applied.push(decision);
    } else {
      throw new Error('Invalid task decision action sequence');
    }
  }
  const current = applied.at(-1);
  return { current, undo: current, redo: undone.at(-1), needsRecheck: !current && matches.some(decision => decision.policyRevision !== snapshot.policyRevision || !validBasis(decision)) };
}

export function selectTaskDecisionHistory(snapshot: TaskReviewSnapshot, target: DecisionTarget) {
  return decisionHistory(snapshot, target, true);
}

/** Provenance selection for explicit adoption; ordinary review/export uses the stricter selector. */
export function selectTaskDecisionAtPolicy(snapshot: TaskReviewSnapshot, target: DecisionTarget): TaskDecision | undefined {
  return decisionHistory(snapshot, target, false).current;
}

export function selectTaskDecision(snapshot: TaskReviewSnapshot, target: DecisionTarget): TaskDecision | undefined {
  return selectTaskDecisionHistory(snapshot, target).current;
}

export function isTaskIssueCurrent(snapshot: TaskReviewSnapshot, issue: TaskIssue): boolean {
  const purpose = issue.purpose ?? 'review';
  if (issue.policyRevision !== snapshot.policyRevision || !snapshot.sourceFiles.some(file => file.status === 'available' && file.currentVersionId === issue.sourceVersionId)) return false;
  if (issue.sourceRefs?.some(ref => !snapshot.sourceFiles.some(file => file.status === 'available' && file.currentVersionId === ref.sourceVersionId))) return false;
  if (!snapshot.contextHistory) return true;
  if (issue.criteriaBasis) return issue.criteriaBasis.every(basis => isTaskCriteriaBasisCurrent(snapshot, snapshot.contextHistory!, basis));
  return resolveUnitCriteriaBasis(snapshot, snapshot.contextHistory, { unitId: issue.unitId, sourceVersionId: issue.sourceVersionId, purpose }).basis.criteriaVersionIds.length === 0;
}

export function isTaskPlanStepCurrent(snapshot: TaskReviewSnapshot, step: TaskPlanStep, policyRevision: number): boolean {
  if (policyRevision !== snapshot.policyRevision || !snapshot.sourceFiles.some(file => file.status === 'available' && file.currentVersionId === step.sourceVersionId)) return false;
  if (step.sourceRefs?.some(ref => !snapshot.sourceFiles.some(file => file.status === 'available' && file.currentVersionId === ref.sourceVersionId))) return false;
  if (!snapshot.contextHistory) return true;
  return step.criteriaBasis ? isTaskCriteriaBasisCurrent(snapshot, snapshot.contextHistory, step.criteriaBasis) : resolveUnitCriteriaBasis(snapshot, snapshot.contextHistory, step).basis.criteriaVersionIds.length === 0;
}

export function isTaskSceneCurrent(snapshot: TaskReviewSnapshot, scene: TaskSceneSuggestion, policyRevision: number): boolean {
  if (policyRevision !== snapshot.policyRevision || scene.targets.some(target => !snapshot.sourceFiles.some(file => file.status === 'available' && file.currentVersionId === target.sourceVersionId))) return false;
  if (!snapshot.contextHistory) return scene.criteriaBasis.every(basis => basis.criteriaVersionIds.length === 0);
  return scene.criteriaBasis.every(basis => isTaskCriteriaBasisCurrent(snapshot, snapshot.contextHistory!, basis));
}
