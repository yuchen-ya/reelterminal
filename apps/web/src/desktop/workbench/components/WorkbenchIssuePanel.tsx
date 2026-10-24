/**
 * In-canvas issue editing panel for the AI material workbench.
 *
 * Restored from the prototype's `PredictiveIssueKanban` (选问题 → 定位锚点 →
 * 写建议 / 引用来源 → 保存或标记返工), deliberately WITHOUT the prototype's
 * cloud prediction: no `/api/ai/predict`, no local preset fallback, no
 * hard-coded "smart suggestions". Every card is a real persisted issue
 * (image annotation or video marker/annotation), every tag chip is a real
 * `provenanceTag` with a stable id, and saving goes through the existing
 * workbench controller actions.
 *
 * Behaviour contract:
 * - selection is controlled by the workspace so the canvas highlight and the
 *   card row stay in sync (one selection state, no second copy);
 * - drafts are keyed by `itemId + version + issueId`, so switching items,
 *   versions or issues never leaks text between them;
 * - save failures keep the draft and surface the reason;
 * - "保存反馈" and "保存并标返工" are distinct; neither publishes a handoff.
 */
import { useCallback, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  Check,
  CircleAlert,
  Crosshair,
  Loader2,
  MessageSquareWarning,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  Video,
} from "lucide-react";
import type {
  WorkbenchAgentGuidance,
  WorkbenchProvenanceTag,
} from "@reelterminal/core";
import type { WorkbenchMutationResult, FeedbackView } from "../types";
import { feedbackMatchesIssue } from "../feedback-identity";

export interface WorkbenchIssueEntry {
  readonly id: string;
  readonly kind: "annotation" | "marker";
  /** Stable 1-based number shown on canvas and in the pill row. */
  readonly indexNumber: number;
  /** Human-readable location ("源像素 (x, y)" or "帧标记 @ 1.234s"). */
  readonly coordinateLabel: string;
  /** Persisted note (annotation label / marker note). */
  readonly note: string;
  /** Version the issue was created against (markers) or the item version. */
  readonly version: number;
  readonly ptsLabel?: string;
  readonly color?: string;
  readonly tool?: string;
  readonly annotationCount?: number;
  readonly staleVersion?: boolean;
}

export interface WorkbenchIssueSaveInput {
  readonly text: string;
  readonly referencedTagIds: readonly string[];
  readonly markRework: boolean;
}

export interface WorkbenchIssueFeedbackView {
  readonly text: string;
  readonly referencedTagIds: readonly string[];
  readonly isDraft: boolean;
}

export interface WorkbenchIssuePanelProps {
  readonly itemId: string;
  readonly itemVersion: number;
  readonly issues: readonly WorkbenchIssueEntry[];
  readonly selectedIssueId: string | null;
  readonly onSelectIssue: (issueId: string) => void;
  readonly onDeleteIssue: (issueId: string) => Promise<WorkbenchMutationResult>;
  readonly onSaveIssue: (
    issueId: string,
    input: WorkbenchIssueSaveInput,
  ) => Promise<WorkbenchMutationResult>;
  readonly provenanceTags: readonly WorkbenchProvenanceTag[];
  readonly agentGuidance?: WorkbenchAgentGuidance;
  /** Last persisted item-level feedback, shown as a read-back summary. */
  readonly lastFeedback?: WorkbenchIssueFeedbackView;
  /** Every persisted feedback record (issue-level readback / unresolved tags). */
  readonly feedbacks?: readonly FeedbackView[];
  readonly widthPx: number;
  readonly emptyHint: string;
}

interface IssueDraft {
  readonly text: string;
  readonly tagIds: readonly string[];
}

function tagLabel(tag: WorkbenchProvenanceTag): string {
  return tag.version ? `@${tag.shortName} ${tag.version}` : `@${tag.shortName}`;
}

