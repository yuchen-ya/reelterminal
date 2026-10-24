/**
 * Bottom details dock for the AI material workbench.
 *
 * Migrated from the prototype's SimpleBottomDetailsTimeline: keeps the
 * three-zone details body (lineage / tags / agent guidance), the collapse
 * toggle and the always-reachable decision bar. Contract changes:
 * - Height and collapsed state are controlled by the parent (heightPx).
 * - Decision buttons state their affected scope ("选中 N 项" when a
 *   multi-selection is active, otherwise "当前项") and share one
 *   onCommitDecision path for single and batch commits.
 * - The nod button renders ONLY from real agentGuidance; without guidance the
 *   bar offers the four standard decisions and never fakes a suggestion.
 * - Provenance tags render their real verification state
 *   (verified / declared / unknown, "未记录" when absent); lineage steps
 *   render only from real lineage data ("无谱系记录" when absent).
 * - Every mutation is awaited; failures surface as a visible error strip
 *   (host history undo via onUndoLast, canUndo from the controller).
 */
import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FastForward,
  Layers,
  Plus,
  Redo2,
  RotateCcw,
  ShieldCheck,
  ThumbsUp,
} from "lucide-react";
import type {
  WorkbenchContentType,
  WorkbenchDecision,
  WorkbenchDecisionStatus,
  WorkbenchProvenanceTag,
} from "@reelterminal/core";
import type { WorkbenchItemView, WorkbenchMutationResult } from "../types";

export interface SimpleBottomDetailsTimelineProps {
  readonly currentItem: WorkbenchItemView | null;
  /** Expanded dock height in pixels (controlled by the parent). */
  readonly heightPx: number;
  readonly collapsed: boolean;
  /** From the controller — the host history has undoable entries. */
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /**
   * Current selection ids. When more than one item is selected the standard
   * decision buttons act on the whole selection; optional, defaults to the
   * current item only.
   */
  readonly selectedIds?: readonly string[];
  readonly onToggleCollapse: () => void;
  /** Jump to a related entry (e.g. a real lineage parent node). */
  readonly onSelectItemById: (id: string) => void;
  readonly onCommitDecision: (
    decision: WorkbenchDecision,
    explicitTargetIds?: readonly string[],
  ) => Promise<WorkbenchMutationResult>;
  readonly onSkipNext: () => void;
  readonly onUndoLast: () => Promise<WorkbenchMutationResult>;
  readonly onRedoLast: () => Promise<WorkbenchMutationResult>;
  readonly onAddUserTag: (itemId: string, tag: string) => Promise<WorkbenchMutationResult>;
}

const TYPE_LABELS: Record<WorkbenchContentType, string> = {
  image: "图片",
  text: "文本",
  data: "数据",
  video: "视频",
  model3d: "3D 模型",
};

const STATUS_LABELS: Record<WorkbenchDecisionStatus, string> = {
  pending: "待处理",
  kept: "保留",
  modified: "已修改",
  rework: "待返工",
  discarded: "已丢弃",
};

const STATUS_CLASS: Record<WorkbenchDecisionStatus, string> = {
  pending: "text-fg-3",
  kept: "text-accent",
  modified: "text-status-info",
  rework: "text-status-warning",
  discarded: "text-status-error",
};

function ProvenanceChip({ tag }: { tag: WorkbenchProvenanceTag }) {
  const verificationLabel =
    tag.verification === "verified"
      ? "已验证"
      : tag.verification === "declared"
        ? "已声明(未验证)"
        : "验证状态未知";
  const iconClass =
    tag.verification === "verified"
      ? "text-accent"
      : tag.verification === "declared"
        ? "text-status-warning"
        : "text-fg-3";
  return (
    <span
      title={`${verificationLabel}${tag.version ? ` · ${tag.version}` : ""} · ${tag.detailSummary}`}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-bg-2 border border-border text-xs font-mono text-fg"
    >
      {tag.verification === "unknown" ? (
        <CircleAlert className={`w-3 h-3 ${iconClass}`} />
      ) : (
        <ShieldCheck className={`w-3 h-3 ${iconClass}`} />
      )}
      @{tag.shortName}
    </span>
  );
}

