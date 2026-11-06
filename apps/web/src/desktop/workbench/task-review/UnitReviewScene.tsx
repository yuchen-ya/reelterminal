import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  TaskDecisionStatus,
  TaskReviewSnapshot,
  TaskTextReviewUnit,
} from "../../../../../desktop/src/shared/task-review";
import { isTextTaskUnit } from "../../../../../desktop/src/shared/task-review";
import type { TaskCriteriaScope } from "../../../../../desktop/src/shared/task-review-context";
import type { TaskAgentBridge, TaskAgentState } from "../../../../../desktop/src/shared/task-review-runtime-types";
import { FeedbackEditor } from "./FeedbackEditor";
import { useSceneScroll, viewKey } from "./view-state";
import { analyzedUnitIds } from "./useTaskAgentState";
import { sourceTitle, sourcePath } from "./display";
import { wbButton } from "../wb-button";
import type { DraftEntry } from "./useTaskDrafts";
import type { MutationResult } from "./useTaskReviewController";
import { CriteriaAdoptionForm } from "./TaskContextPanel";
import { currentSourceIds, issuesForUnit, planStepForUnit, unitDecisionState } from "./queries";

export const statusLabels: Record<TaskDecisionStatus, string> = {
  kept: "保留",
  rework: "返工",
  discarded: "丢弃",
};

const severityLabels = { high: "高风险", medium: "中风险", low: "低风险" } as const;

