import React, { useState, useEffect, useCallback } from "react";
import { ToolcraftButton as Button } from "@openreel/ui";
import { ToolcraftCard as Card } from "@openreel/ui";
import { ToolcraftCheckboxInput as CheckboxInput } from "@openreel/ui";
import { ToolcraftIconButton as IconButton } from "@openreel/ui";
import { ToolcraftNumberInputControl } from "@openreel/ui";
import { ToolcraftText as Text } from "@openreel/ui";
import { PropertySlider } from "./shell/PropertySlider";
import {
  Target,
  X,
  Check,
  AlertTriangle,
  Move,
  Maximize2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from "@/icons/lucide-compat";
import {
  getMotionTrackingBridge,
  type MotionTrackingState,
} from "../../../bridges/motion-tracking-bridge";
import { trackingPathToKeyframes, type Keyframe } from "@openreel/core";
import { createAction } from "../../../stores/project/action-helpers";
import { useProjectStore } from "../../../stores/project-store";
import type { Rectangle } from "@openreel/core";
import { useTranslation } from "react-i18next";

interface MotionTrackingSectionProps {
  clipId: string;
}

type TrackingAlgorithm = "correlation" | "optical-flow" | "feature";

const ALGORITHMS: {
  id: TrackingAlgorithm;
  name: string;
  description: string;
}[] = [
  {
    id: "correlation",
    name: "Correlation",
    description: "Best for high-contrast objects",
  },
  {
    id: "optical-flow",
    name: "Optical Flow",
    description: "Good for smooth motion",
  },
  {
    id: "feature",
    name: "Feature Match",
    description: "Works with complex textures",
  },
];

const RegionInput: React.FC<{
  label: string;
  value: number;
  onChange: (value: number) => void;
}> = ({ label, value, onChange }) => (
  <ToolcraftNumberInputControl
    label={label}
    size="sm"
    width="100%"
    value={value}
    onChange={onChange}
    step={1}
  />
);

export const MotionTrackingSection: React.FC<MotionTrackingSectionProps> = ({
  clipId,
}) => {
  const { t } = useTranslation();
  const project = useProjectStore((state) => state.project);
  const executeActionBatch = useProjectStore(
    (state) => state.executeActionBatch,
  );
  const [state, setState] = useState<MotionTrackingState>({
    isTracking: false,
    progress: 0,
    currentJob: null,
    trackingData: null,
    lostFrames: [],
    error: null,
  });

  const entry = project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === clipId);
  const fps =
    project.settings.frameRate > 0 ? project.settings.frameRate : 30;
  // Track the clip's actual source range instead of a hardcoded 30fps/150
  // frame window: fps from project settings, source frames from clip
  // duration × speed.
  const trackRange = entry
    ? {
        frameRate: fps,
        startFrame: 0,
        endFrame: Math.max(
          1,
          Math.ceil(entry.duration * (entry.speed ?? 1) * fps),
        ),
      }
    : { frameRate: fps, startFrame: 0, endFrame: fps };
  const mediaItem = entry
    ? project.mediaLibrary.items.find((item) => item.id === entry.mediaId)
    : undefined;

  const [region, setRegion] = useState<Rectangle>({
    x: 100,
    y: 100,
    width: 200,
    height: 200,
  });

  const [algorithm, setAlgorithm] = useState<TrackingAlgorithm>("correlation");
  const [confidenceThreshold, setConfidenceThreshold] = useState(70);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [applyScale, setApplyScale] = useState(true);
  const [smoothing, setSmoothing] = useState(0);
  const [isApplied, setIsApplied] = useState(false);
  // Keyframes the clip had before the tracking result was applied, so
  // "Remove Tracking" can restore them with the same undoable mechanism.
  const priorKeyframesRef = React.useRef<Keyframe[] | null>(null);

  const bridge = getMotionTrackingBridge();

  useEffect(() => {
    const unsubscribe = bridge.subscribe(setState);
    const existingData = bridge.getTrackingDataForClip(clipId);
    if (existingData.length > 0) {
      setState((prev) => ({
        ...prev,
        trackingData: existingData[existingData.length - 1],
      }));
    }
    return unsubscribe;
  }, [bridge, clipId]);

  const handleStartTracking = useCallback(async () => {
    try {
      await bridge.startTracking(clipId, region, {
        ...trackRange,
        algorithm,
        confidenceThreshold: confidenceThreshold / 100,
      });
    } catch (error) {
      console.error("Failed to start tracking:", error);
    }
  }, [bridge, clipId, region, trackRange, algorithm, confidenceThreshold]);

  const handleCancelTracking = useCallback(() => {
    if (state.currentJob) {
      bridge.cancelTracking(state.currentJob.id);
    }
  }, [bridge, state.currentJob]);

  /**
   * Landing: the tracked path becomes transform keyframes on the clip
   * (position.x/y + scale.x/y) through ONE undoable keyframe/setAll batch —
   * the same persistent channel the renderer's getAnimatedTransform and the
   * exporter evaluate. The engine's in-memory attachment is only kept as a
   * session cache for the live-preview channel.
   */
  const applyTrackingKeyframes = useCallback(
    (applyOffset: { x: number; y: number }, isFirstApply: boolean) => {
      if (!entry) return false;
      const trackingDataList = bridge.getTrackingDataForClip(clipId);
      const latest = trackingDataList[trackingDataList.length - 1];
      if (!latest || latest.keyframes.length === 0) return false;
      const keyframes = trackingPathToKeyframes(latest, {
        outputWidth: project.settings.width,
        outputHeight: project.settings.height,
        source: {
          width: mediaItem?.metadata?.width ?? project.settings.width,
          height: mediaItem?.metadata?.height ?? project.settings.height,
        },
        clip: { duration: entry.duration, speed: entry.speed },
        applyScale,
        offset: applyOffset,
      });
      if (keyframes.length === 0) return false;

      const batch = executeActionBatch(
        [createAction("keyframe/setAll", { clipId, keyframes })],
        {
          groupLabel: "Motion Tracking",
          historyOwner: "human",
        },
      );
      if (!batch.result.success) return false;
      if (isFirstApply) {
        priorKeyframesRef.current = entry.keyframes;
      }
      // Session cache for the (GUI-only) live-preview attachment channel.
      bridge.applyTrackingToClip(clipId, applyOffset);
      bridge.setApplyScale(clipId, applyScale);
      return true;
    },
    [
      bridge,
      clipId,
      entry,
      project.settings,
      mediaItem,
      applyScale,
      executeActionBatch,
    ],
  );

  const handleApplyTracking = useCallback(() => {
    if (applyTrackingKeyframes({ x: offsetX, y: offsetY }, true)) {
      setIsApplied(true);
    }
  }, [applyTrackingKeyframes, offsetX, offsetY]);

  const handleRemoveTracking = useCallback(() => {
    const prior = priorKeyframesRef.current;
    if (prior && entry) {
      executeActionBatch(
        [createAction("keyframe/setAll", { clipId, keyframes: prior })],
        {
          groupLabel: "Remove Motion Tracking",
          historyOwner: "human",
        },
      );
      priorKeyframesRef.current = null;
    }
    bridge.removeAttachment(clipId);
    setIsApplied(false);
  }, [bridge, clipId, entry, executeActionBatch]);

  const handleOffsetChange = useCallback(
    (axis: "x" | "y", value: number) => {
      const nextOffset = {
        x: axis === "x" ? value : offsetX,
        y: axis === "y" ? value : offsetY,
      };
      if (axis === "x") {
        setOffsetX(value);
      } else {
        setOffsetY(value);
      }
      if (isApplied) {
        // Re-land with the new offset so the persistent keyframes — not just
        // the session attachment — follow the slider.
        applyTrackingKeyframes(nextOffset, false);
      }
    },
    [applyTrackingKeyframes, isApplied, offsetX, offsetY],
  );

  const hasTrackingData =
    state.trackingData !== null || bridge.hasTrackingData(clipId);

  return (
    <div className="space-y-3">
          <div className="flex items-center gap-2 p-2 bg-primary/10 rounded-lg border border-primary/30">
            <Target size={16} className="text-primary" />
            <div className="flex flex-1 flex-col gap-0.5">
              <Text type="supporting" color="primary" weight="medium">
                {t("Motion Tracking")}</Text>
              <Text type="supporting" color="secondary" className="text-[9px]">
                {t("Track a region, apply its motion as transform keyframes")}</Text>
            </div>
          </div>

      {!state.isTracking && !hasTrackingData && (
        <>
          <div className="space-y-2">
            <Text type="supporting" color="secondary" weight="medium">
              {t("Tracking Region")}</Text>
            <div className="grid grid-cols-2 gap-2">
              <RegionInput
                label={t("X Position")}
                value={region.x}
                onChange={(x) => setRegion({ ...region, x })}
              />
              <RegionInput
                label={t("Y Position")}
                value={region.y}
                onChange={(y) => setRegion({ ...region, y })}
              />
              <RegionInput
                label={t("Width")}
                value={region.width}
                onChange={(width) => setRegion({ ...region, width })}
              />
              <RegionInput
                label={t("Height")}
                value={region.height}
                onChange={(height) => setRegion({ ...region, height })}
              />
            </div>
            <Text type="supporting" color="secondary" className="text-center text-[9px]">
              {t("Draw region in preview or enter coordinates")}</Text>
          </div>

          <Button
            label={t("Advanced Options")}
            size="sm"
            variant="ghost"
            icon={showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="w-full flex items-center gap-2 py-1.5 text-[10px] text-fg-2 hover:text-fg transition-colors"
          />

          {showAdvanced && (
            <Card variant="muted" padding={3} className="space-y-3">
              <div className="space-y-1.5">
                <Text type="supporting" color="secondary" weight="medium">
                  {t("Algorithm")}</Text>
                <div className="space-y-1">
                  {ALGORITHMS.map((algo) => (
                    <Button
                      key={algo.id}
                      label={`${algo.name}: ${algo.description}`}
                      size="sm"
                      variant={algorithm === algo.id ? "primary" : "secondary"}
                      onClick={() => setAlgorithm(algo.id)}
                      className="w-full justify-start"
                    />
                  ))}
                </div>
              </div>

              <PropertySlider
                label={t("Confidence Threshold")}
                min={30}
                max={95}
                step={5}
                value={confidenceThreshold}
                onChange={setConfidenceThreshold}
                formatValue={(value) => `${value}%`}
                description={t("Higher = more accurate but may lose track easier")}
              />

              <PropertySlider
                label={t("Path Smoothing")}
                min={0}
                max={10}
                step={1}
                value={smoothing}
                onChange={setSmoothing}
                formatValue={(value) => String(value)}
                description={t("Reduces jitter in tracking path")}
              />
            </Card>
          )}

          <Button
            label={t("Start Tracking")}
            size="md"
            variant="primary"
            icon={<Target size={14} />}
            onClick={handleStartTracking}
            className="w-full py-2.5 bg-primary hover:bg-primary-hover rounded-lg text-[11px] font-medium text-white flex items-center justify-center gap-2 transition-colors"
          />
        </>
      )}

      {state.isTracking && (
        <div className="space-y-3 p-3 bg-bg-2 rounded-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
              <Text type="supporting" color="primary" weight="medium">
                {t("Tracking in Progress")}</Text>
            </div>
            <IconButton
              label={t("Cancel Tracking")}
              icon={<X size={14} />}
              size="sm"
              variant="ghost"
              onClick={handleCancelTracking}
            />
          </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px]">
                <Text type="supporting" color="secondary">{t("Matching the region frame by frame (correlation)...")}</Text>
              <Text type="supporting" color="primary" className="font-mono">
                {Math.round(state.progress)}%
              </Text>
            </div>
            <div className="w-full h-2 bg-bg-1 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-200"
                style={{ width: `${state.progress}%` }}
              />
            </div>
          </div>

          {state.lostFrames.length > 0 && (
            <div className="flex items-center gap-2 p-2 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-400">
              <AlertTriangle size={12} />
              {t("Lost tracking on ")}{state.lostFrames.length} {t(" frame(s)")}</div>
          )}
        </div>
      )}

      {state.error && (
        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-[10px] text-red-400">
          <div className="flex items-center gap-2 font-medium mb-1">
            <AlertTriangle size={12} />
            {t("Tracking Failed")}</div>
          <Text type="supporting" className="text-[9px] text-red-300/80">
            {state.error}
          </Text>
        </div>
      )}

      {hasTrackingData && !state.isTracking && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 p-2 bg-green-500/10 border border-green-500/30 rounded-lg">
            <Check size={14} className="text-green-400" />
            <div className="flex flex-1 flex-col gap-0.5">
              <Text type="supporting" weight="medium" className="text-[10px] text-green-400">
                {t("Tracking Complete")}</Text>
              {state.trackingData && (
                <Text type="supporting" className="text-[9px] text-green-300/70">
                  {state.trackingData.keyframes.length} {t(" keyframes captured ")}{state.trackingData.lostFrames.length > 0 &&
                    ` • ${state.trackingData.lostFrames.length} frames lost`}
                </Text>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Text
              type="supporting"
              color="secondary"
              weight="medium"
              className="flex items-center gap-2"
            >
              <Move size={12} />
              {t("Position Offset")}</Text>
            <div className="grid grid-cols-2 gap-2">
              <RegionInput
                label={t("X Offset")}
                value={offsetX}
                onChange={(value) => handleOffsetChange("x", value)}
              />
              <RegionInput
                label={t("Y Offset")}
                value={offsetY}
                onChange={(value) => handleOffsetChange("y", value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Text type="supporting" color="secondary" weight="medium">
              {t("Transform Options")}</Text>
            <div className="grid grid-cols-2 gap-2">
              <CheckboxInput
                label={t("Scale")}
                value={applyScale}
                labelIcon={<Maximize2 size={10} aria-hidden />}
                onChange={(value) => {
                  setApplyScale(value);
                  if (isApplied) {
                    bridge.setApplyScale(clipId, value);
                  }
                }}
              />
            </div>
          </div>

          {!isApplied ? (
            <div className="space-y-1.5">
              <Button
                label={t("Apply Tracking to Clip")}
                size="md"
                variant="secondary"
                onClick={handleApplyTracking}
                className="w-full py-2.5 bg-primary/20 border border-primary/30 rounded-lg text-[11px] font-medium text-primary hover:bg-primary/30 transition-colors"
              />
              <Text type="supporting" color="secondary" className="text-center text-[9px]">
                {t("Applied as transform keyframes on this clip — undoable and saved with the project.")}</Text>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 p-2 bg-primary/10 border border-primary/20 rounded-lg">
                <Check size={12} className="text-primary" />
                <Text type="supporting" color="primary" className="text-[10px]">
                  {t("Tracking Applied")}</Text>
              </div>
              <Button
                label={t("Remove Tracking")}
                size="sm"
                variant="destructive"
                onClick={handleRemoveTracking}
                className="w-full py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-[10px] text-red-400 hover:bg-red-500/20 transition-colors"
              />
            </div>
          )}

          <Button
            label={t("Re-track with Different Settings")}
            size="sm"
            variant="ghost"
            icon={<RefreshCw size={10} />}
            onClick={handleStartTracking}
            className="w-full flex items-center justify-center gap-2 py-1.5 text-[9px] text-fg-3 hover:text-fg-2 transition-colors"
          />
        </div>
      )}

      <div className="pt-2 border-t border-border">
        <Text type="supporting" color="secondary" className="text-center text-[9px]">
          {t("Correlation matching — no AI model; works fully offline")}</Text>
      </div>
    </div>
  );
};

export default MotionTrackingSection;
