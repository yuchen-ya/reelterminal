/**
 * Letterbox geometry shared by the Preview overlay bounds calculations.
 *
 * When the canvas CSS element's aspect ratio (elementWidth/elementHeight)
 * differs from the project canvas aspect ratio (canvasWidth/canvasHeight),
 * the rendered content is letterboxed inside the element. This computes the
 * on-screen content rectangle, the centered letterbox offsets, and the
 * display scale mapping project-canvas units to CSS pixels, for shared use
 * by the clip/text/graphic/subtitle overlay bounds calculations.
 */

export interface LetterboxGeometry {
  actualWidth: number;
  actualHeight: number;
  letterboxOffsetX: number;
  letterboxOffsetY: number;
  displayScale: number;
}

export function computeLetterboxGeometry(
  canvasWidth: number,
  canvasHeight: number,
  elementWidth: number,
  elementHeight: number,
): LetterboxGeometry {
  const canvasAspect = canvasWidth / canvasHeight;
  const elementAspect = elementWidth / elementHeight;

  let actualWidth: number;
  let actualHeight: number;
  let letterboxOffsetX = 0;
  let letterboxOffsetY = 0;

  if (elementAspect > canvasAspect) {
    actualHeight = elementHeight;
    actualWidth = actualHeight * canvasAspect;
    letterboxOffsetX = (elementWidth - actualWidth) / 2;
  } else {
    actualWidth = elementWidth;
    actualHeight = actualWidth / canvasAspect;
    letterboxOffsetY = (elementHeight - actualHeight) / 2;
  }

  const displayScale = actualWidth / canvasWidth;

  return {
    actualWidth,
    actualHeight,
    letterboxOffsetX,
    letterboxOffsetY,
    displayScale,
  };
}