const formatTime = (ms: number) => {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

/**
 * Node review scene. The original unit text is immutable; the reviewer
 * records one explicit decision at a time for this unit only. Undo/redo
 * change the decision stack and are distinct from timeline navigation.
 */
export function UnitReviewScene({
  snapshot,
  unit,
  draft,
  busy,
  onUpdateDraft,
  onDecide,
  onDecideAndContinue,
  onUndo,
  onRedo,
  onOpenEdit,
  agent,
  agentState,
  criteriaAvailable,
  onAdoptCriteria,
  purpose = "review",
  feedbackOnly = false,
}: {
  snapshot: TaskReviewSnapshot;
  unit: TaskTextReviewUnit;
  draft: DraftEntry | undefined;
  busy: boolean;
  onUpdateDraft: (patch: {
    text?: string;
    selectionStart?: number;
    selectionEnd?: number;
  }) => void;
  onDecide: (status: TaskDecisionStatus, replacementText?: string) => void;
  onDecideAndContinue: (status: TaskDecisionStatus, replacementText?: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onOpenEdit: () => void;
  agent: TaskAgentBridge | null;
  agentState: TaskAgentState | null;
  purpose?: string;
  feedbackOnly?: boolean;
  criteriaAvailable: boolean;
  onAdoptCriteria: (input: {
    content: string;
    scope: TaskCriteriaScope;
    purpose: string;
    origin: { kind: "explicit"; text: string } | { kind: "feedback"; decisionId: string };
  }) => Promise<MutationResult>;
}) {
  const { t } = useTranslation();
  const scroll = useSceneScroll<HTMLDivElement>(`${viewKey(snapshot.root, snapshot.taskId)}:unit:${unit.id}`);
  const stale = !currentSourceIds(snapshot).has(unit.sourceVersionId);
  const decision = unitDecisionState(snapshot, unit.id, purpose);
  const issues = issuesForUnit(snapshot, unit.id, purpose);
  const plan = planStepForUnit(snapshot, unit.id);
  const source = snapshot.sources.find((item) => item.id === unit.sourceVersionId);
  const previous = snapshot.units.filter(isTextTaskUnit).find((item) => item.sourceVersionId === unit.sourceVersionId && item.ordinal === unit.ordinal - 1);
  const next = snapshot.units.filter(isTextTaskUnit).find((item) => item.sourceVersionId === unit.sourceVersionId && item.ordinal === unit.ordinal + 1);
  const analyzed = analyzedUnitIds(snapshot, agentState).has(unit.id);
  const subtitle = unit.startMs !== undefined && unit.endMs !== undefined;
  const [editingSource, setEditingSource] = useState(false);
  const [replacement, setReplacement] = useState(decision.replacementText ?? "");
  useEffect(() => setReplacement(decision.replacementText ?? ""), [decision.replacementText]);

  // A rework replacement is explicit reviewer input, never an implicit draft.
  const trimmed = replacement.trim();
  const effectiveReplacement = trimmed ? trimmed : undefined;

  return (
    <div
      {...scroll}
      className="min-h-0 flex-1 overflow-y-auto p-4 text-xs"
      data-testid="task-review-unit-scene"
    >
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <strong data-testid="task-review-unit-title">
            {t("条目 #{{no}}", { no: unit.ordinal })}
          </strong>
          <span className="max-w-72 truncate text-fg-3" title={source ? sourcePath(snapshot.root, source.relativePath) : undefined}>{source ? sourceTitle(source.relativePath) : ""}</span>
          <span className="text-fg-3">
            {t("行 {{start}}–{{end}}", { start: unit.startLine, end: unit.endLine })}
          </span>
          {subtitle && (
            <span className="font-mono text-fg-3">
              {formatTime(unit.startMs!)} → {formatTime(unit.endMs!)}
            </span>
          )}
          <span
            className="ml-auto shrink-0 rounded border border-border px-1.5 py-0.5"
            data-testid="task-review-unit-status"
          >
            {decision.needsRecheck && !decision.status
              ? t("口径已更新，需重新确认")
              : decision.status
                ? t(statusLabels[decision.status])
                : t("待审")}
          </span>
        </div>
        {plan && !feedbackOnly && (
          <details className="text-fg-3"><summary className="cursor-pointer">审阅此项的原因</summary>
            <p className="mt-1" data-testid="task-review-plan-reason">{plan.reason}</p>
          </details>
        )}
        {stale && <p role="status" className="rounded border border-status-error/50 p-2 text-status-error" data-testid="task-review-stale-source">{t("此场景来自已过期或不可用的原件版本；保留原草稿供参考，请从全局打开当前版本后重新审阅。")}</p>}
        {!stale && !analyzed && <p className="text-fg-3" data-testid="task-review-risk-unknown">{t("风险未知：此条目尚未完成当前口径分析，可继续人工审阅。")}</p>}
        <div className={feedbackOnly ? "flex min-h-0 flex-col gap-3" : "grid min-h-0 gap-4 lg:grid-cols-2"}>
          <section className="flex min-w-0 flex-col gap-3">
            {!feedbackOnly && <><strong className="text-fg-3">{t("原文与上下文")}</strong>
            <blockquote
              className="select-text whitespace-pre-wrap break-words rounded border border-border bg-bg-2 p-3 text-sm leading-relaxed"
              data-testid="task-review-unit-text"
            >
              {unit.text}
            </blockquote>
            {(previous || next) && (
              <div className="flex flex-col gap-2 border-l-2 border-border pl-3 text-fg-3" data-testid="task-review-unit-context">
                {previous && <p className="line-clamp-3 whitespace-pre-wrap break-words">{t("上文：")}{previous.text}</p>}
                {next && <p className="line-clamp-3 whitespace-pre-wrap break-words">{t("下文：")}{next.text}</p>}
              </div>
            )}
            </>}
            {issues.length > 0 && (
              <section className="flex flex-col gap-1.5" data-testid="task-review-issues">
                <strong>{t("AI 疑点（假设，不构成结论）")}</strong>
                {issues.map((issue) => (
                  <article
                    key={issue.id}
                    className={`rounded border p-2 ${issue.severity === "high" ? "border-status-error/60" : "border-border"}`}
                    data-testid="task-review-issue"
                    data-severity={issue.severity}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded px-1.5 py-0.5 ${issue.severity === "high" ? "bg-status-error/15 text-status-error" : "bg-bg-3 text-fg-2"}`}
                      >
                        {t(severityLabels[issue.severity])}
                      </span>
                      <strong className="min-w-0 flex-1">{issue.title}</strong>
                    </div>
                    <p className="mt-1 text-fg-2">
                      {t("证据：")}<span className="rounded bg-bg-3 px-1">{issue.evidence}</span>
                    </p>
                    <p className="mt-1 text-fg-2">{t("假设：")}{issue.hypothesis}</p>
                    {issue.options.length > 0 && (
                      <ul className="mt-1 flex flex-col gap-1">
                        {issue.options.map((option, index) => (
                          <li key={index} className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              className={wbButton.ghost}
                              title={option.reason}
                              onClick={() =>
                                onUpdateDraft({
                                  text: `${draft?.text ?? ""}${draft?.text ? "\n" : ""}${option.label}`,
                                  selectionStart: (draft?.text?.length ?? 0) + (draft?.text ? 1 : 0) + option.label.length,
                                  selectionEnd: (draft?.text?.length ?? 0) + (draft?.text ? 1 : 0) + option.label.length,
                                })
                              }
                            >
                              {option.label}
                            </button>
                            <span className="min-w-0 flex-1 text-fg-3">{option.reason}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </article>
                ))}
              </section>
            )}
          </section>
          <FeedbackEditor
            unit={unit}
            root={snapshot.root}
            taskId={snapshot.taskId}
            agent={agent}
            agentState={agentState}
            draft={draft}
            inputTestId="task-review-unit-note"
            disabled={stale}
            policyRevision={snapshot.policyRevision}
            onUpdateDraft={onUpdateDraft}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-fg-3" data-testid="task-review-decide-scope">
            {t("决定仅作用于当前条目 #{{no}}", { no: unit.ordinal })}
          </span>
          {(Object.keys(statusLabels) as TaskDecisionStatus[]).map((key) => (
            <button
              key={key}
              type="button"
              className={wbButton.secondary}
              aria-pressed={decision.status === key}
              disabled={busy || stale}
              data-testid={`task-review-decide-${key}`}
              onClick={() => onDecide(key, key === "rework" ? effectiveReplacement : undefined)}
            >
              {t(statusLabels[key])}
            </button>
          ))}
          <button
            type="button"
            className={wbButton.primary}
            disabled={busy || stale}
            data-testid="task-review-keep-continue"
            onClick={() => onDecideAndContinue("kept")}
          >
            {t("保留并继续")}
          </button>
          <button type="button" className={wbButton.secondary} onClick={onOpenEdit} data-testid="task-review-open-edit">
            {t("精细编辑")}
          </button>
          {decision.canUndo && (
            <button
              type="button"
              className={wbButton.ghost}
              disabled={busy || stale}
              data-testid="task-review-undo-decision"
              title={t("撤销会改变审阅状态，与时间线返回不同")}
              onClick={onUndo}
            >
              {t("撤销决定")}
            </button>
          )}
          {decision.canRedo && (
            <button
              type="button"
              className={wbButton.ghost}
              disabled={busy || stale}
              data-testid="task-review-redo-decision"
              onClick={onRedo}
            >
              {t("重做决定")}
            </button>
          )}
        </div>
        {criteriaAvailable && decision.decisionId && (decision.note ?? "").trim() && !stale && (
          <CriteriaAdoptionForm
            snapshot={snapshot}
            unit={unit}
            decisionId={decision.decisionId}
            note={decision.note ?? ""}
            busy={busy}
            onAdoptCriteria={onAdoptCriteria}
            purpose={purpose}
          />
        )}
        <button type="button" className={`${wbButton.ghost} self-start`} disabled={stale} onClick={() => setEditingSource((value) => !value)} data-testid="task-review-edit-source">{t(editingSource ? "收起原文修改" : "修改返工原文…")}</button>
        {editingSource && <label className="flex flex-col gap-1" data-testid="task-review-replacement-field">
          <span className="text-fg-3">{t("返工替换文本（可选，仅返工决定使用，不改动原件）")}</span>
          <textarea
            className="min-h-12 rounded border border-border bg-bg-2 p-2"
            aria-label={t("返工替换文本")}
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
          />
        </label>}
        {decision.replacementText !== undefined && (
          <p className="text-fg-3" data-testid="task-review-current-replacement">
            {t("当前返工替换：{{text}}", { text: decision.replacementText })}
          </p>
        )}
      </div>
    </div>
  );
}
