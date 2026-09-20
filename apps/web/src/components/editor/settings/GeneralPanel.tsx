import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftSwitchControl } from "@reelterminal/ui";
import { ToolcraftButton as Button } from "@reelterminal/ui";
import { ToolcraftClickableCard as ClickableCard } from "@reelterminal/ui";
import { ToolcraftNumberInputControl } from "@reelterminal/ui";
import { ToolcraftSelectControl as Selector } from "@reelterminal/ui";
import { ToolcraftText as Text } from "@reelterminal/ui";
import { useSettingsStore } from "../../../stores/settings-store";
import { useProjectStore } from "../../../stores/project-store";
import type { LanguagePreference } from "../../../i18n";
import {
  autoSaveManager,
  type AutoSaveStatus,
} from "../../../services/auto-save";

const ASPECT_PRESETS: Array<{ labelKey: string; width: number; height: number }> = [
  { labelKey: "settings.presetLandscape", width: 1920, height: 1080 },
  { labelKey: "settings.presetVertical", width: 1080, height: 1920 },
  { labelKey: "settings.presetSquare", width: 1080, height: 1080 },
  { labelKey: "settings.presetPortrait", width: 1080, height: 1350 },
  { labelKey: "settings.presetStandard", width: 1440, height: 1080 },
  { labelKey: "settings.presetCinematic", width: 2560, height: 1080 },
  { labelKey: "settings.preset4k", width: 3840, height: 2160 },
];

const BACKGROUND_SWATCHES = [
  "#000000",
  "#FFFFFF",
  "#1E1E1E",
  "#2563EB",
  "#DC2626",
  "#16A34A",
  "#F59E0B",
  "#9333EA",
  "#DB2777",
  "#0EA5E9",
];

