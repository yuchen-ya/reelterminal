import type { JSX } from "react";
import { useEffect, useState } from "react";
import { LayoutTemplate, LockKeyhole, Pencil } from "@/icons/lucide-compat";
import { useTranslation } from "react-i18next";
import {
  useCollabStore,
  installCollabEventListener,
} from "../../stores/collab-store";
import { useUIStore, REQUIREMENT_BOARD_MODAL_ID } from "../../stores/ui-store";
import { useProjectStore } from "../../stores/project-store";
import { toast, useNotificationStore } from "../../stores/notification-store";

/** Compact status for local CLI access to the open desktop project. */
export function CollabStatusBar({ onConnectRequested }: {
  onConnectRequested?: () => void;
} = {}): JSX.Element {

  const { t } = useTranslation();
  const [changingAccess, setChangingAccess] = useState(false);
  const enabled = useCollabStore((state) => state.enabled);
  const access = useCollabStore((state) => state.access);
  const currentAction = useCollabStore((state) => state.currentAction);
  const taskProgress = useCollabStore((state) => state.taskProgress);
  const runningTasks = Object.values(taskProgress).filter((task) => task.state === "queued" || task.state === "running");
  const setAccess = useCollabStore((state) => state.setAccess);
  const openModal = useUIStore((state) => state.openModal);
  const readyRequirements = useProjectStore(
    (state) =>
      (state.project.requirements?.items ?? []).filter(
        (item) => item.status === "review" || item.status === "blocked",
      ).length,
  );

  useEffect(() => {
    void useCollabStore.getState().refresh();
    return installCollabEventListener();
  }, []);

  return (
    <div
      className="flex h-full items-center gap-2 border-b border-border bg-bg-1 px-3 text-xs text-fg-2"
      role="status"
      aria-label={t("desktop.collaboration.accessStatus")}
      data-testid="agent-access-status"
    >
      <button
        type="button"
        disabled={!onConnectRequested && (!enabled || changingAccess)}
        aria-pressed={access === "write"}
        title={t(
          access === "read-only"
            ? "desktop.collaboration.restoreWriteDescription"
            : "desktop.collaboration.setReadOnlyDescription",
        )}
        data-testid="agent-access-toggle"
        onClick={async () => {
          if (onConnectRequested) {
            onConnectRequested();
            return;
          }
          setChangingAccess(true);
          try {
            await setAccess(access === "write" ? "read-only" : "write");
            const status = useCollabStore.getState();
            if (access === "read-only" && status.access === "write" && !status.startupHintShown) {
              useCollabStore.setState({ startupHintShown: true });
              const notificationId = useNotificationStore.getState().addNotification({
                type: "info",
                title: t("desktop.collaboration.startupTitle"),
                message: t("desktop.collaboration.startupDescription"),
                duration: 0,
                onClickLabel: t("desktop.collaboration.copyStartupPrompt"),
                onClick: async () => {
                  try {
                    const { project, workspaceId } = useProjectStore.getState();
                    if (!workspaceId) throw new Error("The project workspace is not ready");
                    const info = await window.reelterminal!.collabControl!.getStartupInfo({ kind: "video", projectId: project.id, workspaceId });
                    await navigator.clipboard.writeText(t("desktop.collaboration.startupPrompt", info));
                    useNotificationStore.getState().removeNotification(notificationId);
                    toast.success(t("desktop.collaboration.startupCopied"));
                  } catch (error) {
                    toast.error(t("desktop.collaboration.startupCopyFailed"), error instanceof Error ? error.message : String(error));
                  }
                },
              });
            }
          } finally {
            setChangingAccess(false);
          }
        }}
        className={`flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[11px] hover:bg-hover disabled:opacity-40 ${access === "write" ? "bg-accent-soft text-accent" : "bg-bg-2 text-fg-2"}`}
      >
        {access === "write" ? <Pencil size={12} /> : <LockKeyhole size={12} />}
        <span>
          {onConnectRequested ? "Agent" : t(
            enabled
              ? "desktop.collaboration.agentReadable"
              : "desktop.collaboration.agentStarting",
          )}
        </span>
        <span aria-hidden>·</span>
        <span data-testid="agent-access-mode">
          {onConnectRequested ? "未连接" : t(
            access === "write"
              ? "desktop.collaboration.writable"
              : "desktop.collaboration.readOnly",
          )}
        </span>
      </button>

      {currentAction ? (
        <span
          className="min-w-0 truncate text-accent"
          data-testid="agent-current-action"
        >
          {t("desktop.collaboration.agentAction", { action: currentAction })}
        </span>
      ) : null}
      {runningTasks.length > 0 && <span data-testid="background-task-progress" className="max-w-64 truncate text-fg-2" title={runningTasks.map((task) => `${task.jobId} · ${task.projectId} / ${task.workspaceId} · r${task.sourceRevision}`).join("\n")}>
        {runningTasks.map((task) => {
          const taskLabel = task.kind === "export" ? "versioning.exportTask"
            : task.kind === "analysis" ? "versioning.analysisTask" : "versioning.audioProcessTask";
          return `${t(taskLabel)} ${Math.round(task.progress?.percent ?? 0)}%`;
        }).join(" · ")}
      </span>}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <button type="button" data-testid="current-archive-entry" title={t("versioning.viewRecords")}
          onClick={() => useUIStore.getState().showCurrentArchive()}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-fg-2 transition-colors duration-150 hover:bg-hover hover:text-fg motion-reduce:transition-none">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />{t("desktopInspector.archives")}
        </button>
        <button
          type="button"
          data-testid="requirement-board-entry"
          aria-label={t("requirementBoard.title")}
          onClick={() => openModal(REQUIREMENT_BOARD_MODAL_ID, { projectId: useProjectStore.getState().project.id })}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-bg-2 px-2.5 text-[11px] font-medium text-fg transition-colors hover:bg-hover"
        >
          <LayoutTemplate size={13} aria-hidden />
          {t("requirementBoard.title")}
          {readyRequirements > 0 ? (
            <span className="rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-bold text-accent-fg">
              {readyRequirements}
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}

export default CollabStatusBar;
