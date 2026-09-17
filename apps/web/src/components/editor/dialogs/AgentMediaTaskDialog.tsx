/**
 * Voiceover / music generation dialog: one surface with the task form and
 * the task ledger.
 *
 * The product never generates audio itself — the form only collects the
 * user's text and requirement wording and hands the composed prompt to the
 * already-connected external Agent conversation, while the ledger below
 * shows where each task really is (queued / submitted / running / awaiting
 * import / done / failed / cancelled). Generation happens on the connected
 * agent's side; results may differ every run, and the copy never claims
 * otherwise. Cancelling is task-local: the conversation owns its own turn.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  AudioLines,
  CircleAlert,
  Loader2,
  Mic,
  Music,
  RotateCcw,
  X,
} from "@/icons/lucide-compat";
import { ToolcraftButton as Button } from "@openreel/ui";
import { AgentConnectionGuide } from "../agent/AgentConnectionGuide";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { useExternalConversationStore } from "../../../stores/external-conversation-store";
import { getAgentMediaTaskService, subscribeAgentMediaTasks } from "../../../services/agent-media-tasks/agent-media-task-service";
import { taskHasRequirementText } from "../../../services/agent-media-tasks/prompt-composer";
import type {
  AgentMediaTaskInsertIntent,
  AgentMediaTaskKind,
  AgentMediaTaskRecord,
  AgentMediaTaskStatus,
} from "../../../services/agent-media-tasks/types";
import {
  cancelAgentMediaTask,
  getRecommendedRootResolver,
  retryAgentMediaTask,
  submitAgentMediaTask,
} from "./agent-media-task-submit";
import {
  confirmTaskArtifactManually,
  importAwaitingTask,
  markTaskFailedManually,
  type AgentTaskRuntimeDeps,
} from "../../../services/agent-media-tasks/task-import";
import {
  insertDoneTaskTimeline,
  type AgentTaskInsertDeps,
} from "../../../services/agent-media-tasks/task-insert";
import { useAgentConnectionSetup } from "./use-agent-connection-setup";

interface SubmitError {
  readonly code: string;
  readonly message: string;
  readonly params?: Record<string, string | number>;
}

/**
 * Known codes are translated here (with their parameters); anything else —
 * e.g. the neutral detail stored on a task record — is shown verbatim. The
 * ledger never stores user-facing prose, so no internal names leak either way.
 */
function describeSubmitError(error: SubmitError, t: (key: string, options?: Record<string, unknown>) => string): string {
  switch (error.code) {
    case "NO_RECOMMENDED_ROOT":
      return t("agentMediaTasks.errorNoRecommendedRoot");
    case "PROMPT_TOO_LONG":
      return t("agentMediaTasks.errorPromptTooLong", {
        length: error.params?.length ?? "",
        max: error.params?.max ?? "",
      });
    case "SESSION_BUSY":
      return t("agentMediaTasks.retryBusyNote");
    default:
      return error.message;
  }
}

export const AGENT_MEDIA_TASK_MODAL_ID = "agentMediaTask";

interface TaskListState {
  readonly tasks: readonly AgentMediaTaskRecord[];
  readonly unreadable: number;
}

function useAgentMediaTaskList(): TaskListState {
  const service = useMemo(() => getAgentMediaTaskService(), []);
  const [state, setState] = useState<TaskListState>(() => ({
    tasks: service.getSnapshot(),
    unreadable: 0,
  }));
  const reload = useCallback(async () => {
    const result = await service.list();
    if (result.ok) {
      setState({
        tasks: result.value.tasks,
        unreadable: result.value.unreadable.length,
      });
    }
  }, [service]);
  useEffect(() => {
    void reload();
    return subscribeAgentMediaTasks(() => void reload());
  }, [reload]);
  return state;
}

/** Shared controller dependencies: ledger service + the open project. */
function useAgentMediaTaskActionDeps(): AgentTaskRuntimeDeps {
  return useMemo(
    () => ({
      service: getAgentMediaTaskService(),
      getCurrentProjectId: () => {
        const state = useProjectStore.getState();
        return state.hasOpenProject ? state.project.id : null;
      },
    }),
    [],
  );
}

