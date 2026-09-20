import React, { useState, useCallback, useEffect, useMemo } from "react";
import { ToolcraftButton as Button } from "@reelterminal/ui";
import { ToolcraftCard as Card } from "@reelterminal/ui";
import { ToolcraftClickableCard as ClickableCard } from "@reelterminal/ui";
import { ToolcraftText as Text } from "@reelterminal/ui";
import { PropertySlider } from "./shell/PropertySlider";
import {
  User,
  ImageIcon,
  Palette,
  Droplets,
  Loader2,
  Info,
  AlertTriangle,
} from "@/icons/lucide-compat";
import {
  getBackgroundRemovalEngine,
  initializeBackgroundRemovalEngine,
  type BackgroundRemovalSettings,
  type BackgroundMode,
  DEFAULT_BACKGROUND_SETTINGS,
} from "@reelterminal/core";
import { toast } from "../../../stores/notification-store";
import { useProcessingStore } from "../../../services/processing-manager";
import { useProjectStore } from "../../../stores/project-store";
import type { Action } from "@reelterminal/core";
import { ColorSelector } from "../../../motion/components/primitives";
import { useTranslation } from "react-i18next";

interface BackgroundRemovalSectionProps {
  clipId: string;
  onSettingsChange?: (settings: BackgroundRemovalSettings) => void;
}

const BACKGROUND_MODES: {
  value: BackgroundMode;
  label: string;
  icon: React.ElementType;
}[] = [
  { value: "blur", label: "Blur", icon: Droplets },
  { value: "color", label: "Color", icon: Palette },
  { value: "image", label: "Image", icon: ImageIcon },
  { value: "transparent", label: "Transparent", icon: User },
];

const PRESET_COLORS = [
  "#00ff00",
  "#0000ff",
  "#ffffff",
  "#000000",
  "#ff0000",
  "#ffff00",
  "#00ffff",
  "#ff00ff",
];

export const BackgroundRemovalSection: React.FC<
  BackgroundRemovalSectionProps
