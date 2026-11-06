import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { isTextTaskSource, isTextTaskUnit, type TaskReviewSnapshot, type TaskTextReviewUnit, type TaskUnitTarget } from '../shared/task-review';
import {
  adoptTaskContext,
  adoptTaskCriteria,
  createTaskContextHistory,
  proposeTaskContext,
  type TaskEvidenceRef,
} from '../shared/task-review-context';
import {
  analyzeTaskReviewBatch,
  currentTaskPlanningContext,
  assertTaskReviewBatchCurrent,
  prepareTaskReviewBatches,
  validateTaskReviewBatchResponse,
  type PreparedTaskReviewBatch,
  type TaskBatchModelResponse,
} from './task-review-context-model';

function fixture(sources = [['林岚：我从未离开过月港。'], ['林岚：我童年在地球海边长大。']]) {
  const taskId = randomUUID();
  const snapshot: TaskReviewSnapshot = { root: '/synthetic-task', taskId, revision: 1, policyRevision: 0, goal: '审阅虚构剧本中的角色背景、关系和场景连续性；发现矛盾时关联来源，不编造解释。', sources: [], sourceFiles: [], units: [], decisions: [], decisionActions: [], drafts: [], issues: [], planRevisions: [], history: [], artifacts: [] };
  for (const [index, lines] of sources.entries()) {
    const sourceVersionId = randomUUID(); const entryId = randomUUID(); const text = lines.join('\n');
    snapshot.sources.push({ id: sourceVersionId, entryId, relativePath: `source-${index}.txt`, hash: createHash('sha256').update(text).digest('hex'), format: 'txt', text, createdAt: 0 });
    snapshot.sourceFiles.push({ entryId, relativePath: `source-${index}.txt`, size: Buffer.byteLength(text), mtimeMs: 0, currentVersionId: sourceVersionId, status: 'available' });
    snapshot.units.push(...lines.map((text, ordinal) => ({ id: randomUUID(), sourceVersionId, ordinal: ordinal + 1, text, startLine: ordinal + 1, endLine: ordinal + 1 })));
  }
  return { snapshot: { ...snapshot, sources: snapshot.sources.filter(isTextTaskSource), units: snapshot.units.filter(isTextTaskUnit) }, history: createTaskContextHistory(taskId), allowed: snapshot.sources.map((source) => source.id) };
}
function target(unit: TaskTextReviewUnit): TaskUnitTarget { return { unitId: unit.id, sourceVersionId: unit.sourceVersionId }; }
function quote(unit: TaskTextReviewUnit, text = unit.text): TaskEvidenceRef {
  const start = unit.text.indexOf(text);
  return { ...target(unit), start, end: start + text.length, text };
}
function clean(batch: PreparedTaskReviewBatch): TaskBatchModelResponse {
  return { understanding: { groundedClaims: [], hypotheses: [], openQuestions: [] }, coverage: batch.targets.map((item) => ({ ...item, status: 'analyzed', reason: '已检查当前明确口径' })), issues: [], scenes: [] };
}
function scene(batch: PreparedTaskReviewBatch, kind: 'compare' | 'lowRiskGroup', sourceRefs: TaskEvidenceRef[] = []) {
  return { id: 'scene-1', kind, targets: batch.targets, purpose: batch.provenance.purpose, decisionMode: 'per-unit' as const, checkIntent: '角色连续性', reason: '逐条人工核对，保留人工决定', issueIds: [], criteriaRefs: [], sourceRefs };
}

