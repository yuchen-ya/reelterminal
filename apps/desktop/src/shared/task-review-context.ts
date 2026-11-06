import { z } from 'zod';
import type { TaskReviewSnapshot, TaskUnitTarget } from './task-review';
import { isCurrentTaskUnit, isTextTaskUnit } from './task-review';
import { selectTaskDecisionAtPolicy } from './task-review-selectors';

/** Versioned task understanding and explicitly adopted criteria. */
export interface TaskEvidenceRef extends TaskUnitTarget {
  start: number;
  end: number;
  text: string;
}
export interface TaskContextProposal {
  id: string;
  taskId: string;
  parentId?: string;
  /** Grounded claims remain attributed proposals, never automatically verified facts. */
  content: { groundedClaims: string[]; hypotheses: string[] };
  sourceRefs: TaskEvidenceRef[];
  openQuestions: string[];
  proposedBy: 'human' | 'agent';
  createdAt: number;
  basedOnPolicyRevision?: number;
  /** Complete source inputs of a model derivation, not merely its quoted evidence. */
  inputSourceVersionIds?: string[];
}
export interface TaskContextAdoption {
  id: string;
  proposalId: string;
  acceptedBy: 'human';
  createdAt: number;
}
export type TaskCriteriaScope =
  | { kind: 'task'; versions: 'current' | 'future' }
  | { kind: 'sources'; entryIds: string[]; versions: 'current' | 'future' }
  | { kind: 'units'; targets: TaskUnitTarget[] };
export type TaskCriteriaOrigin =
  | { kind: 'explicit'; text: string }
  | { kind: 'feedback'; decisionId: string; noteSnapshot: string; unitId: string; sourceVersionId: string; policyRevision: number };
export interface TaskCriteriaVersion {
  id: string;
  criterionId: string;
  taskId: string;
  supersedesId?: string;
  content: string;
  scope: TaskCriteriaScope;
  purpose: string;
  origin: TaskCriteriaOrigin;
  acceptedBy: 'human';
  acceptedSourceVersionIds: string[];
  createdAt: number;
}
export interface TaskCriteriaAction {
  id: string;
  versionId: string;
  kind: 'adopt' | 'deactivate' | 'reactivate';
  acceptedBy: 'human';
  createdAt: number;
}
export interface TaskContextHistory {
  taskId: string;
  proposals: TaskContextProposal[];
  adoptions: TaskContextAdoption[];
  criteriaVersions: TaskCriteriaVersion[];
  criteriaActions: TaskCriteriaAction[];
}
export interface TaskUnitCriteriaBasis extends TaskUnitTarget {
  taskId: string;
  purpose: string;
  policyRevision: number;
  criteriaVersionIds: string[];
}

