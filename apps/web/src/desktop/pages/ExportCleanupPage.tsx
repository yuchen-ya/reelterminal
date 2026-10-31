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
  "purge-media": "清理不再使用的应用内素材",
  "recycle-nodes": "将所选存档移入回收站",
  "restore-nodes": "恢复所选存档",
  "purge-deleted-nodes": "永久删除回收站中的所选存档",
  "purge-cache": "清理可重建缓存",
  "purge-failed-jobs": "清理失败任务记录",
  "purge-work-files": "清理选中的临时文件与未采用结果",
};

const spaceCleanupCards: Array<{
  action: Action;
  title: string;
  desc: string;
  needsNodes?: boolean;
}> = [
  {
    action: "purge-media",
    title: "清理未使用素材",
    desc: "清理不再被当前工程或保留存档引用的应用内素材",
    needsNodes: true,
  },
  {
    action: "purge-cache",
    title: "清理可重建缓存",
    desc: "释放帧缓存与代理文件（不影响工程，按需自动重建）",
  },
  {
    action: "purge-work-files",
    title: "清理临时与未采用文件",
    desc: "清理生成尝试残留的过程文件（需在下方勾选具体文件）",
  },
  {
    action: "purge-failed-jobs",
    title: "清理失败任务记录",
    desc: "移除已失败或已取消作业的快照记录",
  },
];

