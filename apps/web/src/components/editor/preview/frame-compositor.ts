import { getBackgroundRemovalEngine, type Track } from "@reelterminal/core";
import { getEffectsBridge } from "../../../bridges/effects-bridge";
import { clipBackgroundRemovalSettings } from "./background-removal-settings";

export type PreviewClip = Track["clips"][number];

export const clipNeedsFrameProcessing = (clipId: string): boolean => {
  const bgEngine = getBackgroundRemovalEngine();
  if (
    bgEngine?.isInitialized() &&
    clipBackgroundRemovalSettings(clipId).enabled
  ) {
    return true;
  }

  const effectsBridge = getEffectsBridge();
  if (!effectsBridge.isInitialized()) {
    return false;
  }

  if (effectsBridge.getEffects(clipId).some((effect) => effect.enabled)) {
    return true;
  }

  return Object.keys(effectsBridge.getColorGrading(clipId)).length > 0;
};

export const clipCssFilterOnly = (clipId: string): string | null => {
  const bgEngine = getBackgroundRemovalEngine();
  if (
    bgEngine?.isInitialized() &&
    clipBackgroundRemovalSettings(clipId).enabled
  ) {
    return null;
  }
  const effectsBridge = getEffectsBridge();
  if (!effectsBridge.isInitialized()) {
    return null;
  }
  return effectsBridge.getNativeCssFilter(clipId);
};

// The rendered project frame is letterboxed ("contain") inside the canvas
// element. Returns the content rect (CSS px, relative to the element's
// top-left) that maps 1:1 onto the project frame, so pointer coordinates can
// be normalized against the frame — the same geometry the selection bounds
// helpers compute inline.
export const projectFrameContentRect = (
  frameWidth: number,
  frameHeight: number,
  elementWidth: number,
  elementHeight: number,
): { x: number; y: number; width: number; height: number } => {
  const frameAspect = frameWidth / frameHeight;
  const elementAspect = elementWidth / elementHeight;
  if (elementAspect > frameAspect) {
    const width = elementHeight * frameAspect;
    return { x: (elementWidth - width) / 2, y: 0, width, height: elementHeight };
  }
  const height = elementWidth / frameAspect;
  return { x: 0, y: (elementHeight - height) / 2, width: elementWidth, height };
};