describe('bounded task understanding batches', () => {
  it('propagates unquoted model context inputs and excludes incomplete legacy agent provenance without dropping human instructions', () => {
    const f = fixture([['A_ALLOWED'], ['PRIVATE_B_SENTINEL']]); const first = f.snapshot.units[0];
    let history = proposeTaskContext(f.snapshot, f.history, { id: randomUUID(), taskId: f.snapshot.taskId, content: { groundedClaims: [], hypotheses: ['人工明确的任务说明'] }, sourceRefs: [], openQuestions: [], proposedBy: 'human', createdAt: 1 }, f.allowed);
    const humanId = history.proposals[0].id;
    history = proposeTaskContext(f.snapshot, history, { id: randomUUID(), taskId: f.snapshot.taskId, content: { groundedClaims: [], hypotheses: ['PRIVATE_B_SENTINEL'] }, sourceRefs: [], openQuestions: [], proposedBy: 'agent', createdAt: 2 }, f.allowed);
    const legacyId = history.proposals.at(-1)!.id;
    history = proposeTaskContext(f.snapshot, history, { id: randomUUID(), taskId: f.snapshot.taskId, content: { groundedClaims: [], hypotheses: ['PRIVATE_B_SENTINEL'] }, sourceRefs: [], openQuestions: [], proposedBy: 'agent', inputSourceVersionIds: f.allowed, createdAt: 3 }, f.allowed);
    const derivedId = history.proposals.at(-1)!.id;
    const planning = currentTaskPlanningContext(f.snapshot, history, f.allowed);
    const batch = prepareTaskReviewBatches({ ...f, ...planning, purpose: 'review', authorizedSourceVersionIds: f.allowed, targets: [target(first)] }).batches[0];
    expect(batch.providedRanges.map(ref => ref.sourceVersionId)).toEqual([first.sourceVersionId]);
    expect(batch.provenance.sourceVersionIds.sort()).toEqual([...f.allowed].sort());
    expect(planning.unavailableContextProposalIds).toContain(legacyId);
    const narrowed = currentTaskPlanningContext(f.snapshot, history, [first.sourceVersionId]);
    expect(narrowed.history.proposals.map(proposal => proposal.id)).toEqual([humanId]);
    expect(narrowed.unavailableContextProposalIds).toEqual([legacyId, derivedId]);
    const request = prepareTaskReviewBatches({ ...f, ...narrowed, purpose: 'review', authorizedSourceVersionIds: [first.sourceVersionId], targets: [target(first)] }).batches[0];
    expect(request.input).not.toContain('PRIVATE_B_SENTINEL');
    expect(request.input).toContain('人工明确的任务说明');
  });

  it('analyzes a cross-source contradiction in one request with scoped criteria, attributed context and two exact quotes', async () => {
    const f = fixture(); const [first, second] = f.snapshot.units;
    let history = adoptTaskCriteria(f.snapshot, f.history, { id: randomUUID(), criterionId: randomUUID(), content: '两个来源描述的是同一角色和同一时间线，不能无证据改设定。', scope: { kind: 'task', versions: 'current' }, purpose: 'review', origin: { kind: 'explicit', text: '用户明确采用此任务标准' }, createdAt: 1 });
    const proposalId = randomUUID();
    history = proposeTaskContext(f.snapshot, history, { id: proposalId, taskId: f.snapshot.taskId, content: { groundedClaims: ['来源一中角色说自己从未离开月港。'], hypotheses: ['两句可能描述同一角色背景，需要合并核对。'] }, sourceRefs: [quote(first)], openQuestions: ['是否存在未说明的时间线？'], proposedBy: 'agent', inputSourceVersionIds: f.allowed, createdAt: 2 }, f.allowed);
    const prepared = prepareTaskReviewBatches({ ...f, history, authorizedSourceVersionIds: f.allowed, purpose: 'review', targets: [target(second)], relatedTargets: [target(first)] });
    expect(prepared.batches).toHaveLength(1);
    const batch = prepared.batches[0]; const refs = [quote(first), quote(second)];
    const response = clean(batch);
    response.understanding.groundedClaims = [{ content: '两个来源分别给出了从未离港和童年在地球的自述。', sourceRefs: refs }];
    response.understanding.hypotheses = [{ content: '背景可能矛盾；尚未确认角色是否说谎。', targets: [target(first), target(second)], sourceRefs: refs }];
    response.understanding.openQuestions = [{ question: '请确认是否有双重身份或不可靠叙述。', targets: [target(first), target(second)] }];
    response.issues = [{ id: 'contradiction-1', targets: [target(first), target(second)], severity: 'high', title: '两处角色背景可能矛盾', hypothesis: '在明确同一时间线前提下需要核对', sourceRefs: refs, criteriaRefs: [history.criteriaVersions[0].id], options: [{ label: '补查角色设定', reason: '先确认背景，再由人决定是否返工' }] }];
    response.scenes = [{ ...scene(batch, 'compare', refs), targets: [target(first), target(second)], issueIds: ['contradiction-1'], criteriaRefs: [history.criteriaVersions[0].id] }];
    const callModel = vi.fn(async (request) => {
      const body = JSON.parse(request.input);
      expect(body.units.map((unit: { unitId: string }) => unit.unitId).sort()).toEqual([first.id, second.id].sort());
      expect(body.units.find((unit: { unitId: string }) => unit.unitId === first.id).role).toBe('context');
      expect(body.taskContext.proposedBy).toBe('agent');
      expect(body.taskContext.adoptionId).toBeUndefined();
      expect(body.criteria[0].content).toContain('同一角色');
      expect(request.system).toContain('untrusted data');
      return JSON.stringify(response);
    });
    const result = await analyzeTaskReviewBatch({ snapshot: f.snapshot, history, batch, authorizedSourceVersionIds: f.allowed, connection: { endpoint: 'https://synthetic-provider.example', model: 'synthetic-test', apiKey: 'not-a-real-key', signal: new AbortController().signal }, callModel });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(result.issues[0].sourceRefs).toEqual(refs);
    expect(result.scenes[0].kind).toBe('compare');
    expect(result.coverage.map((item) => item.unitId)).toEqual([second.id]);
    expect(result.provenance.context).toEqual({ proposalId, proposedBy: 'agent' });
    expect(result.provenance.sourceVersionIds.sort()).toEqual(f.allowed.sort());
    expect(result.provenance).not.toHaveProperty('apiKey');
  });

  it('preserves accepted context separately from a newer AI working interpretation', () => {
    const f = fixture(); const [first, second] = f.snapshot.units;
    let history = proposeTaskContext(f.snapshot, f.history, { id: randomUUID(), taskId: f.snapshot.taskId, content: { groundedClaims: ['角色自述从未离开月港'], hypotheses: [] }, sourceRefs: [quote(first)], openQuestions: [], proposedBy: 'human', createdAt: 1 }, f.allowed);
    history = adoptTaskContext(f.snapshot, history, { id: randomUUID(), proposalId: history.proposals[0].id, createdAt: 2 }, f.allowed);
    history = proposeTaskContext(f.snapshot, history, { id: randomUUID(), taskId: f.snapshot.taskId, content: { groundedClaims: ['另一来源出现童年在地球的自述'], hypotheses: ['可能是不可靠叙述，但需要人核对'] }, sourceRefs: [quote(second)], openQuestions: ['两句是否由同一人说出？'], proposedBy: 'agent', inputSourceVersionIds: f.allowed, createdAt: 3 }, f.allowed);
    const batch = prepareTaskReviewBatches({ ...f, history, purpose: 'review', authorizedSourceVersionIds: f.allowed }).batches[0];
    const body = JSON.parse(batch.input);
    expect(body.taskContext.proposedBy).toBe('agent');
    expect(body.adoptedContext.id).toBe(history.proposals[0].id);
    expect(batch.provenance.adoptedContext?.adoptionId).toBe(history.adoptions[0].id);
  });

  it('bounds long tasks and reports deferred targets rather than claiming complete coverage', () => {
    const f = fixture([Array.from({ length: 140 }, (_, index) => `第${index + 1}句`)]);
    const prepared = prepareTaskReviewBatches({ ...f, purpose: 'review', authorizedSourceVersionIds: f.allowed });
    expect(prepared.requestedTargets).toHaveLength(140);
    expect(prepared.batches).toHaveLength(16);
    expect(prepared.batches.flatMap((batch) => batch.targets)).toHaveLength(128);
    expect(prepared.deferred).toHaveLength(12);
    expect(prepared.deferred.every((item) => item.reason === 'batch-budget')).toBe(true);
    expect(prepared.batches.every((batch) => batch.input.length <= 48000 && batch.targets.length <= 8)).toBe(true);
    expect(prepared.batches.at(-1)!.input).not.toContain('第140句');
    const oversized = fixture([['x'.repeat(50000), '仍可人工审阅的普通条目']]);
    const bounded = prepareTaskReviewBatches({ ...oversized, purpose: 'review', authorizedSourceVersionIds: oversized.allowed });
    expect(bounded.deferred.map((item) => item.reason)).toEqual(['input-budget']);
    expect(bounded.batches[0].targets.map((item) => item.unitId)).toEqual([oversized.snapshot.units[1].id]);
    expect(bounded.batches[0].omittedContextTargets).toContainEqual(target(oversized.snapshot.units[0]));
  });

  it('does not send unauthorized or stale context, even when only the target itself is authorized', () => {
    const f = fixture(); const first = f.snapshot.units[0]; const second = f.snapshot.units[1];
    expect(() => prepareTaskReviewBatches({ ...f, purpose: 'review', authorizedSourceVersionIds: [first.sourceVersionId], targets: [target(first)], relatedTargets: [target(second)] })).toThrow('authorized');
    const history = proposeTaskContext(f.snapshot, f.history, { id: randomUUID(), taskId: f.snapshot.taskId, content: { groundedClaims: ['另一来源有相关背景'], hypotheses: [] }, sourceRefs: [quote(second)], openQuestions: [], proposedBy: 'agent', inputSourceVersionIds: f.allowed, createdAt: 1 }, f.allowed);
    expect(() => prepareTaskReviewBatches({ ...f, history, purpose: 'review', authorizedSourceVersionIds: [first.sourceVersionId], targets: [target(first)] })).toThrow('authorized');
    const batch = prepareTaskReviewBatches({ ...f, purpose: 'review', authorizedSourceVersionIds: f.allowed }).batches[0];
    const stale = structuredClone(f.snapshot); stale.sourceFiles[1].status = 'missing';
    expect(() => assertTaskReviewBatchCurrent(stale, f.history, batch, f.allowed)).toThrow('changed');
  });

  it('invalidates affected criteria/context while preserving a batch after an unrelated local adoption', () => {
    const f = fixture([['A来源'], ['B来源']]); const [first, second] = f.snapshot.units;
    const batch = prepareTaskReviewBatches({ ...f, purpose: 'review', authorizedSourceVersionIds: f.allowed, targets: [target(first)] }).batches[0];
    let history = adoptTaskCriteria(f.snapshot, f.history, { id: randomUUID(), criterionId: randomUUID(), content: '只检查B的口吻', scope: { kind: 'units', targets: [target(second)] }, purpose: 'review', origin: { kind: 'explicit', text: '人明确采用局部标准' }, createdAt: 1 });
    expect(() => assertTaskReviewBatchCurrent(f.snapshot, history, batch, f.allowed)).not.toThrow();
    history = adoptTaskCriteria(f.snapshot, history, { id: randomUUID(), criterionId: randomUUID(), content: '只检查A的角色身份', scope: { kind: 'units', targets: [target(first)] }, purpose: 'review', origin: { kind: 'explicit', text: '人明确采用局部标准' }, createdAt: 2 });
    expect(() => assertTaskReviewBatchCurrent(f.snapshot, history, batch, f.allowed)).toThrow('criteria changed');
    const next = proposeTaskContext(f.snapshot, f.history, { id: randomUUID(), taskId: f.snapshot.taskId, content: { groundedClaims: [], hypotheses: ['存在更多场景上下文'] }, sourceRefs: [], openQuestions: ['是否还有前场？'], proposedBy: 'agent', inputSourceVersionIds: f.allowed, createdAt: 3 }, f.allowed);
    expect(() => assertTaskReviewBatchCurrent(f.snapshot, next, batch, f.allowed)).toThrow('working context changed');
  });
});

