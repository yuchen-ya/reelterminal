import React, { useState, useCallback, useEffect } from "react";
import { ToolcraftButton as Button } from "@reelterminal/ui";
import { ToolcraftCard as Card } from "@reelterminal/ui";
import { ToolcraftClickableCard as ClickableCard } from "@reelterminal/ui";
import { ToolcraftText as Text } from "@reelterminal/ui";
import { PropertySlider } from "./shell/PropertySlider";
import { MockToggle } from "./shell/InspectorControls";
import {
  Smartphone,
  Monitor,
  Square,
  Loader2,
  Play,
  CheckCircle,
} from "@/icons/lucide-compat";
import {
  getAutoReframeEngine,
  initializeAutoReframeEngine,
  reframeKeyframesToTransformKeyframes,
  type ReframeSettings,
  type AspectRatioPreset,
  type PlatformPreset,
  type ReframeResult,
  ASPECT_RATIO_PRESETS,
  PLATFORM_PRESETS,
  DEFAULT_REFRAME_SETTINGS,
} from "@reelterminal/core";
import { extractFramesForAnalysis, closeFrames } from "../../../services/frame-extraction";
import { toast } from "../../../stores/notification-store";
import { useProjectStore } from "../../../stores/project-store";
import { useTranslation } from "react-i18next";

interface AutoReframeSectionProps {
  clipId: string;
  onReframeComplete?: (result: ReframeResult) => void;
}

const PLATFORM_ICONS: Record<PlatformPreset, React.ElementType> = {
  youtube: Monitor,
  tiktok: Smartphone,
  "instagram-reels": Smartphone,
  "instagram-feed": Square,
  "instagram-stories": Smartphone,
  "youtube-shorts": Smartphone,
  facebook: Monitor,
  twitter: Monitor,
  linkedin: Monitor,
};

