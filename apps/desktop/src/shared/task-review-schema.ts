import { z } from 'zod';
import { taskContextHistorySchema, taskContextProposalSchema, taskCriteriaBasisSchema, taskCriteriaInputSchema, taskEvidenceSchema, taskModelInputSourcesSchema } from './task-review-context';
import { taskOriginalExportRecordSchema } from './task-review-export';
import { taskDecisionRecordSchema } from './task-review-decision-schema';
import { taskMediaAssetSchema, taskMediaUnitSchema } from './task-review-media';

const id = z.string().uuid();
const text = z.string().max(2 * 1024 * 1024);
const purpose = z.string().trim().min(1).max(1000);
const format = z.enum(['txt', 'md', 'srt', 'vtt']);
const relativePath = z.string().min(1).refine(value => !value.includes('\\') && !value.startsWith('/') && !/^[a-z]:/i.test(value) && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.reelterminal'), 'Invalid task relative path');
const target = { unitId: id, sourceVersionId: id };
const commit = { root: z.string().min(1), taskId: id, expectedRevision: z.number().int().nonnegative().safe() };
const decisionHistory = { ...commit, ...target, purpose, decisionId: id, policyRevision: z.number().int().nonnegative().safe() };
export const taskDraftSchema = z.object({ ...target, text, selectionStart: z.number().int().nonnegative(), selectionEnd: z.number().int().nonnegative(), updatedAt: z.number().nonnegative() }).strict();
export const taskIssueSchema = z.object({ inputSourceVersionIds: taskModelInputSourcesSchema.optional(), id, ...target, policyRevision: z.number().int().nonnegative().safe(), severity: z.enum(['high', 'medium', 'low']), title: z.string().min(1).max(2000), evidence: text, hypothesis: text, options: z.array(z.object({ label: z.string().min(1).max(2000), reason: text }).strict()).max(10), sourceRefs: z.array(taskEvidenceSchema).max(100).optional(), criteriaBasis: z.array(taskCriteriaBasisSchema).max(100).optional(), purpose: purpose.optional() }).strict();
export const taskPlanStepSchema = z.object({ inputSourceVersionIds: taskModelInputSourcesSchema.optional(), ...target, purpose, reason: text, criteriaBasis: taskCriteriaBasisSchema.optional(), sourceRefs: z.array(taskEvidenceSchema).max(100).optional() }).strict();
export const taskSceneSuggestionSchema = z.object({ manual: z.boolean().optional(), inputSourceVersionIds: taskModelInputSourcesSchema.optional(), id: z.string().min(1).max(200), kind: z.enum(['single', 'compare', 'lowRiskGroup']), targets: z.array(z.object(target).strict()).min(1).max(8), purpose, decisionMode: z.literal('per-unit'), checkIntent: z.string().min(1).max(2000), reason: text, issueIds: z.array(id).max(100), criteriaRefs: z.array(id).max(100), sourceRefs: z.array(taskEvidenceSchema).max(100), criteriaBasis: z.array(taskCriteriaBasisSchema).min(1).max(100) }).strict();
const proposalInput = taskContextProposalSchema.omit({ id: true, taskId: true, createdAt: true, basedOnPolicyRevision: true });
const contextProvenance = z.object({ proposalId: id.optional(), adoptionId: id.optional() }).strict();
export const taskReviewContextSchemas = {
  proposeContext: z.object({ ...commit, proposal: proposalInput, authorizedSourceVersionIds: z.array(id) }).strict(),
  adoptContext: z.object({ ...commit, proposalId: id, authorizedSourceVersionIds: z.array(id) }).strict(),
  adoptCriteria: taskCriteriaInputSchema.omit({ id: true, createdAt: true }).extend({ ...commit, criterionId: id.optional() }).strict(),
  setCriterionActive: z.object({ ...commit, versionId: id, active: z.boolean() }).strict(),
};
export const taskReviewSchemas = {
  open: z.object({ root: z.string().min(1) }).strict(),
  getDecisionOutcome: z.object({ root: z.string().min(1), taskId: id, decisionId: id }).strict(),
  refreshSources: z.object(commit).strict(),
  setGoal: z.object({ ...commit, goal: z.string().max(200000) }).strict(),
  importText: z.object({ ...commit, name: z.string().trim().min(1).max(200), text, format }).strict(),
  importFile: z.object({ ...commit, entryId: id }).strict(),
  decide: z.object({ ...commit, ...target, purpose, decisionId: id.optional(), status: z.enum(['kept', 'rework', 'discarded']), note: z.string().max(200000), replacementText: text.optional() }).strict(),
  undoDecision: z.object(decisionHistory).strict(),
  redoDecision: z.object(decisionHistory).strict(),
  saveDraft: z.object({ ...commit, draft: taskDraftSchema.omit({ updatedAt: true }) }).strict(),
  visit: z.object({ ...commit, ...target, purpose }).strict(),
  publishAnalysis: z.object({ ...commit, expectedPolicyRevision: z.number().int().nonnegative().safe(), sourceVersionIds: z.array(id).min(1).max(25000), issues: z.array(taskIssueSchema).max(25000), steps: z.array(taskPlanStepSchema).max(25000), reason: text, purpose: purpose.optional(), authorizedSourceVersionIds: z.array(id).optional(), expectedContext: contextProvenance.optional(), proposal: proposalInput.optional(), sceneSuggestions: z.array(taskSceneSuggestionSchema).max(1000).optional(), analyzedUnitIds: z.array(id).max(25000).optional() }).strict(),
  exportSource: z.object({ ...commit, sourceVersionId: id, purpose }).strict(),
};

export const taskReviewStateSchema = z.object({
  taskId: id,
  revision: z.number().int().nonnegative().safe(),
  policyRevision: z.number().int().nonnegative().safe(),
  goal: z.string().max(200000),
  contextHistory: taskContextHistorySchema.optional(),
  goalHistory: z.array(z.object({ id, content: z.string().max(200000), policyRevision: z.number().int().nonnegative(), createdAt: z.number().nonnegative().nullable(), provenance: z.enum(['human-edit', 'legacy-current']) }).strict()).optional(),
  goalHistoryIncomplete: z.boolean().optional(),
  originalExports: z.array(taskOriginalExportRecordSchema).optional(),
  sources: z.array(z.union([
    z.object({ id, entryId: id, relativePath, hash: z.string().regex(/^[a-f0-9]{64}$/), format, text, createdAt: z.number().nonnegative(), kind: z.literal('text').optional() }).strict(),
    z.object({ id, entryId: id, relativePath, hash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.number().nonnegative(), kind: z.enum(['image', 'video']), mime: z.string().min(1), width: z.number().int().positive(), height: z.number().int().positive(), durationSec: z.number().finite().nonnegative() }).strict(),
  ])),
  sourceFiles: z.array(z.object({ entryId: id, relativePath, size: z.number().nonnegative(), mtimeMs: z.number(), ctimeMs: z.number().optional(), currentVersionId: id.optional(), status: z.enum(['available', 'missing', 'invalid']), error: z.string().optional() }).strict()),
  units: z.array(z.union([z.object({ id, sourceVersionId: id, ordinal: z.number().int().positive(), kind: z.literal('text').optional(), supersedesUnitId: id.optional(), text, startLine: z.number().int().positive(), endLine: z.number().int().positive(), startMs: z.number().nonnegative().optional(), endMs: z.number().nonnegative().optional(), cueSettings: z.string().optional() }).strict(), taskMediaUnitSchema])),
  mediaAssets: z.array(taskMediaAssetSchema).optional(),
  decisions: z.array(taskDecisionRecordSchema),
  decisionActions: z.array(z.object({ id, kind: z.enum(['decide', 'undo', 'redo']), decisionId: id, createdAt: z.number().nonnegative() }).strict()),
  drafts: z.array(taskDraftSchema),
  issues: z.array(taskIssueSchema),
  planRevisions: z.array(z.object({ id, policyRevision: z.number().int().nonnegative().safe(), createdAt: z.number().nonnegative(), steps: z.array(taskPlanStepSchema), reason: text, contextProvenance: contextProvenance.optional(), scenes: z.array(taskSceneSuggestionSchema).optional() }).strict()),
  history: z.array(z.object({ id, ...target, purpose, createdAt: z.number().nonnegative() }).strict()),
  artifacts: z.array(z.object({ id, relativePath, manifestRelativePath: relativePath, sourceVersionId: id, unitIds: z.array(id), purpose, status: z.enum(['pending', 'complete', 'failed']), error: z.string().optional(), createdAt: z.number().nonnegative() }).strict()),
}).strict();
