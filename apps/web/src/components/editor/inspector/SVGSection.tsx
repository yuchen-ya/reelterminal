import React, { useCallback, useMemo, useState } from "react";
import { ToolcraftClickableCard as ClickableCard } from "@openreel/ui";
import { ToolcraftSelectControl as Selector } from "@openreel/ui";
import { ToolcraftText as Text } from "@openreel/ui";
import { PropertySlider } from "./shell/PropertySlider";
import { useProjectStore } from "../../../stores/project-store";
import type { GraphicAnimation, GraphicAnimationType } from "@openreel/core";
import { SVG_ANIMATION_PRESETS } from "@openreel/core";
import { ColorSelector } from "../../../motion/components/primitives";
import { t } from "../../../i18n";
import { useTranslation } from "react-i18next";
import { BookmarkPlus, Pencil, Trash2, Wand2 } from "lucide-react";
import { useCustomPresets } from "../../../services/custom-presets/use-custom-presets";
import type { CustomPresetRecord } from "@openreel/core/presets/types";
import { PresetNameDialog } from "../panels/preset-name-dialog";
import {
  applyGraphicsPresetToPlayhead,
  captureGraphicsPresetSvg,
  deleteCustomPresetWithConfirm,
  renameCustomPreset,
  saveGraphicsPreset,
} from "../panels/effect-transition-preset-controllers";
import { dedupePresetName } from "../panels/TextPresetsPanel";
import { toast } from "../../../stores/notification-store";

const ColorField: React.FC<{
  label: string;
  value: string;
  onChange: (color: string) => void;
}> = ({ label, value, onChange }) => (
  <div className="flex items-center justify-between gap-2">
    <Text type="supporting" color="secondary" className="text-[10px]">
      {label}
    </Text>
    <div className="max-w-[170px]">
      <ColorSelector
        label={`Select ${label.toLowerCase()}`}
        value={value}
        onChange={onChange}
      />
    </div>
  </div>
);

const ANIMATION_PRESETS = SVG_ANIMATION_PRESETS.map((preset) => ({
  value: preset.id,
  label: t(preset.name),
  description: preset.description,
}));

interface SVGSectionProps {
  clipId: string;
}

/** One row of the custom graphics preset list: apply / inline rename / delete. */
const GraphicsPresetRow: React.FC<{
  readonly preset: CustomPresetRecord;
  readonly onApply: (preset: CustomPresetRecord) => void;
  readonly onRename: (preset: CustomPresetRecord, draft: string) => void;
  readonly onDelete: (preset: CustomPresetRecord) => void;
}> = ({ preset, onApply, onRename, onDelete }) => {
  const { t } = useTranslation();
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");

  const startRename = () => {
    setRenameDraft(preset.name);
    setIsRenaming(true);
  };
  const submitRename = () => {
    if (isRenaming) onRename(preset, renameDraft);
    setIsRenaming(false);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={preset.name}
      data-graphics-preset-id={preset.id}
      onDoubleClick={() => {
        if (!isRenaming) onApply(preset);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !isRenaming) onApply(preset);
      }}
      className="group flex cursor-pointer items-center gap-1 rounded-lg border border-border bg-bg-2 px-2 py-1.5 text-left transition-colors hover:border-accent"
    >
      <div className="min-w-0 flex-1">
        {isRenaming ? (
          <input
            autoFocus
            aria-label={t("assets.graphicsPresets.renameAriaLabel")}
            maxLength={80}
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.currentTarget.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setIsRenaming(false);
              }
            }}
            onBlur={submitRename}
            className="w-full rounded border border-border bg-bg px-1.5 py-0.5 text-[11px] text-fg outline-none focus:border-accent"
          />
        ) : (
          <Text
            type="supporting"
            weight="bold"
            display="block"
            maxLines={1}
            className="text-[11px] leading-tight text-fg"
          >
            {preset.name}
          </Text>
        )}
      </div>
      <button
        type="button"
        aria-label={t("assets.graphicsPresets.applyAction")}
        title={t("assets.graphicsPresets.applyAction")}
        onClick={(event) => {
          event.stopPropagation();
          onApply(preset);
        }}
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-fg-3 hover:bg-hover hover:text-fg"
      >
        <Wand2 size={12} aria-hidden />
      </button>
      <button
        type="button"
        aria-label={t("assets.graphicsPresets.renameAction")}
        title={t("assets.graphicsPresets.renameAction")}
        onClick={(event) => {
          event.stopPropagation();
          startRename();
        }}
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-fg-3 hover:bg-hover hover:text-fg"
      >
        <Pencil size={12} aria-hidden />
      </button>
      <button
        type="button"
        aria-label={t("assets.graphicsPresets.deleteAction")}
        title={t("assets.graphicsPresets.deleteAction")}
        onClick={(event) => {
          event.stopPropagation();
          onDelete(preset);
        }}
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-fg-3 hover:bg-hover hover:text-red-400"
      >
        <Trash2 size={12} aria-hidden />
      </button>
    </div>
  );
};

