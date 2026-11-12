import type { TaskContextHistory, TaskEvidenceRef, TaskUnitCriteriaBasis } from './task-review-context';
import type { TaskOriginalExportRecord } from './task-review-export';
import type { TaskMediaAsset, TaskMediaSourceVersion, TaskMediaUnit } from './task-review-media';
/** Task state is authoritative in desktop main. Source text is untrusted data. */
export type TaskTextFormat = 'txt' | 'md' | 'srt' | 'vtt';
export type TaskDecisionStatus = 'kept' | 'rework' | 'discarded';
export interface TaskSourceIdentity {
  id: string;
  entryId: string;
  relativePath: string;
  hash: string;
  createdAt: number;
}
export interface TaskTextSourceVersion extends TaskSourceIdentity { kind?: 'text'; format: TaskTextFormat; text: string }
export type TaskSourceVersion = TaskTextSourceVersion | TaskMediaSourceVersion;
export interface TaskSourceFile {
  entryId: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
  currentVersionId?: string;
  status: 'available' | 'missing' | 'invalid';
  error?: string;
}
export interface TaskUnitIdentity {
  id: string;
  sourceVersionId: string;
  ordinal: number;
  supersedesUnitId?: string;
}
export interface TaskTextReviewUnit extends TaskUnitIdentity {
  kind?: 'text';
  text: string;
  startLine: number;
  endLine: number;
  startMs?: number;
  endMs?: number;
  cueSettings?: string;
}
export type TaskReviewUnit = TaskTextReviewUnit | TaskMediaUnit;
export function isTextTaskSource(source: TaskSourceVersion): source is TaskTextSourceVersion { return source.kind === undefined || source.kind === 'text'; }
export function isTextTaskUnit(unit: TaskReviewUnit): unit is TaskTextReviewUnit { return unit.kind === undefined || unit.kind === 'text'; }
export function isCurrentTaskUnit(snapshot: TaskReviewSnapshot, unit: TaskReviewUnit): boolean {
  return snapshot.sourceFiles.some(file => file.status === 'available' && file.currentVersionId === unit.sourceVersionId) && !snapshot.units.some(candidate => candidate.supersedesUnitId === unit.id);
}
export interface TaskDecision {
  id: string;
  unitId: string;
  sourceVersionId: string;
  /** The task-wide criteria explicitly accepted for this human decision. */
  policyRevision: number;
  purpose: string;
  status: TaskDecisionStatus;
  note: string;
  replacementText?: string;
  createdAt: number;
  criteriaBasis?: TaskUnitCriteriaBasis;
}
export interface TaskDecisionBatch {
  id: string;
  decisionIds: string[];
}
export interface TaskDecisionAction {
  id: string;
  kind: 'decide' | 'undo' | 'redo';
  decisionId: string;
  createdAt: number;
}
export interface TaskDraft {
  unitId: string;
  sourceVersionId: string;
  /** Human feedback/issue description, never implicit source replacement. */
  text: string;
  selectionStart: number;
  selectionEnd: number;
  updatedAt: number;
}
export interface TaskIssue {
  /** All sources available to the model that produced this text. */
  inputSourceVersionIds?: string[];
  id: string;
  unitId: string;
  sourceVersionId: string;
  policyRevision: number;
  severity: 'high' | 'medium' | 'low';
  title: string;
  evidence: string;
  hypothesis: string;
  options: { label: string; reason: string }[];
  sourceRefs?: TaskEvidenceRef[];
  criteriaBasis?: TaskUnitCriteriaBasis[];
  purpose?: string;
}
export interface TaskPlanStep { unitId: string; sourceVersionId: string; purpose: string; reason: string; criteriaBasis?: TaskUnitCriteriaBasis; sourceRefs?: TaskEvidenceRef[]; inputSourceVersionIds?: string[] }
export interface TaskSceneSuggestion {
  manual?: boolean;
  inputSourceVersionIds?: string[];
  id: string;
  kind: 'single' | 'compare' | 'lowRiskGroup';
  targets: TaskUnitTarget[];
  purpose: string;
  decisionMode: 'per-unit';
  checkIntent: string;
  reason: string;
  issueIds: string[];
  criteriaRefs: string[];
  sourceRefs: TaskEvidenceRef[];
  criteriaBasis: TaskUnitCriteriaBasis[];
}
export interface TaskPlanRevision { id: string; policyRevision: number; createdAt: number; steps: TaskPlanStep[]; reason: string; contextProvenance?: { proposalId?: string; adoptionId?: string }; scenes?: TaskSceneSuggestion[] }
export interface TaskGoalVersion { id: string; content: string; policyRevision: number; createdAt: number | null; provenance: 'human-edit' | 'legacy-current'; }
export interface TaskVisit {
  id: string;
  unitId: string;
  sourceVersionId: string;
  purpose: string;
  createdAt: number;
}
export interface TaskArtifact { id: string; relativePath: string; manifestRelativePath: string; sourceVersionId: string; unitIds: string[]; purpose: string; status: 'pending' | 'complete' | 'failed'; error?: string; createdAt: number }
export interface TaskReviewSnapshot {
  root: string;
  taskId: string;
  revision: number;
  /** Global task criteria only. Decisions and source updates have their own identity/scope. */
  policyRevision: number;
  goal: string;
  /** Additive for pre-context clients; current main always returns and persists these fields. */
  contextHistory?: TaskContextHistory;
  goalHistory?: TaskGoalVersion[];
  goalHistoryIncomplete?: boolean;
  originalExports?: TaskOriginalExportRecord[];
  mediaAssets?: TaskMediaAsset[];
  sources: TaskSourceVersion[];
  sourceFiles: TaskSourceFile[];
  units: TaskReviewUnit[];
  decisions: TaskDecision[];
  decisionActions: TaskDecisionAction[];
  decisionBatches?: TaskDecisionBatch[];
  drafts: TaskDraft[];
  issues: TaskIssue[];
  planRevisions: TaskPlanRevision[];
  history: TaskVisit[];
  artifacts: TaskArtifact[];
}
export interface TaskCommit { root: string; taskId: string; expectedRevision: number }
export interface TaskUnitTarget { unitId: string; sourceVersionId: string }
export interface TaskDecisionHistoryInput extends TaskCommit, TaskUnitTarget {
  decisionId: string;
  purpose: string;
  policyRevision: number;
}
