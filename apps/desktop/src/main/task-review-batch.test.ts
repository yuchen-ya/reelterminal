import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskReviewStore } from './task-review-store';
import { FolderReviewStore } from './folder-review-store';
import { selectTaskDecision } from '../shared/task-review-selectors';
import type { TaskReviewSnapshot } from '../shared/task-review';
import type { TaskBatchDecisionInput } from '../shared/task-review-bridge';

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const roots: string[] = [];
const commit = (state: TaskReviewSnapshot) => ({ root: state.root, taskId: state.taskId, expectedRevision: state.revision });
afterEach(async () => {
  const actual = await vi.importActual<typeof fs>('node:fs/promises');
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  await Promise.all(roots.splice(0).map(root => actual.rm(root, { recursive: true, force: true })));
});
async function fixture(count = 3) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-batch-')); roots.push(root);
  const folders = new FolderReviewStore();
  const store = new TaskReviewStore(folders);
  let state = await store.open(root);
  state = await store.importText({ ...commit(state), name: 'sources', format: 'txt', text: Array.from({ length: count }, (_, i) => `Review item ${i + 1}`).join('\n') });
  const input = (snapshot = state, indices = snapshot.units.map((_, i) => i)): TaskBatchDecisionInput => ({
    ...commit(snapshot), batchId: randomUUID(), purpose: 'review', status: 'kept', note: 'Human batch review', pendingOnly: true,
    targets: indices.map(index => ({ unitId: snapshot.units[index].id, sourceVersionId: snapshot.units[index].sourceVersionId, decisionId: randomUUID() })),
  });
  return { root, store, folders, state, input, metadata: path.join(root, '.reelterminal', 'task-review.json') };
}

