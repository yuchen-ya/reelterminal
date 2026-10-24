import type { JSX, ReactNode } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, PanelLeftOpen } from "lucide-react";
import type { ReviewContext, ReviewGroup, ReviewNode } from "@reelterminal/core/review/types";
import type { DirectoryCommand } from "../../../services/review-workspace/directory";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@reelterminal/ui";
import { wbButton } from "../wb-button";

export interface ReviewNodeHeaderProps {
  node: ReviewNode | null;
  groups: readonly ReviewGroup[];
  sidebarOpen: boolean;
  onToggleSidebar: (open: boolean) => void;
  onUpdateNode?: (patch: Extract<DirectoryCommand, { kind: "node.update" }>["patch"]) => void;
  onRenameNode?: () => void;
  onPurgeNode?: () => void;
  view?: "content" | "process";
  stepCount?: number;
  onSelectView?: (view: "content" | "process") => void;
  canAttach?: boolean;
  attachTitle?: string;
  onAttach?: () => void;
  canExport?: boolean;
  onExport?: () => void;
  context: ReviewContext | null;
  busy: boolean;
  onToggleAccess: (event: React.ChangeEvent<HTMLInputElement>) => void;
  adminMenu: ReactNode;
}

export function ReviewNodeHeader({
  node,
  groups,
  sidebarOpen,
  onToggleSidebar,
  onUpdateNode,
  onRenameNode,
  onPurgeNode,
  view,
  stepCount = 0,
  onSelectView,
  canAttach = false,
  attachTitle,
  onAttach,
  canExport = false,
  onExport,
  context,
  busy,
  onToggleAccess,
  adminMenu,
}: ReviewNodeHeaderProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-bg-1 px-3">
      {/* 1. 侧栏展开按钮（仅侧栏收起时显示） */}
      {!sidebarOpen && (
        <button
          type="button"
          className={wbButton.ghost}
          onClick={() => onToggleSidebar(true)}
          title={t("review.expandSidebar", "展开数据节点侧栏")}
          aria-label={t("review.expandSidebar", "展开数据节点侧栏")}
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
      )}

      {node ? (
        <>
          {/* 2. 节点名 + ▾ 操作菜单 */}
          <div className="flex min-w-0 items-center gap-1">
            <h1
              className="truncate text-sm font-semibold text-fg max-w-[240px]"
              data-testid="review-node-title"
              data-node-id={node.id}
              title={node.name}
            >
              {node.pinned ? "★ " : ""}
              {node.name}
            </h1>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={wbButton.ghost}
                  data-testid="review-node-menu-trigger"
                  aria-label={t("review.nodeMenu", "节点操作")}
                  title={t("review.nodeMenu", "节点操作")}
                >
                  <ChevronDown className="h-3.5 w-3.5 text-fg-3 hover:text-fg" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    {t("review.moveToGroup")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-44">
                    <DropdownMenuItem
                      onSelect={() => onUpdateNode?.({ groupId: null })}
                    >
                      {t("review.ungrouped")}
                    </DropdownMenuItem>
                    {groups.map((group) => (
                      <DropdownMenuItem
                        key={group.id}
                        onSelect={() => onUpdateNode?.({ groupId: group.id })}
                      >
                        {group.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem onSelect={onRenameNode}>
                  {t("review.rename")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => onUpdateNode?.({ pinned: !node.pinned })}
                >
                  {t(node.pinned ? "review.unpin" : "review.pin")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => onUpdateNode?.({ archived: !node.archivedAt })}
                >
                  {t(node.archivedAt ? "review.unarchive" : "review.archive")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => onUpdateNode?.({ trashed: !node.trashedAt })}
                >
                  {t(node.trashedAt ? "review.restore" : "review.moveToTrash")}
                </DropdownMenuItem>
                {node.trashedAt && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-status-error focus:text-status-error"
                      data-testid="review-purge-open"
                      onSelect={onPurgeNode}
                    >
                      {t("review.purge.title")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* 3. 「内容 | 处理过程(n)」分段控件 */}
          {view && onSelectView && (
            <div
              className={wbButton.segmentedContainer}
              role="group"
              aria-label={t("review.process.title")}
            >
              <button
                type="button"
                className={wbButton.segmentedItem(view === "content")}
                aria-pressed={view === "content"}
                onClick={() => onSelectView("content")}
                data-testid="review-content-tab"
              >
                {t("review.process.content")}
              </button>
              <button
                type="button"
                className={wbButton.segmentedItem(view === "process")}
                aria-pressed={view === "process"}
                onClick={() => onSelectView("process")}
                data-testid="review-process-tab"
              >
                {t("review.process.title")} ({stepCount})
              </button>
            </div>
          )}
        </>
      ) : (
        <strong className="text-xs font-semibold">{t("review.title")}</strong>
      )}

      {/* 4. 弹性空白 */}
      <div className="flex-1" />

      {/* 5. 添加采用版本到项目 (ghost) */}
      {node && onAttach && (
        <button
          type="button"
          className={wbButton.ghost}
          title={attachTitle}
          disabled={!canAttach}
          onClick={onAttach}
          data-testid="review-attach-open"
        >
          {t("review.attach.title")}
        </button>
      )}

      {/* 6. 导出文件 (secondary) */}
      {node && onExport && (
        <button
          type="button"
          className={wbButton.secondary}
          disabled={!canExport}
          onClick={onExport}
          data-testid="review-export-open"
        >
          {t("review.export.title")}
        </button>
      )}

      {/* 7. Agent 徽章 (绿点可写 / 灰点只读) */}
      <label
        className={`relative inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-xs transition-colors cursor-pointer select-none ${
          context?.access === "write"
            ? "border border-accent/60 bg-accent/10 text-accent font-medium"
            : "border border-border bg-bg-2 text-fg-3 hover:text-fg-2"
        }`}
        data-testid="review-access-status"
      >
        <input
          type="checkbox"
          className="absolute inset-0 opacity-0 cursor-pointer z-10"
          disabled={!context || busy}
          checked={context?.access === "write"}
          data-testid="review-access-toggle"
          onChange={onToggleAccess}
        />
        <span
          className={`pointer-events-none h-1.5 w-1.5 rounded-full ${
            context?.access === "write" ? "bg-accent" : "bg-fg-3"
          }`}
        />
        <span className="pointer-events-none">
          {t(
            context?.access === "write"
              ? "review.agentWrite"
              : "review.agentRead",
          )}
        </span>
      </label>

      {/* 8. ⋯ 管理菜单 */}
      {adminMenu}
    </div>
  );
}

export default ReviewNodeHeader;
