import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskReviewStore } from '../main/task-review-store';
import { registerTaskReviewIpc } from '../main/ipc/task-review';
import { createTaskReviewTransport } from './task-review-write-transport';
import { CHANNELS } from '../shared/channels';
const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<any>>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<any>) => ipc.handlers.set(name, handler) } }));
vi.mock('../main/ipc/index', () => ({ assertEditorIpcSender: () => {} }));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preload-recovery-')); roots.push(root);
  const store = new TaskReviewStore(); let state = await store.open(root);
  state = await store.importText({ root, taskId: state.taskId, expectedRevision: state.revision, name: 'line', text: 'fixture source', format: 'txt' });
  registerTaskReviewIpc(store, async () => {});
  const control = { drop: true, queryFail: false, beforeDispatch: false };
  const invoke = vi.fn(async (channel: string, envelope: { method: string; input: unknown }) => {
    if (envelope.method === 'getDecisionOutcome' && control.queryFail) throw new Error('controlled query failure');
    if (envelope.method === 'decide' && control.drop && control.beforeDispatch) throw new Error('controlled response loss before delivery');
    const result = await ipc.handlers.get(channel)!({}, envelope);
    if (envelope.method === 'decide' && control.drop) throw new Error('controlled response loss after commit');
    return result;
  });
  const transport = createTaskReviewTransport(invoke);
  const input = { root, taskId: state.taskId, expectedRevision: state.revision, unitId: state.units[0].id, sourceVersionId: state.units[0].sourceVersionId, purpose: 'review', status: 'kept', note: 'human note', decisionId: randomUUID() };
  return { root, store, state, control, invoke, transport, input };
}

it('public preload entry blocks direct decisions, autosaves, context, export and media writes after a lost reply; open alone never unlocks', async () => {
  const f = await fixture();
  await expect(f.transport(CHANNELS.taskReview, 'decide', f.input)).rejects.toThrow('待核对');
  const calls = f.invoke.mock.calls.length;
  for (const [channel, method] of [[CHANNELS.taskReview, 'decide'], [CHANNELS.taskReview, 'saveDraft'], [CHANNELS.taskReviewContext, 'adoptContext'], [CHANNELS.taskReviewExport, 'execute'], [CHANNELS.taskReviewMedia, 'acceptRegion']]) {
    await expect(f.transport(channel, method, { ...f.input, decisionId: randomUUID() })).rejects.toThrow('暂停');
  }
  expect(f.invoke).toHaveBeenCalledTimes(calls);
  await f.transport(CHANNELS.taskReview, 'open', { root: f.root });
  await expect(f.transport(CHANNELS.taskReview, 'decide', f.input)).rejects.toThrow('暂停');
  expect(JSON.parse(await fs.readFile(path.join(f.root, '.reelterminal/task-review.json'), 'utf8')).decisions).toHaveLength(1);
});

it('keeps the public gate through failed/mismatched reads and releases only for the exact verified committed request, without replay', async () => {
  const f = await fixture();
  await expect(f.transport(CHANNELS.taskReview, 'decide', f.input)).rejects.toThrow('待核对');
  f.control.queryFail = true;
  await expect(f.transport(CHANNELS.taskReview, 'getDecisionOutcome', f.input)).rejects.toThrow('query failure');
  f.control.queryFail = false;
  await expect(f.transport(CHANNELS.taskReview, 'getDecisionOutcome', { root: f.root, taskId: f.state.taskId, decisionId: randomUUID() })).rejects.toThrow('身份');
  const result = await f.transport(CHANNELS.taskReview, 'getDecisionOutcome', { root: f.root, taskId: f.state.taskId, decisionId: f.input.decisionId });
  expect(result.outcome).toBe('committed');
  expect(f.invoke.mock.calls.filter(([, envelope]) => envelope.method === 'decide')).toHaveLength(1);
  expect((await new TaskReviewStore().open(f.root)).decisionActions).toHaveLength(1);
});

it('does not guess non-commit when a request never reached the server and no completion proof exists', async () => {
  const f = await fixture(); f.control.beforeDispatch = true;
  await expect(f.transport(CHANNELS.taskReview, 'decide', f.input)).rejects.toThrow('待核对');
  await expect(f.transport(CHANNELS.taskReview, 'getDecisionOutcome', { root: f.root, taskId: f.state.taskId, decisionId: f.input.decisionId })).rejects.toThrow('无法确认');
  await expect(f.transport(CHANNELS.taskReview, 'setGoal', { root: f.root, taskId: f.state.taskId, goal: 'must not dispatch' })).rejects.toThrow('暂停');
  expect((await f.store.open(f.root)).decisions).toHaveLength(0);
});

it('keeps a still-running decision blocked through an early unknown query, then verifies its exact completed commit', async () => {
  const f = await fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (channel, envelope) => {
    if (envelope.method === 'decide') await held;
    return original(channel, envelope);
  });
  const pending = f.transport(CHANNELS.taskReview, 'decide', f.input);
  const rejected = expect(pending).rejects.toThrow('待核对');
  const query = { root: f.root, taskId: f.state.taskId, decisionId: f.input.decisionId };
  try {
    await expect(f.transport(CHANNELS.taskReview, 'getDecisionOutcome', query)).rejects.toThrow('仍无法确认');
    await expect(f.transport(CHANNELS.taskReview, 'setGoal', { ...f.input, goal: 'must remain blocked' })).rejects.toThrow('暂停');
    expect((await f.store.open(f.root)).decisions).toHaveLength(0);
  } finally { release(); }
  await rejected;
  const checked = await f.transport(CHANNELS.taskReview, 'getDecisionOutcome', query);
  expect(checked.outcome).toBe('committed');
  expect(f.invoke.mock.calls.filter(([, envelope]) => envelope.method === 'decide')).toHaveLength(1);
  const durable = JSON.parse(await fs.readFile(path.join(f.root, '.reelterminal/task-review.json'), 'utf8'));
  expect(durable.decisions).toHaveLength(1); expect(durable.decisionActions).toHaveLength(1);
});

