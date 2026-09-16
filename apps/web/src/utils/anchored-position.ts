import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

/**
 * Fixed-position style that keeps a body-portal layer visually anchored to an
 * in-app trigger element (below it, left-aligned).
 *
 * Body portals escape every ancestor stacking context (the desktop shell's
 * `isolate` root, the web header's `z-30`), which is exactly why they are used
 * for cross-region floating layers — but it also means the layer can no longer
 * inherit its on-screen spot from the DOM flow. The position is therefore
 * derived from the anchor's bounding rect and recomputed on window resize.
 * The editor shells are non-scrolling fixed grids, so no scroll listener is
 * needed. Sizing, margins and shadows stay on the caller's classes.
 */
export function useAnchoredBelowStyle(
  anchorRef: RefObject<HTMLElement | null>,
  active: boolean,
  gapPx: number,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({
    position: "fixed",
    left: 0,
    top: 0,
  });

  useLayoutEffect(() => {
    if (!active) return;
    const update = (): void => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      setStyle({ position: "fixed", left: rect.left, top: rect.bottom + gapPx });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [anchorRef, active, gapPx]);

  return style;
}
