import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskReviewStore } from '../main/task-review-store';
import { registerTaskReviewIpc } from '../main/ipc/task-review';
import { createTaskReviewTransport } from './task-review-write-transport';
import { CHANNELS } from '../shared/channels';

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: any[]) => Promise<any>) => ipc.handlers.set(name, handler) } }));
vi.mock('../main/ipc/index', () => ({ assertEditorIpcSender: (event: { trusted: boolean }) => { if (!event.trusted) throw new Error('Only the trusted editor may decide'); } }));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-transport-')); roots.push(root);
  const store = new TaskReviewStore(); let state = await store.open(root);
  state = await store.importText({ root, taskId: state.taskId, expectedRevision: state.revision, name: 'batch', format: 'txt', text: 'One\nTwo\nThree' });
  const changed = vi.fn(async () => {});
  registerTaskReviewIpc(store, changed);
  const control = { drop: false, partial: false };
  const invoke = vi.fn(async (channel: string, envelope: { method: string; input: unknown }) => {
    const result = await ipc.handlers.get(channel)!({ trusted: true }, envelope);
    if (envelope.method === 'decideBatch' && control.drop) throw new Error('Controlled response loss after commit');
    if (envelope.method === 'decideBatch' && control.partial) return { ...result, decisions: result.decisions.slice(0, -1) };
    return result;
  });
  const transport = createTaskReviewTransport(invoke);
  const input = {
    root, taskId: state.taskId, expectedRevision: state.revision, batchId: randomUUID(),
    targets: state.units.map(unit => ({ unitId: unit.id, sourceVersionId: unit.sourceVersionId, decisionId: randomUUID() })),
    purpose: 'review', status: 'rework', note: 'Clean the edge', pendingOnly: true,
  };
  const query = { root, taskId: state.taskId, decisionId: input.batchId };
  return { root, store, state, changed, control, invoke, transport, input, query };
}

it('returns one committed batch receipt and notifies the runtime once for all members', async () => {
  const f = await fixture();
  const reply = await f.transport(CHANNELS.taskReview, 'decideBatch', f.input);
  expect(reply.decisionReceipt).toEqual({ decisionId: f.input.batchId, outcome: 'committed' });
  expect(reply.decisions).toHaveLength(3);
  expect(reply.decisions.every((decision: { status: string; note: string }) => decision.status === 'rework' && decision.note === 'Clean the edge')).toBe(true);
  expect(f.changed).toHaveBeenCalledTimes(1);
  const disk = JSON.parse(await fs.readFile(path.join(f.root, '.reelterminal', 'task-review.json'), 'utf8'));
  expect(disk).not.toHaveProperty('decisionReceipt');
  expect(disk.decisionBatches[0].decisionIds).toEqual(f.input.targets.map(target => target.decisionId));
});

it('returns the revision published by local planning after discovery and batch history notifications', async () => {
  const f = await fixture();
  f.changed.mockImplementation(async () => {
    const current = await f.store.open(f.root);
    await f.store.publishAnalysis({
      root: f.root, taskId: current.taskId, expectedRevision: current.revision,
      expectedPolicyRevision: current.policyRevision,
      sourceVersionIds: current.sourceFiles.map(file => file.currentVersionId!),
      issues: [], steps: [], reason: 'Local manual planning',
    });
  });
  await fs.writeFile(path.join(f.root, 'new.txt'), 'Discovered later');
  const discovered = await f.transport(CHANNELS.taskReview, 'refreshSources', {
    root: f.root, taskId: f.state.taskId, expectedRevision: f.state.revision,
  });
  expect(discovered.revision).toBe((await f.store.open(f.root)).revision);
  const decided = await f.transport(CHANNELS.taskReview, 'decideBatch', { ...f.input, expectedRevision: discovered.revision });
  expect(decided.decisionReceipt.outcome).toBe('committed');
  const undone = await f.transport(CHANNELS.taskReview, 'undoDecisionBatch', {
    root: f.root, taskId: f.state.taskId, batchId: f.input.batchId, expectedRevision: decided.revision,
  });
  expect(undone.revision).toBe((await f.store.open(f.root)).revision);
  const redone = await f.transport(CHANNELS.taskReview, 'redoDecisionBatch', {
    root: f.root, taskId: f.state.taskId, batchId: f.input.batchId, expectedRevision: undone.revision,
  });
  expect(redone.revision).toBe((await f.store.open(f.root)).revision);
  expect(redone.decisionActions.filter((action: { kind: string }) => action.kind === 'redo')).toHaveLength(3);
});

