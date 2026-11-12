import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TaskBatchDecisionInput, TaskDecisionReply } from '../../../../../desktop/src/shared/task-review-bridge';
import type { TaskMediaOpenResult, TaskReviewMediaBridge } from '../../../../../desktop/src/shared/task-review-media';
import { createFakeTaskReviewBridge } from './testing';
import { useTaskReviewController } from './useTaskReviewController';

afterEach(cleanup);
function fixture() {
  const sourceId = crypto.randomUUID();
  const entryId = crypto.randomUUID();
  const bridge = createFakeTaskReviewBridge({
    taskId: crypto.randomUUID(),
    sources: [{ id: sourceId, entryId, relativePath: 'image.png', hash: 'a'.repeat(64), createdAt: 0, kind: 'image', mime: 'image/png', width: 2, height: 2, durationSec: 0 }],
    sourceFiles: [{ entryId, relativePath: 'image.png', size: 10, mtimeMs: 1, currentVersionId: sourceId, status: 'available' }],
    units: [0, 1, 2].map(() => ({ id: crypto.randomUUID(), sourceVersionId: sourceId, ordinal: 1, kind: 'image' })),
  });
  const decideBatch = vi.fn(async (input: TaskBatchDecisionInput): Promise<TaskDecisionReply> => {
    bridge.mutateState(state => {
      if (input.expectedRevision !== state.revision) throw new Error('Revision conflict');
      for (const target of input.targets) {
        state.decisions.push({ id: target.decisionId, unitId: target.unitId, sourceVersionId: target.sourceVersionId, purpose: input.purpose, status: input.status, note: input.note, policyRevision: state.policyRevision, createdAt: 1 });
        state.decisionActions.push({ id: crypto.randomUUID(), kind: 'decide', decisionId: target.decisionId, createdAt: 1 });
      }
      (state.decisionBatches ??= []).push({ id: input.batchId, decisionIds: input.targets.map(target => target.decisionId) });
      state.revision++;
    });
    return { ...bridge.snapshotState(), decisionReceipt: { decisionId: input.batchId, outcome: 'committed' } };
  });
  bridge.decideBatch = decideBatch;
  const input = { targets: bridge.snapshotState().units.map(unit => ({ unitId: unit.id, sourceVersionId: unit.sourceVersionId })), purpose: ' review ', status: 'rework' as const, note: 'Clean the edge', pendingOnly: true };
  return { bridge, decideBatch, input };
}

it('queues an entire batch after edits, normalizes its purpose and returns its exact batch identity', async () => {
  const f = fixture();
  const hook = renderHook(() => useTaskReviewController('task-root', f.bridge));
  await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
  await act(async () => {
    const goal = hook.result.current.setGoal('Review image edges');
    const batch = hook.result.current.decideBatch(f.input);
    await goal;
    const result = await batch;
    expect(result.ok).toBe(true);
    expect(result.batchId).toBe(f.decideBatch.mock.calls[0][0].batchId);
  });
  expect(f.decideBatch).toHaveBeenCalledTimes(1);
  expect(f.decideBatch.mock.calls[0][0]).toMatchObject({ expectedRevision: 1, purpose: 'review', note: 'Clean the edge', pendingOnly: true });
  expect(hook.result.current.snapshot?.decisions).toHaveLength(3);
  expect(hook.result.current.writesBlocked).toBe(false);
});

it('never retries a batch decision on a revision conflict and requires exact non-commit verification', async () => {
  const f = fixture();
  f.decideBatch.mockImplementation(async () => { f.bridge.mutateState(state => { state.revision++; }); throw new Error('Revision conflict'); });
  f.bridge.getDecisionOutcome = vi.fn(async input => ({ snapshot: f.bridge.snapshotState(), decisionId: input.decisionId, outcome: 'not-committed' as const }));
  const hook = renderHook(() => useTaskReviewController('task-root', f.bridge));
  await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
  await act(async () => { expect((await hook.result.current.decideBatch(f.input)).ok).toBe(false); });
  expect(f.decideBatch).toHaveBeenCalledTimes(1);
  expect(hook.result.current.writesBlocked).toBe(true);
  await act(async () => { expect((await hook.result.current.reconcileDecision()).ok).toBe(true); });
  expect(hook.result.current.writesBlocked).toBe(false);
  expect(hook.result.current.snapshot?.decisions).toEqual([]);
});

