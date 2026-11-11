import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTextTaskSource, isTextTaskUnit } from '../shared/task-review';
import type { TaskAgentTarget, TaskCompletionEvent, TaskSearchScope } from '../shared/task-review-runtime-types';
import type { TaskBatchModelResponse } from './task-review-context-model';
import { TaskReviewStore } from './task-review-store';
import { TaskReviewModelConfigStore } from './task-review-model-config';
import { TaskReviewRuntime } from './task-review-runtime';
import { TaskModelError, type TaskModelRequest } from './task-review-provider';

type Model = (request: TaskModelRequest) => Promise<string>;
const roots: string[] = [];
const runtimes: TaskReviewRuntime[] = [];
const releaseFixtureGates: Array<() => void> = [];
const encryption = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text), decryptString: (buffer: Buffer) => buffer.toString() };
function gate() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
function response(request: TaskModelRequest): TaskBatchModelResponse {
  const body = JSON.parse(request.input);
  const first = body.units.find((unit: { role: string }) => unit.role === 'target');
  return { understanding: { groundedClaims: [{ content: `合成观察：${first.text}`, sourceRefs: [{ unitId: first.unitId, sourceVersionId: first.sourceVersionId, start: 0, end: first.text.length, text: first.text }] }], hypotheses: [], openQuestions: [] }, coverage: body.coverage.targets.map((target: object) => ({ ...target, status: 'analyzed', reason: '合成模型检查了当前口径' })), issues: [], scenes: [] };
}
const clean: Model = async (request) => JSON.stringify(response(request));
async function taskFixture(text: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-runtime-')); roots.push(root);
  const store = new TaskReviewStore(); let snapshot = await store.open(root);
  snapshot = await store.importText({ root, taskId: snapshot.taskId, expectedRevision: snapshot.revision, name: 'text.txt', text, format: 'txt' });
  return { root, store, snapshot: { ...snapshot, sources: snapshot.sources.filter(isTextTaskSource), units: snapshot.units.filter(isTextTaskUnit) }, target: { root, taskId: snapshot.taskId } };
}
async function fixture(text = '第一句\n第二句', model: Model = clean) {
  const task = await taskFixture(text);
  // Match production ownership: profile credentials/grants are not task files.
  // Keeping their atomic temporary file in a scanned task root can create a false
  // ENOENT race while another task is being authorized.
  const profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-runtime-profile-')); roots.push(profileRoot);
  const models = new TaskReviewModelConfigStore(path.join(profileRoot, 'models.json'), encryption);
  await models.save({ endpoint: 'https://provider.example/v1', backgroundModel: 'review', completionModel: 'completion', apiKey: 'test-key' });
  const runtime = new TaskReviewRuntime(task.store, models, model); runtimes.push(runtime);
  return { ...task, models, runtime };
}
const authorize = (runtime: TaskReviewRuntime, target: TaskAgentTarget) => runtime.authorize({ ...target, scope: 'task', sourceVersionIds: [] });
async function settled(runtime: TaskReviewRuntime, target: TaskAgentTarget, timeout = 5000) {
  await vi.waitFor(async () => {
    const state = await runtime.getState(target);
    expect(state.jobs.length).toBeGreaterThan(0);
    expect(state.jobs.some((job) => ['queued', 'running'].includes(job.status))).toBe(false);
  }, { timeout, interval: 50 });
  return runtime.getState(target);
}
afterEach(async () => {
  releaseFixtureGates.splice(0).forEach(release => release());
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(roots.splice(0).map(root => {
    const resolved = path.resolve(root);
    expect(path.dirname(resolved)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(resolved)).toMatch(/^(?:batch-runtime-|copied-task-)/);
    return fs.rm(resolved, { force: true, recursive: true });
  }));
});

