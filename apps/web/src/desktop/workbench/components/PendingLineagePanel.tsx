/**
 * PendingLineagePanel — lineage tree of the active review batch.
 *
 * Renders a compact, node-oriented hierarchy over the controller's visible items.
 * Parent nodes support two roles:
 * - "board" (聚合画板父节点): collapsed by default into a single node; clicking
 *   opens all child items together on the AdaptiveBoardWorkspace.
 * - "category" (分类父节点): expanded by default as a directory folder.
 */
import { Fragment, useMemo, useState } from "react";
import {
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  FolderTree,
  LayoutGrid,
  X,
} from "lucide-react";
import type {
  SelectModifiers,
  WorkbenchItemView,
  WorkbenchMutationResult,
} from "../types";
import {
  buildWorkbenchLineageGroups,
  collectGroupItems,
  collectSubtreeItems,
  getWorkbenchStatusView,
  getWorkbenchTypeIcon,
  type WorkbenchLineageGroup,
  type WorkbenchLineageNode,
} from "./lineage-tree-utils";

/** Tree-scoped status filter; the actual filtering happens in the controller. */
export type LineageTreeFilter = "all" | "pending" | "rework_chain";

export interface SelectedBoardScope {
  readonly id: string;
  readonly title: string;
  readonly itemIds: readonly string[];
}

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
  /** Currently active parent board id when viewing an AdaptiveBoardWorkspace. */
  readonly activeBoardId?: string | null;
  /** Shift/Ctrl modifier semantics are resolved by the controller. */
  readonly onSelectItem: (itemId: string, modifiers: SelectModifiers) => void;
  /** Open a parent node or group in the AdaptiveBoardWorkspace. */
  readonly onSelectBoard?: (board: SelectedBoardScope) => void;
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
const UNGROUPED_LABEL = "本批内容";

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
  activeBoardId,
  onSelectItem,
  onSelectBoard,
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

  // Recursive tree node renderer — compact node geometry, no banner chrome.
  const renderTreeNode = (node: WorkbenchLineageNode, isLast: boolean) => {
    const { item, children } = node;
    const hasChildren = children.length > 0;
    const isBoardParent = hasChildren && node.mode !== "category";
    const boardScopeId = `node:${item.id}`;
    const isBoardActive = activeBoardId === boardScopeId;
    const isCurrent = isBoardActive || (!activeBoardId && currentItem?.id === item.id);
    const isSelected = selectedIds.includes(item.id);
    const isContextOnly = contextOnlySet.has(item.id);
    const isArchived = item.status !== "pending";

    // Board parent nodes default to collapsed (acting as a single aggregated node);
    // category parent nodes default to expanded.
    const isParentCollapsed =
      collapsedParents[item.id] ?? (isBoardParent ? true : false);
    const failStreak = item.lineage?.failStreak ?? 0;
    const priorSteps = item.lineage
      ? item.lineage.steps.slice(0, -1)
      : [];
    const showVersionBadge = item.version > 1 || priorSteps.length > 0;
    const statusView = getWorkbenchStatusView(item.status);
    const label = item.agentGuidance?.nodeSlotLabel ?? item.title;
    const triageGroup = item.agentGuidance?.triageGroup;
    const subtreeItems = hasChildren ? collectSubtreeItems(node) : [item];

    const rowTone = isCurrent
      ? "bg-accent/12 text-fg font-medium ring-1 ring-accent/35"
      : isSelected
        ? "bg-bg-2/80 text-fg ring-1 ring-border-strong"
        : isContextOnly
          ? "cursor-default text-fg-3"
          : isArchived
            ? "text-fg-3/85 hover:text-fg-2 hover:bg-bg-2/40"
            : failStreak >= 2
              ? "bg-status-warning/10 text-fg hover:bg-status-warning/15"
              : "text-fg-2 hover:bg-bg-2/45 hover:text-fg";

    return (
      <div key={item.id} className="relative">
        {/* Vertical continuation line for siblings below this node */}
        {item.lineage && !isLast && (
          <div className="pointer-events-none absolute bottom-0 left-1.5 top-0 w-px bg-border/70" />
        )}
        {/* Elbow connector from the parent spine into this node */}
        {item.lineage && (
          <div className="pointer-events-none absolute left-1.5 top-0 h-3 w-1.5 rounded-bl border-b border-l border-border-strong/80" />
        )}

        <div className={`py-px ${item.lineage ? "pl-3" : ""}`}>
          <div
            onClick={
              isContextOnly
                ? undefined
                : (e) => {
                    if (hasChildren && isBoardParent && onSelectBoard && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                      onSelectBoard({
                        id: boardScopeId,
                        title: label,
                        itemIds: subtreeItems.map((i) => i.id),
                      });
                      return;
                    }
                    onSelectItem(item.id, {
                      shift: e.shiftKey,
                      ctrl: e.ctrlKey,
                      meta: e.metaKey,
                    });
                  }
            }
            className={`group relative flex min-h-[24px] items-center justify-between gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] leading-4 transition-colors ${
              isContextOnly ? "cursor-default" : "cursor-pointer"
            } ${rowTone}`}
            title={
              isContextOnly
                ? "上下文节点:仅用于保持树结构,不匹配当前筛选"
                : hasChildren && isBoardParent
                  ? `${label} (聚合画板 · 共 ${subtreeItems.length} 项)`
                  : label
            }
          >
            {/* Compact node accent marker on left */}
            {isCurrent && (
              <div className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent" />
            )}
            {isSelected && !isCurrent && (
              <div className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent/50" />
            )}

            {/* Left: optional collapse toggle + type/board icon + concise node label */}
            <div className="flex min-w-0 items-center gap-1">
              {hasChildren && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCollapsedParents((prev) => ({
                      ...prev,
                      [item.id]: !isParentCollapsed,
                    }));
                  }}
                  className="-ml-0.5 shrink-0 rounded p-0.5 text-fg-3 hover:text-fg"
                  title={
                    isParentCollapsed ? "展开子节点" : "收拢子节点"
                  }
                >
                  {isParentCollapsed ? (
                    <ChevronRight className="h-3 w-3" />
                  ) : (
                    <ChevronDown className="h-3 w-3 text-accent" />
                  )}
                </button>
              )}
              {hasChildren && isBoardParent ? (
                <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-accent" />
              ) : (
                getWorkbenchTypeIcon(item.type)
              )}
              <span className="truncate font-medium">{label}</span>
              {hasChildren && (
                <span className="shrink-0 rounded bg-bg-3 px-1 font-mono text-[9px] leading-3.5 text-fg-3">
                  {subtreeItems.length}
                </span>
              )}
            </div>

            {/* Right: version chain (only when > v1) + compact status dot / hover retrieve */}
            <div className="flex shrink-0 items-center gap-1">
              {showVersionBadge && (
                <div
                  className="flex items-center gap-0.5 font-mono text-[9px]"
                  title={
                    item.lineage && item.lineage.steps.length > 0
                      ? item.lineage.steps.map((s) => s.summary).join(" → ")
                      : undefined
                  }
                >
                  {priorSteps.map((step) => (
                    <Fragment key={step.version}>
                      <span
                        className={`rounded border px-0.5 text-[9px] leading-3.5 ${
                          step.outcome === "rejected"
                            ? "border-rose-500/40 bg-rose-950/70 text-rose-300"
                            : "border-sky-500/30 bg-sky-950/60 text-sky-300"
                        }`}
                      >
                        v{step.version}
                        {step.outcome === "rejected" ? "✕" : "改"}
                      </span>
                      <span className="text-[8px] text-fg-3">─</span>
                    </Fragment>
                  ))}
                  <span className="rounded bg-bg-2 px-1 text-[9px] leading-3.5 font-semibold text-fg-2">
                    v{item.version}
                  </span>
                </div>
              )}

              {item.status === "pending" ? (
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
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
                <div className="flex shrink-0 items-center gap-0.5">
                  {item.status === "rework" ? (
                    <span
                      className={`font-mono text-[10px] leading-none ${statusView.className} group-hover:hidden`}
                    >
                      {statusView.label}
                    </span>
                  ) : (
                    <>
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusView.dotClassName} group-hover:hidden`}
                        title={statusView.label}
                      />
                      <span className="sr-only">{statusView.label}</span>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRetrieve(item.id);
                    }}
                    disabled={retrievingId === item.id}
                    className="hidden rounded p-0.5 text-fg-3 hover:bg-bg-3 hover:text-fg disabled:opacity-50 group-hover:inline-flex"
                    title={`取回重审 (${statusView.label})`}
                  >
                    <ArchiveRestore className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Nested downstream children */}
          {hasChildren && !isParentCollapsed && (
            <div className="relative ml-1 mt-px">
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

      {/* Multi-level tree hierarchy (compact node style) */}
      <div className="flex-1 select-none space-y-1 overflow-y-auto p-1.5">
        {sourceTrees.length === 0 && (
          <div className="px-2.5 py-6 text-center">
            <p className="text-xs text-fg-2">当前筛选下没有可见条目</p>
            <p className="mt-1 text-[11px] text-fg-3">
              可见范围由检索与筛选状态决定
            </p>
          </div>
        )}
        {sourceTrees.map((group) => {
          const isBoardGroup = !group.isUngrouped && group.mode === "board";
          const isCollapsed =
            collapsedBases[group.id] ?? (isBoardGroup ? true : false);
          const groupScopeId = `group:${group.id}`;
          const isGroupBoardActive = activeBoardId === groupScopeId;
          const groupItems = collectGroupItems(group);
          const pendingGroupCount = groupItems.filter(
            (i) => i.status === "pending",
          ).length;

          return (
            <div key={group.id} className="space-y-px">
              <div
                className={`group flex min-h-[24px] w-full items-center justify-between gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] font-semibold transition-colors ${
                  isGroupBoardActive
                    ? "bg-accent/12 text-fg ring-1 ring-accent/35"
                    : group.isUngrouped
                      ? "text-fg-3 hover:bg-bg-2/50 hover:text-fg-2"
                      : "text-fg hover:bg-bg-2/60"
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (isBoardGroup && onSelectBoard) {
                      onSelectBoard({
                        id: groupScopeId,
                        title: group.baseName,
                        itemIds: groupItems.map((i) => i.id),
                      });
                      return;
                    }
                    setCollapsedBases((prev) => ({
                      ...prev,
                      [group.id]: !isCollapsed,
                    }));
                  }}
                  title={
                    group.isUngrouped
                      ? "这些条目属于当前批次，尚未记录条目间的来源关系"
                      : isBoardGroup
                        ? `${group.baseName} (聚合画板父节点 · 点击打开画板)`
                        : `${group.baseName} (分类父节点 · 点击折叠/展开)`
                  }
                  className="flex min-w-0 flex-1 items-center gap-1 text-left"
                >
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      setCollapsedBases((prev) => ({
                        ...prev,
                        [group.id]: !isCollapsed,
                      }));
                    }}
                    className="shrink-0 rounded p-0.5 text-fg-3 hover:text-fg"
                    title={isCollapsed ? "展开分类子项" : "收拢分类子项"}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3 w-3 text-fg-3" />
                    ) : (
                      <ChevronDown
                        className={`h-3 w-3 ${
                          group.isUngrouped ? "text-fg-3" : "text-accent"
                        }`}
                      />
                    )}
                  </span>
                  {isBoardGroup ? (
                    <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-accent" />
                  ) : (
                    <FolderTree
                      className={`h-3.5 w-3.5 shrink-0 ${
                        group.isUngrouped ? "text-fg-3" : "text-accent/80"
                      }`}
                    />
                  )}
                  <span className="truncate">{group.baseName}</span>
                  <span className="ml-0.5 shrink-0 font-mono text-[10px] font-normal text-fg-3">
                    ({group.totalCount})
                  </span>
                </button>

                <div className="flex shrink-0 items-center gap-1">
                  {onSelectBoard && group.totalCount > 1 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectBoard({
                          id: groupScopeId,
                          title: group.baseName,
                          itemIds: groupItems.map((i) => i.id),
                        });
                      }}
                      className={`rounded p-0.5 transition-opacity ${
                        isGroupBoardActive
                          ? "text-accent opacity-100"
                          : "text-fg-3 opacity-0 hover:bg-bg-3 hover:text-fg group-hover:opacity-100"
                      }`}
                      title="在聚合画板中同屏查看此父节点下全部条目"
                      data-testid={`open-group-board-${group.id}`}
                    >
                      <LayoutGrid className="h-3 w-3" />
                    </button>
                  )}
                  {pendingGroupCount > 0 && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                      title={`待审 ${pendingGroupCount} 项`}
                    />
                  )}
                </div>
              </div>

              {!isCollapsed && (
                <div className="relative ml-1">
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