export function ExportCleanupPage(): JSX.Element {
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
        ? (byId.get(node.parentNodeIds[0])?.name ?? "早期版本")
        : null,
    }));
  }, [review]);

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
    if (!target || !review) throw new Error("请先完成引用审查");
    const effectiveNodes =
      overrideAction === "purge-cache" ||
      overrideAction === "purge-failed-jobs" ||
      overrideAction === "purge-work-files"
        ? []
        : nodeIds;
    return {
      ...target,
      revision: session?.target.revision ?? review.revision,
      scope: `${actionLabels[overrideAction]}；选中节点 ${effectiveNodes.length} 个${overrideAction === "purge-work-files" ? `；选中过程文件 ${workFileIds.join(", ")}` : ""}。另审查未采用生成尝试和失败作业残留，无法确认用途的文件保留。`,
      retention:
        "保留原件、成片、审阅工作台、模板、素材库、草稿/恢复、撤销/重做、后继节点和活动作业输入；导出完成不授权删除源素材。",
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
              <h1 className="text-base font-semibold tracking-tight">
                导出与整理
              </h1>
              <p className="text-xs text-fg-muted">
                管理已导出的视频成片、历史版本存档，或安全释放项目空间（原始素材与已导出成片始终保留）
              </p>
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
              刷新检查
            </button>
            <button
              type="button"
              className={btnSecondary}
              onClick={() => useUIStore.getState().setDesktopPage("edit")}
            >
              <ArrowLeft size={13} aria-hidden />
              返回编辑
            </button>
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
                      {session.state.complete ? "导出完成" : session.state.phase}
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
                  aria-label="导出进度"
                />
                {session.state.error ? (
                  <p role="alert" className="mt-1.5 text-xs text-red-400">
                    {session.state.error}
                  </p>
                ) : null}
                {session.state.isExporting ? (
                  <div className="mt-2 flex items-center justify-between text-xs text-fg-muted">
                    <span>导出进行中，返回编辑不会影响当前导出任务。</span>
                    <button
                      type="button"
                      className="text-red-400 hover:underline"
                      onClick={() => cancelExport?.()}
                    >
                      取消导出
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {deliveredOutputs.length > 0 ? (
              <div className={session ? "mt-3 border-t border-border pt-3" : ""}>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                    <Film size={13} className="text-accent" aria-hidden />
                    已导出成片（{deliveredOutputs.length}）
                  </h2>
                  <span className="text-[11px] text-fg-muted">
                    空间清理不会删除已导出的成片视频
                  </span>
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
                          {output.outputPath ?? "已交给浏览器下载"}
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
                          在文件夹中显示
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {pendingOutputs.length > 0 ? (
              <details className="mt-2.5 text-xs text-fg-muted">
                <summary className="cursor-pointer hover:text-fg">
                  未完成的导出尝试（{pendingOutputs.length}）
                </summary>
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
                <h2 className="text-sm font-semibold">历史版本存档</h2>
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
                  >
                    全选
                  </button>
                  <span className="text-border">|</span>
                  <button
                    type="button"
                    className="text-fg-2 hover:text-fg hover:underline"
                    disabled={busy || nodeIds.length === 0}
                    onClick={() => setNodeIds([])}
                  >
                    清空
                  </button>
                </div>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-fg-muted">
              勾选需要整理的存档版本；仍被当前编辑或其他保留版本使用的素材会自动保护。
            </p>

            {/* Quick Contextual Action Bar when nodes are selected */}
            {nodeIds.length > 0 ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-xs">
                <span className="font-medium text-fg">
                  已选 {nodeIds.length} 个存档
                  {review
                    ? ` · 独立占用 ${bytes(review.selected.reclaimableBytes)}`
                    : ""}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    className={btnSecondary}
                    disabled={busy}
                    onClick={() => runPreview("recycle-nodes")}
                  >
                    <Trash2 size={12} aria-hidden />
                    移入回收站
                  </button>
                  <button
                    type="button"
                    className={btnSecondary}
                    disabled={busy}
                    onClick={() => runPreview("restore-nodes")}
                  >
                    <RotateCcw size={12} aria-hidden />
                    恢复存档
                  </button>
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
                    aria-label={`选择节点 ${node.name}`}
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
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                            回收站
                          </span>
                        ) : null}
                        <span className="rounded bg-bg-3 px-1.5 py-0.5 text-[10px] text-fg-muted">
                          {parentName ? `源于 ${parentName}` : "初始存档"}
                        </span>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-2">
                      <span>包含 {node.media.length} 个素材</span>
                      <span>·</span>
                      <span
                        className={
                          exclusiveBytes > 0
                            ? "font-medium text-accent"
                            : "text-fg-muted"
                        }
                      >
                        仅该存档占用 {bytes(exclusiveBytes)}
                      </span>
                      <span>·</span>
                      <span className="text-fg-muted">
                        共享 {bytes(sharedBytes)}
                      </span>
                    </div>
                  </div>
                </label>
              );
            })}

            {review && review.nodes.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-bg-1/40 p-8 text-center">
                <Archive size={24} className="text-fg-muted" aria-hidden />
                <p className="mt-2 text-sm text-fg-2">
                  还没有项目存档。可以先在右侧清理缓存；当前编辑和自动恢复数据会保留。
                </p>
              </div>
            ) : null}

            {review?.unknowns.length ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
                <h3 className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle size={13} aria-hidden />
                  需保留并继续审查
                </h3>
                <ul className="mt-1.5 list-inside list-disc space-y-1">
                  {review.unknowns.map((unknown) => (
                    <li key={unknown}>{unknown}</li>
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
              <h2 className="text-sm font-semibold">空间清理与操作</h2>
            </div>
          </div>
          <p className="mt-1 text-xs text-fg-muted">
            选择下方清理类型并点击「预览清理内容」，系统会先列出待清理清单，经你确认后才会真正删除。
          </p>

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
              整理动作
              <select
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
              {busy ? "正在检查…" : "预览清理内容"}
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
                  <h3 className="text-sm font-semibold text-fg">
                    确认清理清单
                  </h3>
                  <p className="mt-0.5 text-xs text-fg-2">
                    {actionLabels[plan.action]}
                  </p>
                </div>
                <span className="rounded-md bg-accent/15 px-2.5 py-1 text-xs font-semibold text-accent">
                  预计释放 {bytes(plan.reclaimableBytes)}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-xs text-fg-muted">
                <span className="rounded bg-bg-2 px-2 py-1">
                  {plan.selection.nodeIds.length} 个存档节点
                </span>
                <span className="rounded bg-bg-2 px-2 py-1">
                  {plan.selection.mediaIds.length} 个素材
                </span>
                <span className="rounded bg-bg-2 px-2 py-1">
                  {plan.selection.cacheKeys.length} 项缓存
                </span>
                <span className="rounded bg-bg-2 px-2 py-1">
                  {plan.selection.jobIds.length} 个失败作业
                </span>
                <span className="rounded bg-bg-2 px-2 py-1">
                  {plan.candidateWorkFiles.length} 个过程文件
                </span>
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
                      <p className="font-medium text-fg">
                        素材 {media.mediaId} · {bytes(media.sizeBytes)}
                      </p>
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
                    >
                      可重建帧缓存 · {cache.key} · {bytes(cache.sizeBytes)}
                    </p>
                  ))}
                  {plan.candidateJobs.map((job) => (
                    <div
                      className="rounded border border-border bg-bg-1 p-2"
                      key={job.jobId}
                    >
                      <p className="font-medium text-fg">
                        失败作业 {job.jobId} · {bytes(job.reclaimableBytes)}
                      </p>
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
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              ) : null}

              {!hasPlanChanges && (
                <p
                  role="status"
                  className="my-3 rounded-md border border-border bg-bg-2 px-3 py-2.5 text-xs text-fg-2"
                >
                  没有可清理的内容，无需执行。仍在使用或无法确认用途的文件已保留。
                </p>
              )}

              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  className={btnSecondary}
                  disabled={busy}
                  onClick={() => setPlan(null)}
                >
                  取消
                </button>
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
                  {busy ? "正在执行…" : "确认执行"}
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
                <h3 className="text-sm font-semibold text-fg">整理结果</h3>
              </div>
              <p className="mt-1.5 text-xs text-fg-2">
                实际释放 {bytes(result.reclaimedBytes)} · 删除{" "}
                {result.deletedMediaIds.length} 个素材 /{" "}
                {result.deletedNodeIds.length} 个节点 · 更新{" "}
                {result.updatedNodeIds.length} 个节点 · 清理{" "}
                {result.deletedCacheKeys.length} 项缓存 /{" "}
                {result.deletedJobIds.length} 个失败作业 /{" "}
                {result.deletedWorkFiles?.length ?? 0} 个过程文件
              </p>
              {result.reason ? (
                <p className="mt-2 text-xs text-amber-400">
                  需重新审查：{result.reason}
                </p>
              ) : null}
              <ul className="mt-2.5 space-y-1 break-all text-xs text-fg-muted">
                {result.deletedWorkFiles?.map((file) => (
                  <li key={`${file.jobId}:${file.fileId}`}>
                    已删除 {file.path} · {bytes(file.sizeBytes)}
                  </li>
                ))}
                {result.skipped.map((item) => (
                  <li key={`${item.kind}:${item.id}`}>
                    已跳过 {item.id}：{item.reason}
                  </li>
                ))}
                {result.failed.map((item) => (
                  <li key={`${item.kind}:${item.id}`} className="text-red-400">
                    失败 {item.id}：{item.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {message ? (
            <p
              role="status"
              className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
            >
              {message}
            </p>
          ) : null}

          {/* Advanced Sections */}
          <div className="mt-6 space-y-2.5 border-t border-border pt-4">
            <details
              className="rounded-lg border border-border bg-bg-1 p-3 text-xs"
              open={action === "purge-work-files" || undefined}
            >
              <summary className="cursor-pointer font-medium text-fg-2 hover:text-fg">
                临时文件与未采用结果（高级）
              </summary>
              <p className="mt-2 text-fg-muted">
                勾选不再需要的生成尝试或中间文件后，选择「清理临时与未采用文件」并预览。已采用素材与成片会自动保留。
              </p>
              <div className="mt-2.5 space-y-2">
                {review?.workFiles.files.map((file) => (
                  <label
                    key={`${file.jobId}:${file.fileId}`}
                    className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-bg p-2.5 hover:border-fg-muted/40"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-3.5 w-3.5 accent-accent"
                      aria-label={`选择过程文件 ${file.selectionId}`}
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
                        {file.retainedReason ?? "未发现引用，可勾选清理"}
                      </span>
                    </span>
                  </label>
                ))}
                {!review?.workFiles.files.length ? (
                  <p className="text-fg-muted">
                    当前工程没有待清理的临时过程文件。
                  </p>
                ) : null}
              </div>
            </details>

            <details
              className="rounded-lg border border-border bg-bg-1 p-3 text-xs"
              open={action === "purge-failed-jobs" || undefined}
            >
              <summary className="cursor-pointer font-medium text-fg-2 hover:text-fg">
                审查未采用生成尝试与失败作业
              </summary>
              <p className="mt-2 text-fg-muted">
                仅移除已失败或已取消的任务快照记录，正式素材与输出文件不受影响。
              </p>
              {review?.failedJobs.tasks.map((task) => (
                <div
                  key={task.jobId}
                  className="mt-2 rounded border border-border bg-bg p-2"
                >
                  <p className="break-all font-medium text-fg">
                    {task.kind} · {task.state} · {task.jobId}
                  </p>
                  <p className="mt-1 text-fg-muted">{task.retainedReason}</p>
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
                <p className="mt-2 text-fg-muted">当前没有失败或取消的作业记录。</p>
              ) : null}
            </details>

            <details className="rounded-lg border border-border bg-bg-1 p-3 text-xs">
              <summary className="cursor-pointer font-medium text-fg-2 hover:text-fg">
                交给 Agent 协助检查（可选）
              </summary>
              <p className="mt-2 text-fg-muted">
                如果不确定哪些历史尝试文件可以安全清理，可发布检查任务或复制提示词交给 Agent 协助梳理（不会直接授权删除）。
              </p>
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
                        "清理审查任务已发布到需求看板；尚未授权删除。",
                      );
                    })
                  }
                >
                  <Bot size={13} aria-hidden />
                  发布清理任务到看板
                </button>
                <button
                  type="button"
                  className={btnSecondary}
                  disabled={busy || !review}
                  onClick={() =>
                    void perform(async () => {
                      await navigator.clipboard.writeText(
                        buildCleanupAgentPrompt(handoff(), cleanupNodeIds),
                      );
                      setMessage("已复制审查提示词。");
                    })
                  }
                >
                  复制提示词给 Agent
                </button>
              </div>
            </details>
          </div>
        </div>
      </div>
    </section>
  );
}
