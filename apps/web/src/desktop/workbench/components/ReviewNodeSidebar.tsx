import type { JSX, ReactNode } from "react";
import type React from "react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import type { ReviewGroup, ReviewNode } from "@reelterminal/core/review/types";
import type { DirectoryCommand } from "../../../services/review-workspace/directory";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
} from "@reelterminal/ui";
import { wbButton } from "../wb-button";
import { reviewSeenKey, useReviewSeenStore } from "../../../stores/review-seen-store";

export type DirectoryView = "recent" | "pinned" | "archived" | "trash";

export interface ReviewNodeSidebarProps {
  open: boolean;
  onToggleOpen: (open: boolean) => void;
  nodes: readonly ReviewNode[];
  selectedId: string | null;
  onSelectNode: (nodeId: string) => void;
  onUpdateNode: (nodeId: string, patch: Extract<DirectoryCommand, { kind: "node.update" }>["patch"]) => void;
  onRenameNode: (node: ReviewNode) => void;
  onPurgeNode: (node: ReviewNode) => void;
  onBranches?: (node: ReviewNode) => void;
  onCopyInstructions?: (node: ReviewNode) => Promise<void>;
  copiedNodeId?: string | null;
  directory: {
    groups: readonly ReviewGroup[];
    canUndo: boolean;
    canRedo: boolean;
  };
  view: DirectoryView;
  onSelectView: (view: DirectoryView) => void;
  query: string;
  onQueryChange: (query: string) => void;
  groupId: string;
  onSelectGroup: (groupId: string) => void;
  onCreateNode: (name: string) => Promise<void>;
  onCreateGroup: (name: string) => Promise<void>;
  onRenameGroup: (groupId: string) => void;
  onRemoveGroup: (groupId: string) => void;
  onDirectoryHistory: (direction: "undo" | "redo") => void;
  cursor?: string;
  onLoadMore?: () => void;
  busy: boolean;
}

const compactIconButton = "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded p-1 text-fg-2 hover:bg-bg-2 hover:text-fg disabled:opacity-40";

const textEntry = (element: Element | null) =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLElement && element.isContentEditable);

