import React, { useState, useEffect } from "react";
import { ToolcraftButton as Button } from "@reelterminal/ui";
import { ToolcraftCard as Card } from "@reelterminal/ui";
import { ToolcraftClickableCard as ClickableCard } from "@reelterminal/ui";
import { ToolcraftSelectControl as Selector } from "@reelterminal/ui";
import { ToolcraftText as Text } from "@reelterminal/ui";
import { ToolcraftTextInputControl } from "@reelterminal/ui";
import { RotateCcw, Sparkles } from "@/icons/lucide-compat";
import type { Clip } from "@reelterminal/core";
import { useProjectStore } from "../../../stores/project-store";
import { MockToggle } from "./shell/InspectorControls";
import { useTranslation } from "react-i18next";

interface SpeedSectionProps {
  clip: Clip;
}

const SPEED_PRESETS = [
  { label: "0.25×", value: 0.25 },
  { label: "0.5×", value: 0.5 },
  { label: "0.75×", value: 0.75 },
  { label: "1×", value: 1 },
  { label: "1.25×", value: 1.25 },
  { label: "1.5×", value: 1.5 },
  { label: "2×", value: 2 },
  { label: "3×", value: 3 },
  { label: "5×", value: 5 },
];

export const SpeedSection: React.FC<SpeedSectionProps> = ({ clip }) => {
  const { t } = useTranslation();
  const { project } = useProjectStore();
  const canonicalClip = project.timeline.tracks.flatMap((track) => track.clips).find((item) => item.id === clip.id) ?? clip;
  const currentSpeed = canonicalClip.speed ?? 1;
  const isReversed = canonicalClip.reversed ?? false;
  const [error, setError] = useState<string | null>(null);

  const [customSpeed, setCustomSpeed] = useState<string>(
    currentSpeed.toString(),
  );
  const [affectAudio, setAffectAudio] = useState(true);

  useEffect(() => {
    setCustomSpeed(currentSpeed.toString());
  }, [currentSpeed]);

  const hasAudio = () => {
    const audioTrack = project.timeline.tracks.find(
      (track) =>
        track.type === "audio" &&
        track.clips.some((audioClip) => audioClip.mediaId === clip.mediaId),
    );
    return !!audioTrack;
  };

  const linkedAudioClip = () => {
    if (!affectAudio) return undefined;
    for (const track of project.timeline.tracks) {
      if (track.type !== "audio") continue;
      const audioClip = track.clips.find((c) => c.mediaId === clip.mediaId);
      if (audioClip) return audioClip;
    }
    return undefined;
  };

  const commit = (type: string, params: Record<string, unknown>) => {
    const audioClip = linkedAudioClip();
    const ids = [clip.id, ...(audioClip ? [audioClip.id] : [])];
    const { result } = useProjectStore.getState().executeActionBatch(ids.map((clipId) => ({
      type, id: crypto.randomUUID(), timestamp: Date.now(), params: { clipId, ...params },
    })), { groupLabel: "Edit clip speed", historyOwner: "human" });
    setError(result.success ? null : result.error?.message ?? "Speed edit failed");
  };
  const handleSpeedPreset = (speed: number) => commit("clip/setSpeed", { speed });
  const handleCustomSpeed = () => {
    const speed = Number(customSpeed);
    if (Number.isFinite(speed) && speed >= 0.1 && speed <= 20) handleSpeedPreset(speed);
  };
  const handleToggleReverse = () => commit("clip/setReverse", { reversed: !isReversed });

  return (
    <div className="space-y-3">
      {error && <Text type="supporting" color="secondary" role="alert">{error}</Text>}
      <div className="grid grid-cols-3 gap-2">
        {SPEED_PRESETS.map((preset) => (
          <ClickableCard
            key={preset.value}
            label={`Set speed to ${preset.label}`}
            onClick={() => handleSpeedPreset(preset.value)}
            className={`px-3 py-2 text-xs font-medium rounded-lg transition-all ${
              currentSpeed === preset.value
                ? "bg-primary text-white shadow-lg shadow-primary/20"
                : "bg-bg-2 hover:bg-bg-elev text-fg-2 hover:text-fg border border-border"
            }`}
          >
            {t(preset.label)}
          </ClickableCard>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex gap-2">
          <ToolcraftTextInputControl
            label={t("Custom Speed")}
            value={customSpeed}
            onChange={setCustomSpeed}
            onBlur={handleCustomSpeed}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleCustomSpeed();
              }
            }}
            placeholder="1.0"
            width="100%"
          />
          <Text type="supporting" color="secondary" className="flex items-center text-xs">
            ×
          </Text>
        </div>
        <Text type="supporting" color="secondary" className="text-xs">
          {t("Range: 0.1× (slowest) to 20× (fastest)")}</Text>
      </div>

      {hasAudio() && (
        <Card
          variant="muted"
          padding={3}
          className="flex items-center justify-between border border-border"
        >
          <Text type="supporting" color="secondary" className="text-xs">
            {t("Apply speed to audio")}</Text>
          <MockToggle
            checked={affectAudio}
            onChange={setAffectAudio}
            ariaLabel={t("Apply speed to audio")}
          />
        </Card>
      )}

      <Button
        label={isReversed ? t("Reversed") : t("Reverse Clip")}
        icon={<RotateCcw size={14} />}
        variant={isReversed ? "primary" : "secondary"}
        size="sm"
        onClick={handleToggleReverse}
        className="w-full justify-center"
      />

      {currentSpeed < 1 && (
        <Card variant="muted" padding={3} className="space-y-2 border border-border">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-primary" />
              <Text type="supporting" color="secondary" className="text-xs">
                {t("Smooth Slow Motion")}</Text>
            </div>
            <MockToggle
              ariaLabel={t("Smooth Slow Motion")}
              checked={clip.smoothSlowMo ?? false}
              onChange={(checked) => {
                const tracks = project.timeline.tracks.map((track) => {
                  const clipIndex = track.clips.findIndex((c) => c.id === clip.id);
                  if (clipIndex === -1) return track;
                  const updatedClip = { ...track.clips[clipIndex], smoothSlowMo: checked };
                  const newClips = [...track.clips];
                  newClips[clipIndex] = updatedClip;
                  return { ...track, clips: newClips };
                });
                useProjectStore.setState({
                  project: {
                    ...project,
                    timeline: { ...project.timeline, tracks },
                    modifiedAt: Date.now(),
                  },
                });
              }}
            />
          </div>
          {clip.smoothSlowMo && (
            <div className="space-y-1">
              <Selector
                label={t("Quality")}
                size="sm"
                width="100%"
                value={clip.interpolationQuality ?? "medium"}
                options={[
                  { label: t("Low (faster)"), value: "low" },
                  { label: t("Medium"), value: "medium" },
                  { label: t("High (slower)"), value: "high" },
                ]}
                onChange={(value) => {
                  const tracks = project.timeline.tracks.map((track) => {
                    const clipIndex = track.clips.findIndex((c) => c.id === clip.id);
                    if (clipIndex === -1) return track;
                    const updatedClip = {
                      ...track.clips[clipIndex],
                      interpolationQuality: value as "low" | "medium" | "high",
                    };
                    const newClips = [...track.clips];
                    newClips[clipIndex] = updatedClip;
                    return { ...track, clips: newClips };
                  });
                  useProjectStore.setState({
                    project: {
                      ...project,
                      timeline: { ...project.timeline, tracks },
                      modifiedAt: Date.now(),
                    },
                  });
                }}
              />
              <Text type="supporting" color="secondary" className="text-[10px]">
                {t("Uses optical flow to generate smooth in-between frames")}</Text>
            </div>
          )}
        </Card>
      )}

      {(currentSpeed !== 1 || isReversed) && (
        <Card variant="muted" padding={3} className="border border-border">
          <Text type="supporting" color="secondary" className="mb-1 block text-xs">
            {t("Current Settings")}</Text>
          <Text type="body" color="primary" className="block text-sm">
            {t("Speed: ")}{currentSpeed}× {isReversed && "• Reversed"}
            {clip.smoothSlowMo && " • Smooth"}
          </Text>
        </Card>
      )}
    </div>
  );
};