const id = z.string().uuid();
const text = z.string().trim().min(1).max(16000);
const targetSchema = z.object({ unitId: id, sourceVersionId: id }).strict();
export const taskEvidenceSchema = targetSchema.extend({ start: z.number().int().nonnegative(), end: z.number().int().positive(), text: z.string().min(1).max(16000) }).strict();
export const taskCriteriaScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), versions: z.enum(['current', 'future']) }).strict(),
  z.object({ kind: z.literal('sources'), entryIds: z.array(id).min(1).max(1000), versions: z.enum(['current', 'future']) }).strict(),
  z.object({ kind: z.literal('units'), targets: z.array(targetSchema).min(1).max(1000) }).strict(),
]);
export const taskModelInputSourcesSchema = z.array(id).max(25000);
export const taskContextProposalSchema = z.object({ id, taskId: id, parentId: id.optional(), content: z.object({ groundedClaims: z.array(text).max(100), hypotheses: z.array(text).max(100) }).strict(), sourceRefs: z.array(taskEvidenceSchema).max(100), openQuestions: z.array(text).max(100), proposedBy: z.enum(['human', 'agent']), createdAt: z.number().nonnegative(), basedOnPolicyRevision: z.number().int().nonnegative().optional(), inputSourceVersionIds: taskModelInputSourcesSchema.optional() }).strict();
const adoptionSchema = z.object({ id, proposalId: id, createdAt: z.number().nonnegative() }).strict();
export const taskCriteriaInputSchema = z.object({ id, criterionId: id, supersedesId: id.optional(), content: text, scope: taskCriteriaScopeSchema, purpose: z.string().trim().min(1).max(1000), origin: z.discriminatedUnion('kind', [z.object({ kind: z.literal('explicit'), text }).strict(), z.object({ kind: z.literal('feedback'), decisionId: id }).strict()]), createdAt: z.number().nonnegative() }).strict();
export const taskCriteriaBasisSchema = targetSchema.extend({ taskId: id, purpose: z.string().min(1).max(1000), policyRevision: z.number().int().nonnegative(), criteriaVersionIds: z.array(id) }).strict();
export const taskContextHistorySchema = z.object({ taskId: id, proposals: z.array(taskContextProposalSchema), adoptions: z.array(adoptionSchema.extend({ acceptedBy: z.literal('human') }).strict()), criteriaVersions: z.array(taskCriteriaInputSchema.omit({ origin: true }).extend({ taskId: id, acceptedBy: z.literal('human'), acceptedSourceVersionIds: z.array(id), origin: z.discriminatedUnion('kind', [z.object({ kind: z.literal('explicit'), text }).strict(), z.object({ kind: z.literal('feedback'), decisionId: id, noteSnapshot: z.string().max(200000), unitId: id, sourceVersionId: id, policyRevision: z.number().int().nonnegative() }).strict()]) }).strict()), criteriaActions: z.array(z.object({ id, versionId: id, kind: z.enum(['adopt', 'deactivate', 'reactivate']), acceptedBy: z.literal('human'), createdAt: z.number().nonnegative() }).strict()) }).strict();

function assertTask(snapshot: TaskReviewSnapshot, history: TaskContextHistory): void {
  if (snapshot.taskId !== history.taskId) throw new Error('Task context identity changed');
}
function currentUnit(snapshot: TaskReviewSnapshot, target: TaskUnitTarget) {
  const unit = snapshot.units.find(unit => unit.id === target.unitId && unit.sourceVersionId === target.sourceVersionId);
  return unit && isCurrentTaskUnit(snapshot, unit) ? unit : undefined;
}
function assertScope(snapshot: TaskReviewSnapshot, scope: TaskCriteriaScope): void {
  if (scope.kind === 'sources') {
    if (new Set(scope.entryIds).size !== scope.entryIds.length || scope.entryIds.some(entryId => !snapshot.sourceFiles.some(file => file.entryId === entryId && file.status === 'available')))
      throw new Error('Criteria source scope is not available in this task');
  } else if (scope.kind === 'units') {
    if (new Set(scope.targets.map(target => `${target.sourceVersionId}/${target.unitId}`)).size !== scope.targets.length || scope.targets.some(target => !currentUnit(snapshot, target)))
      throw new Error('Criteria unit scope is not current in this task');
  }
}
function scopeKey(scope: TaskCriteriaScope): string {
  if (scope.kind === 'task') return `task:${scope.versions}`;
  if (scope.kind === 'sources') return `sources:${scope.versions}:${[...scope.entryIds].sort().join('/')}`;
  return `units:${scope.targets.map(target => `${target.sourceVersionId}/${target.unitId}`).sort().join('/')}`;
}

export function createTaskContextHistory(taskId: string): TaskContextHistory {
  return { taskId: id.parse(taskId), proposals: [], adoptions: [], criteriaVersions: [], criteriaActions: [] };
}

/** Missing provenance cannot establish that old model text is safe to reuse. */
export function isTaskModelInputScopeCurrent(snapshot: TaskReviewSnapshot, sourceVersionIds: readonly string[] | undefined, allowedSourceVersionIds: readonly string[]): boolean {
  if (!sourceVersionIds) return false;
  const allowed = new Set(allowedSourceVersionIds);
  const current = new Set(snapshot.sourceFiles.filter(file => file.status === 'available').map(file => file.currentVersionId));
  return sourceVersionIds.every(sourceId => allowed.has(sourceId) && current.has(sourceId));
}

