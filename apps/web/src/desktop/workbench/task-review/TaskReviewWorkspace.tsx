import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskDecisionStatus, TaskSceneSuggestion } from "../../../../../desktop/src/shared/task-review";
import { isTextTaskUnit } from "../../../../../desktop/src/shared/task-review";
import { FolderReviewWorkspace } from "../components/FolderReviewWorkspace";
import { wbButton, segmentedContainer, segmentedItem } from "../wb-button";
import { taskAgentBridge, taskContextBridge, taskReviewBridge, taskExportBridge, taskMediaBridge } from "./bridge";
import { EditScene } from "./EditScene";
import { GlobalScene } from "./GlobalScene";
import { AgentScene } from "./AgentScene";
import { MediaScene } from "./MediaScene";
import { TaskContextBrief } from "./TaskContextPanel";
import { UnitReviewScene } from "./UnitReviewScene";
import { currentSourceIds, findUnit, REVIEW_PURPOSE, unitStats, initialSceneTarget } from "./queries";
import { isTaskSceneCurrent, selectTaskDecisionHistory } from "../../../../../desktop/src/shared/task-review-selectors";
import {
  activeScene,
  back,
  canBack,
  continueScene,
  forwardScenes,
  openAgentScene,
  focusSceneTarget,
  workingRef,
  currentRef,
  initialTimeline,
  openTemporary,
  openUnit,
  setEditing,
  type TimelineState,
} from "./timeline";
import { analyzedUnitIds, useTaskAgentState } from "./useTaskAgentState";
import { useTaskDrafts } from "./useTaskDrafts";
import { useTaskReviewController } from "./useTaskReviewController";
import { readTimeline, viewKey } from "./view-state";

/**
 * AI-native task review shell. The fixed chrome carries task identity, back,
 * continue and progress; directory, global, unit review and fine editing are
 * mutually exclusive scenes over one working timeline. Real folder file
 * management stays embedded with its genuine drag-and-drop behaviour.
 */
