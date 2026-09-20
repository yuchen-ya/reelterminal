import React, { useState, useCallback, useMemo, useEffect } from "react";
import { Video, Pipette, RefreshCw, Eye, EyeOff, Layers } from "@/icons/lucide-compat";
import { ToolcraftButton as Button } from "@reelterminal/ui";
import { ToolcraftIconButton as IconButton } from "@reelterminal/ui";
import { ToolcraftSelectableCard as SelectableCard } from "@reelterminal/ui";
import { ToolcraftText as Text } from "@reelterminal/ui";
import { MockSlider } from "./shell/InspectorControls";
import { useProjectStore } from "../../../stores/project-store";
import { useEngineStore } from "../../../stores/engine-store";
import type { RGB, ChromaKeySettings, Action } from "@reelterminal/core";
import { useTranslation } from "react-i18next";

interface GreenScreenSectionProps {
  clipId: string;
}

const ColorPreview: React.FC<{ color: RGB; onClick?: () => void }> = ({
  color,
  onClick,
}) => {
  const { t } = useTranslation();
  return (
  <Button
    label={t("Pick color from video")}
    variant="ghost"
    onClick={onClick}
    className="w-8 h-8 rounded-lg border-2 border-border hover:border-primary transition-colors"
    style={{
      backgroundColor: `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`,
    }}
  />
);
};

const ControlSlider: React.FC<{
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}> = ({ label, value, onChange, min = 0, max = 1, step = 0.01 }) => {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-fg-2">{label}</span>
        <span className="text-[10px] font-mono text-fg bg-bg-2 px-1.5 py-0.5 rounded border border-border">
          {Math.round(value * 100)}%
        </span>
      </div>
      <MockSlider
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={onChange}
      />
    </div>
  );
};

const ColorPresetButton: React.FC<{
  color: RGB;
  label: string;
  isActive: boolean;
  onClick: () => void;
}> = ({ color, label, isActive, onClick }) => (
  <SelectableCard
    label={label}
    isSelected={isActive}
    onChange={onClick}
    onClick={onClick}
    padding={1}
    variant={isActive ? "green" : "muted"}
    className={`flex items-center gap-1.5 px-2 py-1 rounded text-[9px] transition-colors ${
      isActive
        ? "bg-primary text-white"
        : "bg-bg-2 text-fg-3 hover:text-fg"
    }`}
  >
    <div
      className="w-3 h-3 rounded-sm border border-border"
      style={{
        backgroundColor: `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`,
      }}
    />
    {label}
  </SelectableCard>
);

const COLOR_PRESETS: { color: RGB; label: string }[] = [
  { color: { r: 0, g: 1, b: 0 }, label: "Green" },
  { color: { r: 0, g: 0, b: 1 }, label: "Blue" },
  { color: { r: 1, g: 0, b: 1 }, label: "Magenta" },
  { color: { r: 0, g: 1, b: 1 }, label: "Cyan" },
];