function tagVerificationLabel(tag: WorkbenchProvenanceTag): string {
  return tag.verification === "verified"
    ? "已验证"
    : tag.verification === "declared"
      ? "已声明(未验证)"
      : "验证状态未知";
}

function draftKey(itemId: string, itemVersion: number, issueId: string): string {
  return `${itemId}#v${itemVersion}#${issueId}`;
}

/** Insert or remove an `@tag` token without touching the rest of the note. */
function toggleTagToken(
  text: string,
  token: string,
  add: boolean,
): string {
  if (add) {
    return text.includes(token) ? text : `${text}${text.length > 0 ? " " : ""}${token}`;
  }
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(`\\s*${escaped}`, "g"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function WorkbenchIssuePanel({
  itemId,
  itemVersion,
  issues,
  selectedIssueId,
  onSelectIssue,
  onDeleteIssue,
  onSaveIssue,
  provenanceTags,
  agentGuidance,
  lastFeedback,
  feedbacks,
  widthPx,
  emptyHint,
}: WorkbenchIssuePanelProps): JSX.Element {
  const [drafts, setDrafts] = useState<Readonly<Record<string, IssueDraft>>>({});
  const [busy, setBusy] = useState<"save" | "rework" | "delete" | null>(null);
  const [notice, setNotice] = useState<
    { readonly kind: "ok" | "error"; readonly message: string } | null
  >(null);

  const selectedIssue = useMemo(
    () => issues.find((issue) => issue.id === selectedIssueId) ?? null,
    [issues, selectedIssueId],
  );

  const issueFeedbacks = useMemo(
    () =>
      selectedIssue
        ? (feedbacks ?? []).filter((feedback) =>
            feedbackMatchesIssue(feedback, selectedIssue),
          )
        : [],
    [feedbacks, selectedIssue],
  );
  const savedFeedback = useMemo(
    () =>
      [...issueFeedbacks]
        .reverse()
        .find((feedback) => feedback.itemVersion === itemVersion),
    [issueFeedbacks, itemVersion],
  );
  const historicalFeedback = useMemo(
    () =>
      [...issueFeedbacks]
        .reverse()
        .find((feedback) => feedback.itemVersion !== itemVersion),
    [issueFeedbacks, itemVersion],
  );

  const key = selectedIssue ? draftKey(itemId, itemVersion, selectedIssue.id) : "";
  const draft = useMemo<IssueDraft | null>(
    () =>
      selectedIssue
        ? (drafts[key] ?? {
            text: savedFeedback?.text ?? selectedIssue.note,
            // Reopening an issue restores the tag references that were saved
            // for THIS version; unresolved ids are kept, never filtered.
            tagIds: savedFeedback ? [...savedFeedback.referencedTagIds] : [],
          })
        : null,
    [drafts, key, savedFeedback, selectedIssue],
  );

  /** References that no longer resolve must be preserved and surfaced. */
  const unresolvedTagIds = useMemo(
    () =>
      (draft?.tagIds ?? []).filter(
        (id) => !provenanceTags.some((tag) => tag.id === id),
      ),
    [draft?.tagIds, provenanceTags],
  );

  const updateDraft = useCallback(
    (next: IssueDraft) => {
      if (!selectedIssue) return;
      setDrafts((prev) => ({ ...prev, [key]: next }));
    },
    [key, selectedIssue],
  );

  const handleSave = useCallback(
    async (markRework: boolean) => {
      if (!selectedIssue || !draft) return;
      const text = draft.text.trim();
      setBusy(markRework ? "rework" : "save");
      setNotice(null);
      try {
        const result = await onSaveIssue(selectedIssue.id, {
          text,
          referencedTagIds: [...draft.tagIds],
          markRework,
        });
        if (!result.ok) {
          setNotice({ kind: "error", message: `${result.message}（草稿已保留）` });
          return;
        }
        // Drop only this issue's draft; other issues keep theirs.
        setDrafts((prev) => {
          if (!(key in prev)) return prev;
          const copy = { ...prev };
          delete copy[key];
          return copy;
        });
        setNotice({
          kind: "ok",
          message: markRework
            ? "反馈已保存，条目已标记返工（尚未发布交接）"
            : "反馈已保存（尚未发布交接）",
        });
      } catch (error) {
        setNotice({
          kind: "error",
          message: `${error instanceof Error ? error.message : String(error)}（草稿已保留）`,
        });
      } finally {
        setBusy(null);
      }
    },
    [draft, key, onSaveIssue, selectedIssue],
  );

  const handleDelete = useCallback(async () => {
    if (!selectedIssue) return;
    setBusy("delete");
    setNotice(null);
    try {
      const result = await onDeleteIssue(selectedIssue.id);
      if (!result.ok) {
        setNotice({ kind: "error", message: result.message });
        return;
      }
      setDrafts((prev) => {
        const copy = { ...prev };
        delete copy[key];
        return copy;
      });
      setNotice({ kind: "ok", message: "已删除该问题（其他问题保持不变）" });
    } catch (error) {
      setNotice({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  }, [key, onDeleteIssue, selectedIssue]);

  const toggleTag = useCallback(
    (tag: WorkbenchProvenanceTag) => {
      if (!draft) return;
      const token = `@${tag.shortName}`;
      const active = draft.tagIds.includes(tag.id);
      updateDraft({
        text: toggleTagToken(draft.text, token, !active),
        tagIds: active
          ? draft.tagIds.filter((id) => id !== tag.id)
          : [...draft.tagIds, tag.id],
      });
    },
    [draft, updateDraft],
  );

  return (
    <div
      style={{ width: widthPx }}
      className="my-3 mr-3 flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-bg-1"
      data-testid="workbench-issue-panel"
    >
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3 select-none">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-fg">
          <MessageSquareWarning className="h-3.5 w-3.5 text-accent" />
          选区问题速改
        </span>
        <span className="font-mono text-[11px] text-fg-3">{issues.length} 处</span>
      </div>

      {agentGuidance && (
        <div className="shrink-0 border-b border-border bg-bg-2/60 px-3 py-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-accent">
            <Sparkles className="h-3 w-3 shrink-0" />
            <span className="truncate">
              Agent 建议 · {agentGuidance.branchName} / {agentGuidance.nodeSlotLabel}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-fg-2">
            {agentGuidance.whatToDoNext}
          </p>
          <p className="mt-0.5 text-[10px] text-fg-3">
            建议决定「{agentGuidance.nodButtonLabel}」需在底部详情确认，面板不会自动执行。
          </p>
        </div>
      )}

      {notice && (
        <div
          className={`flex shrink-0 items-start justify-between gap-2 border-b border-border px-3 py-1.5 text-[11px] ${
            notice.kind === "error" ? "bg-status-error/10 text-status-error" : "bg-bg-2 text-fg-2"
          }`}
        >
          <span className="min-w-0 break-words">{notice.message}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="shrink-0 text-fg-3 hover:text-fg"
            title="关闭提示"
          >
            ×
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3">
        {issues.length === 0 ? (
          <div className="rounded-xl border border-border bg-bg-2 p-4 text-center">
            <Crosshair className="mx-auto h-4 w-4 text-accent" />
            <div className="mt-1 text-xs text-fg-2">暂无问题记录</div>
            <div className="mt-1 text-[11px] leading-relaxed text-fg-3">{emptyHint}</div>
          </div>
        ) : (
          <div className="space-y-3">
            {selectedIssue ? (
              <>
                {issues.length > 1 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {issues.map((issue) => (
                      <button
                        key={issue.id}
                        type="button"
                        onClick={() => onSelectIssue(issue.id)}
                        className={`rounded border px-2 py-0.5 font-mono text-xs transition-colors ${
                          issue.id === selectedIssue.id
                            ? "border-accent bg-accent font-bold text-accent-foreground"
                            : "border-border bg-bg-2 text-fg-3 hover:text-fg"
                        }`}
                        title={issue.coordinateLabel}
                      >
                        #{issue.indexNumber}
                      </button>
                    ))}
                  </div>
                )}

                <div className="space-y-2 rounded-xl border border-border bg-bg p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-mono text-fg-3">
                        {selectedIssue.kind === "marker" ? (
                          <Video className="h-3 w-3 shrink-0 text-rose-400" />
                        ) : (
                          <Crosshair className="h-3 w-3 shrink-0 text-accent" />
                        )}
                        <span className="truncate">
                          选区 <strong className="text-accent">#{selectedIssue.indexNumber}</strong> ·{" "}
                          {selectedIssue.coordinateLabel}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] font-mono text-fg-3">
                        {selectedIssue.color && (
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ backgroundColor: selectedIssue.color }}
                          />
                        )}
                        {selectedIssue.tool && <span>{selectedIssue.tool}</span>}
                        {selectedIssue.annotationCount !== undefined &&
                          selectedIssue.annotationCount > 0 && (
                            <span>· {selectedIssue.annotationCount} 处圈注</span>
                          )}
                        <span
                          className={
                            selectedIssue.staleVersion ? "text-status-warning" : "text-fg-3"
                          }
                        >
                          · v{selectedIssue.version}
                          {selectedIssue.staleVersion ? " · 非当前版本" : ""}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDelete()}
                      disabled={busy !== null}
                      className="shrink-0 rounded p-1 text-fg-3 transition-colors hover:text-status-error disabled:opacity-40"
                      title="删除此问题（不影响其他问题）"
                      data-testid="workbench-issue-delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <textarea
                    value={draft?.text ?? ""}
                    onChange={(event) =>
                      updateDraft({
                        text: event.target.value,
                        tagIds: draft?.tagIds ?? [],
                      })
                    }
                    onKeyDown={(event) => event.stopPropagation()}
                    rows={4}
                    placeholder="输入问题说明或返工建议；可引用下方来源标签。"
                    aria-label="问题建议"
                    className="w-full resize-none rounded-lg border border-border bg-bg-2 p-2 text-xs leading-relaxed text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none"
                  />

                  {savedFeedback ? (
                    <div
                      className={`flex items-center gap-1 text-[10px] ${
                        savedFeedback.isDraft ? "text-fg-3" : "text-accent"
                      }`}
                      data-testid="workbench-issue-saved-state"
                    >
                      <Check className="h-2.5 w-2.5" />
                      当前版本已保存{savedFeedback.isDraft ? "（草稿）" : ""} · v
                      {savedFeedback.itemVersion}
                    </div>
                  ) : historicalFeedback ? (
                    <div className="text-[10px] text-status-warning">
                      该问题在 v{historicalFeedback.itemVersion} 有历史反馈；当前 v{itemVersion} 尚未保存
                    </div>
                  ) : (
                    <div className="text-[10px] text-fg-3">当前版本尚未保存反馈</div>
                  )}

                  {provenanceTags.length > 0 || unresolvedTagIds.length > 0 ? (
                    <div>
                      <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-fg-3">
                        <Tag className="h-2.5 w-2.5" />
                        引用来源（点击插入 @ 引用并随反馈保存）
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {provenanceTags.map((tag) => {
                          const active = draft?.tagIds.includes(tag.id) ?? false;
                          return (
                            <button
                              key={tag.id}
                              type="button"
                              onClick={() => toggleTag(tag)}
                              title={`${tagLabel(tag)} · ${tag.category} · ${tagVerificationLabel(tag)}`}
                              className={`flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                                active
                                  ? "border-accent bg-accent-soft text-accent"
                                  : "border-border bg-bg-2 text-fg-3 hover:text-fg"
                              }`}
                            >
                              {tag.verification === "unknown" ? (
                                <CircleAlert className="h-2.5 w-2.5" />
                              ) : (
                                <ShieldCheck className="h-2.5 w-2.5" />
                              )}
                              {tagLabel(tag)}
                            </button>
                          );
                        })}
                        {unresolvedTagIds.map((id) => (
                          <button
                            key={id}
                            type="button"
                            onClick={() =>
                              updateDraft({
                                text: draft?.text ?? "",
                                tagIds: (draft?.tagIds ?? []).filter(
                                  (candidate) => candidate !== id,
                                ),
                              })
                            }
                            title="该来源引用已失效（标签不存在或同名多版本无法确定身份）；保存时不会静默丢弃，可移除后重新选择"
                            className="flex items-center gap-1 rounded border border-status-error/40 bg-status-error/10 px-1.5 py-0.5 font-mono text-[10px] text-status-error"
                            data-testid="workbench-issue-unresolved-tag"
                          >
                            <CircleAlert className="h-2.5 w-2.5" />
                            @{id}（引用失效）
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="text-[10px] text-fg-3">该条目没有可引用的来源标签</div>
                  )}

                  <div className="flex items-center gap-1.5 pt-0.5">
                    <button
                      type="button"
                      onClick={() => void handleSave(false)}
                      disabled={busy !== null || (draft?.text.trim().length ?? 0) === 0}
                      className="flex flex-1 items-center justify-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent-strong disabled:opacity-40"
                      title="保存反馈（不发布交接，不通知 Agent）"
                      data-testid="workbench-issue-save"
                    >
                      {busy === "save" ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Check className="h-3 w-3" />
                      )}
                      保存反馈
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSave(true)}
                      disabled={busy !== null || (draft?.text.trim().length ?? 0) === 0}
                      className="flex flex-1 items-center justify-center gap-1 rounded-md border border-status-warning/50 bg-status-warning/10 px-2 py-1 text-xs font-medium text-status-warning transition-colors hover:bg-status-warning/20 disabled:opacity-40"
                      title="保存反馈并把条目标为待返工（仍需发布交接）"
                      data-testid="workbench-issue-rework"
                    >
                      {busy === "rework" ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <MessageSquareWarning className="h-3 w-3" />
                      )}
                      保存并标返工
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            <div className="space-y-1.5">
              <div className="text-[11px] font-medium text-fg-2">
                全部问题 <span className="font-mono text-fg-3">({issues.length})</span>
              </div>
              {issues.map((issue) => {
                const active = issue.id === selectedIssue?.id;
                return (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => onSelectIssue(issue.id)}
                    data-testid="workbench-issue-card"
                    className={`block w-full rounded-lg border p-2 text-left transition-colors ${
                      active
                        ? "border-accent bg-bg-2"
                        : "border-border bg-bg hover:border-border-strong"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="font-mono font-semibold text-accent">
                        #{issue.indexNumber}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-fg-3">
                        {issue.coordinateLabel}
                      </span>
                      <span
                        className={`shrink-0 font-mono text-[10px] ${
                          issue.staleVersion ? "text-status-warning" : "text-fg-3"
                        }`}
                      >
                        v{issue.version}
                      </span>
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-xs text-fg">
                      {issue.note || "（无说明）"}
                    </div>
                  </button>
                );
              })}
            </div>

            {lastFeedback && (
              <div className="rounded-lg border border-border bg-bg-2 p-2">
                <div className="text-[10px] font-medium text-fg-3">
                  最近保存的条目反馈{lastFeedback.isDraft ? "（草稿）" : ""}
                </div>
                <div className="mt-0.5 line-clamp-3 text-[11px] text-fg-2">
                  {lastFeedback.text || "（空）"}
                </div>
                {lastFeedback.referencedTagIds.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {lastFeedback.referencedTagIds.map((id) => {
                      const tag = provenanceTags.find((candidate) => candidate.id === id);
                      return (
                        <span
                          key={id}
                          className="rounded border border-border bg-bg px-1 py-0.5 font-mono text-[10px] text-fg-3"
                        >
                          {tag ? tagLabel(tag) : `@${id}`}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
