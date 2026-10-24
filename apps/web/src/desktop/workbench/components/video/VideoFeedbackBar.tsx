import type { JSX } from "react";
import { Sparkles, TriangleAlert } from "lucide-react";
import type {
  WorkbenchAgentGuidance,
  WorkbenchDecisionStatus,
  WorkbenchProvenanceTag,
} from "@reelterminal/core";
import { STATUS_LABEL } from "./video-helpers";

export interface VideoFeedbackBarProps {
  readonly guidance?: WorkbenchAgentGuidance;
  readonly status: WorkbenchDecisionStatus;
  readonly feedbackDraft: string;
  readonly onChangeFeedbackDraft: (text: string) => void;
  readonly onSubmitFeedback: () => void;
  readonly canSubmitFeedback: boolean;
  readonly provenanceTags: readonly WorkbenchProvenanceTag[];
  readonly feedbackTagIds: readonly string[];
  readonly onToggleFeedbackTag: (tagId: string) => void;
  readonly markRework: boolean;
  readonly onChangeMarkRework: (rework: boolean) => void;
  readonly mutationError: string | null;
  readonly onDismissMutationError: () => void;
}

export function VideoFeedbackBar({
  guidance,
  status,
  feedbackDraft,
  onChangeFeedbackDraft,
  onSubmitFeedback,
  canSubmitFeedback,
  provenanceTags,
  feedbackTagIds,
  onToggleFeedbackTag,
  markRework,
  onChangeMarkRework,
  mutationError,
  onDismissMutationError,
}: VideoFeedbackBarProps): JSX.Element {
  return (
    <div className="relative shrink-0 border-t border-border bg-bg-1 px-3 py-1.5 select-none">
      {mutationError && (
        <div className="mb-1.5 flex items-center gap-2 rounded-[6px] border border-status-error/40 bg-status-error/10 px-2.5 py-1 text-xs text-status-error">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-all">{mutationError}</span>
          <button
            type="button"
            onClick={onDismissMutationError}
            className="shrink-0 hover:text-fg"
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex h-7 items-center gap-2 text-xs">
        {/* Agent guidance compact badge (if present) */}
        {guidance ? (
          <div
            className="flex shrink-0 items-center gap-1 rounded-[4px] border border-border bg-bg-2 px-1.5 py-0.5 text-[11px] text-fg-2"
            title={`${guidance.whatHappened} ${guidance.whatToDoNext}`}
          >
            <Sparkles className="h-3 w-3 shrink-0 text-accent" />
            <span className="text-fg-3">AI:</span>
            <span className="max-w-[130px] truncate">{guidance.branchName}</span>
          </div>
        ) : null}

        {/* Decision status badge */}
        <span
          className={`shrink-0 rounded-[4px] border px-1.5 py-0.5 text-[11px] font-mono ${
            status === "pending"
              ? "border-border bg-bg-2 text-fg-3"
              : status === "rework"
                ? "border-status-warning/40 bg-status-warning/10 text-status-warning"
                : status === "discarded"
                  ? "border-status-error/40 bg-status-error/10 text-status-error"
                  : "border-accent/40 bg-accent/10 text-accent"
          }`}
        >
          {STATUS_LABEL[status]}
        </span>

        {/* Feedback text input */}
        <input
          value={feedbackDraft}
          onChange={(e) => onChangeFeedbackDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSubmitFeedback) {
              onSubmitFeedback();
            }
          }}
          placeholder="返工/审阅说明(与问题标记一并发送,可选)"
          className="h-7 min-w-0 flex-1 rounded-[4px] border border-border bg-bg-2 px-2 text-xs text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none"
        />

        {/* Provenance reference tag chips */}
        {provenanceTags.length > 0 ? (
          <div className="flex shrink-0 items-center gap-1">
            {provenanceTags.map((tag) => {
              const active = feedbackTagIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => onToggleFeedbackTag(tag.id)}
                  className={`rounded-[4px] border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                    active
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-border bg-bg-2 text-fg-3 hover:text-fg-2"
                  }`}
                  title={`引用溯源标签 @${tag.shortName}`}
                >
                  @{tag.shortName}
                </button>
              );
            })}
          </div>
        ) : null}

        {/* Mark rework checkbox */}
        <label className="flex shrink-0 items-center gap-1 text-fg-2 cursor-pointer">
          <input
            type="checkbox"
            checked={markRework}
            onChange={(e) => onChangeMarkRework(e.target.checked)}
            className="accent-accent"
          />
          标记返工
        </label>

        {/* Submit feedback button */}
        <button
          type="button"
          onClick={onSubmitFeedback}
          disabled={!canSubmitFeedback}
          className="inline-flex h-7 shrink-0 items-center justify-center rounded-[6px] border border-accent/40 bg-accent/10 px-2.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          提交反馈
        </button>
      </div>
    </div>
  );
}
