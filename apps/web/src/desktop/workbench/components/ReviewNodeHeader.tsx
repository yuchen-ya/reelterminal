import type { JSX, ReactNode } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { Bot, ChevronDown, Download, GitBranch, Layers } from "lucide-react";
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
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-bg-1 px-2.5">
      {node ? (
        <>
          {/* 节点名 + ▾ 操作菜单 */}
          <div className="flex min-w-0 items-center gap-0.5">
            <h1
              className="truncate text-xs font-semibold text-fg max-w-[220px]"
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

          {/* 「内容 | 处理过程(n)」紧凑图标切换 */}
          {view && onSelectView && (
            <div
              className="inline-flex h-6 items-center gap-0.5 rounded-[5px] border border-border bg-bg-2 p-0.5"
              role="group"
              aria-label={t("review.process.title")}
            >
              <button
                type="button"
                className={`inline-flex h-5 items-center gap-1 rounded-[4px] px-1.5 text-[11px] transition-colors ${
                  view === "content"
                    ? "bg-bg-3 font-medium text-fg shadow-xs"
                    : "text-fg-3 hover:text-fg"
                }`}
                aria-pressed={view === "content"}
                onClick={() => onSelectView("content")}
                data-testid="review-content-tab"
                title={t("review.process.content")}
              >
                <Layers className="h-3 w-3" />
                <span className="sr-only">{t("review.process.content")}</span>
              </button>
              <button
                type="button"
                className={`inline-flex h-5 items-center gap-1 rounded-[4px] px-1.5 text-[11px] transition-colors ${
                  view === "process"
                    ? "bg-bg-3 font-medium text-fg shadow-xs"
                    : "text-fg-3 hover:text-fg"
                }`}
                aria-pressed={view === "process"}
                onClick={() => onSelectView("process")}
                data-testid="review-process-tab"
                title={`${t("review.process.title")} (${stepCount})`}
              >
                <GitBranch className="h-3 w-3" />
                {stepCount > 0 && <span className="font-mono text-[10px]">{stepCount}</span>}
                <span className="sr-only">
                  {t("review.process.title")} ({stepCount})
                </span>
              </button>
            </div>
          )}
        </>
      ) : (
        <strong className="text-xs font-semibold">{t("review.title")}</strong>
      )}

      {/* 弹性空白 */}
      <div className="flex-1" />

      {node && (onExport || onAttach) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={wbButton.ghost}
              data-testid="review-export-menu-trigger"
              title={t("review.exportMenu")}
              aria-label={t("review.exportMenu")}
            >
              <Download className="h-3.5 w-3.5" />
              <span className="sr-only">{t("review.exportMenu")}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onExport && (
              <DropdownMenuItem disabled={!canExport} onSelect={onExport} data-testid="review-export-open">
                {t("review.export.title")}
              </DropdownMenuItem>
            )}
            {onAttach && (
              <DropdownMenuItem disabled={!canAttach} onSelect={onAttach} title={attachTitle} data-testid="review-attach-open">
                {t("review.attach.title")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Agent 权限极简图标徽章 (绿点可写 / 灰点只读) */}
      <label
        title={`${t("review.agentAccessLabel")} · ${t(
          context?.access === "write" ? "review.agentWrite" : "review.agentRead",
        )}`}
        className={`relative inline-flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-xs transition-colors cursor-pointer select-none ${
          context?.access === "write"
            ? "border border-accent/60 bg-accent/10 text-accent font-medium"
            : "border border-border bg-bg-2 text-fg-3 hover:text-fg-2"
        }`}
        data-testid="review-access-status"
      >
        <input
          type="checkbox"
          aria-label={t("review.agentAccessLabel")}
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
        <Bot className="pointer-events-none h-3.5 w-3.5" />
        <span className="sr-only">
          {t(
            context?.access === "write"
              ? "review.agentWrite"
              : "review.agentRead",
          )}
        </span>
      </label>

      {/* ⋯ 管理菜单 */}
      {adminMenu}
    </div>
  );
}

export default ReviewNodeHeader;
