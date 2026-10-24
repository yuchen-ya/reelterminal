/**
 * Bottom details dock for the AI material workbench.
 *
 * Refactored for Phase 4:
 * - A sticky, prominent decision bar (44px / h-11) remains reachable at all
 *   times at the bottom of the workbench.
 * - Prominent Keep / Rework / Discard decision buttons with distinct semantic
 *   colours and active-state highlights.
 * - Current item summary, status badge, tags preview, inline "+ 标签" input,
 *   and Agent guidance pill in the middle section.
 * - Collapsible 3-zone details drawer (lineage, provenance/tags, agent guidance)
 *   defaulting to collapsed to maximise viewport space for media viewers.
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
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-bg-2 border border-border text-[11px] font-mono text-fg shrink-0"
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

  const lineageCount = (lineage?.steps?.length ?? 0) + (lineage?.upstreamSourceNode ? 1 : 0);
  const tagCount = (currentItem?.provenanceTags.length ?? 0) + (currentItem?.userCategoryTags.length ?? 0);
  const summaryParts: string[] = [];
  if (tagCount > 0) summaryParts.push(`${tagCount}标签`);
  if (lineageCount > 0) summaryParts.push(`${lineageCount}版本`);
  if (guidance) summaryParts.push("建议");
  const summaryCountsText = summaryParts.length > 0 ? summaryParts.join(" · ") : "无详情";

  return (
    <div
      style={{ height: collapsed ? 44 : heightPx }}
      className="bg-bg border-t border-border flex flex-col shrink-0 overflow-hidden"
      data-testid="workbench-bottom-dock"
    >
      {actionError && (
        <div className="px-3 py-1 border-b border-border bg-status-error/10 text-status-error flex items-center justify-between gap-2 shrink-0 text-xs">
          <span className="truncate">{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="text-status-error hover:opacity-80 shrink-0 font-bold px-1"
          >
            ×
          </button>
        </div>
      )}

      {/* Expanded 3-Zone Details Drawer (above the sticky decision bar) */}
      {!collapsed && currentItem && (
        <div className="flex-1 grid grid-cols-12 gap-4 px-3 py-2 overflow-y-auto items-start border-b border-border bg-bg-1/50">
          {/* ZONE 1 (4 cols): lineage history */}
          <div className="col-span-12 lg:col-span-4 space-y-1.5 border-r border-border pr-3">
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
                      className={`px-2 py-0.5 rounded-md text-xs border ${
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
                className="text-[11px] text-accent hover:underline block pt-0.5"
                title="跳转到上游条目"
              >
                跳转上游条目 →
              </button>
            )}
          </div>

          {/* ZONE 2 (4 cols): tags (@provenance + #category) */}
          <div className="col-span-12 lg:col-span-4 space-y-1.5 border-r border-border pr-3">
            <div className="text-[11px] font-medium text-fg-3">完整标签与上游来源</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {currentItem.provenanceTags.length === 0 && currentItem.userCategoryTags.length === 0 && (
                <span className="px-2 py-0.5 rounded-md bg-bg-1 border border-border text-xs text-fg-3">
                  暂无标签与来源
                </span>
              )}
              {currentItem.provenanceTags.map((tag) => (
                <ProvenanceChip key={tag.id} tag={tag} />
              ))}
              {currentItem.userCategoryTags.map((t) => (
                <span
                  key={t}
                  className="px-2 py-0.5 rounded-md bg-bg-1 border border-border text-xs text-fg-2 font-mono"
                >
                  #{t}
                </span>
              ))}
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
        <div className="flex-1 flex items-center justify-center px-4 border-b border-border bg-bg-1/50">
          <span className="text-xs text-fg-3 select-none">无当前条目</span>
        </div>
      )}

      {/* Sticky Bottom Decision Bar (h-11 / 44px, always visible) */}
      <div className="h-11 px-3 flex items-center justify-between gap-3 shrink-0 bg-bg-1 select-none">
        {/* 1. Core Decision Buttons Group */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            disabled={busy || !currentItem}
            onClick={() => handleCommit("kept", targetIds)}
            title={`保留 · 作用于${targetLabel}`}
            className={`h-[30px] px-3.5 rounded-md text-xs font-semibold transition-colors disabled:opacity-40 inline-flex items-center justify-center select-none ${
              currentItem?.status === "kept"
                ? "bg-accent text-accent-fg shadow-sm"
                : "border border-accent/50 bg-accent/15 text-accent hover:bg-accent/25"
            }`}
          >
            保留
          </button>
          <button
            type="button"
            disabled={busy || !currentItem}
            onClick={() => handleCommit("rework", targetIds)}
            title={`标为待返工 · 作用于${targetLabel}`}
            className={`h-[30px] px-3.5 rounded-md text-xs font-semibold transition-colors disabled:opacity-40 inline-flex items-center justify-center select-none ${
              currentItem?.status === "rework"
                ? "bg-amber-500 text-black shadow-sm"
                : "border border-amber-500/50 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
            }`}
          >
            返工
          </button>
          <button
            type="button"
            disabled={busy || !currentItem}
            onClick={() => handleCommit("discarded", targetIds)}
            title={`丢弃 · 作用于${targetLabel}`}
            className={`h-[30px] px-3.5 rounded-md text-xs font-semibold transition-colors disabled:opacity-40 inline-flex items-center justify-center select-none ${
              currentItem?.status === "discarded"
                ? "bg-red-600 text-white shadow-sm"
                : "border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20"
            }`}
          >
            丢弃
          </button>

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
              className="h-[30px] px-2.5 rounded-md bg-accent/20 border border-accent/40 text-accent hover:bg-accent/30 text-xs font-semibold transition-colors flex items-center gap-1 disabled:opacity-40 select-none shrink-0"
            >
              <ThumbsUp className="w-3.5 h-3.5 stroke-[2.2]" />
              <span>{guidance.nodButtonLabel}</span>
            </button>
          )}

          <span
            className="text-[11px] font-mono text-fg-3 px-1.5 py-0.5 rounded bg-bg-2 border border-border select-none shrink-0"
            title="决定按钮作用范围"
          >
            {targetLabel}
          </span>
          <button
            type="button"
            onClick={onSkipNext}
            className="h-[30px] w-[30px] inline-flex items-center justify-center rounded-md border border-border bg-bg-2 text-fg-2 hover:text-fg hover:bg-bg-3 transition-colors shrink-0"
            title="跳到下一项"
          >
            <FastForward className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleUndo}
            disabled={!canUndo || busy}
            className="h-[30px] w-[30px] inline-flex items-center justify-center rounded-md border border-border bg-bg-2 text-fg-2 hover:text-fg hover:bg-bg-3 disabled:opacity-30 transition-colors shrink-0"
            title="撤销上一次决定(宿主历史)"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleRedo}
            disabled={!canRedo || busy}
            className="h-[30px] w-[30px] inline-flex items-center justify-center rounded-md border border-border bg-bg-2 text-fg-2 hover:text-fg hover:bg-bg-3 disabled:opacity-30 transition-colors shrink-0"
            title="重做上一次撤销(宿主历史)"
            data-testid="workbench-redo"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 2. Vertical Divider + Current Item Summary & Quick Shortcuts */}
        <div className="h-5 w-px bg-border shrink-0 mx-0.5" />

        <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
          {currentItem ? (
            <>
              <span
                className="text-xs font-semibold text-fg truncate shrink-0 max-w-[180px]"
                title={currentItem.title}
              >
                {currentItem.title}
              </span>
              <span className="text-fg-3 text-xs shrink-0">·</span>
              <span className="text-xs text-fg-2 shrink-0">{TYPE_LABELS[currentItem.type]}</span>
              <span className="text-fg-3 text-xs shrink-0">·</span>
              <span className="font-mono text-xs text-fg-2 shrink-0">v{currentItem.version}</span>
              <span className="text-fg-3 text-xs shrink-0">·</span>
              <span
                className={`px-1.5 py-0.5 rounded text-[11px] font-medium shrink-0 border ${
                  currentItem.status === "kept"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                    : currentItem.status === "rework"
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                      : currentItem.status === "discarded"
                        ? "border-red-500/30 bg-red-500/10 text-red-300"
                        : currentItem.status === "modified"
                          ? "border-blue-500/30 bg-blue-500/10 text-blue-400"
                          : "border-border bg-bg-2 text-fg-3"
                }`}
              >
                {STATUS_LABELS[currentItem.status]}
              </span>

              {/* Provenance tags preview (up to 2) */}
              {currentItem.provenanceTags.slice(0, 2).map((tag) => (
                <ProvenanceChip key={tag.id} tag={tag} />
              ))}

              {/* User category tags preview (up to 2) */}
              {currentItem.userCategoryTags.slice(0, 2).map((t) => (
                <span
                  key={t}
                  className="px-1.5 py-0.5 rounded bg-bg-2 border border-border text-[11px] text-fg-2 shrink-0 font-mono"
                >
                  #{t}
                </span>
              ))}

              {/* Inline tag form */}
              <form onSubmit={handleAddTagSubmit} className="inline-flex items-center shrink-0">
                <input
                  type="text"
                  value={newTagInput}
                  onChange={(e) => setNewTagInput(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder="+ 标签"
                  className="w-14 bg-transparent border-b border-border focus:border-accent px-1 py-0.5 text-xs text-fg placeholder-fg-3 focus:outline-none"
                />
                {newTagInput.trim() && (
                  <button type="submit" className="ml-1 text-accent hover:opacity-80" title="添加标签">
                    <Plus className="w-3 h-3" />
                  </button>
                )}
              </form>

              {/* Agent guidance badge */}
              {guidance && (
                <button
                  type="button"
                  onClick={onToggleCollapse}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 shrink-0 truncate max-w-[220px]"
                  title={`${guidance.whatHappened} · ${guidance.whatToDoNext} (点击展开详情)`}
                >
                  <span className="font-semibold shrink-0">Agent:</span>
                  <span className="truncate">{guidance.whatToDoNext}</span>
                </button>
              )}
            </>
          ) : (
            <span className="text-xs text-fg-3 select-none">未选择条目</span>
          )}
        </div>

        {/* 3. Right: Node Details Drawer Toggle Button */}
        <button
          type="button"
          onClick={onToggleCollapse}
          className="h-[30px] px-2.5 rounded-md border border-border bg-bg-2 hover:bg-bg-3 text-xs font-semibold text-fg-2 hover:text-fg transition-colors flex items-center gap-1.5 shrink-0 select-none"
          title={collapsed ? "展开节点详情抽屉" : "收起节点详情抽屉"}
        >
          {collapsed ? (
            <ChevronUp className="w-3.5 h-3.5 text-accent" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-fg-3" />
          )}
          <span>节点详情</span>
          {currentItem && (
            <span className="text-[11px] font-normal text-fg-3 ml-0.5 font-mono">
              ({summaryCountsText})
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
