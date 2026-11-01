import { useTranslation } from "react-i18next";
import { useRef } from "react";
import { Plus, X } from "lucide-react";
import { useWorkbenchTabsStore, workbenchTabKey } from "../../../stores/workbench-tabs-store";
import { FreeBoardIcon, ReviewTaskIcon, WorkspaceDirectoryIcon } from "./WorkbenchIcons";

export function WorkbenchTabs({
  locked,
  managerOpen = false,
  onActivate,
  onClose,
  onOpen,
  onCloseManager,
}: {
  locked: boolean;
  managerOpen?: boolean;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onOpen: () => void;
  onCloseManager?: () => void;
}) {
  const { t } = useTranslation();
  const { tabs, activeKey, move } = useWorkbenchTabsStore();
  const dragging = useRef<string | null>(null);
  return (
    <div
      className="relative flex h-9 shrink-0 items-end bg-[var(--wb-tab-track)] px-2 pt-1.5 select-none before:pointer-events-none before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-border"
      data-testid="workbench-tabs"
    >
      <div
        role="tablist"
        aria-label={t("review.title")}
        className="relative z-10 flex min-w-0 items-end gap-0.5 overflow-x-auto scrollbar-none"
      >
        {tabs.map((tab, index) => {
          const key = workbenchTabKey(tab);
          const active = !managerOpen && key === activeKey;
          const nextTab = tabs[index + 1];
          const nextActive = nextTab
            ? !managerOpen && workbenchTabKey(nextTab) === activeKey
            : managerOpen;
          return (
            <div
              key={key}
              className={`group relative flex w-48 shrink-0 items-center transition-colors ${
                active
                  ? "wb-tab-active z-10 h-[31px] rounded-t-lg border-x border-t border-b-0 text-fg"
                  : "mb-px h-[29px] rounded-t-lg border-x border-t border-transparent text-fg-2 hover:bg-bg-1 hover:text-fg"
              }`}
              draggable={!locked}
              onDragStart={event => {
                dragging.current = key;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("application/x-reelterminal-workbench-tab", key);
              }}
              onDragEnd={() => {
                dragging.current = null;
              }}
              onDragOver={event => {
                if (!locked && dragging.current) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={event => {
                if (!locked && dragging.current) {
                  event.preventDefault();
                  event.stopPropagation();
                  move(dragging.current, key);
                  dragging.current = null;
                }
              }}
            >
              <button
                role="tab"
                aria-selected={active}
                disabled={locked}
                data-testid={`${tab.kind === "review" ? "review" : "board"}-tab-${tab.id}`}
                className={`flex h-full min-w-0 flex-1 items-center gap-2 pl-3 pr-1 text-left text-xs disabled:opacity-50 ${
                  active ? "font-medium text-fg" : "text-fg-2 group-hover:text-fg"
                }`}
                onClick={() => onActivate(key)}
                title={tab.name}
              >
                <span
                  className={`shrink-0 ${
                    active
                      ? tab.kind === "review"
                        ? "text-accent"
                        : "text-sky-400"
                      : "text-fg-3 group-hover:text-fg-2"
                  }`}
                  aria-hidden
                >
                  {tab.kind === "review" ? (
                    <ReviewTaskIcon className="h-3.5 w-3.5" />
                  ) : (
                    <FreeBoardIcon className="h-3.5 w-3.5" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">{tab.name}</span>
              </button>
              <button
                disabled={locked}
                className={`mr-1.5 flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors disabled:opacity-40 ${
                  active
                    ? "text-fg-3 hover:bg-bg-2 hover:text-fg"
                    : "text-fg-3 opacity-70 group-hover:opacity-100 hover:bg-bg-2 hover:text-fg"
                }`}
                aria-label={t("Close {{v0}}", { v0: tab.name })}
                data-testid={`close-tab-${tab.kind}-${tab.id}`}
                onClick={() => onClose(key)}
              >
                <X className="h-3 w-3" />
              </button>
              {!active && !nextActive && (index < tabs.length - 1 || managerOpen) && (
                <span
                  className="pointer-events-none absolute -right-[3px] top-2 h-3.5 w-px bg-border group-hover:opacity-0"
                  aria-hidden
                />
              )}
            </div>
          );
        })}

        {managerOpen && (
          <div
            className="wb-tab-active group relative z-10 flex h-[31px] w-48 shrink-0 items-center rounded-t-lg border-x border-t border-b-0 text-fg"
            data-testid="workbench-manager-tab"
          >
            <button
              type="button"
              role="tab"
              aria-selected={true}
              disabled={locked}
              className="flex h-full min-w-0 flex-1 items-center gap-2 pl-3 pr-1 text-left text-xs font-medium text-fg disabled:opacity-50"
              title={t("Open and manage workspaces")}
            >
              <span className="shrink-0 text-accent" aria-hidden>
                <WorkspaceDirectoryIcon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate">{t("Open / Manage")}</span>
            </button>
            {onCloseManager && (
              <button
                type="button"
                disabled={locked}
                className="mr-1.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-fg-3 transition-colors hover:bg-bg-2 hover:text-fg disabled:opacity-40"
                aria-label={t("Close the Open / Manage tab")}
                data-testid="close-tab-manager"
                onClick={onCloseManager}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </div>

      <button
        disabled={locked}
        className="relative z-10 mb-1 ml-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-bg-1 hover:text-fg disabled:opacity-40"
        data-testid="review-workspace-open"
        aria-label={t("Open or manage review tasks and free boards")}
        onClick={onOpen}
        title={t("Open or manage review tasks and free boards")}
      >
        <Plus className="h-4 w-4" />
        <span className="sr-only">{t("Open / Manage")}</span>
      </button>
    </div>
  );
}
