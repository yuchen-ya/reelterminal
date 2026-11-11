import { act, cleanup, renderHook, waitFor, render, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useTaskReviewController } from './useTaskReviewController';
import { useTaskDrafts } from './useTaskDrafts';
import { createFakeTaskReviewBridge } from './testing';
import i18n from '../../../i18n';
import { TaskWriteRecovery } from '../../../../../desktop/src/shared/task-write-recovery';

afterEach(cleanup);

it('translates recovery guidance at display time without changing the pending decision or feedback', async () => {
  const previousLanguage = i18n.language;
  const barrier = new TaskWriteRecovery('locale-fixture');
  const intent = { decisionId: crypto.randomUUID(), unitId: 'unit', sourceVersionId: 'version', purpose: 'review', status: 'kept', note: 'preserve human feedback', revision: 4 };
  barrier.begin(intent); barrier.uncertain(intent);
  try {
    await i18n.changeLanguage('en');
    expect(i18n.t(barrier.state!.message)).toContain('outcome is unknown');
    await i18n.changeLanguage('zh-CN');
    expect(i18n.t(barrier.state!.message)).toContain('保存结果待核对');
    expect(barrier.pending).toEqual(intent);
    expect(barrier.blocked).toBe(true);
  } finally { await i18n.changeLanguage(previousLanguage); }
});
type Mode = 'commit-lost' | 'reject-lost' | 'not-committed' | 'commit' | 'notify-warning';
async function wire(root = 'task-root') {
  const base = createFakeTaskReviewBridge({ root });
  await base.importText({ root, taskId: 'task-1', expectedRevision: 0, name: 'fixture', text: 'first\nsecond', format: 'txt' });
  base.calls.length = 0;
  const realDecide = base.decide;
  const completed = new Map<string, boolean>();
  const control = { mode: 'commit-lost' as Mode, queryFailure: false, queryOverride: null as any, issued: [] as string[], defer: null as Promise<void> | null };
  const bridge: any = base;
  bridge.decide = vi.fn(async (input: any) => {
    control.issued.push(input.decisionId);
    if (control.defer) await control.defer;
    if (control.mode === 'reject-lost') { completed.set(input.decisionId, false); throw new Error('Synthetic lost response before commit'); }
    if (control.mode === 'not-committed') { completed.set(input.decisionId, false); return { ...base.snapshotState(), decisionReceipt: { decisionId: input.decisionId, outcome: 'not-committed' } }; }
    await realDecide(input);
    base.mutateState(state => {
      const last = state.decisions.at(-1)!; const old = last.id; last.id = input.decisionId;
      state.decisionActions.forEach(action => { if (action.decisionId === old) action.decisionId = input.decisionId; });
    });
    completed.set(input.decisionId, true);
    if (control.mode === 'commit-lost') throw new Error('Synthetic lost response after commit');
    return { ...base.snapshotState(), decisionReceipt: { decisionId: input.decisionId, outcome: 'committed', ...(control.mode === 'notify-warning' ? { notificationFailed: true } : {}) } };
  });
  bridge.getDecisionOutcome = vi.fn(async (input: any) => {
    if (control.queryFailure) throw new Error('Synthetic outcome read failure');
    if (control.queryOverride) return control.queryOverride(input);
    return { snapshot: base.snapshotState(), decisionId: input.decisionId, outcome: completed.get(input.decisionId) === true ? 'committed' : completed.get(input.decisionId) === false ? 'not-committed' : 'unknown' };
  });
  const unit = base.snapshotState().units[0];
  return { base, bridge, control, input: { unitId: unit.id, sourceVersionId: unit.sourceVersionId, purpose: 'review', status: 'kept' as const, note: 'human input' } };
}
async function mounted(f: Awaited<ReturnType<typeof wire>>) {
  const hook = renderHook(() => useTaskReviewController(f.base.snapshotState().root, f.bridge));
  await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
  return hook;
}

