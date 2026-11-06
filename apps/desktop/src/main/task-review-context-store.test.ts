import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { TaskIssue, TaskReviewSnapshot, TaskSceneSuggestion } from '../shared/task-review';
import { isTextTaskUnit } from '../shared/task-review';
import { isTaskIssueCurrent, isTaskPlanStepCurrent, isTaskSceneCurrent, selectTaskDecision, selectTaskDecisionHistory } from '../shared/task-review-selectors';
import { resolveUnitCriteriaBasis } from '../shared/task-review-context';
import { TaskReviewStore } from './task-review-store';

const roots: string[] = [];
const commit = (state: TaskReviewSnapshot) => ({ root: state.root, taskId: state.taskId, expectedRevision: state.revision });
const target = (state: TaskReviewSnapshot, index = 0) => ({ unitId: state.units[index].id, sourceVersionId: state.units[index].sourceVersionId, purpose: 'review' });
const textUnit = (state: TaskReviewSnapshot, index = 0) => { const unit = state.units[index]; if (!isTextTaskUnit(unit)) throw new Error('Expected fixture text unit'); return unit; };
const ref = (state: TaskReviewSnapshot, index = 0) => ({ unitId: state.units[index].id, sourceVersionId: state.units[index].sourceVersionId, start: 0, end: textUnit(state, index).text.length, text: textUnit(state, index).text });
async function task() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-context-store-'));
  roots.push(root);
  const store = new TaskReviewStore();
  let state = await store.open(root);
  state = await store.importText({ ...commit(state), name: 'A', format: 'txt', text: 'A dialogue' });
  state = await store.importText({ ...commit(state), name: 'B', format: 'txt', text: 'B dialogue' });
  return { store, state };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('persisted task understanding and scoped criteria', () => {
  it('persists complete known goal contents, attributed cross-source context and separate human adoption in the existing task file', async () => {
    const f = await task(); let state = f.state;
    state = await f.store.setGoal({ ...commit(state), goal: 'Original task criteria' });
    state = await f.store.setGoal({ ...commit(state), goal: 'Revised task criteria' });
    expect(state.goalHistory?.map(version => version.content)).toEqual(['Original task criteria', 'Revised task criteria']);
    expect(state.goalHistoryIncomplete).toBe(false);
    const authorized = state.sources.map(source => source.id);
    state = await f.store.proposeContext({ ...commit(state), authorizedSourceVersionIds: authorized, proposal: { content: { groundedClaims: ['A and B both contain dialogue'], hypotheses: ['They may be the same speaker'] }, sourceRefs: [ref(state), ref(state, 1)], openQuestions: ['Are the speakers identical?'], proposedBy: 'agent' } });
    const proposal = state.contextHistory!.proposals[0];
    expect(proposal).toMatchObject({ proposedBy: 'agent', basedOnPolicyRevision: state.policyRevision });
    expect(state.contextHistory!.adoptions).toEqual([]);
    await expect(f.store.adoptContext({ ...commit(state), proposalId: proposal.id, authorizedSourceVersionIds: [authorized[0]] })).rejects.toThrow('outside the authorized');
    state = await f.store.adoptContext({ ...commit(state), proposalId: proposal.id, authorizedSourceVersionIds: authorized });
    expect(state.contextHistory!.adoptions[0]).toMatchObject({ proposalId: proposal.id, acceptedBy: 'human' });
    expect(await new TaskReviewStore().open(state.root)).toEqual(state);
    expect(JSON.parse(await fs.readFile(path.join(state.root, '.reelterminal', 'task-review.json'), 'utf8')).contextHistory).toEqual(state.contextHistory);
  });

  it('makes only affected decisions, evidence and future steps pending after explicit local feedback adoption', async () => {
    const f = await task(); let state = f.state;
    for (const index of [0, 1]) state = await f.store.decide({ ...commit(state), ...target(state, index), status: 'kept', note: index === 0 ? 'Require evidence for identity' : 'B stays approved' });
    const issues: TaskIssue[] = [0, 1].map(index => ({ id: randomUUID(), unitId: state.units[index].id, sourceVersionId: state.units[index].sourceVersionId, policyRevision: state.policyRevision, title: 'Check', severity: 'low', evidence: textUnit(state, index).text, hypothesis: 'Needs evidence', options: [] }));
    state = await f.store.publishAnalysis({ ...commit(state), expectedPolicyRevision: state.policyRevision, sourceVersionIds: state.sources.map(source => source.id), issues, steps: [0, 1].map(index => ({ ...target(state, index), reason: 'Check evidence' })), reason: 'initial' });
    const previousIssues = state.issues;
    const previousPlan = state.planRevisions.at(-1)!;
    const previousPolicy = state.policyRevision;
    const decision = selectTaskDecision(state, target(state))!;
    const scope = { kind: 'units' as const, targets: [{ unitId: state.units[0].id, sourceVersionId: state.units[0].sourceVersionId }] };
    state = await f.store.adoptCriteria({ ...commit(state), content: 'Require evidence for character identity', scope, purpose: 'review', origin: { kind: 'feedback', decisionId: decision.id } });
    expect(state.policyRevision).toBe(previousPolicy);
    expect(selectTaskDecisionHistory(state, target(state)).needsRecheck).toBe(true);
    expect(selectTaskDecision(state, target(state, 1))?.status).toBe('kept');
    expect(previousIssues.map(issue => isTaskIssueCurrent(state, issue))).toEqual([false, true]);
    expect(previousPlan.steps.map(step => isTaskPlanStepCurrent(state, step, previousPlan.policyRevision))).toEqual([false, true]);
    expect(state.decisions).toHaveLength(2);
    await expect(f.store.exportSource({ ...commit(state), sourceVersionId: state.sources[0].id, purpose: 'review' })).rejects.toThrow('No approved');
    await expect(f.store.publishAnalysis({ ...commit(state), expectedPolicyRevision: state.policyRevision, sourceVersionIds: [state.sources[0].id], issues: [previousIssues[0]], steps: [], reason: 'stale basis' })).rejects.toThrow('criteria basis changed');
    state = await f.store.exportSource({ ...commit(state), sourceVersionId: state.sources[1].id, purpose: 'review' });
    state = await f.store.decide({ ...commit(state), ...target(state), status: 'kept', note: 'Confirmed against adopted local standard' });
    state = await f.store.exportSource({ ...commit(state), sourceVersionId: state.sources[0].id, purpose: 'review' });
    const first = state.contextHistory!.criteriaVersions[0];
    state = await f.store.adoptCriteria({ ...commit(state), content: 'Keep wording concise', scope, purpose: 'review', origin: { kind: 'feedback', decisionId: selectTaskDecision(state, target(state))!.id } });
    expect(resolveUnitCriteriaBasis(state, state.contextHistory!, target(state)).criteria).toHaveLength(2);
    state = await f.store.adoptCriteria({ ...commit(state), criterionId: first.criterionId, supersedesId: first.id, content: 'Require two sources for identity', scope, purpose: 'review', origin: { kind: 'explicit', text: 'Human edited this standard' } });
    expect(state.contextHistory!.criteriaVersions).toHaveLength(3);
    const revised = state.contextHistory!.criteriaVersions.at(-1)!;
    state = await f.store.setCriterionActive({ ...commit(state), versionId: revised.id, active: false });
    expect(resolveUnitCriteriaBasis(state, state.contextHistory!, target(state)).criteria.map(version => version.content)).toEqual(['Keep wording concise']);
    expect(state.contextHistory!.criteriaVersions[0].origin).toMatchObject({ noteSnapshot: decision.note });
    expect(await new TaskReviewStore().open(state.root)).toEqual(state);
  });

  it('strictly validates cross-source evidence and basis while atomically publishing a model understanding proposal', async () => {
    const f = await task(); let state = f.state;
    const sourceIds = state.sources.map(source => source.id);
    const issue: TaskIssue = { id: randomUUID(), unitId: state.units[0].id, sourceVersionId: sourceIds[0], policyRevision: state.policyRevision, title: 'Possible cross-source mismatch', severity: 'high', evidence: textUnit(state).text, hypothesis: 'Check whether these refer to the same person', options: [], purpose: 'review', sourceRefs: [ref(state), ref(state, 1)], criteriaBasis: [0, 1].map(index => resolveUnitCriteriaBasis(state, state.contextHistory!, target(state, index)).basis) };
    const publish = () => ({ ...commit(state), expectedPolicyRevision: state.policyRevision, sourceVersionIds: sourceIds, issues: [issue], steps: [], reason: 'cross-source review' });
    await expect(f.store.publishAnalysis({ ...publish(), authorizedSourceVersionIds: [sourceIds[0]] })).rejects.toThrow('authorized source scope');
    await expect(f.store.publishAnalysis({ ...publish(), issues: [{ ...issue, sourceRefs: [{ ...ref(state, 1), text: 'fabricated' }] }] })).rejects.toThrow('UTF-16');
    await expect(f.store.publishAnalysis({ ...publish(), sourceVersionIds: [sourceIds[0]] })).rejects.toThrow('analysis scope');
    state = await f.store.publishAnalysis({ ...publish(), authorizedSourceVersionIds: sourceIds, expectedContext: {}, proposal: { content: { groundedClaims: ['Both sources contain dialogue'], hypotheses: ['Speaker identity is uncertain'] }, sourceRefs: [ref(state), ref(state, 1)], openQuestions: ['Same speaker?'], proposedBy: 'agent' } });
    expect(state.contextHistory!.proposals).toHaveLength(1);
    expect(state.issues[0].criteriaBasis).toHaveLength(2);
    expect(state.contextHistory!.adoptions).toEqual([]);
    expect(await new TaskReviewStore().open(state.root)).toEqual(state);
  });

  it('upgrades current task data without inventing missing historical goals or old evidence provenance', async () => {
    const f = await task(); let state = f.state;
    state = await f.store.setGoal({ ...commit(state), goal: 'Only this current text survives' });
    state = await f.store.decide({ ...commit(state), ...target(state), status: 'kept', note: 'Existing human decision' });
    const file = path.join(state.root, '.reelterminal', 'task-review.json');
    const legacy = JSON.parse(await fs.readFile(file, 'utf8'));
    delete legacy.contextHistory; delete legacy.goalHistory; delete legacy.goalHistoryIncomplete;
    delete legacy.decisions[0].criteriaBasis;
    await fs.writeFile(file, JSON.stringify(legacy));
    state = await new TaskReviewStore().open(state.root);
    expect(state.goalHistoryIncomplete).toBe(true);
    expect(state.goalHistory).toMatchObject([{ content: 'Only this current text survives', createdAt: null, provenance: 'legacy-current' }]);
    expect(state.goalHistory).toHaveLength(1);
    expect(state.decisions[0].criteriaBasis).toBeUndefined();
    expect(selectTaskDecision(state, target(state))?.status).toBe('kept');
    state = await f.store.setGoal({ ...commit(state), goal: 'Known new goal' });
    expect(state.goalHistory?.map(version => version.content)).toEqual(['Only this current text survives', 'Known new goal']);
    expect((await new TaskReviewStore().open(state.root)).goalHistory).toEqual(state.goalHistory);
  });

  it('persists compare scenes without deciding their members and accepts low-risk groups only with explicit analysis coverage', async () => {
    const f = await task(); let state = f.state;
    const targets = [0, 1].map(index => ({ unitId: state.units[index].id, sourceVersionId: state.units[index].sourceVersionId }));
    const basis = [0, 1].map(index => resolveUnitCriteriaBasis(state, state.contextHistory!, target(state, index)).basis);
    const compare: TaskSceneSuggestion = { id: 'compare-scene', kind: 'compare', targets, purpose: 'review', decisionMode: 'per-unit', checkIntent: 'Check speaker consistency', reason: 'Look at the two sources together', issueIds: [], criteriaRefs: [], sourceRefs: [ref(state), ref(state, 1)], criteriaBasis: basis };
    const request = () => ({ ...commit(state), expectedPolicyRevision: state.policyRevision, sourceVersionIds: state.sources.map(source => source.id), purpose: 'review', issues: [], steps: [], reason: 'scene preparation' });
    state = await f.store.publishAnalysis({ ...request(), sceneSuggestions: [compare] });
    expect(state.planRevisions.at(-1)!.scenes).toEqual([compare]);
    expect(state.decisions).toEqual([]);
    const group: TaskSceneSuggestion = { ...compare, id: 'group-scene', kind: 'lowRiskGroup', sourceRefs: [] };
    await expect(f.store.publishAnalysis({ ...request(), sceneSuggestions: [group] })).rejects.toThrow('explicitly analyzed');
    await expect(f.store.publishAnalysis({ ...request(), analyzedUnitIds: [targets[0].unitId], sceneSuggestions: [group] })).rejects.toThrow('explicitly analyzed');
    state = await f.store.publishAnalysis({ ...request(), analyzedUnitIds: targets.map(target => target.unitId), sceneSuggestions: [group] });
    const plan = state.planRevisions.at(-1)!;
    expect(isTaskSceneCurrent(state, plan.scenes![0], plan.policyRevision)).toBe(true);
    state = await f.store.decide({ ...commit(state), ...target(state), status: 'kept', note: 'Only the first member is approved' });
    expect(selectTaskDecision(state, target(state, 1))).toBeUndefined();
    expect(state.decisions).toHaveLength(1);
    expect(await new TaskReviewStore().open(state.root)).toEqual(state);
    const note = selectTaskDecision(state, target(state))!;
    state = await f.store.adoptCriteria({ ...commit(state), content: 'New local evidence requirement', scope: { kind: 'units', targets: [targets[0]] }, purpose: 'review', origin: { kind: 'feedback', decisionId: note.id } });
    expect(isTaskSceneCurrent(state, plan.scenes![0], plan.policyRevision)).toBe(false);
  });
});