/** All referenced units must be current and within the caller's existing model grant. */
export function validateTaskEvidence(snapshot: TaskReviewSnapshot, input: TaskEvidenceRef[], allowedSourceVersionIds: readonly string[]): TaskEvidenceRef[] {
  const refs = z.array(taskEvidenceSchema).max(100).parse(input);
  const allowed = new Set(allowedSourceVersionIds);
  for (const ref of refs) {
    if (!allowed.has(ref.sourceVersionId)) throw new Error('Evidence is outside the authorized source scope');
    const unit = currentUnit(snapshot, ref);
    if (!unit) throw new Error('Evidence unit/source version is no longer current');
    if (!isTextTaskUnit(unit)) throw new Error('Text evidence cannot reference a media unit');
    if (ref.end <= ref.start || ref.end > unit.text.length || unit.text.slice(ref.start, ref.end) !== ref.text)
      throw new Error('Evidence quote does not match its UTF-16 source range');
  }
  return refs;
}

export function proposeTaskContext(snapshot: TaskReviewSnapshot, history: TaskContextHistory, input: TaskContextProposal, allowedSourceVersionIds: readonly string[]): TaskContextHistory {
  assertTask(snapshot, history);
  const proposal = taskContextProposalSchema.parse(input);
  if (proposal.taskId !== snapshot.taskId) throw new Error('Context proposal belongs to another task');
  if (history.proposals.some(existing => existing.id === proposal.id)) throw new Error('Context proposal identity already exists');
  if (proposal.parentId && !history.proposals.some(existing => existing.id === proposal.parentId)) throw new Error('Context parent does not exist');
  validateTaskEvidence(snapshot, proposal.sourceRefs, allowedSourceVersionIds);
  if (proposal.inputSourceVersionIds && (!isTaskModelInputScopeCurrent(snapshot, proposal.inputSourceVersionIds, allowedSourceVersionIds) || proposal.sourceRefs.some(ref => !proposal.inputSourceVersionIds!.includes(ref.sourceVersionId)))) throw new Error('Context input dependencies are outside the authorized current source scope');
  if (proposal.proposedBy === 'agent' && proposal.content.groundedClaims.length && !proposal.sourceRefs.length) throw new Error('Model grounded claims require source evidence');
  return { ...history, proposals: [...history.proposals, proposal] };
}

/** Trusted-human action: proposals alone never become effective task context. */
export function adoptTaskContext(snapshot: TaskReviewSnapshot, history: TaskContextHistory, input: { id: string; proposalId: string; createdAt: number }, allowedSourceVersionIds: readonly string[]): TaskContextHistory {
  assertTask(snapshot, history);
  const args = adoptionSchema.parse(input);
  const proposal = history.proposals.find(proposal => proposal.id === args.proposalId);
  if (!proposal) throw new Error('Context proposal does not exist');
  if (history.adoptions.some(adoption => adoption.id === args.id)) throw new Error('Context adoption identity already exists');
  validateTaskEvidence(snapshot, proposal.sourceRefs, allowedSourceVersionIds);
  return { ...history, adoptions: [...history.adoptions, { ...args, acceptedBy: 'human' }] };
}

export function selectAdoptedTaskContext(history: TaskContextHistory): TaskContextProposal | undefined {
  const last = history.adoptions.at(-1);
  return last ? history.proposals.find(proposal => proposal.id === last.proposalId) : undefined;
}

/** AI understanding can prepare a future plan without being promoted to human-confirmed truth. */
export function selectTaskContextForPlanning(history: TaskContextHistory): TaskContextProposal | undefined {
  return history.proposals.at(-1);
}

function criterionStates(history: TaskContextHistory): Map<string, { version: TaskCriteriaVersion; active: boolean }> {
  const versions = new Map(history.criteriaVersions.map(version => [version.id, version]));
  const states = new Map<string, { version: TaskCriteriaVersion; active: boolean }>();
  for (const action of history.criteriaActions) {
    const version = versions.get(action.versionId);
    if (!version) throw new Error('Criteria action refers to a missing version');
    const previous = states.get(version.criterionId);
    if (action.kind === 'adopt') {
      if ((previous && version.supersedesId !== previous.version.id) || (!previous && version.supersedesId)) throw new Error('Invalid criteria replacement history');
      states.set(version.criterionId, { version, active: true });
    }
    else {
      if (previous?.version.id !== version.id || previous.active === (action.kind === 'reactivate')) throw new Error('Invalid criteria activation history');
      states.set(version.criterionId, { version, active: action.kind === 'reactivate' });
    }
  }
  return states;
}

