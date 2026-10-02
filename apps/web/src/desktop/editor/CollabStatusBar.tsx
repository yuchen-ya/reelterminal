import type { JSX } from "react";
import { useEffect, useState } from "react";
import { LayoutTemplate, LockKeyhole, Pencil } from "@/icons/lucide-compat";
import { useTranslation } from "react-i18next";
import {
  useCollabStore,
  installCollabEventListener,
} from "../../stores/collab-store";
import { useUIStore } from "../../stores/ui-store";
import { REQUIREMENT_BOARD_MODAL_ID } from "./RequirementBoardDialog";
import { useProjectStore } from "../../stores/project-store";

/** Compact status for local CLI access to the open desktop project. */
export function CollabStatusBar(): JSX.Element {
  const { t } = useTranslation();
  const [changingAccess, setChangingAccess] = useState(false);
  const enabled = useCollabStore((state) => state.enabled);
  const access = useCollabStore((state) => state.access);
  const currentAction = useCollabStore((state) => state.currentAction);
  const setAccess = useCollabStore((state) => state.setAccess);
  const openModal = useUIStore((state) => state.openModal);
  const readyRequirements = useProjectStore(
    (state) =>
      (state.project.requirements?.items ?? []).filter(
        (item) => item.status === "ready",
      ).length,
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
      <button
        type="button"
        disabled={!enabled || changingAccess}
        aria-pressed={access === "write"}
        title={t(
          access === "read-only"
            ? "desktop.collaboration.restoreWriteDescription"
            : "desktop.collaboration.setReadOnlyDescription",
        )}
        data-testid="agent-access-toggle"
        onClick={async () => {
          setChangingAccess(true);
          try {
            await setAccess(access === "write" ? "read-only" : "write");
          } finally {
            setChangingAccess(false);
          }
        }}
        className={`flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[11px] hover:bg-hover disabled:opacity-40 ${access === "write" ? "bg-accent-soft text-accent" : "bg-bg-2 text-fg-2"}`}
      >
        {access === "write" ? <Pencil size={12} /> : <LockKeyhole size={12} />}
        <span>
          {t(
            enabled
              ? "desktop.collaboration.agentReadable"
              : "desktop.collaboration.agentStarting",
          )}
        </span>
        <span aria-hidden>·</span>
        <span data-testid="agent-access-mode">
          {t(
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

      <div className="ml-auto flex items-center">
        <button
          type="button"
          data-testid="requirement-board-entry"
          aria-label={t("requirementBoard.title")}
          onClick={() => openModal(REQUIREMENT_BOARD_MODAL_ID)}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors text-fg-2 hover:bg-hover hover:text-fg"
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
