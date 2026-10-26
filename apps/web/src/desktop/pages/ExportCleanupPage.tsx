import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
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

const button =
  "rounded-md border border-border bg-bg-2 px-3 py-2 text-sm text-fg hover:bg-bg-3 disabled:opacity-40";
const actionLabels: Record<string, string> = {
  "purge-media": "清理无引用受管素材",
  "recycle-nodes": "将选中节点移到回收站",
  "restore-nodes": "恢复选中节点",
  "purge-deleted-nodes": "永久清除已删除节点及独占素材",
  "purge-cache": "清理可重建缓存",
  "purge-failed-jobs": "清理失败作业记录与输入快照",
  "purge-work-files": "清理选中的过程文件 / 未采用尝试",
};

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
  const cleanupNodeIds =
    action === "purge-cache" || action === "purge-failed-jobs" || action === "purge-work-files" ? [] : nodeIds;
  const graph = useMemo(() => {
    const nodes = [...(review?.nodes ?? [])].sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        left.nodeId.localeCompare(right.nodeId),
    );
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const depths = new Map<string, number>();
    const depth = (id: string): number => {
      if (depths.has(id)) return depths.get(id)!;
      const parent = byId
        .get(id)
        ?.parentNodeIds.find((parentId) => byId.has(parentId));
      const value = parent ? depth(parent) + 1 : 0;
      depths.set(id, value);
      return value;
    };
    return nodes.map((node, index) => ({
      node,
      x: Math.min(depth(node.nodeId), 6) * 18 + 8,
      y: index * 124 + 56,
    }));
  }, [review]);

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
      // This ref is a request serial, not a DOM ref: invalidate pending scans.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      request.current++;
    };
  }, [refresh]);

  const handoff = () => {
    if (!target || !review) throw new Error("请先完成引用审查");
    return {
      ...target,
      revision: session?.target.revision ?? review.revision,
      scope: `${actionLabels[action]}；选中节点 ${cleanupNodeIds.length} 个${action === "purge-work-files" ? `；选中过程文件 ${workFileIds.join(", ")}` : ""}。另审查未采用生成尝试和失败作业残留，无法确认用途的文件保留。`,
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

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-bg text-fg"
      data-testid="export-cleanup-page"
    >
      <header className="shrink-0 border-b border-border bg-bg-1 px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">导出与整理</h1>
            <p className="mt-1 text-xs text-fg-muted">
              先审查引用，再确认具体计划。成片与源素材分别保留。
            </p>
          </div>
          <button
            className={button}
            onClick={() => useUIStore.getState().setDesktopPage("edit")}
          >
            返回编辑
          </button>
        </div>
        {session ? (
          <div className="mt-4" data-testid="export-fixed-progress">
            <div className="flex justify-between text-sm">
              <span>
                {session.projectName} ·{" "}
                {session.state.complete ? "导出完成" : session.state.phase}
              </span>
              <span>{Math.round(session.state.progress)}%</span>
            </div>
            <progress
              className="mt-2 h-2 w-full accent-accent"
              max={100}
              value={session.state.progress}
              aria-label="导出进度"
            />
            {session.state.error ? (
              <p role="alert" className="text-sm text-red-400">
                {session.state.error}
              </p>
            ) : null}
            {session.state.isExporting ? (
              <div className="mt-2 flex justify-between text-xs text-fg-muted">
                <span>导出输入已保护，返回编辑不影响当前导出。</span>
                <button className="underline" onClick={() => cancelExport?.()}>
                  取消导出
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {target ? (
          <p className="mt-3 break-all font-mono text-[11px] text-fg-muted">
            工程 {target.projectId} · 工作区 {target.workspaceId}
            {target.exportId ? ` · 导出 ${target.exportId}` : " · 未绑定导出"}
          </p>
        ) : null}
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(300px,1fr)_minmax(360px,1fr)]">
        <div className="overflow-auto border-r border-border p-6">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">工程节点图</h2>
            <button
              className={button}
              disabled={busy || !target}
              onClick={() => void refresh()}
            >
              重新审查
            </button>
          </div>
          <p className="my-3 text-xs text-fg-muted">
            多选按联合引用计算。回收站节点仍保留素材，只有永久清除计划才计算释放。
          </p>
          <div className="relative" data-testid="cleanup-node-graph">
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full overflow-visible text-fg-muted"
              aria-hidden="true"
            >
              {graph.flatMap(({ node, x, y }) =>
                node.parentNodeIds.flatMap((id) => {
                  const parent = graph.find(
                    (entry) => entry.node.nodeId === id,
                  );
                  return parent
                    ? [
                        <path
                          key={`${id}:${node.nodeId}`}
                          d={`M ${parent.x} ${parent.y} V ${y} H ${x + 10}`}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={1.5}
                        />,
                      ]
                    : [];
                }),
              )}
            </svg>
            {graph.map(({ node, x }) => (
              <label
                key={node.nodeId}
                style={{ marginLeft: x + 10, marginBottom: 12 }}
                className={`relative block h-28 overflow-auto rounded-lg border p-3 ${nodeIds.includes(node.nodeId) ? "border-accent bg-bg-2" : "border-border bg-bg-1"}`}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={`选择节点 ${node.name}`}
                    checked={nodeIds.includes(node.nodeId)}
                    disabled={busy}
                    onChange={(event) =>
                      setNodeIds((ids) =>
                        event.target.checked
                          ? [...ids, node.nodeId]
                          : ids.filter((id) => id !== node.nodeId),
                      )
                    }
                  />
                  <span className="text-sm font-medium">{node.name}</span>
                  {node.deletedAt !== undefined ? (
                    <span className="text-xs text-fg-muted">回收站</span>
                  ) : null}
                </div>
                <p
                  className="mt-2 truncate text-[11px] text-fg-muted"
                  title={node.nodeId}
                >
                  {node.parentNodeIds.length
                    ? `来自 ${review?.nodes.find((parent) => parent.nodeId === node.parentNodeIds[0])?.name ?? "已清除的父节点"}`
                    : "根节点"}{" "}
                  · {node.nodeId}
                </p>
                <p className="mt-2 text-xs text-fg-2">
                  {node.media.length} 个素材 · 独占{" "}
                  {bytes(
                    node.media
                      .filter((media) => media.relation === "exclusive")
                      .reduce(
                        (total, media) => total + (media.sizeBytes ?? 0),
                        0,
                      ),
                  )}{" "}
                  · 共享{" "}
                  {bytes(
                    node.media
                      .filter((media) => media.relation === "shared")
                      .reduce(
                        (total, media) => total + (media.sizeBytes ?? 0),
                        0,
                      ),
                  )}
                </p>
              </label>
            ))}
            {review && review.nodes.length === 0 ? (
              <p className="rounded-lg border border-border p-5 text-sm text-fg-muted">
                尚无保存节点。当前工作区、历史和恢复草稿依然受保护。
              </p>
            ) : null}
          </div>
          {review ? (
            <div className="mt-4 rounded-lg border border-border bg-bg-1 p-4 text-sm">
              <strong>已选 {nodeIds.length} 个节点</strong>
              <p className="mt-1">
                联合独占素材 {bytes(review.selected.reclaimableBytes)}
              </p>
              <p className="mt-1 text-xs text-fg-muted">
                全局保留引用 {review.retainedSummary.references.length} 项。最终可释放量以计划检查为准。
              </p>
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer">
                  其他工程 / 模板 / 素材库 / 历史保留摘要
                </summary>
                <ul className="mt-2 space-y-1">
                  {[
                    ...new Set(
                      review.retainedSummary.references.map(
                        (reference) =>
                          `${reference.kind} · ${reference.label ?? reference.referenceId} · ${reference.projectId}`,
                      ),
                    ),
                  ].map((reference) => (
                    <li className="break-all" key={reference}>
                      {reference}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          ) : null}
          {review?.unknowns.length ? (
            <div className="mt-4 text-xs text-amber-400">
              <h3 className="font-medium">需保留并继续审查</h3>
              <ul className="mt-2 list-inside list-disc">
                {review.unknowns.map((unknown) => (
                  <li key={unknown}>{unknown}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <div className="overflow-auto p-6">
          <h2 className="font-semibold">现在整理</h2>
          <label className="mt-3 block text-xs text-fg-muted">
            整理动作
            <select
              className="mt-2 block w-full rounded-md border border-border bg-bg-1 p-2 text-sm text-fg"
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
            className={`${button} mt-3 w-full`}
            disabled={busy || !review}
            onClick={() =>
              void perform(async () => {
                if (!target) return;
                const description = handoff();
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
                        JSON.stringify([...cleanupNodeIds].sort())
                    );
                  });
                const planTarget = requirement
                  ? { ...target, cleanupTaskId: requirement.id }
                  : target;
                if (requirement?.cleanupHandoff) {
                  if (requirement.cleanupHandoff.phase === "pending_review")
                    await advanceCleanupReviewPhase(
                      description,
                      cleanupNodeIds,
                      "reviewing",
                      { store },
                    );
                  const scanned = await getCleanupReview(
                    planTarget,
                    cleanupNodeIds,
                  );
                  if (
                    scanned.scanReady &&
                    (requirement.cleanupHandoff.phase === "pending_review" ||
                      requirement.cleanupHandoff.phase === "reviewing")
                  ) {
                    await advanceCleanupReviewPhase(
                      description,
                      cleanupNodeIds,
                      "awaiting_confirmation",
                      { store },
                    );
                  }
                }
                setResult(null);
                setPlan(
                  await createCleanupPlan(planTarget, action, {
                    nodeIds: cleanupNodeIds,
                    ...(action === "purge-work-files" ? { workFileIds } : {}),
                  }),
                );
              })
            }
          >
            现在整理 · 生成审查计划
          </button>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              className={button}
              disabled={busy || !review}
              onClick={() =>
                void perform(async () => {
                  if (!target) return;
                  const { store } = await workspaceManager.getWorkspaceContext(target);
                  await publishCleanupReview(handoff(), cleanupNodeIds, { store });
                  setMessage("清理审查任务已发布到需求看板；尚未授权删除。");
                })
              }
            >
              发布清理任务到看板
            </button>
            <button
              className={button}
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
          <p className="mt-3 text-xs text-fg-muted">
            未采用生成尝试与失败作业残留需要用途和归属证据。发布任务授权审查；执行仍需确认具体计划。
          </p>
          <details className="mt-4 rounded-lg border border-border p-3 text-xs">
            <summary className="cursor-pointer font-medium">source / work / project / output 文件审查</summary>
            <p className="mt-2 text-fg-muted">正式素材见节点引用，工程见节点图。生产任务按实际用途登记；删除未采用尝试后无法再次注册该结果，且可能无法原样重建，需逐项选择。成片、已采用素材和受引用文件保留。</p>
            {review?.workFiles.files.map((file) => (
              <label key={`${file.jobId}:${file.fileId}`} className="mt-3 flex gap-2 rounded border border-border p-2">
                <input type="checkbox" aria-label={`选择过程文件 ${file.selectionId}`} disabled={busy || !!file.retainedReason} checked={workFileIds.includes(file.selectionId)} onChange={(event) => {
                  setWorkFileIds((current) => event.target.checked ? [...current, file.selectionId] : current.filter((id) => id !== file.selectionId));
                  setPlan(null);
                }} />
                <span className="min-w-0 break-all">
                  <span className="font-medium">{file.kind} · {file.purpose} · {bytes(file.sizeBytes)}</span><br />
                  {file.path}<br />
                  {file.rebuildable ? "可重建" : "不保证原样重建"} · {file.deliveryStatus} · {file.taskState}<br />
                  {file.retainedReason ?? "没有发现保留引用；可选择加入具体清理计划"}
                  {file.retainedBy.length > 0 ? <span className="block">{file.retainedBy.join("；")}</span> : null}
                </span>
              </label>
            ))}
            {!review?.workFiles.files.length ? <p className="mt-2 text-fg-muted">此工程尚无已登记且仍在磁盘上的生产文件。未知历史路径保留。</p> : null}
          </details>
          <details className="mt-4 rounded-lg border border-border p-3 text-xs">
            <summary className="cursor-pointer font-medium">
              审查未采用生成尝试与失败作业
            </summary>
            <p className="mt-2 text-fg-muted">
              失败清理只移除已失败或取消的作业记录与固定输入快照，会失去该作业的重试证据。输出文件、正式素材和未知生成尝试保留。
            </p>
            {review?.failedJobs.tasks.map((task) => (
              <div
                key={task.jobId}
                className="mt-3 rounded border border-border p-2"
              >
                <p className="break-all font-medium">
                  {task.kind} · {task.state} · {task.jobId}
                </p>
                <p className="mt-1 text-fg-muted">{task.retainedReason}</p>
                {task.files.map((file) => (
                  <p className="mt-1 break-all" key={file.path}>
                    {file.path} · {bytes(file.sizeBytes)}
                  </p>
                ))}
              </div>
            ))}
            {review?.failedJobs.unknowns.map((unknown) => (
              <p key={unknown} className="mt-2 text-amber-400">
                {unknown}
              </p>
            ))}
          </details>
          {plan ? (
            <div
              className="mt-5 rounded-lg border border-accent p-4"
              data-testid="cleanup-confirmation"
            >
              <h3 className="font-semibold">确认这份整理计划</h3>
              <p className="mt-2 break-all text-xs text-fg-muted">
                计划 {plan.planId}
                {` · 此次审查版本 ${plan.revision}${session ? ` · 导出来源版本 ${session.target.revision}` : ""}`}
              </p>
              <p className="mt-3 text-sm">
                {actionLabels[plan.action]} · 预计释放{" "}
                {bytes(plan.reclaimableBytes)}
              </p>
              <p className="mt-2 text-xs text-fg-muted">
                {plan.selection.nodeIds.length} 个节点 ·{" "}
                {plan.selection.mediaIds.length} 个素材 ·{" "}
                {plan.selection.cacheKeys.length} 项缓存 ·{" "}
                {plan.selection.jobIds.length} 个失败作业
                {` · ${plan.candidateWorkFiles.length} 个过程文件`}
              </p>
              {plan.selection.nodeIds.length ? (
                <ul className="my-3 list-inside list-disc text-sm">
                  {plan.selection.nodeIds.map((id) => (
                    <li key={id}>
                      {review?.nodes.find((node) => node.nodeId === id)?.name ??
                        id}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="my-3 max-h-64 space-y-3 overflow-auto text-xs">
                {plan.candidateWorkFiles.map((file) => <div key={`${file.jobId}:${file.fileId}`} className="break-all rounded border border-border p-2">
                  <p className="font-medium">work · {file.purpose} · {bytes(file.sizeBytes)}</p>
                  <p>{file.path}</p>
                  <p>{file.rebuildable ? "可重建过程文件" : "未采用尝试，不保证原样重建"}；生产记录归属明确，完整扫描未发现保留引用。</p>
                </div>)}
                {plan.candidateMedia.map((media) => (
                  <div
                    key={media.mediaId}
                    className="rounded border border-border p-2"
                  >
                    <p className="font-medium">
                      素材 {media.mediaId} · {bytes(media.sizeBytes)}
                    </p>
                    <ul className="my-1 list-inside list-disc">
                      {media.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                    {media.files.map((file) => (
                      <p key={file.path} className="break-all text-fg-muted">
                        {file.path} · {bytes(file.sizeBytes)}
                      </p>
                    ))}
                  </div>
                ))}
                {plan.candidateCache.map((cache) => (
                  <p key={cache.key} className="break-all">
                    可重建帧缓存 · {cache.key} · {bytes(cache.sizeBytes)}
                  </p>
                ))}
                {plan.candidateJobs.map((job) => (
                  <div
                    className="rounded border border-border p-2"
                    key={job.jobId}
                  >
                    <p className="font-medium">
                      失败作业 {job.jobId} · {bytes(job.reclaimableBytes)}
                    </p>
                    {job.reasons.map((reason) => (
                      <p key={reason} className="mt-1">
                        {reason}
                      </p>
                    ))}
                    {job.files.map((file) => (
                      <p
                        key={file.path}
                        className="mt-1 break-all text-fg-muted"
                      >
                        {file.path} · {bytes(file.sizeBytes)}
                      </p>
                    ))}
                  </div>
                ))}
              </div>
              <details className="my-3 text-xs">
                <summary className="cursor-pointer">
                  保留 {plan.retainedMedia.length} 个素材与不确定项
                </summary>
                <ul className="mt-2 space-y-2">
                  {plan.retainedMedia.map((media) => (
                    <li key={media.mediaId} className="break-all">
                      {media.mediaId} · {media.reasons.join("；")}
                    </li>
                  ))}
                  {plan.unknowns.map((unknown) => (
                    <li key={unknown}>{unknown}</li>
                  ))}
                </ul>
              </details>
              {plan.blockers.length ? (
                <ul role="alert" className="my-3 text-xs text-amber-400">
                  {plan.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              ) : null}
              <div className="flex gap-2">
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => setPlan(null)}
                >
                  取消
                </button>
                <button
                  className={`${button} border-red-500 text-red-400`}
                  disabled={busy || plan.status !== "ready"}
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
                  确认执行此计划
                </button>
              </div>
            </div>
          ) : null}
          {result ? (
            <div
              className="mt-5 rounded-lg border border-border p-4"
              role="status"
            >
              <h3 className="font-semibold">整理结果</h3>
              <p className="mt-2 text-sm">
                实际释放 {bytes(result.reclaimedBytes)} · 删除{" "}
                {result.deletedMediaIds.length} 个素材 /{" "}
                {result.deletedNodeIds.length} 个节点 · 更新{" "}
                {result.updatedNodeIds.length} 个节点 · 清理{" "}
                {result.deletedCacheKeys.length} 项缓存 / {result.deletedJobIds.length} 个失败作业 / {result.deletedWorkFiles?.length ?? 0} 个过程文件
              </p>
              <p className="mt-2 text-xs text-fg-muted">容量按已移除的存储数据字节统计；IndexedDB 的磁盘空间由浏览器回收。</p>
              {result.reason ? (
                <p className="mt-2 text-xs text-amber-400">
                  需重新审查：{result.reason}
                </p>
              ) : null}
              <ul className="mt-3 space-y-2 break-all text-xs">
                {result.deletedWorkFiles?.map((file) => (
                  <li key={`${file.jobId}:${file.fileId}`}>已删除 {file.path} · {bytes(file.sizeBytes)}</li>
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
              className="mt-4 break-words text-sm text-amber-400"
            >
              {message}
            </p>
          ) : null}
          <div className="mt-6 border-t border-border pt-4">
            <h2 className="font-semibold">成片</h2>
            <p className="mt-2 text-xs text-fg-muted">
              导出结果单独登记；整理不会删除这些文件。
            </p>
            {outputs
              .filter(
                (output) =>
                  output.target.projectId === target?.projectId &&
                  output.ownership.deliveryStatus === "delivered",
              )
              .map((output) => (
                <div
                  key={output.target.exportId}
                  className="mt-3 rounded-md border border-border p-3 text-xs"
                >
                  <strong>{output.projectName}</strong>
                  <p className="my-2 break-all text-fg-muted">
                    {output.outputPath ?? "已交给浏览器下载"}
                  </p>
                  {output.outputPath ? (
                    <button
                      className="underline"
                      onClick={() =>
                        void perform(async () => {
                          await window.reelterminal?.fs.revealInFolder(
                            output.outputPath!,
                          );
                        })
                      }
                    >
                      在文件夹中显示
                    </button>
                  ) : null}
                </div>
              ))}
            {outputs.some(
              (output) =>
                output.target.projectId === target?.projectId &&
                output.ownership.deliveryStatus === "pending",
            ) ? (
              <details className="mt-4 text-xs">
                <summary className="cursor-pointer">待审查的导出尝试</summary>
                {outputs
                  .filter(
                    (output) =>
                      output.target.projectId === target?.projectId &&
                      output.ownership.deliveryStatus === "pending",
                  )
                  .map((output) => (
                    <p
                      key={output.target.exportId}
                      className="mt-2 break-all text-fg-muted"
                    >
                      {output.state.error ?? output.state.phase} ·{" "}
                      {output.outputPath ?? output.target.exportId}
                    </p>
                  ))}
              </details>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
