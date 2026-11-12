import { t } from "../../../i18n";
import { taskReviewSchemas } from '../../../../../desktop/src/shared/task-review-schema';
import { taskDecisionIntentMatches, taskWriteRecovery, type DecisionIntent } from '../../../../../desktop/src/shared/task-write-recovery';
import type { TaskDecisionReply } from '../../../../../desktop/src/shared/task-review-bridge';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  TaskDecisionStatus,
  TaskDraft,
  TaskReviewSnapshot,
  TaskTextFormat,
  TaskCommit,
} from "../../../../../desktop/src/shared/task-review";
import type { TaskCriteriaScope } from "../../../../../desktop/src/shared/task-review-context";
import type { TaskReviewBridge, TaskReviewContextBridge } from "../../../../../desktop/src/shared/task-review-bridge";
import { errorMessage, isRevisionConflict } from "./bridge";
import type { TaskExportPreviewInput, TaskReviewExportBridge } from "../../../../../desktop/src/shared/task-review-export";
import type { TaskMediaTarget, TaskReviewMediaBridge } from "../../../../../desktop/src/shared/task-review-media";

export interface MutationResult {
  ok: boolean;
  snapshot: TaskReviewSnapshot | null;
  error: string | null;
  batchId?: string;
}

const failed = (problem: unknown): MutationResult => ({
  ok: false,
  snapshot: null,
  error: errorMessage(problem),
});

/** One method name across the task store and the task-context store. */
type BridgeMethod = keyof TaskReviewBridge | keyof TaskReviewContextBridge;

/**
 * Serialized access to one task folder. Desktop main is the persistence
 * authority: every write carries the snapshot revision it was planned
 * against. Non-decision writes may refresh once on a CAS conflict; decisions
 * are only observed and never replayed automatically, so a
 * concurrent change never silently drops the reviewer's action. Context
 * adoption shares the same chain and revision contract; when the shell has
 * no context channel the call fails explicitly instead of faking success.
 */
