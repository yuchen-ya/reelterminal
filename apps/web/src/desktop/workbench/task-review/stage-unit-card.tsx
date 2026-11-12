import { t } from "../../../i18n";
import type { JSX, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Copy } from "lucide-react";
import type {
  TaskDecisionStatus,
  TaskReviewSnapshot,
  TaskTextReviewUnit,
} from "../../../../../desktop/src/shared/task-review";
import { sourcePath, sourceTitle, statusLabels } from "./display";
import { issuesForUnit, unitDecisionState } from "./queries";
import { useHoverTip } from "./task-tooltip";

/**
 * 舞台条目卡（纯展示，只消费 props）。
 * 移植自 Review Workbench v1 设计稿 `TaskReviewWorkspace.renderStageUnitCard`：
 * 元信息行（#序号大号 mono + 来源 + 行号 + 时间）｜复制按钮 + 保留/返工/丢弃
 * 三联决定 pill｜原文 blockquote + 深玫红证据高亮｜返工改稿预览条｜一行式疑点 callout。
 * 媒体画布不在本卡内（媒体条目由宿主用 MediaScene 渲染）。
 *
 * 设计原则：
 * - 原地定夺：三联 pill 点击只回调 onDecide，不跳走、不推进场景；
 * - 零延迟提示：复制按钮与 pill 组挂 useHoverTip（bindTip）；
 * - compareMode 下点击卡片本体把焦点切到该条（onFocus），内部按钮区 stopPropagation。
 */

