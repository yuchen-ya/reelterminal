import { useTranslation } from "react-i18next";
import { t as translate } from "../../i18n";
import { legacyCleanupHandoffIdentity } from "../../services/cleanup-handoff-identity";
import { LocalizedMessage } from "../../i18n/LocalizedMessage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import {
  ArrowLeft,
  RefreshCw,
  FolderOpen,
  Film,
  Archive,
  Trash2,
  RotateCcw,
  HardDrive,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Bot,
} from "@/icons/lucide-compat";
import { useDesktopExportStore } from "../../stores/desktop-export-store";
import { useUIStore } from "../../stores/ui-store";
import { workspaceManager } from "../../services/workspace-manager";
import {
  getCleanupReview,
  createCleanupPlan,
  executeCleanupPlan,
} from "../../services/export-cleanup";
import {
  advanceCleanupReviewPhase,
  buildCleanupAgentPrompt,
  publishCleanupReview,
} from "../../services/cleanup-handoff";

type Review = Awaited<ReturnType<typeof getCleanupReview>>;
type Plan = Awaited<ReturnType<typeof createCleanupPlan>>;
type Result = Awaited<ReturnType<typeof executeCleanupPlan>>;
type Action = Parameters<typeof createCleanupPlan>[1];
type Target = Parameters<typeof getCleanupReview>[0];

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

const btnSecondary =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-bg-2 px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-bg-3 disabled:opacity-40";
const btnPrimary =
  "inline-flex items-center justify-center gap-1.5 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40";

const actionLabels: Record<string, string> = {
  get "purge-media"() { return translate("Remove unused app-managed media"); },
  get "recycle-nodes"() { return translate("Move selected snapshots to the recycle bin"); },
  get "restore-nodes"() { return translate("Restore selected snapshots"); },
  get "purge-deleted-nodes"() { return translate("Permanently delete selected snapshots from the recycle bin"); },
  get "purge-cache"() { return translate("Remove rebuildable cache"); },
  get "purge-failed-jobs"() { return translate("Remove failed task records"); },
  get "purge-work-files"() { return translate("Remove selected temporary files and unadopted results"); },
};

const spaceCleanupCards: Array<{
  action: Action;
  title: string;
  desc: string;
  needsNodes?: boolean;
}> = [
  {
    action: "purge-media",
    get title() { return translate("Remove unused media"); },
    get desc() { return translate("Remove app-managed media that is no longer referenced by the current project or retained snapshots"); },
    needsNodes: true,
  },
  {
    action: "purge-cache",
    get title() { return translate("Remove rebuildable cache"); },
    get desc() { return translate("Free frame cache and proxy files (the project is preserved; files rebuild when needed)"); },
  },
  {
    action: "purge-work-files",
    get title() { return translate("Remove temporary and unadopted files"); },
    get desc() { return translate("Remove intermediate files left by generation attempts (select the exact files below)"); },
  },
  {
    action: "purge-failed-jobs",
    get title() { return translate("Remove failed task records"); },
    get desc() { return translate("Remove snapshot records for failed or cancelled jobs"); },
  },
];

