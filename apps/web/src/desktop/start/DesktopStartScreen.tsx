import type { JSX } from "react";
import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftBadge } from "@reelterminal/ui";
import { ToolcraftCard as Card } from "@reelterminal/ui";
import { ToolcraftClickableCard as ClickableCard } from "@reelterminal/ui";
import { ToolcraftHeading as Heading } from "@reelterminal/ui";
import { ToolcraftSelectableCard as SelectableCard } from "@reelterminal/ui";
import { ToolcraftText as Text } from "@reelterminal/ui";
import { ToolcraftButton as Button } from "@reelterminal/ui";
import { Box, Smartphone, Monitor, Square, Film } from "@/icons/lucide-compat";

import { ReelTerminalMark } from "@/components/brand/ReelTerminalMark";
import { Icon } from "@/icons/Icon";
import {
  DESKTOP_FORMATS,
  startNewProject,
  startNewMotionProject,
  listRecentProjects,
  openRecentProject,
  openProject,
  saveCurrentProject,
  type NewProjectFormat,
  type RecentEntry,
} from "./desktop-project-actions";
import { useUIStore } from "../../stores/ui-store";
import i18n from "../../i18n";
import { toast } from "../../stores/notification-store";

const FORMAT_ICONS: Record<string, React.ElementType> = {
  vertical: Smartphone,
  horizontal: Monitor,
  square: Square,
};

const FORMAT_LABEL_KEYS: Record<string, string> = {
  vertical: "desktop.start.formatVertical",
  horizontal: "desktop.start.formatHorizontal",
  square: "desktop.start.formatSquare",
};

function formatDimensions(format: NewProjectFormat): string {
  return `${format.width} × ${format.height} · ${format.frameRate}fps`;
}

