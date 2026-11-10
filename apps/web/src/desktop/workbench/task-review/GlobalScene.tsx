import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  TaskDecisionStatus,
  TaskReviewSnapshot,
  TaskTextFormat,
  TaskSceneSuggestion,
  TaskUnitTarget,
} from "../../../../../desktop/src/shared/task-review";
import { isCurrentTaskUnit, isTextTaskSource } from "../../../../../desktop/src/shared/task-review";
import type { TaskAgentBridge, TaskSearchScope, TaskSemanticSearchResult } from "../../../../../desktop/src/shared/task-review-runtime-types";
import { wbButton } from "../wb-button";
import {
  currentSources,
  decisionStatus,
  issuesForUnit,
  recentVisits,
  remainingPlanSteps,
  remainingScenes,
  pendingSceneTargets,
  unitStats,
  findUnit,
  REVIEW_PURPOSE,
} from "./queries";
import { statusLabels } from "./display";
import type { TaskAgentRuntime } from "./useTaskAgentState";
import { AgentPanel } from "./AgentPanel";
import { TaskContextPanel, TaskContextBrief } from "./TaskContextPanel";
import { sourceTitle, unitTitle } from "./display";
import type { MutationResult } from "./useTaskReviewController";
import { ResultExportPanel, type ResultExportPanelProps } from "./ResultExportPanel";

const inputClass = "min-w-0 flex-1 rounded border border-border bg-bg-2 px-2 py-1 text-xs";

/**
 * Temporary global scene: goal and imports, per-source progress and exports,
 * unit search with explicit-scope batch decisions, and the separated Agent
 * future plan versus actual visit history. Task understanding and adopted
 * criteria stay a collapsed panel: they inform the review, never displace it.
 */
