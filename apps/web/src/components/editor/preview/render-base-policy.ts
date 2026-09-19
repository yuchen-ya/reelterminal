import type { ClipTransform } from "./types";

/**
 * Decides what a freshly rendered preview frame is drawn on top of.
 *
 * A frame produced by an effect such as chroma key contains large transparent
 * regions by design. Compositing such a frame over the previous baked frame
 * lets the stale pixels shine through every transparent region (and the
 * composite gets re-baked), so the preview appears to freeze at the first
 * render after load. When a full-frame active video clip owns the current
 * frame, the new frame must REPLACE the picture: draw from the clean
 * composition background instead — the same replace semantics the playing and
 * export paths already use (they fill the background every frame).
 *
 * The previous composite frame (`lastGoodFrame`) stays meaningful only as the
 * decode-failure fallback: when nothing could be rendered this round (the
 * decode was superseded by a newer seek or failed), the caller keeps showing
 * the last good frame instead of flashing an empty background.
 */

/** The frame is drawn from the clean composition background. */
export type PreviewRenderBase = "background" | "lastFrame";

export interface RenderBaseClipCandidate {
  /**
   * Media kind of the clip's source. Only "video" decodes to a canvas-sized,
   * fully opaque bitmap (letterboxing and blurred backdrop are baked in by
   * the decode step), so only a video clip can be trusted to cover the whole
   * canvas. Images decode to their raw bitmap and are drawn fit-contained, so
   * they may letterbox and must not claim full-frame coverage.
   */
  readonly mediaType: string | undefined;
  /** Clips on hidden tracks render nothing and must not own the frame. */
  readonly trackHidden: boolean;
  readonly startTime: number;
  readonly duration: number;
  /** A non-identity transform may scale/position the clip away from full coverage. */
  readonly transform?: ClipTransform | null;
}

export interface RenderBasePolicyInput {
  readonly time: number;
  /** Whether a previous composite frame exists to fall back on. */
  readonly hasLastGoodFrame: boolean;
  readonly clips: ReadonlyArray<RenderBaseClipCandidate>;
}

const TRANSFORM_EPSILON = 1e-6;

const isIdentityTransform = (transform?: ClipTransform | null): boolean => {
  if (!transform) return true;
  if (
    transform.scale &&
    (Math.abs(transform.scale.x - 1) > TRANSFORM_EPSILON ||
      Math.abs(transform.scale.y - 1) > TRANSFORM_EPSILON)
  ) {
    return false;
  }
  if (
    transform.position &&
    (Math.abs(transform.position.x) > TRANSFORM_EPSILON ||
      Math.abs(transform.position.y) > TRANSFORM_EPSILON)
  ) {
    return false;
  }
  if (
    typeof transform.rotation === "number" &&
    Math.abs(transform.rotation) > TRANSFORM_EPSILON
  ) {
    return false;
  }
  if (
    typeof transform.opacity === "number" &&
    transform.opacity < 1 - TRANSFORM_EPSILON
  ) {
    return false;
  }
  return true;
};

/** A clip is active on the half-open interval [startTime, startTime + duration). */
export const isActiveClipAt = (
  clip: Pick<RenderBaseClipCandidate, "startTime" | "duration">,
  time: number,
): boolean => time >= clip.startTime && time < clip.startTime + clip.duration;

/**
 * Whether this clip renders an opaque, canvas-covering frame at `time`.
 * Mirrors the decode contract: video frames are decoded into a canvas-sized
 * bitmap with the background already baked in, so an untransformed, fully
 * opaque, visible video clip replaces the whole picture.
 */
export const isFullFrameActiveVideoClip = (
  clip: RenderBaseClipCandidate,
  time: number,
): boolean =>
  !clip.trackHidden &&
  clip.mediaType === "video" &&
  isActiveClipAt(clip, time) &&
  isIdentityTransform(clip.transform);

/**
 * Picks the base a new preview frame is drawn onto.
 *
 * - No previous frame (fresh mount/project): always start from the background.
 * - A full-frame active video clip owns the frame: replace — redraw from the
 *   background so transparent effect regions reveal the background, never the
 *   stale previous frame.
 * - Otherwise (gaps between clips, picture-in-picture transforms, image-only
 *   compositions): keep the previous behaviour of compositing over the last
 *   good frame, which the caller also uses as the decode-failure fallback.
 */
export const resolveRenderBase = (
  input: RenderBasePolicyInput,
): PreviewRenderBase => {
  if (!input.hasLastGoodFrame) return "background";
  if (
    input.clips.some((clip) => isFullFrameActiveVideoClip(clip, input.time))
  ) {
    return "background";
  }
  return "lastFrame";
};