it('commits 417 explicit targets with one save, checks each source once, and atomically undoes and redoes after reopening', async () => {
  const f = await fixture(417);
  const read = vi.spyOn(f.folders, 'readTextFile');
  const scan = vi.spyOn(f.folders, 'scan');
  vi.mocked(fs.rename).mockClear();
  const input = f.input();
  let state = await f.store.decideBatch(input);
  expect(state.revision).toBe(f.state.revision + 1);
  expect(state.decisions).toHaveLength(417);
  expect(state.decisionActions).toHaveLength(417);
  expect(state.decisionBatches).toEqual([{ id: input.batchId, decisionIds: input.targets.map(target => target.decisionId) }]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(scan).not.toHaveBeenCalled();
  expect(fs.rename).toHaveBeenCalledTimes(1);
  const reopened = new TaskReviewStore();
  expect((await reopened.getDecisionOutcome({ root: f.root, taskId: state.taskId, decisionId: input.batchId })).outcome).toBe('committed');
  state = await reopened.undoDecisionBatch({ ...commit(state), batchId: input.batchId });
  expect(state.revision).toBe(f.state.revision + 2);
  expect(state.units.every(unit => !selectTaskDecision(state, { unitId: unit.id, sourceVersionId: unit.sourceVersionId, purpose: 'review' }))).toBe(true);
  state = await reopened.redoDecisionBatch({ ...commit(state), batchId: input.batchId });
  expect(state.units.every(unit => selectTaskDecision(state, { unitId: unit.id, sourceVersionId: unit.sourceVersionId, purpose: 'review' })?.status === 'kept')).toBe(true);
  expect((await reopened.open(f.root)).decisionBatches).toEqual(state.decisionBatches);
});

it('rejects duplicate targets, reused member IDs and an empty batch without changing any persisted decision', async () => {
  const f = await fixture();
  for (const mutate of [
    (input: TaskBatchDecisionInput) => { input.targets[1] = { ...input.targets[0], decisionId: randomUUID() }; },
    (input: TaskBatchDecisionInput) => { input.targets[1].decisionId = input.targets[0].decisionId; },
    (input: TaskBatchDecisionInput) => { input.targets = []; },
  ]) {
    const input = f.input(); mutate(input);
    await expect(f.store.decideBatch(input)).rejects.toThrow();
    expect((await f.store.open(f.root)).revision).toBe(f.state.revision);
    expect((await f.store.open(f.root)).decisions).toEqual([]);
  }
});

it('rejects a stale task revision and proves non-commit without replaying the batch', async () => {
  const f = await fixture();
  const input = f.input();
  const current = await f.store.setGoal({ ...commit(f.state), goal: 'Updated review criteria' });
  await expect(f.store.decideBatch(input)).rejects.toThrow('Revision conflict');
  const outcome = await f.store.getDecisionOutcome({ root: f.root, taskId: f.state.taskId, decisionId: input.batchId });
  expect(outcome.outcome).toBe('not-committed');
  expect(outcome.snapshot.revision).toBe(current.revision);
  expect(outcome.snapshot.decisions).toEqual([]);
});

it('rejects all targets if one source changed and preserves the exact metadata bytes', async () => {
  const f = await fixture();
  const before = await fs.readFile(f.metadata, 'utf8');
  await fs.appendFile(path.join(f.root, f.state.sources[0].relativePath), '\nchanged source');
  await expect(f.store.decideBatch(f.input())).rejects.toThrow('Source changed');
  expect(await fs.readFile(f.metadata, 'utf8')).toBe(before);
});

it('keeps previously decided exceptions untouched when approving only pending targets', async () => {
  const f = await fixture();
  const unit = f.state.units[1];
  const current = await f.store.decide({ ...commit(f.state), unitId: unit.id, sourceVersionId: unit.sourceVersionId, purpose: 'review', status: 'rework', note: 'Clean the edge' });
  const invalid = f.input(current);
  await expect(f.store.decideBatch(invalid)).rejects.toThrow('already has a decision');
  expect((await f.store.open(f.root)).decisions).toHaveLength(1);
  const state = await f.store.decideBatch(f.input(current, [0, 2]));
  expect(selectTaskDecision(state, { unitId: unit.id, sourceVersionId: unit.sourceVersionId, purpose: 'review' })).toMatchObject({ status: 'rework', note: 'Clean the edge' });
  expect(state.decisions).toHaveLength(3);
});

it('restores previous decisions after explicitly overwriting selected targets and undoing the batch', async () => {
  const f = await fixture();
  const unit = f.state.units[0];
  const target = { unitId: unit.id, sourceVersionId: unit.sourceVersionId, purpose: 'review' };
  let state = await f.store.decide({ ...commit(f.state), ...target, status: 'kept', note: 'Earlier decision' });
  const input = { ...f.input(state), status: 'rework' as const, note: 'Clean the edge', pendingOnly: false };
  state = await f.store.decideBatch(input);
  expect(selectTaskDecision(state, target)).toMatchObject({ status: 'rework', note: 'Clean the edge' });
  state = await f.store.undoDecisionBatch({ ...commit(state), batchId: input.batchId });
  expect(selectTaskDecision(state, target)).toMatchObject({ status: 'kept', note: 'Earlier decision' });
});

it('leaves every target unchanged when the single batch save fails and allows a fresh explicit attempt', async () => {
  const f = await fixture();
  const before = await fs.readFile(f.metadata, 'utf8');
  const input = f.input();
  vi.mocked(fs.rename).mockRejectedValueOnce(new Error('Controlled save failure'));
  await expect(f.store.decideBatch(input)).rejects.toThrow('Controlled save failure');
  expect(await fs.readFile(f.metadata, 'utf8')).toBe(before);
  expect((await f.store.getDecisionOutcome({ root: f.root, taskId: f.state.taskId, decisionId: input.batchId })).outcome).toBe('not-committed');
  expect((await fs.readdir(path.dirname(f.metadata))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  const retry = await f.store.decideBatch(f.input());
  expect(retry.decisions).toHaveLength(3);
  expect(retry.revision).toBe(f.state.revision + 1);
});

it('never partially undoes a batch after one member received a newer human decision', async () => {
  const f = await fixture();
  const input = f.input();
  let state = await f.store.decideBatch(input);
  const unit = state.units[1];
  state = await f.store.decide({ ...commit(state), unitId: unit.id, sourceVersionId: unit.sourceVersionId, purpose: 'review', status: 'discarded', note: 'Newer individual decision' });
  const before = await fs.readFile(f.metadata, 'utf8');
  await expect(f.store.undoDecisionBatch({ ...commit(state), batchId: input.batchId })).rejects.toThrow('not available');
  expect(await fs.readFile(f.metadata, 'utf8')).toBe(before);
  expect((await f.store.open(f.root)).decisionActions).toHaveLength(4);
});

it('does not append a duplicate batch and does not infer success for an unrelated request ID', async () => {
  const f = await fixture();
  const input = f.input();
  const state = await f.store.decideBatch(input);
  await expect(f.store.decideBatch({ ...input, expectedRevision: state.revision })).rejects.toThrow('tracked');
  expect((await f.store.open(f.root)).decisions).toHaveLength(3);
  expect((await f.store.getDecisionOutcome({ root: f.root, taskId: state.taskId, decisionId: randomUUID() })).outcome).toBe('unknown');
  await expect(f.store.getDecisionOutcome({ root: f.root, taskId: randomUUID(), decisionId: input.batchId })).rejects.toThrow('identity');
});