it('does not mistake an in-flight recovery banner for a finished request or unlock from unknown evidence', async () => {
  const f = await wire(); const hook = await mounted(f);
  let release!: () => void;
  f.control.defer = new Promise<void>(resolve => { release = resolve; });
  let pending!: ReturnType<typeof hook.result.current.decide>;
  act(() => { pending = hook.result.current.decide(f.input); });
  try {
    await waitFor(() => expect(f.bridge.decide).toHaveBeenCalledTimes(1));
    expect(hook.result.current.recovery?.outcome).toBe('unknown');
    expect(hook.result.current.busy).toBe(true);
    await act(async () => { expect((await hook.result.current.reconcileDecision()).ok).toBe(false); });
    expect(hook.result.current.writesBlocked).toBe(true);
    expect(f.base.snapshotState().decisions).toHaveLength(0);
  } finally { await act(async () => { release(); await pending; }); }
  await act(async () => { expect((await hook.result.current.reconcileDecision()).ok).toBe(true); });
  expect(hook.result.current.recovery?.outcome).toBe('committed');
  expect(f.bridge.decide).toHaveBeenCalledTimes(1);
  expect(f.base.snapshotState().decisions).toHaveLength(1);
  expect(f.base.snapshotState().decisionActions).toHaveLength(1);
});

it('blocks queued and new programmatic writes at the actual controller entry after an unknown decision result', async () => {
  const f = await wire(); const hook = await mounted(f);
  let queued: any[] = [];
  await act(async () => {
    queued = await Promise.all([hook.result.current.decide(f.input), hook.result.current.setGoal('queued goal'), hook.result.current.saveDraft({ unitId: f.input.unitId, sourceVersionId: f.input.sourceVersionId, text: 'queued stale text', selectionStart: 0, selectionEnd: 0 })]);
  });
  expect(queued.map(x => x.ok)).toEqual([false, false, false]);
  expect(hook.result.current.writesBlocked).toBe(true);
  expect(f.base.calls.filter(x => x.method === 'setGoal' || x.method === 'saveDraft')).toHaveLength(0);
  await act(async () => {
    expect((await hook.result.current.decide(f.input)).ok).toBe(false);
    expect((await hook.result.current.importText({ name: 'blocked', text: 'x', format: 'txt' })).ok).toBe(false);
    expect((await hook.result.current.refreshSources()).ok).toBe(false);
    expect((await hook.result.current.visit({ ...f.input })).ok).toBe(false);
    await hook.result.current.pollSources();
    await expect(hook.result.current.importMedia('blocked')).rejects.toThrow('暂停');
    await expect(hook.result.current.executeOriginalExport({ root: 'task-root', taskId: 'task-1', expectedRevision: 2, exportId: 'blocked' })).rejects.toThrow('暂停');
  });
  expect(f.bridge.decide).toHaveBeenCalledTimes(1);
  expect(f.base.snapshotState().decisions).toHaveLength(1);
});

it('does not unlock on ordinary refresh or failed verification, then recognizes only this exact committed ID and cancels old callbacks', async () => {
  const f = await wire(); const hook = await mounted(f);
  const staleSave = hook.result.current.saveDraft;
  await act(async () => { await hook.result.current.decide(f.input); });
  f.control.queryFailure = true;
  await act(async () => { await hook.result.current.refresh(); expect((await hook.result.current.reconcileDecision()).ok).toBe(false); });
  expect(hook.result.current.writesBlocked).toBe(true);
  f.control.queryFailure = false;
  await act(async () => { expect((await hook.result.current.reconcileDecision()).ok).toBe(true); });
  expect(hook.result.current.writesBlocked).toBe(false);
  expect(hook.result.current.recovery?.outcome).toBe('committed');
  await act(async () => { expect((await staleSave({ unitId: f.input.unitId, sourceVersionId: f.input.sourceVersionId, text: 'late stale callback', selectionStart: 0, selectionEnd: 0 })).ok).toBe(false); });
  expect(f.base.calls.filter(x => x.method === 'saveDraft')).toHaveLength(0);
  expect(f.bridge.decide).toHaveBeenCalledTimes(1);
  expect(f.base.snapshotState().decisionActions).toHaveLength(1);
});

