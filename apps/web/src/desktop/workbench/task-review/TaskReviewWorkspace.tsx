import { t } from "../../../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  FileText,
  Layers,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import type {
  TaskDecisionStatus,
  TaskReviewSnapshot,
  TaskSceneSuggestion,
  TaskTextReviewUnit,
} from "../../../../../desktop/src/shared/task-review";
import { isCurrentTaskUnit, isTextTaskSource, isTextTaskUnit } from "../../../../../desktop/src/shared/task-review";
import type { TaskCriteriaScope } from "../../../../../desktop/src/shared/task-review-context";
import { isTaskSceneCurrent, selectTaskDecisionHistory } from "../../../../../desktop/src/shared/task-review-selectors";
import type { TaskAgentJob, TaskModelConfig } from "../../../../../desktop/src/shared/task-review-runtime-types";
import { FolderReviewWorkspace } from "../components/FolderReviewWorkspace";
import { wbButton } from "../wb-button";
import { taskAgentBridge, taskContextBridge, taskReviewBridge, taskExportBridge, taskMediaBridge } from "./bridge";
import { EditScene } from "./EditScene";
import { FeedbackEditor } from "./FeedbackEditor";
import { GlobalScene } from "./GlobalScene";
import { MediaScene } from "./MediaScene";
import { ResultExportPanel } from "./ResultExportPanel";
import { SpotlightCard, type SpotlightLauncherItem, type SpotlightPrimaryAction, type SpotlightStepDot } from "./spotlight-card";
import { MODEL_PROVIDER_PRESETS, detectProviderPreset, getProviderPreset } from "./model-presets";
import { StageUnitCard } from "./stage-unit-card";
import { useHoverTip } from "./task-tooltip";
import { CriteriaAdoptionForm } from "./TaskContextPanel";
import { sourceTitle, statusLabels, unitTitle } from "./display";
import {
  currentSourceIds,
  findUnit,
  initialSceneTarget,
  issuesForUnit,
  pendingSceneTargets,
  planScenes,
  planStepForUnit,
  REVIEW_PURPOSE,
  currentAuthorizedSourceVersionIds,
  currentSources,
  selectAdoptedTaskContext,
  selectTaskContextForPlanning,
  unitDecisionState,
  unitStats,
} from "./queries";
import { analyzedUnitIds, preflightCoverage, useTaskAgentState } from "./useTaskAgentState";
import { useTaskDrafts } from "./useTaskDrafts";
import { useTaskReviewController } from "./useTaskReviewController";
import { readTimeline, useSceneScroll, viewKey } from "./view-state";
import {
  activeScene,
  back,
  canBack,
  continueScene,
  currentRef,
  focusSceneTarget,
  initialTimeline,
  openAgentScene,
  openTemporary,
  openUnit,
  setEditing,
  workingRef,
  type TimelineState,
  type UnitRef,
} from "./timeline";