export function GlobalScene({
  snapshot,
  busy,
  agent,
  agentRuntime,
  onSetGoal,
  onImportText,
  onImportFile,
  onRefreshSources,
  onExport,
  onOpenUnit,
  onOpenScene,
  onBatchDecide,
  contextAvailable,
  onAdoptContext,
  onSetCriterionActive,
  exportAvailable,
  onPreviewOriginalExport,
  onExecuteOriginalExport,
  onChooseExportDestination,
  activeSourceVersionId,
  activeTargets = [],
  nextScene,
  pendingRequest = 0,
}: {
  snapshot: TaskReviewSnapshot;
  busy: boolean;
  agent: TaskAgentBridge | null;
  agentRuntime: TaskAgentRuntime;
  onSetGoal: (goal: string) => Promise<{ ok: boolean; error: string | null }>;
  onImportText: (input: { name: string; text: string; format: TaskTextFormat }) => Promise<{ ok: boolean; error: string | null }>;
  onImportFile: (entryId: string) => Promise<{ ok: boolean; error: string | null }>;
  onRefreshSources: () => Promise<{ ok: boolean; error: string | null; snapshot?: TaskReviewSnapshot | null }>;
  onExport: (input: {
    sourceVersionId: string;
    purpose: string;
  }) => Promise<{ ok: boolean; error: string | null; snapshot?: TaskReviewSnapshot | null }>;
  onOpenUnit: (unitId: string) => void;
  onOpenScene: (scene: TaskSceneSuggestion) => void;
  onBatchDecide: (unitIds: string[], status: TaskDecisionStatus) => void;
  contextAvailable: boolean;
  onAdoptContext: (input: { proposalId: string; authorizedSourceVersionIds: string[] }) => Promise<MutationResult>;
  onSetCriterionActive: (input: { versionId: string; active: boolean }) => Promise<MutationResult>;
  exportAvailable: boolean;
  onPreviewOriginalExport: ResultExportPanelProps["onPreview"];
  onExecuteOriginalExport: ResultExportPanelProps["onExecute"];
  onChooseExportDestination: ResultExportPanelProps["onChooseDestination"];
  activeSourceVersionId?: string;
  activeTargets?: TaskUnitTarget[];
  nextScene?: TaskSceneSuggestion | null;
  pendingRequest?: number;
}) {
  const { t } = useTranslation();
  const [goalDraft, setGoalDraft] = useState(snapshot.goal);
  const [goalState, setGoalState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [goalError, setGoalError] = useState<string | null>(null);
  const [paste, setPaste] = useState({ name: "", format: "txt" as TaskTextFormat, text: "" });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "decided">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [exported, setExported] = useState<{ path: string } | null>(null);
  const [semantic, setSemantic] = useState<{
    query: string;
    matches: Map<string, string>;
    searchedUnitCount: number;
    result: TaskSemanticSearchResult;
  } | null>(null);
  const [semanticBusy, setSemanticBusy] = useState(false);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"overview" | "goal" | "import" | "model" | "export">("overview");
  const rowsRef = useRef<HTMLElement>(null);
  const showPending = () => {
    setStatusFilter("pending"); setQuery(""); setSemantic(null); setPanel("overview");
  };
  useEffect(() => { if (pendingRequest) showPending(); }, [pendingRequest]);
  useEffect(() => { if (pendingRequest && panel === "overview") rowsRef.current?.focus(); }, [pendingRequest, panel]);
  const [searchScope, setSearchScope] = useState<"task" | "source" | "scene">("task");
  const scope: TaskSearchScope = searchScope === "source" ? { kind: "sources", sourceVersionIds: activeSourceVersionId ? [activeSourceVersionId] : [] }
    : searchScope === "scene" ? { kind: "units", targets: activeTargets } : { kind: "task" };
  const scopeValid = searchScope === "task" || (searchScope === "source" ? Boolean(activeSourceVersionId) : activeTargets.length > 0);
  const scopeKey = JSON.stringify(scope);
  const searchSequence = useRef(0);
  const activeSearch = useRef<number | null>(null);
  const cancelSemantic = useCallback(() => {
    const wasActive = activeSearch.current !== null;
    activeSearch.current = null;
    const sequence = ++searchSequence.current;
    setSemanticBusy(false);
    if (wasActive && agent) void agent.cancelSearch({ root: snapshot.root, taskId: snapshot.taskId }).catch((problem) => {
      if (sequence === searchSequence.current) setSemanticError(String(problem));
    });
  }, [agent, snapshot.root, snapshot.taskId]);
  useEffect(() => {
    setSemantic(null);
    setSemanticError(null);
    return cancelSemantic;
  }, [cancelSemantic, scopeKey, query]);

  useEffect(() => setGoalDraft(snapshot.goal), [snapshot.goal]);
  useEffect(() => setSelected(new Set()), [snapshot.sources.length]);

  const importedEntries = useMemo(
    () => new Set(snapshot.sources.map((source) => source.entryId)),
    [snapshot.sources],
  );

  const stats = unitStats(snapshot);
  const plan = remainingPlanSteps(snapshot);
  const scenes = remainingScenes(snapshot);
  const visits = recentVisits(snapshot);
  const rows = useMemo(() => {
    const order = new Map(plan.map((step, index) => [step.unitId, index]));
    const matchOrder = semantic
      ? new Map([...semantic.matches.keys()].map((unitId, index) => [unitId, index] as const))
      : null;
    return snapshot.units
      .filter((unit) => isCurrentTaskUnit(snapshot, unit))
      .map((unit) => ({
        unit,
        status: decisionStatus(snapshot, unit.id),
        issues: issuesForUnit(snapshot, unit.id).length,
        reason: semantic?.matches.get(unit.id) ?? null,
      }))
      .filter((row) => {
        if (semantic) {
          if (!semantic.matches.has(row.unit.id)) return false;
        } else if (query && !unitTitle(row.unit).toLowerCase().includes(query.toLowerCase())) return false;
        if (statusFilter === "pending") return !row.status;
        if (statusFilter === "decided") return Boolean(row.status);
        return true;
      })
      .sort((a, b) => {
        if (matchOrder) return matchOrder.get(a.unit.id)! - matchOrder.get(b.unit.id)!;
        const planA = order.get(a.unit.id);
        const planB = order.get(b.unit.id);
        if (planA !== undefined || planB !== undefined)
          return (planA ?? Number.MAX_SAFE_INTEGER) - (planB ?? Number.MAX_SAFE_INTEGER);
        return a.unit.ordinal - b.unit.ordinal;
      });
  }, [plan, query, semantic, snapshot, statusFilter]);

  const saveGoal = async () => {
    setGoalState("saving");
    const result = await onSetGoal(goalDraft);
    if (result.ok) {
      setGoalState("saved");
      setPanel("overview");
      setGoalError(null);
    } else {
      setGoalState("error");
      setGoalError(result.error);
    }
  };

  const granted = Boolean(agentRuntime.state?.grant);
  const runSemanticSearch = async () => {
    if (!agent || !granted || !query.trim() || !scopeValid) return;
    const generation = ++searchSequence.current;
    activeSearch.current = generation;
    setSemanticBusy(true);
    setSemanticError(null);
    try {
      const result = await agent.search({
        root: snapshot.root,
        taskId: snapshot.taskId,
        query,
        scope,
      });
      if (activeSearch.current !== generation) return;
      setSemantic({
        query,
        matches: new Map(result.matches.map((match) => [match.unitId, `${match.reason}${match.sourceRefs?.length ? t("\nQuote: {{v0}}", { v0: match.sourceRefs.map((ref) => ref.text).join(" / ") }) : ""}`])),
        searchedUnitCount: result.searchedUnitCount,
        result,
      });
    } catch (problem) {
      if (activeSearch.current === generation) setSemanticError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      if (activeSearch.current === generation) {
        activeSearch.current = null;
        setSemanticBusy(false);
      }
    }
  };

  const importText = async () => {
    if (!paste.text.trim() || !paste.name.trim()) return;
    const result = await onImportText(paste);
    if (result.ok) {
      setPaste({ name: "", format: paste.format, text: "" });
      setPanel("overview");
      setActionError(null);
    } else setActionError(result.error);
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-xs"
      data-testid="task-review-global-scene"
    >
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3">
        {panel !== "export" && <TaskContextBrief snapshot={snapshot} next={nextScene ?? undefined} />}
        <div className="flex flex-wrap items-center gap-2" data-testid="task-review-global-actions">
          <strong className="mr-auto">{t("Decided ")}{stats.decided}/{stats.total} {t(" · Pending ")}{stats.pending}</strong>
          <button type="button" className={wbButton.secondary} onClick={showPending}>{t("View pending items")}</button>
          {([["goal", t("Edit goal")], ["import", t("Import source")], ["model", t("Model and authorization")]] as const).map(([key, label]) => <button
            key={key}
            type="button"
            className={wbButton.secondary}
            aria-expanded={panel === key}
            data-testid={`task-review-show-${key}`}
            onClick={() => setPanel(panel === key ? "overview" : key)}>{label}</button>)}
          {panel !== "overview" && <button type="button" className={wbButton.ghost} onClick={() => setPanel("overview")}>{t("Return to overview")}</button>}
        </div>
        {actionError && (
          <p role="alert" className="rounded border border-status-error/40 p-2 text-status-error">
            {actionError}
            <button type="button" className={`${wbButton.ghost} ml-2`} onClick={() => setActionError(null)}>
              {t("Got it")}
            </button>
          </p>
        )}
        {exportAvailable && <ResultExportPanel
          snapshot={snapshot}
          open={panel === "export"}
          onOpenChange={(open) => {
            if (open) cancelSemantic();
            setPanel(open ? "export" : "overview");
          }}
          busy={busy}
          onPreview={onPreviewOriginalExport}
          onExecute={onExecuteOriginalExport}
          onChooseDestination={onChooseExportDestination} />}
        <div hidden={panel === "export"} className={panel === "export" ? "hidden" : "flex flex-col gap-3"}>
          <section hidden={panel !== "goal"} className={panel === "goal" ? "flex flex-col gap-1.5" : "hidden"} data-testid="task-review-goal-editor">
            <strong>{t("Task goal and criteria")}</strong>
            <textarea
              className="min-h-14 rounded border border-border bg-bg-2 p-2"
              aria-label={t("Task goal and criteria")}
              value={goalDraft}
              placeholder={t("Describe the goal, audience and criteria for keeping, reworking or discarding")}
              onChange={(event) => setGoalDraft(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <button type="button" className={wbButton.secondary} disabled={busy || goalDraft === snapshot.goal} onClick={() => void saveGoal()}>
                {t("Save goal and criteria")}
              </button>
              <span role="status">
                {goalState === "saving"
                  ? t("Saving…")
                  : goalState === "saved"
                    ? t("Saved")
                    : goalState === "error"
                      ? goalError
                      : ""}
              </span>
            </div>
          </section>
          <TaskContextPanel
            snapshot={snapshot}
            busy={busy}
            available={contextAvailable}
            onAdoptContext={onAdoptContext}
            onSetCriterionActive={onSetCriterionActive}
            onOpenUnit={onOpenUnit}
            nextScene={nextScene}
            showBrief={false}
          />
          <section
            hidden={panel !== "import"}
            className={panel === "import" ? "flex flex-col gap-1.5" : "hidden"}
            data-testid="task-review-import-editor">
            <strong>{t("Import dialogue source")}</strong>
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                className={`${inputClass} max-w-48`}
                aria-label={t("Source name")}
                placeholder={t("Name, for example Episode 1 dialogue")}
                value={paste.name}
                onChange={(event) => setPaste({ ...paste, name: event.target.value })}
              />
              <select
                className="rounded border border-border bg-bg-2 px-1 py-1"
                aria-label={t("Source format")}
                value={paste.format}
                onChange={(event) => setPaste({ ...paste, format: event.target.value as TaskTextFormat })}
              >
                <option value={t("txt")}>{t("txt")}</option>
                <option value={t("md")}>{t("md")}</option>
                <option value={t("srt")}>{t("srt")}</option>
                <option value={t("vtt")}>{t("vtt")}</option>
              </select>
              <button
                type="button"
                className={wbButton.primary}
                disabled={busy || !paste.text.trim() || !paste.name.trim()}
                onClick={() => void importText()}
                data-testid="task-review-import-text">
                {t("Import pasted text")}
              </button>
            </div>
            <textarea
              className="min-h-14 rounded border border-border bg-bg-2 p-2"
              aria-label={t("Pasted text content")}
              placeholder={t("Paste UTF-8 text, Markdown or subtitles. The original is saved as an immutable version.")}
              value={paste.text}
              onChange={(event) => setPaste({ ...paste, text: event.target.value })}
            />
          </section>
          {(snapshot.sourceFiles.length > 0 || snapshot.sources.length > 0) && (
            <div className="flex flex-col gap-1" data-testid="task-review-source-files">
              <div className="flex items-center gap-2">
                <span className="text-fg-3">{t("Text files in the task folder (use the directory view to drop files)")}</span>
                <button
                  type="button"
                  className={wbButton.ghost}
                  disabled={busy}
                  data-testid="task-review-refresh-sources"
                  title={t("Rescan the task folder for source files; missing or damaged files are marked")}
                  onClick={() => void onRefreshSources().then(result => {
                    if (!result.ok) setActionError(result.error);
                  })}
                >
                  {t("Refresh source files")}
                </button>
              </div>
              {snapshot.sourceFiles.map((file) => (
                <div key={file.entryId} className="flex items-center gap-2" data-testid="task-review-source-file" data-status={file.status}>
                  <span className="min-w-0 flex-1 truncate" title={file.error ?? file.relativePath}>
                    {sourceTitle(file.relativePath)}
                  </span>
                  {file.status === "available" ? (
                    importedEntries.has(file.entryId) ? (
                      <span className="shrink-0 text-fg-3">{t("Imported")}</span>
                    ) : (
                      <button
                        type="button"
                        className={wbButton.ghost}
                        disabled={busy}
                        onClick={() => void onImportFile(file.entryId).then(result => {
                          if (!result.ok) setActionError(result.error);
                        })}
                      >
                        {t("Import")}
                      </button>
                    )
                  ) : (
                    <span className="shrink-0 text-status-error" title={file.error}>
                      {file.status === "missing" ? t("File missing") : t("Cannot parse")}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          <section className="flex flex-col gap-1.5">
            <strong>
              {t("Item review and dialogue selection · {{total}} total · {{pending}} pending · {{kept}} kept · {{rework}} rework · {{discarded}} discarded", {
                total: stats.total,
                pending: stats.pending,
                kept: stats.kept,
                rework: stats.rework,
                discarded: stats.discarded,
              })}
            </strong>
            {currentSources(snapshot).filter(isTextTaskSource).map((source) => (
              <div key={source.id} className="flex flex-wrap items-center gap-2 rounded border border-border p-2" data-testid="task-review-source">
                <span className="min-w-0 flex-1 truncate" title={source.relativePath}>
                  {sourceTitle(source.relativePath)} · {source.format}
                </span>
                <button
                  type="button"
                  className={wbButton.secondary}
                  disabled={busy}
                  title={t("Export all kept items under the export criteria, preserving subtitle timing and multiline structure")}
                  onClick={() =>
                    void onExport({ sourceVersionId: source.id, purpose: REVIEW_PURPOSE }).then((result) => {
                      if (result.ok) {
                        const artifact = result.snapshot?.artifacts.at(-1);
                        setExported(artifact ? { path: artifact.relativePath } : null);
                        setActionError(null);
                      } else setActionError(result.error);
                    })
                  }
                >
                  {t("Export approved items")}
                </button>
              </div>
            ))}
            {(snapshot.artifacts.length > 0 || exported) && (
              <div className="flex flex-col gap-1 text-fg-3" data-testid="task-review-artifacts">
                <span>{t("Result files")}</span>
                {snapshot.artifacts.map((artifact) => (
                  <div
                    key={artifact.id}
                    className="flex items-center gap-2"
                    data-testid="task-review-artifact"
                    data-status={artifact.status}
                  >
                    <span className="min-w-0 flex-1 truncate" title={artifact.error ?? artifact.manifestRelativePath}>
                      {artifact.relativePath} · {t("{{count}} items", { count: artifact.unitIds.length })}
                    </span>
                    <span className={artifact.status === "failed" ? "shrink-0 text-status-error" : "shrink-0"}>
                      {artifact.status === "complete"
                        ? t("Generated")
                        : artifact.status === "pending"
                          ? t("Generating")
                          : t("Failed")}
                    </span>
                    {artifact.status === "failed" && artifact.error && (
                      <span className="min-w-0 flex-1 truncate text-status-error" title={artifact.error}>
                        {artifact.error}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
          <section ref={rowsRef} tabIndex={-1} className="flex flex-col gap-1.5 outline-none" data-testid="task-review-item-list">
            <div className="flex flex-wrap items-center gap-1.5">
              <strong>{t("Item search")}</strong>
              <input
                className={`${inputClass} max-w-56`}
                aria-label={t("Search item text")}
                placeholder={t("Search item text")}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSemantic(null);
                }}
              />
              <button
                type="button"
                className={wbButton.secondary}
                disabled={!agent || !granted || semanticBusy || !query.trim() || !scopeValid}
                title={granted ? t("AI semantic search includes paraphrases and requires task authorization") : t("Authorize this task below first")}
                data-testid="task-review-semantic-search"
                onClick={() => void runSemanticSearch()}
              >
                {semanticBusy ? t("Searching semantically…") : t("Semantic search")}
              </button>
              <select
                className={inputClass}
                aria-label={t("Semantic search scope")}
                value={searchScope}
                onChange={(event) => setSearchScope(event.target.value as typeof searchScope)}>
                <option value="task">{t("Entire authorized task")}</option>
                <option value="source" disabled={!activeSourceVersionId}>{t("Current source")}</option>
                <option value="scene" disabled={!activeTargets.length}>{t("Current scene items")}</option>
              </select>
              {semanticBusy && <button type="button" className={wbButton.ghost} data-testid="task-review-cancel-search" onClick={cancelSemantic}>{t("Stop search")}</button>}
              {semantic && (
                <span className="text-fg-3" role="status" data-testid="task-review-semantic-result">
                  {t("{{count}}/{{total}} semantic matches", {
                    count: semantic.matches.size,
                    total: semantic.searchedUnitCount,
                  })}
                  {semantic.result.scopeUnitCount !== undefined && <span>{t(" · Scope {{scope}} items, local search {{local}} items, AI candidates {{candidates}} items; ", { scope: semantic.result.scopeUnitCount, local: semantic.result.locallyScannedUnitCount ?? semantic.result.scopeUnitCount, candidates: semantic.result.candidateUnitCount ?? semantic.searchedUnitCount })}{semantic.result.coverage === "scope" ? t("Covers the selected scope") : t("Covers candidates only; does not claim full-scope analysis")}{semantic.result.truncated ? t("; {{v0}} items not sent to the model", { v0: semantic.result.omittedUnitCount ?? 0 }) : ""}{semantic.result.cached ? t(" (valid cache reused)") : ""}</span>}
                  <button
                    type="button"
                    className={`${wbButton.ghost} ml-1`}
                    onClick={() => {
                      setSemantic(null);
                      setQuery("");
                    }}
                  >
                    {t("reviewUi.Clear_37")}
                  </button>
                </span>
              )}
              {semanticError && (
                <span role="alert" className="text-status-error">
                  {semanticError}
                </span>
              )}
              <select
                className="rounded border border-border bg-bg-2 px-1 py-1"
                aria-label={t("Status filter")}
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
              >
                <option value="all">{t("All")}</option>
                <option value="pending">{t("Pending")}</option>
                <option value="decided">{t("Decided")}</option>
              </select>
            </div>
            {selected.size > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 rounded border border-accent/50 bg-accent/5 p-2" data-testid="task-review-batch-bar">
                <span className="font-medium">{t("The batch decision applies to {{count}} selected items", { count: selected.size })}</span>
                {(Object.keys(statusLabels) as TaskDecisionStatus[]).map((status) => (
                  <button
                    key={status}
                    type="button"
                    className={wbButton.secondary}
                    disabled={busy}
                    data-testid={`task-review-batch-${status}`}
                    onClick={() => {
                      onBatchDecide([...selected], status);
                      setSelected(new Set());
                    }}
                  >
                    {t("reviewUi.status_count_selected_items_239", { status: t(statusLabels[status]), count: selected.size })}
                  </button>
                ))}
                <button type="button" className={wbButton.ghost} onClick={() => setSelected(new Set())}>
                  {t("reviewUi.clearSelection")}
                </button>
              </div>
            )}
            <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto" data-testid="task-review-unit-list">
              {rows.map(({ unit, status, issues, reason }) => {
                const inPlan = plan.some((step) => step.unitId === unit.id);
                return (
                  <li key={unit.id} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-bg-2">
                    <input
                      type="checkbox"
                      aria-label={t("Select item #{{no}}", { no: unit.ordinal })}
                      checked={selected.has(unit.id)}
                      onChange={(event) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(unit.id);
                          else next.delete(unit.id);
                          return next;
                        })
                      }
                    />
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left"
                      title={reason ? `${unitTitle(unit)}\n${reason}` : unitTitle(unit)}
                      data-testid="task-review-unit-row"
                      onClick={() => onOpenUnit(unit.id)}
                    >
                      <span className="mr-1.5 text-fg-3">#{unit.ordinal}</span>
                      {unitTitle(unit).split("\n")[0]}
                    </button>
                    {issues > 0 && (
                      <span className="shrink-0 rounded bg-status-error/15 px-1 py-0.5 text-status-error" title={t("{{count}} AI concerns", { count: issues })}>
                        {issues}
                      </span>
                    )}
                    {inPlan && <span className="shrink-0 text-accent" title={t("In the Agent's future plan")}>◐</span>}
                    <span className={`shrink-0 ${status ? "text-fg-3" : "text-accent"}`}>
                      {status ? t(statusLabels[status]) : t("Pending")}
                    </span>
                  </li>
                );
              })}
              {!rows.length && <li className="p-3 text-center text-fg-3">{t("No matching items")}</li>}
            </ul>
          </section>
          <section className="grid gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1" data-testid="task-review-plan-list">
              <strong>{t("Agent plan (upcoming, risk first)")}</strong>
              {scenes.map((scene) => {
                const pending = pendingSceneTargets(snapshot, scene);
                return (
                  <button
                    key={scene.id}
                    type="button"
                    className="flex items-center gap-2 rounded px-1 py-1 text-left hover:bg-bg-2"
                    data-testid="task-review-plan-scene"
                    data-scene-kind={scene.kind}
                    onClick={() => onOpenScene(scene)}
                  >
                    <span className="shrink-0 text-fg-3">{scene.manual ? t("Human review / local tools") : scene.kind === "compare" ? t("Related comparison") : scene.kind === "lowRiskGroup" ? t("Group skim") : t("Single item")}</span>
                    <span className="min-w-0 flex-1 truncate" title={`${scene.checkIntent}：${scene.reason}`}>{scene.targets.map((target) => (findUnit(snapshot, target.unitId) ? unitTitle(findUnit(snapshot, target.unitId)!).split("\n")[0] : t("Item unavailable"))).join(" / ")}</span>
                    <span className="shrink-0 text-fg-3">{t("Pending ")}{pending.length}/{scene.targets.length}</span>
                  </button>
                );
              })}
              {!plan.length && <span className="p-2 text-fg-3">{t("No upcoming plan. Import source text or wait for review results.")}</span>}
            </div>
            <div className="flex flex-col gap-1" data-testid="task-review-history-list">
              <strong>{t("Visited items (actual history)")}</strong>
              {visits.map((visit) => {
                const unit = findUnit(snapshot, visit.unitId);
                return (
                  <button
                    key={visit.id}
                    type="button"
                    className="flex items-center gap-2 rounded px-1 py-1 text-left hover:bg-bg-2"
                    onClick={() => onOpenUnit(visit.unitId)}
                  >
                    <span className="shrink-0 text-fg-3">#{unit?.ordinal ?? "?"}</span>
                    <span className="min-w-0 flex-1 truncate">{(unit ? unitTitle(unit) : t("Item unavailable")).split("\n")[0]}</span>
                    <span className="shrink-0 text-fg-3">{new Date(visit.createdAt).toLocaleTimeString()}</span>
                  </button>
                );
              })}
              {!visits.length && <span className="p-2 text-fg-3">{t("No items visited yet")}</span>}
            </div>
          </section>
          <section hidden={panel !== "model"} className={panel === "model" ? "" : "hidden"} data-testid="task-review-model-settings"><AgentPanel agent={agent} snapshot={snapshot} runtime={agentRuntime} /></section>
        </div>
      </div>
    </div>
  );
}