export const GeneralPanel: React.FC = () => {
  const { t } = useTranslation();
  const {
    autoSave,
    autoSaveInterval,
    language,
    setAutoSave,
    setAutoSaveInterval,
    setLanguage,
  } = useSettingsStore();

  const projectWidth = useProjectStore((s) => s.project.settings.width);
  const projectHeight = useProjectStore((s) => s.project.settings.height);
  const updateProjectSettings = useProjectStore((s) => s.updateSettings);
  const backgroundFillMode = useProjectStore(
    (s) => s.project.timeline.backgroundFillMode,
  );
  const layoutBackgroundColor = useProjectStore(
    (s) => s.project.timeline.layoutBackgroundColor,
  );
  const setCanvasBackground = useProjectStore((s) => s.setCanvasBackground);

  const [draftWidth, setDraftWidth] = React.useState(String(projectWidth));
  const [draftHeight, setDraftHeight] = React.useState(String(projectHeight));
  const [autoSaveStatus, setAutoSaveStatus] =
    React.useState<AutoSaveStatus>(() => autoSaveManager.getStatus());

  React.useEffect(() => {
    setDraftWidth(String(projectWidth));
    setDraftHeight(String(projectHeight));
  }, [projectWidth, projectHeight]);

  React.useEffect(() => {
    const onSaving = (): void => setAutoSaveStatus("saving");
    const onPending = (): void => setAutoSaveStatus("pending");
    const onSaved = (): void => setAutoSaveStatus("saved");
    const onError = (): void => setAutoSaveStatus("error");
    autoSaveManager.on("pending", onPending);
    autoSaveManager.on("saving", onSaving);
    autoSaveManager.on("saved", onSaved);
    autoSaveManager.on("error", onError);
    return () => {
      autoSaveManager.off("pending", onPending);
      autoSaveManager.off("saving", onSaving);
      autoSaveManager.off("saved", onSaved);
      autoSaveManager.off("error", onError);
    };
  }, []);

  const applyDimensions = useCallback(
    async (width: number, height: number) => {
      const w = Math.max(16, Math.min(7680, Math.round(width)));
      const h = Math.max(16, Math.min(7680, Math.round(height)));
      await updateProjectSettings({ width: w, height: h });
    },
    [updateProjectSettings],
  );

  const handleApplyCustom = useCallback(() => {
    const w = Number(draftWidth);
    const h = Number(draftHeight);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      applyDimensions(w, h);
    }
  }, [draftWidth, draftHeight, applyDimensions]);

  return (
    <div className="space-y-6 pb-4">
      <div className="space-y-3">
        <div>
          <Text type="body" color="primary" className="text-sm font-medium">
            {t("settings.language")}
          </Text>
          <Text type="supporting" color="secondary" className="mt-0.5 text-xs">
            {t("settings.languageDescription")}
          </Text>
        </div>
        <Selector
          label={t("settings.language")}
          size="md"
          width={220}
          value={language}
          onChange={(value) => setLanguage(value as LanguagePreference)}
          options={[
            { label: t("common.systemDefault"), value: "system" },
            { label: t("settings.english"), value: "en" },
            { label: t("settings.simplifiedChinese"), value: "zh-CN" },
          ]}
        />
      </div>

      <div className="h-px bg-border" />

      {/* Project Composition */}
      <div className="space-y-4">
        <div>
          <Text type="body" color="primary" className="text-sm font-medium">
            {t("settings.projectComposition")}
          </Text>
          <Text type="supporting" color="secondary" className="mt-0.5 text-xs">
            {t("settings.projectCompositionDescription")}
          </Text>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {ASPECT_PRESETS.map((preset) => {
            const isActive =
                preset.width === projectWidth && preset.height === projectHeight;
            return (
              <ClickableCard
                key={preset.labelKey}
                label={t(preset.labelKey)}
                onClick={() => applyDimensions(preset.width, preset.height)}
                padding={3}
                variant={isActive ? "green" : "muted"}
                className={`text-left text-xs border ${
                  isActive
                    ? "border-primary bg-primary/10 text-text-primary"
                    : "border-border bg-background-tertiary text-text-secondary hover:text-text-primary hover:border-primary/40"
                }`}
              >
                <Text type="supporting" color="inherit" className="font-medium">
                  {t(preset.labelKey)}
                </Text>
                <Text type="supporting" color="secondary" className="mt-0.5 text-[10px]">
                  {preset.width} × {preset.height}
                </Text>
              </ClickableCard>
            );
          })}
        </div>

        <div className="flex items-end gap-2">
          <ToolcraftNumberInputControl
            label={t("settings.width")}
            size="md"
            width="100%"
            min={16}
            max={7680}
            value={Number.isFinite(Number(draftWidth)) ? Number(draftWidth) : null}
            onChange={(value) => setDraftWidth(String(value))}
          />
          <ToolcraftNumberInputControl
            label={t("settings.height")}
            size="md"
            width="100%"
            min={16}
            max={7680}
            value={Number.isFinite(Number(draftHeight)) ? Number(draftHeight) : null}
            onChange={(value) => setDraftHeight(String(value))}
          />
          <Button
            label={t("common.apply")}
            onClick={handleApplyCustom}
            variant="primary"
            size="md"
          />
        </div>

        <div className="space-y-2">
          <Text type="supporting" color="secondary" className="text-xs font-medium">
            {t("settings.backgroundFill")}
          </Text>
          <Text type="supporting" color="secondary" className="text-[11px]">
            {t("settings.backgroundFillDescription")}
          </Text>
          <div className="flex flex-wrap items-center gap-2">
            <ClickableCard
              label={t("settings.noBackgroundFill")}
              onClick={() => setCanvasBackground(undefined, undefined)}
              padding={2}
              variant={!backgroundFillMode ? "green" : "muted"}
              className={`border px-3 py-1.5 text-xs ${
                !backgroundFillMode
                  ? "border-primary bg-primary/10 text-text-primary"
                  : "border-border bg-background-tertiary text-text-secondary hover:text-text-primary"
              }`}
            >
              {t("None")}</ClickableCard>
            <ClickableCard
              label={t("settings.blurBackgroundFill")}
              onClick={() =>
                setCanvasBackground("blur", layoutBackgroundColor)
              }
              padding={2}
              variant={backgroundFillMode === "blur" ? "green" : "muted"}
              className={`border px-3 py-1.5 text-xs ${
                backgroundFillMode === "blur"
                  ? "border-primary bg-primary/10 text-text-primary"
                  : "border-border bg-background-tertiary text-text-secondary hover:text-text-primary"
              }`}
            >
              {t("Blur")}</ClickableCard>
            {BACKGROUND_SWATCHES.map((hex) => {
              const isActive =
                backgroundFillMode === "color" &&
                layoutBackgroundColor?.toLowerCase() === hex.toLowerCase();
              return (
                <ClickableCard
                  key={hex}
                  label={t("settings.backgroundColor", { color: hex })}
                  onClick={() => setCanvasBackground("color", hex)}
                  padding={0}
                  variant="transparent"
                  style={{ backgroundColor: hex }}
                  className={`h-6 w-6 rounded-full border-2 transition-transform ${
                    isActive
                      ? "border-primary scale-110"
                      : "border-border hover:scale-105"
                  }`}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div className="h-px bg-border" />

      {/* Auto-save */}
      <div className="space-y-4">
        <Text type="body" color="primary" className="text-sm font-medium">
          {t("settings.autoSave")}
        </Text>

        <div className="flex items-center justify-between">
          <div>
            <Text type="supporting" color="secondary" className="text-sm">
              {t("settings.enableAutoSave")}
            </Text>
            <Text type="supporting" color="secondary" className="mt-0.5 text-xs">
              {t("settings.enableAutoSaveDescription")}
            </Text>
          </div>
          <ToolcraftSwitchControl
            ariaLabel={t("settings.enableAutoSave")}
            checked={autoSave}
            onCheckedChange={setAutoSave}
            showLabel={false}
          />
        </div>

        {autoSave && (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Text type="supporting" color="secondary" className="whitespace-nowrap text-sm">
                {t("settings.saveEvery")}
              </Text>
              <Selector
                label={t("settings.autoSaveInterval")}
                isLabelHidden
                size="md"
                width={150}
                value={String(autoSaveInterval)}
                onChange={(value) => setAutoSaveInterval(Number(value))}
                options={[
                  { label: t("settings.minute", { count: 1 }), value: "1" },
                  { label: t("settings.minute", { count: 2 }), value: "2" },
                  { label: t("settings.minute", { count: 5 }), value: "5" },
                  { label: t("settings.minute", { count: 10 }), value: "10" },
                  { label: t("settings.minute", { count: 15 }), value: "15" },
                  { label: t("settings.minute", { count: 30 }), value: "30" },
                ]}
              />
            </div>
            <Text type="supporting" color="secondary" className="text-xs">
              {t("settings.autoSaveTimingDescription")}
            </Text>
            {autoSaveStatus !== "idle" && (
              <Text
                type="supporting"
                color={autoSaveStatus === "error" ? "danger" : "secondary"}
                className="text-xs"
                role="status"
              >
                {t(`settings.autoSave${
                  autoSaveStatus === "saving"
                    ? "Saving"
                    : autoSaveStatus === "saved"
                      ? "Saved"
                      : autoSaveStatus === "pending"
                        ? "Pending"
                        : "Failed"
                }`)}
              </Text>
            )}
          </div>
        )}
      </div>

    </div>
  );
};
