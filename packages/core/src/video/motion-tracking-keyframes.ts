import type { Keyframe } from "../types/timeline";
import type { Point, TrackingKeyframe } from "./motion-tracking-engine";

/**
 * Turns a motion-tracking result (per-frame tracked point/scale, the same
 * `TrackingData.keyframes` the GUI bridge holds in memory) into the transform
 * keyframes the renderer actually consumes through `clip.setKeyframes` / the
 * core `keyframe/setAll` action. This is the persistent, undoable landing of a
 * tracking result — the engine's in-memory TrackingAttachment Map is only a
 * session cache and is never read by the render or export chains.
 *
 * Semantics ("keep framed"): the renderer (drawFrameToContext) translates to
 * canvasCenter + position, rotates, then scales, and draws the contain-fitted
 * frame centered on the anchor — so a source pixel p renders at
 * canvasCenter + position + scale * fitScale * (p − W/2), with fitScale =
 * fitWidth / sourceWidth and the scale pivot on the source frame center (the
 * point that sits on the canvas center when the base transform is at its
 * defaults). When the tracked subject grows (sample.scale > firstScale) the
 * emitted scale shrinks the drawn frame around that pivot, so a pure
 * counter-shift position would leave the tracked point displaced by
 * (1 − s_emit) * fitScale * (p(t) − W/2) — the position must compensate
 * around the pivot with that same emitted value. Setting the clip's
 * transform position to
 *   offset + fitScale * ((p0 − W/2) − s_emit * (p(t) − W/2))
 * (s_emit = the emitted scale-channel value = firstScale / sample.scale, 1
 * when not compensating) keeps the tracked subject at the position — and,
 * with applyScale, the size — it had when tracking started, i.e. it stays
 * framed as captured. With s_emit = 1 this degenerates to the pure
 * counter-shift offset − fitScale * (p(t) − p0). The GUI's offset sliders
 * choose where on screen the subject is kept.
 *
 * Times are folded from the tracking frame clock to the clip-local keyframe
 * clock (frame / frameRate / speed) and clamped to the clip duration. More
 * than {@link MAX_TRACKING_TRANSFORM_POINTS} path points are thinned with the
 * same first/last-preserving stride convention as the reframe card
 * (downsampleToCap in ai/auto-reframe-engine.ts).
 */

/** Path points kept before thinning; each yields up to 4 transform keyframes. */
export const MAX_TRACKING_TRANSFORM_POINTS = 100;

export interface TrackingPathSourceInfo {
  readonly width: number;
  readonly height: number;
}

export interface TrackingClipTiming {
  /** Clip duration in timeline seconds. */
  readonly duration: number;
  readonly speed?: number;
}

export interface TrackingKeyframesOptions {
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly source: TrackingPathSourceInfo;
  readonly clip: TrackingClipTiming;
  /** Compensate tracked size changes via scale.x/scale.y (default true). */
  readonly applyScale?: boolean;
  /** Output-space pixel offset where the subject is kept (default 0,0). */
  readonly offset?: Point;
  /** Thin the path to at most this many points (default 100, first/last kept). */
  readonly maxPoints?: number;
}

/**
 * Downsample to exactly `max` entries; the first and the last entry of the
 * input always survive. Same convention as the reframe card.
 */
function downsampleToCap<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const stride = (items.length - 1) / (max - 1);
  const out: T[] = [];
  for (let index = 0; index < max; index++) {
    out.push(items[Math.round(index * stride)]!);
  }
  out[max - 1] = items[items.length - 1]!;
  return out;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export interface TrackingPathInput {
  /** Chronological per-frame tracking samples (frame numbers, not seconds). */
  readonly keyframes: readonly TrackingKeyframe[];
  /** Frame clock of the tracking samples (frames → seconds). */
  readonly frameRate: number;
}

/**
 * Convert tracking path samples into position.x/y (+ scale.x/y) keyframes.
 * Returns [] when there is nothing to land (empty path, non-positive
 * duration or source/output geometry) so callers can skip the write instead
 * of applying an empty keyframe set; a non-positive frame rate instead falls
 * back to 30 (the tracking engine's ingest convention).
 */
export function trackingPathToKeyframes(
  path: TrackingPathInput,
  options: TrackingKeyframesOptions,
): Keyframe[] {
  const samples = path.keyframes.filter(
    (sample) =>
      Number.isFinite(sample.frame) &&
      Number.isFinite(sample.position.x) &&
      Number.isFinite(sample.position.y),
  );
  const frameRate =
    Number.isFinite(path.frameRate) && path.frameRate > 0 ? path.frameRate : 30;
  const { width: sourceWidth, height: sourceHeight } = options.source;
  const { duration } = options.clip;
  if (
    samples.length === 0 ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    !(duration > 0) ||
    !(options.outputWidth > 0) ||
    !(options.outputHeight > 0)
  ) {
    return [];
  }

  const speed =
    options.clip.speed !== undefined &&
    Number.isFinite(options.clip.speed) &&
    options.clip.speed > 0
      ? options.clip.speed
      : 1;

  // Default "contain" fit of the source inside the output canvas
  // (drawFrameToContext with the default center anchor).
  const sourceAspect = sourceWidth / sourceHeight;
  const canvasAspect = options.outputWidth / options.outputHeight;
  const fitWidth =
    sourceAspect > canvasAspect ? options.outputWidth : options.outputHeight * sourceAspect;
  const fitScale = fitWidth / sourceWidth;

  const offset = options.offset ?? { x: 0, y: 0 };
  const applyScale = options.applyScale ?? true;

  const thinned = downsampleToCap(
    samples,
    Math.max(1, Math.floor(options.maxPoints ?? MAX_TRACKING_TRANSFORM_POINTS)),
  );

  const first = thinned[0]!;
  const firstScale =
    applyScale && typeof first.scale === "number" && Number.isFinite(first.scale) && first.scale > 0
      ? first.scale
      : null;

  const keyframes: Keyframe[] = [];
  const sourceCenterX = sourceWidth / 2;
  const sourceCenterY = sourceHeight / 2;
  thinned.forEach((sample, index) => {
    const time = Math.min(
      duration,
      Math.max(0, sample.frame / frameRate / speed),
    );
    // The scale-channel value this sample emits (1 when not compensating);
    // the position pivot correction below must use the SAME value.
    const sampleScale =
      firstScale !== null &&
      typeof sample.scale === "number" &&
      Number.isFinite(sample.scale) &&
      sample.scale > 0
        ? firstScale / sample.scale
        : 1;
    const base = `track-${index}-`;
    keyframes.push(
      {
        id: `${base}position.x`,
        property: "position.x",
        time,
        value: round4(
          offset.x +
            fitScale *
              ((first.position.x - sourceCenterX) -
                sampleScale * (sample.position.x - sourceCenterX)),
        ),
        easing: "linear",
      },
      {
        id: `${base}position.y`,
        property: "position.y",
        time,
        value: round4(
          offset.y +
            fitScale *
              ((first.position.y - sourceCenterY) -
                sampleScale * (sample.position.y - sourceCenterY)),
        ),
        easing: "linear",
      },
    );
    if (firstScale !== null) {
      keyframes.push(
        {
          id: `${base}scale.x`,
          property: "scale.x",
          time,
          value: round4(sampleScale),
          easing: "linear",
        },
        {
          id: `${base}scale.y`,
          property: "scale.y",
          time,
          value: round4(sampleScale),
          easing: "linear",
        },
      );
    }
  });
  return keyframes;
}