function formatLastOpened(lastOpened: number): string {
  const date = new Date(lastOpened);
  const diffDays = Math.floor((Date.now() - lastOpened) / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return i18n.t("desktop.start.today");
  if (diffDays === 1) return i18n.t("desktop.start.yesterday");
  if (diffDays < 7) return i18n.t("desktop.start.daysAgo", { count: diffDays });
  return date.toLocaleDateString(i18n.language);
}

type ProjectMode = "edit" | "motion";

export function DesktopStartScreen({
  onProjectOpened,
  onCancel,
}: {
  onProjectOpened?: () => void;
  onCancel?: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [loadingRecents, setLoadingRecents] = useState<boolean>(true);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [projectMode, setProjectMode] = useState<ProjectMode>("edit");
  const setDesktopPage = useUIStore((state) => state.setDesktopPage);
  const busy = starting || openingId !== null;

  useEffect(() => {
    let active = true;
    listRecentProjects()
      .then((entries) => {
        if (active) setRecents(entries);
      })
      .catch(() => {
        if (active) setRecents([]);
      })
      .finally(() => {
        if (active) setLoadingRecents(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleOpenRecent = useCallback(async (projectId: string) => {
    setOpeningId(projectId);
    try {
      if (await openRecentProject(projectId)) {
        setDesktopPage("edit");
        onProjectOpened?.();
      }
    } catch (error) {
      toast.error(t("desktop.start.actionFailed"), error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningId(null);
    }
  }, [setDesktopPage, onProjectOpened, t]);

  const handleOpenProject = useCallback(async () => {
    setStarting(true);
    try {
      if (await openProject()) {
        setDesktopPage("edit");
        onProjectOpened?.();
      }
    } catch (error) {
      toast.error(t("desktop.start.actionFailed"), error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }, [setDesktopPage, onProjectOpened, t]);

  const handleStartProject = useCallback(async (format: NewProjectFormat) => {
    setStarting(true);
    try {
      await saveCurrentProject();
      if (projectMode === "motion") {
        startNewMotionProject(format);
      } else {
        startNewProject(format);
      }
      setDesktopPage(projectMode);
      onProjectOpened?.();
    } catch (error) {
      toast.error(t("desktop.start.actionFailed"), error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }, [projectMode, setDesktopPage, onProjectOpened, t]);

  const formatModeLabel = projectMode === "motion"
    ? t("desktop.start.modeMotion")
    : t("desktop.start.modeVideo");

  return (
    <div className="h-full overflow-y-auto bg-bg text-fg">
      <div className="mx-auto flex max-w-4xl flex-col gap-10 px-8 py-12">
        <div className="flex flex-wrap gap-3">
          {onCancel ? (
            <Button label={t("desktop.start.backToProject")} variant="secondary" onClick={onCancel} isDisabled={busy} />
          ) : null}
          <Button label={t("common.openProjectPicker")} variant="secondary" onClick={handleOpenProject} isDisabled={busy} />
        </div>
        <section>
          <div className="flex items-center gap-3">
            <ReelTerminalMark size={28} className="text-accent" />
            <div>
              <Heading level={1}>{t("desktop.appName")}</Heading>
              <Text type="supporting" display="block" className="mt-0.5">
                {t("desktop.tagline")}
              </Text>
            </div>
          </div>
          <Heading level={2} className="mt-8">
            {t("desktop.start.newProject")}
          </Heading>
          <Text type="supporting" display="block" className="mt-1">
            {t("desktop.start.chooseWorkspace")}
          </Text>
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SelectableCard
              label={t("desktop.start.videoEditor")}
              isSelected={projectMode === "edit"}
              onChange={() => setProjectMode("edit")}
              padding={5}
            >
              <div className="flex items-start gap-4">
                <span className="flex h-11 w-11 items-center justify-center rounded-md bg-accent-soft text-accent">
                  <Film size={22} aria-hidden />
                </span>
                <span>
                  <Text type="large" weight="bold" display="block">
                    {t("desktop.start.videoEditor")}
                  </Text>
                  <Text type="supporting" display="block" className="mt-1">
                    {t("desktop.start.videoEditorDescription")}
                  </Text>
                </span>
              </div>
            </SelectableCard>
            <SelectableCard
              label={t("desktop.start.motionCreator")}
              isSelected={projectMode === "motion"}
              onChange={() => setProjectMode("motion")}
              padding={5}
            >
              <div className="flex items-start gap-4">
                <span className="flex h-11 w-11 items-center justify-center rounded-md bg-accent text-accent-fg">
                  <Box size={22} aria-hidden />
                </span>
                <span>
                  <Text type="large" weight="bold" display="block">
                    {t("desktop.start.motionCreator")}
                  </Text>
                  <Text type="supporting" display="block" className="mt-1">
                    {t("desktop.start.motionCreatorDescription")}
                  </Text>
                </span>
              </div>
            </SelectableCard>
          </div>
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {DESKTOP_FORMATS.map((format) => {
              const FormatIcon = FORMAT_ICONS[format.id] ?? Film;
              const formatLabel = t(FORMAT_LABEL_KEYS[format.id] ?? format.label);
              return (
                <ClickableCard
                  key={format.id}
                  label={`${formatLabel} ${formatModeLabel}`}
                  onClick={() => handleStartProject(format)}
                  isDisabled={busy}
                  padding={5}
                >
                  <div className="relative flex flex-col items-start gap-3">
                    <Icon
                      name="plus.square"
                      size={16}
                      ariaHidden
                      className="absolute right-0 top-0 text-fg-muted"
                    />
                    <span className="flex h-11 w-11 items-center justify-center rounded-md bg-accent-soft text-accent">
                      <FormatIcon size={22} aria-hidden />
                    </span>
                    <Text type="large" weight="bold" display="block">
                      {formatLabel}
                    </Text>
                    <Text type="code" color="secondary" display="block">
                      {formatDimensions(format)}
                    </Text>
                    <ToolcraftBadge variant="success" label={formatModeLabel} />
                  </div>
                </ClickableCard>
              );
            })}
          </div>
        </section>

        <section>
          <Heading level={2} color="secondary">{t("desktop.start.recent")}</Heading>
          <Card className="mt-3" padding={0}>
            {loadingRecents ? (
              <Text type="supporting" display="block" className="px-4 py-6">
                {t("desktop.start.loadingRecent")}
              </Text>
            ) : recents.length === 0 ? (
              <Text type="supporting" display="block" className="px-4 py-6">
                {t("desktop.start.noRecent")}
              </Text>
            ) : (
              <ul className="divide-y divide-border">
                {recents.map((entry) => (
                  <li key={entry.id} className="p-1.5">
                    <ClickableCard
                      label={t("desktop.start.openProject", { name: entry.name })}
                      isDisabled={busy}
                      onClick={() => handleOpenRecent(entry.id)}
                      padding={2}
                      variant="transparent"
                    >
                      <div className="flex items-center gap-3">
                        <Icon name="clock" size={14} ariaHidden className="text-fg-muted" />
                        <span className="flex h-9 w-9 items-center justify-center rounded-md bg-bg-3 text-fg-muted">
                          <Film size={16} aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <Text type="body" weight="bold" display="block" maxLines={1}>
                            {entry.name}
                          </Text>
                          <Text type="supporting" display="block" className="mt-0.5">
                            {formatLastOpened(entry.lastOpened)}
                          </Text>
                        </span>
                      </div>
                    </ClickableCard>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      </div>
    </div>
  );
}