export function ReviewNodeSidebar({
  open,
  onToggleOpen,
  nodes,
  selectedId,
  onSelectNode,
  onUpdateNode,
  onRenameNode,
  onPurgeNode,
  onBranches,
  onCopyInstructions,
  copiedNodeId,
  directory,
  view,
  onSelectView,
  query,
  onQueryChange,
  groupId,
  onSelectGroup,
  onCreateNode,
  onCreateGroup,
  onRenameGroup,
  onRemoveGroup,
  onDirectoryHistory,
  cursor,
  onLoadMore,
  busy,
}: ReviewNodeSidebarProps): JSX.Element {
  const { t } = useTranslation();
  const seen = useReviewSeenStore(state => state.seen);
  const [creatingNode, setCreatingNode] = useState(false);
  const [newNodeName, setNewNodeName] = useState("");
  const [managingGroups, setManagingGroups] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const nodeInputRef = useRef<HTMLInputElement>(null);
  const hasActiveFilter = Boolean(query) || view !== "recent" || Boolean(groupId) || managingGroups;
  const showFilterDrawer = filtersOpen || hasActiveFilter;

  const menuItems = (node: ReviewNode, context: boolean) => {
    const Item = context ? ContextMenuItem : DropdownMenuItem;
    const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
    const Sub = context ? ContextMenuSub : DropdownMenuSub;
    const SubTrigger = context ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
    const SubContent = context ? ContextMenuSubContent : DropdownMenuSubContent;
    return <>
        <Item disabled={busy} onSelect={() => onRenameNode(node)}>{t("review.rename")}</Item>
        <Sub><SubTrigger disabled={busy}>{t("review.moveToGroup")}</SubTrigger><SubContent>
          <Item onSelect={() => onUpdateNode(node.id, { groupId: null })}>{t("review.ungrouped")}</Item>
          {directory.groups.map(group => <Item key={group.id} onSelect={() => onUpdateNode(node.id, { groupId: group.id })}>{group.name}</Item>)}
        </SubContent></Sub>
        <Item disabled={busy} onSelect={() => onUpdateNode(node.id, { pinned: !node.pinned })}>
          {t(node.pinned ? "review.unpin" : "review.pin")}
        </Item>
        {!node.trashedAt && <Item disabled={busy} onSelect={() => onUpdateNode(node.id, { archived: !node.archivedAt })}>
          {t(node.archivedAt ? "review.unarchive" : "review.archive")}
        </Item>}
        {onCopyInstructions && !node.trashedAt && <Item onSelect={() => { void onCopyInstructions(node); }}>{t(copiedNodeId === node.id ? "review.copied" : "review.copyTaskInstructions", { name: node.name })}</Item>}
        {onBranches && <Item disabled={busy} onSelect={() => onBranches(node)} data-testid="review-branches-open">查看历史任务关联</Item>}
        <Separator />
        <Item disabled={busy} onSelect={() => onUpdateNode(node.id, { trashed: !node.trashedAt })}>
          {t(node.trashedAt ? "review.restore" : "review.moveToTrash")}
        </Item>
        {node.trashedAt && <Item disabled={busy} className="text-status-error focus:text-status-error" onSelect={() => onPurgeNode(node)}>
          {t("review.purge.title")}
        </Item>}
    </>;
  };
  const taskMenu = (node: ReviewNode, children: ReactNode) => (
    <ContextMenu key={node.id}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">{menuItems(node, true)}</ContextMenuContent>
    </ContextMenu>
  );

  // Keyboard shortcut trapping for directory undo/redo
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (
      textEntry(event.target as Element) ||
      !(event.ctrlKey || event.metaKey) ||
      event.altKey
    ) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    event.preventDefault();
    event.stopPropagation();
    onDirectoryHistory(key === "y" || event.shiftKey ? "redo" : "undo");
  };

  // Collapsed state: 48px icon strip
  if (!open) {
    return (
      <aside
        className="flex w-12 shrink-0 flex-col items-center gap-3 border-r border-border bg-bg-1 py-2.5 select-none"
        data-review-directory="true"
        onKeyDownCapture={handleKeyDown}
      >
        <button
          type="button"
          className={wbButton.ghost}
          onClick={() => onToggleOpen(true)}
          title={t("review.expandSidebar", "展开审阅任务侧栏")}
          aria-label={t("review.expandSidebar", "展开审阅任务侧栏")}
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={wbButton.ghost}
          onClick={() => {
            onToggleOpen(true);
            setCreatingNode(true);
          }}
          data-testid="review-new-task"
          title={t("review.newNode")}
          aria-label={t("review.newNode", "新建节点")}
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={wbButton.ghost}
          onClick={() => {
            onToggleOpen(true);
            setFiltersOpen(true);
            setTimeout(() => searchRef.current?.focus(), 50);
          }}
          title={t("review.searchNodes")}
          aria-label={t("review.searchNodes")}
        >
          <Search className="h-4 w-4" />
        </button>
        <div className="h-px w-6 bg-border" />
        <span className="text-[11px] font-bold text-fg-3">{nodes.length}</span>

        <div
          className="flex flex-col items-center gap-1.5 overflow-y-auto w-full px-1 pt-0.5"
          data-testid="review-node-list"
        >
          {nodes.map((node) => {
            const isCurrent = selectedId === node.id;
            return taskMenu(node, (
              <button
                key={node.id}
                type="button"
                className={`flex h-7 w-7 items-center justify-center rounded-[6px] border text-[11px] font-semibold transition-colors ${
                  isCurrent
                    ? "border-accent/60 bg-accent/15 text-accent"
                    : "border-border bg-bg-2 text-fg-3 hover:border-border-strong hover:text-fg"
                }`}
                onClick={() => onSelectNode(node.id)}
                title={node.name}
                aria-label={node.name}
              >
                <span aria-hidden="true">{node.name.slice(0, 1)}</span>
                <span className="sr-only">{node.name}</span>
              </button>
            ));
          })}
        </div>
      </aside>
    );
  }

  // Expanded state: compact structured sidebar
  return (
    <aside
      className="flex w-[208px] shrink-0 flex-col gap-1.5 border-r border-border bg-bg-1 p-2 text-xs"
      data-review-directory="true"
      onKeyDownCapture={handleKeyDown}
    >
      {/* 1. Header row (all actions iconified on one line) */}
      <div className="flex h-7 items-center justify-between px-1">
        <span className="shrink-0 font-semibold text-fg">{t("review.nodes")}</span>
        <div className="flex items-center gap-0.5">
          {!creatingNode && (
            <button
              type="button"
              className={compactIconButton}
              data-testid="review-new-task"
              onClick={() => setCreatingNode(true)}
              title={t("review.newNode")}
              aria-label={t("review.newNode")}
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="sr-only">{t("review.newNode")}</span>
            </button>
          )}
          <button
            type="button"
            className={`${compactIconButton} ${hasActiveFilter ? "text-accent" : ""}`}
            onClick={() => {
              setFiltersOpen((v) => !v);
              if (!filtersOpen) setTimeout(() => searchRef.current?.focus(), 30);
            }}
            title={t("review.searchNodes")}
            aria-label={t("review.searchNodes")}
            aria-expanded={showFilterDrawer}
          >
            <Search className="h-3.5 w-3.5" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={compactIconButton}
                title={t("review.undoDirectory")}
                aria-label={t("review.undoDirectory")}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-36">
              <DropdownMenuItem
                disabled={busy || !directory.canUndo}
                onSelect={() => onDirectoryHistory("undo")}
              >
                {t("review.undoDirectory")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={busy || !directory.canRedo}
                onSelect={() => onDirectoryHistory("redo")}
              >
                {t("review.redo")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setManagingGroups((v) => !v)}>
                {t(managingGroups ? "review.finishGroupManagement" : "review.manageGroups")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            className={compactIconButton}
            onClick={() => onToggleOpen(false)}
            title={t("review.collapseSidebar", "收起侧栏")}
            aria-label={t("review.collapseSidebar", "收起侧栏")}
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Create a task only when requested. */}
      {creatingNode && <form
        className="flex items-center gap-1 px-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (!newNodeName.trim()) return;
          void onCreateNode(newNodeName).then(() => {
            setNewNodeName("");
            setCreatingNode(false);
          });
        }}
      >
        <input
          ref={nodeInputRef}
          autoFocus={creatingNode}
          className="flex-1 min-w-0 rounded-[6px] border border-border bg-bg-2 px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
          aria-label={t("review.newNodeName")}
          placeholder={t("review.newNodeName")}
          maxLength={200}
          value={newNodeName}
          onChange={(event) => setNewNodeName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setCreatingNode(false);
              setNewNodeName("");
            }
          }}
        />
        <button
          type="submit"
          className={`${wbButton.primary} shrink-0`}
          disabled={busy || !newNodeName.trim()}
          data-testid="review-create-node"
        >
          {t("review.create")}
        </button>
        <button
          type="button"
          className={wbButton.ghost}
          onClick={() => {
            setCreatingNode(false);
            setNewNodeName("");
          }}
        >
          {t("review.cancel")}
        </button>
      </form>}

      {/* 3 & 4 & 5. On-demand Filter/Search/Groups Drawer */}
      <div className={showFilterDrawer ? "space-y-1.5" : "sr-only"}>
        <div className="relative px-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-fg-3 pointer-events-none" />
          <input
            ref={searchRef}
            type="search"
            className="w-full rounded-[6px] border border-border bg-bg-2 pl-7 pr-2 py-1 text-xs text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none"
            value={query}
            maxLength={500}
            onChange={(event) => onQueryChange(event.target.value)}
            aria-label={t("review.searchNodes")}
            placeholder={t("review.searchNodes")}
          />
        </div>

        <div className="grid grid-cols-4 gap-0.5 rounded-[6px] border border-border bg-bg-1 p-0.5 text-xs select-none">
          {(["recent", "pinned", "archived", "trash"] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={`inline-flex h-6 items-center justify-center rounded-[4px] px-1 text-[11px] font-medium transition-colors ${
                view === item
                  ? "bg-bg-3 text-fg font-semibold shadow-sm"
                  : "text-fg-3 hover:text-fg-2"
              }`}
              aria-pressed={view === item}
              onClick={() => {
                onSelectView(item);
                onSelectGroup("");
              }}
            >
              {t(`review.${item}`)}
            </button>
          ))}
        </div>

        {(directory.groups.length > 0 || managingGroups) && (
          <div className="space-y-1 border-t border-border pt-1">
            <div className="flex h-6 items-center justify-between px-1">
              <span className="text-[11px] font-medium text-fg-3">
                {t("review.groups")}
              </span>
              <button
                type="button"
                className={wbButton.ghost}
                onClick={() => setManagingGroups((v) => !v)}
                aria-expanded={managingGroups}
              >
                {t(managingGroups ? "review.finishGroupManagement" : "review.manageGroups")}
              </button>
            </div>

            {managingGroups && (
              <form
                className="flex items-center gap-1 px-1 mb-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!newGroupName.trim()) return;
                  void onCreateGroup(newGroupName).then(() => {
                    setNewGroupName("");
                  });
                }}
              >
                <input
                  autoFocus
                  className="flex-1 min-w-0 rounded-[4px] border border-border bg-bg-2 px-1.5 py-0.5 text-xs text-fg focus:border-accent focus:outline-none"
                  aria-label={t("review.newGroupName")}
                  placeholder={t("review.newGroupName")}
                  value={newGroupName}
                  maxLength={200}
                  onChange={(event) => setNewGroupName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setManagingGroups(false);
                  }}
                />
                <button
                  type="submit"
                  disabled={busy || !newGroupName.trim()}
                  className={`${wbButton.secondary} h-6 px-2 text-[11px] shrink-0`}
                >
                  {t("review.create")}
                </button>
              </form>
            )}

            {directory.groups.length > 0 && <div className="flex max-h-24 flex-col gap-0.5 overflow-y-auto px-0.5">
              <button
                type="button"
                onClick={() => {
                  onSelectGroup("");
                  onSelectView("recent");
                }}
                className={`flex items-center justify-between rounded px-1.5 py-1 text-left text-xs transition-colors ${
                  !groupId
                    ? "bg-bg-2 text-accent font-medium"
                    : "text-fg-2 hover:bg-bg-2/50"
                }`}
              >
                <span>{t("review.allGroups")}</span>
              </button>
              {directory.groups.map((group) => {
                const isSelected = groupId === group.id;
                return (
                  <div
                    key={group.id}
                    className={`group flex items-center justify-between rounded px-1.5 py-1 text-xs transition-colors ${
                      isSelected
                        ? "bg-bg-2 text-accent font-medium"
                        : "text-fg-2 hover:bg-bg-2/50"
                    }`}
                  >
                    <button
                      type="button"
                      className="flex-1 min-w-0 truncate text-left"
                      onClick={() => {
                        onSelectGroup(group.id);
                        onSelectView("recent");
                      }}
                    >
                      {group.name}
                    </button>
                    {managingGroups && (
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          className="rounded p-0.5 text-fg-3 hover:text-fg"
                          onClick={() => onRenameGroup(group.id)}
                          title={t("review.renameGroup")}
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          className="rounded p-0.5 text-status-error/80 hover:text-status-error"
                          onClick={() => onRemoveGroup(group.id)}
                          title={t("review.removeEmptyGroup")}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>}
          </div>
        )}
      </div>

      {/* 6. Node List */}
      <div className="flex flex-1 min-h-0 flex-col border-t border-border pt-1">
        <div
          className="flex-1 overflow-y-auto space-y-0.5"
          data-testid="review-node-list"
        >
          {nodes.map((node) => {
            const isCurrent = selectedId === node.id;
            return taskMenu(node, (
              <div key={node.id} className="group relative">
                <button
                  type="button"
                  className={`w-full flex min-w-0 flex-col rounded pl-2 pr-8 py-1.5 text-left transition-colors border-l-2 ${
                    isCurrent
                      ? "border-l-accent bg-bg-2 text-fg shadow-sm"
                      : "border-l-transparent text-fg-2 hover:bg-bg-2/60"
                  }`}
                  onClick={() => onSelectNode(node.id)}
                  aria-current={isCurrent ? "true" : undefined}
                >
                  <span
                    className="max-w-full truncate text-xs font-medium"
                    title={node.name}
                  >
                    {node.pinned ? "★ " : ""}
                    {node.name}
                    {(node.incomingRevision ?? 0) > (seen[reviewSeenKey(node.id, "node")] ?? 0) && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent" aria-label="有未查看的新内容" />}
                  </span>
                  <span className="text-[10px] text-fg-3">
                    {new Date(node.updatedAt).toLocaleDateString()}
                  </span>
                </button>
                <DropdownMenu><DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={`${compactIconButton} absolute right-1 top-1`}
                    title={t("review.nodeMenu")}
                    aria-label={`${node.name} · ${t("review.nodeMenu")}`}
                    data-testid="review-node-menu-trigger"
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger><DropdownMenuContent align="start" className="w-52">{menuItems(node, false)}</DropdownMenuContent></DropdownMenu>
              </div>
            ));
          })}
          {!nodes.length && (
            <p className="px-2 py-4 text-center text-xs text-fg-3">
              {t("review.noNodesInView")}
            </p>
          )}
          {cursor && (
            <button
              type="button"
              className={`${wbButton.ghost} w-full text-center mt-1`}
              onClick={onLoadMore}
            >
              {t("review.loadMore")}
            </button>
          )}
        </div>
      </div>
      <button type="button" className="flex items-center gap-2 border-t border-border px-2 py-2 text-xs text-fg-2 hover:text-fg" aria-label="打开回收站" onClick={() => { onSelectView("trash"); onSelectGroup(""); }}>
        <Trash2 className="h-3.5 w-3.5" />{t("review.trash")}
      </button>
    </aside>
  );
}

export default ReviewNodeSidebar;