export const SVGSection: React.FC<SVGSectionProps> = ({ clipId }) => {
  const { t } = useTranslation();
  const { getSVGClipById, updateSVGClip, project } = useProjectStore();

  const svgClip = useMemo(
    () => getSVGClipById(clipId),
    [clipId, getSVGClipById, project.modifiedAt],
  );

  const customGraphicsPresets = useCustomPresets("graphics");
  const existingPresetNames = useMemo(
    () => customGraphicsPresets.map((preset) => preset.name),
    [customGraphicsPresets],
  );
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetNameDraft, setPresetNameDraft] = useState("");

  const colorStyle = useMemo(
    () =>
      svgClip?.colorStyle ?? {
        colorMode: "none" as const,
        tintColor: "#ffffff",
        tintOpacity: 1,
      },
    [svgClip?.colorStyle],
  );

  const entryAnimation = svgClip?.entryAnimation;
  const exitAnimation = svgClip?.exitAnimation;

  const handleColorModeChange = useCallback(
    (mode: "none" | "tint" | "replace") => {
      if (!svgClip) {
        console.warn(`[SVGSection] No SVG clip found for ${clipId}`);
        return;
      }
      const newColorStyle = {
        ...colorStyle,
        colorMode: mode,
      };
      updateSVGClip(clipId, {
        colorStyle: newColorStyle,
      });
    },
    [clipId, svgClip, colorStyle, updateSVGClip],
  );

  const handleTintColorChange = useCallback(
    (color: string) => {
      if (!svgClip) return;
      updateSVGClip(clipId, {
        colorStyle: {
          ...colorStyle,
          tintColor: color,
        },
      });
    },
    [clipId, svgClip, colorStyle, updateSVGClip],
  );

  const handleTintOpacityChange = useCallback(
    (opacity: number) => {
      if (!svgClip) return;
      updateSVGClip(clipId, {
        colorStyle: {
          ...colorStyle,
          tintOpacity: opacity,
        },
      });
    },
    [clipId, svgClip, colorStyle, updateSVGClip],
  );

  const handleEntryAnimationChange = useCallback(
    (type: GraphicAnimationType) => {
      if (!svgClip) {
        console.warn(`[SVGSection] No SVG clip found for ${clipId}`);
        return;
      }
      const animation: GraphicAnimation = {
        type,
        duration: entryAnimation?.duration || 0.5,
        easing: entryAnimation?.easing || "ease-out",
      };
      updateSVGClip(clipId, { entryAnimation: animation });
    },
    [clipId, svgClip, entryAnimation, updateSVGClip],
  );

  const handleExitAnimationChange = useCallback(
    (type: GraphicAnimationType) => {
      if (!svgClip) return;
      const animation: GraphicAnimation = {
        type,
        duration: exitAnimation?.duration || 0.5,
        easing: exitAnimation?.easing || "ease-out",
      };
      updateSVGClip(clipId, { exitAnimation: animation });
    },
    [clipId, svgClip, exitAnimation, updateSVGClip],
  );

  const handleEntryDurationChange = useCallback(
    (duration: number) => {
      if (!svgClip || !entryAnimation) return;
      updateSVGClip(clipId, {
        entryAnimation: { ...entryAnimation, duration },
      });
    },
    [clipId, svgClip, entryAnimation, updateSVGClip],
  );

  const handleExitDurationChange = useCallback(
    (duration: number) => {
      if (!svgClip || !exitAnimation) return;
      updateSVGClip(clipId, {
        exitAnimation: { ...exitAnimation, duration },
      });
    },
    [clipId, svgClip, exitAnimation, updateSVGClip],
  );

  const handleSaveAsPreset = useCallback(() => {
    if (!svgClip) return;
    // Same-source validation gate as agent preset.create: the payload only
    // persists when validateSvgContent accepts the clip's SVG source.
    const capture = captureGraphicsPresetSvg(svgClip.svgContent);
    if (!capture.ok) {
      toast.error(t("assets.graphicsPresets.saveFailed"), capture.message);
      return;
    }
    setPresetNameDraft(dedupePresetName(t("assets.graphicsPresets.defaultName"), existingPresetNames));
    setPresetDialogOpen(true);
  }, [svgClip, existingPresetNames, t]);

  const handlePresetSaveConfirm = useCallback(() => {
    if (!svgClip) return;
    const capture = captureGraphicsPresetSvg(svgClip.svgContent);
    setPresetDialogOpen(false);
    if (!capture.ok) {
      toast.error(t("assets.graphicsPresets.saveFailed"), capture.message);
      return;
    }
    void saveGraphicsPreset({
      name: presetNameDraft,
      svg: capture.svg,
      existingNames: existingPresetNames,
    });
  }, [svgClip, presetNameDraft, existingPresetNames, t]);

  const handleApplyPreset = useCallback((preset: CustomPresetRecord) => {
    void applyGraphicsPresetToPlayhead(preset);
  }, []);

  const handleRenamePreset = useCallback(
    (preset: CustomPresetRecord, draft: string) => {
      void renameCustomPreset(preset, draft, "assets.graphicsPresets");
    },
    [],
  );

  const handleDeletePreset = useCallback((preset: CustomPresetRecord) => {
    void deleteCustomPresetWithConfirm(preset, "assets.graphicsPresets");
  }, []);

  if (!svgClip) {
    return (
      <Text type="supporting" color="secondary" className="py-8 text-center text-xs">
        {t("No SVG clip selected")}</Text>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Text type="supporting" color="secondary" className="text-[10px]">
            {t("Mode")}</Text>
          <div className="flex gap-1">
            {(["none", "tint", "replace"] as const).map((mode) => (
              <ClickableCard
                key={mode}
                label={`Set SVG color mode to ${mode}`}
                onClick={() => handleColorModeChange(mode)}
                className={`px-2 py-1 text-[9px] rounded capitalize transition-colors ${
                  colorStyle.colorMode === mode
                    ? "bg-primary text-white"
                    : "bg-bg-2 border border-border text-fg-2 hover:text-fg"
                }`}
              >
                {mode}
              </ClickableCard>
            ))}
          </div>
        </div>

        {colorStyle.colorMode !== "none" && (
          <>
            <ColorField
              label={t("Color")}
              value={colorStyle.tintColor || "#ffffff"}
              onChange={handleTintColorChange}
            />
            <PropertySlider
              label={t("Opacity")}
              value={colorStyle.tintOpacity || 1}
              onChange={handleTintOpacityChange}
              min={0}
              max={1}
              step={0.1}
              formatValue={(value) => `${Math.round(value * 100)}%`}
            />
          </>
        )}
      </div>

      <div className="space-y-3">
        <Selector
          label={t("Entry Animation")}
          size="sm"
          width="100%"
          value={entryAnimation?.type || "none"}
          options={ANIMATION_PRESETS.map((preset) => ({
            label: t(preset.label),
            value: preset.value,
          }))}
          onChange={(value) =>
            handleEntryAnimationChange(value as GraphicAnimationType)
          }
        />

        {entryAnimation && entryAnimation.type !== "none" && (
          <PropertySlider
            label={t("Duration")}
            value={entryAnimation.duration}
            onChange={handleEntryDurationChange}
            min={0.1}
            max={3}
            step={0.1}
            formatValue={(value) => `${value.toFixed(1)}s`}
          />
        )}
      </div>

      <div className="space-y-4">
        <Selector
          label={t("Exit Animation")}
          size="sm"
          width="100%"
          value={exitAnimation?.type || "none"}
          options={ANIMATION_PRESETS.map((preset) => ({
            label: t(preset.label),
            value: preset.value,
          }))}
          onChange={(value) =>
            handleExitAnimationChange(value as GraphicAnimationType)
          }
        />

        {exitAnimation && exitAnimation.type !== "none" && (
          <PropertySlider
            label={t("Duration")}
            value={exitAnimation.duration}
            onChange={handleExitDurationChange}
            min={0.1}
            max={3}
            step={0.1}
            formatValue={(value) => `${value.toFixed(1)}s`}
          />
        )}
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex items-center justify-between">
          <Text
            type="supporting"
            color="secondary"
            weight="bold"
            className="text-[9.5px] uppercase"
          >
            {t("assets.graphicsPresets.groupCustom")}
          </Text>
          <button
            type="button"
            aria-label={t("assets.graphicsPresets.save")}
            title={t("assets.graphicsPresets.save")}
            onClick={handleSaveAsPreset}
            className="flex items-center gap-1 rounded-md border border-border bg-bg-2 px-2 py-1 text-[10px] font-semibold text-fg-2 transition-colors hover:border-accent hover:text-fg"
          >
            <BookmarkPlus size={12} aria-hidden />
            {t("assets.graphicsPresets.save")}
          </button>
        </div>
        <Text
          type="supporting"
          color="secondary"
          display="block"
          className="text-[9.5px] leading-snug text-fg-muted"
        >
          {t("assets.graphicsPresets.sectionHint")}
        </Text>
        {customGraphicsPresets.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-2.5 text-center text-[10.5px] text-fg-muted">
            {t("assets.graphicsPresets.customEmpty")}
          </div>
        ) : (
          <div className="space-y-1.5">
            {customGraphicsPresets.map((preset) => (
              <GraphicsPresetRow
                key={preset.id}
                preset={preset}
                onApply={handleApplyPreset}
                onRename={handleRenamePreset}
                onDelete={handleDeletePreset}
              />
            ))}
          </div>
        )}
      </div>

      {presetDialogOpen && (
        <PresetNameDialog
          title={t("assets.graphicsPresets.dialogTitle")}
          placeholder={t("assets.graphicsPresets.namePlaceholder")}
          confirmLabel={t("assets.graphicsPresets.save")}
          value={presetNameDraft}
          onChange={setPresetNameDraft}
          onCancel={() => setPresetDialogOpen(false)}
          onConfirm={handlePresetSaveConfirm}
        />
      )}
    </div>
  );
};
