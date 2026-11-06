import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { TaskReviewSnapshot } from '../shared/task-review';
import { isTextTaskSource } from '../shared/task-review';
import { adoptTaskContext, adoptTaskCriteria, createTaskContextHistory, isTaskCriteriaBasisCurrent, proposeTaskContext, resolveUnitCriteriaBasis, selectAdoptedTaskContext, selectTaskContextForPlanning, setTaskCriterionActive, validateTaskEvidence } from '../shared/task-review-context';

function fixture(): TaskReviewSnapshot {
  const taskId = randomUUID();
  const a = randomUUID();
  const b = randomUUID();
  const entryA = randomUUID();
  const entryB = randomUUID();
  return {
    root: 'unused-pure-fixture', taskId, revision: 5, policyRevision: 2, goal: 'Review dialogue',
    sources: [
      { id: a, entryId: entryA, relativePath: 'a.txt', hash: 'a'.repeat(64), text: 'A😀\nnext\nA second', format: 'txt', createdAt: 0 },
      { id: b, entryId: entryB, relativePath: 'b.txt', hash: 'b'.repeat(64), text: 'B line', format: 'txt', createdAt: 0 },
    ],
    sourceFiles: [
      { entryId: entryA, relativePath: 'a.txt', size: 20, mtimeMs: 1, currentVersionId: a, status: 'available' },
      { entryId: entryB, relativePath: 'b.txt', size: 6, mtimeMs: 1, currentVersionId: b, status: 'available' },
    ],
    units: [
      { id: randomUUID(), sourceVersionId: a, ordinal: 1, text: 'A😀\nnext', startLine: 1, endLine: 2 },
      { id: randomUUID(), sourceVersionId: a, ordinal: 2, text: 'A second', startLine: 3, endLine: 3 },
      { id: randomUUID(), sourceVersionId: b, ordinal: 1, text: 'B line', startLine: 1, endLine: 1 },
    ],
    decisions: [], decisionActions: [], drafts: [], issues: [], planRevisions: [], history: [], artifacts: [],
  };
}
const target = (snapshot: TaskReviewSnapshot, index = 0) => ({ unitId: snapshot.units[index].id, sourceVersionId: snapshot.units[index].sourceVersionId, purpose: 'review' });
const explicit = () => ({ id: randomUUID(), criterionId: randomUUID(), content: 'Check the stated evidence', purpose: 'review', origin: { kind: 'explicit' as const, text: 'Human explicitly supplied this standard' }, createdAt: 1 });