> = ({ clipId, onSettingsChange }) => {
  const { t } = useTranslation();
  const [isInitializing, setIsInitializing] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [aiDegraded, setAiDegraded] = useState(false);
  const { addTask, updateTaskProgress, completeTask, failTask } =
    useProcessingStore();

  const project = useProjectStore((state) => state.project);

  // Reopened projects carry the persisted clip.backgroundRemoval field (the
  // engine Map is empty after a reload): seed the engine's session cache from
  // the field so the render pipeline and this panel start from the saved
  // tuning instead of defaults.
  useEffect(() => {
    const engine = getBackgroundRemovalEngine();
    if (!engine || !clipId) return;
    const clip = project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === clipId);
    if (clip?.backgroundRemoval) {
      engine.setSettings(clipId, clip.backgroundRemoval);
    }
    setIsInitialized(engine.isInitialized());
    setAiDegraded(engine.isAIDegraded());
  }, [clipId, project]);

  // The persisted clip field is the display source of truth; the engine Map
  // stays the fallback for in-session values that are not committed yet.
  const settings = useMemo<BackgroundRemovalSettings>(() => {
    const clip = project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === clipId);
    if (clip?.backgroundRemoval) {
      return { ...DEFAULT_BACKGROUND_SETTINGS, ...clip.backgroundRemoval };
    }
    return getBackgroundRemovalEngine()?.getSettings(clipId) ?? {
      ...DEFAULT_BACKGROUND_SETTINGS,
    };
  }, [clipId, project]);

  const handleInitialize = useCallback(
    async (onProgress?: (progress: number, message: string) => void) => {
      setIsInitializing(true);
      try {
        const engine = initializeBackgroundRemovalEngine();
        await engine.initialize(onProgress);
        setIsInitialized(true);
        setAiDegraded(engine.isAIDegraded());
      } catch (error) {
        console.error("Failed to initialize background removal:", error);
        throw error;
      } finally {
        setIsInitializing(false);
      }
    },
    [],
  );

  // Persist every change through the clip/setBackgroundRemoval action so the
  // matte is undoable AND survives save/reopen: the action writes the
  // clip.backgroundRemoval field the render pipeline reads first (the engine
  // Map is only a session cache, kept in step here for immediate rendering).
  const updateSettings = useCallback(
    (updates: Partial<BackgroundRemovalSettings>) => {
      const engine = getBackgroundRemovalEngine();
      if (engine) {
        engine.setSettings(clipId, updates);
      }

      const current = (() => {
        const clip = useProjectStore
          .getState()
          .project.timeline.tracks.flatMap((track) => track.clips)
          .find((candidate) => candidate.id === clipId);
        if (clip?.backgroundRemoval) {
          return { ...DEFAULT_BACKGROUND_SETTINGS, ...clip.backgroundRemoval };
        }
        return engine?.getSettings(clipId) ?? {
          ...DEFAULT_BACKGROUND_SETTINGS,
        };
      })();
      const newSettings = { ...current, ...updates };

      const action: Action = {
        type: "clip/setBackgroundRemoval",
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        params: { clipId, backgroundRemoval: newSettings },
      };
      useProjectStore.getState().executeActionBatch([action], {
        groupLabel: "Background removal",
        historyOwner: "human",
      });

      onSettingsChange?.(newSettings);
      window.dispatchEvent(new CustomEvent("openreel:preview-invalidate"));
    },
    [clipId, onSettingsChange],
  );

  const processBackgroundRemoval = useCallback(async () => {
    const taskId = addTask(clipId, "background-removal");
    setIsProcessing(true);

    try {
      if (!isInitialized) {
        // Progress comes from the engine's real initialization stages
        // (canvas setup, segmentation model download/load). First use may
        // download the model from the network, so it can take a while.
        await handleInitialize((progress, message) => {
          updateTaskProgress(taskId, progress, message);
        });
      }

      updateSettings({ enabled: true });
      completeTask(taskId);
      const degraded = getBackgroundRemovalEngine()?.isAIDegraded() ?? false;
      if (degraded) {
        // Honest disclosure: the segmentation model failed to load, so the
        // engine falls back to the non-AI luminance mask (behavior is
        // unchanged — only the disclosure is new).
        toast.info(
          t("Background Removal Ready"),
          t("Segmentation model unavailable — using a non-AI fallback mask"),
        );
      } else {
        toast.success(
          t("Background Removal Ready"),
          t("Effect will be applied during playback"),
        );
      }
    } catch (error) {
      failTask(
        taskId,
        error instanceof Error ? error.message : "Unknown error",
      );
      toast.error(t("Processing Failed"), t("Could not enable background removal"));
    } finally {
      setIsProcessing(false);
    }
  }, [
    clipId,
    isInitialized,
    handleInitialize,
    updateSettings,
    addTask,
    updateTaskProgress,
    completeTask,
    failTask,
    t,
  ]);

  const handleToggleEnabled = useCallback(() => {
    if (settings.enabled) {
      updateSettings({ enabled: false });
      toast.info(t("Background Removal Disabled"));
    } else {
      processBackgroundRemoval();
    }
  }, [settings.enabled, updateSettings, processBackgroundRemoval, t]);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          label={settings.enabled ? "On" : t("Off")}
          icon={
            isInitializing || isProcessing ? (
              <Loader2 size={12} className="animate-spin" />
            ) : undefined
          }
          variant={settings.enabled ? "primary" : "secondary"}
          size="sm"
          onClick={handleToggleEnabled}
          isDisabled={isInitializing || isProcessing}
        />
      </div>

      {settings.enabled && (
        <Card variant="muted" padding={3} className="space-y-3">
          {aiDegraded && (
            <div className="flex items-start gap-2 p-2 bg-warning/10 rounded border border-warning/30">
              <AlertTriangle size={14} className="text-warning flex-shrink-0 mt-0.5" />
              <Text type="supporting" color="secondary" className="text-[9px]">
                {t("Non-AI fallback mask: the segmentation model could not be loaded, so a non-AI luminance mask is used (not AI matting).")}</Text>
            </div>
          )}
          <div>
            <Text type="supporting" color="secondary" className="mb-2 block text-[10px]">
              {t("Background Mode")}</Text>
            <div className="grid grid-cols-4 gap-1">
              {BACKGROUND_MODES.map((mode) => {
                const ModeIcon = mode.icon;
                return (
                  <ClickableCard
                    key={mode.value}
                    label={`${mode.label} background mode`}
                    onClick={() => updateSettings({ mode: mode.value })}
                    className={`flex flex-col items-center gap-1 rounded p-2 transition-colors ${
                      settings.mode === mode.value
                        ? "bg-primary/20 border border-primary"
                        : "bg-bg-1 hover:bg-background-primary border border-transparent"
                    }`}
                  >
                    <ModeIcon size={14} />
                    <Text type="supporting" color="primary" className="text-[9px]">
                      {t(mode.label)}
                    </Text>
                  </ClickableCard>
                );
              })}
            </div>
          </div>

          {settings.mode === "blur" && (
            <PropertySlider
              label={t("Blur Amount")}
              min={0}
              max={50}
              step={1}
              value={settings.blurAmount}
              onChange={(value: number) => updateSettings({ blurAmount: value })}
              formatValue={(value) => `${Math.round(value)}px`}
            />
          )}

          {settings.mode === "color" && (
            <div>
              <Text type="supporting" color="secondary" className="mb-2 block text-[10px]">
                {t("Background Color")}</Text>
              <div className="grid grid-cols-8 gap-1 mb-2">
                {PRESET_COLORS.map((color) => (
                  <ClickableCard
                    key={color}
                    label={`Use ${color} background color`}
                    onClick={() => updateSettings({ backgroundColor: color })}
                    className={`w-6 h-6 rounded border-2 transition-all ${
                      settings.backgroundColor === color
                        ? "border-primary scale-110"
                        : "border-transparent hover:scale-105"
                    }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
              <ColorSelector
                value={settings.backgroundColor}
                onChange={(value) => updateSettings({ backgroundColor: value })}
                label={t("Select replacement background color")}
              />
            </div>
          )}

          {settings.mode === "image" && (
            <div>
              <Text type="supporting" color="secondary" className="mb-2 block text-[10px]">
                {t("Background Image")}</Text>
              <Button
                label={t("Choose Image")}
                icon={<ImageIcon size={14} />}
                variant="secondary"
                size="sm"
                onClick={() => {
                  const input = document.createElement("input");
                  input.type = "file";
                  input.accept = "image/*";
                  input.onchange = async (e) => {
                    const file = (e.target as HTMLInputElement).files?.[0];
                    if (file) {
                      const url = URL.createObjectURL(file);
                      updateSettings({ backgroundImageUrl: url });
                      const engine = getBackgroundRemovalEngine();
                      if (engine) {
                        await engine.setBackgroundImage(url);
                      }
                    }
                  };
                  input.click();
                }}
                className="w-full justify-center"
              />
              {settings.backgroundImageUrl && (
                <Text type="supporting" color="secondary" className="mt-2 truncate text-[9px]">
                  {t("Image loaded")}</Text>
              )}
            </div>
          )}

          <PropertySlider
            label={t("Edge Smoothing")}
            min={0}
            max={10}
            step={1}
            value={settings.edgeBlur}
            onChange={(value: number) => updateSettings({ edgeBlur: value })}
            formatValue={(value) => `${Math.round(value)}`}
          />

          <PropertySlider
            label={t("Detection Threshold")}
            min={0}
            max={100}
            step={1}
            value={settings.threshold * 100}
            onChange={(value: number) => updateSettings({ threshold: value / 100 })}
            formatValue={(value) => `${Math.round(value)}%`}
          />

          <div className="flex items-start gap-2 p-2 bg-primary/10 rounded border border-primary/20">
            <Info size={14} className="text-primary flex-shrink-0 mt-0.5" />
            <Text type="supporting" color="secondary" className="text-[9px]">
              {t("Background removal is processed in real-time. For best results, export your video after previewing.")}</Text>
          </div>
        </Card>
      )}
    </div>
  );
};

export default BackgroundRemovalSection;
