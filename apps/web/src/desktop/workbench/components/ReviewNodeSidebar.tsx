import type { JSX } from "react";
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
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@reelterminal/ui";
import { wbButton } from "../wb-button";

export type DirectoryView = "recent" | "pinned" | "archived" | "trash";

export interface ReviewNodeSidebarProps {
  open: boolean;
  onToggleOpen: (open: boolean) => void;
  nodes: readonly ReviewNode[];
  selectedId: string | null;
  onSelectNode: (nodeId: string) => void;
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
  const [creatingNode, setCreatingNode] = useState(false);
  const [newNodeName, setNewNodeName] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const nodeInputRef = useRef<HTMLInputElement>(null);

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
          title={t("review.expandSidebar", "展开数据节点侧栏")}
          aria-label={t("review.expandSidebar", "展开数据节点侧栏")}
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={wbButton.ghost}
          onClick={() => {
            onToggleOpen(true);
            setCreatingNode(true);
            setTimeout(() => nodeInputRef.current?.focus(), 50);
          }}
          title={t("review.newNode", "新建节点")}
          aria-label={t("review.newNode", "新建节点")}
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={wbButton.ghost}
          onClick={() => {
            onToggleOpen(true);
            setTimeout(() => searchRef.current?.focus(), 50);
          }}
          title={t("review.searchNodes")}
          aria-label={t("review.searchNodes")}
        >
          <Search className="h-4 w-4" />
        </button>
        <div className="h-px w-6 bg-border" />
        <span className="text-[11px] font-bold text-fg-3">{nodes.length}</span>
      </aside>
    );
  }

  // Expanded state: 240px structured sidebar
  return (
    <aside
      className="flex w-[240px] shrink-0 flex-col gap-2 border-r border-border bg-bg-1 p-2 text-xs"
      data-review-directory="true"
      onKeyDownCapture={handleKeyDown}
    >
      {/* 1. Header row */}
      <div className="flex h-7 items-center justify-between px-1">
        <span className="font-semibold text-fg">{t("review.nodes")}</span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className={wbButton.ghost}
            onClick={() => {
              setCreatingNode((v) => !v);
              setTimeout(() => nodeInputRef.current?.focus(), 50);
            }}
            title={t("review.newNode", "新建节点")}
            aria-label={t("review.newNode", "新建节点")}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={wbButton.ghost}
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
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            className={wbButton.ghost}
            onClick={() => onToggleOpen(false)}
            title={t("review.collapseSidebar", "收起侧栏")}
            aria-label={t("review.collapseSidebar", "收起侧栏")}
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 2. Inline node creation form */}
      {(creatingNode || !nodes.length) && (
        <form
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
              if (event.key === "Escape" && nodes.length > 0) {
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
        </form>
      )}

      {/* 3. Search box */}
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

      {/* 4. Segmented view switchers */}
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

      {/* 5. Groups section */}
      <div className="space-y-1 border-t border-border pt-1">
        <div className="flex h-6 items-center justify-between px-1">
          <span className="text-[11px] font-medium text-fg-3">
            {t("review.groups")}
          </span>
          <button
            type="button"
            className={wbButton.ghost}
            onClick={() => setCreatingGroup((v) => !v)}
            title={t("review.newGroupName")}
            aria-label={t("review.newGroupName")}
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>

        {creatingGroup && (
          <form
            className="flex items-center gap-1 px-1 mb-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (!newGroupName.trim()) return;
              void onCreateGroup(newGroupName).then(() => {
                setNewGroupName("");
                setCreatingGroup(false);
              });
            }}
          >
            <input
              autoFocus
              className="flex-1 min-w-0 rounded-[4px] border border-border bg-bg-2 px-1.5 py-0.5 text-xs text-fg focus:border-accent focus:outline-none"
              placeholder={t("review.newGroupName")}
              value={newGroupName}
              maxLength={200}
              onChange={(event) => setNewGroupName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setCreatingGroup(false);
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

        <div className="flex max-h-24 flex-col gap-0.5 overflow-y-auto px-0.5">
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
                {isSelected && (
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
        </div>
      </div>

      {/* 6. Node List */}
      <div className="flex flex-1 min-h-0 flex-col border-t border-border pt-1">
        <div
          className="flex-1 overflow-y-auto space-y-0.5"
          data-testid="review-node-list"
        >
          {nodes.map((node) => {
            const isCurrent = selectedId === node.id;
            return (
              <button
                key={node.id}
                type="button"
                className={`w-full flex flex-col rounded px-2 py-1.5 text-left transition-colors border-l-2 ${
                  isCurrent
                    ? "border-l-accent bg-bg-2 text-fg shadow-sm"
                    : "border-l-transparent text-fg-2 hover:bg-bg-2/60"
                }`}
                onClick={() => onSelectNode(node.id)}
                aria-current={isCurrent ? "true" : undefined}
              >
                <span
                  className="truncate text-xs font-medium"
                  title={node.name}
                >
                  {node.pinned ? "★ " : ""}
                  {node.name}
                </span>
                <span className="text-[10px] text-fg-3">
                  {new Date(node.updatedAt).toLocaleDateString()}
                </span>
              </button>
            );
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
    </aside>
  );
}

export default ReviewNodeSidebar;