describe('production multi-unit runtime', () => {
  it('awaits the interrupted checkpoint before releasing a disposed task directory', async () => {
    const started = gate(); const stopping = gate(); const release = gate();
    const f = await fixture('shutdown checkpoint', async request => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        request.signal.throwIfAborted();
        request.signal.addEventListener('abort', () => {
          stopping.resolve();
          void release.promise.then(() => reject(request.signal.reason));
        }, { once: true });
      });
      return '';
    });
    await authorize(f.runtime, f.target); await started.promise;
    const file = path.join(f.root, '.reelterminal', 'task-review-jobs.json');
    const previous = await fs.readFile(file, 'utf8');
    let stopped = false;
    const disposing = f.runtime.dispose().then(() => { stopped = true; });
    try {
      await stopping.promise;
      expect(stopped).toBe(false);
      expect(await fs.readFile(file, 'utf8')).toBe(previous);
      release.resolve(); await disposing;
      const stored = JSON.parse(await fs.readFile(file, 'utf8'));
      expect(stored.jobs).toHaveLength(1);
      expect(stored.jobs[0]).toMatchObject({ status: 'interrupted', attempts: 1 });
      expect((await fs.readdir(path.dirname(file))).filter(name => name.endsWith('.tmp'))).toEqual([]);
      // Awaited shutdown makes removal safe, rather than racing a late rename.
      const root = path.resolve(f.root);
      expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(root)).toMatch(/^batch-runtime-/);
      await fs.rm(root, { recursive: true, force: true });
      roots.splice(roots.indexOf(f.root), 1);
    } finally {
      release.resolve(); await disposing;
    }
  });

  it('analyzes only real text while media outside the cloud grant remains in the same manual scene plan', async () => {
    const model = vi.fn<Model>(async request => request.system.includes('Find semantic matches') ? JSON.stringify({ matches: [] }) : clean(request));
    const f = await fixture('first text\nsecond text', model);
    await fs.writeFile(path.join(f.root, 'synthetic-image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=', 'base64'));
    let snapshot = await f.store.refreshSources({ ...f.target, expectedRevision: f.snapshot.revision });
    const media = snapshot.units.find(unit => !isTextTaskUnit(unit))!;
    expect(media.kind).toBe('image'); expect(media).not.toHaveProperty('text');
    await f.runtime.authorize({ ...f.target, scope: 'sources', sourceVersionIds: [f.snapshot.sources[0].id] });
    const state = await settled(f.runtime, f.target);
    expect(state.jobs).toHaveLength(1); expect(state.jobs[0].unitIds.sort()).toEqual(f.snapshot.units.map(unit => unit.id).sort());
    expect(state.remainingUnitCount).toBe(0); expect(state.deferredUnitIds).toEqual([]);
    const batch = JSON.parse(model.mock.calls[0][0].input);
    expect(batch.units.map((unit: { unitId: string }) => unit.unitId).sort()).toEqual(f.snapshot.units.map(unit => unit.id).sort());
    expect(model.mock.calls[0][0].input).not.toContain(media.sourceVersionId);
    snapshot = await f.store.open(f.root);
    const scene = snapshot.planRevisions.at(-1)!.scenes!.find(scene => scene.targets.some(target => target.unitId === media.id))!;
    expect(scene).toMatchObject({ manual: true, kind: 'single', sourceRefs: [], issueIds: [], inputSourceVersionIds: [] });
    expect(scene.reason).toContain('需人工查看'); expect(scene.reason).not.toContain('等待');
    expect(scene.criteriaBasis[0].unitId).toBe(media.id);
    expect(snapshot.planRevisions.at(-1)!.steps.some(step => step.unitId === media.id)).toBe(true);
    const search = await f.runtime.search({ ...f.target, query: 'text' });
    expect(search).toMatchObject({ scopeUnitCount: 2, candidateUnitCount: 2, coverage: 'scope', truncated: false });
    expect(model.mock.calls.at(-1)![0].input).not.toContain(media.sourceVersionId);
    await f.runtime.onTaskChanged(f.target); await f.runtime.getState(f.target); expect(model).toHaveBeenCalledTimes(2);
  });

  it('keeps media-only scopes manual with zero text coverage, jobs or remote search/completion calls', async () => {
    const model = vi.fn<Model>(clean); const f = await fixture('removed text', model);
    await fs.unlink(path.join(f.root, f.snapshot.sources[0].relativePath));
    await fs.writeFile(path.join(f.root, 'only-image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=', 'base64'));
    const snapshot = await f.store.refreshSources({ ...f.target, expectedRevision: f.snapshot.revision });
    const media = snapshot.units.find(unit => !isTextTaskUnit(unit))!;
    const state = await authorize(f.runtime, f.target);
    expect(state).toMatchObject({ jobs: [], remainingUnitCount: 0, deferredUnitIds: [] });
    const target = { unitId: media.id, sourceVersionId: media.sourceVersionId };
    const scopes: TaskSearchScope[] = [{ kind: 'task' }, { kind: 'sources', sourceVersionIds: [media.sourceVersionId] }, { kind: 'units', targets: [target] }];
    for (const scope of scopes) {
      await expect(f.runtime.search({ ...f.target, query: 'image', scope })).rejects.toThrow('no searchable text units');
    }
    const events: TaskCompletionEvent[] = []; f.runtime.onCompletion(event => events.push(event));
    await f.runtime.complete({ ...f.target, ...target, generationId: 'media-feedback', text: 'Review image' });
    expect(events.at(-1)?.error).toBeDefined();
    await f.runtime.onTaskChanged(f.target); await f.runtime.continueAnalysis(f.target);
    expect((await f.runtime.getState(f.target)).jobs).toEqual([]); expect(model).not.toHaveBeenCalled();
    expect((await f.store.open(f.root)).planRevisions.at(-1)?.scenes?.[0].manual).toBe(true);
  });

  it('keeps one current manual plan after revocation and new media without model calls or repeated plan writes', async () => {
    const model = vi.fn<Model>(clean); const f = await fixture('manual text', model);
    await f.runtime.onTaskChanged(f.target);
    expect((await f.store.open(f.root)).planRevisions.at(-1)?.scenes?.[0]).toMatchObject({ manual: true, sourceRefs: [], issueIds: [], inputSourceVersionIds: [] });
    expect(model).not.toHaveBeenCalled();
    await authorize(f.runtime, f.target); await settled(f.runtime, f.target); await f.runtime.revoke(f.target);
    model.mockClear();
    await fs.writeFile(path.join(f.root, 'after-revoke.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=', 'base64'));
    await f.runtime.onTaskChanged(f.target);
    const snapshot = await f.store.open(f.root);
    const scenes = snapshot.planRevisions.at(-1)!.scenes!;
    expect(scenes).toHaveLength(2);
    expect(scenes.every(scene => scene.manual && scene.kind === 'single' && !scene.sourceRefs.length && !scene.issueIds.length && !scene.inputSourceVersionIds?.length)).toBe(true);
    expect(new Set(snapshot.planRevisions.at(-1)!.steps.map(step => step.unitId))).toEqual(new Set(snapshot.units.map(unit => unit.id)));
    await f.runtime.onTaskChanged(f.target); const state = await f.runtime.getState(f.target);
    expect((await f.store.open(f.root)).revision).toBe(snapshot.revision);
    expect(state.grant).toBeUndefined(); expect(state.jobs.flatMap(job => job.completedUnitIds)).toEqual([]);
    expect(model).not.toHaveBeenCalled();
  });

  it('requires a local grant, analyzes a multi-unit batch once and does not send without a credential', async () => {
    const model = vi.fn<Model>(clean); const f = await fixture(undefined, model);
    await expect(f.runtime.startPreflight(f.target)).rejects.toThrow('Authorize');
    await authorize(f.runtime, f.target); expect((await settled(f.runtime, f.target)).jobs[0].status).toBe('completed');
    expect(model).toHaveBeenCalledTimes(1); expect(JSON.parse(model.mock.calls[0][0].input).coverage.targets).toHaveLength(2);
    await f.runtime.startPreflight(f.target); await settled(f.runtime, f.target); expect(model).toHaveBeenCalledTimes(1);
    const snapshot = await f.store.open(f.root);
    expect(snapshot.contextHistory?.proposals.at(-1)?.proposedBy).toBe('agent'); expect(snapshot.contextHistory?.adoptions).toEqual([]);
    await f.models.save({ endpoint: 'https://provider.example/v1', backgroundModel: 'review', completionModel: 'completion', apiKey: '' });
    await f.store.setGoal({ ...f.target, expectedRevision: snapshot.revision, goal: '明确新全局标准' });
    await f.runtime.onTaskChanged(f.target); expect((await settled(f.runtime, f.target)).jobs.at(-1)?.status).toBe('failed'); expect(model).toHaveBeenCalledTimes(1);
  });

  it('atomically publishes cross-source evidence, comparison scenes and a derived single-unit index', async () => {
    const f = await fixture('角色从未离开月港', async (request) => {
      const body = JSON.parse(request.input); const result = response(request); const targets = body.coverage.targets;
      const sourceRefs = targets.map((target: { unitId: string }) => { const unit = body.units.find((unit: { unitId: string }) => unit.unitId === target.unitId); return { unitId: unit.unitId, sourceVersionId: unit.sourceVersionId, start: 0, end: unit.text.length, text: unit.text }; });
      result.issues = [{ id: 'cross', targets, severity: 'high', title: '两处背景可能冲突', hypothesis: '需人工对照设定', sourceRefs, criteriaRefs: [], options: [{ label: '对照设定', reason: '查证后逐项判断' }] }];
      result.scenes = [{ id: 'compare', kind: 'compare', targets, purpose: 'review', decisionMode: 'per-unit', checkIntent: '角色连续性', reason: '两处原文证据', issueIds: ['cross'], criteriaRefs: [], sourceRefs }];
      return JSON.stringify(result);
    });
    let snapshot = await f.store.open(f.root); await f.store.importText({ ...f.target, expectedRevision: snapshot.revision, name: 'other.txt', text: '角色童年在地球生活', format: 'txt' });
    await authorize(f.runtime, f.target); expect((await settled(f.runtime, f.target)).jobs[0].status).toBe('completed');
    snapshot = await f.store.open(f.root); const plan = snapshot.planRevisions.at(-1)!;
    expect(snapshot.issues).toHaveLength(2); expect(snapshot.issues.every((issue) => issue.sourceRefs?.length === 2 && issue.criteriaBasis?.length === 2)).toBe(true);
    expect(plan.scenes?.[0].kind).toBe('compare'); expect(plan.scenes?.[0].issueIds.sort()).toEqual(snapshot.issues.map((issue) => issue.id).sort());
    expect(plan.steps.map((step) => step.unitId)).toEqual(plan.scenes?.[0].targets.map((target) => target.unitId)); expect(snapshot.decisions).toEqual([]);
  });

  it('merges around draft/navigation writes and a publication CAS conflict without recalling the model', async () => {
    const started = gate(); const release = gate();
    const model = vi.fn<Model>(async (request) => { started.resolve(); await release.promise; return JSON.stringify(response(request)); });
    const f = await fixture(undefined, model); const publish = f.store.publishAnalysis.bind(f.store); let commits = 0;
    vi.spyOn(f.store, 'publishAnalysis').mockImplementation(async (input) => {
      if (!commits++) { const snapshot = await f.store.open(f.root); const unit = snapshot.units[0]; await f.store.saveDraft({ ...f.target, expectedRevision: snapshot.revision, draft: { unitId: unit.id, sourceVersionId: unit.sourceVersionId, text: '继续手写', selectionStart: 4, selectionEnd: 4 } }); }
      return publish(input);
    });
    await authorize(f.runtime, f.target); await started.promise; const snapshot = await f.store.open(f.root); const unit = snapshot.units[0];
    await f.store.visit({ ...f.target, expectedRevision: snapshot.revision, unitId: unit.id, sourceVersionId: unit.sourceVersionId, purpose: 'review' }); release.resolve();
    expect((await settled(f.runtime, f.target)).jobs[0].status).toBe('completed'); expect(model).toHaveBeenCalledTimes(1); expect(commits).toBe(2);
    const after = await f.store.open(f.root); expect(after.drafts[0].text).toBe('继续手写'); expect(after.history).toHaveLength(1);
  });

  it('does not recall the model for decide/undo/redo and rechecks only explicitly affected criterion targets', async () => {
    const model = vi.fn<Model>(clean); const f = await fixture(undefined, model); await authorize(f.runtime, f.target); await settled(f.runtime, f.target);
    let snapshot = await f.store.open(f.root); const unit = snapshot.units[0];
    snapshot = await f.store.decide({ ...f.target, expectedRevision: snapshot.revision, unitId: unit.id, sourceVersionId: unit.sourceVersionId, purpose: 'review', status: 'kept', note: '普通通过，不自动推广全局标准' });
    const decisionId = snapshot.decisions.at(-1)!.id; await f.runtime.onTaskChanged(f.target); snapshot = await f.store.open(f.root);
    expect(snapshot.planRevisions.at(-1)?.steps).toHaveLength(1);
    const historyTarget = { ...f.target, unitId: unit.id, sourceVersionId: unit.sourceVersionId, purpose: 'review', policyRevision: snapshot.policyRevision, decisionId };
    await f.store.undoDecision({ ...historyTarget, expectedRevision: snapshot.revision }); await f.runtime.onTaskChanged(f.target); snapshot = await f.store.open(f.root);
    expect(snapshot.planRevisions.at(-1)?.steps).toHaveLength(2);
    await f.store.redoDecision({ ...historyTarget, expectedRevision: snapshot.revision }); await f.runtime.onTaskChanged(f.target); snapshot = await f.store.open(f.root); expect(model).toHaveBeenCalledTimes(1);
    await f.store.adoptCriteria({ ...f.target, expectedRevision: snapshot.revision, content: '只检查此句的称谓', scope: { kind: 'units', targets: [{ unitId: unit.id, sourceVersionId: unit.sourceVersionId }] }, purpose: 'review', origin: { kind: 'explicit', text: '人明确采用局部标准' } });
    await f.runtime.onTaskChanged(f.target); await settled(f.runtime, f.target); expect(model).toHaveBeenCalledTimes(2);
    expect(JSON.parse(model.mock.calls[1][0].input).coverage.targets.map((target: { unitId: string }) => target.unitId)).toEqual([unit.id]);
    snapshot = await f.store.open(f.root); expect(snapshot.planRevisions.at(-1)?.steps).toHaveLength(2);
    await f.store.setGoal({ ...f.target, expectedRevision: snapshot.revision, goal: '明确改变全局标准' }); await f.runtime.onTaskChanged(f.target); await settled(f.runtime, f.target);
    expect(model).toHaveBeenCalledTimes(3); expect(JSON.parse(model.mock.calls[2][0].input).coverage.targets).toHaveLength(2);
  });

  it('preserves unrelated B coverage when A changes and excludes B summaries when authorization narrows', async () => {
    const model = vi.fn<Model>(clean); const f = await fixture('A_ALLOWED_OLD', model); let snapshot = await f.store.open(f.root);
    await f.store.importText({ ...f.target, expectedRevision: snapshot.revision, name: 'b.txt', text: 'B_PRIVATE_TEXT', format: 'txt' });
    await authorize(f.runtime, f.target); await settled(f.runtime, f.target);
    await fs.writeFile(path.join(f.root, f.snapshot.sources[0].relativePath), 'A_ALLOWED_NEW'); await f.runtime.onTaskChanged(f.target); await settled(f.runtime, f.target);
    expect(model).toHaveBeenCalledTimes(2); const changed = JSON.parse(model.mock.calls[1][0].input); expect(changed.coverage.targets).toHaveLength(1);
    expect(changed.units.find((unit: { text: string }) => unit.text === 'B_PRIVATE_TEXT').role).toBe('context'); expect(JSON.stringify(changed)).not.toContain('A_ALLOWED_OLD');
    snapshot = await f.store.open(f.root); const sourceA = snapshot.sources.at(-1)!; const unitB = snapshot.units.filter(isTextTaskUnit).find((unit) => unit.text === 'B_PRIVATE_TEXT')!;
    await f.store.proposeContext({ ...f.target, expectedRevision: snapshot.revision, authorizedSourceVersionIds: snapshot.sourceFiles.flatMap((source) => source.currentVersionId ? [source.currentVersionId] : []), proposal: { proposedBy: 'agent', content: { groundedClaims: ['B_PRIVATE_SUMMARY'], hypotheses: [] }, sourceRefs: [{ unitId: unitB.id, sourceVersionId: unitB.sourceVersionId, start: 0, end: unitB.text.length, text: unitB.text }], openQuestions: [] } });
    await f.runtime.authorize({ ...f.target, scope: 'sources', sourceVersionIds: [sourceA.id] }); await settled(f.runtime, f.target);
    const narrowed = model.mock.calls.at(-1)![0].input; expect(narrowed).toContain('A_ALLOWED_NEW'); expect(narrowed).not.toContain('B_PRIVATE_TEXT'); expect(narrowed).not.toContain('B_PRIVATE_SUMMARY'); expect(JSON.parse(narrowed).unavailableContext.proposalIds.length).toBeGreaterThan(0);
  });

  it.each(['hypothesis', 'question', 'claim'] as const)('keeps complete batch dependencies for %s, issues and scenes when a grant narrows', async (kind) => {
    const secret = 'PRIVATE_B_SENTINEL';
    const model = vi.fn<Model>(async (request) => {
      if (request.onDelta) { request.onDelta('请核对。'); return ''; }
      const result = response(request);
      const body = JSON.parse(request.input);
      const a = body.units.find((unit: { text: string }) => unit.text === 'A_ALLOWED');
      const b = body.units.find((unit: { text: string }) => unit.text === secret);
      if (!b) return JSON.stringify(result);
      const targetA = { unitId: a.unitId, sourceVersionId: a.sourceVersionId };
      const targetB = { unitId: b.unitId, sourceVersionId: b.sourceVersionId };
      const refA = { ...targetA, start: 0, end: a.text.length, text: a.text };
      result.understanding = { groundedClaims: [], hypotheses: [], openQuestions: [] };
      if (kind === 'hypothesis') result.understanding.hypotheses = [{ content: `Related to ${secret}`, targets: [targetB], sourceRefs: [] }];
      if (kind === 'question') result.understanding.openQuestions = [{ question: `Why ${secret}?`, targets: [targetB] }];
      if (kind === 'claim') result.understanding.groundedClaims = [{ content: `A relates to ${secret}`, sourceRefs: [refA] }];
      result.issues = [{ id: 'issue-a', targets: [targetA], severity: 'high', title: `Check ${secret}`, hypothesis: `Possibly ${secret}`, sourceRefs: [refA], criteriaRefs: [], options: [] }];
      result.scenes = [{ id: 'scene-a', kind: 'single', targets: [targetA], purpose: 'review', decisionMode: 'per-unit', checkIntent: '角色关系', reason: `Compare ${secret}`, issueIds: ['issue-a'], criteriaRefs: [], sourceRefs: [refA] }];
      return JSON.stringify(result);
    });
    const f = await fixture('A_ALLOWED', model);
    let snapshot = await f.store.open(f.root);
    snapshot = await f.store.importText({ ...f.target, expectedRevision: snapshot.revision, name: 'b.txt', text: secret, format: 'txt' });
    await authorize(f.runtime, f.target); await settled(f.runtime, f.target);
    snapshot = await f.store.open(f.root);
    const sources = snapshot.sources.map(source => source.id).sort();
    expect(snapshot.contextHistory?.proposals.at(-1)?.inputSourceVersionIds?.sort()).toEqual(sources);
    expect(snapshot.issues[0].inputSourceVersionIds?.sort()).toEqual(sources);
    expect(snapshot.planRevisions.at(-1)?.scenes?.find(scene => scene.issueIds.length)?.inputSourceVersionIds?.sort()).toEqual(sources);
    // Resume after the trusted grant narrowed while old portable artifacts
    // remain. Completion must filter before any automatic replan.
    f.runtime.dispose();
    const a = snapshot.sources.filter(isTextTaskSource).find(source => source.text === 'A_ALLOWED')!;
    await f.models.saveGrant(f.root, { taskId: snapshot.taskId, scope: 'sources', sourceEntryIds: [a.entryId], endpoint: 'https://provider.example/v1', createdAt: Date.now() });
    const resumed = new TaskReviewRuntime(f.store, f.models, model); runtimes.push(resumed);
    const unit = snapshot.units.find(unit => unit.sourceVersionId === a.id)!;
    await resumed.complete({ ...f.target, unitId: unit.id, sourceVersionId: a.id, generationId: 'narrowed', text: '问题是' });
    const completionInput = model.mock.calls.find(([request]) => request.onDelta)![0].input;
    expect(JSON.parse(completionInput).evidence).toEqual([]);
    expect(completionInput).not.toContain(secret);
    await resumed.startPreflight(f.target); await settled(resumed, f.target);
    const request = model.mock.calls.filter(([request]) => !request.onDelta).at(-1)![0];
    expect(request.input).not.toContain(secret);
    snapshot = await f.store.open(f.root);
    expect(JSON.stringify(snapshot.planRevisions.at(-1))).not.toContain(secret);
  });

  it('rechecks a completed dependent checkpoint after local criteria change and projects only current coverage', async () => {
    let calls = 0;
    const model = vi.fn<Model>(async request => {
      const result = response(request);
      if (!calls++) {
        const body = JSON.parse(request.input);
        const sourceRefs = body.units.map((unit: { unitId: string; sourceVersionId: string; text: string }) => ({ unitId: unit.unitId, sourceVersionId: unit.sourceVersionId, start: 0, end: unit.text.length, text: unit.text }));
        const targetB = body.coverage.targets[1];
        result.issues = [{ id: 'dependent-b', targets: [targetB], severity: 'high', title: 'B依赖A的口径', hypothesis: '关联两处设定', sourceRefs, criteriaRefs: [], options: [] }];
      }
      return JSON.stringify(result);
    });
    const f = await fixture('A_TEXT', model);
    let snapshot = await f.store.open(f.root);
    snapshot = await f.store.importText({ ...f.target, expectedRevision: snapshot.revision, name: 'b.txt', text: 'B_TEXT', format: 'txt' });
    await authorize(f.runtime, f.target); await settled(f.runtime, f.target);
    snapshot = await f.store.open(f.root); const a = snapshot.units[0]; const b = snapshot.units[1];
    await f.store.adoptCriteria({ ...f.target, expectedRevision: snapshot.revision, content: '明确A的角色身份', scope: { kind: 'units', targets: [{ unitId: a.id, sourceVersionId: a.sourceVersionId }] }, purpose: 'review', origin: { kind: 'explicit', text: '明确局部标准' } });
    const current = await f.runtime.getState(f.target);
    expect(current.jobs[0].completedUnitIds).toEqual([]);
    const stored = JSON.parse(await fs.readFile(path.join(f.root, '.reelterminal', 'task-review-jobs.json'), 'utf8'));
    expect(stored.jobs[0].completedUnitIds).toHaveLength(2);
    await f.runtime.onTaskChanged(f.target); const state = await settled(f.runtime, f.target);
    expect(model).toHaveBeenCalledTimes(2);
    expect(JSON.parse(model.mock.calls[1][0].input).coverage.targets.map((target: { unitId: string }) => target.unitId).sort()).toEqual([a.id, b.id].sort());
    expect(state.jobs.flatMap(job => job.completedUnitIds)).toContain(b.id);
    expect((await f.store.open(f.root)).issues).toEqual([]);
    await f.runtime.onTaskChanged(f.target); expect(model).toHaveBeenCalledTimes(2);
  });

  it('persists unreferenced goal understanding only as attributed AI hypotheses without inventing quotes or human adoption', async () => {
    const f = await fixture('合成材料原文', async request => {
      const result = response(request);
      result.understanding.groundedClaims.unshift({ content: JSON.parse(request.input).goal, sourceRefs: [] });
      return JSON.stringify(result);
    });
    const goal = '已确认任务背景：角色从未离开月港';
    await f.store.setGoal({ ...f.target, expectedRevision: f.snapshot.revision, goal });
    await authorize(f.runtime, f.target); const state = await settled(f.runtime, f.target);
    expect(state.jobs[0].status).toBe('completed');
    const snapshot = await f.store.open(f.root); const proposal = snapshot.contextHistory!.proposals.at(-1)!;
    expect(proposal.proposedBy).toBe('agent'); expect(snapshot.contextHistory!.adoptions).toEqual([]);
    expect(proposal.content.groundedClaims).not.toContain(goal); expect(proposal.content.hypotheses).toContain(goal);
    expect(proposal.sourceRefs.every(ref => ref.text === '合成材料原文')).toBe(true);
    expect(proposal.inputSourceVersionIds).toEqual([f.snapshot.sources[0].id]);
    expect(proposal.openQuestions).toEqual([]);
  });

  it('keeps a cancellation tombstone and spent budget until explicit resume', async () => {
    const started = gate(); const release = gate(); let calls = 0;
    const f = await fixture('一句', async (request) => { calls++; if (calls === 1) { started.resolve(); await release.promise; } return JSON.stringify(response(request)); });
    await authorize(f.runtime, f.target); await started.promise;
    const active = (await f.runtime.getState(f.target)).jobs[0]; await f.runtime.cancelJob({ ...f.target, jobId: active.id }); release.resolve(); await settled(f.runtime, f.target);
    let snapshot = await f.store.open(f.root); const unit = snapshot.units[0]; await f.store.decide({ ...f.target, expectedRevision: snapshot.revision, unitId: unit.id, sourceVersionId: unit.sourceVersionId, purpose: 'review', status: 'kept', note: '普通人工决定' });
    await f.runtime.onTaskChanged(f.target); await f.runtime.continueAnalysis(f.target); const stopped = await f.runtime.getState(f.target); expect(stopped.jobs).toHaveLength(1); expect(stopped.jobs[0]).toMatchObject({ id: active.id, status: 'cancelled', attempts: 1, reservedOutputTokens: 6000 }); expect(calls).toBe(1);
    snapshot = await f.store.open(f.root); expect(snapshot.contextHistory?.proposals).toEqual([]);
    await f.runtime.startPreflight(f.target); const resumed = await settled(f.runtime, f.target); expect(resumed.jobs[0]).toMatchObject({ id: active.id, status: 'completed', attempts: 2, reservedOutputTokens: 12000 }); expect(calls).toBe(2);
  });

  it('marks the ninth unit unknown then failed, and bounds transient retries', async () => {
    const started = gate(); const release = gate(); let calls = 0;
    const f = await fixture(Array.from({ length: 9 }, (_, i) => `条目${i}`).join('\n'), async (request) => { calls++; if (calls === 2) { started.resolve(); await release.promise; throw new TaskModelError('Synthetic invalid structure'); } return JSON.stringify(response(request)); });
    await authorize(f.runtime, f.target); await started.promise; let snapshot = await f.store.open(f.root); const ninth = snapshot.units[8];
    expect(snapshot.planRevisions.at(-1)?.steps.find((step) => step.unitId === ninth.id)?.reason).toContain('风险未知'); release.resolve(); await settled(f.runtime, f.target); snapshot = await f.store.open(f.root);
    expect(snapshot.planRevisions.at(-1)?.steps.find((step) => step.unitId === ninth.id)?.reason).toContain('预审失败');
    const retryModel = vi.fn<Model>(async () => { throw new TaskModelError('Model provider returned HTTP 429', true); }); const retry = await fixture('一句', retryModel); await authorize(retry.runtime, retry.target); const state = await settled(retry.runtime, retry.target);
    expect(retryModel).toHaveBeenCalledTimes(3); expect(state.jobs[0]).toMatchObject({ status: 'failed', attempts: 3, reservedOutputTokens: 18000 }); await expect(retry.runtime.retryJob({ ...retry.target, jobId: state.jobs[0].id })).rejects.toThrow('budget');
  });

  it('keeps missing/unknown coverage out of analyzed counts and enforces a stable total batch budget', async () => {
    const started = performance.now(); let reads = 0, readMs = 0;
    const phase = (stage: string) => process.stdout.write(`TASK_BATCH_BUDGET_STAGE ${JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - started), reads, readMs: Math.round(readMs) })}\n`);
    const unknown = await fixture('未知项\n已分析项', async (request) => { const result = response(request); result.coverage[0].status = 'unknown'; result.coverage[0].reason = '缺少前场语境'; return JSON.stringify(result); });
    await authorize(unknown.runtime, unknown.target); const state = await settled(unknown.runtime, unknown.target);
    expect(state.jobs[0].completedUnitIds).toEqual([unknown.snapshot.units[1].id]);
    const plan = (await unknown.store.open(unknown.root)).planRevisions.at(-1)!;
    expect(plan.steps.find((step) => step.unitId === unknown.snapshot.units[0].id)?.reason).toContain('风险未知'); expect(plan.scenes?.some((scene) => scene.kind === 'lowRiskGroup')).toBe(false);
    phase('unknown-coverage');
    const model = vi.fn<Model>(clean); const bounded = await fixture(Array.from({ length: 140 }, (_, i) => `条目${i}`).join('\n'), model);
    const open = bounded.store.open.bind(bounded.store);
    vi.spyOn(bounded.store, 'open').mockImplementation(async root => { const began = performance.now(); reads++; try { return await open(root); } finally { readMs += performance.now() - began; } });
    phase('bounded-prepared');
    await authorize(bounded.runtime, bounded.target); phase('authorized');
    // Full getState validates/projects the growing plan. Poll the controlled
    // model boundary cheaply until the last batch starts, then still require
    // the real public state to settle and verify all coverage/budget invariants.
    await vi.waitFor(() => expect(model.mock.calls.length).toBeGreaterThanOrEqual(16), { timeout: 15000 });
    const full = await settled(bounded.runtime, bounded.target, 15000); phase('initial-settled');
    expect(model).toHaveBeenCalledTimes(16); expect(full.deferredUnitIds).toHaveLength(12); expect(full.jobs.flatMap((job) => job.completedUnitIds)).toHaveLength(128);
    let snapshot = await bounded.store.open(bounded.root); const unit = snapshot.units[0];
    await bounded.store.decide({ ...bounded.target, expectedRevision: snapshot.revision, unitId: unit.id, sourceVersionId: unit.sourceVersionId, purpose: 'review', status: 'kept', note: '普通判断不自动续费' });
    await bounded.runtime.onTaskChanged(bounded.target); await bounded.runtime.getState(bounded.target);
    const repeated = await bounded.runtime.startPreflight(bounded.target);
    expect(repeated.jobs.map(job => job.id)).toEqual(full.jobs.map(job => job.id)); expect(model).toHaveBeenCalledTimes(16);
    phase('stable-preflight');
    await bounded.runtime.continueAnalysis(bounded.target);
    await vi.waitFor(() => expect(model.mock.calls.length).toBeGreaterThanOrEqual(18), { timeout: 15000 });
    const continued = await settled(bounded.runtime, bounded.target, 15000); phase('continued-settled');
    expect(model).toHaveBeenCalledTimes(18); expect(continued.deferredUnitIds).toEqual([]); expect(continued.remainingUnitCount).toBe(0);
    expect(new Set(continued.jobs.flatMap(job => job.completedUnitIds)).size).toBe(140);
    const complete = await bounded.runtime.continueAnalysis(bounded.target);
    expect(complete.jobs.map(job => job.id)).toEqual(continued.jobs.map(job => job.id)); expect(model).toHaveBeenCalledTimes(18);
    phase('done');
  }, 20000);

  it('limits background concurrency across tasks while foreground completion remains independent', async () => {
    const phase = async <T>(stage: string, work: () => Promise<T>) => {
      const started = performance.now();
      process.stdout.write(`TASK_RUNTIME_CONCURRENCY_STAGE ${JSON.stringify({ stage: `${stage}.start`, elapsedMs: 0 })}\n`);
      try { return await work(); }
      finally { process.stdout.write(`TASK_RUNTIME_CONCURRENCY_STAGE ${JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - started) })}\n`); }
    };
    // One runtime uses one model profile across real task roots. The other
    // tasks do not need unrelated, unused credential/configuration files.
    const [first, second, third] = await phase('prepare-task-roots', async () => [await fixture('任务一'), await taskFixture('任务二'), await taskFixture('任务三')] as const);
    const gates = [gate(), gate(), gate()]; const firstTwoStarted = gate(); const thirdStarted = gate(); let calls = 0; let active = 0; let peak = 0;
    const runtime = new TaskReviewRuntime(first.store, first.models, async (request) => {
      if (request.onDelta) { request.onDelta('继续反馈'); return ''; }
      request.signal.throwIfAborted();
      const index = calls++; active++; peak = Math.max(peak, active); if (index === 1) firstTwoStarted.resolve(); if (index === 2) thirdStarted.resolve();
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(request.signal.reason); request.signal.addEventListener('abort', abort, { once: true }); });
      try { await Promise.race([gates[index].promise, cancelled]); }
      finally { active--; request.signal.removeEventListener('abort', abort); }
      return JSON.stringify(response(request));
    }); runtimes.push(runtime);
    await phase('authorize-and-occupy-two-slots', async () => {
      await authorize(runtime, first.target); await authorize(runtime, second.target); await authorize(runtime, third.target); await firstTwoStarted.promise; expect(calls).toBe(2);
      const states = await Promise.all([first, second, third].map(task => runtime.getState(task.target)));
      expect(states.flatMap(state => state.jobs).some(job => job.status === 'failed')).toBe(false);
    });
    const events: TaskCompletionEvent[] = []; runtime.onCompletion((event) => events.push(event));
    await runtime.complete({ ...first.target, unitId: first.snapshot.units[0].id, sourceVersionId: first.snapshot.units[0].sourceVersionId, generationId: 'foreground', text: '问题是' }); expect(events[0].delta).toBe('继续反馈');
    try {
      await phase('release-first-and-start-third', async () => { gates[0].resolve(); await thirdStarted.promise; expect(calls).toBe(3); });
      await phase('finish-all-tasks', async () => {
        gates[1].resolve(); gates[2].resolve();
        const states = await Promise.all([first, second, third].map((f) => settled(runtime, f.target)));
        expect(states.map(state => state.jobs[0].status)).toEqual(['completed', 'completed', 'completed']);
        expect(calls).toBe(3); expect(peak).toBe(2);
      });
    } finally { gates.forEach(item => item.resolve()); }
  });

  it('starts an earlier queued batch when its completion overlaps another task checkpoint', async () => {
    const first = await fixture(Array.from({ length: 9 }, (_, index) => `queued ${index}`).join('\n'));
    const second = await taskFixture('other active task');
    const firstStarted = gate(); const releaseFirst = gate(); const firstCompleted = gate();
    const checkpointEntered = gate(); const releaseCheckpoint = gate();
    const secondStarted = gate(); const releaseSecond = gate(); const nextBatchStarted = gate();
    releaseFixtureGates.push(() => { releaseFirst.resolve(); releaseCheckpoint.resolve(); releaseSecond.resolve(); });
    const wait = async (request: TaskModelRequest, pending: Promise<void>) => {
      request.signal.throwIfAborted();
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(request.signal.reason); request.signal.addEventListener('abort', abort, { once: true }); });
      try { await Promise.race([pending, cancelled]); }
      finally { request.signal.removeEventListener('abort', abort); }
    };
    const runtime = new TaskReviewRuntime(first.store, first.models, async request => {
      const ids = JSON.parse(request.input).coverage.targets.map((target: { unitId: string }) => target.unitId);
      if (ids.includes(first.snapshot.units[0].id)) { firstStarted.resolve(); await wait(request, releaseFirst.promise); }
      else if (ids.includes(second.snapshot.units[0].id)) { secondStarted.resolve(); await wait(request, releaseSecond.promise); }
      else { expect(ids).toEqual([first.snapshot.units[8].id]); nextBatchStarted.resolve(); }
      return clean(request);
    }); runtimes.push(runtime);
    // Hold one real checkpoint to force completion while the pump awaits I/O.
    // Observe model progress and public job state, rather than pump internals.
    const writer = runtime as unknown as { persist(root: string, state: { jobs: Array<{ status: string }> }): Promise<void> };
    const persist = writer.persist.bind(runtime); let held = false;
    const checkpoint = vi.spyOn(writer, 'persist').mockImplementation(async (root, state) => {
      await persist(root, state);
      if (root === first.root && state.jobs[0]?.status === 'completed') firstCompleted.resolve();
      if (root === second.root && state.jobs[0]?.status === 'running' && !held) {
        held = true; checkpointEntered.resolve(); await releaseCheckpoint.promise;
      }
    });
    try {
      await authorize(runtime, first.target); await firstStarted.promise;
      await authorize(runtime, second.target); await checkpointEntered.promise;
      releaseFirst.resolve(); await firstCompleted.promise;
      // Drain the completion's microtasks while the second checkpoint is held.
      await new Promise<void>(resolve => setImmediate(resolve));
      releaseCheckpoint.resolve();
      await Promise.all([secondStarted.promise, nextBatchStarted.promise]);
      releaseSecond.resolve();
      const states = await Promise.all([first, second].map(task => settled(runtime, task.target)));
      expect(states.map(state => state.jobs.map(job => job.status))).toEqual([['completed', 'completed'], ['completed']]);
    } finally {
      releaseFirst.resolve(); releaseCheckpoint.resolve(); releaseSecond.resolve(); checkpoint.mockRestore();
    }
  }, 10000);

  it('resumes only interrupted batches and never trusts a copied task grant', async () => {
    const started = gate(); let calls = 0;
    const f = await fixture(Array.from({ length: 9 }, (_, i) => `条目${i}`).join('\n'), async (request) => { calls++; if (calls === 2) { started.resolve(); await new Promise<void>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })); } return JSON.stringify(response(request)); });
    await authorize(f.runtime, f.target); await started.promise; f.runtime.dispose();
    const file = path.join(f.root, '.reelterminal', 'task-review-jobs.json'); await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(file, 'utf8')).jobs[1].status).toBe('interrupted'));
    const resumedModel = vi.fn<Model>(clean); const resumed = new TaskReviewRuntime(f.store, f.models, resumedModel); runtimes.push(resumed); await resumed.getState(f.target); await settled(resumed, f.target);
    expect(resumedModel).toHaveBeenCalledTimes(1); expect(JSON.parse(resumedModel.mock.calls[0][0].input).coverage.targets).toHaveLength(1);
    const portable = JSON.parse(await fs.readFile(file, 'utf8')); expect(portable.grant).toBeUndefined(); portable.grant = { taskId: f.target.taskId, scope: 'task', sourceEntryIds: [], endpoint: 'https://provider.example/v1', createdAt: 0 }; portable.jobs[0].status = 'queued';
    const copiedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'copied-task-')); roots.push(copiedRoot); await fs.cp(f.root, copiedRoot, { recursive: true }); await fs.writeFile(path.join(copiedRoot, '.reelterminal', 'task-review-jobs.json'), JSON.stringify(portable));
    const copied = new TaskReviewRuntime(f.store, f.models, resumedModel); runtimes.push(copied); expect((await copied.getState({ root: copiedRoot, taskId: f.target.taskId })).grant).toBeUndefined(); expect(resumedModel).toHaveBeenCalledTimes(1);
  });
});