function useAgentMediaTaskInsertDeps(): AgentTaskInsertDeps {
  return useMemo(
    () => ({
      service: getAgentMediaTaskService(),
      getCurrentProjectId: () => {
        const state = useProjectStore.getState();
        return state.hasOpenProject ? state.project.id : null;
      },
      getMediaItem: (mediaId: string) => {
        const state = useProjectStore.getState();
        return state.hasOpenProject ? state.getMediaItem(mediaId) : undefined;
      },
      addClipToNewTrack: (mediaId: string, startTime?: number) =>
        useProjectStore.getState().addClipToNewTrack(mediaId, startTime),
      collectClipIds: () => {
        const state = useProjectStore.getState();
        return state.hasOpenProject
          ? state.project.timeline.tracks.flatMap((track) =>
              track.clips.map((clip) => clip.id as string),
            )
          : [];
      },
    }),
    [],
  );
}

/**
 * Inline audio preview of an imported task result. Only renders while the
 * target project is open (the media item lives in that project); previewing
 * a closed project's bytes is deliberately out of reach.
 */
function DoneAudioPreview({
  mediaId,
  targetProjectId,
  currentProjectId,
}: {
  readonly mediaId: string;
  readonly targetProjectId: string;
  readonly currentProjectId: string | null;
}): React.JSX.Element | null {
  const mediaItem = useProjectStore((state) =>
    state.hasOpenProject && state.project.id === targetProjectId
      ? state.getMediaItem(mediaId)
      : undefined,
  );
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    const blob = mediaItem?.blob;
    if (!blob) {
      setObjectUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setObjectUrl(null);
    };
  }, [mediaItem]);
  if (currentProjectId !== targetProjectId || !objectUrl) return null;
  return (
    <audio
      controls
      preload="none"
      data-testid="amt-audio-preview"
      src={objectUrl}
      className="mt-1.5 h-8 w-full"
    />
  );
}