export function useTaskReviewController(
  root: string,
  bridge: TaskReviewBridge,
  contextBridge: TaskReviewContextBridge | null = null,
  exportBridge: TaskReviewExportBridge | null = null,
  mediaBridge: TaskReviewMediaBridge | null = null,
) {
  const [snapshot, setSnapshot] = useState<TaskReviewSnapshot | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sourceRefresh, setSourceRefresh] = useState<{ error: string | null; lastSuccess: number | null }>({ error: null, lastSuccess: null });
  const lastSourceSuccess = useRef<number | null>(null);
  const snapshotRef = useRef<TaskReviewSnapshot | null>(null);
  const scope = useMemo(() => ({ barrier: taskWriteRecovery(root, bridge), chain: { current: Promise.resolve() as Promise<unknown> }, active: true, foreground: 0, polling: false }), [root, bridge]);
  const scopeRef = useRef(scope);
  if (scopeRef.current !== scope || !scope.active) { scopeRef.current.active = false; scopeRef.current = scope; snapshotRef.current = null; }
  const chain = scope.chain;
  const [, renderRecovery] = useState(0);
  const epoch = scope.barrier.epoch;
  const publishRecovery = useCallback(() => { if (scopeRef.current === scope) renderRecovery(value => value + 1); }, [scope]);
  const guard = useCallback((allowSaving = false) => {
    if (scopeRef.current !== scope || !scope.active) throw new Error(t("The review task changed; the previous call was cancelled."));
    scope.barrier.guard(epoch, allowSaving);
  }, [scope, epoch]);
  const generation = useRef(0);

  const apply = useCallback((next: TaskReviewSnapshot) => {
    if (scopeRef.current !== scope || !scope.active) return;
    scope.barrier.bind(next);
    if (snapshotRef.current && snapshotRef.current.revision > next.revision) return;
    snapshotRef.current = next;
    setSnapshot(next);
  }, [scope]);

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    const next = await bridge.open(root);
    // Never downgrade past a queued mutation that already applied.
    if (
      request === generation.current &&
      (!snapshotRef.current || next.revision >= snapshotRef.current.revision)
    ) {
      apply(next);
    }
    return next;
  }, [apply, bridge, root]);

  useEffect(() => {
    scope.active = true;
    snapshotRef.current = null;
    setSnapshot(null);
    setOpenError(null);
    void bridge
      .open(root)
      .then(apply)
      .catch((problem) => { if (scopeRef.current === scope) setOpenError(errorMessage(problem)); });
    return () => {
      scope.active = false;
      generation.current++;
    };
  }, [apply, bridge, root, scope]);

  const contextBridgeRef = useRef(contextBridge);
  contextBridgeRef.current = contextBridge;

  const resolveMethod = useCallback(
    (method: BridgeMethod): ((request: unknown) => Promise<TaskReviewSnapshot>) | null => {
      const direct = (bridge as unknown as Record<string, unknown>)[method];
      if (typeof direct === "function")
        return direct as (request: unknown) => Promise<TaskReviewSnapshot>;
      const handler = contextBridgeRef.current
        ? (contextBridgeRef.current as unknown as Record<string, unknown>)[method]
        : undefined;
      return typeof handler === "function"
        ? (handler as (request: unknown) => Promise<TaskReviewSnapshot>)
        : null;
    },
    [bridge],
  );

  const reconcileDecision = useCallback(async (): Promise<MutationResult> => {
    if (scopeRef.current !== scope || !scope.active) return failed(new Error(t("The review task changed.")));
    const pending = scope.barrier.pending;
    if (!pending || !scope.barrier.taskId || !bridge.getDecisionOutcome)
      return failed(new Error(t("This decision cannot be verified; writes remain paused.")));
    try {
      const result = await bridge.getDecisionOutcome({ root, taskId: scope.barrier.taskId, decisionId: pending.decisionId });
      if (scopeRef.current !== scope || !scope.active) throw new Error(t("Verification for the previous task was ignored."));
      if (result.snapshot.revision < (snapshotRef.current?.revision ?? 0)) throw new Error(t("The verification result is out of date."));
      const next = scope.barrier.resolve(result);
      apply(next); publishRecovery();
      return { ok: true, snapshot: next, error: null };
    } catch (problem) { publishRecovery(); return failed(problem); }
  }, [scope, bridge, root, apply, publishRecovery]);

  const call = useCallback((method: BridgeMethod, input: Record<string, unknown>, checkCurrent?: (snapshot: TaskReviewSnapshot) => void): Promise<MutationResult> => {
    try { guard(true); } catch (problem) { return Promise.resolve(failed(problem)); }
    scope.foreground++;
    const task = chain.current.then(async (): Promise<MutationResult> => {
      let intent: DecisionIntent | null = null;
      const blocksInteraction = method !== 'saveDraft' && method !== 'visit';
      try {
        guard();
        if (blocksInteraction) setBusy(true);
        const invokeMethod = resolveMethod(method);
        if (!invokeMethod) throw new Error('Task context channel is not available');
        let current = snapshotRef.current ?? await bridge.open(root);
        scope.barrier.bind(current);
        if (!snapshotRef.current) apply(current);
        const isBatch = method === 'decideBatch';
        const isDecision = method === 'decide' || isBatch;
        const decisionId = isDecision ? crypto.randomUUID() : undefined;
        if (decisionId && (current.decisions.some(item => item.id === decisionId) || current.decisionBatches?.some(item => item.id === decisionId))) throw new Error('Decision identity collision');
        const batchTargets = isBatch ? taskReviewSchemas.decideBatch.shape.targets.parse(
          (input.targets as { unitId: string; sourceVersionId: string }[]).map(target => ({ ...target, decisionId: crypto.randomUUID() })),
        ) : undefined;
        const invoke = (base: TaskReviewSnapshot) => {
          guard();
          checkCurrent?.(base);
          let decisionInput: Record<string, unknown> = {};
          if (decisionId) {
            const purpose = taskReviewSchemas.decide.shape.purpose.parse(input.purpose);
            const status = taskReviewSchemas.decide.shape.status.parse(input.status);
            const note = taskReviewSchemas.decide.shape.note.parse(input.note);
            if (batchTargets) {
              const members = batchTargets.map(target => ({ decisionId: target.decisionId, unitId: target.unitId, sourceVersionId: target.sourceVersionId, purpose, status, note, revision: base.revision }));
              intent = { ...members[0], decisionId, batch: members };
              decisionInput = { batchId: decisionId, targets: batchTargets, purpose, status, note };
            } else {
              const replacementText = taskReviewSchemas.decide.shape.replacementText.parse(input.replacementText);
              intent = { decisionId, unitId: String(input.unitId), sourceVersionId: String(input.sourceVersionId), purpose, status, note, ...(replacementText !== undefined ? { replacementText } : {}), revision: base.revision };
              decisionInput = { decisionId, purpose, status, note, ...(replacementText !== undefined ? { replacementText } : {}) };
            }
            scope.barrier.begin(intent); publishRecovery();
          }
          return invokeMethod({ root: base.root, taskId: base.taskId, expectedRevision: base.revision, ...input, ...decisionInput });
        };
        let next: TaskReviewSnapshot;
        try { next = await invoke(current); }
        catch (problem) {
          // A decision is never replayed automatically, including on stale CAS.
          if (isDecision || method === 'undoDecisionBatch' || method === 'redoDecisionBatch') {
            if (isRevisionConflict(problem)) {
              const observed = await bridge.open(root);
              if (scopeRef.current !== scope || !scope.active || epoch !== scope.barrier.epoch) throw new Error(t("The previous task reply was ignored."));
              scope.barrier.bind(observed); apply(observed);
              // Re-evaluate scene guards, but never reissue the decision.
              checkCurrent?.(observed);
            }
            throw problem;
          }
          if (!isRevisionConflict(problem)) throw problem;
          guard(); current = await bridge.open(root); scope.barrier.bind(current); apply(current); next = await invoke(current);
        }
        if (scopeRef.current !== scope || !scope.active || epoch !== scope.barrier.epoch) throw new Error(t("A reply for a previous task or an outdated decision was ignored."));
        scope.barrier.bind(next);
        const receipt = (next as TaskDecisionReply).decisionReceipt;
        if (intent && receipt) {
          const issued = intent as DecisionIntent;
          if (receipt.decisionId !== issued.decisionId) throw new Error('Decision receipt identity changed');
          if (receipt.outcome === 'not-committed') {
            scope.barrier.uncertain(issued);
            scope.barrier.resolve({ snapshot: next, decisionId: issued.decisionId, outcome: 'not-committed' });
            apply(next); publishRecovery();
            checkCurrent?.(next);
            return failed(new Error(t("This decision was not committed. Your input is preserved; retry explicitly.")));
          }
          if (!taskDecisionIntentMatches(next, issued)) throw new Error('Committed receipt lacks this exact decision');
          scope.barrier.complete(issued.decisionId);
          if (receipt.notificationFailed || receipt.refreshFailed) {
            scope.barrier.state = { outcome: 'committed', decisionId: issued.decisionId, message: "This decision was saved. Follow-up refresh did not finish; do not submit it again." };
            publishRecovery();
          }
        }
        if (intent && !receipt) {
          if ((intent as DecisionIntent).batch) throw new Error('Batch decision response requires exact verification');
          scope.barrier.complete((intent as DecisionIntent).decisionId);
        }
        publishRecovery(); apply(next);
        return { ok: true, snapshot: next, error: null, ...(isBatch ? { batchId: decisionId } : {}) };
      } catch (problem) {
        if (intent && scope.barrier.pending?.decisionId === (intent as DecisionIntent).decisionId && scope.barrier.epoch === epoch) { scope.barrier.uncertain(intent); publishRecovery(); }
        return failed(problem);
      } finally { if (blocksInteraction && scopeRef.current === scope) setBusy(false); }
    });
    chain.current = task.then(() => { scope.foreground--; }, () => { scope.foreground--; });
    return task;
  }, [apply, bridge, resolveMethod, root, scope, guard, publishRecovery]);

  const setGoal = useCallback(
    (goal: string) => call("setGoal", { goal }),
    [call],
  );
  const importText = useCallback(
    (input: { name: string; text: string; format: TaskTextFormat }) =>
      call("importText", input),
    [call],
  );
  const importFile = useCallback(
    (entryId: string) => call("importFile", { entryId }),
    [call],
  );
  const decide = useCallback(
    (input: {
      unitId: string;
      sourceVersionId: string;
      purpose: string;
      status: TaskDecisionStatus;
      note: string;
      replacementText?: string;
    }, checkCurrent?: (snapshot: TaskReviewSnapshot) => void) => call("decide", input, checkCurrent),
    [call],
  );
  const decideBatch = useCallback((input: {
    targets: { unitId: string; sourceVersionId: string }[];
    purpose: string;
    status: TaskDecisionStatus;
    note: string;
    pendingOnly?: boolean;
  }) => call('decideBatch', { ...input, targets: input.targets.map(target => ({ ...target })) }), [call]);
  const undoDecisionBatch = useCallback((batchId: string) => call('undoDecisionBatch', { batchId }), [call]);
  const redoDecisionBatch = useCallback((batchId: string) => call('redoDecisionBatch', { batchId }), [call]);
  const undoDecision = useCallback(
    (input: {
      unitId: string;
      sourceVersionId: string;
      purpose: string;
      decisionId: string;
      policyRevision: number;
    }) => call("undoDecision", input),
    [call],
  );
  const redoDecision = useCallback(
    (input: {
      unitId: string;
      sourceVersionId: string;
      purpose: string;
      decisionId: string;
      policyRevision: number;
    }) => call("redoDecision", input),
    [call],
  );
  const sourceSucceeded = useCallback(() => {
    if (scopeRef.current !== scope || !scope.active) return;
    lastSourceSuccess.current = Date.now();
    setSourceRefresh((current) => current.error ? { error: null, lastSuccess: lastSourceSuccess.current } : current);
  }, [scope]);
  const sourceFailed = useCallback((error: string) => {
    if (scopeRef.current !== scope || !scope.active) return;
    setSourceRefresh({ error, lastSuccess: lastSourceSuccess.current });
  }, [scope]);
  const refreshSources = useCallback(async () => {
    const result = await call("refreshSources", {});
    if (result.ok) sourceSucceeded();
    else sourceFailed(result.error!);
    return result;
  }, [call, sourceFailed, sourceSucceeded]);

  /**
   * Background source discovery for the active task. Serialized with writes
   * through the same chain and guarded by the same revision contract, but
   * never flips `busy`: failures keep the last snapshot with a quiet warning
   * and last-success time. Stable successful refreshes do not re-render.
   */
  const pollSources = useCallback(async (): Promise<void> => {
    if (scope.polling || scope.foreground > 0 || scope.barrier.blocked) return;
    scope.polling = true;
    const task = chain.current.then(async () => {
      try { guard(); } catch { return; }
      const base = snapshotRef.current;
      if (!base) return;
      const invoke = (snapshot: TaskReviewSnapshot) => { guard(); return bridge.refreshSources({
          root,
          taskId: snapshot.taskId,
          expectedRevision: snapshot.revision,
        }); };
      try {
        let next: TaskReviewSnapshot;
        try {
          next = await invoke(base);
        } catch (problem) {
          if (!isRevisionConflict(problem)) throw problem;
          const reopened = await bridge.open(root);
          apply(reopened);
          next = await invoke(reopened);
        }
        guard();
        if (next.revision !== snapshotRef.current?.revision) apply(next);
        sourceSucceeded();
      } catch (problem) {
        sourceFailed(errorMessage(problem));
      }
    });
    chain.current = task.then(() => { scope.polling = false; }, () => { scope.polling = false; });
    await task;
  }, [apply, bridge, root, sourceFailed, sourceSucceeded, guard, scope]);
  const saveDraft = useCallback(
    (draft: Omit<TaskDraft, "updatedAt">) => call("saveDraft", { draft }),
    [call],
  );
  const visit = useCallback(
    (input: { unitId: string; sourceVersionId: string; purpose: string }) =>
      call("visit", input),
    [call],
  );
  const exportSource = useCallback(
    (input: { sourceVersionId: string; purpose: string }) =>
      call("exportSource", input),
    [call],
  );

  const exportBridgeRef = useRef(exportBridge);
  exportBridgeRef.current = exportBridge;
  const queueResult = useCallback(<Result extends { snapshot: TaskReviewSnapshot },>(operation: (base: TaskReviewSnapshot) => Promise<Result>) => {
    try { guard(true); } catch (problem) { return Promise.reject(problem); }
    scope.foreground++;
    const task = chain.current.then(async () => {
      guard();
      setBusy(true);
      try {
        let current = snapshotRef.current ?? await bridge.open(root);
        guard();
        let result;
        try { result = await operation(current); }
        catch (problem) {
          if (!isRevisionConflict(problem)) throw problem;
          current = await bridge.open(root);
          apply(current);
          // The operation closes over the same preview parameters/exportId.
          // Relevant input changes are rejected by the service, not replanned here.
          guard();
          result = await operation(current);
        }
        guard();
        apply(result.snapshot);
        return result;
      } finally { if (scopeRef.current === scope) setBusy(false); }
    });
    chain.current = task.then(() => { scope.foreground--; }, () => { scope.foreground--; });
    return task;
  }, [apply, bridge, root, guard, scope]);
  const previewOriginalExport = useCallback((input: TaskExportPreviewInput) => queueResult(async (base) => {
    const channel = exportBridgeRef.current;
    if (!channel) throw new Error(t("Original-file export connection is unavailable"));
    if (input.root !== root || input.taskId !== base.taskId) throw new Error(t("The export task changed. Reopen the preview."));
    const result = await channel.preview({ ...input, root, taskId: base.taskId, expectedRevision: base.revision });
    return { snapshot: result.snapshot, record: result.preview };
  }).then(({ snapshot, record }) => ({ snapshot, preview: record })), [queueResult, root]);
  const executeOriginalExport = useCallback((input: TaskCommit & { exportId: string }) => queueResult(async (base) => {
    const channel = exportBridgeRef.current;
    if (!channel) throw new Error(t("Original-file export connection is unavailable"));
    if (input.root !== root || input.taskId !== base.taskId) throw new Error(t("The export task changed. Reopen the preview."));
    const result = await channel.execute({ root, taskId: base.taskId, expectedRevision: base.revision, exportId: input.exportId });
    return { snapshot: result.snapshot, record: result.receipt };
  }).then(({ snapshot, record }) => ({ snapshot, receipt: record })), [queueResult, root]);

  const mediaRef = useRef(mediaBridge);
  mediaRef.current = mediaBridge;
  const requireMedia = useCallback(() => {
    guard();
    if (!mediaRef.current) throw new Error(t("The media review channel is unavailable."));
    return mediaRef.current;
  }, [guard]);
  const importMedia = useCallback((entryId: string) => queueResult(async (base) => ({
    snapshot: await requireMedia().importFile({ root, taskId: base.taskId, expectedRevision: base.revision, entryId }),
  })).then((result) => result.snapshot), [queueResult, requireMedia, root]);
  const openMedia = useCallback((target: TaskMediaTarget) => queueResult(async (base) => {
    if (target.root !== root || target.taskId !== base.taskId) throw new Error(t('The media review target changed.'));
    return requireMedia().open(target);
  }), [queueResult, requireMedia, root]);
  const thumbnailMedia = useCallback(async (target: TaskMediaTarget) => {
    const channel = mediaRef.current;
    const current = snapshotRef.current;
    if (scopeRef.current !== scope || !scope.active || target.root !== root || target.taskId !== current?.taskId) throw new Error(t('The media review target changed.'));
    if (!channel?.thumbnail) throw new Error(t('The media preview channel is unavailable.'));
    const result = await channel.thumbnail(target);
    if (scopeRef.current !== scope || !scope.active || snapshotRef.current?.taskId !== target.taskId) throw new Error(t('The media review target changed.'));
    return result;
  }, [root, scope]);
  const captureMediaFrame = useCallback((input: Omit<Parameters<TaskReviewMediaBridge["captureFrame"]>[0], "root" | "taskId" | "expectedRevision">) => queueResult((base) =>
    requireMedia().captureFrame({ ...input, root, taskId: base.taskId, expectedRevision: base.revision }),
  ), [queueResult, requireMedia, root]);
  const acceptMediaRegion = useCallback((input: Omit<Parameters<TaskReviewMediaBridge["acceptRegion"]>[0], "root" | "taskId" | "expectedRevision">) => queueResult((base) =>
    requireMedia().acceptRegion({ ...input, root, taskId: base.taskId, expectedRevision: base.revision }),
  ), [queueResult, requireMedia, root]);
  const segmentMedia = useCallback((input: Parameters<TaskReviewMediaBridge["segment"]>[0]) => requireMedia().segment(input), [requireMedia]);
  const cancelMedia = useCallback((input: Parameters<TaskReviewMediaBridge["cancel"]>[0]) => {
    // Cancelling transient inference is cleanup, not a task-state mutation.
    if (input.root !== root || input.taskId !== scope.barrier.taskId) return Promise.reject(new Error(t("The cancellation target changed.")));
    if (!mediaBridge) return Promise.reject(new Error(t("The media review channel is unavailable.")));
    return mediaBridge.cancel(input);
  }, [root, scope, mediaBridge]);

  // Explicit human adoption of task understanding and review criteria. These
  // are separate actions with their own revision guards; ordinary input,
  // completion and decisions never route through them.
  const adoptContext = useCallback(
    (input: { proposalId: string; authorizedSourceVersionIds: string[] }) =>
      call("adoptContext", input),
    [call],
  );
  const adoptCriteria = useCallback(
    (input: {
      criterionId?: string;
      supersedesId?: string;
      content: string;
      scope: TaskCriteriaScope;
      purpose: string;
      origin: { kind: "explicit"; text: string } | { kind: "feedback"; decisionId: string };
    }) => call("adoptCriteria", input),
    [call],
  );
  const setCriterionActive = useCallback(
    (input: { versionId: string; active: boolean }) =>
      call("setCriterionActive", input),
    [call],
  );

  return {
    snapshot,
    snapshotRef,
    openError,
    busy,
    sourceRefresh,
    recovery: scope.barrier.state,
    writesBlocked: scope.barrier.blocked,
    reconcileDecision,
    refresh,
    setGoal,
    importText,
    importFile,
    decide,
    decideBatch,
    undoDecisionBatch,
    redoDecisionBatch,
    undoDecision,
    redoDecision,
    refreshSources,
    pollSources,
    saveDraft,
    visit,
    exportSource,
    previewOriginalExport,
    executeOriginalExport,
    importMedia, openMedia, thumbnailMedia, captureMediaFrame, acceptMediaRegion, segmentMedia, cancelMedia,
    adoptContext,
    adoptCriteria,
    setCriterionActive,
  };
}

export type TaskReviewController = ReturnType<typeof useTaskReviewController>;
