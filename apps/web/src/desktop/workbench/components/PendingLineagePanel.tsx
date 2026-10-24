/**
 * PendingLineagePanel — lineage tree of the active review batch.
 *
 * Migrated from the prototype `AgentMindMapTreePanel`. The tree is a pure
 * read-only presentation layer over the items the controller made visible:
 * it groups, folds and renders, but never filters. Real `parentNodeId`
 * references draw parent/child edges; items without lineage land in an
 * explicit "未分组" section and no edges are fabricated. Ancestor/context
 * nodes rendered only to keep tree shape are excluded from the selectable
 * scope.
 */
import { Fragment, useMemo, useState } from "react";
import {
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Layers,
  X,
} from "lucide-react";
import type {
  SelectModifiers,
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

/** Tree-scoped status filter; the actual filtering happens in the controller. */
export type LineageTreeFilter = "all" | "pending" | "rework_chain";

export interface PendingLineagePanelProps {
  /**
   * Items visible under the controller's current filter + search. The tree
   * renders exactly this set — it never applies filter semantics of its own.
   */
  readonly items: readonly WorkbenchItemView[];
  readonly currentItem: WorkbenchItemView | null;
  readonly selectedIds: readonly string[];
  /**
   * Ids present in `items` only to keep the ancestor chain visible; they are
   * rendered but never enter the selectable scope.
   */
  readonly contextOnlyIds?: readonly string[];
  /** Shift/Ctrl modifier semantics are resolved by the controller. */
  readonly onSelectItem: (itemId: string, modifiers: SelectModifiers) => void;
  /**
   * Only offered for already-processed items. May return void when the
   * caller reports the outcome (e.g. a toast); when a mutation result is
   * returned, failures are surfaced inline.
   */
  readonly onRetrieveItem: (
    itemId: string,
  ) => void | Promise<WorkbenchMutationResult>;
}

interface TreeGroup extends WorkbenchLineageGroup {
  totalCount: number;
}

const UNGROUPED_GROUP_ID = "__ungrouped__";
const UNGROUPED_LABEL = "未分组";

function buildTreeGroups(items: readonly WorkbenchItemView[]): TreeGroup[] {
  const countSubtree = (entry: WorkbenchLineageNode): number =>
    1 + entry.children.reduce((acc, child) => acc + countSubtree(child), 0);
  return buildWorkbenchLineageGroups(items, {
    ungroupedId: UNGROUPED_GROUP_ID,
    ungroupedLabel: UNGROUPED_LABEL,
  }).map((group) => ({
    ...group,
    totalCount: group.roots.reduce((acc, root) => acc + countSubtree(root), 0),
  }));
}

export function PendingLineagePanel({
  items,
  currentItem,
  selectedIds,
  contextOnlyIds,
  onSelectItem,
  onRetrieveItem,
}: PendingLineagePanelProps) {
  const [collapsedBases, setCollapsedBases] = useState<
    Record<string, boolean>
  >({});
  const [collapsedParents, setCollapsedParents] = useState<
    Record<string, boolean>
  >({});
  const [retrieveError, setRetrieveError] = useState<string | null>(null);
  const [retrievingId, setRetrievingId] = useState<string | null>(null);

  const contextOnlySet = useMemo(
    () => new Set(contextOnlyIds ?? []),
    [contextOnlyIds],
  );
  const sourceTrees = useMemo(() => buildTreeGroups(items), [items]);

  const handleRetrieve = (itemId: string): void => {
    setRetrievingId(itemId);
    setRetrieveError(null);
    Promise.resolve(onRetrieveItem(itemId))
      .then((outcome) => {
        if (outcome && !outcome.ok) {
          setRetrieveError(outcome.message);
        }
      })
      .catch((error: unknown) => {
        setRetrieveError(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        setRetrievingId(null);
      });
  };

  // Recursive tree node renderer — positional/graphical hierarchy only.
  const renderTreeNode = (node: WorkbenchLineageNode, isLast: boolean) => {
    const { item, children } = node;
    const isCurrent = currentItem?.id === item.id;
    const isSelected = selectedIds.includes(item.id);
    const isContextOnly = contextOnlySet.has(item.id);
    const isArchived = item.status !== "pending";
    const hasChildren = children.length > 0;
    const isParentCollapsed = !!collapsedParents[item.id];
    const failStreak = item.lineage?.failStreak ?? 0;
    const priorSteps = item.lineage
      ? item.lineage.steps.slice(0, -1)
      : [];
    const statusView = getWorkbenchStatusView(item.status);
    const label = item.agentGuidance?.nodeSlotLabel ?? item.title;
    const triageGroup = item.agentGuidance?.triageGroup;

    const rowTone = isCurrent
      ? "bg-bg-2 text-fg font-medium shadow-xs"
      : isSelected
        ? "bg-bg-2/80 text-fg"
        : isContextOnly
          ? "cursor-default text-fg-3"
          : isArchived
            ? "text-fg-3 opacity-70 hover:opacity-100 hover:bg-bg-2/50"
            : failStreak >= 2
              ? "bg-status-warning/10 text-fg hover:bg-status-warning/15"
              : "text-fg-2 hover:bg-bg-2/50 hover:text-fg";

    return (
      <div key={item.id} className="relative">
        {/* Vertical continuation line for siblings below this node */}
        {!isLast && (
          <div className="pointer-events-none absolute bottom-0 left-2 top-0 w-px bg-border" />
        )}
        {/* Elbow connector from the parent spine into this node */}
        <div className="pointer-events-none absolute left-2 top-0 h-3.5 w-2 rounded-bl border-b border-l border-border-strong" />

        <div className="py-0.5 pl-4">
          <div
            onClick={
              isContextOnly
                ? undefined
                : (e) =>
                    onSelectItem(item.id, {
                      shift: e.shiftKey,
                      ctrl: e.ctrlKey,
                      meta: e.metaKey,
                    })
            }
            className={`group relative flex items-center justify-between gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
              isContextOnly ? "cursor-default" : "cursor-pointer"
            } ${rowTone}`}
            title={
              isContextOnly
                ? "上下文节点:仅用于保持树结构,不匹配当前筛选"
                : undefined
            }
          >
            {/* Active / selected indicator bar on left */}
            {isCurrent && (
              <div className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full bg-accent" />
            )}
            {isSelected && !isCurrent && (
              <div className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full bg-accent/50" />
            )}

            {/* Left: optional collapse toggle + type icon + node label */}
            <div className="flex min-w-0 items-center gap-1.5">
              {hasChildren && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCollapsedParents((prev) => ({
                      ...prev,
                      [item.id]: !prev[item.id],
                    }));
                  }}
                  className="-ml-1 shrink-0 rounded p-0.5 text-fg-3 hover:text-fg"
                  title={
                    isParentCollapsed ? "展开下游衍生节点" : "折叠下游衍生节点"
                  }
                >
                  {isParentCollapsed ? (
                    <ChevronRight className="h-3 w-3" />
                  ) : (
                    <ChevronDown className="h-3 w-3 text-accent" />
                  )}
                </button>
              )}
              {getWorkbenchTypeIcon(item.type)}
              <span className="truncate text-xs font-medium">{label}</span>
            </div>

            {/* Right: graphical version chain + status dot / archive badge */}
            <div className="flex shrink-0 items-center gap-1.5">
              <div
                className="flex items-center gap-0.5 font-mono text-[10px]"
                title={
                  item.lineage && item.lineage.steps.length > 0
                    ? item.lineage.steps.map((s) => s.summary).join(" → ")
                    : undefined
                }
              >
                {priorSteps.map((step) => (
                  <Fragment key={step.version}>
                    <span
                      className={`rounded border px-1 text-[9px] leading-4 ${
                        step.outcome === "rejected"
                          ? "border-rose-500/40 bg-rose-950/70 text-rose-300"
                          : "border-sky-500/30 bg-sky-950/60 text-sky-300"
                      }`}
                    >
                      v{step.version}
                      {step.outcome === "rejected" ? "✕" : "改"}
                    </span>
                    <span className="text-[9px] text-fg-3">─</span>
                  </Fragment>
                ))}
                <span
                  className={`rounded px-1 text-[10px] leading-4 ${
                    priorSteps.length > 0
                      ? "bg-bg-2 font-semibold text-fg-2"
                      : "text-fg-3"
                  }`}
                >
                  v{item.version}
                </span>
              </div>

              {item.status === "pending" ? (
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    failStreak >= 2
                      ? "bg-status-error ring-2 ring-status-error/30"
                      : triageGroup === "need_verdict"
                        ? "bg-status-warning"
                        : triageGroup === "ready_patch"
                          ? "bg-status-info"
                          : "bg-accent"
                  }`}
                />
              ) : (
                <div className="flex shrink-0 items-center gap-1">
                  <span className={`font-mono text-[10px] ${statusView.className}`}>
                    {statusView.label}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRetrieve(item.id);
                    }}
                    disabled={retrievingId === item.id}
                    className="p-0.5 text-fg-3 hover:text-fg disabled:opacity-50"
                    title="取回重审"
                  >
                    <ArchiveRestore className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Nested downstream children */}
          {hasChildren && !isParentCollapsed && (
            <div className="relative ml-1.5 mt-0.5">
              {children.map((child, idx) =>
                renderTreeNode(child, idx === children.length - 1),
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {retrieveError && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-status-error/10 px-2.5 py-1.5">
          <span className="truncate text-[11px] text-status-error">
            取回失败:{retrieveError}
          </span>
          <button
            type="button"
            onClick={() => setRetrieveError(null)}
            className="shrink-0 text-fg-3 hover:text-fg"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Multi-level tree hierarchy (position + iconography = up/downstream) */}
      <div className="flex-1 select-none space-y-2 overflow-y-auto p-2">
        {sourceTrees.length === 0 && (
          <div className="px-2.5 py-6 text-center">
            <p className="text-xs text-fg-2">当前筛选下没有可见条目</p>
            <p className="mt-1 text-[11px] text-fg-3">
              可见范围由检索与筛选状态决定
            </p>
          </div>
        )}
        {sourceTrees.map((group) => {
          const isCollapsed = !!collapsedBases[group.id];

          return (
            <div key={group.id} className="space-y-0.5">
              {/* Root base node (icon + name; ungrouped items have no lineage) */}
              <button
                type="button"
                onClick={() =>
                  setCollapsedBases((prev) => ({
                    ...prev,
                    [group.id]: !prev[group.id],
                  }))
                }
                title={group.isUngrouped ? "没有谱系信息的条目" : undefined}
                className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-xs font-semibold transition-colors ${
                  group.isUngrouped
                    ? "text-fg-3 hover:bg-bg-2 hover:text-fg-2"
                    : "text-fg hover:bg-bg-2"
                }`}
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3.5 w-3.5 text-fg-3" />
                ) : (
                  <ChevronDown
                    className={`h-3.5 w-3.5 ${
                      group.isUngrouped ? "text-fg-3" : "text-accent"
                    }`}
                  />
                )}
                <Layers
                  className={`h-3.5 w-3.5 shrink-0 ${
                    group.isUngrouped ? "text-fg-3" : "text-accent"
                  }`}
                />
                <span className="truncate">{group.baseName}</span>
                <span className="ml-0.5 font-mono text-[10px] text-fg-3">
                  ({group.totalCount})
                </span>
              </button>

              {!isCollapsed && (
                <div className="relative ml-1.5">
                  {group.roots.map((rootNode, idx) =>
                    renderTreeNode(rootNode, idx === group.roots.length - 1),
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
