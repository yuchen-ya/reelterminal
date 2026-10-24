/**
 * VisualMindMapModal — on-demand 2D (left→right) lineage mind map.
 *
 * Migrated from the prototype `VisualMindMapModal`. The dialog is hosted by
 * the host `ToolcraftDialog` (no custom fixed overlay). Only REAL
 * `parentNodeId` references draw edges; a batch without any lineage shows an
 * explicit empty state instead of a fabricated tree. Both single-item and
 * whole-branch nods go through an in-dialog confirmation that lists every
 * entry with its suggested decision (`agentGuidance.nodDecision`) and the
 * action that will execute — the controller performs the mutations, the UI
 * never pretends "modified" content edits happened here. Items without
 * agent guidance show "无建议" and cannot be nodded.
 */
import { Fragment, useMemo, useState } from "react";
import {
  FolderGit2,
  Layers,
  Network,
  ThumbsUp,
} from "lucide-react";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import type { WorkbenchDecision } from "@reelterminal/core";
import type {
  WorkbenchBatchView,
  WorkbenchItemView,
  WorkbenchMutationResult,
} from "../types";
import {
  buildWorkbenchLineageGroups,
  getWorkbenchStatusView,
  getWorkbenchTypeIcon,
  type WorkbenchLineageGroup,
  type WorkbenchLineageNode,
} from "./lineage-tree-utils";

/**
 * A nod callback may return void when the caller reports the outcome itself
 * (e.g. a toast); when a mutation result is returned, failures are surfaced
 * inline in the confirmation panel.
 */
type NodOutcome = void | WorkbenchMutationResult;

interface VisualMindMapModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly batch: WorkbenchBatchView | null;
  readonly items: readonly WorkbenchItemView[];
  readonly currentItemId: string | null;
  /** Node click: select the item in the workbench and jump to it. */
  readonly onSelectAndFocusItem: (itemId: string) => void;
  /** Single-item nod; the caller executes the suggested decision. */
  readonly onNodSingleItem: (item: WorkbenchItemView) => NodOutcome | Promise<NodOutcome>;
  /** Whole-branch nod over the listed items; executed by the controller. */
  readonly onNodEntireGroup: (
    items: readonly WorkbenchItemView[],
  ) => NodOutcome | Promise<NodOutcome>;
}

interface MindMapBranch extends WorkbenchLineageGroup {
  /** Pending items of this branch that carry agent guidance (nod scope). */
  nodablePendingItems: WorkbenchItemView[];
}

type NodRequest =
  | { readonly mode: "single"; readonly item: WorkbenchItemView }
  | { readonly mode: "group"; readonly items: readonly WorkbenchItemView[] };

const UNGROUPED_BRANCH_ID = "__ungrouped__";
const UNGROUPED_LABEL = "未分组(无谱系)";

const DECISION_LABELS: Record<WorkbenchDecision, string> = {
  kept: "保留",
  modified: "修改后保留",
  rework: "返工",
  discarded: "丢弃",
};

function buildMindMapBranches(
  items: readonly WorkbenchItemView[],
): MindMapBranch[] {
  const branches = buildWorkbenchLineageGroups(items, {
    ungroupedId: UNGROUPED_BRANCH_ID,
    ungroupedLabel: UNGROUPED_LABEL,
  }).map((group): MindMapBranch => ({ ...group, nodablePendingItems: [] }));
  const branchById = new Map(branches.map((branch) => [branch.id, branch]));
  for (const item of items) {
    const groupId = item.lineage?.upstreamGroupId ?? UNGROUPED_BRANCH_ID;
    const branch = branchById.get(groupId);
    if (branch && item.status === "pending" && item.agentGuidance) {
      branch.nodablePendingItems.push(item);
    }
  }
  return branches;
}


