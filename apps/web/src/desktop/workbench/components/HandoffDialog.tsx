/**
 * Handoff publication dialog for the AI material workbench.
 *
 * Migrated from the prototype's HandoffModal onto the host ToolcraftDialog.
 * Kept: the KPI strip, the publish-preview table of decided entries, the
 * exclusion notice and the published-snapshot history with real delivery
 * states.
 *
 * Publish is a real controller mutation over a checked subset of decided
 * entries (default: all decided). Publishing an unchanged snapshot replays the
 * existing handoff identity (no duplicate); changing feedback/decisions
 * publishes a new snapshot linked by supersedes. Real failures are surfaced
 * verbatim; nothing is faked.
 */
import { useCallback, useEffect, useState } from "react";
import {
  CircleCheck,
  Clock,
  Copy,
  Download,
  Send,
  ShieldCheck,
} from "lucide-react";
import type { WorkbenchDecision, WorkbenchDecisionStatus, WorkbenchHandoff } from "@reelterminal/core";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import type {
  WorkbenchBatchView,
  WorkbenchItemView,
  WorkbenchMutationResult,
} from "../types";
import { wbButton } from "../wb-button";

export interface HandoffDialogProps {
  readonly preparing?: boolean;
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly batch: WorkbenchBatchView;
  readonly batchItems: readonly WorkbenchItemView[];
  /** Real published snapshots (append-only); newest first. */
  readonly handoffs: readonly WorkbenchHandoff[];
  /**
   * Controller publish. `itemIds` selects a subset of DECIDED entries;
   * an unchanged snapshot replays the existing handoff, a feedback change
   * publishes a new one, and a real failure is returned for display.
   */
  readonly onPublishHandoff: (
    itemIds?: readonly string[],
  ) => Promise<WorkbenchMutationResult>;
}

const STATUS_LABELS: Record<WorkbenchDecision, string> = {
  kept: "保留",
  modified: "已修改",
  rework: "待返工",
  discarded: "已丢弃",
};

const STATUS_CLASS: Record<WorkbenchDecision, string> = {
  kept: "text-accent",
  modified: "text-status-info",
  rework: "text-status-warning",
  discarded: "text-status-error",
};

type DecidedItem = WorkbenchItemView & { readonly status: WorkbenchDecision };

function isDecidedStatus(status: WorkbenchDecisionStatus): status is WorkbenchDecision {
  return status !== "pending";
}

function formatPublishedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function HandoffDialog({
  isOpen,
  onOpenChange,
  batch,
  batchItems,
  handoffs,
  onPublishHandoff,
  preparing = false,
}: HandoffDialogProps) {
  const [checkedOverride, setCheckedOverride] = useState<ReadonlySet<string> | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [jsonCopied, setJsonCopied] = useState(false);

  const decidedItems = batchItems.filter(
    (item): item is DecidedItem => isDecidedStatus(item.status),
  );
  const pendingItems = batchItems.filter((item) => !isDecidedStatus(item.status));
  // Draft feedback never enters a published handoff — counted across the
  // whole batch and called out explicitly.
  const draftFeedbackCount = batchItems.filter((item) => item.feedback?.isDraft).length;

  // null = "all decided checked" (default); a set is an explicit override.
  const effectiveChecked: ReadonlySet<string> =
    checkedOverride ?? new Set(decidedItems.map((item) => item.id));
  const checkedCount = decidedItems.filter((item) => effectiveChecked.has(item.id)).length;

  useEffect(() => {
    if (isOpen) {
      setCheckedOverride(null);
      setPublishError(null);
      setJsonCopied(false);
    }
  }, [isOpen]);

  const counts = {
    kept: decidedItems.filter((i) => i.status === "kept").length,
    modified: decidedItems.filter((i) => i.status === "modified").length,
    rework: decidedItems.filter((i) => i.status === "rework").length,
    discarded: decidedItems.filter((i) => i.status === "discarded").length,
  };

  // Tag display names resolve from the batch's own provenance tags.
  const tagNameById = new Map<string, string>();
  for (const item of batchItems) {
    for (const tag of item.provenanceTags) tagNameById.set(tag.id, tag.shortName);
  }

  const toggleItem = (itemId: string) => {
    const next = new Set(
      decidedItems.filter((i) => effectiveChecked.has(i.id)).map((i) => i.id),
    );
    if (next.has(itemId)) next.delete(itemId);
    else next.add(itemId);
    setCheckedOverride(next);
  };

  const allChecked = checkedCount === decidedItems.length && decidedItems.length > 0;
  const toggleAll = () => {
    setCheckedOverride(allChecked ? new Set<string>() : null);
  };

  const handlePublish = useCallback(async () => {
    if (preparing) return;
    const ids = decidedItems
      .filter((item) => effectiveChecked.has(item.id))
      .map((item) => item.id);
    if (ids.length === 0) return;
    setPublishError(null);
    setPublishing(true);
    try {
      const result = await onPublishHandoff(ids);
      if (!result.ok) setPublishError(result.message);
    } finally {
      setPublishing(false);
    }
  }, [decidedItems, effectiveChecked, onPublishHandoff, preparing]);

  const latestHandoff = handoffs.find((handoff) => !handoff.historicalOnly) ?? null;

  const handleCopyJson = () => {
    const data = latestHandoff ?? {
      batchId: batch.id,
      batchName: batch.name,
      decidedItemsCount: decidedItems.length,
      items: decidedItems.map((item) => ({
        id: item.id,
        version: item.version,
        status: item.status,
        feedback: item.feedback?.text,
      })),
    };
    void navigator.clipboard?.writeText(JSON.stringify(data, null, 2));
    setJsonCopied(true);
    setTimeout(() => setJsonCopied(false), 2000);
  };

  const handleExportJson = () => {
    const data = latestHandoff ?? {
      batchId: batch.id,
      batchName: batch.name,
      decidedItemsCount: decidedItems.length,
      items: decidedItems,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `handoff-${batch.name || "snapshot"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <ToolcraftDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      width={880}
      purpose="workbench-handoff-publish"
    >
      <ToolcraftDialogHeader
        title="交回本轮审阅结果"
        subtitle={
          <>
            {batch.name} · 仅包含已决定条目，待处理项 ({pendingItems.length}) 与未确认草稿
            反馈 ({draftFeedbackCount}) 绝不误发
          </>
        }
        onOpenChange={onOpenChange}
      />

      <div
        className="max-h-[64vh] overflow-y-auto px-5 py-4 space-y-4 text-xs"
        data-workbench-modal="true"
        data-workbench-scope="true"
        data-testid="workbench-handoff-dialog"
      >
        {preparing && <p role="status" className="text-xs text-fg-2">正在读取完整发布预览…</p>}
        {publishError && (
          <div className="px-3.5 py-2 rounded-[6px] border border-status-error/40 bg-bg-2 flex items-start justify-between gap-2">
            <span className="text-xs text-status-error break-all">
              发布失败: {publishError}
            </span>
            <button
              type="button"
              onClick={() => setPublishError(null)}
              className="text-fg-3 hover:text-fg shrink-0"
            >
              ×
            </button>
          </div>
        )}

        {/* Summary KPI strip */}
        <div className="grid grid-cols-5 gap-2.5">
          <div className="p-3 rounded-[6px] bg-bg-2 border border-border">
            <div className="text-[11px] text-fg-2">本轮交回总数</div>
            <div className="text-lg font-bold font-mono tabular-nums [font-family:var(--wb-font-num)] text-fg mt-0.5">
              {decidedItems.length}{" "}
              <span className="text-xs font-normal text-fg-3">/ {batchItems.length}</span>
            </div>
          </div>
          <div className="p-3 rounded-[6px] bg-bg-2 border border-border">
            <div className="text-[11px] text-accent">
              已保留<span className="sr-only"> (Kept)</span>
            </div>
            <div className="text-lg font-bold font-mono tabular-nums [font-family:var(--wb-font-num)] text-accent mt-0.5">
              {counts.kept}
            </div>
          </div>
          <div className="p-3 rounded-[6px] bg-bg-2 border border-border">
            <div className="text-[11px] text-status-info">
              已修改<span className="sr-only"> (Modified)</span>
            </div>
            <div className="text-lg font-bold font-mono tabular-nums [font-family:var(--wb-font-num)] text-status-info mt-0.5">
              {counts.modified}
            </div>
          </div>
          <div className="p-3 rounded-[6px] bg-bg-2 border border-border">
            <div className="text-[11px] text-status-warning">
              待返工<span className="sr-only"> (Rework)</span>
            </div>
            <div className="text-lg font-bold font-mono tabular-nums [font-family:var(--wb-font-num)] text-status-warning mt-0.5">
              {counts.rework}
            </div>
          </div>
          <div className="p-3 rounded-[6px] bg-bg-2 border border-border">
            <div className="text-[11px] text-status-error">
              已丢弃<span className="sr-only"> (Discarded)</span>
            </div>
            <div className="text-lg font-bold font-mono tabular-nums [font-family:var(--wb-font-num)] text-status-error mt-0.5">
              {counts.discarded}
            </div>
          </div>
        </div>

        {/* Pending & draft exclusion notice */}
        <div className="px-3.5 py-2 rounded-[6px] bg-bg-2 border border-border flex items-center justify-between gap-3 text-xs text-fg-2">
          <span>
            边界校验: 当前仍有 <strong className="text-fg tabular-nums">{pendingItems.length}</strong>{" "}
            项处于待处理队列。允许先行交回已处理子集,
            {draftFeedbackCount > 0 && (
              <>
                另有 <strong className="text-status-warning tabular-nums">{draftFeedbackCount}</strong>{" "}
                条草稿不会发布,
              </>
            )}
            未确认草稿反馈一律留在本地。
          </span>
          <span className="font-mono text-[11px] text-accent shrink-0 select-none">
            互斥计数守恒
          </span>
        </div>

        {/* Table of decided entries to publish (subset selectable) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-fg">
              即将写入交接快照的条目明细<span className="sr-only"> (不可变 Handoff 快照)</span> ({checkedCount}/{decidedItems.length} 项)
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopyJson}
                className={wbButton.ghost}
                data-testid="workbench-handoff-copy-json"
                title="复制快照 JSON"
              >
                <Copy className="h-3 w-3" />
                {jsonCopied ? "已复制" : "复制 JSON"}
              </button>
              <button
                type="button"
                onClick={handleExportJson}
                className={wbButton.ghost}
                data-testid="workbench-handoff-export-json"
                title="导出快照 JSON 文件"
              >
                <Download className="h-3 w-3" />
                导出 JSON
              </button>
              {decidedItems.length > 0 && (
                <label className="flex items-center gap-1.5 text-[11px] text-fg-2 cursor-pointer select-none ml-1">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={toggleAll}
                    className="accent-accent"
                  />
                  全选已决定
                </label>
              )}
            </div>
          </div>
          {decidedItems.length === 0 ? (
            <div className="p-5 rounded-[6px] bg-bg-2 border border-border text-center text-xs text-fg-3">
              当前批次尚无已处理条目。请先在工作台中保留、修改、标为待返工或丢弃至少 1
              项后再发布交接快照。
            </div>
          ) : (
            <div className="rounded-[6px] border border-border bg-bg-2 overflow-hidden">
              <table className="w-full text-left text-xs border-collapse select-text">
                <thead>
                  <tr className="bg-bg-1 border-b border-border text-fg-2 text-[11px]">
                    <th className="py-2 px-3 w-8 select-none">发布</th>
                    <th className="py-2 px-3">条目与版本</th>
                    <th className="py-2 px-3">主决定 (互斥)</th>
                    <th className="py-2 px-3">锚定坐标 / 修订范围</th>
                    <th className="py-2 px-3">反馈与 @来源引用</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {decidedItems.map((item) => (
                    <tr key={item.id} className="hover:bg-bg-3/50 transition-colors">
                      <td className="py-2 px-3 align-top">
                        <input
                          type="checkbox"
                          checked={effectiveChecked.has(item.id)}
                          onChange={() => toggleItem(item.id)}
                          aria-label={`选择发布 ${item.title}`}
                          className="accent-accent"
                        />
                      </td>
                      <td className="py-2 px-3 font-medium text-fg">
                        <div>{item.title}</div>
                        <div className="font-mono tabular-nums text-[10px] text-fg-3">
                          ID: {item.id} · v{item.version}
                          {item.reworkOrigin && ` · 返工自 v${item.reworkOrigin.previousVersion}`}
                        </div>
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap align-top">
                        <span className={`font-semibold ${STATUS_CLASS[item.status]}`}>
                          {STATUS_LABELS[item.status]}
                        </span>
                        {item.hasManualRevision && item.status === "rework" && (
                          <div className="text-[10px] text-status-info">附带人工修订层</div>
                        )}
                      </td>
                      <td className="py-2 px-3 font-mono text-[11px] text-fg-2 align-top">
                        {item.feedback?.targetSummary || `全条目 v${item.version}`}
                      </td>
                      <td className="py-2 px-3 text-fg-2 max-w-xs align-top">
                        <div className="truncate">{item.feedback?.text || "—"}</div>
                        {item.feedback?.isDraft && (
                          <div className="text-[10px] text-status-warning mt-0.5">
                            反馈为草稿,不会随快照发布
                          </div>
                        )}
                        {(item.feedback?.referencedTagIds.length ?? 0) > 0 && (
                          <div className="text-[10px] font-mono text-accent mt-0.5">
                            引用:{" "}
                            {item.feedback?.referencedTagIds
                              .map((id) => `@${tagNameById.get(id) ?? id}`)
                              .join(" ")}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Published snapshots — real delivery states only */}
        {handoffs.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-border">
            <div className="text-xs font-semibold text-fg">
              已发布 Handoff 快照历史与 Agent 接收/返工回流状态
            </div>
            {handoffs.map((handoff) => (
              <div
                key={handoff.handoffId}
                className="p-3 rounded-[6px] bg-bg-2 border border-border space-y-1"
              >
                <div className="flex items-center gap-2 text-xs flex-wrap">
                  <span className="font-mono font-semibold text-fg">{handoff.handoffId}</span>
                  <span className="text-fg-3">·</span>
                  <span className="font-mono text-[11px] text-fg-2">
                    幂等键: {handoff.idempotencyKey}
                  </span>
                  {handoff.supersedesHandoffId && (
                    <>
                      <span className="text-fg-3">·</span>
                      <span className="text-[11px] text-status-warning select-none">
                        明确取代旧快照 {handoff.supersedesHandoffId}
                      </span>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs flex-wrap select-none">
                  <span className="text-fg-2 tabular-nums">
                    发布时间 {formatPublishedAt(handoff.publishedAt)} · 含{" "}
                    {handoff.items.length} 项决定
                  </span>
                  <span className="text-fg-3">·</span>
                  {handoff.historicalOnly && <span className="text-fg-3">历史快照（不可继续外部任务）</span>}
                  {!handoff.historicalOnly && handoff.deliveryState === "published_waiting" && (
                    <span className="text-status-warning flex items-center gap-1 font-medium">
                      <Clock className="w-3.5 h-3.5" />
                      状态: 已交回, 等待 Agent 读取 (workbench.handoff.get)
                    </span>
                  )}
                  {!handoff.historicalOnly && handoff.deliveryState === "agent_acked" && (
                    <span className="text-status-info flex items-center gap-1 font-medium">
                      <ShieldCheck className="w-3.5 h-3.5" />
                      状态: Agent 已回报接收 (workbench.handoff.ack)
                    </span>
                  )}
                  {!handoff.historicalOnly && handoff.deliveryState === "rework_returned" && (
                    <span className="text-accent flex items-center gap-1 font-medium">
                      <CircleCheck className="w-3.5 h-3.5" />
                      状态: 返工产物已关联原 item/handoff 回流至待处理队列
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-5 py-3 bg-bg-1 border-t border-border flex items-center justify-between gap-3">
        <div className="text-xs text-fg-2 min-w-0 truncate select-none">
          {latestHandoff
            ? `最新快照状态: ${
                latestHandoff.deliveryState === "published_waiting"
                  ? "已交回,等待读取"
                  : latestHandoff.deliveryState === "agent_acked"
                    ? "Agent 已回报接收"
                    : "返工已回流"
              }`
            : "当前状态: 本地已保存(尚未对外发布快照)"}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className={wbButton.secondary}
          >
            关闭窗口
          </button>
          <button
            type="button"
            onClick={() => void handlePublish()}
            disabled={preparing || decidedItems.length === 0 || checkedCount === 0 || publishing}
            className={wbButton.primary}
          >
            <Send className="w-3.5 h-3.5" />
            {publishing
              ? "发布中…"
              : latestHandoff
                ? `发布新修订快照 (Supersede, ${checkedCount} 项)`
                : `发布本轮交接快照 (${checkedCount} 项)`}
          </button>
        </div>
      </div>
    </ToolcraftDialog>
  );
}
