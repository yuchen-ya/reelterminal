import type { JSX } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { Bot, Download, GitBranch, Layers } from "lucide-react";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@reelterminal/ui";
import { wbButton } from "../wb-button";

export interface ReviewNodeHeaderProps {
  node: ReviewNode | null;
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
  browserDemo?: boolean;
}

export function ReviewNodeHeader({
  node,
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
  browserDemo = false,
}: ReviewNodeHeaderProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-bg-1 px-2.5">
      {node ? (
        <>
          {/* 当前任务；打开与管理入口位于顶部标签栏。 */}
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
                <span>{t("review.process.content")}</span>
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
                <span>
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
      {!browserDemo && <label
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
        <span className="pointer-events-none">
          {t(
            context?.access === "write"
              ? "review.agentWrite"
              : "review.agentRead",
          )}
        </span>
      </label>}

    </div>
  );
}

export default ReviewNodeHeader;
