import type { CSSProperties, JSX, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ToolcraftIconButton as IconButton } from "@openreel/ui";
import { Maximize2, Minimize2, Minus, X } from "@/icons/lucide-compat";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloatingWindowProps {
  title: ReactNode;
  icon?: ReactNode;
  bounds: WindowBounds;
  minSize?: { width: number; height: number };
  maximized?: boolean;
  minimized?: boolean;
  onBoundsChange: (bounds: WindowBounds) => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
  /** Portal target; defaults to document.body. The desktop shell passes its
   * themed root so the window inherits the shell's theme tokens. */
  portalContainer?: Element | null;
  children: ReactNode;
}

export const FLOATING_WINDOW_MARGIN = 8;
export const DEFAULT_MIN_SIZE = { width: 320, height: 280 } as const;

type Size = { width: number; height: number };

type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

function readViewport(): Size {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Keeps a window fully inside the visible viewport (8px margin) when it fits
 * there; a window larger than the viewport shrinks to fit. Pure, so tests can
 * drive it with an explicit viewport.
 */
export function clampBoundsToViewport(
  bounds: WindowBounds,
  minSize: Size = DEFAULT_MIN_SIZE,
  viewport: Size = readViewport(),
): WindowBounds {
  const margin = FLOATING_WINDOW_MARGIN;
  const maxWidth = Math.max(minSize.width, viewport.width - margin * 2);
  const maxHeight = Math.max(minSize.height, viewport.height - margin * 2);
  const width = Math.min(Math.max(bounds.width, minSize.width), maxWidth);
  const height = Math.min(Math.max(bounds.height, minSize.height), maxHeight);
  const maxX = Math.max(margin, viewport.width - margin - width);
  const maxY = Math.max(margin, viewport.height - margin - height);
  const x = Math.min(Math.max(bounds.x, margin), maxX);
  const y = Math.min(Math.max(bounds.y, margin), maxY);
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function maximizedBounds(minSize: Size): WindowBounds {
  const viewport = readViewport();
  return clampBoundsToViewport(
    {
      x: FLOATING_WINDOW_MARGIN,
      y: FLOATING_WINDOW_MARGIN,
      width: viewport.width - FLOATING_WINDOW_MARGIN * 2,
      height: viewport.height - FLOATING_WINDOW_MARGIN * 2,
    },
    minSize,
  );
}

function applyResize(
  start: WindowBounds,
  direction: ResizeDirection,
  dx: number,
  dy: number,
  minSize: Size,
): WindowBounds {
  let { x, y, width, height } = start;
  if (direction.includes("e")) width = start.width + dx;
  if (direction.includes("s")) height = start.height + dy;
  if (direction.includes("w")) {
    width = start.width - dx;
    x = start.x + dx;
  }
  if (direction.includes("n")) {
    height = start.height - dy;
    y = start.y + dy;
  }
  if (width < minSize.width) {
    if (direction.includes("w")) x = start.x + start.width - minSize.width;
    width = minSize.width;
  }
  if (height < minSize.height) {
    if (direction.includes("n")) y = start.y + start.height - minSize.height;
    height = minSize.height;
  }
  return { x, y, width, height };
}

const RESIZE_HANDLES: ReadonlyArray<{
  direction: ResizeDirection;
  className: string;
}> = [
  { direction: "n", className: "absolute left-2 right-2 top-0 h-1.5 cursor-ns-resize" },
  { direction: "s", className: "absolute bottom-0 left-2 right-2 h-1.5 cursor-ns-resize" },
  { direction: "e", className: "absolute bottom-2 right-0 top-2 w-1.5 cursor-ew-resize" },
  { direction: "w", className: "absolute bottom-2 left-0 top-2 w-1.5 cursor-ew-resize" },
  { direction: "ne", className: "absolute right-0 top-0 h-2.5 w-2.5 cursor-nesw-resize" },
  { direction: "nw", className: "absolute left-0 top-0 h-2.5 w-2.5 cursor-nwse-resize" },
  { direction: "se", className: "absolute bottom-0 right-0 h-2.5 w-2.5 cursor-nwse-resize" },
  { direction: "sw", className: "absolute bottom-0 left-0 h-2.5 w-2.5 cursor-nesw-resize" },
];

/**
 * Controlled floating window with a draggable title bar and eight resize
 * handles. Rendered through a portal to document.body so it can overlay the
 * editor regardless of where it is mounted. The parent owns the bounds; the
 * window reports live drags visually and commits via onBoundsChange on
 * pointer-up. Minimized keeps children mounted (display:none) so their React
 * state survives.
 */
export function FloatingWindow({
  title,
  icon,
  bounds,
  minSize = DEFAULT_MIN_SIZE,
  maximized = false,
  minimized = false,
  onBoundsChange,
  onMinimize,
  onToggleMaximize,
  onClose,
  portalContainer,
  children,
}: FloatingWindowProps): JSX.Element {
  const { t } = useTranslation();
  const [liveBounds, setLiveBounds] = useState<WindowBounds | null>(null);
  // Bumped on viewport resize so the maximized geometry tracks the viewport.
  const [, setViewportVersion] = useState(0);
  const didDragRef = useRef(false);

  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const minSizeRef = useRef(minSize);
  minSizeRef.current = minSize;
  const onBoundsChangeRef = useRef(onBoundsChange);
  onBoundsChangeRef.current = onBoundsChange;

  // Retract into the visible viewport on mount and on every viewport resize.
  useEffect(() => {
    const retract = (): void => {
      setViewportVersion((version) => version + 1);
      const current = boundsRef.current;
      const clamped = clampBoundsToViewport(current, minSizeRef.current);
      if (
        clamped.x !== current.x ||
        clamped.y !== current.y ||
        clamped.width !== current.width ||
        clamped.height !== current.height
      ) {
        onBoundsChangeRef.current(clamped);
      }
    };
    retract();
    window.addEventListener("resize", retract);
    return () => window.removeEventListener("resize", retract);
  }, []);

  const displayBounds =
    liveBounds ??
    (maximized
      ? maximizedBounds(minSize)
      : clampBoundsToViewport(bounds, minSize));

  const onTitleBarPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (event.button !== 0 || maximized) return;
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const start = displayBounds;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const target = event.currentTarget;
    let next = start;
    didDragRef.current = false;
    try {
      target.setPointerCapture?.(pointerId);
    } catch {
      /* jsdom has no pointer capture */
    }

    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 3) {
        didDragRef.current = true;
      }
      next = clampBoundsToViewport(
        {
          ...start,
          x: start.x + (ev.clientX - startX),
          y: start.y + (ev.clientY - startY),
        },
        minSizeRef.current,
      );
      setLiveBounds(next);
    };
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      try {
        target.releasePointerCapture?.(pointerId);
      } catch {
        /* capture already released */
      }
      setLiveBounds(null);
      if (next !== start) onBoundsChangeRef.current(next);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onTitleBarClick = (): void => {
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
    if (minimized) onMinimize();
  };

  const onTitleBarDoubleClick = (): void => {
    if (minimized) {
      onMinimize();
    } else {
      onToggleMaximize();
    }
  };

  const onResizePointerDown =
    (direction: ResizeDirection) =>
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0 || maximized || minimized) return;
      event.preventDefault();
      event.stopPropagation();
      const start = displayBounds;
      const startX = event.clientX;
      const startY = event.clientY;
      const pointerId = event.pointerId;
      const target = event.currentTarget;
      let next = start;
      try {
        target.setPointerCapture?.(pointerId);
      } catch {
        /* jsdom has no pointer capture */
      }

      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return;
        next = clampBoundsToViewport(
          applyResize(
            start,
            direction,
            ev.clientX - startX,
            ev.clientY - startY,
            minSizeRef.current,
          ),
          minSizeRef.current,
        );
        setLiveBounds(next);
      };
      const onUp = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        try {
          target.releasePointerCapture?.(pointerId);
        } catch {
          /* capture already released */
        }
        setLiveBounds(null);
        if (next !== start) onBoundsChangeRef.current(next);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };

  const windowStyle: CSSProperties = minimized
    ? { left: displayBounds.x, top: displayBounds.y, width: displayBounds.width }
    : {
        left: displayBounds.x,
        top: displayBounds.y,
        width: displayBounds.width,
        height: displayBounds.height,
      };

  return createPortal(
    <div
      data-testid="floating-window"
      className="fixed z-[60] flex touch-none flex-col overflow-hidden rounded-xl border border-border bg-bg-1 shadow-2xl"
      style={windowStyle}
    >
      <div
        data-testid="floating-window-titlebar"
        className={`flex h-8 shrink-0 select-none items-center gap-1.5 bg-bg-1 pl-2.5 pr-1 ${
          minimized ? "cursor-pointer" : "border-b border-border"
        }`}
        onPointerDown={onTitleBarPointerDown}
        onClick={onTitleBarClick}
        onDoubleClick={onTitleBarDoubleClick}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg">
          {title}
        </span>
        {minimized ? (
          <>
            <IconButton
              label={t("floatingWindow.restore")}
              icon={<Maximize2 size={13} aria-hidden />}
              size="sm"
              variant="ghost"
              onClick={onMinimize}
              className="h-6 w-6"
            />
            <IconButton
              label={t("floatingWindow.close")}
              icon={<X size={13} aria-hidden />}
              size="sm"
              variant="ghost"
              onClick={onClose}
              className="h-6 w-6"
            />
          </>
        ) : (
          <>
            <IconButton
              label={t("floatingWindow.minimize")}
              icon={<Minus size={13} aria-hidden />}
              size="sm"
              variant="ghost"
              onClick={onMinimize}
              className="h-6 w-6"
            />
            <IconButton
              label={
                maximized
                  ? t("floatingWindow.restore")
                  : t("floatingWindow.maximize")
              }
              icon={
                maximized ? (
                  <Minimize2 size={13} aria-hidden />
                ) : (
                  <Maximize2 size={13} aria-hidden />
                )
              }
              size="sm"
              variant="ghost"
              onClick={onToggleMaximize}
              className="h-6 w-6"
            />
            <IconButton
              label={t("floatingWindow.close")}
              icon={<X size={13} aria-hidden />}
              size="sm"
              variant="ghost"
              onClick={onClose}
              className="h-6 w-6"
            />
          </>
        )}
      </div>

      <div
        data-testid="floating-window-body"
        className="flex min-h-0 flex-1 flex-col"
        style={minimized ? { display: "none" } : undefined}
      >
        {children}
      </div>

      {!minimized && !maximized
        ? RESIZE_HANDLES.map(({ direction, className }) => (
            <div
              key={direction}
              data-testid={`floating-window-resize-${direction}`}
              className={`${className} z-10 touch-none`}
              onPointerDown={onResizePointerDown(direction)}
            />
          ))
        : null}
    </div>,
    portalContainer ?? document.body,
  );
}

export default FloatingWindow;
