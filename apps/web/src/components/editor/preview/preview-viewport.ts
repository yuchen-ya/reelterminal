export type PreviewZoom =
  | { readonly mode: "fit" }
  | { readonly mode: "percent"; readonly value: number };

export interface PreviewViewportSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Calculates the visible player frame in CSS pixels. `fit` uses the complete
 * ResizeObserver content box (which already excludes CSS padding); fixed
 * zoom percentages are based on the project's actual pixel dimensions.
 * Multiple columns are used by side-by-side reference comparison.
 */
export function computePreviewFrameSize(args: {
  readonly viewport: PreviewViewportSize;
  readonly project: PreviewViewportSize;
  readonly zoom: PreviewZoom;
  readonly columns?: number;
}): PreviewViewportSize {
  const { viewport, project, zoom } = args;
  const columns = Math.max(1, args.columns ?? 1);
  if (
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    project.width <= 0 ||
    project.height <= 0
  ) {
    return { width: 0, height: 0 };
  }

  if (zoom.mode === "percent") {
    const scale = Math.max(1, zoom.value) / 100;
    return {
      width: project.width * scale * columns,
      height: project.height * scale,
    };
  }

  const scale = Math.min(
    viewport.width / (project.width * columns),
    viewport.height / project.height,
  );
  return {
    width: project.width * scale * columns,
    height: project.height * scale,
  };
}

export function previewFrameOverflows(
  frame: PreviewViewportSize,
  viewport: PreviewViewportSize,
): boolean {
  return frame.width > viewport.width + 0.5 || frame.height > viewport.height + 0.5;
}
