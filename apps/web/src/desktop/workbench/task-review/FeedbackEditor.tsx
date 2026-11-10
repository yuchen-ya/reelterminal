import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskReviewUnit } from "../../../../../desktop/src/shared/task-review";
import type {
  TaskAgentBridge,
  TaskAgentState,
  TaskCompletionEvent,
} from "../../../../../desktop/src/shared/task-review-runtime-types";
import { errorMessage } from "./bridge";
import { wbButton } from "../wb-button";
import type { DraftEntry } from "./useTaskDrafts";
import { useSceneScroll, viewKey } from "./view-state";

interface CompletionState {
  generationId: string;
  text: string;
  status: "running" | "done" | "error";
  error: string | null;
}

/** Exact draft the model saw when the live generation was requested. */
interface GenerationInput {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * Fine editing scene: the reviewer writes on top, the model continuation is a
 * candidate below. Adoption is always an explicit insertion into the draft;
 * the original unit text is never rewritten, and streaming never touches the
 * textarea, its selection or the input focus, including during IME
 * composition.
 */
export function FeedbackEditor({
  unit,
  root,
  taskId,
  agent,
  agentState,
  draft,
  onUpdateDraft,
  inputTestId = "task-review-edit-input",
  disabled = false,
  policyRevision = 0,
  showSuggestions = true,
}: {
  unit: TaskReviewUnit;
  root: string;
  taskId: string;
  agent: TaskAgentBridge | null;
  agentState: TaskAgentState | null;
  draft: DraftEntry | undefined;
  onUpdateDraft: (patch: {
    text?: string;
    selectionStart?: number;
    selectionEnd?: number;
  }) => void;
  inputTestId?: string;
  disabled?: boolean;
  policyRevision?: number;
  showSuggestions?: boolean;
}) {
  const { t } = useTranslation();
  const [completion, setCompletion] = useState<CompletionState | null>(null);
  const composingRef = useRef(false);
  const composedChange = useRef(false);
  const inputScroll = useSceneScroll<HTMLTextAreaElement>(`${viewKey(root, taskId)}:input:${unit.id}:${inputTestId}`, Boolean(draft));
  const inputRef = inputScroll.ref;
  const pendingEvents = useRef<TaskCompletionEvent[]>([]);
  const suggestionRef = useRef<HTMLDivElement>(null);
  // Track the in-flight generation so unmount cancels the live one.
  const runningGeneration = useRef<string | null>(null);
  const generationInput = useRef<GenerationInput | null>(null);
  const autoTimer = useRef<number | undefined>(undefined);
  const draftText = draft?.text ?? "";

  const granted = Boolean(agentState?.grant) && !disabled;
  const [modelAvailable, setModelAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    setModelAvailable(false);
    if (agent && granted) void agent.getModelConfig().then((config) => {
      if (active) setModelAvailable(config.hasApiKey && Boolean(config.completionModel));
    }, () => { if (active) setModelAvailable(false); });
    return () => { active = false; };
  }, [agent, granted]);
  const latestText = useRef(draftText);
  latestText.current = draftText;
  // The candidate contract is a follow-up of the exact generation-time draft,
  // so adoption has to re-check the draft text and selection against it.
  const latestSelection = useRef<[number, number]>([draftText.length, draftText.length]);
  latestSelection.current = [
    Math.min(draft?.selectionStart ?? draftText.length, draftText.length),
    Math.min(draft?.selectionEnd ?? draftText.length, draftText.length),
  ];

