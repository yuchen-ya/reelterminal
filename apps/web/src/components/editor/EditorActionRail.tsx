import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  ToolcraftDropdownMenu as DropdownMenu,
  ToolcraftIconButton as IconButton,
  ToolcraftTooltip as Tooltip,
} from "@reelterminal/ui";
import { Icon } from "@/icons/Icon";
import {
  House,
  Sun,
  Moon,
  SunMoon,
  Settings,
  Circle,
  Play,
  Sparkles,
  HelpCircle,
  FileCode,
  Command,
} from "@/icons/lucide-compat";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import { useThemeStore } from "../../stores/theme-store";
import { useSettingsStore } from "../../stores/settings-store";
import { useRouter } from "../../hooks/use-router";
import {
  startTour,
  ONBOARDING_KEY,
  startMoGraphTour,
  MOGRAPH_TOUR_KEY,
} from "./tour";

const RailButton: React.FC<{
  label: string;
  icon: string;
  onClick: () => void;
  active?: boolean;
}> = ({ label, icon, onClick, active = false }) => (
  <Tooltip content={label} placement="end">
    <IconButton
      label={label}
      icon={<Icon name={icon} size={16} ariaHidden />}
      size="sm"
      variant={active ? "secondary" : "ghost"}
      onClick={onClick}
    />
  </Tooltip>
);

export const EditorActionRail: React.FC = () => {
  const { t } = useTranslation();
  const { undo, redo, createMotionComposition } = useProjectStore();
  const {
    openModal,
    toggleKeyframeEditor,
    keyframeEditorOpen,
    panels,
    togglePanel,
    activeModal,
  } = useUIStore();
  const { mode: themeMode, toggleTheme } = useThemeStore();
  const { openSettings } = useSettingsStore();
  const { navigate } = useRouter();

  const themeLabel =
    themeMode === "auto"
      ? t("editorRail.themeSystem")
      : themeMode === "light"
        ? t("editorRail.themeLight")
        : t("editorRail.themeDark");
  const nextThemeLabel =
    themeMode === "light"
      ? t("editorRail.themeDark")
      : themeMode === "dark"
        ? t("editorRail.themeSystem")
        : t("editorRail.themeLight");
  const themeIcon =
    themeMode === "light" ? (
      <Sun size={16} aria-hidden />
    ) : themeMode === "dark" ? (
      <Moon size={16} aria-hidden />
    ) : (
      <SunMoon size={16} aria-hidden />
    );
  const themeActionLabel = t("editorRail.themeAction", {
    current: themeLabel,
    next: nextThemeLabel,
  });

  const handleCreateMotionScene = useCallback(async () => {
    const composition = await createMotionComposition("Motion Scene");
    if (composition) {
      navigate("motion", { compositionId: composition.id });
    }
  }, [createMotionComposition, navigate]);

  return (
    <nav
      data-tour="toolbar"
      aria-label={t("editorRail.ariaLabel")}
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-bg-1 py-3"
    >
      <Tooltip content={t("editorRail.backHome")} placement="end">
        <IconButton
          label={t("editorRail.backHome")}
          icon={<House size={16} aria-hidden />}
          size="sm"
          variant="ghost"
          onClick={() => navigate("welcome")}
        />
      </Tooltip>

      <div className="my-1.5 h-px w-6 bg-border" />

      <RailButton
        label={t("editorRail.search")}
        icon="magnifyingglass"
        onClick={() => openModal("search")}
      />
      <RailButton
        label={t("editorRail.undo")}
        icon="arrow.uturn.backward"
        onClick={() => void undo()}
      />
      <RailButton
        label={t("editorRail.redo")}
        icon="arrow.uturn.forward"
        onClick={() => void redo()}
      />

      <div className="my-1.5 h-px w-6 bg-border" />

      <RailButton
        label={t("editorRail.createMotionScene")}
        icon="cube"
        onClick={() => void handleCreateMotionScene()}
      />
      <RailButton
        label={t("editorRail.actionHistory")}
        icon="clock"
        onClick={() => openModal("history")}
        active={activeModal === "history"}
      />
      <RailButton
        label={t("editorRail.keyframeEditor")}
        icon="diamond"
        onClick={toggleKeyframeEditor}
        active={keyframeEditorOpen}
      />
      <RailButton
        label={t("editorRail.audioMixer")}
        icon="music.note"
        onClick={() => togglePanel("audioMixer")}
        active={Boolean(panels.audioMixer?.visible)}
      />
      <RailButton
        label={t("editorRail.projectData")}
        icon="curlybraces"
        onClick={() => openModal("scriptView")}
      />

      <div className="flex-1" />

      <Tooltip content={themeActionLabel} placement="end">
        <IconButton
          label={themeActionLabel}
          icon={themeIcon}
          size="sm"
          variant="secondary"
          onClick={toggleTheme}
        />
      </Tooltip>

      <DropdownMenu
        placement="end"
        button={{
          label: t("editorRail.moreActions"),
          icon: <Icon name="star" size={16} ariaHidden />,
          size: "sm",
          variant: "ghost",
          isIconOnly: true,
        }}
        hasChevron={false}
        menuWidth={224}
        items={[
          {
            label: t("common.settings"),
            icon: <Settings size={14} aria-hidden />,
            onClick: () => openSettings(),
          },
          {
            label: t("editorRail.screenRecorder"),
            icon: (
              <Circle
                size={14}
                className="fill-current text-status-error"
                aria-hidden
              />
            ),
            onClick: () => openModal("recorder"),
          },
          { type: "divider" },
          {
            label: t("editorRail.editorTour"),
            icon: <Play size={14} aria-hidden />,
            onClick: () => {
              localStorage.removeItem(ONBOARDING_KEY);
              startTour();
            },
          },
          {
            label: t("editorRail.animationTour"),
            icon: <Sparkles size={14} className="text-accent" aria-hidden />,
            onClick: () => {
              localStorage.removeItem(MOGRAPH_TOUR_KEY);
              startMoGraphTour();
            },
          },
          { type: "divider" },
          {
            label: t("editorRail.helpShortcuts"),
            icon: <HelpCircle size={14} aria-hidden />,
            isDisabled: true,
          },
          {
            label: t("editorRail.projectJson"),
            icon: <FileCode size={14} aria-hidden />,
            isDisabled: true,
          },
          {
            label: t("editorRail.searchShortcut"),
            icon: <Command size={14} aria-hidden />,
            isDisabled: true,
          },
        ]}
      />
    </nav>
  );
};