describe('foreground feedback and search', () => {
  it('binds search source versions and computes exact UTF-16 citations from model quote-only references', async () => {
    const f = await fixture('🙂他说想家，随后走向海边。', async request => {
      if (!request.system.includes('Find semantic matches')) return clean(request);
      const unit = JSON.parse(request.input).units[0];
      return JSON.stringify({ debugInfo: 'readonly model metadata', matches: [{ unitId: unit.unitId, reason: '表达对家的思念', confidence: 0.9, sourceRefs: [{ unitId: unit.unitId, text: '想家', start: 1, end: 999, confidence: 0.8 }] }] });
    });
    await authorize(f.runtime, f.target); await settled(f.runtime, f.target);
    const result = await f.runtime.search({ ...f.target, query: '思念家乡' });
    const unit = f.snapshot.units[0]; const start = unit.text.indexOf('想家');
    expect(result.matches[0]).toMatchObject({ unitId: unit.id, sourceVersionId: unit.sourceVersionId, sourceRefs: [{ unitId: unit.id, sourceVersionId: unit.sourceVersionId, start, end: start + 2, text: '想家' }] });
    expect(result).not.toHaveProperty('debugInfo'); expect(result.matches[0]).not.toHaveProperty('confidence'); expect(result.matches[0].sourceRefs![0]).not.toHaveProperty('confidence');
  });

  it.each(['characters', 'whole'] as const)('replays the captured quoted DeepSeek completion as %s without exposing the echoed draft', async chunking => {
    const captured = JSON.parse(readFileSync(new URL('./__fixtures__/task-review-deepseek-completion-response.json', import.meta.url), 'utf8'));
    const draft = captured.preparedInput.reviewFeedbackDraft;
    const candidate: string = captured.response;
    const events: TaskCompletionEvent[] = [];
    const f = await fixture(captured.preparedInput.source, async request => {
      if (!request.onDelta) return clean(request);
      const chunks = chunking === 'characters' ? Array.from(candidate) : [candidate];
      for (const chunk of chunks) {
        request.onDelta(chunk);
        expect(events.filter(event => event.delta)).toEqual([]);
      }
      return captured.response;
    });
    let snapshot = await f.store.setGoal({ ...f.target, expectedRevision: f.snapshot.revision, goal: captured.preparedInput.goal });
    const unit = snapshot.units[0];
    snapshot = await f.store.saveDraft({ ...f.target, expectedRevision: snapshot.revision, draft: { unitId: unit.id, sourceVersionId: unit.sourceVersionId, text: draft, selectionStart: draft.length, selectionEnd: draft.length } });
    await authorize(f.runtime, f.target); await settled(f.runtime, f.target);
    const before = await f.store.open(f.root); const sourcePath = path.join(f.root, f.snapshot.sources[0].relativePath); const sourceBefore = await fs.readFile(sourcePath, 'utf8');
    f.runtime.onCompletion(event => events.push(event));
    await f.runtime.complete({ ...f.target, unitId: unit.id, sourceVersionId: unit.sourceVersionId, generationId: 'captured-quoted', text: draft });
    const suggestion = events.map(event => event.delta).join('');
    expect(captured.response.slice(1, -1).startsWith(draft)).toBe(true);
    expect(suggestion).toBe(captured.response.slice(1 + draft.length, -1));
    expect(draft + suggestion).toBe(captured.response.slice(1, -1));
    expect((draft + suggestion).indexOf(draft, draft.length)).toBe(-1);
    expect(suggestion).toContain('‘我小时候每个夏天都在地球这片海里游泳’');
    expect(events.at(-1)).toMatchObject({ done: true }); expect(events.at(-1)?.error).toBeUndefined();
    expect((await f.store.open(f.root)).drafts).toEqual(before.drafts);
    expect(await fs.readFile(sourcePath, 'utf8')).toBe(sourceBefore);
  });

  it.each([
    { name: 'quoted prefix followed by text outside its quote', candidate: '“这段意见，建议”是原反馈，请保留“内部引文”' },
    { name: 'a whole quotation with a different prefix', candidate: '“别的意见，保留‘引文’。”' },
    { name: 'unmatched outer quotation', candidate: '“这段意见，建议检查称谓"' },
    { name: 'ordinary suffix with internal quotation and repetition', candidate: '请核对“这段意见，建议”的引用，保留重复、保留重复。' },
  ])('preserves $name verbatim', async ({ name, candidate }) => {
    const events: TaskCompletionEvent[] = []; const draft = '这段意见，建议';
    const f = await fixture('原文不能修改', async request => {
      if (!request.onDelta) return clean(request);
      for (const chunk of candidate) request.onDelta(chunk);
      if (name.startsWith('ordinary suffix')) expect(events.some(event => event.delta)).toBe(true);
      return candidate;
    });
    await authorize(f.runtime, f.target); await settled(f.runtime, f.target); f.runtime.onCompletion(event => events.push(event));
    const unit = f.snapshot.units[0];
    await f.runtime.complete({ ...f.target, unitId: unit.id, sourceVersionId: unit.sourceVersionId, generationId: 'preserved-quote', text: draft });
    expect(events.map(event => event.delta).join('')).toBe(candidate);
  });

  it('returns only an insertable suffix, preserves intentional inner repetition, and detects continued edits', async () => {
    const started = gate(); const release = gate();
    const f = await fixture('原台词', async (request) => {
      if (!request.onDelta) return clean(request);
      const draft = JSON.parse(request.input).reviewFeedbackDraft; expect(request.system).toContain('explicit facts and dates');
      if (draft === '年份有误，') { request.onDelta('年份'); request.onDelta('有误，'); request.onDelta('请按2025年设定修改。'); }
      else if (draft === '用户半句') { started.resolve(); await release.promise; request.onDelta('旧候选'); }
      else { request.onDelta('请核对称谓，'); request.onDelta('请核对称谓。'); }
      return '';
    });
    await authorize(f.runtime, f.target); await settled(f.runtime, f.target); const events: TaskCompletionEvent[] = []; f.runtime.onCompletion((event) => events.push(event));
    const unit = f.snapshot.units[0]; const target = { ...f.target, unitId: unit.id, sourceVersionId: unit.sourceVersionId };
    await f.runtime.complete({ ...target, generationId: 'echo', text: '年份有误，' }); expect(events.filter((event) => event.generationId === 'echo').map((event) => event.delta).join('')).toBe('请按2025年设定修改。');
    await f.runtime.complete({ ...target, generationId: 'suffix', text: '请核对内容。' }); expect(events.filter((event) => event.generationId === 'suffix').map((event) => event.delta).join('')).toBe('请核对称谓，请核对称谓。');
    const pending = f.runtime.complete({ ...target, generationId: 'old', text: '用户半句' }); await started.promise; const snapshot = await f.store.open(f.root); await f.store.saveDraft({ ...f.target, expectedRevision: snapshot.revision, draft: { unitId: unit.id, sourceVersionId: unit.sourceVersionId, text: '用户半句已继续', selectionStart: 7, selectionEnd: 7 } }); release.resolve(); await pending;
    expect(events.at(-1)?.error).toContain('feedback changed'); expect((await f.store.open(f.root)).drafts[0].text).toBe('用户半句已继续');
  });

  it('searches exact source/unit scopes, caches success, and invalidates source, criteria, provider and grant changes', async () => {
    const requests: TaskModelRequest[] = [];
    const model = vi.fn<Model>(async request => {
      if (!request.system.includes('Find semantic matches')) return clean(request);
      requests.push(request);
      const range = JSON.parse(request.input).units[0];
      return JSON.stringify({ matches: [{ unitId: range.unitId, sourceVersionId: range.sourceVersionId, reason: '语义候选', sourceRefs: [{ unitId: range.unitId, sourceVersionId: range.sourceVersionId, start: range.start, end: range.end, text: range.text }] }] });
    });
    const f = await fixture('A_ALLOWED', model); let snapshot = await f.store.open(f.root);
    snapshot = await f.store.importText({ ...f.target, expectedRevision: snapshot.revision, name: 'b.txt', text: 'B_PRIVATE', format: 'txt' });
    await authorize(f.runtime, f.target); await settled(f.runtime, f.target);
    const a = snapshot.units[0]; const b = snapshot.units[1];
    const scope = { kind: 'sources' as const, sourceVersionIds: [a.sourceVersionId] };
    const input = { ...f.target, query: '核对范围', scope };
    const first = await f.runtime.search(input);
    expect(first).toMatchObject({ scopeUnitCount: 1, candidateUnitCount: 1, searchedUnitCount: 1, coverage: 'scope', truncated: false, cached: false });
    expect(first.matches[0].sourceRefs?.[0].text).toBe('A_ALLOWED'); expect(requests[0].input).not.toContain('B_PRIVATE');
    expect((await f.runtime.search(input)).cached).toBe(true); expect(requests).toHaveLength(1);
    await f.runtime.search({ ...input, scope: { kind: 'units', targets: [{ unitId: b.id, sourceVersionId: b.sourceVersionId }] } });
    expect(requests[1].input).toContain('B_PRIVATE'); expect(requests[1].input).not.toContain('A_ALLOWED');
    snapshot = await f.store.open(f.root);
    await f.store.adoptCriteria({ ...f.target, expectedRevision: snapshot.revision, content: '只核对此句', scope: { kind: 'units', targets: [{ unitId: a.id, sourceVersionId: a.sourceVersionId }] }, purpose: 'review', origin: { kind: 'explicit', text: '人明确采用' } });
    expect((await f.runtime.search(input)).cached).toBe(false); expect(requests).toHaveLength(3);
    await f.models.save({ endpoint: 'https://provider.example/v1', backgroundModel: 'review', completionModel: 'changed' });
    expect((await f.runtime.search(input)).cached).toBe(false); expect(requests).toHaveLength(4);
    await f.runtime.authorize({ ...f.target, scope: 'sources', sourceVersionIds: [a.sourceVersionId] }); await settled(f.runtime, f.target);
    expect((await f.runtime.search(input)).cached).toBe(false); expect(requests).toHaveLength(5);
    await expect(f.runtime.search({ ...input, scope: { kind: 'units', targets: [{ unitId: b.id, sourceVersionId: b.sourceVersionId }] } })).rejects.toThrow('authorized');
    expect(requests).toHaveLength(5);
    await fs.writeFile(path.join(f.root, snapshot.sources[0].relativePath), 'A_CHANGED');
    await expect(f.runtime.search(input)).rejects.toThrow('authorized');
    const refreshed = await f.store.open(f.root); const version = refreshed.sourceFiles.find(file => file.entryId === snapshot.sources.find(source => source.id === a.sourceVersionId)!.entryId)!.currentVersionId!;
    const changed = await f.runtime.search({ ...input, scope: { kind: 'sources', sourceVersionIds: [version] } });
    expect(changed.cached).toBe(false); expect(changed.matches[0].sourceRefs?.[0].text).toBe('A_CHANGED'); expect(requests).toHaveLength(6);
  });

  it('recalls a deep synonym in a large scope with bounded model input while background work is occupied', async () => {
    const diagnosticStarted = performance.now();
    const diagnostic = (phase: string) => process.stdout.write(`large-search-phase ${phase} ${Math.round(performance.now() - diagnosticStarted)}ms\n`);
    const requests: TaskModelRequest[] = [];
    const backgroundStarted = gate();
    const model: Model = async request => {
      if (request.system.includes('Expand only')) { requests.push(request); return JSON.stringify({ terms: ['思念故乡', '怀念家乡'] }); }
      if (request.system.includes('Find semantic matches')) {
        requests.push(request);
        const ranges = JSON.parse(request.input).units;
        const range = ranges.find((range: { text: string }) => range.text.includes('思念故乡'));
        const start = range.start + range.text.indexOf('思念故乡');
        return JSON.stringify({ matches: [{ unitId: range.unitId, sourceVersionId: range.sourceVersionId, reason: '表达想家的同义意思', sourceRefs: [{ unitId: range.unitId, sourceVersionId: range.sourceVersionId, start, end: start + 4, text: '思念故乡' }] }] });
      }
      await new Promise<void>((_resolve, reject) => {
        request.signal.throwIfAborted();
        request.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
        backgroundStarted.resolve();
      });
      return '';
    };
    const lines = Array.from({ length: 170 }, (_, i) => `${i}:普通场景${'描写'.repeat(250)}`); lines[139] = '远行多年，每晚都在思念故乡。';
    const f = await fixture(lines.join('\n'), model); diagnostic('fixture'); await authorize(f.runtime, f.target); diagnostic('authorized');
    await backgroundStarted.promise; diagnostic('background-started');
    const found = await f.runtime.search({ ...f.target, query: '想家' });
    diagnostic('searched');
    expect(found.matches[0].unitId).toBe(f.snapshot.units[139].id); expect(found.matches[0].sourceRefs?.[0].text).toBe('思念故乡');
    expect(found).toMatchObject({ scopeUnitCount: 170, locallyScannedUnitCount: 170, coverage: 'candidates', truncated: true, cached: false });
    expect(found.searchedUnitCount).toBeLessThanOrEqual(24); expect(found.omittedUnitCount).toBe(170 - found.searchedUnitCount);
    expect(requests).toHaveLength(2); expect(JSON.parse(requests[0].input)).toEqual({ query: '想家' });
    expect(requests[1].input.length).toBeLessThan(32000);
    expect(found.modelInputRanges!.reduce((sum, range) => sum + range.text.length, 0)).toBeLessThanOrEqual(24000);
    expect((await f.runtime.search({ ...f.target, query: '想家' })).cached).toBe(true); expect(requests).toHaveLength(2);
    diagnostic('cached');
    // This search contract does not require sixteen separate user cancellations,
    // each re-reading the large scope. Drain the owner before fixture deletion;
    // individual job cancellation has its own regression above.
    await f.runtime.dispose(); diagnostic('disposed');
  });

  it('does not cache fabricated citations or cancelled search responses', async () => {
    const started = gate(); const release = gate(); let mode = 'invalid'; let searches = 0;
    const f = await fixture('完整原文', async request => {
      if (!request.system.includes('Find semantic matches')) return clean(request);
      searches++; const range = JSON.parse(request.input).units[0];
      if (mode === 'wait') { started.resolve(); await release.promise; }
      return JSON.stringify({ matches: [{ unitId: range.unitId, sourceVersionId: range.sourceVersionId, reason: '合成关联', sourceRefs: [{ unitId: range.unitId, sourceVersionId: range.sourceVersionId, start: 0, end: 2, text: mode === 'invalid' ? '伪造' : '完整' }] }] });
    });
    await authorize(f.runtime, f.target); await settled(f.runtime, f.target);
    const input = { ...f.target, query: '原文' };
    await expect(f.runtime.search(input)).rejects.toThrow('EVIDENCE_NOT_SUPPLIED');
    mode = 'wait'; const pending = f.runtime.search(input); await started.promise;
    await f.runtime.cancelSearch(f.target); release.resolve(); await expect(pending).rejects.toThrow();
    mode = 'valid'; expect((await f.runtime.search(input)).cached).toBe(false); expect(searches).toBe(3);
  });

  it.each(['cancel-final', 'cancel-cache', 'replace-final'] as const)('rejects %s during the final freshness refresh without publishing an old success', async mode => {
    let modelCalls = 0;
    const f = await fixture('searchable source', async request => {
      if (!request.system.includes('Find semantic matches')) return clean(request);
      modelCalls++;
      const range = JSON.parse(request.input).units[0];
      const { id: _id, ...sourceRef } = range;
      return JSON.stringify({ matches: [{ unitId: range.unitId, sourceVersionId: range.sourceVersionId, reason: 'exact candidate', sourceRefs: [sourceRef] }] });
    });
    await authorize(f.runtime, f.target); await settled(f.runtime, f.target);
    const input = { ...f.target, query: 'original query' };
    if (mode === 'cancel-cache') await f.runtime.search(input);
    const started = gate(); const release = gate(); let refreshes = 0;
    const refresh = f.store.refreshSources.bind(f.store);
    vi.spyOn(f.store, 'refreshSources').mockImplementation(async target => {
      const snapshot = await refresh(target);
      if (++refreshes === (mode === 'cancel-cache' ? 2 : 3)) { started.resolve(); await release.promise; }
      return snapshot;
    });
    const pending = f.runtime.search(input);
    const rejected = expect(pending).rejects.toThrow();
    await started.promise;
    if (mode === 'replace-final') {
      const replacement = await f.runtime.search({ ...input, query: 'replacement query' });
      expect(replacement.cached).toBe(false);
    } else await f.runtime.cancelSearch(f.target);
    release.resolve(); await rejected;
    const retried = await f.runtime.search(input);
    // A pre-existing valid cache survives a cancelled cache read; an aborted
    // newly ranked result must never create a cache entry.
    expect(retried.cached).toBe(mode === 'cancel-cache');
    expect(modelCalls).toBe(mode === 'cancel-cache' ? 1 : mode === 'replace-final' ? 3 : 2);
  });

  it('validates semantic matches and refuses a provider changed during request construction', async () => {
    const model = vi.fn<Model>(async (request) => request.system.includes('Find semantic matches') ? JSON.stringify({ matches: [{ unitId: JSON.parse(request.input).units[0].id, sourceVersionId: JSON.parse(request.input).units[0].sourceVersionId, reason: '含义相近', sourceRefs: [JSON.parse(request.input).units[0]].map(({ id: _id, ...range }) => range) }] }) : clean(request));
    const f = await fixture('背井离乡', model); await authorize(f.runtime, f.target); await settled(f.runtime, f.target); expect((await f.runtime.search({ ...f.target, query: '离开家乡' })).matches[0].unitId).toBe(f.snapshot.units[0].id);
    const original = f.models.forRequest.bind(f.models); vi.spyOn(f.models, 'forRequest').mockImplementationOnce(async (kind) => ({ ...await original(kind), endpoint: 'https://new-provider.example/v1' }));
    await expect(f.runtime.search({ ...f.target, query: '离开家乡' })).rejects.toThrow('changed model provider'); expect(model.mock.calls.filter(([request]) => request.system.includes('Find semantic matches'))).toHaveLength(1);
  });
});