  const candidateMatchesDraft = useCallback((): boolean => {
    const input = generationInput.current;
    if (!input) return false;
    if (input.text !== latestText.current) return false;
    const [start, end] = latestSelection.current;
    return start === input.selectionStart && end === input.selectionEnd;
  }, []);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || composingRef.current || !draft) return;
    const start = Math.min(draft.selectionStart, draft.text.length);
    const end = Math.min(draft.selectionEnd, draft.text.length);
    if (input.selectionStart !== start || input.selectionEnd !== end) input.setSelectionRange(start, end);
  }, [draft?.selectionStart, draft?.selectionEnd, draft?.text]);

  const applyEvent = (event: TaskCompletionEvent) => {
    if (event.generationId !== runningGeneration.current) return;
    if (event.done || event.error) runningGeneration.current = null;
    setCompletion((current) => {
      // Stale generations never replace a newer request.
      if (!current || current.generationId !== event.generationId) return current;
      if (event.error)
        return { ...current, status: "error", error: event.error };
      return {
        ...current,
        text: current.text + event.delta,
        status: event.done ? "done" : "running",
      };
    });
  };

  useEffect(() => {
    if (!agent) return;
    return agent.onCompletion((event) => {
      if (event.taskId !== taskId || event.unitId !== unit.id) return;
      // During IME composition nothing re-renders the writing area; events
      // are buffered and applied once composition ends.
      if (composingRef.current) {
        pendingEvents.current.push(event);
        return;
      }
      applyEvent(event);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, taskId, unit.id]);

  useEffect(
    () => () => {
      const generationId = runningGeneration.current;
      if (generationId && agent)
        void agent.cancelCompletion({ taskId, generationId }).catch(() => undefined);
    },
    [agent, taskId],
  );

  const cancelRunning = useCallback(() => {
    const generationId = runningGeneration.current;
    runningGeneration.current = null;
    if (generationId && agent) void agent.cancelCompletion({ taskId, generationId }).catch(() => undefined);
  }, [agent, taskId]);

  // Any draft text change — typing, the first IME composition update or a
  // programmatic patch — invalidates the generation and its candidate at once:
  // a follow-up generated for another draft is never insertable. Selection-only
  // movement is not input; it leaves the candidate visible but unadoptable.
  useEffect(() => {
    if (generationInput.current && generationInput.current.text !== draftText) {
      cancelRunning();
      setCompletion(null);
    }
  }, [cancelRunning, draftText]);

  useEffect(() => {
    cancelRunning();
    setCompletion(null);
  }, [cancelRunning, policyRevision, disabled]);

  useEffect(() => {
    if (!granted) cancelRunning();
  }, [cancelRunning, granted]);

  const requestCompletion = useCallback(() => {
    if (!agent || !granted || composingRef.current) return;
    window.clearTimeout(autoTimer.current);
    autoTimer.current = undefined;
    cancelRunning();
    const generationId = crypto.randomUUID();
    runningGeneration.current = generationId;
    generationInput.current = {
      text: latestText.current,
      selectionStart: latestSelection.current[0],
      selectionEnd: latestSelection.current[1],
    };
    setCompletion({ generationId, text: "", status: "running", error: null });
    void agent
      .complete({
        root,
        taskId,
        unitId: unit.id,
        sourceVersionId: unit.sourceVersionId,
        generationId,
        text: latestText.current,
      })
      .catch((problem) => {
        if (runningGeneration.current !== generationId) return;
        runningGeneration.current = null;
        setCompletion((current) =>
          current?.generationId === generationId
            ? { ...current, status: "error", error: errorMessage(problem) }
            : current,
        );
      });
  }, [agent, granted, cancelRunning, root, taskId, unit.id, unit.sourceVersionId]);

  // Only typing schedules assistance; opening a saved draft never spends a request.
  const [typingRevision, setTypingRevision] = useState(0);
  useEffect(() => {
    if (!typingRevision || !granted || !modelAvailable || !latestText.current.trim()) return;
    autoTimer.current = window.setTimeout(requestCompletion, 1000);
    return () => window.clearTimeout(autoTimer.current);
  }, [typingRevision, granted, modelAvailable, requestCompletion]);

  const insertIntoDraft = (insertion: string) => {
    if (!insertion || !candidateMatchesDraft()) return;
    window.clearTimeout(autoTimer.current);
    cancelRunning();
    setCompletion((current) => current ? { ...current, status: "done" } : null);
    const start = Math.min(draft?.selectionStart ?? draftText.length, draftText.length);
    const end = Math.min(draft?.selectionEnd ?? start, draftText.length);
    const next = draftText.slice(0, start) + insertion + draftText.slice(end);
    const caret = start + insertion.length;
    onUpdateDraft({ text: next, selectionStart: caret, selectionEnd: caret });
  };

  const adoptSelection = () => {
    const node = suggestionRef.current;
    if (!node || !completion) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!node.contains(range.commonAncestorContainer)) return;
    insertIntoDraft(selection.toString());
  };

  // A candidate is only adoptable against the exact draft and selection it
  // was generated from; anything older stays visible but cannot be inserted.
  const adoptable = completion !== null && completion.text.length > 0 && candidateMatchesDraft();

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 text-xs"
      data-testid="task-review-feedback-editor"
    >
      <label className="flex min-h-0 flex-1 flex-col gap-1">
        {t("Human feedback (type above; draft saves automatically)")}
        <textarea
          className="min-h-32 max-h-80 flex-1 resize-y rounded border border-border bg-bg-2 p-2 leading-relaxed"
          data-testid={inputTestId}
          ref={inputRef}
          onScroll={inputScroll.onScroll}
          readOnly={disabled}
          value={draftText}
          onCompositionStart={() => {
            composingRef.current = true;
            composedChange.current = false;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            if (composedChange.current) setTypingRevision((value) => value + 1);
            const buffered = pendingEvents.current;
            pendingEvents.current = [];
            for (const event of buffered) applyEvent(event);
          }}
          onChange={(event) => {
            if (composingRef.current) composedChange.current = true;
            cancelRunning();
            setCompletion(null);
            setTypingRevision((value) => value + 1);
            onUpdateDraft({
              text: event.target.value,
              selectionStart: event.target.selectionStart,
              selectionEnd: event.target.selectionEnd,
            });
          }}
          onSelect={(event) => {
            if (disabled) return;
            const target = event.target as HTMLTextAreaElement;
            onUpdateDraft({
              selectionStart: target.selectionStart,
              selectionEnd: target.selectionEnd,
            });
          }}
        />
      </label>
      {showSuggestions && <section className="flex max-h-64 shrink-0 flex-col gap-1.5 rounded border border-border bg-bg-1 p-2">
        <div className="flex items-center gap-2">
          <strong>{t("AI completion candidates")}</strong>
          <button
            type="button"
            className={wbButton.secondary}
            disabled={!agent || !granted}
            title={
              !agent
                ? t("Built-in model connection is unavailable")
                : !granted
                  ? t("Authorize AI review for this task in the overview first")
                  : t("Generate completion candidates from the current draft")
            }
            data-testid="task-review-complete-request"
            onClick={requestCompletion}
          >
            {t("Generate completion")}
          </button>
          {completion?.status === "running" && (
            <button
              type="button"
              className={wbButton.ghost}
              onClick={() => { cancelRunning(); setCompletion((current) => current ? { ...current, status: "done" } : null); }}
            >
              {t("Stop")}
            </button>
          )}
          <span className="min-w-0 flex-1 truncate text-fg-3" role="status" data-testid="task-review-complete-status">
            {completion?.status === "running"
                ? t("Generating…")
                : completion?.status === "error"
                  ? completion.error
                  : completion && completion.text.length > 0 && !adoptable
                    ? t("The draft or cursor changed. Generate new candidates.")
                    : completion
                      ? t("Candidates ready. Accept all or part.")
                      : !agent || !granted || !modelAvailable
                        ? t("Manual review remains available without authorization or a model")
                        : t("Suggest completions after a typing pause; insert only when explicitly accepted")}
          </span>
        </div>
        {completion && (
          <>
            <div
              ref={suggestionRef}
              className="min-h-10 select-text overflow-y-auto whitespace-pre-wrap break-words rounded border border-border bg-bg-2 p-2 text-fg-2"
              data-testid="task-review-suggestion"
            >
              {completion.text || (completion.status === "running" ? t("…") : "")}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={wbButton.secondary}
                disabled={!adoptable}
                data-testid="task-review-adopt-all"
                onClick={() => insertIntoDraft(completion.text)}
              >
                {t("Accept all (insert into draft)")}
              </button>
              <button
                type="button"
                className={wbButton.secondary}
                disabled={!adoptable}
                data-testid="task-review-adopt-selection"
                onClick={adoptSelection}
              >
                {t("Accept selected part")}
              </button>
              <span className="text-fg-3">{t("Acceptance inserts into the draft and never replaces the source")}</span>
            </div>
          </>
        )}
      </section>}
    </div>
  );
}