it('keeps changed local draft text and selection through failed verification and rejects an autosave timer scheduled before recovery', async () => {
  const f = await wire();
  const hook = renderHook(() => { const controller = useTaskReviewController('task-root', f.bridge); const drafts = useTaskDrafts(controller.snapshot, controller); return { controller, drafts }; });
  await waitFor(() => expect(hook.result.current.controller.snapshot).not.toBeNull());
  await act(async () => { await hook.result.current.controller.decide(f.input); });
  act(() => hook.result.current.drafts.updateDraft(f.input.unitId, f.input.sourceVersionId, { text: 'newer local input', selectionStart: 3, selectionEnd: 8 }));
  f.control.queryFailure = true;
  await act(async () => { await hook.result.current.controller.reconcileDecision(); });
  expect(hook.result.current.drafts.drafts[f.input.unitId]).toMatchObject({ text: 'newer local input', selectionStart: 3, selectionEnd: 8 });
  f.control.queryFailure = false;
  await act(async () => { await hook.result.current.controller.reconcileDecision(); });
  await waitFor(() => expect(hook.result.current.drafts.drafts[f.input.unitId]?.status).toBe('error'), { timeout: 2000 });
  expect(f.base.calls.filter(x => x.method === 'saveDraft')).toHaveLength(0);
  await act(async () => { await hook.result.current.drafts.retry(f.input.unitId); });
  expect(f.base.snapshotState().drafts.at(-1)).toMatchObject({ text: 'newer local input', selectionStart: 3, selectionEnd: 8 });
  expect(f.base.snapshotState().decisions).toHaveLength(1);
});

it('accepts an authoritative not-committed receipt without retrying the decision, then permits one explicit new request', async () => {
  const f = await wire(); f.control.mode = 'not-committed'; const hook = await mounted(f);
  await act(async () => { expect((await hook.result.current.decide(f.input)).ok).toBe(false); });
  expect(hook.result.current.recovery?.outcome).toBe('not-committed');
  expect(f.bridge.decide).toHaveBeenCalledTimes(1); expect(f.base.snapshotState().decisions).toHaveLength(0);
  f.control.mode = 'commit';
  await act(async () => { expect((await hook.result.current.decide(f.input)).ok).toBe(true); });
  expect(new Set(f.control.issued).size).toBe(2);
  expect(f.base.snapshotState().decisions).toHaveLength(1); expect(f.base.snapshotState().decisionActions).toHaveLength(1);
});

it.each(['root', 'task', 'revision', 'unknown'])('does not unlock for mismatched or insufficient %s evidence', async kind => {
  const f = await wire(); f.control.mode = 'reject-lost'; const hook = await mounted(f);
  await act(async () => { await hook.result.current.decide(f.input); });
  f.control.queryOverride = (input: any) => ({ decisionId: input.decisionId, outcome: kind === 'unknown' ? 'unknown' : 'not-committed', snapshot: { ...f.base.snapshotState(), ...(kind === 'root' ? { root: 'another-root' } : {}), ...(kind === 'task' ? { taskId: 'another-task' } : {}), revision: kind === 'revision' ? 0 : f.base.snapshotState().revision + 1 } });
  await act(async () => { expect((await hook.result.current.reconcileDecision()).ok).toBe(false); });
  expect(hook.result.current.writesBlocked).toBe(true);
  expect(hook.result.current.snapshot?.root).toBe('task-root');
});

it('preserves an unresolved barrier across unmount/reopen and never replays a pending intent on mount', async () => {
  const f = await wire(); const first = await mounted(f);
  await act(async () => { await first.result.current.decide(f.input); });
  first.unmount(); const second = await mounted(f);
  expect(second.result.current.writesBlocked).toBe(true);
  expect(f.bridge.decide).toHaveBeenCalledTimes(1);
  await act(async () => { await second.result.current.reconcileDecision(); });
  expect(second.result.current.recovery?.outcome).toBe('committed');
  expect(f.base.snapshotState().decisionActions).toHaveLength(1);
});

