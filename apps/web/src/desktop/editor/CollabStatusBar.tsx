import type { JSX } from "react";
import { useEffect } from "react";
import { MessageSquare } from "@/icons/lucide-compat";
import { useTranslation } from "react-i18next";
import { useCollabStore, installCollabEventListener } from "../../stores/collab-store";
import { useUIStore } from "../../stores/ui-store";
import { REQUIREMENT_BOARD_MODAL_ID } from "./RequirementBoardDialog";
import { useProjectStore } from "../../stores/project-store";

/** Compact status for local CLI access to the open desktop project. */
export function CollabStatusBar(): JSX.Element {
  const { t } = useTranslation();
  const enabled = useCollabStore((state) => state.enabled);
  const access = useCollabStore((state) => state.access);
  const currentAction = useCollabStore((state) => state.currentAction);
  const setAccess = useCollabStore((state) => state.setAccess);
  const openModal = useUIStore((state) => state.openModal);
  const readyRequirements = useProjectStore((state) =>
    (state.project.requirements?.items ?? []).filter((item) => item.status === "ready").length,
  );

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
      <span className="flex items-center gap-1.5 text-fg-muted" data-testid="cli-availability">
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${enabled ? "bg-status-success" : "bg-fg-muted"}`}
        />
        {enabled
          ? t("desktop.collaboration.agentReadable")
          : t("desktop.collaboration.agentStarting")}
      </span>

      <span className="rounded-[5px] bg-bg-2 px-1.5 py-0.5" data-testid="agent-access-mode">
        {access === "read-only"
          ? t("desktop.collaboration.readOnly")
          : t("desktop.collaboration.writable")}
      </span>
      <button
        type="button"
        aria-pressed={access === "write"}
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
          ? t("desktop.collaboration.allowEditing")
          : t("desktop.collaboration.stopEditing")}
      </button>

      {currentAction ? (
        <span className="min-w-0 truncate text-accent" data-testid="agent-current-action">
          {t("desktop.collaboration.agentAction", { action: currentAction })}
        </span>
      ) : null}

      <div className="ml-auto flex items-center">
        <button
          type="button"
          data-testid="requirement-board-entry"
          aria-label={t("requirementBoard.title")}
          onClick={() => openModal(REQUIREMENT_BOARD_MODAL_ID)}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors text-fg-2 hover:bg-hover hover:text-fg"
        >
          <MessageSquare size={13} aria-hidden />
          {t("requirementBoard.title")}
          {readyRequirements > 0 ? <span className="rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-bold text-accent-fg">{readyRequirements}</span> : null}
        </button>
      </div>
    </div>
  );
}

export default CollabStatusBar;