/** Disk history may be stale, but its original identities and exact quotations must remain valid. */
export function validateTaskContextHistory(snapshot: TaskReviewSnapshot, history: TaskContextHistory): void {
  assertTask(snapshot, history);
  const proposals = new Map(history.proposals.map(proposal => [proposal.id, proposal]));
  const versions = new Map(history.criteriaVersions.map(version => [version.id, version]));
  if (proposals.size !== history.proposals.length || versions.size !== history.criteriaVersions.length) throw new Error('Duplicate task context history identity');
  if (history.adoptions.some(adoption => !proposals.has(adoption.proposalId))) throw new Error('Invalid context adoption history');
  for (const proposal of history.proposals) {
    if (proposal.taskId !== snapshot.taskId || (proposal.parentId && !proposals.has(proposal.parentId))) throw new Error('Invalid context proposal provenance');
    for (const ref of proposal.sourceRefs) {
      const unit = snapshot.units.find(unit => unit.id === ref.unitId && unit.sourceVersionId === ref.sourceVersionId);
      if (!unit || !isTextTaskUnit(unit) || ref.end <= ref.start || ref.end > unit.text.length || unit.text.slice(ref.start, ref.end) !== ref.text) throw new Error('Invalid historical context evidence');
    }
  }
  for (const version of history.criteriaVersions) {
    if (version.taskId !== snapshot.taskId) throw new Error('Invalid criteria task identity');
    if (version.origin.kind === 'feedback') {
      const origin = version.origin;
      const decision = snapshot.decisions.find(decision => decision.id === origin.decisionId);
      if (!decision || decision.note !== origin.noteSnapshot || decision.unitId !== origin.unitId || decision.sourceVersionId !== origin.sourceVersionId || decision.policyRevision !== origin.policyRevision) throw new Error('Invalid criteria feedback provenance');
    }
  }
  criterionStates(history);
}

/** Deactivation is reversible and traceable; historical contents are never deleted. */
export function setTaskCriterionActive(history: TaskContextHistory, input: { id: string; versionId: string; active: boolean; createdAt: number }): TaskContextHistory {
  const args = z.object({ id, versionId: id, active: z.boolean(), createdAt: z.number().nonnegative() }).strict().parse(input);
  if (history.criteriaActions.some(action => action.id === args.id)) throw new Error('Criteria action identity already exists');
  const current = [...criterionStates(history).values()].find(state => state.version.id === args.versionId);
  if (!current || current.active === args.active) throw new Error('Criteria version is not eligible for activation change');
  return { ...history, criteriaActions: [...history.criteriaActions, { id: args.id, versionId: args.versionId, kind: args.active ? 'reactivate' : 'deactivate', acceptedBy: 'human', createdAt: args.createdAt }] };
}