export const AutoReframeSection: React.FC<AutoReframeSectionProps> = ({
  clipId,
  onReframeComplete,
}) => {
  const { t } = useTranslation();
  const executeActionBatch = useProjectStore(
    (state) => state.executeActionBatch,
  );
  const [reframeSettings, setReframeSettings] = useState<ReframeSettings>(
    DEFAULT_REFRAME_SETTINGS,
  );
  const [isInitializing, setIsInitializing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isApplied, setIsApplied] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const [selectedPlatform, setSelectedPlatform] =
    useState<PlatformPreset | null>("tiktok");

  useEffect(() => {
    const engine = getAutoReframeEngine();
    if (engine) {
      setIsInitialized(engine.isInitialized());
    }
  }, [clipId]);

  const handleInitialize = useCallback(async () => {
    setIsInitializing(true);
    try {
      const engine = initializeAutoReframeEngine();
      await engine.initialize((prog, msg) => {
        setProgress(prog);
        setProgressMessage(msg);
      });
      setIsInitialized(true);
    } catch (error) {
      console.error("Failed to initialize auto-reframe:", error);
    } finally {
      setIsInitializing(false);
    }
  }, []);

  const updateLocalSettings = useCallback(
    (updates: Partial<ReframeSettings>) => {
      setReframeSettings((prev) => ({ ...prev, ...updates }));
    },
    [],
  );

  const handleSelectPlatform = useCallback(
    (platform: PlatformPreset) => {
      setSelectedPlatform(platform);
      const config = PLATFORM_PRESETS[platform];
      const aspectRatio = Object.entries(ASPECT_RATIO_PRESETS).find(
        ([, v]) => Math.abs(v.ratio - config.ratio) < 0.01,
      );
      if (aspectRatio) {
        updateLocalSettings({
          targetAspectRatio: aspectRatio[0] as AspectRatioPreset,
        });
      }
    },
    [updateLocalSettings],
  );

  const handleSelectAspectRatio = useCallback(
    (ratio: AspectRatioPreset) => {
      setSelectedPlatform(null);
      updateLocalSettings({ targetAspectRatio: ratio });
    },
    [updateLocalSettings],
  );

  const handleAnalyze = useCallback(async () => {
    setIsProcessing(true);
    setProgress(0);
    setProgressMessage(t("Preparing local analysis..."));

    let frames: ImageBitmap[] = [];
    try {
      if (!isInitialized) {
        await handleInitialize();
      }

      const engine = getAutoReframeEngine();
      if (!engine) {
        throw new Error("Engine not available");
      }

      const { project } = useProjectStore.getState();
      const clip = project.timeline.tracks
        .flatMap((track) => track.clips)
        .find((candidate) => candidate.id === clipId);
      if (!clip) {
        throw new Error(t("Clip not found"));
      }
      const mediaItem = project.mediaLibrary.items.find(
        (candidate) => candidate.id === clip.mediaId,
      );
      if (!mediaItem?.blob) {
        throw new Error(t("Media file not loaded"));
      }

      // Real frame supply: evenly spaced samples over the clip's source
      // span, hard-capped so long clips cannot exhaust memory.
      setProgressMessage(t("Extracting frames..."));
      const extraction = await extractFramesForAnalysis(mediaItem.blob, {
        inPoint: clip.inPoint,
        outPoint: clip.outPoint,
        sampleFps: project.settings.frameRate,
      });
      frames = extraction.frames;
      if (frames.length === 0) {
        throw new Error(t("No frames could be extracted from this clip"));
      }
      const source = {
        width: frames[0]!.width,
        height: frames[0]!.height,
      };

      // Real analysis: progress comes from the engine's per-frame callback.
      const result = await engine.analyzeClip(
        frames,
        extraction.frameRate,
        reframeSettings,
        (prog, msg) => {
          setProgress(prog);
          setProgressMessage(msg);
        },
      );
      closeFrames(frames);
      frames = [];

      if (!result.success || result.keyframes.length === 0) {
        throw new Error(
          result.message || t("Reframe analysis produced no subject track"),
        );
      }

      setProgressMessage(t("Applying reframe keyframes..."));
      const keyframes = reframeKeyframesToTransformKeyframes(
        result,
        source,
        { duration: clip.duration, speed: clip.speed },
      );
      if (keyframes.length === 0) {
        throw new Error(t("Reframe analysis produced no subject track"));
      }

      // Resize + keyframes land as ONE atomic, undoable batch: the resize
      // action is only included when the output size actually differs.
      const makeAction = (
        type: string,
        params: Record<string, unknown>,
      ): { type: string; id: string; timestamp: number; params: Record<string, unknown> } => ({
        type,
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        params,
      });
      const actions: ReturnType<typeof makeAction>[] = [];
      if (
        project.settings.width !== result.outputWidth ||
        project.settings.height !== result.outputHeight
      ) {
        actions.push(
          makeAction("project/updateSettings", {
            width: result.outputWidth,
            height: result.outputHeight,
          }),
        );
      }
      actions.push(
        makeAction("keyframe/setAll", { clipId, keyframes }),
      );

      const batch = executeActionBatch(actions, {
        groupLabel: "Auto Reframe",
        historyOwner: "human",
      });
      if (!batch.result.success) {
        throw new Error(
          batch.result.error?.message ?? "Failed to apply the reframe",
        );
      }

      setProgress(100);
      setProgressMessage(t("Complete!"));
      setIsApplied(true);

      onReframeComplete?.(result);

      toast.success(
        t("Auto Reframe Applied"),
        t("{{count}} transform keyframes applied at {{size}}", {
          count: keyframes.length,
          size: `${result.outputWidth}x${result.outputHeight}`,
        }),
      );
    } catch (error) {
      console.error("Auto-reframe failed:", error);
      toast.error(
        t("Auto Reframe Failed"),
        error instanceof Error ? error.message : "Unknown error",
      );
      setIsApplied(false);
    } finally {
      closeFrames(frames);
      setIsProcessing(false);
    }
  }, [
    clipId,
    isInitialized,
    handleInitialize,
    reframeSettings,
    onReframeComplete,
    executeActionBatch,
    t,
  ]);

  return (
    <div className="space-y-3">
      <div className="space-y-3">
        <div>
          <Text type="supporting" color="secondary" className="mb-2 block text-[10px]">
            {t("Platform Presets")}</Text>
            <div className="grid grid-cols-3 gap-1">
              {(Object.keys(PLATFORM_PRESETS) as PlatformPreset[]).map(
                (platform) => {
                  const PlatformIcon = PLATFORM_ICONS[platform];
                  return (
                    <ClickableCard
                      key={platform}
                      label={`${PLATFORM_PRESETS[platform].name} platform preset`}
                      onClick={() => handleSelectPlatform(platform)}
                      className={`flex items-center gap-1 p-2 rounded text-[9px] transition-colors ${
                        selectedPlatform === platform
                          ? "bg-primary/20 border border-primary text-fg"
                          : "bg-bg-1 hover:bg-background-primary border border-transparent text-fg-2"
                      }`}
                    >
                      <PlatformIcon size={14} />
                      <Text type="supporting" className="truncate text-[9px]">
                        {PLATFORM_PRESETS[platform].name}
                      </Text>
                    </ClickableCard>
                  );
                },
            )}
          </div>
        </div>

        <div>
          <Text type="supporting" color="secondary" className="mb-2 block text-[10px]">
            {t("Aspect Ratio")}</Text>
          <div className="grid grid-cols-3 gap-1">
            {(Object.keys(ASPECT_RATIO_PRESETS) as AspectRatioPreset[])
              .filter((r) => r !== "custom")
              .map((ratio) => (
                <ClickableCard
                  key={ratio}
                  label={`${ratio} aspect ratio`}
                  onClick={() => handleSelectAspectRatio(ratio)}
                  className={`p-2 rounded text-[9px] transition-colors ${
                    reframeSettings.targetAspectRatio === ratio &&
                    !selectedPlatform
                      ? "bg-primary/20 border border-primary text-fg"
                      : "bg-bg-1 hover:bg-background-primary border border-transparent text-fg-2"
                  }`}
                >
                  {ratio}
                </ClickableCard>
              ))}
          </div>
        </div>

        <PropertySlider
          label={t("Tracking Speed")}
          min={0}
          max={100}
          step={1}
          value={reframeSettings.trackingSpeed * 100}
          onChange={(value: number) =>
            updateLocalSettings({
              trackingSpeed: value / 100,
            })
          }
          formatValue={(value) => `${Math.round(value)}%`}
        />

        <PropertySlider
          label={t("Smoothing")}
          min={0}
          max={100}
          step={1}
          value={reframeSettings.smoothing * 100}
          onChange={(value: number) => updateLocalSettings({ smoothing: value / 100 })}
          formatValue={(value) => `${Math.round(value)}%`}
        />

        <PropertySlider
          label={t("Center Bias")}
          min={0}
          max={100}
          step={1}
          value={reframeSettings.centerBias * 100}
          onChange={(value: number) =>
            updateLocalSettings({
              centerBias: value / 100,
            })
          }
          formatValue={(value) => `${Math.round(value)}%`}
        />

        <div className="flex items-center justify-between">
          <Text type="supporting" color="secondary" className="text-[10px]">
            {t("Follow Subject")}</Text>
          <MockToggle
            ariaLabel={t("Follow Subject")}
            checked={reframeSettings.followSubject}
            onChange={() =>
              updateLocalSettings({
                followSubject: !reframeSettings.followSubject,
              })
            }
          />
        </div>

        {isProcessing && (
          <Card variant="muted" padding={2} className="space-y-1">
            <div className="flex items-center justify-between">
              <Text type="supporting" color="secondary" className="text-[9px]">
                {progressMessage}
              </Text>
              <Text type="supporting" color="secondary" className="text-[9px]">
                {progress}%
              </Text>
            </div>
            <div className="h-1 bg-bg-1 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </Card>
        )}

        <Button
          label={
            isInitializing || isProcessing
              ? isInitializing
                ? t("Initializing...")
                : t("Analyzing...")
              : isApplied
                ? t("Applied - Click to Reanalyze")
                : t("Analyze & Reframe")
          }
          icon={
            isInitializing || isProcessing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : isApplied ? (
              <CheckCircle size={14} />
            ) : (
              <Play size={14} />
            )
          }
          variant="primary"
          size="sm"
          onClick={handleAnalyze}
          isDisabled={isInitializing || isProcessing}
          className="w-full justify-center"
        />

        <Text type="supporting" color="secondary" className="text-center text-[9px]">
          {t("Output:")}{" "}
          {ASPECT_RATIO_PRESETS[reframeSettings.targetAspectRatio].width} x{" "}
          {ASPECT_RATIO_PRESETS[reframeSettings.targetAspectRatio].height}
        </Text>

        <Text type="supporting" color="secondary" className="block text-center text-[9px]">
          {t("Tracks subjects with a local color-region heuristic — not an AI model.")}
        </Text>
      </div>
    </div>
  );
};

export default AutoReframeSection;