it('protects all writes after a lost batch reply and only unlocks for the exact verified batch, without replaying', async () => {
  const f = await fixture(); f.control.drop = true;
  await expect(f.transport(CHANNELS.taskReview, 'decideBatch', f.input)).rejects.toThrow('待核对');
  const calls = f.invoke.mock.calls.length;
  await expect(f.transport(CHANNELS.taskReview, 'saveDraft', { root: f.root, taskId: f.state.taskId })).rejects.toThrow('暂停');
  await expect(f.transport(CHANNELS.taskReview, 'undoDecisionBatch', { ...f.input })).rejects.toThrow('暂停');
  expect(f.invoke).toHaveBeenCalledTimes(calls);
  await expect(f.transport(CHANNELS.taskReview, 'getDecisionOutcome', { ...f.query, decisionId: randomUUID() })).rejects.toThrow('身份');
  expect((await f.transport(CHANNELS.taskReview, 'getDecisionOutcome', f.query)).outcome).toBe('committed');
  expect(f.invoke.mock.calls.filter(([, envelope]) => envelope.method === 'decideBatch')).toHaveLength(1);
  expect((await f.store.open(f.root)).decisionActions).toHaveLength(3);
});

it('does not accept a committed receipt missing even one member; an authoritative exact query can recover it', async () => {
  const f = await fixture(); f.control.partial = true;
  await expect(f.transport(CHANNELS.taskReview, 'decideBatch', f.input)).rejects.toThrow('待核对');
  await expect(f.transport(CHANNELS.taskReview, 'setGoal', { root: f.root, taskId: f.state.taskId, goal: 'Must wait' })).rejects.toThrow('暂停');
  expect((await f.transport(CHANNELS.taskReview, 'getDecisionOutcome', f.query)).outcome).toBe('committed');
  expect((await f.store.open(f.root)).decisions).toHaveLength(3);
});

it('rejects changing the payload under a previously committed batch ID and never appends duplicate decisions', async () => {
  const f = await fixture();
  await f.transport(CHANNELS.taskReview, 'decideBatch', f.input);
  await expect(f.transport(CHANNELS.taskReview, 'decideBatch', { ...f.input, expectedRevision: f.state.revision + 1, note: 'Different intent' })).rejects.toThrow('待核对');
  const state = await f.store.open(f.root);
  expect(state.decisions).toHaveLength(3);
  expect(state.decisions.every(decision => decision.note === 'Clean the edge')).toBe(true);
  expect(state.decisionActions).toHaveLength(3);
});

it('returns an explicit validation rejection without poisoning the next corrected human request', async () => {
  const f = await fixture();
  const rejected = await f.transport(CHANNELS.taskReview, 'decideBatch', { ...f.input, note: 'x'.repeat(200001) });
  expect(rejected.decisionReceipt).toMatchObject({ outcome: 'not-committed', rejection: 'validation' });
  expect(rejected.decisions).toEqual([]);
  const corrected = await f.transport(CHANNELS.taskReview, 'decideBatch', { ...f.input, batchId: randomUUID() });
  expect(corrected.decisions).toHaveLength(3);
});

it('rejects untrusted callers and schema attempts to widen the batch authority before persistence', async () => {
  const f = await fixture();
  const handler = ipc.handlers.get(CHANNELS.taskReview)!;
  await expect(handler({ trusted: false }, { method: 'decideBatch', input: f.input })).rejects.toThrow('trusted editor');
  const rejected = await handler({ trusted: true }, { method: 'decideBatch', input: { ...f.input, acceptedBy: 'agent' } });
  expect(rejected.decisionReceipt.outcome).toBe('not-committed');
  expect((await f.store.open(f.root)).decisions).toEqual([]);
  expect(f.changed).not.toHaveBeenCalled();
});

it('allows target-bound read-only previews during outcome recovery while keeping media writes paused', async () => {
  const f = await fixture(); f.control.drop = true;
  await expect(f.transport(CHANNELS.taskReview, 'decideBatch', f.input)).rejects.toThrow('待核对');
  const preview = vi.fn(async () => ({ url: 'app://reelterminal/preview', width: 2, height: 2 }));
  ipc.handlers.set(CHANNELS.taskReviewMedia, preview);
  await f.transport(CHANNELS.taskReviewMedia, 'thumbnail', { root: f.root, taskId: f.state.taskId, ...f.input.targets[0] });
  expect(preview).toHaveBeenCalledTimes(1);
  await expect(f.transport(CHANNELS.taskReviewMedia, 'thumbnail', { root: f.root, taskId: randomUUID() })).rejects.toThrow('目标');
  await expect(f.transport(CHANNELS.taskReviewMedia, 'acceptRegion', { root: f.root, taskId: f.state.taskId })).rejects.toThrow('暂停');
});