it('never applies an old asynchronous decision result or callback to another task after a root switch', async () => {
  const a = await wire('root-a'), b = await wire('root-b'); b.control.mode = 'commit';
  let release!: () => void; a.control.defer = new Promise<void>(resolve => { release = resolve; });
  const hook = renderHook(({ root, bridge }) => useTaskReviewController(root, bridge), { initialProps: { root: 'root-a', bridge: a.bridge } });
  await waitFor(() => expect(hook.result.current.snapshot?.root).toBe('root-a'));
  const stale = hook.result.current.setGoal;
  let pending!: Promise<any>;
  act(() => { pending = hook.result.current.decide(a.input); });
  await waitFor(() => expect(a.bridge.decide).toHaveBeenCalledTimes(1));
  hook.rerender({ root: 'root-b', bridge: b.bridge });
  await waitFor(() => expect(hook.result.current.snapshot?.root).toBe('root-b'));
  await act(async () => { release(); await pending; expect((await stale('wrong task write')).ok).toBe(false); });
  expect(hook.result.current.snapshot?.root).toBe('root-b');
  expect(b.base.snapshotState().goal).toBe('');
});

it('keeps a verified notification failure distinct from a failed decision and allows normal queued writes', async () => {
  const f = await wire(); f.control.mode = 'notify-warning'; const hook = await mounted(f);
  await act(async () => { const results = await Promise.all([hook.result.current.decide(f.input), hook.result.current.setGoal('after committed decision')]); expect(results.every(x => x.ok)).toBe(true); });
  expect(hook.result.current.writesBlocked).toBe(false);
  expect(hook.result.current.recovery?.outcome).toBe('committed');
  expect(f.base.snapshotState().decisions).toHaveLength(1);
  expect(f.base.snapshotState().goal).toBe('after committed decision');
});

it('blocks repeat mouse, keyboard and direct handler submissions through the same mutation entry while unresolved', async () => {
  const f = await wire(); let current: ReturnType<typeof useTaskReviewController>;
  function Harness() { const controller = useTaskReviewController('task-root', f.bridge); current = controller; return <button onClick={() => void controller.decide(f.input)} onKeyDown={event => { if (event.key === 'Enter') void controller.decide(f.input); }}>Keep</button>; }
  render(<Harness />);
  await waitFor(() => expect(current!.snapshot).not.toBeNull());
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(current!.writesBlocked).toBe(true));
  fireEvent.click(screen.getByRole('button')); fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
  await act(async () => { expect((await current!.decide(f.input)).ok).toBe(false); });
  expect(f.bridge.decide).toHaveBeenCalledTimes(1);
});

it('queues a normal autosave during an in-flight successful decision instead of falsely failing or overwriting input', async () => {
  const f = await wire(); f.control.mode = 'commit';
  let release!: () => void; f.control.defer = new Promise<void>(resolve => { release = resolve; });
  const hook = await mounted(f); let deciding!: Promise<any>, saving!: Promise<any>;
  act(() => { deciding = hook.result.current.decide(f.input); });
  await waitFor(() => expect(f.bridge.decide).toHaveBeenCalledTimes(1));
  act(() => { saving = hook.result.current.saveDraft({ unitId: f.input.unitId, sourceVersionId: f.input.sourceVersionId, text: 'new input while saving', selectionStart: 2, selectionEnd: 7 }); });
  expect(f.base.calls.filter(call => call.method === 'saveDraft')).toHaveLength(0);
  await act(async () => { release(); expect((await deciding).ok).toBe(true); expect((await saving).ok).toBe(true); });
  expect(f.base.snapshotState().decisions).toHaveLength(1);
  expect(f.base.snapshotState().drafts.at(-1)).toMatchObject({ text: 'new input while saving', selectionStart: 2, selectionEnd: 7 });
});