export function SimpleBottomDetailsTimeline({
  currentItem,
  heightPx,
  collapsed,
  canUndo,
  canRedo,
  selectedIds,
  onToggleCollapse,
  onSelectItemById,
  onCommitDecision,
  onSkipNext,
  onUndoLast,
  onRedoLast,
  onAddUserTag,
}: SimpleBottomDetailsTimelineProps) {
  const [newTagInput, setNewTagInput] = useState<string>("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Single and batch commits share onCommitDecision; multi-selection commits
  // carry explicit target ids so the controller cannot guess the scope.
  const targetIds: readonly string[] =
    selectedIds && selectedIds.length > 1
      ? selectedIds
      : currentItem
        ? [currentItem.id]
        : [];
  const targetLabel = targetIds.length > 1 ? `选中 ${targetIds.length} 项` : "当前项";

  const runMutation = useCallback(
    async (action: () => Promise<WorkbenchMutationResult>) => {
      setActionError(null);
      setBusy(true);
      try {
        const result = await action();
        if (!result.ok) setActionError(result.message);
        return result;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const handleCommit = (decision: WorkbenchDecision, explicitTargetIds?: readonly string[]) => {
    if (targetIds.length === 0) return;
    void runMutation(() => onCommitDecision(decision, explicitTargetIds));
  };

  const handleUndo = () => {
    void runMutation(onUndoLast);
  };

  const handleRedo = () => {
    void runMutation(onRedoLast);
  };

  const handleAddTagSubmit = (e: FormEvent) => {
    e.preventDefault();
    const tag = newTagInput.trim();
    if (!currentItem || !tag) return;
    void runMutation(() => onAddUserTag(currentItem.id, tag)).then((result) => {
      if (result.ok) setNewTagInput("");
    });
  };

  const guidance = currentItem?.agentGuidance;
  const lineage = currentItem?.lineage;
  const parentItemId = lineage?.parentNodeId;
  // "modified" is only executable through a real content revision. The data
  // path creates one from proposed cells; other types must use their own
  // editor (text revision / pixel repair / annotation save) first.
  const nodExecutable =
    guidance !== undefined &&
    (guidance.nodDecision !== "modified" || currentItem?.type === "data");

  return (
    <div
      style={{ height: collapsed ? 36 : heightPx }}
      className="bg-bg border-t border-border flex flex-col shrink-0 overflow-hidden"
      data-testid="workbench-bottom-dock"
    >
      {/* Minimal Header Strip (decision bar stays reachable when collapsed) */}
      <div className="h-9 px-4 border-b border-border flex items-center justify-between gap-4 shrink-0 bg-bg-1 select-none">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex items-center gap-1.5 text-xs font-semibold text-fg-2 hover:text-fg transition-colors"
        >
          {collapsed ? (
            <ChevronUp className="w-3.5 h-3.5 text-accent" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-fg-3" />
          )}
          <span>节点详情</span>
          {currentItem && (
            <span className="text-fg-3 ml-2 font-normal">
              {currentItem.title} · {TYPE_LABELS[currentItem.type]} · <span className="font-mono">v{currentItem.version}</span> ·{" "}
              <span className={STATUS_CLASS[currentItem.status]}>
                {STATUS_LABELS[currentItem.status]}
              </span>
            </span>
          )}
        </button>

        {currentItem && targetIds.length > 0 && (
          <div className="flex items-center gap-1.5">
            {guidance && (
              <button
                type="button"
                disabled={busy || !nodExecutable}
                onClick={() => handleCommit(guidance.nodDecision, [currentItem.id])}
                title={
                  nodExecutable
                    ? `Agent 建议决定:${STATUS_LABELS[guidance.nodDecision]}(仅作用于当前项)`
                    : "Agent 建议“已修改”，需先在内容编辑器保存实际修订"
                }
                className="px-3 py-1 rounded-md bg-accent text-accent-fg text-xs font-bold hover:opacity-90 transition-opacity flex items-center gap-1 disabled:opacity-40"
              >
                <ThumbsUp className="w-3 h-3 stroke-[2.5]" />
                {guidance.nodButtonLabel}
              </button>
            )}

            <button
              type="button"
              disabled={busy}
              onClick={() => handleCommit("kept", targetIds)}
              title={`保留 · 作用于${targetLabel}`}
              className="px-2 py-1 rounded-md bg-bg-2 hover:bg-hover text-xs text-fg-2 hover:text-fg disabled:opacity-40"
            >
              保留
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => handleCommit("rework", targetIds)}
              title={`标为待返工 · 作用于${targetLabel}`}
              className="px-2 py-1 rounded-md bg-bg-2 hover:bg-hover text-xs text-status-warning disabled:opacity-40"
            >
              返工
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => handleCommit("discarded", targetIds)}
              title={`丢弃 · 作用于${targetLabel}`}
              className="px-2 py-1 rounded-md bg-bg-2 hover:bg-hover text-xs text-status-error disabled:opacity-40"
            >
              丢弃
            </button>
            <span className="text-[10px] font-mono text-fg-3 px-1" title="决定按钮作用范围">
              {targetLabel}
            </span>
            <button
              type="button"
              onClick={onSkipNext}
              className="p-1 rounded-md bg-bg-2 text-fg-2 hover:text-fg"
              title="跳到下一项"
            >
              <FastForward className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleUndo}
              disabled={!canUndo || busy}
              className="p-1 rounded-md bg-bg-2 text-fg-2 hover:text-fg disabled:opacity-30"
              title="撤销上一次决定(宿主历史)"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleRedo}
              disabled={!canRedo || busy}
              className="p-1 rounded-md bg-bg-2 text-fg-2 hover:text-fg disabled:opacity-30"
              title="重做上一次撤销(宿主历史)"
              data-testid="workbench-redo"
            >
              <Redo2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {actionError && (
        <div className="px-4 py-1.5 border-b border-border bg-bg-1 flex items-center justify-between gap-2 shrink-0">
          <span className="text-[11px] text-status-error break-all">{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="text-fg-3 hover:text-fg shrink-0"
          >
            ×
          </button>
        </div>
      )}

      {/* Calm, Open 3-Zone Details Body */}
      {!collapsed && currentItem && (
        <div className="flex-1 grid grid-cols-12 gap-6 px-4 py-3 overflow-y-auto items-start">
          {/* ZONE 1 (4 cols): lineage history (icon + position -> versions) */}
          <div className="col-span-12 lg:col-span-4 space-y-1.5 border-r border-border pr-4">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-fg-3">
              {lineage ? (
                <>
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-bg-2 border border-border text-fg font-semibold">
                    <Layers className="w-3 h-3 text-accent" />
                    {lineage.upstreamSourceNode}
                  </span>
                  <ArrowRight className="w-3 h-3 text-fg-3" />
                  <span className="text-accent">{lineage.basedOnLabel}</span>
                </>
              ) : (
                <span>无谱系记录</span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {(lineage?.steps ?? []).map((step, idx) => {
                const steps = lineage?.steps ?? [];
                const isLast = idx === steps.length - 1;
                return (
                  <span key={step.version} className="inline-flex items-center gap-1.5">
                    <span
                      title={step.summary}
                      className={`px-2 py-1 rounded-md text-xs border ${
                        step.outcome === "rejected"
                          ? "border-status-error/30 text-status-error"
                          : isLast
                            ? "bg-bg-2 border-accent/50 text-fg font-medium"
                            : "bg-bg-1 border-border text-fg-2"
                      }`}
                    >
                      <span className="font-mono font-bold mr-1">v{step.version}:</span>
                      <span>{step.summary.split("：")[1] || step.summary}</span>
                    </span>
                    {!isLast && <ArrowRight className="w-3 h-3 text-fg-3 shrink-0" />}
                  </span>
                );
              })}
              {lineage && lineage.steps.length === 0 && (
                <span className="text-xs text-fg-3">无版本历史</span>
              )}
            </div>

            {parentItemId && (
              <button
                type="button"
                onClick={() => onSelectItemById(parentItemId)}
                className="text-[11px] text-accent hover:underline"
                title="跳转到上游条目"
              >
                跳转上游条目 →
              </button>
            )}
          </div>

          {/* ZONE 2 (4 cols): tags (@provenance + #category) */}
          <div className="col-span-12 lg:col-span-4 space-y-1.5 border-r border-border pr-4">
            <div className="text-[11px] font-medium text-fg-3">已打标签与上游来源</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {currentItem.provenanceTags.length === 0 && (
                <span className="px-2 py-0.5 rounded-md bg-bg-1 border border-border text-xs text-fg-3">
                  来源未记录
                </span>
              )}
              {currentItem.provenanceTags.map((tag) => (
                <ProvenanceChip key={tag.id} tag={tag} />
              ))}

              {currentItem.userCategoryTags.map((t) => (
                <span
                  key={t}
                  className="px-2 py-0.5 rounded-md bg-bg-1 border border-border text-xs text-fg-2"
                >
                  #{t}
                </span>
              ))}

              <form onSubmit={handleAddTagSubmit} className="inline-flex items-center">
                <input
                  type="text"
                  value={newTagInput}
                  onChange={(e) => setNewTagInput(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder="+ 标签"
                  className="w-16 bg-transparent border-b border-border focus:border-accent px-1 py-0.5 text-xs text-fg placeholder-fg-3 focus:outline-none"
                />
                {newTagInput.trim() && (
                  <button type="submit" className="ml-1 text-accent" title="添加标签">
                    <Plus className="w-3 h-3" />
                  </button>
                )}
              </form>
            </div>
          </div>

          {/* ZONE 3 (4 cols): agent diagnosis & suggestion */}
          <div className="col-span-12 lg:col-span-4 space-y-1">
            <div className="text-[11px] font-medium text-accent">Agent 诊断与建议</div>
            {guidance ? (
              <>
                <p className="text-xs text-fg leading-relaxed">{guidance.whatHappened}</p>
                <p className="text-xs text-fg-2 leading-relaxed">{guidance.whatToDoNext}</p>
              </>
            ) : (
              <p className="text-xs text-fg-3">未提供 Agent 建议</p>
            )}
          </div>
        </div>
      )}

      {!collapsed && !currentItem && (
        <div className="flex-1 flex items-center justify-center px-4">
          <span className="text-xs text-fg-3 select-none">无当前条目</span>
        </div>
      )}
    </div>
  );
}