const formatTime = (ms: number) => {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const srtTime = (ms: number) => {
  const total = Math.max(0, Math.floor(ms));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
};

const severityRank = { high: 3, medium: 2, low: 1 } as const;

const jobStatusLabels: Record<TaskAgentJob["status"], string> = {
  get queued() { return t("Queued"); },
  get running() { return t("Analyzing"); },
  get completed() { return t("Completed"); },
  get failed() { return t("Failed"); },
  get cancelled() { return t("Paused"); },
  get interrupted() { return t("Interrupted"); },
  get stale() { return t("Stale"); },
};

/**
 * 场景依据（自 AgentScene 迁移）：场景的口径、疑点与定位引文永远可查，
 * 人工判断永远能看到 Agent 给出的依据。
 */
function SceneBasis({ snapshot, suggestion }: { snapshot: TaskReviewSnapshot; suggestion: TaskSceneSuggestion }) {
  const additional = suggestion.sourceRefs.filter((ref) => !suggestion.targets.some((target) => target.unitId === ref.unitId && target.sourceVersionId === ref.sourceVersionId));
  const policy = suggestion.criteriaBasis[0]?.policyRevision;
  const goal = policy === snapshot.policyRevision ? snapshot.goal : snapshot.goalHistory?.find((version) => version.policyRevision === policy)?.content ?? t("Historical goal criteria updated");
  return (
    <details className="shrink-0 text-fg-3" data-testid="task-review-scene-basis">
      <summary className="cursor-pointer">{suggestion.criteriaRefs.length} {t(" criteria · ")}{suggestion.issueIds.length} {t(" concerns · ")}{suggestion.sourceRefs.length} {t(" references")}</summary>
      <p className="mt-1">{suggestion.reason}</p>
      {suggestion.criteriaRefs.map((id) => <p key={id} className="mt-1 whitespace-pre-wrap">{snapshot.contextHistory?.criteriaVersions.find((version) => version.id === id)?.content ?? t("Historical criteria (currently unavailable)")}</p>)}
      {additional.map((ref, index) => <p key={index} className="mt-1 select-text whitespace-pre-wrap">{snapshot.sources.find((source) => source.id === ref.sourceVersionId)?.relativePath} · #{findUnit(snapshot, ref.unitId)?.ordinal}：{ref.text}</p>)}
      {!suggestion.criteriaRefs.length && <p className="mt-1 whitespace-pre-wrap">{t("Task goal and criteria:")}{goal || t("Not filled in yet")}</p>}
    </details>
  );
}

/**
 * 完整疑点卡（自 UnitReviewScene 迁移）：证据、假设与候选动作按钮全部保留；
 * 候选按钮只把建议追加进人工批注草稿，不替人下结论。
 */
function IssueCards({ snapshot, unit, purpose, draft, onUpdateDraft }: {
  snapshot: TaskReviewSnapshot;
  unit: TaskTextReviewUnit;
  purpose: string;
  draft: { text?: string } | undefined;
  onUpdateDraft: (patch: { text?: string; selectionStart?: number; selectionEnd?: number }) => void;
}) {
  const { t } = useTranslation();
  const severityLabels = { high: t("High risk"), medium: t("Medium risk"), low: t("Low risk") } as const;
  const issues = issuesForUnit(snapshot, unit.id, purpose);
  if (!issues.length) return null;
  return (
    <section className="flex flex-col gap-1.5" data-testid="task-review-issues">
      <strong className="text-fg-2">{t("AI concerns (hypotheses, not conclusions)")}</strong>
      {issues.map((issue) => (
        <article
          key={issue.id}
          className={`rounded border p-2 ${issue.severity === "high" ? "border-status-error/60" : "border-border"}`}
          data-testid="task-review-issue"
          data-severity={issue.severity}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 ${issue.severity === "high" ? "bg-status-error/15 text-status-error" : "bg-bg-3 text-fg-2"}`}>
              {t(severityLabels[issue.severity])}
            </span>
            <strong className="min-w-0 flex-1">{issue.title}</strong>
          </div>
          <p className="mt-1 text-fg-2">
            {t("Evidence:")}<span className="rounded bg-bg-3 px-1">{issue.evidence}</span>
          </p>
          <p className="mt-1 text-fg-2">{t("Hypothesis:")}{issue.hypothesis}</p>
          {issue.options.length > 0 && (
            <ul className="mt-1 flex flex-col gap-1">
              {issue.options.map((option, index) => (
                <li key={index} className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    className={`${wbButton.ghost} h-6`}
                    title={option.reason}
                    onClick={() =>
                      onUpdateDraft({
                        text: `${draft?.text ?? ""}${draft?.text ? "\n" : ""}${option.label}`,
                        selectionStart: (draft?.text?.length ?? 0) + (draft?.text ? 1 : 0) + option.label.length,
                        selectionEnd: (draft?.text?.length ?? 0) + (draft?.text ? 1 : 0) + option.label.length,
                      })
                    }
                  >
                    {option.label}
                  </button>
                  <span className="min-w-0 flex-1 text-fg-3">{option.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </section>
  );
}

/**
 * AI-native task review shell, rebuilt on the design's single working-timeline
 * trunk: a neutral browse top bar, the plan/unit dock, the spotlight stage, a
 * draggable spotlight tool card, the unit track and timeline/export/global
 * overlays. All data and behaviour ride the existing controller, drafts, agent
 * runtime and timeline semantics; nothing about them is re-implemented here.
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

  // ---- Design-shell local state (session only; never review state). ----
  const { tipNode, bindTip } = useHoverTip();
  const [timelineDrawerOpen, setTimelineDrawerOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [copyModalOpen, setCopyModalOpen] = useState(false);
  const [spotlightActive, setSpotlightActive] = useState(true);
  const [cardFace, setCardFace] = useState<"tool" | "launcher">("tool");
  const [forceCompletion, setForceCompletion] = useState(false);
  const [bottomTrackCollapsed, setBottomTrackCollapsed] = useState(true);
  const [cardToolTab, setCardToolTab] = useState<"rewrite" | "note" | "criteria">("rewrite");
  const [replacement, setReplacement] = useState("");
  const [compareReplacements, setCompareReplacements] = useState<Record<string, string>>({});
  const [criterionText, setCriterionText] = useState("");
  const [criterionScope, setCriterionScope] = useState<"unit" | "source" | "task">("unit");
  const [exportFormat, setExportFormat] = useState<"srt" | "txt" | "json">("srt");
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [quickImportOpen, setQuickImportOpen] = useState(false);
  const [quickImportName, setQuickImportName] = useState(t("Dialogue text.txt"));
  const [quickImportText, setQuickImportText] = useState("");
  const [quickImportBusy, setQuickImportBusy] = useState(false);
  const [agentSetupSkipped, setAgentSetupSkipped] = useState(false);
  const [dismissedProposalId, setDismissedProposalId] = useState<string | null>(null);
  const [cardModelSettingsOpen, setCardModelSettingsOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string>("custom");
  const [modelConfig, setModelConfig] = useState<TaskModelConfig | null>(null);
  const [inlineEndpoint, setInlineEndpoint] = useState("");
  const [inlineModel, setInlineModel] = useState("");
  const [inlineApiKey, setInlineApiKey] = useState("");
  const [inlineSaving, setInlineSaving] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    void agent
      .getModelConfig()
      .then((cfg) => {
        if (!cancelled) setModelConfig(cfg);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agent]);

  useEffect(() => {
    if (modelConfig) {
      if (modelConfig.endpoint) {
        setInlineEndpoint((prev) => prev || modelConfig.endpoint);
        setSelectedProvider(detectProviderPreset(modelConfig.endpoint));
      }
      if (modelConfig.backgroundModel) setInlineModel((prev) => prev || modelConfig.backgroundModel);
    }
  }, [modelConfig]);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const showToast = useCallback((message: string) => {
    window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
    return message;
  }, []);
  const copyText = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(t("Copied {{label}}", { label }));
    } catch {
      showToast(t("Failed to copy {{label}}", { label }));
    }
  }, [showToast, t]);

  // ---- Derived view model. ----
  const scene = activeScene(timeline);
  const unit =
    (scene.kind === "unit" || scene.kind === "edit" || scene.kind === "agent") && snapshot
      ? findUnit(snapshot, scene.ref.unitId)
      : null;
  const stats = snapshot ? unitStats(snapshot) : null;
  const nextTarget = snapshot ? continueScene(snapshot, timeline) : null;
  const workFocus = timeline.focus ?? workingRef(timeline);
  const workingScene = timeline.position === null ? null : timeline.sceneAnchors[timeline.position];
  const currentIds = useMemo(() => (snapshot ? currentSourceIds(snapshot) : new Set<string>()), [snapshot]);
  const analyzed = useMemo(
    () => (snapshot ? analyzedUnitIds(snapshot, agentRuntime.state) : new Set<string>()),
    [snapshot, agentRuntime.state],
  );
  const dockUnits = useMemo(() => (
    snapshot ? snapshot.units.filter((candidate) => isCurrentTaskUnit(snapshot, candidate) && currentIds.has(candidate.sourceVersionId)) : []
  ), [snapshot, currentIds]);
  const planList = snapshot ? planScenes(snapshot) : [];
  const directoryActive = scene.kind === "directory";
  const allDecided = Boolean(stats && stats.total > 0 && stats.pending === 0);
  const completedView = allDecided || forceCompletion;
  const busy = controller.busy || savingGroup;
  const sourceFilesCount = (snapshot?.sourceFiles?.length ?? 0) || (snapshot?.sources?.length ?? 0);
  const coverage = snapshot ? preflightCoverage(snapshot, agentRuntime.state) : null;
  const isAuthorized = Boolean(agentRuntime.state?.grant);
  const isModelConfigured = Boolean(
    modelConfig &&
    modelConfig.endpoint?.trim() &&
    (modelConfig.backgroundModel?.trim() || modelConfig.completionModel?.trim()) &&
    modelConfig.hasApiKey,
  );
  const activeJob = (agentRuntime.state?.jobs ?? []).find(
    (job) => job.status === "queued" || job.status === "running",
  );
  const isPreflightRunning = Boolean(activeJob);
  const proposal = snapshot?.contextHistory ? selectTaskContextForPlanning(snapshot.contextHistory) : undefined;
  const adopted = snapshot?.contextHistory ? selectAdoptedTaskContext(snapshot.contextHistory) : undefined;
  const isProposalPendingAdoption = Boolean(
    proposal &&
    proposal.proposedBy === "agent" &&
    adopted?.id !== proposal.id &&
    dismissedProposalId !== proposal.id,
  );

  const focusedDecision =
    snapshot && openRef ? unitDecisionState(snapshot, openRef.unitId, openRef.purpose) : null;
  const focusedUnitRow = snapshot && openRef ? findUnit(snapshot, openRef.unitId) : null;
  const focusedStatusText = focusedDecision
    ? focusedDecision.status
      ? t(statusLabels[focusedDecision.status])
      : focusedDecision.needsRecheck
        ? t("Needs recheck")
        : t("Pending")
    : null;

  // The replacement field is explicit reviewer input, never an implicit
  // draft; it re-seeds from the applied decision and resets per unit.
  useEffect(() => {
    setReplacement(focusedDecision?.replacementText ?? "");
  }, [focusedDecision?.replacementText, openRef?.unitId]);
  // The sub-tool resets on a real unit change only; a covering overlay makes
  // currentRef null without moving the reviewer to another unit.
  const tabUnitRef = useRef<string | null>(null);
  useEffect(() => {
    const unitId = openRef?.unitId ?? null;
    if (unitId === null) return;
    if (tabUnitRef.current !== unitId) {
      tabUnitRef.current = unitId;
      setCardToolTab("rewrite");
    }
  }, [openRef?.unitId]);

  const agentScene =
    scene.kind === "agent" && snapshot
      ? {
          suggestion: scene.suggestion,
          current: isTaskSceneCurrent(snapshot, scene.suggestion, scene.suggestion.criteriaBasis[0]?.policyRevision ?? snapshot.policyRevision),
        }
      : null;

  interface CompareMember { unit: TaskTextReviewUnit; target: UnitRef; decision: ReturnType<typeof unitDecisionState>; stale: boolean; known: boolean }
  const compareMembers: CompareMember[] = useMemo(() => {
    if (!snapshot || !agentScene || agentScene.suggestion.kind !== "compare") return [];
    return agentScene.suggestion.targets.flatMap((targetRow) => {
      const row = findUnit(snapshot, targetRow.unitId);
      return row && isTextTaskUnit(row)
        ? [{
            unit: row,
            target: { ...targetRow, purpose: agentScene.suggestion.purpose },
            decision: unitDecisionState(snapshot, targetRow.unitId, agentScene.suggestion.purpose),
            stale: !currentIds.has(targetRow.sourceVersionId),
            known: analyzed.has(targetRow.unitId),
          }]
        : [];
    });
  }, [snapshot, agentScene, currentIds, analyzed]);

  interface GroupMember { unit: TaskTextReviewUnit; decision: ReturnType<typeof unitDecisionState>; known: boolean; eligible: boolean }
  const groupMembers: GroupMember[] = useMemo(() => {
    if (!snapshot || !agentScene || agentScene.suggestion.kind !== "lowRiskGroup") return [];
    return agentScene.suggestion.targets.flatMap((targetRow) => {
      const row = findUnit(snapshot, targetRow.unitId);
      if (!row || !isTextTaskUnit(row)) return [];
      const decision = unitDecisionState(snapshot, targetRow.unitId, agentScene.suggestion.purpose);
      const known = analyzed.has(targetRow.unitId);
      const eligible = agentScene.current && known && issuesForUnit(snapshot, targetRow.unitId, agentScene.suggestion.purpose).length === 0 && !decision.status;
      return [{ unit: row, decision, known, eligible }];
    });
  }, [snapshot, agentScene, analyzed]);

  const selectedIds = agentScene ? timeline.sceneSelections[agentScene.suggestion.id] ?? [] : [];
  const chosenGroupIds = groupMembers.filter((member) => member.eligible && selectedIds.includes(member.unit.id)).map((member) => member.unit.id);

  const sceneTargets: UnitRef[] = useMemo(() => (
    agentScene
      ? agentScene.suggestion.targets.map((targetRow) => ({ ...targetRow, purpose: agentScene.suggestion.purpose }))
      : openRef ? [openRef] : []
  ), [agentScene, openRef]);
  const undecidedTargets = useMemo(() => (
    snapshot
      ? sceneTargets.filter((ref) => currentIds.has(ref.sourceVersionId) && findUnit(snapshot, ref.unitId) !== null && unitDecisionState(snapshot, ref.unitId, ref.purpose).status === null)
      : []
  ), [snapshot, sceneTargets, currentIds]);
  const sceneDecided = sceneTargets.length > 0 && undecidedTargets.length === 0;

  // ---- Navigation / decision handlers (existing semantics, unchanged). ----
  const openPending = () => {
    setPendingRequest((request) => request + 1);
    setTimeline((state) => openTemporary(state, "global"));
  };
  const navigateNext = (next: ReturnType<typeof continueScene>, planId: string | null) => {
    if (!next) return;
    setForceCompletion(false);
    setCardFace("tool");
    setTimeline((state) => {
      const base = { ...state, overlay: null };
      return next.suggestion && !next.suggestion.id.startsWith("legacy:")
        ? openAgentScene(base, next.suggestion, next.ref, planId)
        : openUnit(base, next.ref, planId);
    });
  };
  /**
   * Pure browse advance (top-bar → arrow and the card's 下一场景): never
   * writes a decision; at the end of the round it opens the pending list in
   * the global overview instead of pretending the work is done.
   */
  const handleContinuePlan = () => {
    const latest = controller.snapshotRef.current ?? snapshot;
    if (!latest) return;
    const next = continueScene(latest, timeline);
    if (next) navigateNext(next, latest.planRevisions.at(-1)?.id ?? null);
    else openPending();
  };
  const openPlannedScene = (suggestion: TaskSceneSuggestion) => {
    if (!snapshot) return;
    const sceneTarget = initialSceneTarget(snapshot, suggestion);
    navigateNext({ suggestion, ref: { ...sceneTarget, purpose: suggestion.purpose } }, snapshot.planRevisions.at(-1)?.id ?? null);
  };
  const openUnitById = (unitId: string) => {
    const latest = controller.snapshotRef.current ?? snapshot;
    const unitRow = latest ? findUnit(latest, unitId) : null;
    if (!unitRow) return;
    setCardFace("tool");
    setTimeline((state) =>
      openUnit(state, {
        unitId: unitRow.id,
        sourceVersionId: unitRow.sourceVersionId,
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
      const mediaUnit = next.units.find((item) => item.sourceVersionId === file?.currentVersionId && (item.kind === "image" || item.kind === "video"));
      if (!mediaUnit) throw new Error(t("Current image or video item not found"));
      openUnitById(mediaUnit.id);
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

  const decideTarget = async (ref: UnitRef, status: TaskDecisionStatus, replacementText?: string) => {
    if (!snapshot) return null;
    const draft = draftMap[ref.unitId];
    const result = await controller.decide({
      ...ref,
      status,
      note: draft?.text ?? "",
      ...(replacementText !== undefined ? { replacementText } : {}),
    });
    setActionError(result.ok ? null : result.error);
    return result;
  };
  const decideSingle = async (status: TaskDecisionStatus, replacementText?: string) => {
    if (!openRef) return;
    await decideTarget(openRef, status, replacementText);
  };
  const decideAndContinue = async (status: TaskDecisionStatus, replacementText?: string) => {
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
    } else {
      // Forward plan finished; earlier pending entries remain in the summary.
      setTimeline((state) => openTemporary(state, "global"));
    }
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
  // Timeline drawer undo rows can target any unit, not only the open one.
  const undoUnitById = async (unitId: string) => {
    const latest = controller.snapshotRef.current ?? snapshot;
    const unitRow = latest ? findUnit(latest, unitId) : null;
    if (!latest || !unitRow) return;
    const history = selectTaskDecisionHistory(latest, { unitId, sourceVersionId: unitRow.sourceVersionId, purpose: REVIEW_PURPOSE });
    if (!history.undo) return;
    const result = await controller.undoDecision({
      unitId,
      sourceVersionId: unitRow.sourceVersionId,
      purpose: REVIEW_PURPOSE,
      decisionId: history.undo.id,
      policyRevision: latest.policyRevision,
    });
    setActionError(result.ok ? null : result.error);
  };

  const batchDecide = async (unitIds: string[], status: TaskDecisionStatus) => {
    if (!snapshot) return;
    for (const unitId of unitIds) {
      const unitRow = findUnit(snapshot, unitId);
      if (!unitRow) continue;
      const result = await controller.decide({
        unitId: unitRow.id,
        sourceVersionId: unitRow.sourceVersionId,
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

  const keepSceneSelection = async (unitIds: string[]) => {
    if (!snapshot || scene.kind !== "agent" || groupSaving.current) return;
    groupSaving.current = true;
    setSavingGroup(true);
    const navigation = navigationSequence.current;
    let latest = snapshot;
    let saved = 0;
    try {
      for (const unitId of unitIds) {
        const targetRow = scene.suggestion.targets.find((item) => item.unitId === unitId)!;
        const result = await controller.decide({ ...targetRow, purpose: scene.suggestion.purpose, status: "kept", note: draftMap[unitId]?.text ?? "" }, (base) => {
          if (!isTaskSceneCurrent(base, scene.suggestion, snapshot.policyRevision)) throw new Error(t("Scene criteria or sources changed. Refresh the plan before confirming."));
        });
        if (!result.ok) {
          setActionError(t("Saved {{v0}}/{{v1}} items; remaining items incomplete: {{v2}}", { v0: saved, v1: unitIds.length, v2: result.error }));
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

  /** Compare 改词 tab: adopt each undecided target's replacement, then advance. */
  const adoptCompareAndContinue = async () => {
    if (!snapshot || !agentScene || agentScene.suggestion.kind !== "compare") return;
    const navigation = navigationSequence.current;
    for (const member of compareMembers) {
      if (member.decision.status || member.stale) continue;
      const replacementText = compareReplacements[member.unit.id]?.trim();
      const result = await controller.decide({
        ...member.target,
        status: "rework",
        note: draftMap[member.unit.id]?.text ?? "",
        ...(replacementText ? { replacementText } : {}),
      });
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
    }
    if (navigation !== navigationSequence.current) return;
    handleContinuePlan();
  };
  /** Compare non-rewrite tabs (design): keep every undecided target, then advance. */
  const keepUndecidedAndContinue = async () => {
    if (!snapshot) return;
    const navigation = navigationSequence.current;
    for (const ref of undecidedTargets) {
      const result = await controller.decide({ ...ref, status: "kept", note: draftMap[ref.unitId]?.text ?? "" });
      if (!result.ok) {
        setActionError(result.error);
        return;
      }
    }
    if (navigation !== navigationSequence.current) return;
    handleContinuePlan();
  };

  const toggleSceneSelect = (unitId: string, checked: boolean) => {
    if (!agentScene) return;
    setTimeline((state) => ({ ...state, sceneSelections: { ...state.sceneSelections,
      [agentScene.suggestion.id]: checked ? [...new Set([...(state.sceneSelections[agentScene!.suggestion.id] ?? []), unitId])] : (state.sceneSelections[agentScene!.suggestion.id] ?? []).filter((id) => id !== unitId),
    } }));
  };
  const focusCompareTarget = (member: CompareMember) => {
    if (!agentScene) return;
    setTimeline((state) => focusSceneTarget(state, member.target));
  };

  const adoptCriterion = async () => {
    if (!snapshot || !openRef || !focusedUnitRow || !criterionText.trim()) return;
    const source = snapshot.sources.find((item) => item.id === focusedUnitRow.sourceVersionId);
    const scope: TaskCriteriaScope =
      criterionScope === "unit"
        ? { kind: "units", targets: [{ unitId: openRef.unitId, sourceVersionId: openRef.sourceVersionId }] }
        : criterionScope === "source" && source
          ? { kind: "sources", entryIds: [source.entryId], versions: "current" }
          : { kind: "task", versions: "current" };
    const content = criterionText.trim();
    const result = await controller.adoptCriteria({
      content,
      scope,
      purpose: openRef.purpose,
      origin: { kind: "explicit", text: content },
    });
    if (result.ok) {
      setCriterionText("");
      showToast(t("Criteria saved"));
    } else {
      setActionError(result.error);
    }
  };

  // ---- Clipboard builders (real snapshot data only). ----
  const subtitleRows = useMemo(() => {
    if (!snapshot) return [] as { ordinal: number; body: string; status: TaskDecisionStatus; startMs?: number; endMs?: number; source: string }[];
    return snapshot.units
      .filter(isTextTaskUnit)
      .filter((candidate) => currentIds.has(candidate.sourceVersionId) && isCurrentTaskUnit(snapshot, candidate))
      .flatMap((candidate) => {
        const decision = unitDecisionState(snapshot, candidate.id, REVIEW_PURPOSE);
        if (decision.status !== "kept" && decision.status !== "rework") return [];
        const replaced = decision.status === "rework" && decision.replacementText?.trim();
        if (decision.status === "rework" && !replaced) return [];
        const source = snapshot.sources.find((item) => item.id === candidate.sourceVersionId);
        return [{
          ordinal: candidate.ordinal,
          body: replaced ? decision.replacementText!.trim() : candidate.text,
          status: decision.status,
          startMs: candidate.startMs,
          endMs: candidate.endMs,
          source: source?.relativePath ?? "",
        }];
      });
  }, [snapshot, currentIds]);

  const buildSubtitleExport = useCallback((format: "srt" | "txt" | "json") => {
    if (!subtitleRows.length) return { text: t("No approved items yet"), exportedCount: 0 };
    if (format === "json") {
      return {
        text: JSON.stringify(subtitleRows.map((row) => ({
          ordinal: row.ordinal,
          decision: row.status,
          deliveredText: row.body,
          source: row.source,
        })), null, 2),
        exportedCount: subtitleRows.length,
      };
    }
    if (format === "txt") {
      return {
        text: subtitleRows.map((row) => `[#${row.ordinal}] ${row.body}`).join("\n\n"),
        exportedCount: subtitleRows.length,
      };
    }
    return {
      text: subtitleRows
        .map((row, index) => `${index + 1}\n${srtTime(row.startMs ?? 0)} --> ${srtTime(row.endMs ?? row.startMs ?? 0)}\n${row.body}`)
        .join("\n\n"),
      exportedCount: subtitleRows.length,
    };
  }, [subtitleRows]);

  const buildReworkPrompt = useCallback(() => {
    if (!snapshot) return "";
    const rows = snapshot.units
      .filter(isTextTaskUnit)
      .filter((candidate) => currentIds.has(candidate.sourceVersionId) && isCurrentTaskUnit(snapshot, candidate))
      .flatMap((candidate) => {
        const decision = unitDecisionState(snapshot, candidate.id, REVIEW_PURPOSE);
        const issues = issuesForUnit(snapshot, candidate.id, REVIEW_PURPOSE);
        if (decision.status !== "rework" && issues.length === 0) return [];
        const source = snapshot.sources.find((item) => item.id === candidate.sourceVersionId);
        const instruction = decision.replacementText?.trim()
          ? t("Suggested replacement: \"{{v0}}\"", { v0: decision.replacementText.trim() })
          : t("Explanation: {{v0}}", { v0: decision.note || draftMap[candidate.id]?.text || t("Revise according to the criteria") });
        return [{
          line: t("- #{{v0}} [{{v1}}:{{v2}}]\n  Original: \"{{v3}}\"\n  {{v4}}", { v0: candidate.ordinal, v1: source?.relativePath ?? "?", v2: candidate.startLine, v3: candidate.text, v4: instruction }),
        }];
      });
    return t("# Rework instructions ({{v0}} · r{{v1}})\nPath: {{v2}}\n\n{{v3}}", { v0: name ?? root, v1: snapshot.revision, v2: root, v3: rows.map((row) => row.line).join("\n\n") || t("(No items currently need rework or have concerns)") });
  }, [snapshot, currentIds, draftMap, name, root, t]);

  const buildStartupPrompt = useCallback(() => {
    const title = name ?? root;
    return t("# ReelTerminal external Agent review collaboration instructions\n- Task: {{v0}}\n- Task root: {{v1}}\n\nYou are collaborating on a ReelTerminal review task using reelctl or MCP tools.\nFollow these steps:\n1. Check task state and originals:\n   reelctl task-review status --root \"{{v2}}\"\n2. View existing items or import dialogue:\n   reelctl task-review import --root \"{{v3}}\" <dialogue-file-path>\n3. Review or generate suggestions according to the review criteria.\n", { v0: title, v1: root, v2: root, v3: root });
  }, [name, root, t]);

  const handleQuickImport = useCallback(async () => {
    if (!quickImportText.trim()) return;
    setQuickImportBusy(true);
    try {
      const res = await controller.importText({
        name: quickImportName.trim() || t("Dialogue text.txt"),
        text: quickImportText,
        format: "txt",
      });
      if (res.ok) {
        setQuickImportText("");
        setQuickImportOpen(false);
        showToast(t("Text imported successfully"));
      } else if (res.error) {
        showToast(t("Import failed: {{msg}}", { msg: res.error }));
      }
    } catch (e) {
      showToast(t("Import failed: {{msg}}", { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setQuickImportBusy(false);
    }
  }, [controller, quickImportName, quickImportText, showToast, t]);

  const handleSelectProvider = useCallback((providerId: string) => {
    setSelectedProvider(providerId);
    const preset = getProviderPreset(providerId);
    if (preset && preset.id !== "custom") {
      setInlineEndpoint(preset.endpoint);
      const firstModel = preset.models[0] ?? "";
      setInlineModel(firstModel);
    }
  }, []);

  const handleSaveModelOnly = useCallback(async () => {
    if (!agent) return;
    setInlineSaving(true);
    setInlineError(null);
    try {
      const updated = await agent.configureModel({
        endpoint: inlineEndpoint.trim(),
        backgroundModel: inlineModel.trim(),
        completionModel: inlineModel.trim(),
        ...(inlineApiKey.trim() ? { apiKey: inlineApiKey.trim() } : {}),
      });
      setModelConfig(updated);
      setInlineApiKey("");
      setCardModelSettingsOpen(false);
      setInlineApiKey("");
      setCardModelSettingsOpen(false);
      showToast(t("Model configuration saved"));
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : String(err));
    } finally {
      setInlineSaving(false);
    }
  }, [agent, inlineApiKey, inlineEndpoint, inlineModel, showToast, t]);

  const handleConfigureAndStartPreflight = useCallback(async () => {
    if (!agent || !snapshot) return;
    setInlineSaving(true);
    setInlineError(null);
    try {
      const updated = await agent.configureModel({
        endpoint: inlineEndpoint.trim(),
        backgroundModel: inlineModel.trim(),
        completionModel: inlineModel.trim(),
        ...(inlineApiKey.trim() ? { apiKey: inlineApiKey.trim() } : {}),
      });
      setModelConfig(updated);
      const sourceIds = currentSources(snapshot).filter(isTextTaskSource).map((s) => s.id);
      await agent.authorize({ root: snapshot.root, taskId: snapshot.taskId, scope: "task", sourceVersionIds: sourceIds });
      await agent.startPreflight({ root: snapshot.root, taskId: snapshot.taskId });
      void agentRuntime.refresh(true);
      showToast(t("Model configured and review started"));
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : String(err));
    } finally {
      setInlineSaving(false);
    }
  }, [agent, agentRuntime, inlineApiKey, inlineEndpoint, inlineModel, snapshot, showToast, t]);

  const handleStartPreflight = useCallback(async () => {
    if (!agent || !snapshot) return;
    try {
      const sourceIds = currentSources(snapshot).filter(isTextTaskSource).map((s) => s.id);
      await agent.authorize({ root: snapshot.root, taskId: snapshot.taskId, scope: "task", sourceVersionIds: sourceIds });
      await agent.startPreflight({ root: snapshot.root, taskId: snapshot.taskId });
      void agentRuntime.refresh(true);
      showToast(t("AI review started"));
    } catch (err) {
      showToast(t("Failed to start review: {{msg}}", { msg: err instanceof Error ? err.message : String(err) }));
    }
  }, [agent, agentRuntime, snapshot, showToast, t]);

  const handleAdoptProposal = useCallback(async () => {
    if (!proposal || !snapshot) return;
    const authorizedSourceVersionIds = currentAuthorizedSourceVersionIds(snapshot);
    const result = await controller.adoptContext({
      proposalId: proposal.id,
      authorizedSourceVersionIds,
    });
    if (result.ok) {
      showToast(t("AI understanding proposal adopted"));
      const firstScene = planList[0];
      if (firstScene) {
        openPlannedScene(firstScene);
      }
    } else if (result.error) {
      showToast(t("Failed to adopt proposal: {{msg}}", { msg: result.error }));
    }
  }, [controller, openPlannedScene, planList, proposal, snapshot, showToast, t]);

  // ---- Card assembly. ----
  const focusedSource = snapshot && focusedUnitRow ? snapshot.sources.find((item) => item.id === focusedUnitRow.sourceVersionId) : null;
  const describeCurrentScene = () => {
    if (exportOpen) return t("Export");
    if (timeline.overlay === "global") return t("Overview");
    if (directoryActive) return t("Original");
    if (scene.kind === "edit") return t("Detailed edit");
    if (agentScene) return agentScene.suggestion.checkIntent;
    if (unit && snapshot) {
      const source = snapshot.sources.find((item) => item.id === unit.sourceVersionId);
      return `#${unit.ordinal} ${source ? sourceTitle(source.relativePath) : ""}`;
    }
    return name ?? root;
  };

  const cardHeaderTitle = cardModelSettingsOpen
    ? t("Model and API key")
    : cardFace === "launcher"
    ? t("Workbench")
    : completedView && stats
      ? t("{{decided}}/{{total}} completed", { decided: stats.decided, total: stats.total })
      : agentScene
        ? agentScene.suggestion.checkIntent
        : unit
          ? `#${unit.ordinal} ${focusedSource ? sourceTitle(focusedSource.relativePath) : ""}`
          : snapshot?.units.length === 0
            ? t("Built-in Agent · Standing by")
            : isPreflightRunning
              ? t("Built-in Agent · Reviewing")
              : isProposalPendingAdoption
                ? t("Built-in Agent · Task understanding proposal")
                : agent && !isAuthorized && !agentSetupSkipped && (coverage?.unanalyzed ?? 0) > 0 && !isModelConfigured
                  ? t("Built-in Agent · Model configuration")
                  : t("Built-in Agent");

  const returnToStage = () => {
    setCardFace("tool");
    setForceCompletion(false);
    if (exportOpen) {
      setExportOpen(false);
      return;
    }
    if (timeline.overlay) setTimeline((state) => back(state));
  };
  const openGlobal = () => {
    setCardFace("tool");
    setExportOpen(false);
    setTimeline((state) => openTemporary(state, "global"));
  };

  const launcherItems: SpotlightLauncherItem[] = [
    { id: "stage", label: t("Main stage"), tip: t("Return to the current spotlight review scene"), icon: Sparkles,
      active: !exportOpen && timeline.overlay === null && !completedView && !directoryActive,
      testId: "task-review-launcher-stage", onClick: returnToStage },
    { id: "overview", label: t("Overview"), tip: t("Open the global list of all review items"), icon: Layers,
      active: !exportOpen && timeline.overlay === "global",
      testId: "task-review-launcher-overview", onClick: openGlobal },
    { id: "export", label: t("Export"), tip: t("Open originals and result export"), icon: Download,
      active: exportOpen, testId: "task-review-launcher-export",
      onClick: () => { setCardFace("tool"); setExportOpen(true); } },
    { id: "agent", label: t("Model and Agent"), tip: t("Configure the built-in Agent model connection and API key"), icon: Bot,
      active: cardModelSettingsOpen, testId: "task-review-launcher-agent",
      onClick: () => {
        setCardFace("tool");
        setCardModelSettingsOpen(true);
      } },
    { id: "copy", label: t("Copy"), tip: t("Copy the current item, rework instructions or approved subtitles"), icon: Copy,
      active: copyModalOpen, testId: "task-review-launcher-copy", onClick: () => setCopyModalOpen(true) },
    { id: "import", label: t("Import"), tip: t("Import new source text in the overview"), icon: Upload,
      active: false, testId: "task-review-launcher-import", onClick: openGlobal },
    { id: "files", label: t("Original"), tip: t("View original files in the task folder"), icon: FileText,
      active: !exportOpen && timeline.overlay === "directory", testId: "task-review-launcher-files",
      onClick: () => { setCardFace("tool"); setTimeline((state) => openTemporary(state, "directory")); } },
    { id: "criteria", label: t("Criteria"), tip: t("Manage task understanding and review criteria in the overview"), icon: CheckCircle2,
      active: false, testId: "task-review-launcher-criteria", onClick: openGlobal },
  ];

  const stepDots: SpotlightStepDot[] = snapshot && !cardModelSettingsOpen && !directoryActive ? planList.map((suggestion) => ({
    id: suggestion.id,
    title: t("Scene: {{intent}}", { intent: suggestion.checkIntent }),
    detail: pendingSceneTargets(snapshot, suggestion).length === 0
      ? t("All items in this scene have decisions. Click to review them.")
      : t("Enter this scene"),
    active: Boolean(agentScene && agentScene.suggestion.id === suggestion.id) && !completedView,
    done: pendingSceneTargets(snapshot, suggestion).length === 0,
    onClick: () => openPlannedScene(suggestion),
  })) : [];

  const primaryAction: SpotlightPrimaryAction | null = (() => {
    if (!snapshot || !stats || scene.kind === "edit" || completedView) return null;
    const shouldStartPreflightAfterSave =
      (coverage?.unanalyzed ?? 0) > 0 && !isAuthorized && (snapshot?.units.length ?? 0) > 0;
    if (cardModelSettingsOpen) {
      return {
        label: inlineSaving
          ? t("Saving…")
          : shouldStartPreflightAfterSave
            ? t("Save and start review")
            : t("Save model configuration"),
        testId: "task-review-save-model-btn",
        disabled:
          inlineSaving ||
          !inlineEndpoint.trim() ||
          !inlineModel.trim() ||
          (!modelConfig?.hasApiKey && !inlineApiKey.trim()),
        tipTitle: shouldStartPreflightAfterSave
          ? t("Save model configuration, authorize this task and start AI review")
          : t("Save the built-in Agent model connection and API key"),
        onClick: () => {
          if (shouldStartPreflightAfterSave) {
            void handleConfigureAndStartPreflight();
          } else {
            void handleSaveModelOnly();
          }
        },
      };
    }
    if (openRef) {
    if (agentScene && agentScene.suggestion.kind === "lowRiskGroup") {
      return {
        label: t("Keep selected ({{count}}) and continue", { count: chosenGroupIds.length }),
        testId: "task-review-group-keep-continue",
        disabled: busy || chosenGroupIds.length === 0 || !agentScene.current,
        tipTitle: t("Keep {{count}} selected items and move to the next scene", { count: chosenGroupIds.length }),
        tipDetail: t("Approve low-risk items without conflicts as a group; unselected items remain pending"),
        onClick: () => void keepSceneSelection(chosenGroupIds),
      };
    }
    if (sceneDecided && undecidedTargets.length === 0 && sceneTargets.length > 0) {
      return {
        label: t("reviewUi.nextScene"),
        doneState: true,
        testId: "task-review-next-scene",
        disabled: busy,
        tipTitle: t("This scene has decisions → Go to the next scene"),
        tipDetail: t("Your choices are saved. Continue without overwriting your conclusions."),
        onClick: handleContinuePlan,
      };
    }
    if (agentScene && agentScene.suggestion.kind === "compare" && cardToolTab === "rewrite") {
      const single = undecidedTargets.length === 1 && compareMembers.some((member) => member.unit.id === undecidedTargets[0]!.unitId);
      return {
        label: single
          ? t("Accept revision for #{{no}} and continue", { no: focusedUnitRow?.ordinal ?? "" })
          : t("Accept revision and continue"),
        testId: "task-review-adopt-continue",
        disabled: busy,
        tipTitle: t("Apply the revised dialogue above (mark as rework) and go to the next scene"),
        tipDetail: t("Apply replacements only to undecided items; preserve items already decided manually"),
        onClick: () => void adoptCompareAndContinue(),
      };
    }
    if (agentScene && agentScene.suggestion.kind === "compare") {
      return {
        label: t("Keep undecided items and continue"),
        testId: "task-review-keep-continue",
        disabled: busy,
        tipTitle: t("Keep all undecided items in this scene and go to the next scene"),
        tipDetail: t("Keep original dialogue unchanged and continue to the next planned scene"),
        onClick: () => void keepUndecidedAndContinue(),
      };
    }
      return {
        label: t("Keep and continue"),
        testId: "task-review-keep-continue",
        disabled: busy || !currentIds.has(openRef.sourceVersionId),
        tipTitle: t("Keep #{{no}} and go to the next scene", { no: focusedUnitRow?.ordinal ?? "" }),
        tipDetail: t("Confirm keep and move to the next item in one step"),
        onClick: () => void decideAndContinue("kept"),
      };
    }
    if (snapshot.units.length > 0) {
      if (isProposalPendingAdoption) {
        return {
          label: t("Adopt and continue review"),
          testId: "task-review-adopt-proposal-cta",
          disabled: busy,
          tipTitle: t("Adopt the AI understanding proposal and enter the first scene"),
          onClick: () => void handleAdoptProposal(),
        };
      }
      if (agent && !isAuthorized && !agentSetupSkipped && (coverage?.unanalyzed ?? 0) > 0) {
        if (!isModelConfigured) {
          return {
            label: inlineSaving ? t("Saving…") : t("Save and start review"),
            testId: "task-review-save-model-btn",
            disabled: inlineSaving || !inlineEndpoint.trim() || !inlineModel.trim() || (!modelConfig?.hasApiKey && !inlineApiKey.trim()),
            tipTitle: t("Save model configuration, authorize this task and start AI review"),
            onClick: () => void handleConfigureAndStartPreflight(),
          };
        }
        return {
          label: t("Start AI review"),
          testId: "task-review-start-preflight",
          disabled: busy,
          tipTitle: t("Start AI review and planning for this task"),
          tipDetail: t("Summarize criteria and organize planned scenes automatically"),
          onClick: () => void handleStartPreflight(),
        };
      }
    }
    return null;
  })();

  const footerStatus = (() => {
    const runningBadge = isPreflightRunning ? (
      <span className="flex items-center gap-1.5 text-[11px] text-accent" data-testid="task-review-agent-running">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        <span>{t("AI is reviewing and planning…")}</span>
      </span>
    ) : null;

    if (openRef && focusedUnitRow && !completedView && !cardModelSettingsOpen) {
      return (
        <span className="flex min-w-0 items-center gap-2 text-[11px] text-fg-3" data-testid="task-review-card-status">
          <span className="shrink-0 font-mono text-[11px] font-bold text-accent">#{focusedUnitRow.ordinal}</span>
          <span className="shrink-0">{focusedStatusText}</span>
          {runningBadge}
        </span>
      );
    }
    return runningBadge;
  })();

  // ---- Tool-card body per stage type. ----
  const hint = (text: string) => (
    <p className="rounded-lg bg-[#101216] px-2.5 py-2 text-[11px] leading-relaxed text-fg-3">{text}</p>
  );

  const completionHub = stats && (
    <div className="flex flex-col gap-2.5" data-testid="spotlight-completion-hub">
      <div className="grid grid-cols-3 gap-1.5 text-center">
        <div className="rounded-lg bg-[#101216] py-2">
          <span className="block font-mono text-sm font-bold text-accent">{stats.kept}</span>
          <span className="text-[10px] text-fg-3">{t("Keep")}</span>
        </div>
        <div className="rounded-lg bg-[#101216] py-2">
          <span className="block font-mono text-sm font-bold text-amber-400">{stats.rework}</span>
          <span className="text-[10px] text-fg-3">{t("Rework")}</span>
        </div>
        <div className="rounded-lg bg-[#101216] py-2">
          <span className="block font-mono text-sm font-bold text-rose-400">{stats.discarded}</span>
          <span className="text-[10px] text-fg-3">{t("Discard")}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setExportOpen(true)}
          data-testid="spotlight-open-export"
          {...bindTip(t("Open export panel"), t("Filter by status and copy originals and derived results to an external directory"))}
          className="flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-xs font-bold text-accent-fg hover:brightness-110"
        >
          <Download className="h-4 w-4" />
          {t("Export ({{count}})", { count: subtitleRows.length })}
        </button>
        <button
          type="button"
          onClick={openGlobal}
          data-testid="spotlight-open-overview"
          {...bindTip(t("Open overview"), t("View every item's decision status and revision history together"))}
          className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-accent/50 bg-[#101216] py-2.5 text-xs font-semibold text-fg hover:bg-[#1a1f27]"
        >
          <Layers className="h-4 w-4 text-accent" />
          {t("Overview ({{count}})", { count: stats.total })}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => void copyText(buildSubtitleExport(exportFormat).text, t("Approved subtitles"))}
          {...bindTip(t("Copy approved subtitles"), t("Copy kept and revised items to the clipboard in the current format"))}
          className="flex cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-[#101216] py-1.5 text-[11px] text-fg-2 hover:text-white"
        >
          <Copy className="h-3 w-3 text-accent" />
          {t("Copy subtitles")}
        </button>
        <button
          type="button"
          onClick={() => setAgentModalOpen(true)}
          {...bindTip(t("Hand off to an external Agent"), t("Copy rework instructions or view background analysis jobs"))}
          className="flex cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-[#101216] py-1.5 text-[11px] text-fg-2 hover:text-white"
        >
          <Bot className="h-3 w-3 text-accent" />
          {t("External Agent")}
        </button>
      </div>
    </div>
  );

  const groupToolBody = agentScene && agentScene.suggestion.kind === "lowRiskGroup" && unit && isTextTaskUnit(unit) && snapshot && (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1 rounded-lg bg-[#101216] p-2">
        {groupMembers.map((member) => {
          const checked = selectedIds.includes(member.unit.id) && member.eligible;
          return (
            <label key={member.unit.id} className="flex items-center justify-between gap-2 rounded bg-bg-2 px-2.5 py-1.5 text-xs">
              <span className="flex min-w-0 items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!member.eligible || busy}
                  onChange={(event) => toggleSceneSelect(member.unit.id, event.target.checked)}
                />
                <span className="truncate font-medium text-fg">
                  #{member.unit.ordinal} {member.unit.text.split("\n")[0]}
                </span>
              </span>
              <span className="shrink-0 text-[10px] text-fg-3">
                {member.decision.status ? t(statusLabels[member.decision.status]) : member.eligible ? t("No concerns") : member.known ? t("Has concerns") : t("Risk unknown")}
              </span>
            </label>
          );
        })}
      </div>
      <FeedbackEditor
        unit={unit}
        root={snapshot.root}
        taskId={snapshot.taskId}
        agent={agent}
        agentState={agentRuntime.state}
        draft={draftMap[unit.id]}
        inputTestId="task-review-unit-note"
        disabled={!currentIds.has(unit.sourceVersionId)}
        policyRevision={snapshot.policyRevision}
        onUpdateDraft={(patch) => updateDraft(unit.id, unit.sourceVersionId, patch)}
      />
    </div>
  );

  const compareToolBody = agentScene && agentScene.suggestion.kind === "compare" && snapshot && (
    <div className="flex flex-col gap-2">
      {compareMembers.map((member) => {
        const value = compareReplacements[member.unit.id] ?? member.decision.replacementText ?? "";
        return (
          <div key={member.unit.id} className="flex flex-col gap-1 rounded-lg bg-[#101216] p-2.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="flex min-w-0 items-center gap-1.5">
                <strong className="shrink-0 text-fg-2">#{member.unit.ordinal}</strong>
                {member.decision.status && (
                  <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold ${
                    member.decision.status === "kept"
                      ? "bg-accent/15 text-accent"
                      : member.decision.status === "rework"
                        ? "bg-amber-500/20 text-amber-300"
                        : "bg-rose-500/20 text-rose-300"
                  }`}>
                    {t("Selected: {{status}}", { status: t(statusLabels[member.decision.status]) })}
                  </span>
                )}
              </span>
              {!member.decision.status && !member.stale && (
                <button
                  type="button"
                  {...bindTip(t("Accept this revision for #{{v0}}", { v0: member.unit.ordinal }), t("Mark this item as rework and fill in the replacement above; stay on this page"))}
                  className="shrink-0 cursor-pointer text-accent hover:underline"
                  onClick={() => void decideTarget(member.target, "rework", compareReplacements[member.unit.id]?.trim() || undefined)}
                >
                  {t("Accept revision")}
                </button>
              )}
            </div>
            <textarea
              aria-label={t("Replacement text for #{{no}}", { no: member.unit.ordinal })}
              value={value}
              disabled={Boolean(member.decision.status) || member.stale}
              onChange={(event) => setCompareReplacements((current) => ({ ...current, [member.unit.id]: event.target.value }))}
              placeholder={t("Replacement (leave blank to mark for rework only)")}
              className="min-h-14 w-full rounded border border-border bg-bg-2 p-2 text-xs leading-relaxed text-fg focus:border-accent focus:outline-none disabled:opacity-60"
            />
          </div>
        );
      })}
      {unit && isTextTaskUnit(unit) && (
        <FeedbackEditor
          unit={unit}
          root={snapshot.root}
          taskId={snapshot.taskId}
          agent={agent}
          agentState={agentRuntime.state}
          draft={draftMap[unit.id]}
          inputTestId="task-review-unit-note"
          disabled={!currentIds.has(unit.sourceVersionId)}
          policyRevision={snapshot.policyRevision}
          onUpdateDraft={(patch) => updateDraft(unit.id, unit.sourceVersionId, patch)}
        />
      )}
    </div>
  );

  const criteriaForm = unit && isTextTaskUnit(unit) && openRef && (
    <form
      className="flex flex-col gap-2 rounded-lg bg-[#101216] p-2.5"
      data-testid="task-review-criteria-form"
      onSubmit={(event) => {
        event.preventDefault();
        void adoptCriterion();
      }}
    >
      <input
        className="w-full rounded border border-border bg-bg-2 px-2.5 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
        placeholder={t("Add criteria rule…")}
        aria-label={t("Criteria content")}
        value={criterionText}
        onChange={(event) => setCriterionText(event.target.value)}
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[11px] text-fg-2">
          {([["unit", t("This item")], ["source", t("File")], ["task", t("Global")]] as const).map(([scopeKey, label]) => (
            <label key={scopeKey} className="inline-flex cursor-pointer items-center gap-1">
              <input
                type="radio"
                name="criterion-scope"
                checked={criterionScope === scopeKey}
                onChange={() => setCriterionScope(scopeKey)}
              />
              <span>{t(label)}</span>
            </label>
          ))}
        </div>
        <button
          type="submit"
          className={wbButton.primary}
          disabled={!contextBridge || busy || !criterionText.trim()}
          title={contextBridge ? t("Explicitly adopt this rule as review criteria") : t("This desktop shell has no task understanding connection")}
        >
          {t("Save")}
        </button>
      </div>
    </form>
  );

  const textToolBody = unit && isTextTaskUnit(unit) && snapshot && openRef && (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 rounded-lg bg-[#101216] p-1">
        {([
          ["rewrite", t("Revision"), t("Edit replacement dialogue directly (adoption marks it as rework)")],
          ["note", t("Notes"), t("Write review notes or accept AI completion suggestions")],
          ["criteria", t("Criteria"), t("Turn the current judgment into review criteria")],
        ] as const).map(([tabKey, label, tip]) => (
          <button
            key={tabKey}
            type="button"
            data-testid={`task-review-card-tab-${tabKey}`}
            onClick={() => setCardToolTab(tabKey)}
            {...bindTip(t(label), t(tip))}
            className={`flex-1 cursor-pointer rounded py-1 text-center text-xs font-medium transition-colors ${
              cardToolTab === tabKey ? "bg-accent font-semibold text-accent-fg" : "text-fg-2 hover:text-white"
            }`}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {cardToolTab === "rewrite" && (
        <div className="flex flex-col gap-2 rounded-lg bg-[#101216] p-2.5" data-testid="task-review-replacement-field">
          <div className="flex items-center justify-between text-[11px]">
            <span className="min-w-0 truncate font-medium text-fg-2">
              #{unit.ordinal} {focusedSource ? sourceTitle(focusedSource.relativePath) : ""}
            </span>
            <button
              type="button"
              {...bindTip(t("Accept revision"), t("Fill in replacement dialogue and mark this item as rework; stay on this page"))}
              className="shrink-0 cursor-pointer text-accent hover:underline"
              onClick={() => void decideSingle("rework", replacement.trim() || undefined)}
            >
              {t("Accept revision")}
            </button>
          </div>
          <textarea
            aria-label={t("Rework replacement text")}
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            placeholder={t("Replacement (leave blank to mark for rework only)")}
            className="min-h-20 w-full rounded border border-border bg-bg-2 p-2 text-xs leading-relaxed text-fg focus:border-accent focus:outline-none"
          />
          {focusedDecision?.replacementText && (
            <p className="text-[11px] leading-relaxed text-amber-300" data-testid="task-review-current-replacement">
              {t("Current replacement: {{text}}", { text: focusedDecision.replacementText })}
            </p>
          )}
          <button
            type="button"
            className={`${wbButton.ghost} self-start`}
            data-testid="task-review-open-edit"
            disabled={!currentIds.has(unit.sourceVersionId)}
            onClick={() => setTimeline((state) => setEditing(state, true))}
          >
            {t("Detailed edit")}
          </button>
        </div>
      )}
      {cardToolTab === "note" && (
        <FeedbackEditor
          unit={unit}
          root={snapshot.root}
          taskId={snapshot.taskId}
          agent={agent}
          agentState={agentRuntime.state}
          draft={draftMap[unit.id]}
          inputTestId="task-review-unit-note"
          disabled={!currentIds.has(unit.sourceVersionId)}
          policyRevision={snapshot.policyRevision}
          onUpdateDraft={(patch) => updateDraft(unit.id, unit.sourceVersionId, patch)}
        />
      )}
      {cardToolTab === "criteria" && criteriaForm}
    </div>
  );

  const mediaToolBody = unit && !isTextTaskUnit(unit) && (
    <div className="flex flex-col gap-2">
      {hint(t("Annotate, capture frames and select regions on the left stage; MediaScene provides the full media tools."))}
    </div>
  );

  const emptyAgentBody = (
    <div className="flex flex-col gap-3" data-testid="task-review-empty-agent-state">
      <div className="flex items-start gap-2.5 rounded-lg bg-[#101216] p-3 border border-white/5">
        <Bot className="h-5 w-5 shrink-0 text-accent mt-0.5" />
        <div className="flex flex-col gap-1 text-[11px] leading-relaxed">
          <strong className="text-fg font-medium">
            {sourceFilesCount > 0 ? t("Source media found") : t("Built-in Agent standing by")}
          </strong>
          <p className="text-fg-3">
            {sourceFilesCount > 0
              ? t("This folder contains source media. Import dialogue text or use the startup prompt with an Agent to generate review items.")
              : t("This task is empty. Import dialogue or originals to start automatic review and planning, or copy the startup prompt to collaborate with an external Agent.")}
          </p>
        </div>
      </div>

      {quickImportOpen ? (
        <div className="flex flex-col gap-2 rounded-lg bg-[#101216] p-2.5 border border-accent/40" data-testid="task-review-inline-import-form">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-semibold text-fg">{t("Quick import dialogue / text")}</span>
            <button
              type="button"
              onClick={() => setQuickImportOpen(false)}
              className="text-fg-3 hover:text-fg cursor-pointer text-[10px]"
            >
              {t("Cancel")}
            </button>
          </div>
          <input
            className="w-full rounded border border-border bg-bg-2 px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
            placeholder={t("Source name (for example: Episode 1 dialogue.txt)")}
            value={quickImportName}
            onChange={(e) => setQuickImportName(e.target.value)}
          />
          <textarea
            className="min-h-24 w-full rounded border border-border bg-bg-2 p-2 text-xs text-fg focus:border-accent focus:outline-none"
            placeholder={t("Paste dialogue or subtitles, one item per line…")}
            value={quickImportText}
            onChange={(e) => setQuickImportText(e.target.value)}
          />
          <button
            type="button"
            disabled={quickImportBusy || !quickImportText.trim()}
            onClick={() => void handleQuickImport()}
            className="flex h-7 items-center justify-center rounded-lg bg-accent px-3 text-xs font-bold text-accent-fg hover:brightness-110 cursor-pointer disabled:opacity-40"
            data-testid="task-review-quick-import-submit"
          >
            {quickImportBusy ? t("Importing…") : t("Confirm import")}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setQuickImportOpen(true)}
            data-testid="task-review-empty-import-text"
            className="flex h-8 items-center justify-center gap-2 rounded-lg bg-accent/20 border border-accent/40 px-3 text-xs font-medium text-accent hover:bg-accent/30 cursor-pointer transition-colors"
          >
            <Upload className="h-3.5 w-3.5" />
            {t("Import text / dialogue")}
          </button>

          <button
            type="button"
            onClick={() => {
              setCardFace("tool");
              setTimeline((state) => openTemporary(state, "directory"));
            }}
            data-testid="task-review-empty-open-files"
            className="flex h-8 items-center justify-center gap-2 rounded-lg bg-[#101216] border border-white/10 px-3 text-xs font-medium text-fg-2 hover:bg-[#1a1f27] hover:text-white cursor-pointer transition-colors"
          >
            <FileText className="h-3.5 w-3.5 text-accent" />
            {t("Open originals / import files")}
          </button>

          <button
            type="button"
            onClick={() => void copyText(buildStartupPrompt(), t("Startup prompt"))}
            data-testid="task-review-copy-startup-prompt"
            className="flex h-8 items-center justify-center gap-2 rounded-lg bg-[#101216] border border-white/10 px-3 text-xs font-medium text-fg-2 hover:bg-[#1a1f27] hover:text-white cursor-pointer transition-colors"
          >
            <Copy className="h-3.5 w-3.5 text-accent" />
            {t("Copy startup prompt")}
          </button>
          <button
            type="button"
            onClick={() => {
              setCardFace("tool");
              setCardModelSettingsOpen(true);
            }}
            data-testid="task-review-open-model-settings-btn"
            className="flex h-8 items-center justify-center gap-2 rounded-lg bg-[#101216] border border-white/10 px-3 text-xs font-medium text-fg-2 hover:bg-[#1a1f27] hover:text-white cursor-pointer transition-colors"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-accent" />
            {isModelConfigured
              ? t("Model: {{model}} (click to edit)", {
                  model: modelConfig?.backgroundModel || modelConfig?.completionModel || t("Configured"),
                })
              : t("Configure model and API key")}
          </button>
        </div>
      )}
    </div>
  );

    const currentProviderPreset = getProviderPreset(selectedProvider);

  const modelSettingsCardBody = (
    <div className="flex flex-col gap-3" data-testid="task-review-agent-unconfigured">
      <div className="flex items-start gap-2.5 rounded-lg bg-[#101216] p-3 border border-white/5">
        <Bot className="h-5 w-5 shrink-0 text-accent mt-0.5" />
        <div className="flex flex-col gap-1 text-[11px] leading-relaxed">
          <strong className="text-fg font-medium">{t("Configure the built-in Agent model connection")}</strong>
          <p className="text-fg-3">
            {t("Configure a model endpoint so the built-in Agent can review dialogue, plan review order and identify potential concerns.")}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-lg bg-[#101216] p-2.5 border border-border">
        {/* 1. 服务商 */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-fg-3">{t("reviewUi.provider")}</span>
          <select
            data-testid="task-review-provider-select"
            className="w-full rounded border border-border bg-bg-2 px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
            value={selectedProvider}
            onChange={(e) => handleSelectProvider(e.target.value)}
          >
            {MODEL_PROVIDER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {/* 2. 接口地址 */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-fg-3">{t("Endpoint")}</span>
          <input
            data-testid="task-review-config-endpoint"
            className="w-full rounded border border-border bg-bg-2 px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
            placeholder={t("https://api.openai.com/v1")}
            value={inlineEndpoint}
            onChange={(e) => {
              const val = e.target.value;
              setInlineEndpoint(val);
              setSelectedProvider(detectProviderPreset(val));
            }}
          />
        </label>

        {/* 3. 模型名称 */}
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-fg-3">{t("Model name")}</span>
          <select
            data-testid="task-review-model-preset-select"
            className="w-full rounded border border-border bg-bg-2 px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
            value={currentProviderPreset?.models.includes(inlineModel) ? inlineModel : "__custom__"}
            onChange={(e) => {
              if (e.target.value !== "__custom__") {
                setInlineModel(e.target.value);
              }
            }}
          >
            {(currentProviderPreset?.models ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value="__custom__">
              {(currentProviderPreset?.models.length ?? 0) > 0 ? t("Other custom model…") : t("Custom model")}
            </option>
          </select>
          <input
            data-testid="task-review-config-model"
            className="w-full rounded border border-border bg-bg-2 px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
            placeholder={t("gpt-4o / deepseek-chat")}
            value={inlineModel}
            onChange={(e) => setInlineModel(e.target.value)}
          />
        </div>

        {/* 4. API 密钥 */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-fg-3">{t("reviewUi.API_key_130")}</span>
          <input
            type="password"
            data-testid="task-review-config-apikey"
            className="w-full rounded border border-border bg-bg-2 px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
            placeholder={
              modelConfig?.hasApiKey
                ? t("Key saved (leave blank to keep; enter a new key to replace)")
                : "sk-..."
            }
            value={inlineApiKey}
            onChange={(e) => setInlineApiKey(e.target.value)}
          />
        </label>

        {inlineError && (
          <p className="text-[11px] text-status-error">{inlineError}</p>
        )}
      </div>

      {/* 5. Secondary action */}
      <div className="flex items-center justify-between gap-2">
        {cardModelSettingsOpen ? (
          <button
            type="button"
            onClick={() => setCardModelSettingsOpen(false)}
            data-testid="task-review-close-model-settings-btn"
            className="flex h-7 items-center justify-center rounded-lg border border-white/10 bg-[#101216] px-3 text-xs text-fg-2 hover:bg-[#1a1f27] hover:text-white cursor-pointer"
          >
            {t("reviewUi.back")}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setAgentSetupSkipped(true)}
            className="text-[11px] text-fg-3 hover:text-fg hover:underline cursor-pointer"
          >
            {t("Skip for now; review manually")}
          </button>
        )}
      </div>
    </div>
  );

  const readyToPreflightBody = (
    <div className="flex flex-col gap-3" data-testid="task-review-agent-ready">
      <div className="flex items-start gap-2.5 rounded-lg bg-[#101216] p-3 border border-white/5">
        <Bot className="h-5 w-5 shrink-0 text-accent mt-0.5" />
        <div className="flex flex-col gap-1 text-[11px] leading-relaxed">
          <strong className="text-fg font-medium">{t("Built-in Agent ready")}</strong>
          <p className="text-fg-3">
            {t("Ready to review this task, summarize criteria, group low-risk items and flag uncertain passages.")}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] text-fg-3">
          {t("{{count}} items pending review", { count: snapshot?.units.length ?? 0 })}
        </span>
        <button
          type="button"
          onClick={() => setAgentSetupSkipped(true)}
          className="text-[11px] text-fg-3 hover:text-fg hover:underline cursor-pointer"
        >
          {t("Skip automated review")}
        </button>
      </div>
    </div>
  );

  const preflightRunningBody = (
    <div className="flex flex-col gap-3" data-testid="task-review-agent-running-body">
      <div className="flex items-start gap-2.5 rounded-lg bg-[#101216] p-3 border border-white/5">
        <Bot className="h-5 w-5 shrink-0 text-accent mt-0.5 animate-pulse" />
        <div className="flex flex-col gap-1 text-[11px] leading-relaxed">
          <strong className="text-fg font-medium">{t("AI is reviewing and planning…")}</strong>
          <p className="text-fg-3">
            {t("The built-in Agent is analyzing items, summarizing criteria and planning review scenes. Wait or start reviewing from the left.")}
          </p>
        </div>
      </div>
      {coverage && (
        <div className="flex items-center justify-between rounded-lg bg-[#101216] p-2 text-[11px] text-fg-3">
          <span>{t("Analysis progress")}</span>
          <span className="font-mono text-fg-2">
            {coverage.analyzed} / {coverage.total}
          </span>
        </div>
      )}
    </div>
  );

  const proposalBody = proposal && (
    <div className="flex flex-col gap-2.5" data-testid="task-review-proposal-body">
      <div className="flex items-start gap-2.5 rounded-lg bg-[#101216] p-3 border border-white/5">
        <Bot className="h-5 w-5 shrink-0 text-accent mt-0.5" />
        <div className="flex flex-col gap-1 text-[11px] leading-relaxed">
          <strong className="text-fg font-medium">{t("AI task understanding proposal")}</strong>
          {snapshot?.goal && (
            <p className="text-fg-3">
              <span className="text-fg-2">{t("Task goal:")}</span>
              {snapshot.goal}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-lg bg-[#101216] p-2.5 border border-border text-[11px]">
        {proposal.content.groundedClaims.length > 0 && (
          <div className="flex flex-col gap-1">
            <strong className="text-fg-2 font-medium">{t("Criteria and facts:")}</strong>
            <ul className="list-disc pl-4 space-y-0.5 text-fg-3">
              {proposal.content.groundedClaims.slice(0, 3).map((claim, idx) => (
                <li key={idx} className="line-clamp-2">{claim}</li>
              ))}
            </ul>
          </div>
        )}

        {proposal.content.hypotheses.length > 0 && (
          <div className="flex flex-col gap-1">
            <strong className="text-fg-2 font-medium">{t("Assumptions to infer:")}</strong>
            <ul className="list-disc pl-4 space-y-0.5 text-fg-3">
              {proposal.content.hypotheses.slice(0, 2).map((hyp, idx) => (
                <li key={idx} className="line-clamp-2">{hyp}</li>
              ))}
            </ul>
          </div>
        )}

        {proposal.openQuestions.length > 0 && (
          <div className="flex flex-col gap-1">
            <strong className="text-amber-300 font-medium">{t("reviewUi.Questions_to_clarify_621")}</strong>
            <ul className="list-disc pl-4 space-y-0.5 text-fg-3">
              {proposal.openQuestions.slice(0, 2).map((q, idx) => (
                <li key={idx} className="line-clamp-2">{q}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-[11px]">
        <button
          type="button"
          onClick={() => openGlobal()}
          className="text-fg-3 hover:text-fg hover:underline cursor-pointer"
        >
          {t("View criteria and evidence")}
        </button>
        <button
          type="button"
          onClick={() => setDismissedProposalId(proposal.id)}
          className="text-fg-3 hover:text-fg cursor-pointer"
        >
          {t("Later")}
        </button>
      </div>
    </div>
  );

  const toolBody = (() => {
    if (!snapshot || !stats) return null;
    if (cardModelSettingsOpen) return modelSettingsCardBody;
    if (completedView) return completionHub;
    if (scene.kind === "edit") return hint(t("Detailed editing: edit the draft in the left editor, then return to item review."));
    if (agentScene && agentScene.suggestion.kind === "lowRiskGroup") return groupToolBody;
    if (agentScene && agentScene.suggestion.kind === "compare") return compareToolBody;
    if (unit && isTextTaskUnit(unit)) return textToolBody;
    if (unit) return mediaToolBody;

    if (snapshot.units.length === 0) {
      return emptyAgentBody;
    }

    if (isPreflightRunning) {
      return preflightRunningBody;
    }

    if (isProposalPendingAdoption) {
      return proposalBody;
    }

    if (agent && !isAuthorized && !agentSetupSkipped && (coverage?.unanalyzed ?? 0) > 0) {
      if (!isModelConfigured) {
        return modelSettingsCardBody;
      }
      return readyToPreflightBody;
    }

    return hint(t("Select an item from the plan or item dock on the left to start reviewing."));
  })();

  const spotlightCardNode = snapshot && stats ? (
    <SpotlightCard
      headerTitle={cardHeaderTitle}
      face={cardFace}
      onFlipFace={setCardFace}
      launcherItems={launcherItems}
      toolBody={toolBody}
      showCompletionToggle={!allDecided}
      completionActive={forceCompletion}
      onToggleCompletion={() => setForceCompletion((value) => !value)}
      spotlightActive={spotlightActive}
      onToggleSpotlight={() => setSpotlightActive((value) => !value)}
      onOpenModelSettings={() => {
        setCardFace("tool");
        setCardModelSettingsOpen((prev) => !prev);
      }}
      modelSettingsActive={cardModelSettingsOpen}
      modelConfigured={isModelConfigured}
      onBack={() => {
        setCardFace("tool");
        setTimeline((state) => back(state));
      }}
      canBack={canBack(timeline)}
      footerStatus={footerStatus}
      stepDots={stepDots}
      primaryAction={primaryAction}
    />
  ) : null;

  // ---- Stage content. ----
  const agentScroll = useSceneScroll<HTMLDivElement>(
    snapshot && agentScene ? `${viewKey(snapshot.root, snapshot.taskId)}:scene:${agentScene.suggestion.id}` : "scene",
    Boolean(snapshot && agentScene),
  );
  const unitScroll = useSceneScroll<HTMLDivElement>(
    snapshot && unit ? `${viewKey(snapshot.root, snapshot.taskId)}:unit:${unit.id}` : "unit",
    Boolean(snapshot && unit && scene.kind !== "edit" && !agentScene),
  );

  const staleBanner = (sceneStale: boolean, stale: boolean) => stale
    ? <p role="status" className="rounded border border-status-error/50 p-2 text-xs text-status-error" data-testid={sceneStale ? "task-review-scene-stale" : "task-review-stale-source"}>
        {t("This scene uses a stale or unavailable source version. The old draft is preserved for reference; open the current version from the overview to review again.")}
      </p>
    : null;

  /** 文本条目舞台：舞台卡 + 完整疑点卡 + 反馈口径采用 + 撤销/重做。 */
  const renderTextStage = (suggestion: TaskSceneSuggestion | null) => {
    if (!snapshot || !unit || !isTextTaskUnit(unit) || !openRef) return null;
    const purpose = suggestion?.purpose ?? openRef.purpose;
    const decision = unitDecisionState(snapshot, unit.id, purpose);
    const stale = !currentIds.has(unit.sourceVersionId);
    // 对照/成组场景等价于旧的 feedbackOnly：隐藏计划原因；single 场景与普通单元一致展示。
    const plan = suggestion && suggestion.kind !== "single" ? null : planStepForUnit(snapshot, unit.id);
    return (
      <div
        className="flex min-h-0 flex-1 flex-col gap-3"
        data-testid="task-review-unit-scene"
      >
        <div className="flex flex-wrap items-center gap-2 text-fg-3">
          {suggestion && <span className="shrink-0 text-fg-2">{suggestion.checkIntent}</span>}
          {plan && (
            <details className="text-fg-3">
              <summary className="cursor-pointer">{t("Why review this item")}</summary>
              <p className="mt-1" data-testid="task-review-plan-reason">{plan.reason}</p>
            </details>
          )}
          {decision.needsRecheck && !decision.status && (
            <span className="shrink-0 rounded border border-status-warning/50 px-1.5 py-0.5 text-status-warning" data-testid="task-review-needs-recheck">{t("Criteria updated; confirm again")}</span>
          )}
          <span className="ml-auto shrink-0" data-testid="task-review-decide-scope">
            {t("Decision applies only to current item #{{no}}", { no: unit.ordinal })}
          </span>
          {decision.canUndo && (
            <button
              type="button"
              className={`${wbButton.ghost} h-6 shrink-0`}
              disabled={busy || stale}
              data-testid="task-review-undo-decision"
              title={t("Undo changes review state; timeline navigation does not")}
              onClick={() => void changeDecision("undo")}
            >
              {t("Undo decision")}
            </button>
          )}
          {decision.canRedo && (
            <button
              type="button"
              className={`${wbButton.ghost} h-6 shrink-0`}
              disabled={busy || stale}
              data-testid="task-review-redo-decision"
              onClick={() => void changeDecision("redo")}
            >
              {t("Redo decision")}
            </button>
          )}
        </div>
        {staleBanner(Boolean(suggestion), stale)}
        {!stale && !suggestion && !analyzed.has(unit.id) && (
          <p className="text-xs text-fg-3" data-testid="task-review-risk-unknown">
            {t("Risk unknown: this item has not been analyzed under the current criteria. Manual review is still available.")}
          </p>
        )}
        <StageUnitCard
          snapshot={snapshot}
          unit={unit}
          purpose={purpose}
          busy={busy}
          stale={stale}
          focused
          compareMode={false}
          analysisKnown={analyzed.has(unit.id)}
          onCopyText={(text) => void copyText(text, `#${unit.ordinal}`)}
          onDecide={(status) => void decideSingle(status)}
        />
        <IssueCards
          snapshot={snapshot}
          unit={unit}
          purpose={purpose}
          draft={draftMap[unit.id]}
          onUpdateDraft={(patch) => updateDraft(unit.id, unit.sourceVersionId, patch)}
        />
        {contextBridge && decision.decisionId && (decision.note ?? "").trim() && !stale && (
          <CriteriaAdoptionForm
            snapshot={snapshot}
            unit={unit}
            decisionId={decision.decisionId}
            note={decision.note ?? ""}
            busy={busy}
            onAdoptCriteria={controller.adoptCriteria}
            purpose={purpose}
          />
        )}
      </div>
    );
  };

  const stage = (() => {
    if (!snapshot || !unit) return null;
    if (scene.kind === "edit" && isTextTaskUnit(unit)) {
      return (
        <EditScene
          key={unit.id}
          unit={unit}
          root={snapshot.root}
          taskId={snapshot.taskId}
          agent={agent}
          agentState={agentRuntime.state}
          disabled={!currentIds.has(unit.sourceVersionId)}
          policyRevision={snapshot.policyRevision}
          draft={draftMap[unit.id]}
          onUpdateDraft={(patch) => updateDraft(unit.id, unit.sourceVersionId, patch)}
          onBackToReview={() => setTimeline((state) => setEditing(state, false))}
        />
      );
    }
    if (!isTextTaskUnit(unit)) {
      return mediaBridge ? (
        <MediaScene key={unit.id} snapshot={snapshot} unit={unit} operations={controller} draft={draftMap[unit.id]}
          onUpdateDraft={(patch) => updateDraft(unit.id, unit.sourceVersionId, patch)} onOpenUnit={openDerivedUnit}
          onDecide={(status) => void decideSingle(status)} onUndo={() => void changeDecision("undo")} onRedo={() => void changeDecision("redo")} onReportError={setActionError} busy={controller.busy} />
      ) : hint(t("This desktop shell has no media review connection. Image and video items are unavailable."));
    }
    if (agentScene && agentScene.suggestion.kind === "compare") {
      return (
        <div {...agentScroll} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto"
          data-testid="task-review-agent-scene" data-scene-id={agentScene.suggestion.id} data-scene-kind="compare">
          <header className="flex shrink-0 flex-wrap items-center gap-2 text-fg-3">
            <strong className="text-fg-2">{t("Related comparison")} · {agentScene.suggestion.checkIntent}</strong>
            <span className="text-[11px]">{t("AI scene suggestion · Human decision for each item")}</span>
            <SceneBasis snapshot={snapshot} suggestion={agentScene.suggestion} />
          </header>
          {!agentScene.current && (
            <p className="shrink-0 rounded border border-status-error/50 p-2 text-status-error" data-testid="task-review-scene-stale">
              {t("This scene's sources or criteria changed. The reading view is preserved for reference; open the latest plan from the overview.")}
            </p>
          )}
          <div className="flex flex-col gap-2.5" data-testid="task-review-scene-targets">
            {compareMembers.map((member) => {
              const refs = agentScene.suggestion.sourceRefs.filter((ref) => ref.unitId === member.unit.id);
              return (
                <div key={member.unit.id} className="flex flex-col gap-1">
                  <StageUnitCard
                    snapshot={snapshot}
                    unit={member.unit}
                    purpose={agentScene.suggestion.purpose}
                    busy={busy}
                    stale={member.stale}
                    focused={openRef?.unitId === member.unit.id}
                    compareMode
                    analysisKnown={member.known}
                    focusTestId="task-review-scene-focus"
                    focusActive={openRef?.unitId === member.unit.id}
                    onFocus={() => focusCompareTarget(member)}
                    onCopyText={(text) => void copyText(text, `#${member.unit.ordinal}`)}
                    onDecide={(status) => void decideTarget(member.target, status)}
                  />
                  {refs.length > 0 && (
                    <details className="px-1 text-[11px] text-fg-3">
                      <summary className="cursor-pointer">{t("View quoted evidence")}</summary>
                      {refs.map((ref, index) => (
                        <p key={index} className="mt-1 select-text whitespace-pre-wrap border-l-2 border-border pl-2" data-testid="task-review-scene-evidence">{ref.text}</p>
                      ))}
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      );
    }
    if (agentScene && agentScene.suggestion.kind === "lowRiskGroup") {
      return (
        <div {...agentScroll} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto"
          data-testid="task-review-agent-scene" data-scene-id={agentScene.suggestion.id} data-scene-kind="lowRiskGroup">
          <header className="flex shrink-0 flex-wrap items-center gap-2 text-fg-3">
            <strong className="text-fg-2">
              {groupMembers.every((member) => member.known && issuesForUnit(snapshot, member.unit.id, agentScene.suggestion.purpose).length === 0)
                ? t("Low-risk group skim (AI suggestion)")
                : t("Group skim (risk needs verification)")} · {agentScene.suggestion.checkIntent}
            </strong>
            <span className="text-[11px]">{t("AI scene suggestion · Human decision for each item")}</span>
            <SceneBasis snapshot={snapshot} suggestion={agentScene.suggestion} />
          </header>
          {!agentScene.current && (
            <p className="shrink-0 rounded border border-status-error/50 p-2 text-status-error" data-testid="task-review-scene-stale">
              {t("This scene's sources or criteria changed. The reading view is preserved for reference; open the latest plan from the overview. Group confirmation is disabled.")}
            </p>
          )}
          <div className="flex flex-col gap-2.5" data-testid="task-review-scene-targets">
            {groupMembers.map((member) => (
              <div
                key={member.unit.id}
                onClick={() => setTimeline((state) => focusSceneTarget(state, { unitId: member.unit.id, sourceVersionId: member.unit.sourceVersionId, purpose: agentScene.suggestion.purpose }))}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                  openRef?.unitId === member.unit.id ? "border-accent bg-bg-1" : "border-border bg-bg-1/70 hover:border-fg-3"
                }`}
                data-testid="task-review-scene-target"
                data-unit-id={member.unit.id}
              >
                <input
                  type="checkbox"
                  className="mt-1 shrink-0"
                  data-testid="task-review-group-select"
                  aria-label={t("Select skim item #{{no}}", { no: member.unit.ordinal })}
                  checked={selectedIds.includes(member.unit.id) && member.eligible}
                  disabled={!member.eligible || busy}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => toggleSceneSelect(member.unit.id, event.target.checked)}
                />
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-fg">#{member.unit.ordinal} {focusedSourceLabel(snapshot, member.unit)}</span>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm font-medium leading-relaxed text-fg" data-testid="task-review-scene-original">{member.unit.text}</p>
                  {!member.known && <p className="mt-1 text-[11px] text-fg-3">{t("Risk unknown or not yet analyzed under current criteria; group confirmation is unavailable.")}</p>}
                  {member.known && !member.eligible && !member.decision.status && <p className="mt-1 text-[11px] text-fg-3">{t("Current concerns exist. Decide each item individually.")}</p>}
                </div>
                <span className="shrink-0 text-xs text-fg-3">
                  {member.decision.status ? t(statusLabels[member.decision.status]) : member.decision.needsRecheck ? t("Needs recheck") : t("Pending")}
                </span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    if (agentScene) {
      // Formal single scene: the Agent's check intent and basis stay visible.
      return (
        <div {...agentScroll} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
          data-testid="task-review-agent-scene" data-scene-id={agentScene.suggestion.id} data-scene-kind="single">
          <header className="flex shrink-0 flex-wrap items-center gap-2 text-fg-3">
            <strong className="text-fg-2">{agentScene.suggestion.checkIntent}</strong>
            {!agentScene.current && <span className="text-status-error" data-testid="task-review-scene-stale">{t("This scene's sources or criteria changed. Check the latest plan.")}</span>}
            <SceneBasis snapshot={snapshot} suggestion={agentScene.suggestion} />
          </header>
          {renderTextStage(agentScene.suggestion)}
        </div>
      );
    }
    return (
      <div {...unitScroll} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {renderTextStage(null)}
      </div>
    );
  })();

  // ---- Dock / track / drawer content. ----
  const leftDock = snapshot && stats && snapshot.units.length > 0 && (
    <aside className="flex h-full min-h-0 w-[216px] shrink-0 flex-col overflow-hidden bg-bg-1 xl:w-[232px]">
      <div className="flex shrink-0 flex-col gap-0.5 border-b border-border p-2">
        <div className="flex items-center justify-between px-1.5 py-1 text-[11px] text-fg-3">
          <span className="font-semibold text-fg-2">{t("Plan")}</span>
          <span className="font-mono tabular-nums">{stats.decided}/{stats.total}</span>
        </div>
        <div className="flex max-h-44 flex-col gap-0.5 overflow-y-auto">
          {planList.map((suggestion, index) => {
            const pending = pendingSceneTargets(snapshot, suggestion);
            const done = pending.length === 0;
            const isCurrent = Boolean(agentScene && agentScene.suggestion.id === suggestion.id);
            const risk = Math.max(0, ...suggestion.targets.flatMap((targetRow) =>
              issuesForUnit(snapshot, targetRow.unitId, suggestion.purpose).map((issue) => severityRank[issue.severity])));
            const dotClass = done ? "bg-accent/40" : risk >= 3 ? "bg-rose-400" : risk === 2 ? "bg-amber-400" : risk === 1 ? "bg-fg-3" : "bg-white/20";
            return (
              <button
                key={suggestion.id}
                type="button"
                onClick={() => openPlannedScene(suggestion)}
                {...bindTip(suggestion.checkIntent, done ? t("All items in this scene have decisions. Click to review them.") : t("{{count}} items awaiting decisions · {{reason}}", { count: pending.length, reason: suggestion.reason }))}
                className={`flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                  isCurrent ? "bg-accent/15 font-semibold text-accent" : done ? "text-fg-3 line-through hover:bg-bg-2" : "text-fg-2 hover:bg-bg-2"
                }`}
                data-testid="task-review-dock-scene"
                data-scene-id={suggestion.id}
              >
                <span className="truncate">{index + 1}. {suggestion.checkIntent}</span>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
              </button>
            );
          })}
          {!planList.length && <p className="px-2 py-1 text-[11px] text-fg-3">{t("No plan yet. Import source text in the overview or wait for review results.")}</p>}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-fg-3">
          <span className="font-semibold text-fg-2">{t("Items")}</span>
          <span className="font-mono tabular-nums">{stats.decided}/{stats.total}</span>
        </div>
        <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {dockUnits.map((candidate) => {
            if (!isTextTaskUnit(candidate)) return null;
            const decision = unitDecisionState(snapshot, candidate.id, REVIEW_PURPOSE);
            const issueCount = issuesForUnit(snapshot, candidate.id, REVIEW_PURPOSE).length;
            const known = analyzed.has(candidate.id);
            const dotClass =
              decision.status === "kept" ? "bg-accent"
                : decision.status === "rework" ? "bg-amber-400"
                  : decision.status === "discarded" ? "bg-rose-500"
                    : issueCount > 0 ? "bg-rose-400 ring-2 ring-rose-400/30"
                      : !known ? "bg-amber-300" : "bg-white/20";
            const isFocus = workFocus?.unitId === candidate.id;
            const inScene = Boolean(agentScene && agentScene.suggestion.targets.some((targetRow) => targetRow.unitId === candidate.id));
            return (
              <button
                key={candidate.id}
                type="button"
                onClick={() => openUnitById(candidate.id)}
                {...bindTip(
                  `#${candidate.ordinal} ${focusedSourceLabel(snapshot, candidate)}`,
                  decision.status ? t("Current status: {{status}}", { status: t(statusLabels[decision.status]) }) : issueCount > 0 ? t("Pending · {{count}} concerns", { count: issueCount }) : t("Pending"),
                )}
                className={`flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors ${
                  isFocus ? "bg-bg-3 text-fg" : inScene ? "bg-accent/5 text-fg-2 hover:bg-bg-2" : "text-fg-2 hover:bg-bg-2/70"
                }`}
                data-testid="task-review-dock-unit"
                data-unit-id={candidate.id}
              >
                <span className="flex items-center justify-between gap-1.5 text-[11px] tabular-nums">
                  <span className="min-w-0 truncate font-medium text-fg">
                    <span className="mr-1 font-mono text-accent">#{candidate.ordinal}</span>
                    {focusedSourceLabel(snapshot, candidate)}
                  </span>
                  <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
                </span>
                <span className="line-clamp-1 text-[11px] text-fg-3">{candidate.text.split("\n")[0]}</span>
              </button>
            );
          })}
          {!dockUnits.length && <p className="px-2 py-1 text-[11px] text-fg-3">{t("No current item.")}</p>}
        </div>
      </div>
    </aside>
  );

  const bottomTrack = snapshot && snapshot.units.length > 0 && (
    bottomTrackCollapsed ? (
      <div className="flex h-6 shrink-0 items-center justify-end bg-bg-1 px-2">
        <button
          type="button"
          onClick={() => setBottomTrackCollapsed(false)}
          {...bindTip(t("Expand timeline"), t("Show the bottom item track"))}
          className="cursor-pointer text-[11px] text-fg-3 hover:text-white"
        >
          {t("Expand timeline ▴")}
        </button>
      </div>
    ) : (
      <section className="flex h-16 shrink-0 items-center gap-1.5 overflow-x-auto bg-bg-1 px-2.5" data-testid="task-review-unit-track">
        {dockUnits.map((candidate) => {
          const isFocus = workFocus?.unitId === candidate.id;
          const inScene = Boolean(agentScene && agentScene.suggestion.targets.some((targetRow) => targetRow.unitId === candidate.id));
          return (
            <button
              key={candidate.id}
              type="button"
              onClick={() => openUnitById(candidate.id)}
              {...bindTip(`#${candidate.ordinal}`, unitTitle(candidate).split("\n")[0])}
              className={`flex h-12 w-36 shrink-0 flex-col justify-between rounded border px-2 py-1 text-left transition-colors ${
                isFocus ? "border-accent bg-bg-3 text-fg" : inScene ? "border-accent/50 bg-bg-2 text-fg" : "border-border bg-bg text-fg-2 hover:bg-bg-2"
              }`}
              data-testid="task-review-track-unit"
              data-unit-id={candidate.id}
            >
              <span className="flex items-center justify-between text-[10px] tabular-nums">
                <span className="font-mono font-bold text-accent">#{candidate.ordinal}</span>
                <span className="font-mono text-fg-3">{isTextTaskUnit(candidate) && candidate.startMs !== undefined ? formatTime(candidate.startMs) : "--:--"}</span>
              </span>
              <span className="line-clamp-1 text-[11px] text-fg-2">{unitTitle(candidate).split("\n")[0]}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setBottomTrackCollapsed(true)}
          {...bindTip(t("Collapse timeline"), t("Hide the bottom item track to free stage space"))}
          className="ml-auto flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-fg-3 hover:bg-bg-2 hover:text-white"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </section>
    )
  );

  const timelineDrawer = snapshot && timelineDrawerOpen && (
    <div className="z-40 shrink-0 border-b border-border bg-bg-1 px-4 py-2.5 shadow-lg" data-testid="task-review-timeline-drawer">
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-1">
          <strong className="text-[11px] text-fg-3">{t("Future plan")}</strong>
          <div className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
            {planList.map((suggestion, index) => {
              const done = pendingSceneTargets(snapshot, suggestion).length === 0;
              return (
                <button
                  key={suggestion.id}
                  type="button"
                  onClick={() => {
                    openPlannedScene(suggestion);
                    setTimelineDrawerOpen(false);
                  }}
                  className="flex cursor-pointer items-center justify-between rounded px-2 py-1 text-left text-xs text-fg-2 hover:bg-bg-2"
                >
                  <span className={done ? "text-fg-3 line-through" : ""}>{index + 1}. {suggestion.checkIntent}</span>
                  <span className="text-[10px] text-fg-3">{done ? "✓" : ""}</span>
                </button>
              );
            })}
            {!planList.length && <p className="px-2 py-1 text-[11px] text-fg-3">{t("No plan yet.")}</p>}
          </div>
        </div>
        <div className="flex flex-col gap-1 border-border lg:border-l lg:pl-4">
          <strong className="text-[11px] text-fg-3">{t("Visit history")}</strong>
          <div className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
            {[...timeline.visited].reverse().map((ref, index) => {
              const row = findUnit(snapshot, ref.unitId);
              return (
                <button
                  key={`${ref.unitId}:${timeline.visited.length - 1 - index}`}
                  type="button"
                  onClick={() => {
                    openUnitById(ref.unitId);
                    setTimelineDrawerOpen(false);
                  }}
                  className="cursor-pointer truncate rounded px-2 py-1 text-left text-xs text-fg-2 hover:bg-bg-2"
                >
                  {row ? `#${row.ordinal} ${unitTitle(row).split("\n")[0]}` : t("Item unavailable")}
                </button>
              );
            })}
            {!timeline.visited.length && <p className="px-2 py-1 text-[11px] text-fg-3">{t("No items visited yet.")}</p>}
          </div>
        </div>
        <div className="flex flex-col gap-1 border-border lg:border-l lg:pl-4">
          <div className="flex items-center justify-between">
            <strong className="text-[11px] text-fg-3">{t("Undo history")}</strong>
            <button
              type="button"
              className="cursor-pointer text-fg-3 hover:text-white"
              onClick={() => setTimelineDrawerOpen(false)}
              aria-label={t("reviewUi.Collapse_timeline_658")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
            {dockUnits.flatMap((candidate) => {
              const decision = unitDecisionState(snapshot, candidate.id, REVIEW_PURPOSE);
              if (!decision.canUndo) return [];
              return [(
                <div key={candidate.id} className="flex items-center justify-between rounded px-2 py-1 text-xs">
                  <span className="text-fg-2">
                    #{candidate.ordinal} {t("{{status}}", { status: decision.status ? t(statusLabels[decision.status]) : t("Pending") })}
                  </span>
                  <button
                    type="button"
                    className="cursor-pointer text-accent hover:underline"
                    onClick={() => void undoUnitById(candidate.id)}
                  >
                    {t("Undo")}
                  </button>
                </div>
              )];
            })}
          </div>
        </div>
      </div>
    </div>
  );

  if (legacy) {
    // Older shell without the task-review IPC: keep the folder workspace.
    return <FolderReviewWorkspace root={root} onFlush={onFlush} onClose={onClose} />;
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-bg text-xs text-fg"
      data-testid="task-review-workspace"
      data-task-root={root}
    >
      {tipNode}
      {toast && (
        <div className="fixed bottom-12 left-6 z-50 rounded-md border border-accent/50 bg-bg-1 px-3 py-1.5 text-xs text-fg shadow-xl" role="status" data-testid="task-review-toast">
          {toast}
        </div>
      )}

      {/* Top bar: neutral browse arrows, progress pill and utility entries. */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border bg-bg-1 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <strong className="max-w-56 truncate text-xs font-semibold text-fg" title={root} data-testid="task-review-identity">
            {name ?? root}
          </strong>
          {snapshot && (
            <span className="sr-only" data-testid="task-review-revision">
              r{snapshot.revision}
            </span>
          )}
          {(exportOpen || timeline.overlay !== null) && (
            <button
              type="button"
              onClick={() => {
              setCardFace("tool");
              if (exportOpen) setExportOpen(false);
              else setTimeline((state) => back(state));
            }}
              {...bindTip(t("Return to the main review stage"), t("Return to spotlight review without changing any decisions"))}
              className="inline-flex h-6 cursor-pointer items-center gap-1 rounded bg-accent/15 px-2 text-[11px] font-semibold text-accent hover:bg-accent/25"
              data-testid="task-review-back-to-stage"
            >
              <ArrowLeft className="h-3 w-3" />
              {t("Stage")}
            </button>
          )}
        </div>

        <div className="hidden min-w-0 flex-1 items-center justify-center md:flex">
          <button
            type="button"
            onClick={() => setTimelineDrawerOpen((value) => !value)}
            {...bindTip(t("Expand/collapse work timeline details"), t("View future plans, visit history and undo history"))}
            className="inline-flex max-w-full cursor-pointer items-center gap-2 rounded border border-border bg-bg-2 px-2.5 py-0.5 text-xs text-fg hover:border-fg-3"
            data-testid="task-review-progress"
          >
            {stats && (
              <span className="shrink-0 font-mono text-[11px] font-bold tabular-nums text-accent">
                {stats.decided}/{stats.total}
              </span>
            )}
            <span className="truncate font-medium text-fg-2">{describeCurrentScene()}</span>
            <ChevronDown className={`h-3 w-3 shrink-0 text-fg-3 transition-transform ${timelineDrawerOpen ? "rotate-180" : ""}`} />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setCopyModalOpen(true)}
            {...bindTip(t("Copy center"), t("Copy the current item, rework instructions or all approved subtitles"))}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded border border-border bg-bg-2 text-fg-2 hover:text-white"
            data-testid="task-review-copy-center"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setAgentModalOpen(true)}
            {...bindTip(t("External Agent"), t("View background analysis jobs and copy rework instructions"))}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded border border-border bg-bg-2 text-fg-2 hover:text-white"
            data-testid="task-review-agent-button"
          >
            <Bot className="h-3.5 w-3.5" />
          </button>
          {focusedDecision?.canUndo && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void changeDecision("undo")}
              {...bindTip(t("Undo the current item's decision"), t("Withdraw the decision without changing the reading position"))}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-fg-2 hover:bg-bg-2 hover:text-white disabled:opacity-40"
              aria-label={t("Undo decision")}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            disabled={!canBack(timeline)}
            data-testid="task-review-back"
            onClick={() => {
              setCardFace("tool");
              setTimeline((state) => back(state));
            }}
            {...bindTip(t("Return to the previous reading view"), t("Move reading focus back without changing any decisions"))}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded border border-border bg-bg-2 text-fg-2 hover:text-white disabled:opacity-30"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={!snapshot}
            data-testid="task-review-continue"
            onClick={handleContinuePlan}
            {...bindTip(t("Browse the next planned scene (skip undecided items)"), t("Move reading focus only; undecided items remain pending. Use the spotlight card's green button to decide."))}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded border border-border bg-bg-2 text-fg-2 hover:text-white disabled:opacity-30"
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
          {errorCount > 0 ? (
            <button
              type="button"
              className={wbButton.danger}
              title={t("Retry saving unsuccessful drafts")}
              data-testid="task-review-draft-retry"
              onClick={() => {
                for (const [unitId, entry] of Object.entries(draftMap))
                  if (entry.status === "error") void retryDraft(unitId);
              }}
            >
              {t("Draft not saved. Click to retry.")}
            </button>
          ) : dirtyCount > 0 ? (
            <span className="shrink-0 text-fg-3" role="status">
              {t("Saving draft…")}
            </span>
          ) : null}
          {onClose && (
            <button type="button" className={`${wbButton.ghost} px-2`} onClick={onClose}>
              {t("Close")}
            </button>
          )}
        </div>
      </div>

      {timelineDrawer}

      {controller.recovery && (
        <div role="status" data-testid="task-review-write-recovery" className="border-b border-border p-2 text-status-warning">
          <span>{t(controller.recovery.message)}</span>
          {controller.writesBlocked && <button type="button" data-testid="task-review-reconcile-decision"
            onClick={() => void controller.reconcileDecision().then(result => setActionError(result.ok ? null : result.error))}>
            {t("Verify this decision")}
          </button>}
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
              {t("Retry")}
            </button>
          )}
          {actionError && (
            <button type="button" className={wbButton.ghost} onClick={() => setActionError(null)}>
              {t("Got it")}
            </button>
          )}
        </div>
      )}
      {controller.sourceRefresh.error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-2 px-3 py-1.5 text-fg-2" role="status" data-testid="task-review-source-refresh-error">
          <span className="min-w-0 flex-1">{t("Source refresh failed:")}{controller.sourceRefresh.error}。{controller.sourceRefresh.lastSuccess ? t("Last successful refresh: {{v0}}", { v0: new Date(controller.sourceRefresh.lastSuccess).toLocaleTimeString() }) : t("No successful refresh yet")}{t("; showing the last retrieved content.")}</span>
          <button type="button" className={wbButton.ghost} onClick={() => void pollSources()}>{t("Retry refresh")}</button>
        </div>
      )}

      {/* Export overlay: the original-file export panel plus the tool card. */}
      {exportOpen && snapshot && (
        exportBridge ? (
          <div className="flex min-h-0 flex-1 items-start gap-3.5 overflow-y-auto p-3.5" data-testid="task-review-export-scene">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <ResultExportPanel
                snapshot={snapshot}
                open
                onOpenChange={(open) => { if (!open) setExportOpen(false); }}
                busy={controller.busy}
                onPreview={controller.previewOriginalExport}
                onExecute={controller.executeOriginalExport}
                onChooseDestination={async () => {
                  if (!window.reelterminal?.fs) throw new Error(t("Directory picker connection is unavailable"));
                  return window.reelterminal.fs.showOpenDialog({ directory: true, filters: [] });
                }}
              />
            </div>
            {spotlightCardNode}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-start gap-3.5 p-3.5" data-testid="task-review-export-scene">
            <p className="min-w-0 flex-1 rounded border border-border bg-bg-1 p-4 text-fg-3">
              {t("This desktop shell has no result export connection. Original-file export preview and execution are unavailable.")}
            </p>
            {spotlightCardNode}
          </div>
        )
      )}

      {/* Global overview overlay plus the tool card. */}
      {!exportOpen && timeline.overlay === "global" && snapshot && (
        <div className="flex min-h-0 flex-1 items-start gap-3.5 p-3.5">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
                if (!window.reelterminal?.fs) throw new Error(t("Directory picker connection is unavailable"));
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
          </div>
          {spotlightCardNode}
        </div>
      )}

      {/* Directory scene: real file management stays mounted for instant,
          state-preserving return under every other scene; while covered,
          polling and preview media pause and every legacy file-level review
          entry stays hidden: task decisions have exactly one authority — the
          task domain. */}

      <div
        className={`items-start gap-3.5 p-3.5 ${directoryActive ? "flex min-h-0 flex-1 overflow-y-auto" : "hidden"}`}
      >
        <div
          className={`flex h-full min-h-0 min-w-0 flex-1 flex-col self-stretch ${directoryActive ? "" : "hidden"}`}
          data-testid="task-review-directory-host"
        >
          <FolderReviewWorkspace
            root={root}
            mode="files"
            sceneVisible={directoryActive}
            onOpenMedia={mediaBridge ? openMediaFile : undefined}
            onFlush={registerFolderFlush}
          />
        </div>
        {directoryActive && spotlightCardNode}
      </div>

      {/* Main spotlight workbench. */}
      {!exportOpen && timeline.overlay !== "global" && !directoryActive && snapshot && stats && (
        <div
          className="relative flex min-h-0 flex-1 divide-x divide-border overflow-hidden bg-border"
          data-testid="task-review-active-scene"
        >
          {spotlightActive && unit && (
            <div
              className="pointer-events-none absolute inset-0 z-20 bg-black/20 transition-opacity backdrop-blur-[0.5px]"
              aria-hidden="true"
            />
          )}
          {leftDock}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col divide-y divide-border overflow-hidden bg-bg">
            <div className="flex min-h-0 flex-1 items-start gap-3.5 overflow-hidden p-3.5">
              <main
                className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl p-1 transition-all ${
                  spotlightActive ? "relative z-30 shadow-[0_0_24px_var(--accent-glow)] ring-2 ring-accent" : ""
                }`}
              >
                {stage}
              </main>
              {spotlightCardNode}
            </div>
            {bottomTrack}
          </div>
        </div>
      )}

      {/* Copy centre. */}
      {copyModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
          <div
            className="flex w-full max-w-sm flex-col gap-2 rounded-xl border border-border bg-bg-1 p-3.5 text-xs shadow-2xl"
            data-testid="copy-center-modal"
            role="dialog"
            aria-label={t("Copy center")}
          >
            <div className="flex items-center justify-between border-b border-border pb-2">
              <strong className="text-sm font-semibold text-fg">{t("Copy")}</strong>
              <button type="button" className={wbButton.ghost} onClick={() => setCopyModalOpen(false)} aria-label={t("Close copy center")}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid gap-1.5">
              {focusedUnitRow && isTextTaskUnit(focusedUnitRow) && (
                <button
                  type="button"
                  onClick={() => {
                    void copyText(focusedDecision?.replacementText?.trim() || focusedUnitRow.text, `#${focusedUnitRow.ordinal}`);
                    setCopyModalOpen(false);
                  }}
                  className="flex cursor-pointer items-center justify-between rounded-lg border border-border bg-bg px-3 py-2 text-left hover:border-accent"
                >
                  <span className="font-medium text-fg">{t("Current item (#{{no}})", { no: focusedUnitRow.ordinal })}</span>
                  <Copy className="h-3.5 w-3.5 text-accent" />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  void copyText(buildReworkPrompt(), t("reviewUi.Rework_instructions_687"));
                  setCopyModalOpen(false);
                }}
                className="flex cursor-pointer items-center justify-between rounded-lg border border-border bg-bg px-3 py-2 text-left hover:border-accent"
              >
                <span className="font-medium text-fg">{t("Rework instructions (Prompt)")}</span>
                <Copy className="h-3.5 w-3.5 text-accent" />
              </button>
              <button
                type="button"
                onClick={() => {
                  void copyText(buildStartupPrompt(), t("Startup prompt"));
                  setCopyModalOpen(false);
                }}
                className="flex cursor-pointer items-center justify-between rounded-lg border border-border bg-bg px-3 py-2 text-left hover:border-accent"
              >
                <span className="font-medium text-fg">{t("Startup prompt (Prompt)")}</span>
                <Copy className="h-3.5 w-3.5 text-accent" />
              </button>
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-bg px-3 py-2">
                <button
                  type="button"
                  onClick={() => {
                    void copyText(buildSubtitleExport(exportFormat).text, t("Approved subtitles"));
                    setCopyModalOpen(false);
                  }}
                  className="flex min-w-0 cursor-pointer items-center gap-2 text-left"
                >
                  <span className="font-medium text-fg">{t("Approved subtitles")}</span>
                  <Copy className="h-3.5 w-3.5 shrink-0 text-accent" />
                </button>
                <select
                  className="shrink-0 rounded border border-border bg-bg-2 px-1 py-0.5 text-xs"
                  aria-label={t("Subtitle format")}
                  value={exportFormat}
                  onChange={(event) => setExportFormat(event.target.value as typeof exportFormat)}
                >
                  <option value={t("srt")}>{t("srt")}</option>
                  <option value={t("txt")}>{t("txt")}</option>
                  <option value={t("json")}>{t("json")}</option>
                </select>
              </div>
              <button
                type="button"
                onClick={() => {
                  void copyText(root, t("Path"));
                  setCopyModalOpen(false);
                }}
                className="flex cursor-pointer items-center justify-between rounded-lg border border-border bg-bg px-3 py-2 text-left hover:border-accent"
              >
                <span className="min-w-0 truncate font-medium text-fg" title={root}>{t("Task path ({{path}})", { path: root })}</span>
                <Copy className="h-3.5 w-3.5 shrink-0 text-accent" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Agent modal: real runtime jobs only — no RW/RO toggle, the folder
          task has no such channel, and faking one would fake success. */}
      {agentModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
          <div
            className="flex w-full max-w-xl flex-col gap-3 rounded-xl border border-border bg-bg-1 p-4 text-xs shadow-2xl"
            data-testid="task-review-agent-modal"
            role="dialog"
            aria-label={t("External Agent")}
          >
            <div className="flex items-center justify-between border-b border-border pb-2">
              <strong className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                <Bot className="h-4 w-4 text-accent" />
                {t("External Agent")}
              </strong>
              <button type="button" className={wbButton.ghost} onClick={() => setAgentModalOpen(false)} aria-label={t("Close external Agent")}>
                <X className="h-4 w-4" />
              </button>
            </div>
            {agentRuntime.error && <p role="alert" className="text-status-error">{agentRuntime.error}</p>}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-fg-3">{t("Background analysis jobs (actual runtime)")}</span>
                <button
                  type="button"
                  className="cursor-pointer text-accent hover:underline"
                  onClick={() => {
                    void copyText(buildReworkPrompt(), t("reviewUi.Rework_instructions_687"));
                    setAgentModalOpen(false);
                  }}
                >
                  {t("Copy rework instructions")}
                </button>
              </div>
              <div className="max-h-56 divide-y divide-border overflow-y-auto rounded border border-border bg-bg" data-testid="task-review-agent-jobs">
                {(agentRuntime.state?.jobs ?? []).map((job) => {
                  const expanded = expandedJobId === job.id;
                  return (
                    <div key={job.id} className="flex flex-col p-2">
                      <button
                        type="button"
                        onClick={() => setExpandedJobId(expanded ? null : job.id)}
                        className="flex cursor-pointer items-center justify-between gap-2 text-left"
                      >
                        <span className={`shrink-0 font-mono ${job.status === "failed" || job.status === "interrupted" ? "text-status-error" : "text-accent"}`}>
                          {t(jobStatusLabels[job.status])}
                        </span>
                        <span className="min-w-0 truncate text-fg-3">
                          {t("Job {{id}} · {{count}} items · Attempt {{attempts}}", { id: job.id, count: job.unitIds.length, attempts: job.attempts })}
                        </span>
                      </button>
                      {job.error && <span className="mt-1 truncate text-status-error" title={job.error}>{job.error}</span>}
                      {expanded && (
                        <pre className="mt-1.5 overflow-x-auto rounded bg-bg-2 p-2 font-mono text-[10px] text-fg-2">
                          {JSON.stringify({
                            id: job.id,
                            status: job.status,
                            unitIds: job.unitIds,
                            sourceVersionIds: job.sourceVersionIds,
                            completedUnitIds: job.completedUnitIds,
                            policyRevision: job.policyRevision,
                            attempts: job.attempts,
                            ...(job.error ? { error: job.error } : {}),
                          }, null, 2)}
                        </pre>
                      )}
                    </div>
                  );
                })}
                {!(agentRuntime.state?.jobs ?? []).length && (
                  <p className="p-3 text-center text-fg-3">{t("No background analysis jobs yet. Authorize review under Model and authorization in the overview.")}</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function focusedSourceLabel(snapshot: TaskReviewSnapshot, unit: TaskTextReviewUnit): string {
  const source = snapshot.sources.find((item) => item.id === unit.sourceVersionId);
  return source ? sourceTitle(source.relativePath) : "";
}

export default TaskReviewWorkspace;
