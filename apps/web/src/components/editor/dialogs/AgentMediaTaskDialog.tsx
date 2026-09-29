/**
 * Voiceover / music task history and artifact management.
 *
 * Generation submission and retry are paused until they have an independent
 * task mechanism. The ledger remains available so existing records and
 * artifacts can be inspected, imported, inserted, or cancelled.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  AudioLines,
  Loader2,
  Mic,
  Music,
  X,
} from "@/icons/lucide-compat";
import { ToolcraftButton as Button } from "@reelterminal/ui";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { getAgentMediaTaskService, subscribeAgentMediaTasks } from "../../../services/agent-media-tasks/agent-media-task-service";
import type {
  AgentMediaTaskRecord,
  AgentMediaTaskStatus,
} from "../../../services/agent-media-tasks/types";
import {
  confirmTaskArtifactManually,
  importAwaitingTask,
  markTaskFailedManually,
  type AgentTaskActionDeps,
} from "../../../services/agent-media-tasks/task-import";
import {
  insertDoneTaskTimeline,
  type AgentTaskInsertDeps,
} from "../../../services/agent-media-tasks/task-insert";

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
function useAgentMediaTaskActionDeps(): AgentTaskActionDeps {
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
  currentProjectId,
  rowError,
  onCancel,
  onImport,
  onInsert,
  onManualConfirm,
  onManualFail,
}: {
  readonly record: AgentMediaTaskRecord;
  readonly busy: boolean;
  readonly currentProjectId: string | null;
  readonly rowError: { readonly code: string; readonly message: string } | null;
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
            <span className="text-[10px] text-fg-muted" data-testid="amt-retry-paused-note">
              {t("agentMediaTasks.retryPausedNote")}
            </span>
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

  const open = activeModal === AGENT_MEDIA_TASK_MODAL_ID;
  const { tasks, unreadable } = useAgentMediaTaskList();

  const [busy, setBusy] = useState(false);
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

  const runRowAction = useCallback(
    async (
      record: AgentMediaTaskRecord,
      action: () => Promise<{ ok: boolean; code?: string; message?: string }>,
    ): Promise<void> => {
      setRowError(null);
      setBusy(true);
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
        setBusy(false);
      }
    },
    [],
  );

  const handleCancel = useCallback(
    (record: AgentMediaTaskRecord) => {
      void runRowAction(record, async () => {
        const result = await getAgentMediaTaskService().markCancelled(record.id);
        return result.ok
          ? { ok: true }
          : { ok: false, code: result.code, message: result.message };
      });
    },
    [runRowAction],
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
          <div
            role="status"
            data-testid="amt-generation-paused"
            className="rounded-md border border-status-warning/30 bg-status-warning/8 px-2.5 py-2.5 text-[11px] leading-relaxed text-fg-2"
          >
            {t("agentMediaTasks.generationPausedNotice")}
          </div>

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
                    busy={busy}
                    currentProjectId={project?.id ?? null}
                    rowError={rowError && rowError.id === record.id ? rowError : null}
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