describe('independent task context and scoped criteria logic', () => {
  it('validates cross-source evidence using exact UTF-16 ranges and existing authorized current sources', () => {
    const snapshot = fixture();
    const refs = [
      { ...target(snapshot), start: 1, end: 8, text: '😀\nnext' },
      { ...target(snapshot, 2), start: 0, end: 6, text: 'B line' },
    ].map(({ purpose: _purpose, ...ref }) => ref);
    const allowed = snapshot.sources.map(source => source.id);
    expect(validateTaskEvidence(snapshot, refs, allowed)).toEqual(refs);
    expect(() => validateTaskEvidence(snapshot, refs, [allowed[0]])).toThrow('outside the authorized');
    expect(() => validateTaskEvidence(snapshot, [{ ...refs[0], end: 2 }], allowed)).toThrow('UTF-16');
    expect(() => validateTaskEvidence(snapshot, [{ ...refs[0], text: 'invented' }], allowed)).toThrow('UTF-16');
    expect(() => validateTaskEvidence(snapshot, [{ ...refs[0], sourceVersionId: allowed[1] }], allowed)).toThrow('no longer current');
    const stale = structuredClone(snapshot);
    stale.sourceFiles[0].status = 'missing';
    expect(() => validateTaskEvidence(stale, refs, allowed)).toThrow('no longer current');
  });

  it('keeps AI understanding attributed and usable for planning while preserving separate human adoption history', () => {
    const snapshot = fixture();
    const initial = createTaskContextHistory(snapshot.taskId);
    const proposal = { id: randomUUID(), taskId: snapshot.taskId, content: { groundedClaims: ['The selected source contains A'], hypotheses: ['A and B may refer to the same speaker'] }, sourceRefs: [{ ...target(snapshot), start: 0, end: 1, text: 'A' }].map(({ purpose: _purpose, ...ref }) => ref), openQuestions: ['Are A and B the same speaker?'], proposedBy: 'agent' as const, createdAt: 1 };
    const proposed = proposeTaskContext(snapshot, initial, proposal, snapshot.sources.map(source => source.id));
    expect(initial.proposals).toEqual([]);
    expect(selectAdoptedTaskContext(proposed)).toBeUndefined();
    expect(selectTaskContextForPlanning(proposed)).toMatchObject({ proposedBy: 'agent', content: proposal.content });
    const adopted = adoptTaskContext(snapshot, proposed, { id: randomUUID(), proposalId: proposal.id, createdAt: 2 }, snapshot.sources.map(source => source.id));
    expect(adopted.adoptions[0].acceptedBy).toBe('human');
    expect(selectAdoptedTaskContext(adopted)).toEqual(proposal);
    const next = proposeTaskContext(snapshot, adopted, { ...proposal, id: randomUUID(), parentId: proposal.id, content: { groundedClaims: ['A is present'], hypotheses: ['Revised interpretation'] }, createdAt: 3 }, snapshot.sources.map(source => source.id));
    expect(next.proposals).toHaveLength(2);
    expect(selectAdoptedTaskContext(next)?.id).toBe(proposal.id);
    expect(selectTaskContextForPlanning(next)?.parentId).toBe(proposal.id);
  });

  it('adopts feedback only explicitly and changes only matching unit/purpose bases without mutating decisions or global policy', () => {
    const snapshot = fixture();
    const unit = target(snapshot);
    const decision = { id: randomUUID(), ...unit, policyRevision: snapshot.policyRevision, status: 'rework' as const, note: 'Do not infer a speaker without a citation', createdAt: 1 };
    snapshot.decisions.push(decision);
    snapshot.decisionActions.push({ id: randomUUID(), kind: 'decide', decisionId: decision.id, createdAt: 1 });
    const history = createTaskContextHistory(snapshot.taskId);
    const before = snapshot.units.map((_, index) => resolveUnitCriteriaBasis(snapshot, history, target(snapshot, index)).basis);
    expect(before.every(basis => basis.criteriaVersionIds.length === 0)).toBe(true);
    const changed = adoptTaskCriteria(snapshot, history, { ...explicit(), content: 'Require a citation for speaker identity', scope: { kind: 'units', targets: [{ unitId: unit.unitId, sourceVersionId: unit.sourceVersionId }] }, origin: { kind: 'feedback', decisionId: decision.id } });
    expect(changed.criteriaVersions[0].origin).toMatchObject({ kind: 'feedback', decisionId: decision.id, noteSnapshot: decision.note });
    expect(isTaskCriteriaBasisCurrent(snapshot, changed, before[0])).toBe(false);
    expect(isTaskCriteriaBasisCurrent(snapshot, changed, before[1])).toBe(true);
    expect(isTaskCriteriaBasisCurrent(snapshot, changed, before[2])).toBe(true);
    expect(resolveUnitCriteriaBasis(snapshot, changed, { ...unit, purpose: 'translation' }).criteria).toEqual([]);
    expect(snapshot.policyRevision).toBe(2);
    expect(snapshot.decisions).toEqual([decision]);
    expect(history.criteriaVersions).toEqual([]);
  });

  it('keeps different criteria in the same scope, edits only an explicit criterion, and traces deactivation/reactivation', () => {
    const snapshot = fixture();
    let history = createTaskContextHistory(snapshot.taskId);
    const scope = { kind: 'task' as const, versions: 'future' as const };
    const first = { ...explicit(), content: 'Require citations', scope };
    const second = { ...explicit(), content: 'Keep dialogue concise', scope };
    history = adoptTaskCriteria(snapshot, history, first);
    history = adoptTaskCriteria(snapshot, history, second);
    const both = resolveUnitCriteriaBasis(snapshot, history, target(snapshot));
    expect(both.criteria.map(criterion => criterion.content)).toEqual(['Require citations', 'Keep dialogue concise']);
    expect(() => adoptTaskCriteria(snapshot, history, { ...first, id: randomUUID() })).toThrow('explicit previous');
    const edited = { ...first, id: randomUUID(), supersedesId: first.id, content: 'Require two independent citations' };
    history = adoptTaskCriteria(snapshot, history, edited);
    expect(history.criteriaVersions.map(version => version.content)).toEqual(['Require citations', 'Keep dialogue concise', 'Require two independent citations']);
    expect(resolveUnitCriteriaBasis(snapshot, history, target(snapshot)).criteria.map(version => version.id)).toEqual([edited.id, second.id]);
    history = setTaskCriterionActive(history, { id: randomUUID(), versionId: second.id, active: false, createdAt: 4 });
    expect(isTaskCriteriaBasisCurrent(snapshot, history, both.basis)).toBe(false);
    expect(resolveUnitCriteriaBasis(snapshot, history, target(snapshot)).criteria.map(version => version.id)).toEqual([edited.id]);
    history = setTaskCriterionActive(history, { id: randomUUID(), versionId: second.id, active: true, createdAt: 5 });
    expect(resolveUnitCriteriaBasis(snapshot, history, target(snapshot)).criteria).toHaveLength(2);
    expect(history.criteriaActions.map(action => action.kind)).toEqual(['adopt', 'adopt', 'adopt', 'deactivate', 'reactivate']);
    expect(() => adoptTaskCriteria(snapshot, history, { ...explicit(), supersedesId: edited.id, scope })).toThrow('retain its identity');
  });

  it('applies source rules across versions only when explicitly accepted and never migrates exact-unit rules', () => {
    const snapshot = fixture();
    let history = createTaskContextHistory(snapshot.taskId);
    const entryIds = [snapshot.sources[0].entryId];
    const currentRule = { ...explicit(), scope: { kind: 'sources' as const, entryIds, versions: 'current' as const } };
    const futureRule = { ...explicit(), scope: { kind: 'sources' as const, entryIds, versions: 'future' as const } };
    const localRule = { ...explicit(), scope: { kind: 'units' as const, targets: [{ unitId: snapshot.units[0].id, sourceVersionId: snapshot.units[0].sourceVersionId }] } };
    history = adoptTaskCriteria(snapshot, history, currentRule);
    history = adoptTaskCriteria(snapshot, history, futureRule);
    history = adoptTaskCriteria(snapshot, history, localRule);
    const changed = structuredClone(snapshot);
    const sourceId = randomUUID();
    const newUnit = { ...changed.units[0], id: randomUUID(), sourceVersionId: sourceId, text: 'new version' };
    const original = changed.sources[0];
    if (!isTextTaskSource(original)) throw new Error('Expected fixture text source');
    changed.sources.push({ ...original, id: sourceId, text: newUnit.text });
    changed.units.push(newUnit);
    changed.sourceFiles[0].currentVersionId = sourceId;
    const resolved = resolveUnitCriteriaBasis(changed, history, { unitId: newUnit.id, sourceVersionId: sourceId, purpose: 'review' });
    expect(resolved.criteria.map(version => version.id)).toEqual([futureRule.id]);
    expect(history.criteriaVersions[0].acceptedSourceVersionIds).toEqual([snapshot.sources[0].id]);
    expect(isTaskCriteriaBasisCurrent(changed, history, resolveUnitCriteriaBasis(snapshot, history, target(snapshot)).basis)).toBe(false);
  });
});
