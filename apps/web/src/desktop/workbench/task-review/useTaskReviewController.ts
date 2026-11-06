import { useCallback, useEffect, useRef, useState } from "react";
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
 * against, and a revision conflict refreshes once and replays the write so a
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
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const generation = useRef(0);

  const apply = useCallback((next: TaskReviewSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

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
    snapshotRef.current = null;
    setSnapshot(null);
    setOpenError(null);
    void bridge
      .open(root)
      .then(apply)
      .catch((problem) => setOpenError(errorMessage(problem)));
    return () => {
      generation.current++;
    };
  }, [apply, bridge, root]);

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

  const call = useCallback(
    (
      method: BridgeMethod,
      input: Record<string, unknown>,
      checkCurrent?: (snapshot: TaskReviewSnapshot) => void,
    ): Promise<MutationResult> => {
      const task = chain.current.then(async (): Promise<MutationResult> => {
        // Autosave already has per-draft status. Keep other actions clickable:
        // they serialize behind this save rather than losing a native click
        // when its short-lived busy flag disables the button mid-gesture.
        const blocksInteraction = method !== "saveDraft";
        if (blocksInteraction) setBusy(true);
        try {
          const invokeMethod = resolveMethod(method);
          if (!invokeMethod)
            throw new Error("Task context channel is not available in this shell");
          let current = snapshotRef.current ?? (await bridge.open(root));
          if (!snapshotRef.current) apply(current);
          const invoke = (base: TaskReviewSnapshot) => {
            checkCurrent?.(base);
            return invokeMethod({
              root,
              taskId: base.taskId,
              expectedRevision: base.revision,
              ...input,
            });
          };
          let next: TaskReviewSnapshot;
          try {
            next = await invoke(current);
          } catch (problem) {
            if (!isRevisionConflict(problem)) throw problem;
            current = await bridge.open(root);
            apply(current);
            next = await invoke(current);
          }
          apply(next);
          return { ok: true, snapshot: next, error: null };
        } catch (problem) {
          return failed(problem);
        } finally {
          if (blocksInteraction) setBusy(false);
        }
      });
      chain.current = task.then(() => undefined, () => undefined);
      return task;
    },
    [apply, bridge, resolveMethod, root],
  );

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
    lastSourceSuccess.current = Date.now();
    setSourceRefresh((current) => current.error ? { error: null, lastSuccess: lastSourceSuccess.current } : current);
  }, []);
  const sourceFailed = useCallback((error: string) => {
    setSourceRefresh({ error, lastSuccess: lastSourceSuccess.current });
  }, []);
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
    const task = chain.current.then(async () => {
      const base = snapshotRef.current;
      if (!base) return;
      const invoke = (snapshot: TaskReviewSnapshot) =>
        bridge.refreshSources({
          root,
          taskId: snapshot.taskId,
          expectedRevision: snapshot.revision,
        });
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
        if (next.revision !== snapshotRef.current?.revision) apply(next);
        sourceSucceeded();
      } catch (problem) {
        sourceFailed(errorMessage(problem));
      }
    });
    chain.current = task.then(() => undefined, () => undefined);
    await task;
  }, [apply, bridge, root, sourceFailed, sourceSucceeded]);
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
    const task = chain.current.then(async () => {
      setBusy(true);
      try {
        let current = snapshotRef.current ?? await bridge.open(root);
        let result;
        try { result = await operation(current); }
        catch (problem) {
          if (!isRevisionConflict(problem)) throw problem;
          current = await bridge.open(root);
          apply(current);
          // The operation closes over the same preview parameters/exportId.
          // Relevant input changes are rejected by the service, not replanned here.
          result = await operation(current);
        }
        apply(result.snapshot);
        return result;
      } finally { setBusy(false); }
    });
    chain.current = task.then(() => undefined, () => undefined);
    return task;
  }, [apply, bridge, root]);
  const previewOriginalExport = useCallback((input: TaskExportPreviewInput) => queueResult(async (base) => {
    const channel = exportBridgeRef.current;
    if (!channel) throw new Error("原文件结果导出通道未接入");
    if (input.root !== root || input.taskId !== base.taskId) throw new Error("导出任务已变化，请重新打开预览");
    const result = await channel.preview({ ...input, root, taskId: base.taskId, expectedRevision: base.revision });
    return { snapshot: result.snapshot, record: result.preview };
  }).then(({ snapshot, record }) => ({ snapshot, preview: record })), [queueResult, root]);
  const executeOriginalExport = useCallback((input: TaskCommit & { exportId: string }) => queueResult(async (base) => {
    const channel = exportBridgeRef.current;
    if (!channel) throw new Error("原文件结果导出通道未接入");
    if (input.root !== root || input.taskId !== base.taskId) throw new Error("导出任务已变化，请重新打开预览");
    const result = await channel.execute({ root, taskId: base.taskId, expectedRevision: base.revision, exportId: input.exportId });
    return { snapshot: result.snapshot, record: result.receipt };
  }).then(({ snapshot, record }) => ({ snapshot, receipt: record })), [queueResult, root]);

  const mediaRef = useRef(mediaBridge);
  mediaRef.current = mediaBridge;
  const requireMedia = useCallback(() => {
    if (!mediaRef.current) throw new Error("媒体审阅通道未接入");
    return mediaRef.current;
  }, []);
  const importMedia = useCallback((entryId: string) => queueResult(async (base) => ({
    snapshot: await requireMedia().importFile({ root, taskId: base.taskId, expectedRevision: base.revision, entryId }),
  })).then((result) => result.snapshot), [queueResult, requireMedia, root]);
  const openMedia = useCallback(async (target: TaskMediaTarget) => {
    const result = await requireMedia().open(target);
    const current = snapshotRef.current;
    if (current?.taskId === result.snapshot.taskId && result.snapshot.revision >= current.revision) apply(result.snapshot);
    return result;
  }, [apply, requireMedia]);
  const captureMediaFrame = useCallback((input: Omit<Parameters<TaskReviewMediaBridge["captureFrame"]>[0], "root" | "taskId" | "expectedRevision">) => queueResult((base) =>
    requireMedia().captureFrame({ ...input, root, taskId: base.taskId, expectedRevision: base.revision }),
  ), [queueResult, requireMedia, root]);
  const acceptMediaRegion = useCallback((input: Omit<Parameters<TaskReviewMediaBridge["acceptRegion"]>[0], "root" | "taskId" | "expectedRevision">) => queueResult((base) =>
    requireMedia().acceptRegion({ ...input, root, taskId: base.taskId, expectedRevision: base.revision }),
  ), [queueResult, requireMedia, root]);
  const segmentMedia = useCallback((input: Parameters<TaskReviewMediaBridge["segment"]>[0]) => requireMedia().segment(input), [requireMedia]);
  const cancelMedia = useCallback((input: Parameters<TaskReviewMediaBridge["cancel"]>[0]) => requireMedia().cancel(input), [requireMedia]);

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
    refresh,
    setGoal,
    importText,
    importFile,
    decide,
    undoDecision,
    redoDecision,
    refreshSources,
    pollSources,
    saveDraft,
    visit,
    exportSource,
    previewOriginalExport,
    executeOriginalExport,
    importMedia, openMedia, captureMediaFrame, acceptMediaRegion, segmentMedia, cancelMedia,
    adoptContext,
    adoptCriteria,
    setCriterionActive,
  };
}

export type TaskReviewController = ReturnType<typeof useTaskReviewController>;