function StatusBadge({ status }: { readonly status: AgentMediaTaskStatus }): React.JSX.Element {
  const { t } = useTranslation();
  const active = status === "queued" || status === "submitted" || status === "running";
  const failed = status === "error";
  return (
    <span
      data-testid={`amt-status-${status}`}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
        failed
          ? "bg-status-error/12 text-status-error"
          : active
            ? "bg-accent-soft text-accent"
            : status === "awaiting_import"
              ? "bg-status-warning/10 text-status-warning"
              : status === "done"
                ? "bg-status-success/12 text-status-success"
                : "bg-bg-3 text-fg-muted"
      }`}
    >
      {active ? <Loader2 size={10} className="animate-spin" aria-hidden /> : null}
      {t(`agentMediaTasks.status.${status}`)}
    </span>
  );
}

function TaskRow({
  record,
  busy,
  sessionBusy,
  currentProjectId,
  rowError,
  onRetry,
  onCancel,
  onImport,
  onInsert,
  onManualConfirm,
  onManualFail,
}: {
  readonly record: AgentMediaTaskRecord;
  readonly busy: boolean;
  /** The conversation lane is busy; a retry would fail and burn the attempt. */
  readonly sessionBusy: boolean;
  readonly currentProjectId: string | null;
  readonly rowError: { readonly code: string; readonly message: string } | null;
  readonly onRetry: (record: AgentMediaTaskRecord) => void;
  readonly onCancel: (record: AgentMediaTaskRecord) => void;
  readonly onImport: (record: AgentMediaTaskRecord) => void;
  readonly onInsert: (record: AgentMediaTaskRecord) => void;
  readonly onManualConfirm: (record: AgentMediaTaskRecord) => void;
  readonly onManualFail: (record: AgentMediaTaskRecord) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const cancellable =
    record.status === "queued" || record.status === "submitted" || record.status === "running";
  const retryable = record.status === "error" || record.status === "cancelled";
  const manualOnly = record.autoConfirm === "manual-only";
  const manualConfirmable =
    manualOnly && (record.status === "submitted" || record.status === "running");
  const targetIsCurrent =
    currentProjectId !== null && currentProjectId === record.targetProjectId;
  const importable = record.status === "awaiting_import";
  const insertable =
    record.status === "done" &&
    Boolean(record.resultMediaId) &&
    !record.insertedClipId &&
    record.insertIntent === "timeline";
  const excerpt =
    record.promptText.trim() ||
    record.requirementsText?.trim() ||
    t("agentMediaTasks.musicBlankRowExcerpt");
  return (
    <li
      data-testid={`amt-row-${record.id}`}
      className="rounded-lg border border-border bg-bg-1/70 px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-bg-3 text-fg-2">
          {record.kind === "tts" ? <Mic size={11} aria-hidden /> : <Music size={11} aria-hidden />}
        </span>
        <StatusBadge status={record.status} />
        <span className="ml-auto shrink-0 text-[10px] text-fg-muted">
          {t("agentMediaTasks.attempt", { count: record.attempt + 1 })}
        </span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-fg">{excerpt}</p>
      <p className="mt-1 text-[10px] text-fg-muted">
        {t("agentMediaTasks.targetProject", {
          name: record.targetProjectName || record.targetProjectId,
        })}
      </p>
      {record.autoConfirmNotice ? (
        <p
          role="note"
          data-testid="amt-auto-confirm-notice"
          className="mt-1.5 rounded-md border border-status-warning/30 bg-status-warning/8 px-2 py-1.5 text-[10px] leading-relaxed text-status-warning"
        >
          {t("agentMediaTasks.autoConfirmBadge")}：{record.autoConfirmNotice}
        </p>
      ) : null}
      {record.status === "error" || record.failureReason ? (
        <p
          role="alert"
          className="mt-1.5 rounded-md border border-status-error/30 bg-status-error/8 px-2 py-1.5 text-[10px] leading-relaxed text-status-error"
        >
          {record.error ? `${record.error.code}：` : ""}
          {record.failureReason}
        </p>
      ) : null}
      {rowError ? (
        <p
          role="alert"
          data-testid="amt-row-error"
          className="mt-1.5 rounded-md border border-status-error/30 bg-status-error/8 px-2 py-1.5 text-[10px] leading-relaxed text-status-error"
        >
          {rowError.message}
        </p>
      ) : null}
      {record.status === "awaiting_import" ? (
        <p className="mt-1.5 text-[10px] leading-relaxed text-fg-muted">
          {targetIsCurrent
            ? t("agentMediaTasks.awaitingImportReady")
            : t("agentMediaTasks.awaitingImportNote")}
        </p>
      ) : null}
      {record.status === "done" && record.resultMediaId ? (
        <>
          <p className="mt-1.5 text-[10px] leading-relaxed text-fg-muted">
            {t("agentMediaTasks.doneNote", { mediaId: record.resultMediaId })}
          </p>
          <DoneAudioPreview
            mediaId={record.resultMediaId}
            targetProjectId={record.targetProjectId}
            currentProjectId={currentProjectId}
          />
        </>
      ) : null}
      {record.status === "done" && record.insertedClipId ? (
        <p
          className="mt-1 text-[10px] leading-relaxed text-status-success"
          data-testid="amt-inserted-note"
        >
          {t("agentMediaTasks.insertedNote")}
        </p>
      ) : null}
      {cancellable || retryable || importable || insertable || manualConfirmable ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {importable && targetIsCurrent ? (
            <Button
              label={t("agentMediaTasks.importToProject")}
              size="sm"
              variant="secondary"
              isDisabled={busy}
              data-testid="amt-import"
              onClick={() => onImport(record)}
            />
          ) : null}
          {insertable && targetIsCurrent ? (
            <Button
              label={t("agentMediaTasks.insertTimeline")}
              size="sm"
              variant="secondary"
              isDisabled={busy}
              data-testid="amt-insert"
              onClick={() => onInsert(record)}
            />
          ) : null}
          {manualConfirmable ? (
            <>
              <Button
                label={t("agentMediaTasks.manualConfirm")}
                size="sm"
                variant="secondary"
                isDisabled={busy}
                data-testid="amt-manual-confirm"
                onClick={() => onManualConfirm(record)}
              />
              <Button
                label={t("agentMediaTasks.manualFail")}
                size="sm"
                variant="ghost"
                isDisabled={busy}
                data-testid="amt-manual-fail"
                onClick={() => onManualFail(record)}
              />
            </>
          ) : null}
          {retryable ? (
            <>
              <Button
                label={t("agentMediaTasks.retry")}
                icon={<RotateCcw size={11} aria-hidden />}
                size="sm"
                variant="secondary"
                data-testid="amt-retry"
                // A retry resubmits over the conversation lane, so it shares
                // the submission's session-busy gate instead of burning an
                // attempt on a prompt that cannot be delivered.
                isDisabled={busy || sessionBusy}
                onClick={() => onRetry(record)}
              />
              {sessionBusy ? (
                <span
                  className="text-[10px] text-fg-muted"
                  data-testid="amt-retry-busy-note"
                >
                  {t("agentMediaTasks.retryBusyNote")}
                </span>
              ) : null}
            </>
          ) : null}
          {cancellable ? (
            <Button
              label={t("agentMediaTasks.cancel")}
              size="sm"
              variant="ghost"
              isDisabled={busy}
              onClick={() => onCancel(record)}
            />
          ) : null}
          {retryable ? (
            <span className="text-[10px] text-fg-muted">{t("agentMediaTasks.retryNote")}</span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export const AgentMediaTaskDialog: React.FC = () => {
  const { t } = useTranslation();
  const activeModal = useUIStore((state) => state.activeModal);
  const closeModal = useUIStore((state) => state.closeModal);
  const project = useProjectStore((state) => state.project);
  const capabilityBits = useExternalConversationStore(
    (value) => value.state.conversation.capabilities,
  );
  const sessionBusy = useExternalConversationStore(
    (value) => value.sending || value.busy || value.cancelling,
  );

  const open = activeModal === AGENT_MEDIA_TASK_MODAL_ID;
  const connection = useAgentConnectionSetup();
  const { tasks, unreadable } = useAgentMediaTaskList();

  const [kind, setKind] = useState<AgentMediaTaskKind>("tts");
  const [text, setText] = useState("");
  const [requirements, setRequirements] = useState("");
  const [language, setLanguage] = useState("");
  const [durationText, setDurationText] = useState("");
  const [styleHint, setStyleHint] = useState("");
  const [insertIntent, setInsertIntent] = useState<AgentMediaTaskInsertIntent>("timeline");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const [rowError, setRowError] = useState<{ id: string; code: string; message: string } | null>(
    null,
  );
  const actionDeps = useAgentMediaTaskActionDeps();
  const insertDeps = useAgentMediaTaskInsertDeps();

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, closeModal]);

  const overrides = useMemo(() => {
    const parsedDuration = Number.parseFloat(durationText);
    return {
      ...(language.trim() ? { language: language.trim() } : {}),
      ...(Number.isFinite(parsedDuration) && parsedDuration > 0
        ? { targetDurationSeconds: parsedDuration }
        : {}),
      ...(styleHint.trim() ? { styleHint: styleHint.trim() } : {}),
    };
  }, [language, durationText, styleHint]);

  // A blank required field stays clickable so the validation message can
  // explain what is missing instead of a silently disabled button.
  const canSubmit = Boolean(project) && connection.ready && !sessionBusy && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!project) return;
    setSubmitError(null);
    if (kind === "tts" && !text.trim()) {
      setSubmitError({ code: "EMPTY_FIELD", message: t("agentMediaTasks.errorEmptyTts") });
      return;
    }
    if (kind === "music" && !taskHasRequirementText(requirements, overrides) && !text.trim()) {
      setSubmitError({ code: "EMPTY_FIELD", message: t("agentMediaTasks.errorEmptyMusic") });
      return;
    }
    if (!connection.ready) {
      setSubmitError({ code: "SESSION_NOT_READY", message: t("agentMediaTasks.errorNotReady") });
      return;
    }
    setSubmitting(true);
    try {
      const result = await submitAgentMediaTask(
        {
          kind,
          promptText: text.trim(),
          ...(requirements.trim() ? { requirementsText: requirements } : {}),
          ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
          targetProjectId: project.id,
          targetProjectName: project.name,
          insertIntent,
        },
        {
          service: getAgentMediaTaskService(),
          sendPrompt: (prompt) =>
            useExternalConversationStore.getState().prompt(prompt),
          capabilityBits,
          resolveRecommendedRoot: getRecommendedRootResolver(),
        },
      );
      if (!result.ok) {
        setSubmitError({ code: result.code, message: result.message });
      }
    } finally {
      setSubmitting(false);
    }
  }, [capabilityBits, connection.ready, insertIntent, kind, overrides, project, requirements, t, text]);

  const handleRetry = useCallback(
    async (record: AgentMediaTaskRecord) => {
      setSubmitError(null);
      // Same gate as submission: the retry resubmits over the single-flight
      // conversation lane, and a prompt sent while busy fails and burns the
      // freshly minted attempt.
      if (sessionBusy) {
        setSubmitError({ code: "SESSION_BUSY", message: t("agentMediaTasks.retryBusyNote") });
        return;
      }
      if (!connection.ready) {
        setSubmitError({ code: "SESSION_NOT_READY", message: t("agentMediaTasks.errorNotReady") });
        return;
      }
      setSubmitting(true);
      try {
        const result = await retryAgentMediaTask(record.id, {
          service: getAgentMediaTaskService(),
          sendPrompt: (prompt) => useExternalConversationStore.getState().prompt(prompt),
          capabilityBits,
          resolveRecommendedRoot: getRecommendedRootResolver(),
        });
        if (!result.ok) {
          setSubmitError({
            code: result.code,
            message: result.message,
            ...(result.params !== undefined ? { params: result.params } : {}),
          });
        }
      } finally {
        setSubmitting(false);
      }
    },
    [capabilityBits, connection.ready, sessionBusy, t],
  );

  const handleCancel = useCallback(async (record: AgentMediaTaskRecord) => {
    await cancelAgentMediaTask(record.id, getAgentMediaTaskService());
  }, []);

  const runRowAction = useCallback(
    async (
      record: AgentMediaTaskRecord,
      action: () => Promise<{ ok: boolean; code?: string; message?: string }>,
    ): Promise<void> => {
      setRowError(null);
      setSubmitting(true);
      try {
        const outcome = await action();
        if (!outcome.ok) {
          setRowError({
            id: record.id,
            code: outcome.code ?? "INTERNAL",
            message: outcome.message ?? String(outcome.code ?? "INTERNAL"),
          });
        }
      } finally {
        setSubmitting(false);
      }
    },
    [],
  );

  const handleImport = useCallback(
    (record: AgentMediaTaskRecord) => {
      void runRowAction(record, async () => {
        const outcome = await importAwaitingTask(record.id, actionDeps);
        return outcome.ok
          ? { ok: true }
          : { ok: false, code: outcome.code, message: outcome.message };
      });
    },
    [actionDeps, runRowAction],
  );

  const handleInsert = useCallback(
    (record: AgentMediaTaskRecord) => {
      void runRowAction(record, async () => {
        const outcome = await insertDoneTaskTimeline(record.id, insertDeps);
        return outcome.ok
          ? { ok: true }
          : { ok: false, code: outcome.code, message: outcome.message };
      });
    },
    [insertDeps, runRowAction],
  );

  const handleManualConfirm = useCallback(
    (record: AgentMediaTaskRecord) => {
      void runRowAction(record, async () => {
        const outcome = await confirmTaskArtifactManually(record.id, actionDeps);
        return outcome.ok
          ? { ok: true }
          : { ok: false, code: outcome.code, message: outcome.message };
      });
    },
    [actionDeps, runRowAction],
  );

  const handleManualFail = useCallback(
    (record: AgentMediaTaskRecord) => {
      void runRowAction(record, () =>
        markTaskFailedManually(record.id, actionDeps).then((outcome) =>
          outcome.ok
            ? { ok: true }
            : { ok: false, code: outcome.code, message: outcome.message },
        ),
      );
    },
    [actionDeps, runRowAction],
  );

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-black/40 p-4"
      onClick={closeModal}
      data-testid="agent-media-task-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("agentMediaTasks.title")}
        data-testid="agent-media-task-dialog"
        className="flex max-h-[85vh] w-full max-w-[540px] flex-col overflow-hidden rounded-[14px] border border-border bg-bg-1 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
          <span className="grid h-7 w-7 place-items-center rounded-lg border border-accent/30 bg-accent-soft text-accent">
            <AudioLines size={14} aria-hidden />
          </span>
          <h2 className="flex-1 text-[14px] font-bold text-fg">{t("agentMediaTasks.title")}</h2>
          <button
            type="button"
            aria-label={t("agentMediaTasks.close")}
            onClick={closeModal}
            className="grid h-7 w-7 place-items-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <X size={14} aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {!connection.conversationApiAvailable ? (
            <div
              role="note"
              data-testid="amt-desktop-notice"
              className="rounded-md border border-status-warning/30 bg-status-warning/8 px-2.5 py-2.5"
            >
              <p className="text-xs font-medium text-fg">
                {t("externalAgent.setup.desktopUnavailableTitle")}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
                {t("externalAgent.setup.desktopUnavailableDetail")}
              </p>
            </div>
          ) : !connection.ready ? (
            <div data-testid="amt-connection-guide" className="h-80">
              <p className="mb-2 text-xs font-medium text-fg">
                {t("agentMediaTasks.guideHeading")}
              </p>
              <AgentConnectionGuide
                provider={connection.provider}
                setup={connection.setup}
                selectedThread={connection.selectedThread}
                collabEnabled={connection.collabEnabled}
                busy={connection.busy}
                error={connection.failed}
                onProviderChange={connection.onProviderChange}
                onSelectThread={connection.onSelectThread}
                onRefresh={() => void connection.refresh()}
                onConnect={() => void connection.connect()}
              />
            </div>
          ) : (
            <section aria-label={t("agentMediaTasks.newTask")}>
              <div className="mb-1.5 grid grid-cols-2 gap-1 rounded-md bg-bg-2 p-1" role="tablist" aria-label={t("agentMediaTasks.kindLabel")}>
                {(["tts", "music"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="tab"
                    aria-selected={kind === option}
                    data-testid={`amt-kind-${option}`}
                    onClick={() => setKind(option)}
                    className={`flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-[11px] font-medium transition-colors ${
                      kind === option
                        ? "bg-bg-elev text-fg shadow-sm"
                        : "text-fg-muted hover:text-fg"
                    }`}
                  >
                    {option === "tts" ? <Mic size={12} aria-hidden /> : <Music size={12} aria-hidden />}
                    {t(option === "tts" ? "agentMediaTasks.kindTts" : "agentMediaTasks.kindMusic")}
                  </button>
                ))}
              </div>

              <label className="mt-2 block text-[11px] font-medium text-fg-2" htmlFor="amt-text">
                {t(kind === "tts" ? "agentMediaTasks.textLabelTts" : "agentMediaTasks.textLabelMusic")}
              </label>
              <textarea
                id="amt-text"
                data-testid="amt-text"
                value={text}
                onChange={(event) => setText(event.currentTarget.value)}
                placeholder={t(
                  kind === "tts"
                    ? "agentMediaTasks.textPlaceholderTts"
                    : "agentMediaTasks.textPlaceholderMusic",
                )}
                rows={3}
                maxLength={30_000}
                className="mt-1 w-full resize-y rounded-[9px] border border-border bg-bg px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
              />
              {kind === "music" ? (
                <p className="mt-1 text-[10px] text-fg-muted">
                  {t("agentMediaTasks.musicBlankHint")}
                </p>
              ) : null}

              <label className="mt-2 block text-[11px] font-medium text-fg-2" htmlFor="amt-requirements">
                {t("agentMediaTasks.requirementsLabel")}
              </label>
              <textarea
                id="amt-requirements"
                data-testid="amt-requirements"
                value={requirements}
                onChange={(event) => setRequirements(event.currentTarget.value)}
                placeholder={t("agentMediaTasks.requirementsPlaceholder")}
                rows={2}
                maxLength={30_000}
                className="mt-1 w-full resize-y rounded-[9px] border border-border bg-bg px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
              />

              <details className="mt-2 rounded-md border border-border px-3 py-2">
                <summary className="cursor-pointer text-[11px] font-medium text-fg-2">
                  {t("agentMediaTasks.overridesLabel")}
                </summary>
                <p className="mt-1 text-[10px] leading-relaxed text-fg-muted">
                  {t("agentMediaTasks.overridesNote")}
                </p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <label className="min-w-0">
                    <span className="block text-[10px] text-fg-muted">
                      {t("agentMediaTasks.overridesLanguage")}
                    </span>
                    <input
                      data-testid="amt-language"
                      value={language}
                      onChange={(event) => setLanguage(event.currentTarget.value)}
                      className="mt-0.5 w-full rounded-[7px] border border-border bg-bg px-2 py-1.5 text-[12px] text-fg outline-none focus:border-accent"
                    />
                  </label>
                  <label className="min-w-0">
                    <span className="block text-[10px] text-fg-muted">
                      {t("agentMediaTasks.overridesDuration")}
                    </span>
                    <input
                      data-testid="amt-duration"
                      type="number"
                      min={1}
                      step="any"
                      value={durationText}
                      onChange={(event) => setDurationText(event.currentTarget.value)}
                      className="mt-0.5 w-full rounded-[7px] border border-border bg-bg px-2 py-1.5 text-[12px] text-fg outline-none focus:border-accent"
                    />
                  </label>
                  <label className="min-w-0">
                    <span className="block text-[10px] text-fg-muted">
                      {t("agentMediaTasks.overridesStyle")}
                    </span>
                    <input
                      data-testid="amt-style"
                      value={styleHint}
                      onChange={(event) => setStyleHint(event.currentTarget.value)}
                      className="mt-0.5 w-full rounded-[7px] border border-border bg-bg px-2 py-1.5 text-[12px] text-fg outline-none focus:border-accent"
                    />
                  </label>
                </div>
              </details>

              <fieldset className="mt-3">
                <legend className="text-[11px] font-medium text-fg-2">
                  {t("agentMediaTasks.insertIntentLabel")}
                </legend>
                <div className="mt-1 flex gap-2">
                  {(["timeline", "library-only"] as const).map((option) => (
                    <label
                      key={option}
                      className={`flex flex-1 cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] ${
                        insertIntent === option
                          ? "border-accent/55 bg-accent-soft text-fg"
                          : "border-border text-fg-muted"
                      }`}
                    >
                      <input
                        type="radio"
                        name="amt-insert-intent"
                        className="accent-[var(--accent)]"
                        checked={insertIntent === option}
                        onChange={() => setInsertIntent(option)}
                        data-testid={`amt-intent-${option}`}
                      />
                      {t(
                        option === "timeline"
                          ? "agentMediaTasks.intentTimeline"
                          : "agentMediaTasks.intentLibraryOnly",
                      )}
                    </label>
                  ))}
                </div>
              </fieldset>

              {sessionBusy ? (
                <p
                  role="status"
                  data-testid="amt-session-busy"
                  className="mt-3 rounded-md border border-status-warning/30 bg-status-warning/8 px-2.5 py-2 text-[11px] leading-relaxed text-status-warning"
                >
                  {t("agentMediaTasks.sessionBusyNote")}
                </p>
              ) : null}
              {submitError ? (
                <p
                  role="alert"
                  data-testid="amt-submit-error"
                  className="mt-3 flex items-start gap-1.5 rounded-md border border-status-error/30 bg-status-error/8 px-2.5 py-2 text-[11px] leading-relaxed text-status-error"
                >
                  <CircleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
                  <span>
                    {t("agentMediaTasks.submitFailedLabel")}：
                    {describeSubmitError(submitError, t)}
                  </span>
                </p>
              ) : null}

              <div className="mt-3 flex items-center gap-3">
                <Button
                  label={submitting ? t("agentMediaTasks.submitting") : t("agentMediaTasks.submit")}
                  icon={
                    submitting ? (
                      <Loader2 size={12} className="animate-spin" aria-hidden />
                    ) : (
                      <AudioLines size={12} aria-hidden />
                    )
                  }
                  variant="primary"
                  size="sm"
                  isDisabled={!canSubmit}
                  data-testid="amt-submit"
                  onClick={() => void handleSubmit()}
                />
                <span className="text-[10px] leading-relaxed text-fg-muted">
                  {t("agentMediaTasks.resultVariesNote")}
                </span>
              </div>
            </section>
          )}

          <section aria-label={t("agentMediaTasks.tasks")} className="mt-4">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-muted">
              {t("agentMediaTasks.tasks")}
            </h3>
            {tasks.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-fg-muted">
                {t("agentMediaTasks.emptyTasks")}
              </p>
            ) : (
              <ul data-testid="amt-list" className="space-y-2">
                {tasks.map((record) => (
                  <TaskRow
                    key={record.id}
                    record={record}
                    busy={submitting}
                    sessionBusy={sessionBusy}
                    currentProjectId={project?.id ?? null}
                    rowError={rowError && rowError.id === record.id ? rowError : null}
                    onRetry={(task) => void handleRetry(task)}
                    onCancel={(task) => void handleCancel(task)}
                    onImport={handleImport}
                    onInsert={handleInsert}
                    onManualConfirm={handleManualConfirm}
                    onManualFail={handleManualFail}
                  />
                ))}
              </ul>
            )}
            <p className="mt-2 text-[10px] leading-relaxed text-fg-muted">
              {t("agentMediaTasks.cancelNote")}
            </p>
            {unreadable > 0 ? (
              <p className="mt-1 text-[10px] text-fg-muted">
                {t("agentMediaTasks.unreadableNote", { count: unreadable })}
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default AgentMediaTaskDialog;
