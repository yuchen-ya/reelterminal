import type { TaskCommit, TaskDecisionHistoryInput, TaskDecisionStatus, TaskDraft, TaskIssue, TaskPlanStep, TaskReviewSnapshot, TaskSceneSuggestion, TaskTextFormat, TaskUnitTarget } from './task-review';
import type { TaskContextProposal, TaskCriteriaScope } from './task-review-context';

export interface TaskReviewContextBridge {
  proposeContext(input: TaskCommit & { proposal: Omit<TaskContextProposal, 'id' | 'taskId' | 'createdAt' | 'basedOnPolicyRevision'>; authorizedSourceVersionIds: string[] }): Promise<TaskReviewSnapshot>;
  adoptContext(input: TaskCommit & { proposalId: string; authorizedSourceVersionIds: string[] }): Promise<TaskReviewSnapshot>;
  adoptCriteria(input: TaskCommit & { criterionId?: string; supersedesId?: string; content: string; scope: TaskCriteriaScope; purpose: string; origin: { kind: 'explicit'; text: string } | { kind: 'feedback'; decisionId: string } }): Promise<TaskReviewSnapshot>;
  setCriterionActive(input: TaskCommit & { versionId: string; active: boolean }): Promise<TaskReviewSnapshot>;
}

export interface TaskDecisionOutcome {
  snapshot: TaskReviewSnapshot;
  decisionId: string;
  outcome: 'committed' | 'not-committed' | 'unknown';
}
export type TaskDecisionReply = TaskReviewSnapshot & {
  decisionReceipt?: { decisionId: string; outcome: 'committed' | 'not-committed'; notificationFailed?: boolean; refreshFailed?: boolean; rejection?: 'validation' };
};

export interface TaskReviewBridge {
  getDecisionOutcome?(input: { root: string; taskId: string; decisionId: string }): Promise<TaskDecisionOutcome>;
  open(root: string): Promise<TaskReviewSnapshot>;
  refreshSources(input: TaskCommit): Promise<TaskReviewSnapshot>;
  setGoal(input: TaskCommit & { goal: string }): Promise<TaskReviewSnapshot>;
  importText(input: TaskCommit & { name: string; text: string; format: TaskTextFormat }): Promise<TaskReviewSnapshot>;
  importFile(input: TaskCommit & { entryId: string }): Promise<TaskReviewSnapshot>;
  decide(input: TaskCommit & TaskUnitTarget & { purpose: string; status: TaskDecisionStatus; note: string; replacementText?: string; decisionId?: string }): Promise<TaskDecisionReply>;
  undoDecision(input: TaskDecisionHistoryInput): Promise<TaskReviewSnapshot>;
  redoDecision(input: TaskDecisionHistoryInput): Promise<TaskReviewSnapshot>;
  saveDraft(input: TaskCommit & { draft: Omit<TaskDraft, 'updatedAt'> }): Promise<TaskReviewSnapshot>;
  visit(input: TaskCommit & TaskUnitTarget & { purpose: string }): Promise<TaskReviewSnapshot>;
  publishAnalysis(input: TaskCommit & { expectedPolicyRevision: number; sourceVersionIds: string[]; issues: TaskIssue[]; steps: TaskPlanStep[]; reason: string; purpose?: string; authorizedSourceVersionIds?: string[]; expectedContext?: { proposalId?: string; adoptionId?: string }; proposal?: Omit<TaskContextProposal, 'id' | 'taskId' | 'createdAt' | 'basedOnPolicyRevision'>; sceneSuggestions?: TaskSceneSuggestion[]; analyzedUnitIds?: string[] }): Promise<TaskReviewSnapshot>;
  exportSource(input: TaskCommit & { sourceVersionId: string; purpose: string }): Promise<TaskReviewSnapshot>;
}
