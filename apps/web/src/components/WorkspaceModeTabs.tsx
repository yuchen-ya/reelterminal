import type { JSX } from "react";
import { useTranslation } from "react-i18next";

export type WorkspaceMode = "video" | "motion" | "workbench";

const MODES: Array<{
  id: WorkspaceMode;
  labelKey:
    | "desktop.workspace.videoEditor"
    | "desktop.workspace.motionDesign"
    | "desktop.workspace.workbench";
}> = [
  { id: "video", labelKey: "desktop.workspace.videoEditor" },
  { id: "workbench", labelKey: "desktop.workspace.workbench" },
];

export function WorkspaceModeTabs({
  activeMode,
  onSelectMode,
  ariaLabel = "Editor workspaces",
  className = "",
  accessibleLabels,
  availableModes,
}: {
  activeMode: WorkspaceMode;
  onSelectMode: (mode: WorkspaceMode) => void;
  ariaLabel?: string;
  className?: string;
  accessibleLabels?: Partial<Record<WorkspaceMode, string>>;
  availableModes?: readonly WorkspaceMode[];
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-0 rounded-[7px] bg-bg-3 p-[2px] ${className}`}
    >
      {MODES.filter(mode => !availableModes || availableModes.includes(mode.id)).map((mode) => {
        const isActive = activeMode === mode.id;
        return (
          <button
            key={mode.id}
            type="button"
            role="tab"
            aria-label={accessibleLabels?.[mode.id]}
            aria-selected={isActive}
            onClick={() => onSelectMode(mode.id)}
            className={`rounded-[5px] px-3 py-1 text-xs transition-colors ${
              isActive
                ? "bg-bg-1 text-fg font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.12)]"
                : "bg-transparent text-fg-3 font-medium hover:text-fg-2"
            }`}
          >
            {t(mode.labelKey)}
          </button>
        );
      })}
    </div>
  );
}