it.skipIf(process.platform !== 'win32')('known pre-commit denial safely releases the transport for one explicit retry with a fresh ID', async () => {
  const f = await fixture(); f.control.drop = false;
  const file = path.join(f.root, '.reelterminal/task-review.json');
  const reader = await fs.open(file, 'r');
  try {
    const reply = await f.transport(CHANNELS.taskReview, 'decide', f.input);
    expect(reply.decisionReceipt.outcome).toBe('not-committed');
  } finally { await reader.close(); }
  const retry = await f.transport(CHANNELS.taskReview, 'decide', { ...f.input, decisionId: randomUUID() });
  expect(retry.decisionReceipt.outcome).toBe('committed');
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(disk.decisions).toHaveLength(1); expect(disk.decisionActions).toHaveLength(1);
});

it.skipIf(process.platform !== 'win32')('holds an unknown result through failed checking, then proves non-commit and accepts one explicit retry', async () => {
  const f = await fixture();
  const file = path.join(f.root, '.reelterminal/task-review.json');
  const original = await fs.readFile(file, 'utf8');
  const reader = await fs.open(file, 'r');
  try { await expect(f.transport(CHANNELS.taskReview, 'decide', f.input)).rejects.toThrow('待核对'); }
  finally { await reader.close(); }
  expect(await fs.readFile(file, 'utf8')).toBe(original);
  f.control.queryFail = true;
  await expect(f.transport(CHANNELS.taskReview, 'getDecisionOutcome', { root: f.root, taskId: f.state.taskId, decisionId: f.input.decisionId })).rejects.toThrow('query failure');
  await expect(f.transport(CHANNELS.taskReview, 'decide', f.input)).rejects.toThrow('暂停');
  f.control.queryFail = false;
  const checked = await f.transport(CHANNELS.taskReview, 'getDecisionOutcome', { root: f.root, taskId: f.state.taskId, decisionId: f.input.decisionId });
  expect(checked.outcome).toBe('not-committed');
  f.control.drop = false;
  await f.transport(CHANNELS.taskReview, 'decide', { ...f.input, decisionId: randomUUID() });
  const reopened = await new TaskReviewStore().open(f.root);
  expect(reopened.decisions).toHaveLength(1); expect(reopened.decisionActions).toHaveLength(1);
});

it('allows only target-bound transient cancellation while state writes stay blocked', async () => {
  const f = await fixture();
  await expect(f.transport(CHANNELS.taskReview, 'decide', f.input)).rejects.toThrow('待核对');
  const cleanup = vi.fn(async () => {});
  ipc.handlers.set(CHANNELS.taskReviewMedia, cleanup);
  await expect(f.transport(CHANNELS.taskReviewMedia, 'cancel', { root: f.root, taskId: randomUUID(), generationId: randomUUID() })).rejects.toThrow('目标');
  await f.transport(CHANNELS.taskReviewMedia, 'cancel', { root: f.root, taskId: f.state.taskId, generationId: randomUUID() });
  expect(cleanup).toHaveBeenCalledTimes(1);
  await expect(f.transport(CHANNELS.taskReviewMedia, 'acceptRegion', { root: f.root, taskId: f.state.taskId })).rejects.toThrow('暂停');
  expect((await f.store.open(f.root)).decisions).toHaveLength(1);
});

it('reports a known validation rejection without poisoning recovery, then accepts an explicit corrected request', async () => {
  const f = await fixture(); f.control.drop = false;
  const rejected = await f.transport(CHANNELS.taskReview, 'decide', { ...f.input, note: 'x'.repeat(200001) });
  expect(rejected.decisionReceipt).toMatchObject({ outcome: 'not-committed', rejection: 'validation' });
  const accepted = await f.transport(CHANNELS.taskReview, 'decide', { ...f.input, decisionId: randomUUID() });
  expect(accepted.decisions).toHaveLength(1); expect(accepted.decisionActions).toHaveLength(1);
});

it('uses the shared schema normalization when binding exact decision evidence', async () => {
  const f = await fixture(); f.control.drop = false;
  const result = await f.transport(CHANNELS.taskReview, 'decide', { ...f.input, purpose: ' review ' });
  expect(result.decisionReceipt.outcome).toBe('committed');
  expect(result.decisions[0].purpose).toBe('review');
});

it('never reports a reused exact ID as a new changed payload or appends a second decision', async () => {
  const f = await fixture(); f.control.drop = false;
  await f.transport(CHANNELS.taskReview, 'decide', f.input);
  await expect(f.transport(CHANNELS.taskReview, 'decide', { ...f.input, expectedRevision: f.state.revision + 1, note: 'different intent must have another ID' })).rejects.toThrow('待核对');
  const state = await new TaskReviewStore().open(f.root);
  expect(state.decisions).toHaveLength(1); expect(state.decisions[0].note).toBe('human note');
  expect(state.decisionActions).toHaveLength(1);
});

it('allocates missing request IDs through browser crypto available to sandboxed preload', async () => {
  const f = await fixture(); f.control.drop = false;
  const id = randomUUID();
  const browserRandom = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(id);
  try {
    const result = await f.transport(CHANNELS.taskReview, 'decide', { ...f.input, decisionId: undefined });
    expect(browserRandom).toHaveBeenCalledOnce();
    expect(result.decisionReceipt).toMatchObject({ outcome: 'committed', decisionId: id });
    expect(result.decisions[0].id).toBe(id);
  } finally { browserRandom.mockRestore(); }
});