/** Explicit human adoption, never called as a side effect of decide or ordinary feedback. */
export function adoptTaskCriteria(snapshot: TaskReviewSnapshot, history: TaskContextHistory, input: {
  id: string; criterionId: string; supersedesId?: string; content: string; scope: TaskCriteriaScope; purpose: string;
  origin: { kind: 'explicit'; text: string } | { kind: 'feedback'; decisionId: string }; createdAt: number;
}): TaskContextHistory {
  assertTask(snapshot, history);
  const args = taskCriteriaInputSchema.parse(input);
  if (history.criteriaVersions.some(version => version.id === args.id)) throw new Error('Criteria identity already exists');
  assertScope(snapshot, args.scope);
  const previousState = criterionStates(history).get(args.criterionId);
  if (args.supersedesId) {
    const previous = history.criteriaVersions.find(version => version.id === args.supersedesId);
    if (!previous || previous.criterionId !== args.criterionId || previous.purpose !== args.purpose || scopeKey(previous.scope) !== scopeKey(args.scope)) throw new Error('Criteria replacement must retain its identity, explicit scope and purpose');
    if (previousState?.version.id !== previous.id) throw new Error('Criteria version has already been replaced');
  } else if (previousState) throw new Error('Editing a criterion requires its explicit previous version');
  let origin: TaskCriteriaOrigin;
  if (args.origin.kind === 'feedback') {
    const decisionId = args.origin.decisionId;
    const decision = snapshot.decisions.find(decision => decision.id === decisionId);
    if (!decision || selectTaskDecisionAtPolicy(snapshot, decision)?.id !== decision.id || !decision.note.trim()) throw new Error('Feedback must be a current human decision with a nonempty note');
    origin = { kind: 'feedback', decisionId: decision.id, noteSnapshot: decision.note, unitId: decision.unitId, sourceVersionId: decision.sourceVersionId, policyRevision: decision.policyRevision };
  } else {
    origin = args.origin;
  }
  const acceptedSourceVersionIds = snapshot.sourceFiles.filter(file => file.status === 'available' && file.currentVersionId && (
    args.scope.kind === 'task' ||
    (args.scope.kind === 'sources' && args.scope.entryIds.includes(file.entryId)) ||
    (args.scope.kind === 'units' && args.scope.targets.some(target => target.sourceVersionId === file.currentVersionId))
  )).map(file => file.currentVersionId!);
  if (args.scope.kind !== 'units' && args.scope.versions === 'current' && !acceptedSourceVersionIds.length) throw new Error('Current-version criteria require available sources');
  const version: TaskCriteriaVersion = { ...args, taskId: snapshot.taskId, origin, acceptedBy: 'human', acceptedSourceVersionIds };
  return { ...history, criteriaVersions: [...history.criteriaVersions, version], criteriaActions: [...history.criteriaActions, { id: args.id, versionId: version.id, kind: 'adopt', acceptedBy: 'human', createdAt: args.createdAt }] };
}

/** Full criterion contents remain available beside stable IDs; no hash or rule engine is needed. */
export function resolveUnitCriteriaBasis(snapshot: TaskReviewSnapshot, history: TaskContextHistory, target: TaskUnitTarget & { purpose: string }): { basis: TaskUnitCriteriaBasis; criteria: TaskCriteriaVersion[] } {
  assertTask(snapshot, history);
  if (!currentUnit(snapshot, target)) throw new Error('Criteria target unit/source version is no longer current');
  const source = snapshot.sources.find(source => source.id === target.sourceVersionId)!;
  const criteria = [...criterionStates(history).values()].filter(state => state.active).map(state => state.version).filter(version => version.purpose === target.purpose && (
    (version.scope.kind === 'task' && (version.scope.versions === 'future' || version.acceptedSourceVersionIds.includes(source.id))) ||
    (version.scope.kind === 'sources' && version.scope.entryIds.includes(source.entryId) && (version.scope.versions === 'future' || version.acceptedSourceVersionIds.includes(source.id))) ||
    (version.scope.kind === 'units' && version.scope.targets.some(member => member.unitId === target.unitId && member.sourceVersionId === target.sourceVersionId))
  ));
  return { basis: { taskId: snapshot.taskId, unitId: target.unitId, sourceVersionId: target.sourceVersionId, purpose: target.purpose, policyRevision: snapshot.policyRevision, criteriaVersionIds: criteria.map(version => version.id).sort() }, criteria };
}

/** Can be used by issues and decisions without mutating either historical record. */
export function isTaskCriteriaBasisCurrent(snapshot: TaskReviewSnapshot, history: TaskContextHistory, recorded: TaskUnitCriteriaBasis): boolean {
  if (recorded.taskId !== snapshot.taskId || recorded.policyRevision !== snapshot.policyRevision || !currentUnit(snapshot, recorded)) return false;
  const current = resolveUnitCriteriaBasis(snapshot, history, recorded).basis;
  return current.criteriaVersionIds.length === recorded.criteriaVersionIds.length && current.criteriaVersionIds.every((id, index) => id === recorded.criteriaVersionIds[index]);
}
