import type { JSX } from "react";
import { useEffect } from "react";
import { AudioLines } from "@/icons/lucide-compat";
import { useTranslation } from "react-i18next";
import { useCollabStore, installCollabEventListener } from "../../stores/collab-store";
import { useUIStore } from "../../stores/ui-store";
import { AGENT_MEDIA_TASK_MODAL_ID } from "../../components/editor/dialogs/AgentMediaTaskDialog";
import { AnalysisRecordsPanel } from "./AnalysisRecordsPanel";

/** Compact status for local CLI access to the open desktop project. */
export function CollabStatusBar(): JSX.Element {
  const { t } = useTranslation();
  const enabled = useCollabStore((state) => state.enabled);
  const access = useCollabStore((state) => state.access);
  const currentAction = useCollabStore((state) => state.currentAction);
  const enable = useCollabStore((state) => state.enable);
  const disable = useCollabStore((state) => state.disable);
  const setAccess = useCollabStore((state) => state.setAccess);
  const openModal = useUIStore((state) => state.openModal);

  useEffect(() => {
    void useCollabStore.getState().refresh();
    return installCollabEventListener();
  }, []);

  return (
    <div
      className="flex h-full items-center gap-3 border-b border-border bg-bg-1 px-3 text-[11px] text-fg-2"
      role="status"
      aria-label={t("desktop.collaboration.accessStatus")}
      data-testid="agent-access-status"
    >
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={t("desktop.collaboration.agentAccess")}
        onClick={() => void (enabled ? disable() : enable())}
        className="flex items-center gap-1.5 text-fg-muted"
        data-testid="cli-availability"
      >
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${enabled ? "bg-status-success" : "bg-fg-muted"}`}
        />
        {enabled
          ? t("desktop.collaboration.cliAvailable")
          : t("desktop.collaboration.cliUnavailable")}
      </button>

      <span className="rounded-[5px] bg-bg-2 px-1.5 py-0.5" data-testid="agent-access-mode">
        {access === "read-only"
          ? t("desktop.collaboration.readOnly")
          : t("desktop.collaboration.writable")}
      </span>
      <button
        type="button"
        onClick={() => void setAccess(access === "read-only" ? "write" : "read-only")}
        className="rounded-[5px] px-1.5 py-0.5 font-medium text-accent hover:bg-accent-soft"
        title={t(
          access === "read-only"
            ? "desktop.collaboration.restoreWriteDescription"
            : "desktop.collaboration.setReadOnlyDescription",
        )}
        data-testid="agent-access-toggle"
      >
        {access === "read-only"
          ? t("desktop.collaboration.restoreWrite")
          : t("desktop.collaboration.setReadOnly")}
      </button>

      {currentAction ? (
        <span className="min-w-0 truncate text-accent" data-testid="agent-current-action">
          {t("desktop.collaboration.agentAction", { action: currentAction })}
        </span>
      ) : null}

      <div className="ml-auto flex items-center">
        <AnalysisRecordsPanel />
        <button
          type="button"
          data-testid="collab-agent-media-entry"
          aria-label={t("agentMediaTasks.entry")}
          onClick={() => openModal(AGENT_MEDIA_TASK_MODAL_ID)}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors text-fg-2 hover:bg-hover hover:text-fg"
        >
          <AudioLines size={13} aria-hidden />
          {t("agentMediaTasks.entry")}
        </button>
      </div>
    </div>
  );
}

export default CollabStatusBar;