export function VisualMindMapModal({
  isOpen,
  onClose,
  batch,
  items,
  currentItemId,
  onSelectAndFocusItem,
  onNodSingleItem,
  onNodEntireGroup,
}: VisualMindMapModalProps) {
  const [nodRequest, setNodRequest] = useState<NodRequest | null>(null);
  const [nodBusy, setNodBusy] = useState(false);
  const [nodError, setNodError] = useState<string | null>(null);

  const branches = useMemo(() => buildMindMapBranches(items), [items]);
  const hasAnyLineage = items.some((item) => item.lineage);

  const requestClose = (): void => {
    setNodRequest(null);
    setNodError(null);
    setNodBusy(false);
    onClose();
  };

  const openNod = (request: NodRequest): void => {
    setNodError(null);
    setNodRequest(request);
  };

  const confirmNod = async (): Promise<void> => {
    if (!nodRequest || nodBusy) return;
    setNodBusy(true);
    setNodError(null);
    let outcome: NodOutcome;
    if (nodRequest.mode === "single") {
      outcome = await onNodSingleItem(nodRequest.item);
    } else {
      outcome = await onNodEntireGroup(nodRequest.items);
    }
    setNodBusy(false);
    // void outcome: the caller owns error reporting (e.g. toast).
    if (outcome && !outcome.ok) {
      setNodError(outcome.message);
      return;
    }
    setNodRequest(null);
  };

  const nodListItems: readonly WorkbenchItemView[] =
    nodRequest === null
      ? []
      : nodRequest.mode === "single"
        ? [nodRequest.item]
        : nodRequest.items;

  // Recursive horizontal mind-map node renderer:
  // [Node] ──┬── [Child 1] / ╰── [Child 2]
  const renderMindMapSubtree = (
    node: WorkbenchLineageNode,
    idx: number,
    totalSiblings: number,
  ) => {
    const { item, children } = node;
    const isCurrent = item.id === currentItemId;
    const isArchived = item.status !== "pending";
    const failStreak = item.lineage?.failStreak ?? 0;
    const priorSteps = item.lineage
      ? item.lineage.steps.slice(0, -1)
      : [];
    const isFirst = idx === 0;
    const isLast = idx === totalSiblings - 1;
    const isOnly = totalSiblings === 1;
    const guidance = item.agentGuidance;
    const statusView = getWorkbenchStatusView(item.status);
    const label = guidance?.nodeSlotLabel ?? item.title;
    const canNod = item.status === "pending" && !!guidance;

    const pillTone = isCurrent
      ? "border-accent bg-bg-2 text-fg shadow-md ring-1 ring-accent"
      : isArchived
        ? "border-border bg-bg text-fg-3 opacity-80 hover:opacity-100"
        : failStreak >= 2
          ? "border-status-warning/50 bg-bg-2 text-fg hover:border-status-warning"
          : "border-border bg-bg-1 text-fg hover:border-border-strong";

    return (
      <div key={item.id} className="relative flex items-center py-1.5">
        {/* Vertical spine connector on the left of the sibling group */}
        {!isOnly && (
          <div
            className={`absolute left-0 w-px bg-border ${
              isFirst
                ? "bottom-0 top-1/2"
                : isLast
                  ? "bottom-1/2 top-0"
                  : "bottom-0 top-0"
            }`}
          />
        )}

        {/* Horizontal branch line into the node */}
        <div className="h-px w-5 shrink-0 bg-border" />

        {/* Prior version graphical steps along the branch */}
        {priorSteps.map((step) => (
          <Fragment key={step.version}>
            <div
              title={step.summary}
              className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                step.outcome === "rejected"
                  ? "border-rose-500/40 bg-rose-950/70 text-rose-300"
                  : "border-sky-500/30 bg-sky-950/60 text-sky-300"
              }`}
            >
              v{step.version}
              {step.outcome === "rejected" ? "✕" : "改"}
            </div>
            <div className="h-px w-2.5 shrink-0 bg-border-strong" />
          </Fragment>
        ))}

        {/* Node pill: type icon + label + version + quick nod */}
        <div
          onClick={() => {
            onSelectAndFocusItem(item.id);
            requestClose();
          }}
          className={`flex shrink-0 cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-1.5 transition-all ${pillTone}`}
        >
          <div className="flex items-center gap-1.5">
            {getWorkbenchTypeIcon(item.type)}
            <span className="whitespace-nowrap text-xs font-semibold">
              {label}
            </span>
            <span className="rounded bg-bg-2 px-1.5 py-0.5 font-mono text-[10px] text-fg-2">
              v{item.version}
            </span>
          </div>

          {item.status === "pending" ? (
            canNod ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openNod({ mode: "single", item });
                }}
                title={guidance?.nodButtonLabel}
                className="flex items-center gap-1 rounded-md border border-accent-soft bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <ThumbsUp className="h-2.5 w-2.5" />
                点头
              </button>
            ) : (
              <span
                title="该条目没有 Agent 建议"
                className="cursor-not-allowed rounded-md border border-border bg-bg-2 px-2 py-0.5 text-[10px] text-fg-3"
              >
                无建议
              </span>
            )
          ) : (
            <span className={`font-mono text-[10px] ${statusView.className}`}>
              {statusView.label}
            </span>
          )}
        </div>

        {/* Downstream child nodes branching to the right */}
        {children.length > 0 && (
          <div className="flex items-center">
            <div className="h-px w-5 shrink-0 bg-border" />
            <div className="flex flex-col justify-center">
              {children.map((child, cIdx) =>
                renderMindMapSubtree(child, cIdx, children.length),
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <ToolcraftDialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
      width={880}
    >
      <div className="flex max-h-[84vh] flex-col" data-workbench-modal="true">
        <ToolcraftDialogHeader
          title="横向血缘思维导图"
          subtitle="左→右空间层级即上下游衍生关系 · 节点前置版本链即返工次数"
          startContent={<Network className="h-4 w-4 text-accent" />}
          onOpenChange={(open) => {
            if (!open) requestClose();
          }}
        />

        {/* 2D horizontal branching canvas */}
        <div className="min-h-0 flex-1 overflow-auto bg-stage-bg p-8">
          {items.length === 0 ? (
            <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 text-center">
              <Network className="h-6 w-6 text-fg-3" />
              <p className="text-sm font-semibold text-fg-2">
                当前批次没有条目
              </p>
              <p className="text-xs text-fg-3">
                批次暂无内容,等待导入或 Agent 挂载衍生节点
              </p>
            </div>
          ) : !hasAnyLineage ? (
            <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 text-center">
              <Network className="h-6 w-6 text-fg-3" />
              <p className="text-sm font-semibold text-fg-2">暂无谱系记录</p>
              <p className="max-w-md text-xs leading-5 text-fg-3">
                当前批次的 {items.length}{" "}
                条条目都没有上游谱系信息;只有由 Agent
                挂载的衍生节点才会形成血缘分支,这里不虚构谱系。
              </p>
            </div>
          ) : (
            <div className="flex min-w-max items-center">
              {/* Batch root on the far left */}
              <div className="flex shrink-0 items-center gap-2 rounded-xl border-2 border-accent bg-bg-2 px-4 py-2.5 text-fg shadow-md">
                <FolderGit2 className="h-4 w-4 text-accent" />
                <span className="whitespace-nowrap text-xs font-bold">
                  {batch?.name ?? "当前批次"}
                </span>
              </div>

              {/* Stem from the batch root to the base branches */}
              <div className="h-px w-7 shrink-0 bg-border" />

              <div className="flex flex-col justify-center">
                {branches.map((branch, bIdx) => {
                  const isFirstBranch = bIdx === 0;
                  const isLastBranch = bIdx === branches.length - 1;
                  const isOnlyBranch = branches.length === 1;

                  return (
                    <div
                      key={branch.id}
                      className="relative flex items-center py-4"
                    >
                      {/* Spine connecting the batch root to the branches */}
                      {!isOnlyBranch && (
                        <div
                          className={`absolute left-0 w-px bg-border ${
                            isFirstBranch
                              ? "bottom-0 top-1/2"
                              : isLastBranch
                                ? "bottom-1/2 top-0"
                                : "bottom-0 top-0"
                          }`}
                        />
                      )}

                      <div className="h-px w-6 shrink-0 bg-border" />

                      {/* Base source pill */}
                      <div
                        title={
                          branch.isUngrouped
                            ? "没有谱系信息的条目"
                            : undefined
                        }
                        className={`flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ${
                          branch.isUngrouped
                            ? "border-border bg-bg-1 text-fg-2"
                            : "border-border-strong bg-bg-2 text-fg"
                        }`}
                      >
                        <Layers
                          className={`h-3.5 w-3.5 shrink-0 ${
                            branch.isUngrouped ? "text-fg-3" : "text-accent"
                          }`}
                        />
                        <span className="whitespace-nowrap">
                          {branch.baseName}
                        </span>
                        {!branch.isUngrouped &&
                          branch.nodablePendingItems.length > 0 && (
                            <button
                              onClick={() =>
                                openNod({
                                  mode: "group",
                                  items: branch.nodablePendingItems,
                                })
                              }
                              className="ml-1 flex items-center gap-1 rounded border border-accent-soft bg-accent-soft px-2 py-0.5 text-[10px] text-accent transition-colors hover:bg-accent hover:text-accent-foreground"
                              title="整支一键点头"
                            >
                              <ThumbsUp className="h-2.5 w-2.5" />
                              {branch.nodablePendingItems.length}
                            </button>
                          )}
                      </div>

                      {/* Stem from the base pill to the asset subtrees */}
                      <div className="h-px w-6 shrink-0 bg-border" />

                      <div className="flex flex-col justify-center">
                        {branch.roots.map((rootNode, rIdx) =>
                          renderMindMapSubtree(
                            rootNode,
                            rIdx,
                            branch.roots.length,
                          ),
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Nod confirmation: lists every entry, its suggested decision and
            the modification that will execute before anything is committed. */}
        {nodRequest && (
          <div className="shrink-0 border-t border-border bg-bg-1 px-5 py-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <ThumbsUp className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="text-xs font-semibold text-fg">
                {nodRequest.mode === "single"
                  ? "确认单项点头"
                  : `确认整枝点头(${nodRequest.items.length} 项)`}
              </span>
              <span className="text-[11px] text-fg-3">
                点头按每条的建议决定执行;「修改后保留」需要真实内容修改,由控制器落地。
              </span>
            </div>

            <div className="mb-3 max-h-40 space-y-1.5 overflow-y-auto">
              {nodListItems.map((item) => {
                const guidance = item.agentGuidance;
                if (!guidance) return null;
                return (
                  <div
                    key={item.id}
                    className="flex items-start gap-2 rounded-lg border border-border bg-bg-2 px-2.5 py-1.5"
                  >
                    <span className="mt-0.5 shrink-0">
                      {getWorkbenchTypeIcon(item.type)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-medium text-fg">
                          {guidance.nodeSlotLabel}
                        </span>
                        <span className="shrink-0 rounded border border-border bg-bg px-1 font-mono text-[10px] text-fg-3">
                          v{item.version}
                        </span>
                        <span className="shrink-0 text-[11px] text-accent">
                          建议决定:{DECISION_LABELS[guidance.nodDecision]}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] leading-4 text-fg-2">
                        将执行:{guidance.whatToDoNext}
                      </div>
                      <div className="text-[11px] leading-4 text-fg-3">
                        背景:{guidance.whatHappened}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {nodError && (
              <div className="mb-2 text-[11px] text-status-error">
                执行失败:{nodError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setNodRequest(null)}
                disabled={nodBusy}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-fg-2 transition-colors hover:bg-bg-2 hover:text-fg disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={() => void confirmNod()}
                disabled={nodBusy}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent-strong disabled:opacity-50"
              >
                {nodBusy
                  ? "执行中…"
                  : nodRequest.mode === "single"
                    ? "确认点头"
                    : `确认点头(${nodRequest.items.length} 项)`}
              </button>
            </div>
          </div>
        )}
      </div>
    </ToolcraftDialog>
  );
}