export const GreenScreenSection: React.FC<GreenScreenSectionProps> = ({
  clipId,
}) => {
  const { t } = useTranslation();
  const project = useProjectStore((state) => state.project);
  const getChromaKeyEngine = useEngineStore(
    (state) => state.getChromaKeyEngine,
  );

  const [isPickingColor, setIsPickingColor] = useState(false);
  const [chromaKeyEngine, setChromaKeyEngine] =
    useState<import("@reelterminal/core").ChromaKeyEngine | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadEngine = async () => {
      const engine = await getChromaKeyEngine();
      if (!cancelled) {
        setChromaKeyEngine(engine);
      }
    };
    loadEngine();
    return () => {
      cancelled = true;
    };
  }, [getChromaKeyEngine]);

  // Reopened projects do not back-fill the chroma engine Map (loadProject
  // never re-seeds it): seed it from the persisted field on mount and after
  // every commit, so toggling or dragging here starts from the saved tuning
  // instead of engine defaults (which would reset the keyer or silently
  // disable the rendered keying via enabled:false).
  useEffect(() => {
    if (!chromaKeyEngine || !clipId) return;
    const clip = project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === clipId);
    if (clip?.chromaKey) {
      chromaKeyEngine.setSettings(clipId, clip.chromaKey);
    }
  }, [chromaKeyEngine, clipId, project]);

  // The persisted clip field is the display source of truth (loadProject
  // never re-seeds the engine Map, so the engine alone can show stale or
  // default values); the engine Map stays as the fallback for values that are
  // not committed yet.
  const settings = useMemo<ChromaKeySettings>(() => {
    const clip = project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === clipId);
    return (
      clip?.chromaKey ??
      chromaKeyEngine?.getSettings(clipId) ?? {
        enabled: false,
        keyColor: { r: 0, g: 1, b: 0 },
        tolerance: 0.3,
        edgeSoftness: 0.1,
        spillSuppression: 0.5,
      }
    );
  }, [chromaKeyEngine, clipId, project]);

  // Persist every keyer change through the clip/setChromaKey action so the
  // green screen is undoable AND rendered: the action writes both the
  // clip.chromaKey settings field and the chromaKey effect item in clip.effects
  // that the frame pipeline (preview bridge + export video-engine) consumes.
  // executeActionBatch (not bare executeAction) keeps the effects bridge in
  // sync so the preview picks the change up immediately.
  const persistChromaKeySettings = useCallback(() => {
    if (!chromaKeyEngine) return;
    const action: Action = {
      type: "clip/setChromaKey",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      params: { clipId, chromaKey: chromaKeyEngine.getSettings(clipId) },
    };
    useProjectStore.getState().executeActionBatch([action], {
      groupLabel: "Green screen",
      historyOwner: "human",
    });
  }, [chromaKeyEngine, clipId]);

  const handleToggleEnabled = useCallback(() => {
    if (!chromaKeyEngine) return;
    if (settings.enabled) {
      chromaKeyEngine.disableChromaKey(clipId);
    } else {
      chromaKeyEngine.enableChromaKey(clipId);
    }
    persistChromaKeySettings();
  }, [chromaKeyEngine, clipId, settings.enabled, persistChromaKeySettings]);

  const handleSetKeyColor = useCallback(
    (color: RGB) => {
      if (!chromaKeyEngine) return;
      chromaKeyEngine.setKeyColor(clipId, color);
      persistChromaKeySettings();
    },
    [chromaKeyEngine, clipId, persistChromaKeySettings],
  );

  const handleSetTolerance = useCallback(
    (value: number) => {
      if (!chromaKeyEngine) return;
      chromaKeyEngine.setTolerance(clipId, value);
      persistChromaKeySettings();
    },
    [chromaKeyEngine, clipId, persistChromaKeySettings],
  );

  const handleSetEdgeSoftness = useCallback(
    (value: number) => {
      if (!chromaKeyEngine) return;
      chromaKeyEngine.setEdgeSoftness(clipId, value);
      persistChromaKeySettings();
    },
    [chromaKeyEngine, clipId, persistChromaKeySettings],
  );

  const handleSetSpillSuppression = useCallback(
    (value: number) => {
      if (!chromaKeyEngine) return;
      chromaKeyEngine.setSpillSuppression(clipId, value);
      persistChromaKeySettings();
    },
    [chromaKeyEngine, clipId, persistChromaKeySettings],
  );

  const handleResetToDefaults = useCallback(() => {
    if (!chromaKeyEngine) return;
    chromaKeyEngine.setSettings(clipId, {
      enabled: true,
      keyColor: { r: 0, g: 1, b: 0 },
      tolerance: 0.3,
      edgeSoftness: 0.1,
      spillSuppression: 0.5,
    });
    persistChromaKeySettings();
  }, [chromaKeyEngine, clipId, persistChromaKeySettings]);

  const isActiveColor = (preset: RGB) =>
    Math.abs(settings.keyColor.r - preset.r) < 0.1 &&
    Math.abs(settings.keyColor.g - preset.g) < 0.1 &&
    Math.abs(settings.keyColor.b - preset.b) < 0.1;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 p-2 bg-gradient-to-r from-green-500/20 to-emerald-500/20 rounded-lg border border-green-500/30">
        <Video size={16} className="text-green-400" />
        <div className="flex flex-col gap-0.5 flex-1">
          <span className="block text-[11px] font-medium text-fg">
            {t("Green Screen")}</span>
          <Text type="supporting" color="secondary" display="block" className="text-[9px] text-fg-3">
            {t("Remove background color from video")}</Text>
        </div>
        <IconButton
          label={settings.enabled ? t("Disable chroma key") : t("Enable chroma key")}
          icon={settings.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
          variant="ghost"
          size="sm"
          onClick={handleToggleEnabled}
          className={`p-1.5 rounded transition-colors ${
            settings.enabled
              ? "bg-green-500/30 text-green-400"
              : "bg-bg-2 text-fg-3 hover:text-fg"
          }`}
        />
      </div>

      {settings.enabled && (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-fg">
                {t("Key Color")}</span>
              <div className="flex items-center gap-2">
                <IconButton
                  label={t("Pick color from video")}
                  icon={<Pipette size={12} />}
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsPickingColor(!isPickingColor)}
                  className={`p-1.5 rounded transition-colors ${
                    isPickingColor
                      ? "bg-primary text-white"
                      : "bg-bg-2 text-fg-3 hover:text-fg"
                  }`}
                />
                <ColorPreview color={settings.keyColor} />
              </div>
            </div>

            {isPickingColor && (
              <div className="p-2 bg-primary/10 border border-primary/30 rounded-lg">
                <Text type="supporting" color="primary" className="text-[9px] text-primary text-center">
                  {t("Click on the video preview to pick a color")}</Text>
              </div>
            )}

            <div className="flex flex-wrap gap-1">
              {COLOR_PRESETS.map((preset) => (
                <ColorPresetButton
                  key={preset.label}
                  color={preset.color}
                  label={t(preset.label)}
                  isActive={isActiveColor(preset.color)}
                  onClick={() => handleSetKeyColor(preset.color)}
                />
              ))}
            </div>
          </div>

          <div className="space-y-3 pt-2 border-t border-border">
            <ControlSlider
              label={t("Tolerance")}
              value={settings.tolerance}
              onChange={handleSetTolerance}
            />

            <ControlSlider
              label={t("Edge Softness")}
              value={settings.edgeSoftness}
              onChange={handleSetEdgeSoftness}
            />

            <ControlSlider
              label={t("Spill Suppression")}
              value={settings.spillSuppression}
              onChange={handleSetSpillSuppression}
            />
          </div>

          <div className="flex items-center gap-2 pt-2 border-t border-border">
            <Button
              label={t("Reset to Defaults")}
              variant="ghost"
              icon={<RefreshCw size={12} />}
              onClick={handleResetToDefaults}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 text-[10px] text-fg-2 hover:text-fg bg-bg-2 rounded-lg transition-colors"
            />
          </div>

          <div className="flex items-center gap-2 p-2 bg-bg-2 rounded-lg">
            <Layers size={12} className="text-fg-3" />
            <Text type="supporting" color="secondary" className="text-[9px] text-fg-3 flex-1">
              {t("Place video clips below this one to use as background")}</Text>
          </div>
        </>
      )}

      {!settings.enabled && (
        <div className="text-center py-4">
          <Video
            size={24}
            className="mx-auto mb-2 text-fg-3 opacity-50"
          />
          <Text type="supporting" color="secondary" display="block" className="text-[10px] text-fg-3">
            {t("Enable to remove background color")}</Text>
          <Button
            label={t("Enable Green Screen")}
            variant="primary"
            onClick={handleToggleEnabled}
            className="mt-2 px-4 py-1.5 text-[10px] bg-green-500/20 text-green-400 hover:bg-green-500/30 rounded-lg transition-colors"
          />
        </div>
      )}
    </div>
  );
};

export default GreenScreenSection;