it('rejects an incomplete committed batch snapshot and recovers only from all exact members', async () => {
  const f = fixture();
  const save = f.decideBatch.getMockImplementation()!;
  f.decideBatch.mockImplementation(async input => { const result = await save(input); return { ...result, decisions: result.decisions.slice(0, -1) }; });
  f.bridge.getDecisionOutcome = vi.fn(async input => ({ snapshot: f.bridge.snapshotState(), decisionId: input.decisionId, outcome: 'committed' as const }));
  const hook = renderHook(() => useTaskReviewController('task-root', f.bridge));
  await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
  await act(async () => { expect((await hook.result.current.decideBatch(f.input)).ok).toBe(false); });
  expect(hook.result.current.writesBlocked).toBe(true);
  await act(async () => { expect((await hook.result.current.reconcileDecision()).ok).toBe(true); });
  expect(hook.result.current.snapshot?.decisions).toHaveLength(3);
  expect(f.decideBatch).toHaveBeenCalledTimes(1);
});

it('keeps media preparation and batch decisions on the same queue while previews remain read-only', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const initial = f.bridge.snapshotState();
  const source = initial.sources[0]; const unit = initial.units[0];
  const target = { root: initial.root, taskId: initial.taskId, sourceVersionId: source.id, unitId: unit.id };
  const thumbnail = vi.fn(async () => ({ url: 'app://reelterminal/preview', width: 2, height: 2 }));
  const media = {
    thumbnail,
    open: vi.fn(async () => {
      await held;
      f.bridge.mutateState(state => { state.revision++; });
      return { snapshot: f.bridge.snapshotState(), source, unit, url: 'app://reelterminal/prepared', width: 2, height: 2 } as TaskMediaOpenResult;
    }),
  } as unknown as TaskReviewMediaBridge;
  const hook = renderHook(() => useTaskReviewController('task-root', f.bridge, null, null, media));
  await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
  await act(async () => { await hook.result.current.thumbnailMedia(target); });
  expect(hook.result.current.busy).toBe(false);
  expect(hook.result.current.snapshot?.revision).toBe(0);
  let opened!: Promise<TaskMediaOpenResult>;
  let batch!: ReturnType<typeof hook.result.current.decideBatch>;
  await act(async () => { opened = hook.result.current.openMedia(target); batch = hook.result.current.decideBatch(f.input); });
  expect(hook.result.current.busy).toBe(true);
  expect(f.decideBatch).not.toHaveBeenCalled();
  await act(async () => { release(); await opened; expect((await batch).ok).toBe(true); });
  expect(f.decideBatch.mock.calls[0][0].expectedRevision).toBe(1);
  expect(hook.result.current.snapshot?.revision).toBe(2);
  expect(thumbnail).toHaveBeenCalledTimes(1);
  await expect(hook.result.current.thumbnailMedia({ ...target, taskId: crypto.randomUUID() })).rejects.toThrow(/target changed|目标已变化/);
});

it('coalesces source polling instead of building a scan backlog behind a human action', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const refresh = vi.spyOn(f.bridge, 'refreshSources').mockImplementation(async () => { await held; return f.bridge.snapshotState(); });
  const hook = renderHook(() => useTaskReviewController('task-root', f.bridge));
  await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
  let first!: Promise<void>;
  await act(async () => { first = hook.result.current.pollSources(); await hook.result.current.pollSources(); });
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => { release(); await first; });
  let releaseDecision!: () => void;
  const heldDecision = new Promise<void>(resolve => { releaseDecision = resolve; });
  const save = f.decideBatch.getMockImplementation()!;
  f.decideBatch.mockImplementation(async input => { await heldDecision; return save(input); });
  let saving!: ReturnType<typeof hook.result.current.decideBatch>;
  await act(async () => { saving = hook.result.current.decideBatch(f.input); await hook.result.current.pollSources(); });
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => { releaseDecision(); expect((await saving).ok).toBe(true); });
  expect(refresh).toHaveBeenCalledTimes(1);
});