const formatTime = (ms: number) => {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

/** 深玫红半透明底 + 亮粉白字 + 2px 玫红下划线的证据高亮（设计稿 renderHighlightedText）。 */
function renderHighlightedText(text: string, evidence?: string): ReactNode {
  if (!evidence || !text.includes(evidence)) {
    return <span>{text}</span>;
  }
  const idx = text.indexOf(evidence);
  const before = text.slice(0, idx);
  const after = text.slice(idx + evidence.length);
  return (
    <>
      <span>{before}</span>
      <span className="mx-0.5 inline rounded bg-rose-500/25 px-1.5 py-0.5 font-semibold text-rose-100 underline decoration-rose-400 decoration-2 underline-offset-4">
        {evidence}
      </span>
      <span>{after}</span>
    </>
  );
}

const pillDetails: Record<TaskDecisionStatus, string> = {
  get kept() { return t("Keep the original dialogue unchanged (stay on this page)"); },
  get rework() { return t("Mark for rework / accept revised dialogue (stay on this page)"); },
  get discarded() { return t("Mark as discarded; automatically exclude from export"); },
};

const pillActiveClasses: Record<TaskDecisionStatus, string> = {
  kept: "bg-accent font-bold text-accent-fg",
  rework: "bg-amber-400 font-bold text-black",
  discarded: "bg-zinc-500 font-bold text-white",
};

export function StageUnitCard({
  snapshot,
  unit,
  purpose,
  busy,
  stale,
  focused,
  compareMode,
  analysisKnown,
  focusTestId,
  focusActive,
  onFocus,
  onCopyText,
  onDecide,
}: {
  snapshot: TaskReviewSnapshot;
  /** 仅文本条目；媒体条目由宿主用 MediaScene 渲染。 */
  unit: TaskTextReviewUnit;
  purpose: string;
  /** 全局写入串行队列忙。 */
  busy: boolean;
  /** 来源版本已过期（currentSourceIds 不含）。 */
  stale: boolean;
  /** 聚光灯焦点卡：翠绿边框 + 大号序号着色。 */
  focused: boolean;
  /** 对照场景：点击卡片本体可把焦点切到该条。 */
  compareMode: boolean;
  /** Agent 已完成当前口径分析。 */
  analysisKnown: boolean;
  /** 对照场景的聚焦按钮（#序号按钮）testid；提供时元信息行变为聚焦按钮。 */
  focusTestId?: string;
  /** 聚焦按钮的 aria-pressed 状态。 */
  focusActive?: boolean;
  onFocus?: () => void;
  /** 头部复制按钮（复制替换词优先，否则原文）。 */
  onCopyText: (text: string) => void;
  /** 三联 pill：原地定夺，不跳走、不推进。 */
  onDecide: (status: TaskDecisionStatus) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { tipNode, bindTip } = useHoverTip();
  const decision = unitDecisionState(snapshot, unit.id, purpose);
  const issues = issuesForUnit(snapshot, unit.id, purpose);
  const primaryIssue = issues[0];
  const source = snapshot.sources.find((item) => item.id === unit.sourceVersionId);

  return (
    <article
      onClick={() => {
        if (compareMode) onFocus?.();
      }}
      className={`flex flex-col gap-2.5 rounded-lg border p-3.5 transition-colors ${
        compareMode ? "cursor-pointer" : ""
      } ${
        focused
          ? "border-accent/80 bg-bg-1"
          : "border-border bg-bg-1/70 hover:border-fg-3"
      }`}
      data-testid="task-review-scene-target"
      data-unit-id={unit.id}
    >
      {tipNode}

      {stale && (
        <p
          role="status"
          className="rounded border border-status-error/50 p-2 text-xs text-status-error"
          data-testid="task-review-stale-source"
        >
          {t("This scene uses a stale or unavailable source version. The old draft is preserved for reference; open the current version from the overview to review again.")}
        </p>
      )}
      {!stale && !analysisKnown && (
        <p className="text-xs text-fg-3" data-testid="task-review-risk-unknown">
          {t("Risk unknown: this item has not been analyzed under the current criteria. Manual review is still available.")}
        </p>
      )}

      {/* 元信息行 + 复制按钮 + 三联决定 pill */}
      <div className="flex items-center justify-between gap-2">
        {focusTestId ? (() => {
          const metadata = (
            <>
              <span
                className={`shrink-0 font-mono text-sm font-bold ${
                  focused ? "text-accent" : "text-fg"
                }`}
                data-testid="task-review-unit-title"
              >
                #{unit.ordinal}
              </span>
              {source && (
                <span
                  className="min-w-0 truncate"
                  title={sourcePath(snapshot.root, source.relativePath)}
                >
                  {sourceTitle(source.relativePath)}
                </span>
              )}
              <span className="shrink-0">
                {t("Lines {{start}}–{{end}}", { start: unit.startLine, end: unit.endLine })}
              </span>
              {unit.startMs !== undefined && (
                <span className="shrink-0 font-mono text-[11px]">
                  {formatTime(unit.startMs)}
                </span>
              )}
            </>
          );
          return (
            <button
              type="button"
              data-testid={focusTestId}
              aria-pressed={focusActive ?? false}
              onClick={(event) => {
                event.stopPropagation();
                onFocus?.();
              }}
              {...bindTip(
                t("Focus #{{v0}}", { v0: unit.ordinal }),
                t("Move reading focus to this item without changing any decisions"),
              )}
              className="flex min-w-0 items-center gap-2 rounded text-left text-xs text-fg-3 tabular-nums transition-colors hover:text-fg"
            >
              {metadata}
            </button>
          );
        })() : (
          <div className="flex min-w-0 items-center gap-2 text-xs text-fg-3 tabular-nums">
            <span
              className={`shrink-0 font-mono text-sm font-bold ${
                focused ? "text-accent" : "text-fg"
              }`}
              data-testid="task-review-unit-title"
            >
              #{unit.ordinal}
            </span>
            {source && (
              <span
                className="min-w-0 truncate"
                title={sourcePath(snapshot.root, source.relativePath)}
              >
                {sourceTitle(source.relativePath)}
              </span>
            )}
            <span className="shrink-0">
              {t("Lines {{start}}–{{end}}", { start: unit.startLine, end: unit.endLine })}
            </span>
            {unit.startMs !== undefined && (
              <span className="shrink-0 font-mono text-[11px]">
                {formatTime(unit.startMs)}
              </span>
            )}
          </div>
        )}

        <div
          className="flex shrink-0 items-center gap-1"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => onCopyText(decision.replacementText ?? unit.text)}
            {...bindTip(
              t("Copy text of #{{v0}}", { v0: unit.ordinal }),
              t("Copy this dialogue item to the clipboard"),
            )}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-fg-3 hover:bg-bg-2 hover:text-fg"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>

          {/* 原地决定：三联 pill 不跳走、不推进 */}
          <div
            className="inline-flex items-center rounded border border-border bg-bg-2 p-0.5"
            data-testid="task-review-unit-status"
          >
            {(["kept", "rework", "discarded"] as const).map((status) => {
              const active = decision.status === status;
              return (
                <button
                  key={status}
                  type="button"
                  disabled={busy || stale}
                  aria-pressed={active}
                  onClick={() => onDecide(status)}
                  {...bindTip(
                    t("Set #{{v0}} to \"{{v1}}\"", { v0: unit.ordinal, v1: statusLabels[status] }),
                    pillDetails[status],
                  )}
                  className={`cursor-pointer rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                    active
                      ? pillActiveClasses[status]
                      : "text-fg-3 hover:text-fg"
                  } disabled:cursor-not-allowed disabled:opacity-40`}
                  data-testid={`task-review-decide-${status}`}
                >
                  {statusLabels[status]}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* 原文 + 首个疑点证据的深玫红高亮 */}
      <blockquote
        className="select-text whitespace-pre-wrap break-words rounded-md bg-bg-2 px-3.5 py-2.5 text-[15px] font-medium leading-relaxed text-fg"
        data-testid="task-review-unit-text"
      >
        {renderHighlightedText(unit.text, primaryIssue?.evidence)}
      </blockquote>

      {/* 返工改稿预览条 */}
      {decision.status === "rework" && decision.replacementText !== undefined && decision.replacementText !== "" && (
        <div
          className="flex items-start gap-2 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100"
          data-testid="task-review-rework-preview"
        >
          <span className="mt-0.5 shrink-0 font-mono text-[11px] font-bold text-amber-300">
            {t("Rework draft →")}</span>
          <span>{decision.replacementText}</span>
        </div>
      )}

      {/* 一行式疑点 callout（简报；完整疑点卡 task-review-issue 由舞台承载，同 testid 全页唯一） */}
      {primaryIssue && (
        <div
          className="flex items-center gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs"
          data-testid="task-review-issue-brief"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400" />
          <span className="min-w-0 truncate font-medium text-rose-200">
            {primaryIssue.title}
          </span>
        </div>
      )}
    </article>
  );
}