export function TaskReviewWorkspace({
  root,
  name,
  onFlush,
  onClose,
}: {
  root: string;
  name?: string;
  onFlush?: (callback: () => Promise<void>) => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const reviewBridge = taskReviewBridge();
  const contextBridge = taskContextBridge();
  const exportBridge = taskExportBridge();
  const mediaBridge = taskMediaBridge();
  const agent = taskAgentBridge();
  const legacy = !reviewBridge;

  const controller = useTaskReviewController(root, reviewBridge!, contextBridge, exportBridge, mediaBridge);
  const {
    drafts: draftMap,
    updateDraft,
    retry: retryDraft,
    flushAll: flushDrafts,
    dirtyCount,
    errorCount,
  } = useTaskDrafts(controller.snapshot, controller);
  const [timeline, setTimelineState] = useState<TimelineState>(() =>
    initialTimeline([]),
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const seeded = useRef(false);
  const [viewReady, setViewReady] = useState(false);
  const touched = useRef(false);
  const navigationSequence = useRef(0);
  const groupSaving = useRef(false);
  const [savingGroup, setSavingGroup] = useState(false);
  const [pendingRequest, setPendingRequest] = useState(0);
  const mediaOpening = useRef<{ entryId: string; intent: number } | null>(null);
  const setTimeline = useCallback(
    (update: (state: TimelineState) => TimelineState) => {
      touched.current = true;
      navigationSequence.current++;
      setTimelineState(update);
    },
    [],
  );

  const snapshot = controller.snapshot;
  const target = useMemo(
    () => (snapshot ? { root: snapshot.root, taskId: snapshot.taskId } : null),
    [snapshot?.root, snapshot?.taskId],
  );
  const agentRuntime = useTaskAgentState(agent, target, snapshot?.revision ?? null);
  const refresh = controller.refresh;
  const pollSources = controller.pollSources;

  // The active workspace owns source discovery: a quiet, serialized
  // refreshSources poll notices external file changes in every scene, never
  // relying on the hidden directory scene's own file-tree polling. Discovery
  // never resets the open scene or local drafts; a stable refresh keeps its
  // revision.
  const taskLoaded = snapshot !== null;
  useEffect(() => {
    if (!taskLoaded) return;
    void pollSources();
    const timer = window.setInterval(() => void pollSources(), 3000);
    return () => window.clearInterval(timer);
  }, [taskLoaded, pollSources]);

  // Published analysis lands in the task store; pick it up when a background
  // job completes. New plans only change the future, never the open scene.
  const completedJobs = useRef<Set<string>>(new Set());
  useEffect(() => {
    const completed = new Set(
      (agentRuntime.state?.jobs ?? [])
        .filter((job) => job.status === "completed")
        .map((job) => job.id),
    );
    const fresh = [...completed].some((id) => !completedJobs.current.has(id));
    completedJobs.current = completed;
    if (fresh) void refresh().catch(() => undefined);
  }, [agentRuntime.state, refresh]);

  // Restart recovery: restore the last visited unit scene once, and only
  // while the reviewer has not navigated yet (a load-time click wins).
  useEffect(() => {
    if (!snapshot || seeded.current) return;
    seeded.current = true;
    if (!touched.current) {
      const recovered = readTimeline(viewKey(root, snapshot.taskId));
      const valid = recovered?.visited.every((ref) => snapshot.units.some((unit) => unit.id === ref.unitId && unit.sourceVersionId === ref.sourceVersionId));
      setTimelineState(valid ? recovered! : initialTimeline(snapshot.history));
    }
    setViewReady(true);
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot || !viewReady) return;
    localStorage.setItem(viewKey(root, snapshot.taskId), JSON.stringify(timeline));
  }, [root, snapshot?.taskId, timeline, viewReady]);

  // Record actual visits; navigation alone never changes review state.
  const lastVisit = useRef<string | null>(null);
  const openRef = currentRef(timeline);
  const visit = controller.visit;
  useEffect(() => {
    if (!openRef || !snapshot) return;
    if (lastVisit.current === openRef.unitId) return;
    lastVisit.current = openRef.unitId;
    void visit(openRef);
  }, [openRef?.unitId, snapshot, visit]);

  const folderFlushRef = useRef<() => Promise<void>>(async () => {});
  const registerFolderFlush = useCallback((callback: () => Promise<void>) => {
    folderFlushRef.current = callback;
  }, []);
  useEffect(() => {
    onFlush?.(async () => {
      // Both flushes run; a failure keeps the switch honest about state.
      const folderFlush = folderFlushRef.current();
      const draftProblem = await flushDrafts().then(
        () => null,
        (problem) => problem,
      );
      await folderFlush;
      if (draftProblem) throw draftProblem;
    });
  }, [onFlush, flushDrafts]);

  const scene = activeScene(timeline);
  const unit =
    (scene.kind === "unit" || scene.kind === "edit" || scene.kind === "agent") && snapshot
      ? findUnit(snapshot, scene.ref.unitId)
      : null;
  const stats = snapshot ? unitStats(snapshot) : null;
  const planLeft = snapshot ? forwardScenes(snapshot, timeline).pending.length : 0;
  const nextTarget = snapshot ? continueScene(snapshot, timeline) : null;
  const workFocus = timeline.focus ?? workingRef(timeline);
  const workingScene = timeline.position === null ? null : timeline.sceneAnchors[timeline.position];
  const openPending = () => {
    setPendingRequest((request) => request + 1);
    setTimeline((state) => openTemporary(state, "global"));
  };
  const navigateNext = (next: ReturnType<typeof continueScene>, planId: string | null) => {
    if (!next) return;
    setTimeline((state) => {
      const base = { ...state, overlay: null };
      return next.suggestion && !next.suggestion.id.startsWith("legacy:")
        ? openAgentScene(base, next.suggestion, next.ref, planId)
        : openUnit(base, next.ref, planId);
    });
  };
  const openPlannedScene = (suggestion: TaskSceneSuggestion) => {
    if (!snapshot) return;
    const target = initialSceneTarget(snapshot, suggestion);
    navigateNext({ suggestion, ref: { ...target, purpose: suggestion.purpose } }, snapshot.planRevisions.at(-1)?.id ?? null);
  };

  const decideAndContinue = async (
    status: TaskDecisionStatus,
    replacementText?: string,
  ) => {
    if (!snapshot || !openRef) return;
    const navigation = navigationSequence.current;
    const draft = draftMap[openRef.unitId];
    const result = await controller.decide({
      ...openRef,
      status,
      note: draft?.text ?? "",
      ...(replacementText !== undefined ? { replacementText } : {}),
    });
    if (!result.ok) {
      setActionError(result.error);
      return;
    }
    setActionError(null);
    if (navigation !== navigationSequence.current) return;
    const next = result.snapshot ? continueScene(result.snapshot, timeline) : null;
    if (next) {
      navigateNext(next, result.snapshot?.planRevisions.at(-1)?.id ?? null);
    } else if (!next) {
      // Forward plan finished; earlier pending entries remain in the summary.
      setTimeline((state) => openTemporary(state, "global"));
    }
  };

  const decideSingle = async (
    status: TaskDecisionStatus,
    replacementText?: string,
  ) => {
    if (!snapshot || !openRef) return;
    const draft = draftMap[openRef.unitId];
    const result = await controller.decide({
      ...openRef,
      status,
      note: draft?.text ?? "",
      ...(replacementText !== undefined ? { replacementText } : {}),
    });
    setActionError(result.ok ? null : result.error);
  };

  // Undo/redo act on the decision stack via the shared selector's verdict.
  const changeDecision = async (direction: "undo" | "redo") => {
    if (!snapshot || !openRef) return;
    const history = selectTaskDecisionHistory(snapshot, openRef);
    const decisionId = (direction === "undo" ? history.undo : history.redo)?.id;
    if (!decisionId) return;
    const result = await (direction === "undo"
      ? controller.undoDecision
      : controller.redoDecision)({
      ...openRef,
      decisionId,
      policyRevision: snapshot.policyRevision,
    });
    setActionError(result.ok ? null : result.error);
  };

  const batchDecide = async (unitIds: string[], status: TaskDecisionStatus) => {
    if (!snapshot) return;
    for (const unitId of unitIds) {
      const unit = findUnit(snapshot, unitId);
      if (!unit) continue;
      const result = await controller.decide({
        unitId: unit.id,
        sourceVersionId: unit.sourceVersionId,
        purpose: REVIEW_PURPOSE,
        status,
        note: "",
      });
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
    }
    setActionError(null);
  };

  const openUnitById = (unitId: string) => {
    const latest = controller.snapshotRef.current ?? snapshot;
    const unit = latest ? findUnit(latest, unitId) : null;
    if (!unit) return;
    setTimeline((state) =>
      openUnit(state, {
        unitId: unit.id,
        sourceVersionId: unit.sourceVersionId,
        purpose: REVIEW_PURPOSE,
      }, latest?.planRevisions.at(-1)?.id),
    );
  };
  const openMediaFile = async (entryId: string) => {
    const intent = ++navigationSequence.current;
    if (mediaOpening.current?.entryId === entryId) {
      mediaOpening.current.intent = intent;
      return;
    }
    const pending = { entryId, intent };
    mediaOpening.current = pending;
    try {
      const next = await controller.importMedia(entryId);
      if (pending.intent !== navigationSequence.current) return;
      const file = next.sourceFiles.find((item) => item.entryId === entryId);
      const target = next.units.find((item) => item.sourceVersionId === file?.currentVersionId && (item.kind === "image" || item.kind === "video"));
      if (!target) throw new Error("未找到当前图片或视频条目");
      openUnitById(target.id);
    } finally { if (mediaOpening.current === pending) mediaOpening.current = null; }
  };
  const openDerivedUnit = (unitId: string) => {
    const latest = controller.snapshotRef.current;
    const derived = latest ? findUnit(latest, unitId) : null;
    if (!derived) return;
    setTimeline((state) => openUnit(state, { unitId, sourceVersionId: derived.sourceVersionId, purpose: REVIEW_PURPOSE },
      state.position === null ? null : state.planAnchors[state.position],
      state.position === null ? null : state.workAnchors[state.position] ?? workingRef(state)));
  };

  const keepSceneSelection = async (unitIds: string[]) => {
    if (!snapshot || scene.kind !== "agent" || groupSaving.current) return;
    groupSaving.current = true;
    setSavingGroup(true);
    const navigation = navigationSequence.current;
    let latest = snapshot;
    let saved = 0;
    try {
      for (const unitId of unitIds) {
        const target = scene.suggestion.targets.find((item) => item.unitId === unitId)!;
        const result = await controller.decide({ ...target, purpose: scene.suggestion.purpose, status: "kept", note: draftMap[unitId]?.text ?? "" }, (base) => {
          if (!isTaskSceneCurrent(base, scene.suggestion, snapshot.policyRevision)) throw new Error("场景判断口径或来源已变化，请刷新计划后确认");
        });
        if (!result.ok) {
          setActionError(`已保存 ${saved}/${unitIds.length} 条；剩余条目未完成：${result.error}`);
          return;
        }
        latest = result.snapshot!;
        saved++;
      }
      setActionError(null);
      if (navigation !== navigationSequence.current) return;
      const next = continueScene(latest, timeline);
      if (next) navigateNext(next, latest.planRevisions.at(-1)?.id ?? null);
      else setTimeline((state) => openTemporary(state, "global"));
    } finally {
      groupSaving.current = false;
      setSavingGroup(false);
    }
  };

  const unitScene = snapshot && unit && isTextTaskUnit(unit) ? (
    <UnitReviewScene
      key={unit.id}
      purpose={openRef?.purpose}
      feedbackOnly={scene.kind === "agent" && scene.suggestion.kind !== "single"}
      snapshot={snapshot}
      unit={unit}
      busy={controller.busy || savingGroup}
      draft={draftMap[unit.id]}
      agent={agent}
      agentState={agentRuntime.state}
      onUpdateDraft={(patch) => updateDraft(unit.id, unit.sourceVersionId, patch)}
      onDecide={(status, replacementText) => void decideSingle(status, replacementText)}
      onDecideAndContinue={(status, replacementText) => void decideAndContinue(status, replacementText)}
      onUndo={() => void changeDecision("undo")}
      onRedo={() => void changeDecision("redo")}
      onOpenEdit={() => setTimeline((state) => setEditing(state, true))}
      criteriaAvailable={contextBridge !== null}
      onAdoptCriteria={controller.adoptCriteria}
    />
  ) : snapshot && unit && !isTextTaskUnit(unit) && mediaBridge ? (
    <MediaScene key={unit.id} snapshot={snapshot} unit={unit} operations={controller} draft={draftMap[unit.id]}
      onUpdateDraft={(patch) => updateDraft(unit.id, unit.sourceVersionId, patch)} onOpenUnit={openDerivedUnit}
      onDecide={(status) => void decideSingle(status)} onUndo={() => void changeDecision("undo")} onRedo={() => void changeDecision("redo")} onReportError={setActionError} busy={controller.busy} />
  ) : null;

  if (legacy) {
    // Older shell without the task-review IPC: keep the folder workspace.
    return <FolderReviewWorkspace root={root} onFlush={onFlush} onClose={onClose} />;
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col text-xs text-fg"
      data-testid="task-review-workspace"
      data-task-root={root}
    >
      <div className="flex h-9 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-bg-1 px-3">
        <strong className="min-w-0 max-w-56 truncate" title={root} data-testid="task-review-identity">
          {name ?? root}
        </strong>
        <div className={segmentedContainer} data-testid="task-review-scene-switch">
          <button
            type="button"
            className={segmentedItem(scene.kind === "directory")}
            onClick={() => setTimeline((state) => openTemporary(state, "directory"))}
          >
            {t("目录")}
          </button>
          <button
            type="button"
            className={segmentedItem(scene.kind === "global")}
            onClick={() => setTimeline((state) => openTemporary(state, "global"))}
          >
            {t("全局")}
          </button>
        </div>
        <button
          type="button"
          className={wbButton.ghost}
          disabled={!canBack(timeline)}
          title={t("返回上一场景；不改变审阅状态")}
          data-testid="task-review-back"
          onClick={() => setTimeline((state) => back(state))}
        >
          {t("返回")}
        </button>
        <button
          type="button"
          className={wbButton.primary}
          disabled={!snapshot || !nextTarget || controller.busy}
          title={nextTarget ? t("继续 Agent 计划的下一个待审条目") : t("没有待审条目")}
          data-testid="task-review-continue"
          onClick={() => navigateNext(nextTarget, snapshot?.planRevisions.at(-1)?.id ?? null)}
        >
          {t("继续")}
        </button>
        <span className="min-w-0 flex-1" />
        {stats && (
          <span className="shrink-0 text-fg-3" data-testid="task-review-progress">
            {t("已判定 {{decided}}/{{total}} · 待审 {{pending}} · 后续 {{plan}} 场景", {
              decided: stats.decided,
              total: stats.total,
              plan: planLeft,
              pending: stats.pending,
            })}
          </span>
        )}
        {errorCount > 0 ? (
          <button
            type="button"
            className={wbButton.danger}
            title={t("重试保存未成功的草稿")}
            data-testid="task-review-draft-retry"
            onClick={() => {
              for (const [unitId, entry] of Object.entries(draftMap))
                if (entry.status === "error") void retryDraft(unitId);
            }}
          >
            {t("草稿未保存，点击重试")}
          </button>
        ) : dirtyCount > 0 ? (
          <span className="shrink-0 text-fg-3" role="status">
            {t("草稿保存中…")}
          </span>
        ) : null}
        {onClose && (
          <button type="button" className={wbButton.ghost} onClick={onClose}>
            {t("关闭")}
          </button>
        )}
      </div>
      {snapshot && stats && stats.pending > 0 && workFocus && !nextTarget && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-fg-2" data-testid="task-review-round-end">
          <span>本轮已到末尾，仍有 {stats.pending} 条待审。</span>
          <button type="button" className={wbButton.secondary} onClick={openPending}>查看这些待审项</button>
        </div>
      )}
      {(controller.openError || actionError) && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-border p-2 text-status-error"
          data-testid="task-review-error"
        >
          <span className="min-w-0 flex-1">{controller.openError ?? actionError}</span>
          {controller.openError && (
            <button
              type="button"
              className={wbButton.ghost}
              onClick={() => void controller.refresh().catch(() => undefined)}
            >
              {t("重试")}
            </button>
          )}
          {actionError && (
            <button type="button" className={wbButton.ghost} onClick={() => setActionError(null)}>
              {t("知道了")}
            </button>
          )}
        </div>
      )}
      {controller.sourceRefresh.error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-2 px-3 py-1.5 text-fg-2" role="status" data-testid="task-review-source-refresh-error">
          <span className="min-w-0 flex-1">来源刷新失败：{controller.sourceRefresh.error}。{controller.sourceRefresh.lastSuccess ? `最后成功：${new Date(controller.sourceRefresh.lastSuccess).toLocaleTimeString()}` : "尚未成功刷新"}；当前显示上次读取的内容。</span>
          <button type="button" className={wbButton.ghost} onClick={() => void pollSources()}>重试刷新</button>
        </div>
      )}
      {scene.kind === "directory" && snapshot && <TaskContextBrief snapshot={snapshot} next={nextTarget?.suggestion ?? undefined} />}
      {/* Real file management stays mounted for instant, state-preserving
          return; while another scene covers it, polling and preview media
          pause and every legacy file-level review entry stays hidden: task
          decisions have exactly one authority — the task domain. */}
      <div
        className={`flex min-h-0 flex-1 flex-col ${scene.kind === "directory" ? "" : "hidden"}`}
        data-testid="task-review-directory-host"
      >
        <FolderReviewWorkspace
          root={root}
          mode="files"
          sceneVisible={scene.kind === "directory"}
          onOpenMedia={mediaBridge ? openMediaFile : undefined}
          onFlush={registerFolderFlush}
        />
      </div>
      {scene.kind === "global" && snapshot && (
        <GlobalScene
          snapshot={snapshot}
          busy={controller.busy}
          agent={agent}
          agentRuntime={agentRuntime}
          onSetGoal={controller.setGoal}
          onImportText={controller.importText}
          onImportFile={controller.importFile}
          onRefreshSources={controller.refreshSources}
          onExport={controller.exportSource}
          exportAvailable={exportBridge !== null}
          onPreviewOriginalExport={controller.previewOriginalExport}
          onExecuteOriginalExport={controller.executeOriginalExport}
          onChooseExportDestination={async () => {
            if (!window.reelterminal?.fs) throw new Error("目录选择通道未接入");
            return window.reelterminal.fs.showOpenDialog({ directory: true, filters: [] });
          }}
          onOpenUnit={openUnitById}
          onOpenScene={openPlannedScene}
          nextScene={nextTarget?.suggestion ?? null}
          pendingRequest={pendingRequest}
          activeSourceVersionId={workFocus?.sourceVersionId}
          activeTargets={workingScene?.targets ?? (workFocus ? [{ unitId: workFocus.unitId, sourceVersionId: workFocus.sourceVersionId }] : [])}
          onBatchDecide={(unitIds, status) => void batchDecide(unitIds, status)}
          contextAvailable={contextBridge !== null}
          onAdoptContext={controller.adoptContext}
          onSetCriterionActive={controller.setCriterionActive}
        />
      )}
      {scene.kind === "unit" && unitScene}
      {scene.kind === "agent" && snapshot && unit && (
        <AgentScene snapshot={snapshot} suggestion={scene.suggestion} focusId={scene.ref.unitId}
          selected={timeline.sceneSelections[scene.suggestion.id] ?? []} analyzed={analyzedUnitIds(snapshot, agentRuntime.state)} busy={controller.busy || savingGroup}
          onFocus={(unitId) => {
            const target = scene.suggestion.targets.find((item) => item.unitId === unitId)!;
            setTimeline((state) => focusSceneTarget(state, { ...target, purpose: scene.suggestion.purpose }));
          }}
          onSelect={(unitId, checked) => setTimeline((state) => ({ ...state, sceneSelections: { ...state.sceneSelections,
            [scene.suggestion.id]: checked ? [...new Set([...(state.sceneSelections[scene.suggestion.id] ?? []), unitId])] : (state.sceneSelections[scene.suggestion.id] ?? []).filter((id) => id !== unitId),
          } }))}
          onKeepSelected={(unitIds) => void keepSceneSelection(unitIds)}>
          {unitScene}
        </AgentScene>
      )}
      {scene.kind === "edit" && snapshot && unit && isTextTaskUnit(unit) && (
        <EditScene
          key={unit.id}
          unit={unit}
          root={snapshot.root}
          taskId={snapshot.taskId}
          agent={agent}
          agentState={agentRuntime.state}
          disabled={!currentSourceIds(snapshot).has(unit.sourceVersionId)}
          policyRevision={snapshot.policyRevision}
          draft={draftMap[unit.id]}
          onUpdateDraft={(patch) => updateDraft(unit.id, unit.sourceVersionId, patch)}
          onBackToReview={() => setTimeline((state) => setEditing(state, false))}
        />
      )}
    </div>
  );
}

export default TaskReviewWorkspace;
