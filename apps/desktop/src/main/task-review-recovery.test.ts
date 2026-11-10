import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskReviewStore } from './task-review-store';
import { registerTaskReviewIpc } from './ipc/task-review';
import { CHANNELS } from '../shared/channels';

const transport = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<any>>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<any>) => transport.handlers.set(name, handler) } }));
vi.mock('./ipc/index', () => ({ assertEditorIpcSender: () => {} }));
vi.mock('node:fs/promises', async original => { const real = await original<typeof import('node:fs/promises')>(); return { ...real, rename: vi.fn(real.rename) }; });
const roots: string[] = [];
afterEach(async () => { const real = await vi.importActual<typeof fs>('node:fs/promises'); vi.mocked(fs.rename).mockImplementation(real.rename); await Promise.all(roots.splice(0).map(root => real.rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-gate-')); roots.push(root);
  const store = new TaskReviewStore();
  let state = await store.open(root);
  state = await store.importText({ root, taskId: state.taskId, expectedRevision: state.revision, name: 'line', text: 'synthetic source', format: 'txt' });
  state = await store.saveDraft({ root, taskId: state.taskId, expectedRevision: state.revision, draft: { unitId: state.units[0].id, sourceVersionId: state.units[0].sourceVersionId, text: 'human feedback', selectionStart: 2, selectionEnd: 5 } });
  const input = { root, taskId: state.taskId, expectedRevision: state.revision, unitId: state.units[0].id, sourceVersionId: state.units[0].sourceVersionId, purpose: 'review', status: 'kept' as const, note: 'human feedback', decisionId: randomUUID() };
  return { root, store, state, input, destination: path.join(root, '.reelterminal/task-review.json') };
}
const invoke = (method: string, input: unknown) => transport.handlers.get(CHANNELS.taskReview)!({}, { method, input });

it('returns a committed snapshot and a bounded notification warning after durable save, never a fake decision failure', async () => {
  const f = await fixture();
  registerTaskReviewIpc(f.store, async () => { throw Object.assign(new Error('synthetic notification denial'), { code: 'EPERM' }); });
  const result = await invoke('decide', f.input);
  expect(result.decisionReceipt).toEqual({ decisionId: f.input.decisionId, outcome: 'committed', notificationFailed: true });
  const disk = JSON.parse(await fs.readFile(f.destination, 'utf8'));
  expect(disk.decisions.map((x: { id: string }) => x.id)).toEqual([f.input.decisionId]);
  expect(disk.decisionActions).toHaveLength(1);
  expect(disk).not.toHaveProperty('decisionReceipt');
  expect((await new TaskReviewStore().open(f.root)).decisions).toHaveLength(1);
});

it.skipIf(process.platform !== 'win32')('reports known pre-commit rejection under a real persistent reader, preserves bytes/revision/draft, and allows exactly one explicit new attempt', async () => {
  const f = await fixture();
  registerTaskReviewIpc(f.store, async () => {});
  const bytes = await fs.readFile(f.destination, 'utf8');
  const reader = await fs.open(f.destination, 'r');
  try {
    const result = await invoke('decide', f.input);
    expect(result.decisionReceipt.outcome).toBe('not-committed');
    expect(await fs.readFile(f.destination, 'utf8')).toBe(bytes);
    expect(result.revision).toBe(f.state.revision);
    expect(result.drafts).toEqual(f.state.drafts);
    expect(result.decisions).toHaveLength(0);
    expect((await fs.readdir(path.dirname(f.destination))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  } finally { await reader.close(); }
  const retried = await invoke('decide', { ...f.input, decisionId: randomUUID() });
  expect(retried.decisionReceipt.outcome).toBe('committed');
  expect(retried.decisions).toHaveLength(1);
  expect(retried.decisionActions).toHaveLength(1);
  expect(retried.revision).toBe(f.state.revision + 1);
  const reopened = await new TaskReviewStore().open(f.root);
  expect(reopened.decisions).toEqual(retried.decisions);
  const child = JSON.parse(execFileSync(process.execPath, ['-e', 'const fs=require("node:fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify({revision:x.revision,decisions:x.decisions.length,actions:x.decisionActions.length}))', f.destination], { encoding: 'utf8', windowsHide: true }));
  expect(child).toEqual({ revision: retried.revision, decisions: 1, actions: 1 });
});

it('waits for the exact in-flight request and proves committed status using its existing decision/action ID', async () => {
  const f = await fixture();
  const real = await vi.importActual<typeof fs>('node:fs/promises');
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(fs.rename).mockImplementation(async (from, to) => { if (String(to) === f.destination) { started(); await proceed; } await real.rename(from, to); });
  const saving = f.store.decide(f.input);
  await ready;
  let resolved = false;
  const query = f.store.getDecisionOutcome({ root: f.root, taskId: f.state.taskId, decisionId: f.input.decisionId }).then(result => { resolved = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(resolved).toBe(false);
  release(); await saving;
  const result = await query;
  expect(result.outcome).toBe('committed');
  expect(result.snapshot.decisions[0].id).toBe(f.input.decisionId);
});

it('does not confuse equal-content history or revision movement with this request, and rejects a wrong task', async () => {
  const f = await fixture();
  await f.store.decide(f.input);
  const unknown = await f.store.getDecisionOutcome({ root: f.root, taskId: f.state.taskId, decisionId: randomUUID() });
  expect(unknown.outcome).toBe('unknown');
  expect(unknown.snapshot.revision).toBeGreaterThan(f.state.revision);
  await expect(f.store.getDecisionOutcome({ root: f.root, taskId: randomUUID(), decisionId: f.input.decisionId })).rejects.toThrow('Task identity');
});

it('never appends a second decision when an exact request identity is sent again', async () => {
  const f = await fixture();
  const saved = await f.store.decide(f.input);
  await expect(f.store.decide({ ...f.input, expectedRevision: saved.revision })).rejects.toThrow('tracked');
  expect((await f.store.getDecisionOutcome({ root: f.root, taskId: f.state.taskId, decisionId: f.input.decisionId })).outcome).toBe('committed');
  const disk = JSON.parse(await fs.readFile(f.destination, 'utf8'));
  expect(disk.decisions).toHaveLength(1); expect(disk.decisionActions).toHaveLength(1);
});

it('allows a caller-authorized short sharing window to finish without replaying a business decision', async () => {
  const f = await fixture();
  const real = await vi.importActual<typeof fs>('node:fs/promises');
  const reader = await real.open(f.destination, 'r');
  await reader.close();
  const saved = await f.store.decide(f.input);
  expect(saved.decisions).toHaveLength(1); expect(saved.decisionActions).toHaveLength(1);
});

it('returns the latest same-task snapshot after a successful follow-up revision, so the next write does not start stale', async () => {
  const f = await fixture();
  registerTaskReviewIpc(f.store, async () => {
    const current = await f.store.open(f.root);
    await f.store.visit({ root: f.root, taskId: current.taskId, expectedRevision: current.revision, unitId: f.input.unitId, sourceVersionId: f.input.sourceVersionId, purpose: 'review' });
  });
  const result = await invoke('decide', f.input);
  const disk = JSON.parse(await fs.readFile(f.destination, 'utf8'));
  expect(result.revision).toBe(disk.revision);
  expect(result.revision).toBe(f.state.revision + 2);
  expect(result.decisionReceipt.outcome).toBe('committed');
});

it('keeps a known committed decision successful when only the post-commit state refresh fails', async () => {
  const f = await fixture(); let denyRead = false;
  const realOpen = f.store.open.bind(f.store);
  vi.spyOn(f.store, 'open').mockImplementation(root => denyRead ? Promise.reject(new Error('controlled follow-up read denied')) : realOpen(root));
  registerTaskReviewIpc(f.store, async () => { denyRead = true; });
  const result = await invoke('decide', f.input);
  expect(result.decisionReceipt).toMatchObject({ outcome: 'committed', refreshFailed: true });
  expect(result.decisionReceipt.notificationFailed).toBeUndefined();
  expect(JSON.parse(await fs.readFile(f.destination, 'utf8')).decisions).toHaveLength(1);
  denyRead = false;
  expect((await f.store.getDecisionOutcome({ root: f.root, taskId: f.state.taskId, decisionId: f.input.decisionId })).outcome).toBe('committed');
});