export function ExportCleanupPage(): JSX.Element {
  const { t } = useTranslation();
  const session = useDesktopExportStore((state) => state.session);
  const outputs = useDesktopExportStore((state) => state.outputs);
  const cancelExport = useDesktopExportStore((state) => state.cancel);
  const [activeTarget, setActiveTarget] = useState<Target | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [nodeIds, setNodeIds] = useState<string[]>([]);
  const [workFileIds, setWorkFileIds] = useState<string[]>([]);
  const [action, setAction] = useState<Action>("purge-media");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef(0);

  const target = useMemo(
    () => session?.target ?? activeTarget,
    [session?.target, activeTarget],
  );

  const hasPlanChanges =
    plan !== null &&
    (plan.candidateMedia.length > 0 ||
      plan.candidateCache.length > 0 ||
      plan.candidateJobs.length > 0 ||
      plan.candidateWorkFiles.length > 0 ||
      (["recycle-nodes", "restore-nodes", "purge-deleted-nodes"].includes(
        plan.action,
      ) &&
        plan.selection.nodeIds.length > 0));

  const cleanupNodeIds =
    action === "purge-cache" ||
    action === "purge-failed-jobs" ||
    action === "purge-work-files"
      ? []
      : nodeIds;

  const sortedNodes = useMemo(() => {
    const nodes = [...(review?.nodes ?? [])].sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        left.nodeId.localeCompare(right.nodeId),
    );
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const depths = new Map<string, number>();
    const getDepth = (id: string): number => {
      if (depths.has(id)) return depths.get(id)!;
      const parent = byId
        .get(id)
        ?.parentNodeIds.find((parentId) => byId.has(parentId));
      const value = parent ? getDepth(parent) + 1 : 0;
      depths.set(id, value);
      return value;
    };
    return nodes.map((node) => ({
      node,
      depth: Math.min(getDepth(node.nodeId), 4),
      parentName: node.parentNodeIds.length
        ? (byId.get(node.parentNodeIds[0])?.name ?? t("Earlier version"))
        : null,
    }));
  }, [review, t]);

  const deliveredOutputs = useMemo(
    () =>
      outputs.filter(
        (output) =>
          output.target.projectId === target?.projectId &&
          output.ownership.deliveryStatus === "delivered",
      ),
    [outputs, target?.projectId],
  );

  const pendingOutputs = useMemo(
    () =>
      outputs.filter(
        (output) =>
          output.target.projectId === target?.projectId &&
          output.ownership.deliveryStatus === "pending",
      ),
    [outputs, target?.projectId],
  );

  useEffect(() => {
    let disposed = false;
    workspaceManager
      .getActiveWorkspace()
      .then((workspace) => {
        if (!disposed && workspace)
          setActiveTarget({
            projectId: workspace.projectId,
            workspaceId: workspace.id,
          });
      })
      .catch((error: unknown) => {
        if (!disposed) setMessage(String(error));
      });
    return () => {
      disposed = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!target) return;
    const sequence = ++request.current;
    try {
      const next = await getCleanupReview(target, nodeIds);
      if (sequence === request.current) setReview(next);
    } catch (error) {
      if (sequence === request.current) {
        setReview(null);
        setMessage(error instanceof Error ? error.message : String(error));
      }
    }
  }, [target, nodeIds]);

  useEffect(() => {
    setPlan(null);
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh]);

  const handoff = (overrideAction: Action = action) => {
    if (!target || !review) throw new Error(translate("Complete the reference review first"));
    const effectiveNodes =
      overrideAction === "purge-cache" ||
      overrideAction === "purge-failed-jobs" ||
      overrideAction === "purge-work-files"
        ? []
        : nodeIds;
    return {
      ...target,
      revision: session?.target.revision ?? review.revision,
      ...legacyCleanupHandoffIdentity(overrideAction, effectiveNodes, workFileIds),
      presentation: {
        scope: translate("cleanup.handoff.scope", { action: actionLabels[overrideAction], count: effectiveNodes.length, workFiles: overrideAction === "purge-work-files" ? translate("cleanup.handoff.workFiles", { files: workFileIds.join(", ") }) : "" }),
        retention: translate("cleanup.handoff.retention"),
      },
    };
  };

  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await operation();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const runPreview = (selectedAction: Action = action) => {
    if (selectedAction !== action) {
      setAction(selectedAction);
    }
    const effectiveNodes =
      selectedAction === "purge-cache" ||
      selectedAction === "purge-failed-jobs" ||
      selectedAction === "purge-work-files"
        ? []
        : nodeIds;
    void perform(async () => {
      if (!target) return;
      const description = handoff(selectedAction);
      const { store } = await workspaceManager.getWorkspaceContext(target);
      const requirement = store
        .getState()
        .project.requirements?.items.find((item) => {
          const binding = item.cleanupHandoff;
          return (
            binding &&
            binding.projectId === target.projectId &&
            binding.workspaceId === target.workspaceId &&
            binding.exportId === target.exportId &&
            binding.revision === description.revision &&
            binding.scope === description.scope &&
            binding.retention === description.retention &&
            binding.phase !== "completed" &&
            JSON.stringify([...binding.nodeIds].sort()) ===
              JSON.stringify([...effectiveNodes].sort())
          );
        });
      const planTarget = requirement
        ? { ...target, cleanupTaskId: requirement.id }
        : target;
      if (requirement?.cleanupHandoff) {
        if (requirement.cleanupHandoff.phase === "pending_review")
          await advanceCleanupReviewPhase(
            description,
            effectiveNodes,
            "reviewing",
            { store },
          );
        const scanned = await getCleanupReview(planTarget, effectiveNodes);
        if (
          scanned.scanReady &&
          (requirement.cleanupHandoff.phase === "pending_review" ||
            requirement.cleanupHandoff.phase === "reviewing")
        ) {
          await advanceCleanupReviewPhase(
            description,
            effectiveNodes,
            "awaiting_confirmation",
            { store },
          );
        }
      }
      setResult(null);
      setPlan(
        await createCleanupPlan(planTarget, selectedAction, {
          nodeIds: effectiveNodes,
          ...(selectedAction === "purge-work-files" ? { workFileIds } : {}),
        }),
      );
    });
  };

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-bg text-fg"
      data-testid="export-cleanup-page"
    >
      {/* Top Bar */}
      <header className="shrink-0 border-b border-border bg-bg-1 px-6 py-3.5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <HardDrive size={17} aria-hidden />
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight">{t("Exports and cleanup")}</h1>
              <p className="text-xs text-fg-muted">{t("Manage exported videos and version snapshots, or free project space while preserving source media and delivered videos")}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={btnSecondary}
              disabled={busy || !target}
              onClick={() => void refresh()}
            >
              <RefreshCw size={13} aria-hidden />
              {t("Refresh checks")}</button>
            <button
              type="button"
              className={btnSecondary}
              onClick={() => useUIStore.getState().setDesktopPage("edit")}
            >
              <ArrowLeft size={13} aria-hidden />
              {t("Return to editing")}</button>
          </div>
        </div>

        {/* Active Export Progress & Delivered Videos Banner */}
        {(session || deliveredOutputs.length > 0 || pendingOutputs.length > 0) && (
          <div className="mt-3.5 rounded-lg border border-border bg-bg-2/70 p-3.5">
            {session ? (
              <div data-testid="export-fixed-progress">
                <div className="flex items-center justify-between text-xs font-medium">
                  <span className="flex items-center gap-2">
                    <Film size={14} className="text-accent" aria-hidden />
                    <span>
                      {session.projectName} ·{" "}
                      {session.state.complete ? t("Export complete") : session.state.phase}
                    </span>
                  </span>
                  <span className="font-mono text-fg-2">
                    {Math.round(session.state.progress)}%
                  </span>
                </div>
                <progress
                  className="mt-2 h-1.5 w-full overflow-hidden rounded-full accent-accent"
                  max={100}
                  value={session.state.progress}
                  aria-label={t("Export Progress")}
                />
                {session.state.error ? (
                  <p role="alert" className="mt-1.5 text-xs text-red-400">
                    {session.state.error}
                  </p>
                ) : null}
                {session.state.isExporting ? (
                  <div className="mt-2 flex items-center justify-between text-xs text-fg-muted">
                    <span>{t("Export is in progress. Returning to editing will not interrupt it.")}</span>
                    <button
                      type="button"
                      className="text-red-400 hover:underline"
                      onClick={() => cancelExport?.()}
                    >{t("desktop.editor.cancelExport")}</button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {deliveredOutputs.length > 0 ? (
              <div className={session ? "mt-3 border-t border-border pt-3" : ""}>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                    <Film size={13} className="text-accent" aria-hidden />
                    {t("Delivered videos (")}{deliveredOutputs.length}）
                  </h2>
                  <span className="text-[11px] text-fg-muted">{t("Space cleanup does not delete delivered videos")}</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {deliveredOutputs.map((output) => (
                    <div
                      key={output.target.exportId}
                      className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg-1 px-3 py-2 text-xs"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-fg">
                          {output.projectName}
                        </div>
                        <div
                          className="mt-0.5 truncate text-[11px] text-fg-muted"
                          title={output.outputPath}
                        >
                          {output.outputPath ?? t("Handed to the browser for download")}
                        </div>
                      </div>
                      {output.outputPath ? (
                        <button
                          type="button"
                          className={btnSecondary}
                          onClick={() =>
                            void perform(async () => {
                              await window.reelterminal?.fs.revealInFolder(
                                output.outputPath!,
                              );
                            })
                          }
                        >
                          <FolderOpen size={12} aria-hidden />
                          {t("Show in folder")}</button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {pendingOutputs.length > 0 ? (
              <details className="mt-2.5 text-xs text-fg-muted">
                <summary className="cursor-pointer hover:text-fg">{t("Incomplete export attempts ({{v0}})", { v0: pendingOutputs.length })}</summary>
                <div className="mt-1.5 space-y-1">
                  {pendingOutputs.map((output) => (
                    <p
                      key={output.target.exportId}
                      className="break-all text-[11px]"
                    >
                      {output.state.error ?? output.state.phase} ·{" "}
                      {output.outputPath ?? output.target.exportId}
                    </p>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        )}
      </header>

      {/* Main Content Split */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(340px,5fr)_minmax(420px,7fr)]">
        {/* Left Panel: Project Archive Versions */}
        <div className="flex min-h-0 flex-col border-b border-border lg:border-b-0 lg:border-r">
          <div className="shrink-0 border-b border-border bg-bg-1/50 px-5 py-3.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Archive size={15} className="text-accent" aria-hidden />
                <h2 className="text-sm font-semibold">{t("Version snapshots")}</h2>
                {review ? (
                  <span className="rounded-full bg-bg-3 px-2 py-0.5 text-[11px] text-fg-2">
                    {review.nodes.length}
                  </span>
                ) : null}
              </div>
              {review && review.nodes.length > 0 ? (
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    className="text-fg-2 hover:text-fg hover:underline"
                    disabled={busy}
                    onClick={() =>
                      setNodeIds(review.nodes.map((node) => node.nodeId))
                    }
                  >{t("Select all")}</button>
                  <span className="text-border">|</span>
                  <button
                    type="button"
                    className="text-fg-2 hover:text-fg hover:underline"
                    disabled={busy || nodeIds.length === 0}
                    onClick={() => setNodeIds([])}
                  >{t("Clear")}</button>
                </div>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-fg-muted">{t("Select snapshots to organize. Media still used by the current edit or other retained versions is protected.")}</p>

            {/* Quick Contextual Action Bar when nodes are selected */}
            {nodeIds.length > 0 ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-xs">
                <span className="font-medium text-fg">{t("Snapshots selected: {{v0}} {{v1}}", { v0: nodeIds.length, v1: review
                    ? t(" · Exclusive space: {{v0}}", { v0: bytes(review.selected.reclaimableBytes) })
                    : "" })}</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    className={btnSecondary}
                    disabled={busy}
                    onClick={() => runPreview("recycle-nodes")}
                  >
                    <Trash2 size={12} aria-hidden />
                    {t("review.moveToTrash")}</button>
                  <button
                    type="button"
                    className={btnSecondary}
                    disabled={busy}
                    onClick={() => runPreview("restore-nodes")}
                  >
                    <RotateCcw size={12} aria-hidden />
                    {t("Restore snapshots")}</button>
                </div>
              </div>
            ) : null}
          </div>

          {/* Archive Node List */}
          <div
            className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-5"
            data-testid="cleanup-node-graph"
          >
            {sortedNodes.map(({ node, depth, parentName }) => {
              const isSelected = nodeIds.includes(node.nodeId);
              const exclusiveBytes = node.media
                .filter((media) => media.relation === "exclusive")
                .reduce((total, media) => total + (media.sizeBytes ?? 0), 0);
              const sharedBytes = node.media
                .filter((media) => media.relation === "shared")
                .reduce((total, media) => total + (media.sizeBytes ?? 0), 0);

              return (
                <label
                  key={node.nodeId}
                  style={{ marginLeft: depth * 12 }}
                  className={`group flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-colors ${
                    isSelected
                      ? "border-accent bg-accent/10"
                      : "border-border bg-bg-1 hover:border-fg-muted/40 hover:bg-bg-2/60"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-border accent-accent"
                    aria-label={t("Select node {{v0}}", { v0: node.name })}
                    checked={isSelected}
                    disabled={busy}
                    onChange={(event) =>
                      setNodeIds((ids) =>
                        event.target.checked
                          ? [...ids, node.nodeId]
                          : ids.filter((id) => id !== node.nodeId),
                      )
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-fg">
                        {node.name}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {node.deletedAt !== undefined ? (
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">{t("review.trash")}</span>
                        ) : null}
                        <span className="rounded bg-bg-3 px-1.5 py-0.5 text-[10px] text-fg-muted">
                          {parentName ? t("Based on {{v0}}", { v0: parentName }) : t("Initial snapshot")}
                        </span>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-2">
                      <span>{t("Media items: {{v0}}", { v0: node.media.length })}</span>
                      <span>·</span>
                      <span
                        className={
                          exclusiveBytes > 0
                            ? "font-medium text-accent"
                            : "text-fg-muted"
                        }
                      >{t("Exclusive to this snapshot: {{v0}}", { v0: bytes(exclusiveBytes) })}</span>
                      <span>·</span>
                      <span className="text-fg-muted">{t("Shared: {{v0}}", { v0: bytes(sharedBytes) })}</span>
                    </div>
                  </div>
                </label>
              );
            })}

            {review && review.nodes.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-bg-1/40 p-8 text-center">
                <Archive size={24} className="text-fg-muted" aria-hidden />
                <p className="mt-2 text-sm text-fg-2">{t("No project snapshots yet. You can remove cache on the right; current edits and recovery data are preserved.")}</p>
              </div>
            ) : null}

            {review?.unknowns.length ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
                <h3 className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle size={13} aria-hidden />
                  {t("Retain and review further")}</h3>
                <ul className="mt-1.5 list-inside list-disc space-y-1">
                  {review.unknowns.map((unknown) => (
                    <li key={unknown}><LocalizedMessage>{unknown}</LocalizedMessage></li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>

        {/* Right Panel: Space Cleanup & Execution */}
        <div className="flex min-h-0 flex-col overflow-y-auto p-6">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles size={15} className="text-accent" aria-hidden />
              <h2 className="text-sm font-semibold">{t("Space cleanup and actions")}</h2>
            </div>
          </div>
          <p className="mt-1 text-xs text-fg-muted">{t("Choose an action and select Preview cleanup. Exact candidates are listed before you confirm deletion.")}</p>

          {/* 4 Visual Quick-Select Cards */}
          <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {spaceCleanupCards.map((card) => {
              const active = action === card.action;
              return (
                <button
                  key={card.action}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setAction(card.action);
                    setPlan(null);
                  }}
                  className={`flex flex-col items-start rounded-lg border p-3.5 text-left transition-colors ${
                    active
                      ? "border-accent bg-accent/10"
                      : "border-border bg-bg-1 hover:border-fg-muted/40 hover:bg-bg-2/60"
                  }`}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-fg">
                      {card.title}
                    </span>
                    <span
                      className={`h-2 w-2 rounded-full ${
                        active ? "bg-accent" : "bg-border"
                      }`}
                    />
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-fg-muted">
                    {card.desc}
                  </p>
                </button>
              );
            })}
          </div>

          {/* Action Selector + Preview Trigger Bar */}
          <div className="mt-4 flex flex-col gap-3 rounded-lg border border-border bg-bg-1 p-4 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1 text-xs font-medium text-fg-2">
              {t("Cleanup action")}<select
                className="mt-1.5 block w-full rounded-md border border-border bg-bg-2 px-3 py-2 text-xs text-fg focus:border-accent focus:outline-none"
                value={action}
                disabled={busy}
                onChange={(event) => {
                  setAction(event.target.value as Action);
                  setPlan(null);
                }}
              >
                {Object.entries(actionLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={`${btnPrimary} h-[34px] shrink-0`}
              disabled={busy || !review}
              onClick={() => runPreview(action)}
            >
              {busy ? t("audioEnvironment.checking") : t("Preview cleanup")}
            </button>
          </div>

          {/* Confirmation Step Card */}
          {plan ? (
            <div
              className="mt-4 rounded-lg border border-accent bg-bg-1 p-4 shadow-lg"
              data-testid="cleanup-confirmation"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                <div>
                  <h3 className="text-sm font-semibold text-fg">{t("Confirm cleanup candidates")}</h3>
                  <p className="mt-0.5 text-xs text-fg-2">
                    {actionLabels[plan.action]}
                  </p>
                </div>
                <span className="rounded-md bg-accent/15 px-2.5 py-1 text-xs font-semibold text-accent">{t("Estimated space to free: {{v0}}", { v0: bytes(plan.reclaimableBytes) })}</span>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-xs text-fg-muted">
                <span className="rounded bg-bg-2 px-2 py-1">{t("Snapshot nodes: {{v0}}", { v0: plan.selection.nodeIds.length })}</span>
                <span className="rounded bg-bg-2 px-2 py-1">{t("Media items: {{v0}}", { v0: plan.selection.mediaIds.length })}</span>
                <span className="rounded bg-bg-2 px-2 py-1">{t("Cache entries: {{v0}}", { v0: plan.selection.cacheKeys.length })}</span>
                <span className="rounded bg-bg-2 px-2 py-1">{t("Failed jobs: {{v0}}", { v0: plan.selection.jobIds.length })}</span>
                <span className="rounded bg-bg-2 px-2 py-1">{t("Intermediate files: {{v0}}", { v0: plan.candidateWorkFiles.length })}</span>
              </div>

              {plan.selection.nodeIds.length > 0 ? (
                <ul className="my-3 list-inside list-disc text-xs text-fg-2">
                  {plan.selection.nodeIds.map((id) => (
                    <li key={id}>
                      {review?.nodes.find((node) => node.nodeId === id)?.name ??
                        id}
                    </li>
                  ))}
                </ul>
              ) : null}

              {(plan.candidateWorkFiles.length > 0 ||
                plan.candidateMedia.length > 0 ||
                plan.candidateCache.length > 0 ||
                plan.candidateJobs.length > 0) && (
                <div className="my-3 max-h-56 space-y-2 overflow-y-auto rounded-md border border-border bg-bg p-2.5 text-xs">
                  {plan.candidateWorkFiles.map((file) => (
                    <div
                      key={`${file.jobId}:${file.fileId}`}
                      className="break-all rounded border border-border bg-bg-1 p-2"
                    >
                      <p className="font-medium text-fg">
                        {file.purpose} · {bytes(file.sizeBytes)}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-fg-muted">
                        {file.path}
                      </p>
                    </div>
                  ))}
                  {plan.candidateMedia.map((media) => (
                    <div
                      key={media.mediaId}
                      className="rounded border border-border bg-bg-1 p-2"
                    >
                      <p className="font-medium text-fg">{t("Media {{v0}} · {{v1}}", { v0: media.mediaId, v1: bytes(media.sizeBytes) })}</p>
                      {media.files.map((file) => (
                        <p
                          key={file.path}
                          className="mt-0.5 break-all font-mono text-[11px] text-fg-muted"
                        >
                          {file.path} · {bytes(file.sizeBytes)}
                        </p>
                      ))}
                    </div>
                  ))}
                  {plan.candidateCache.map((cache) => (
                    <p
                      key={cache.key}
                      className="break-all rounded border border-border bg-bg-1 p-2"
                    >{t("Rebuildable frame cache · {{v0}} · {{v1}}", { v0: cache.key, v1: bytes(cache.sizeBytes) })}</p>
                  ))}
                  {plan.candidateJobs.map((job) => (
                    <div
                      className="rounded border border-border bg-bg-1 p-2"
                      key={job.jobId}
                    >
                      <p className="font-medium text-fg">{t("Failed job {{v0}} · {{v1}}", { v0: job.jobId, v1: bytes(job.reclaimableBytes) })}</p>
                      {job.files.map((file) => (
                        <p
                          key={file.path}
                          className="mt-0.5 break-all font-mono text-[11px] text-fg-muted"
                        >
                          {file.path} · {bytes(file.sizeBytes)}
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {plan.blockers.length > 0 ? (
                <ul
                  role="alert"
                  className="my-3 space-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-300"
                >
                  {plan.blockers.map((blocker) => (
                    <li key={blocker}><LocalizedMessage>{blocker}</LocalizedMessage></li>
                  ))}
                </ul>
              ) : null}

              {!hasPlanChanges && (
                <p
                  role="status"
                  className="my-3 rounded-md border border-border bg-bg-2 px-3 py-2.5 text-xs text-fg-2"
                >{t("Nothing to remove. Files still in use or of uncertain purpose are retained.")}</p>
              )}

              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  className={btnSecondary}
                  disabled={busy}
                  onClick={() => setPlan(null)}
                >{t("review.cancel")}</button>
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-md border border-red-500/60 bg-red-500/15 px-4 py-1.5 text-xs font-semibold text-red-300 transition-colors hover:bg-red-500/25 disabled:opacity-40"
                  disabled={busy || plan.status !== "ready" || !hasPlanChanges}
                  onClick={() =>
                    void perform(async () => {
                      const outcome = await executeCleanupPlan({
                        ...plan.confirmation,
                        confirmed: true,
                      });
                      setResult(outcome);
                      setPlan(null);
                      await refresh();
                    })
                  }
                >
                  {busy ? t("Executing…") : t("Confirm execution")}
                </button>
              </div>
            </div>
          ) : null}

          {/* Execution Result Card */}
          {result ? (
            <div
              className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4"
              role="status"
            >
              <div className="flex items-center gap-2">
                <CheckCircle2 size={16} className="text-emerald-400" aria-hidden />
                <h3 className="text-sm font-semibold text-fg">{t("Cleanup results")}</h3>
              </div>
              <p className="mt-1.5 text-xs text-fg-2">{t("Freed {{bytes}} · Removed media: {{media}} / nodes: {{nodes}} · Updated nodes: {{updated}} · Removed cache: {{cache}} / failed jobs: {{jobs}} / intermediate files: {{files}}", { bytes: bytes(result.reclaimedBytes), media: result.deletedMediaIds.length, nodes: result.deletedNodeIds.length, updated: result.updatedNodeIds.length, cache: result.deletedCacheKeys.length, jobs: result.deletedJobIds.length, files: result.deletedWorkFiles?.length ?? 0 })}</p>
              {result.reason ? (
                <p className="mt-2 text-xs text-amber-400">{t("Review again: {{v0}}", { v0: result.reason })}</p>
              ) : null}
              <ul className="mt-2.5 space-y-1 break-all text-xs text-fg-muted">
                {result.deletedWorkFiles?.map((file) => (
                  <li key={`${file.jobId}:${file.fileId}`}>{t("Removed {{v0}} · {{v1}}", { v0: file.path, v1: bytes(file.sizeBytes) })}</li>
                ))}
                {result.skipped.map((item) => (
                  <li key={`${item.kind}:${item.id}`}>{t("Skipped {{v0}}: {{v1}}", { v0: item.id, v1: item.reason })}</li>
                ))}
                {result.failed.map((item) => (
                  <li key={`${item.kind}:${item.id}`} className="text-red-400">{t("Failed {{v0}}: {{v1}}", { v0: item.id, v1: item.reason })}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {message ? (
            <p
              role="status"
              className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
            >
              <LocalizedMessage>{message}</LocalizedMessage>
            </p>
          ) : null}

          {/* Advanced Sections */}
          <div className="mt-6 space-y-2.5 border-t border-border pt-4">
            <details
              className="rounded-lg border border-border bg-bg-1 p-3 text-xs"
              open={action === "purge-work-files" || undefined}
            >
              <summary className="cursor-pointer font-medium text-fg-2 hover:text-fg">{t("Temporary files and unadopted results (advanced)")}</summary>
              <p className="mt-2 text-fg-muted">{t("Select unwanted generation attempts or intermediate files, choose Remove temporary and unadopted files, and preview. Adopted media and delivered videos are retained.")}</p>
              <div className="mt-2.5 space-y-2">
                {review?.workFiles.files.map((file) => (
                  <label
                    key={`${file.jobId}:${file.fileId}`}
                    className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-bg p-2.5 hover:border-fg-muted/40"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-3.5 w-3.5 accent-accent"
                      aria-label={t("Select intermediate file {{v0}}", { v0: file.selectionId })}
                      disabled={busy || !!file.retainedReason}
                      checked={workFileIds.includes(file.selectionId)}
                      onChange={(event) => {
                        setWorkFileIds((current) =>
                          event.target.checked
                            ? [...current, file.selectionId]
                            : current.filter((id) => id !== file.selectionId),
                        );
                        setAction("purge-work-files");
                        setPlan(null);
                      }}
                    />
                    <span className="min-w-0 flex-1 break-all">
                      <span className="font-medium text-fg">
                        {file.purpose} · {bytes(file.sizeBytes)}
                      </span>
                      <span className="mt-0.5 block font-mono text-[11px] text-fg-muted">
                        {file.path}
                      </span>
                      <span className="mt-1 block text-[11px] text-fg-muted">
                        {file.retainedReason ?? t("No references found; eligible for selection")}
                      </span>
                    </span>
                  </label>
                ))}
                {!review?.workFiles.files.length ? (
                  <p className="text-fg-muted">{t("This project has no temporary intermediate files to remove.")}</p>
                ) : null}
              </div>
            </details>

            <details
              className="rounded-lg border border-border bg-bg-1 p-3 text-xs"
              open={action === "purge-failed-jobs" || undefined}
            >
              <summary className="cursor-pointer font-medium text-fg-2 hover:text-fg">{t("Review unadopted attempts and failed jobs")}</summary>
              <p className="mt-2 text-fg-muted">{t("Only failed or cancelled task snapshot records are removed. Saved media and output files are preserved.")}</p>
              {review?.failedJobs.tasks.map((task) => (
                <div
                  key={task.jobId}
                  className="mt-2 rounded border border-border bg-bg p-2"
                >
                  <p className="break-all font-medium text-fg">
                    {task.kind} · {task.state} · {task.jobId}
                  </p>
                  <p className="mt-1 text-fg-muted"><LocalizedMessage>{task.retainedReason}</LocalizedMessage></p>
                  {task.files.map((file) => (
                    <p
                      className="mt-1 break-all font-mono text-[11px] text-fg-muted"
                      key={file.path}
                    >
                      {file.path} · {bytes(file.sizeBytes)}
                    </p>
                  ))}
                </div>
              ))}
              {!review?.failedJobs.tasks.length ? (
                <p className="mt-2 text-fg-muted">{t("No failed or cancelled job records.")}</p>
              ) : null}
            </details>

            <details className="rounded-lg border border-border bg-bg-1 p-3 text-xs">
              <summary className="cursor-pointer font-medium text-fg-2 hover:text-fg">{t("Ask an Agent to review (optional)")}</summary>
              <p className="mt-2 text-fg-muted">{t("If you are unsure which files can be removed, publish a review task or copy the prompt for an Agent. This does not authorize deletion.")}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={btnSecondary}
                  disabled={busy || !review}
                  onClick={() =>
                    void perform(async () => {
                      if (!target) return;
                      const { store } =
                        await workspaceManager.getWorkspaceContext(target);
                      await publishCleanupReview(handoff(), cleanupNodeIds, {
                        store,
                      });
                      setMessage(
                        translate("Cleanup review published to the requirements board; deletion is not authorized."),
                      );
                    })
                  }
                >
                  <Bot size={13} aria-hidden />
                  {t("Publish cleanup review to the board")}</button>
                <button
                  type="button"
                  className={btnSecondary}
                  disabled={busy || !review}
                  onClick={() =>
                    void perform(async () => {
                      await navigator.clipboard.writeText(
                        buildCleanupAgentPrompt(handoff(), cleanupNodeIds),
                      );
                      setMessage(translate("Review prompt copied."));
                    })
                  }
                >{t("Copy prompt for Agent")}</button>
              </div>
            </details>
          </div>
        </div>
      </div>
    </section>
  );
}
