import React from "react";
import { ToolcraftButton as Button } from "@reelterminal/ui";
import { Move } from "@/icons/lucide-compat";
import { useTranslation } from "react-i18next";
import type { HandlePosition } from "./types";

export type SelectionTransformOverlayTheme = "primary" | "cyan";

interface SelectionTransformOverlayProps {
  bounds: { x: number; y: number; width: number; height: number };
  lockAspectRatio: boolean;
  theme: SelectionTransformOverlayTheme;
  moveTitle: string;
  onToggleLock: () => void;
  onMoveHandleMouseDown: (e: React.MouseEvent) => void;
  onHandleMouseDown: (e: React.MouseEvent, handle: HandlePosition) => void;
}

// Accent class fragments per theme. Every value is the exact literal class
// name the inline overlays in Preview always rendered, so Tailwind keeps
// seeing the same tokens and the composed classNames stay byte-identical.
const THEME_ACCENTS: Record<
  SelectionTransformOverlayTheme,
  {
    border: string;
    moveBackground: string;
    hoverBackground: string;
    lockBackground: string;
  }
> = {
  primary: {
    border: "border-primary",
    moveBackground: "bg-primary/80",
    hoverBackground: "hover:bg-primary",
    lockBackground: "bg-primary",
  },
  cyan: {
    border: "border-cyan-500",
    moveBackground: "bg-cyan-500/80",
    hoverBackground: "hover:bg-cyan-500",
    lockBackground: "bg-cyan-500",
  },
};

/**
 * Pure presentational selection/transform overlay: positioned container,
 * selection border, center move handle, aspect-ratio lock toggle and the
 * eight resize handles. All interaction is delegated to the caller.
 */
export const SelectionTransformOverlay: React.FC<SelectionTransformOverlayProps> = ({
  bounds,
  lockAspectRatio,
  theme,
  moveTitle,
  onToggleLock,
  onMoveHandleMouseDown,
  onHandleMouseDown,
}) => {
  const { t } = useTranslation();
  const accent = THEME_ACCENTS[theme];

  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }}
    >
      {/* Selection border */}
      <div className={`absolute inset-0 border-2 ${accent.border} pointer-events-none`} />

      {/* Move handle (center) */}
      <div
        className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 ${accent.moveBackground} rounded-full flex items-center justify-center cursor-move pointer-events-auto ${accent.hoverBackground} transition-colors`}
        onMouseDown={onMoveHandleMouseDown}
        title={moveTitle}
      >
        <Move size={14} className="text-white" />
      </div>

      {/* Aspect ratio lock toggle */}
      <Button
        label={lockAspectRatio ? t("Unlock aspect ratio") : t("Lock aspect ratio")}
        variant="ghost"
        className={`absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 text-[10px] rounded pointer-events-auto transition-colors ${
          lockAspectRatio
            ? `${accent.lockBackground} text-white`
            : "bg-background-tertiary text-text-secondary border border-border hover:bg-background-elevated"
        }`}
        onClick={onToggleLock}
      >
        {lockAspectRatio ? "🔒 Locked" : "🔓 Free"}
      </Button>

      {/* Corner resize handles */}
      <div
        className={`absolute -left-2 -top-2 w-4 h-4 bg-white border-2 ${accent.border} rounded-sm cursor-nw-resize pointer-events-auto ${accent.hoverBackground} hover:border-white transition-colors`}
        onMouseDown={(e) => onHandleMouseDown(e, "nw")}
      />
      <div
        className={`absolute -right-2 -top-2 w-4 h-4 bg-white border-2 ${accent.border} rounded-sm cursor-ne-resize pointer-events-auto ${accent.hoverBackground} hover:border-white transition-colors`}
        onMouseDown={(e) => onHandleMouseDown(e, "ne")}
      />
      <div
        className={`absolute -left-2 -bottom-2 w-4 h-4 bg-white border-2 ${accent.border} rounded-sm cursor-sw-resize pointer-events-auto ${accent.hoverBackground} hover:border-white transition-colors`}
        onMouseDown={(e) => onHandleMouseDown(e, "sw")}
      />
      <div
        className={`absolute -right-2 -bottom-2 w-4 h-4 bg-white border-2 ${accent.border} rounded-sm cursor-se-resize pointer-events-auto ${accent.hoverBackground} hover:border-white transition-colors`}
        onMouseDown={(e) => onHandleMouseDown(e, "se")}
      />

      {/* Edge resize handles */}
      <div
        className={`absolute left-1/2 -translate-x-1/2 -top-2 w-6 h-4 bg-white border-2 ${accent.border} rounded-sm cursor-n-resize pointer-events-auto ${accent.hoverBackground} hover:border-white transition-colors`}
        onMouseDown={(e) => onHandleMouseDown(e, "n")}
      />
      <div
        className={`absolute left-1/2 -translate-x-1/2 -bottom-2 w-6 h-4 bg-white border-2 ${accent.border} rounded-sm cursor-s-resize pointer-events-auto ${accent.hoverBackground} hover:border-white transition-colors`}
        onMouseDown={(e) => onHandleMouseDown(e, "s")}
      />
      <div
        className={`absolute top-1/2 -translate-y-1/2 -left-2 w-4 h-6 bg-white border-2 ${accent.border} rounded-sm cursor-w-resize pointer-events-auto ${accent.hoverBackground} hover:border-white transition-colors`}
        onMouseDown={(e) => onHandleMouseDown(e, "w")}
      />
      <div
        className={`absolute top-1/2 -translate-y-1/2 -right-2 w-4 h-6 bg-white border-2 ${accent.border} rounded-sm cursor-e-resize pointer-events-auto ${accent.hoverBackground} hover:border-white transition-colors`}
        onMouseDown={(e) => onHandleMouseDown(e, "e")}
      />
    </div>
  );
};

export default SelectionTransformOverlay;