describe('external batch response validation', () => {
  it.each([{ file: 'character', issueCount: 2, refCount: 10, kind: 'compare' }, { file: 'goal-context', issueCount: 1, refCount: 7, kind: 'single' }, { file: 'extra-metadata', issueCount: 1, refCount: 7, kind: 'single' }])('replays the captured real DeepSeek $file batch offline with authoritative targets and exact server-located quotes', ({ file, issueCount, refCount, kind }) => {
    const captured = JSON.parse(readFileSync(new URL(`./__fixtures__/task-review-deepseek-${file}-response.json`, import.meta.url), 'utf8'));
    const f = fixture(captured.preparedInput.units.map((unit: { text: string }) => [unit.text]));
    f.snapshot.taskId = captured.preparedInput.taskId; f.snapshot.goal = captured.preparedInput.goal;
    const history = createTaskContextHistory(f.snapshot.taskId);
    for (const [index, unit] of captured.preparedInput.units.entries()) {
      f.snapshot.sources[index].id = unit.sourceVersionId;
      f.snapshot.sourceFiles[index].currentVersionId = unit.sourceVersionId;
      f.snapshot.units[index].id = unit.unitId; f.snapshot.units[index].sourceVersionId = unit.sourceVersionId;
    }
    const allowed = f.snapshot.sources.map(source => source.id);
    const batch = prepareTaskReviewBatches({ snapshot: f.snapshot, history, authorizedSourceVersionIds: allowed, purpose: 'review' }).batches[0];
    expect(JSON.parse(batch.input)).toEqual(captured.preparedInput);
    const result = validateTaskReviewBatchResponse(f.snapshot, history, batch, JSON.stringify(captured.response), allowed);
    expect(result.issues).toHaveLength(issueCount); expect(result.scenes[0].kind).toBe(kind);
    expect(result.understanding.hypotheses[0].targets[0]).toEqual(batch.targets[1]);
    const refs = [...result.understanding.groundedClaims.flatMap(claim => claim.sourceRefs), ...result.understanding.hypotheses.flatMap(hypothesis => hypothesis.sourceRefs), ...result.issues.flatMap(issue => issue.sourceRefs), ...result.scenes.flatMap(scene => scene.sourceRefs)];
    expect(refs).toHaveLength(refCount);
    expect(refs.every(ref => f.snapshot.units.find(unit => unit.id === ref.unitId)!.text.slice(ref.start, ref.end) === ref.text)).toBe(true);
    expect(result.understanding.groundedClaims[0].sourceRefs[0]).toMatchObject({ start: 3, end: 14, text: '这是我第一次亲眼看见海' });
    if (file === 'character') expect(captured.response.understanding.groundedClaims[0].sourceRefs[0].end).toBe(22);
    else if (file === 'goal-context') {
      const interpretation = captured.response.understanding.groundedClaims[0].content;
      expect(result.understanding.groundedClaims).toHaveLength(2);
      expect(result.understanding.groundedClaims.some(claim => claim.content === interpretation)).toBe(false);
      expect(result.understanding.hypotheses).toContainEqual({ content: interpretation, targets: [], sourceRefs: [] });
      expect(result.understanding.openQuestions.map(item => item.question)).toEqual(captured.response.understanding.openQuestions.map((item: { question: string }) => item.question));
    }
    expect(result).not.toHaveProperty('openQuestions');
    expect(result.understanding.openQuestions.map(item => item.question)).toEqual(captured.response.understanding.openQuestions.map((item: { question: string }) => item.question));
  });

  it('still rejects issues without material evidence when an unreferenced task interpretation is allowed', () => {
    const f = fixture(); const batch = prepareTaskReviewBatches({ ...f, purpose: 'review', authorizedSourceVersionIds: f.allowed }).batches[0];
    const response = clean(batch);
    response.understanding.groundedClaims = [{ content: 'AI对用户目标的理解，不是材料事实', sourceRefs: [] }];
    response.issues = [{ id: 'unsupported', targets: [batch.targets[0]], severity: 'high', title: '无证据问题', hypothesis: '不能用任务理解冒充原文引用', sourceRefs: [], criteriaRefs: [], options: [] }];
    expect(() => validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(response), f.allowed)).toThrow('SCHEMA_INVALID] at issues.0.sourceRefs');
  });

  it('projects harmless wire metadata at every model object boundary without copying it into canonical output', () => {
    const f = fixture(); const batch = prepareTaskReviewBatches({ ...f, purpose: 'review', authorizedSourceVersionIds: f.allowed }).batches[0];
    const base = clean(batch); const ref = quote(f.snapshot.units[0]);
    base.understanding.groundedClaims = [{ content: '材料中的陈述', sourceRefs: [ref] }];
    base.scenes = [{ id: 'read-only', kind: 'single', targets: [batch.targets[0]], purpose: 'review', decisionMode: 'per-unit', checkIntent: '人工核对', reason: '模型只提供建议', issueIds: [], criteriaRefs: [], sourceRefs: [ref] }];
    const wire = { ...base, openQuestions: [], trace: { provider: 'synthetic' }, understanding: { ...base.understanding, confidence: 0.8, groundedClaims: [{ ...base.understanding.groundedClaims[0], confidence: 0.7, sourceRefs: [{ ...ref, confidence: 0.9 }] }] }, scenes: [{ ...base.scenes[0], displayHint: 'two columns', targets: [{ ...batch.targets[0], confidence: 1 }] }] };
    expect(validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(wire), f.allowed)).toEqual(base);
    const control = { ...wire, scenes: [{ ...wire.scenes[0], manual: true }] };
    expect(() => validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(control), f.allowed)).toThrow('CONTROL_FIELD_NOT_ALLOWED] at scenes.0.manual');
  });

  it.each(['missing', 'wrong-type', 'wrong-enum'])('rejects %s required coverage despite harmless extra metadata', kind => {
    const f = fixture(); const batch = prepareTaskReviewBatches({ ...f, purpose: 'review', authorizedSourceVersionIds: f.allowed }).batches[0];
    const base = clean(batch);
    const coverage = kind === 'missing' ? undefined : kind === 'wrong-type' ? 'all' : base.coverage.map(entry => ({ ...entry, status: 'approved' }));
    expect(() => validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify({ ...base, coverage, debugInfo: 'not a required field' }), f.allowed)).toThrow('SCHEMA_INVALID] at coverage');
  });

  it('rejects ambiguous unlocated quotes but accepts an exact explicit occurrence', () => {
    const f = fixture([['🙂海边再见海边']]); const unit = f.snapshot.units[0];
    const batch = prepareTaskReviewBatches({ ...f, purpose: 'review', authorizedSourceVersionIds: f.allowed }).batches[0];
    const response = { ...clean(batch), understanding: { groundedClaims: [{ content: '重复词', sourceRefs: [{ unitId: unit.id, text: '海边' }] }], hypotheses: [], openQuestions: [] } };
    expect(() => validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(response), f.allowed)).toThrow('EVIDENCE_AMBIGUOUS');
    const start = unit.text.lastIndexOf('海边');
    const explicit = { ...response, understanding: { ...response.understanding, groundedClaims: [{ content: '第二次出现', sourceRefs: [{ unitId: unit.id, text: '海边', start, end: start + 2 }] }] } };
    expect(validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(explicit), f.allowed).understanding.groundedClaims[0].sourceRefs[0].start).toBe(start);
    explicit.understanding.groundedClaims[0].sourceRefs[0].start = 0;
    expect(() => validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(explicit), f.allowed)).toThrow('EVIDENCE_AMBIGUOUS');
  });

  it('rejects unknown targets and explicit wrong versions with safe code and schema path', () => {
    const f = fixture(); const batch = prepareTaskReviewBatches({ ...f, purpose: 'review', authorizedSourceVersionIds: f.allowed }).batches[0];
    const unknown = randomUUID();
    const response = { ...clean(batch), understanding: { groundedClaims: [], hypotheses: [{ content: 'PRIVATE_MODEL_TEXT', targets: [unknown], sourceRefs: [] }], openQuestions: [] } };
    expect(() => validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(response), f.allowed)).toThrow('TARGET_NOT_SUPPLIED] at understanding.hypotheses.0.targets.0');
    const wrongVersion = { ...response, understanding: { ...response.understanding, hypotheses: [{ ...response.understanding.hypotheses[0], targets: [{ unitId: batch.targets[0].unitId, sourceVersionId: randomUUID() }] }] } };
    expect(() => validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(wrongVersion), f.allowed)).toThrow('SOURCE_VERSION_MISMATCH');
    try { validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(response), f.allowed); }
    catch (error) { expect(String(error)).not.toContain('PRIVATE_MODEL_TEXT'); expect(String(error)).not.toContain(unknown); }
  });

  it('normalizes unique exact quotes to UTF-16 offsets and rejects fabricated text', () => {
    const f = fixture([['🙂林岚：我没有离开月港。']]);
    const batch = prepareTaskReviewBatches({ ...f, purpose: 'review', authorizedSourceVersionIds: f.allowed }).batches[0];
    const response = clean(batch);
    response.understanding.groundedClaims = [{ content: '角色作出离港经历的自述', sourceRefs: [quote(f.snapshot.units[0], '林岚')] }];
    expect(response.understanding.groundedClaims[0].sourceRefs[0].start).toBe(2);
    expect(validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(response), f.allowed).understanding.groundedClaims).toHaveLength(1);
    response.understanding.groundedClaims[0].sourceRefs[0].start = 1;
    expect(validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(response), f.allowed).understanding.groundedClaims[0].sourceRefs[0].start).toBe(2);
    response.understanding.groundedClaims[0].sourceRefs[0].text = '没有发送的引文';
    expect(() => validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(response), f.allowed)).toThrow('EVIDENCE_NOT_SUPPLIED');
  });

  it('rejects valid source text outside the exact context ranges supplied to the model', () => {
    const f = fixture([['月港有许多从未提及的背景细节。'], ['本批只检查第二来源']]); const first = f.snapshot.units[0];
    const history = proposeTaskContext(f.snapshot, f.history, { id: randomUUID(), taskId: f.snapshot.taskId, content: { groundedClaims: ['月港被提及'], hypotheses: [] }, sourceRefs: [quote(first, '月港')], openQuestions: [], proposedBy: 'agent', inputSourceVersionIds: f.allowed, createdAt: 1 }, f.allowed);
    const batch = prepareTaskReviewBatches({ ...f, history, purpose: 'review', authorizedSourceVersionIds: f.allowed, targets: [target(f.snapshot.units[1])] }).batches[0];
    const response = clean(batch);
    response.understanding.groundedClaims = [{ content: '引用了未提供的细节', sourceRefs: [quote(first)] }];
    expect(() => validateTaskReviewBatchResponse(f.snapshot, history, batch, JSON.stringify(response), f.allowed)).toThrow('EVIDENCE_NOT_SUPPLIED');
  });

  it('requires explicit coverage and never puts unknown or flagged units into a low-risk group', () => {
    const f = fixture(); const batch = prepareTaskReviewBatches({ ...f, purpose: 'review', authorizedSourceVersionIds: f.allowed }).batches[0];
    const response = clean(batch);
    response.scenes = [scene(batch, 'lowRiskGroup')];
    expect(validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(response), f.allowed).scenes[0].kind).toBe('lowRiskGroup');
    response.coverage[1].status = 'unknown';
    expect(() => validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(response), f.allowed)).toThrow('low-risk');
    response.coverage[1].status = 'analyzed';
    response.issues = [{ id: 'risk', targets: [target(f.snapshot.units[0])], severity: 'low', title: '待核对', hypothesis: '可能缺少上下文', sourceRefs: [quote(f.snapshot.units[0])], criteriaRefs: [], options: [] }];
    expect(() => validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(response), f.allowed)).toThrow('low-risk');
    response.issues = []; response.coverage.pop();
    expect(() => validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(response), f.allowed)).toThrow('coverage');
  });

  it.each(['humanDecisions', 'fileActions', 'toolCalls', 'decisions', 'permissions'])('rejects forbidden %s rather than executing or silently dropping it', (field) => {
    const f = fixture(); const batch = prepareTaskReviewBatches({ ...f, purpose: 'review', authorizedSourceVersionIds: f.allowed }).batches[0];
    expect(() => validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify({ ...clean(batch), [field]: [] }), f.allowed)).toThrow('CONTROL_FIELD_NOT_ALLOWED');
  });

  it('keeps comparison purpose in the existing namespace and requires evidence from each compared unit', () => {
    const f = fixture(); const batch = prepareTaskReviewBatches({ ...f, purpose: 'review', authorizedSourceVersionIds: f.allowed }).batches[0];
    const response = clean(batch); const refs = f.snapshot.units.map((unit) => quote(unit));
    response.scenes = [{ ...scene(batch, 'compare', refs), purpose: 'new-character-decision-purpose' }];
    expect(() => validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(response), f.allowed)).toThrow('purpose');
    response.scenes[0].purpose = 'review'; response.scenes[0].sourceRefs = [refs[0], refs[0]];
    expect(() => validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(response), f.allowed)).toThrow('every compared unit');
    response.scenes[0].sourceRefs = refs; response.scenes[0].criteriaRefs = [randomUUID()];
    expect(() => validateTaskReviewBatchResponse(f.snapshot, f.history, batch, JSON.stringify(response), f.allowed)).toThrow('criteria');
  });

  it('does not return a result after cancellation even if the injected transport returns late', async () => {
    const f = fixture(); const batch = prepareTaskReviewBatches({ ...f, purpose: 'review', authorizedSourceVersionIds: f.allowed }).batches[0];
    const controller = new AbortController();
    const callModel = vi.fn(async () => { controller.abort(); return JSON.stringify(clean(batch)); });
    await expect(analyzeTaskReviewBatch({ snapshot: f.snapshot, history: f.history, batch, authorizedSourceVersionIds: f.allowed, connection: { endpoint: 'https://synthetic-provider.example', model: 'synthetic', apiKey: 'not-a-real-key', signal: controller.signal }, callModel })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
