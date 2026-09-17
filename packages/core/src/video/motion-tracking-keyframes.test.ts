/**
 * trackingPathToKeyframes — the shared conversion from a motion-tracking
 * result (per-frame tracked point/scale) to the transform keyframes the
 * renderer consumes through keyframe/setAll.
 *
 * Covered behavior:
 *  - exact counter-shift/scale math for the renderer's default contain-fit
 *    draw path ("keep framed": the tracked subject stays at the position and
 *    size it had when tracking started), including the scale-pivot
 *    correction around the canvas center when the subject size changes
 *    (drift < 1px through the renderer's own evaluation path),
 *  - time folding from the tracking frame clock onto the clip-local keyframe
 *    clock (divided by clip speed, clamped to the clip duration),
 *  - the ≤100-path-point cap with first/last samples preserved,
 *  - the red-line contract: after the produced keyframe/setAll action lands
 *    through the real core executor, evaluating the clip's keyframes the way
 *    video-engine's getAnimatedTransform does (property filter +
 *    KeyframeEngine.getValueAtTime) yields the compensating transform — and a
 *    single undo restores the prior keyframes.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_TRACKING_TRANSFORM_POINTS,
  trackingPathToKeyframes,
} from "./motion-tracking-keyframes";
import type { TrackingKeyframe } from "./motion-tracking-engine";
import { ActionExecutor } from "../actions/action-executor";
import { keyframeEngine } from "./keyframe-engine";
import type { Action, ActionResult } from "../types/actions";
import type { Project } from "../types/project";

const OUTPUT = { width: 1920, height: 1080 };
const SOURCE = { width: 1920, height: 1080 };

function sample(frame: number, x: number, y: number, scale = 1): TrackingKeyframe {
  return { frame, position: { x, y }, scale, rotation: 0 };
}

function keyframesByProperty(keyframes: ReturnType<typeof trackingPathToKeyframes>) {
  return new Map(keyframes.map((k) => [k.property, k]));
}

describe("trackingPathToKeyframes", () => {
  it("counter-shifts a panning subject so it keeps its initial framing", () => {
    // Subject pans +100 source px right over 1s at 30fps; 1:1 source→canvas
    // contain fit, so fitScale = 1.
    const keyframes = trackingPathToKeyframes(
      {
        keyframes: [sample(0, 960, 540), sample(15, 1010, 540), sample(30, 1060, 540)],
        frameRate: 30,
      },
      {
        outputWidth: OUTPUT.width,
        outputHeight: OUTPUT.height,
        source: SOURCE,
        clip: { duration: 1 },
      },
    );

    expect(keyframes).toHaveLength(12); // 3 points × (position.x + position.y + scale.x + scale.y)
    const byTimeX = keyframes
      .filter((k) => k.property === "position.x")
      .sort((a, b) => a.time - b.time);
    expect(byTimeX.map((k) => k.value)).toEqual([0, -50, -100]);
    const byTimeY = keyframes
      .filter((k) => k.property === "position.y")
      .sort((a, b) => a.time - b.time);
    expect(byTimeY.map((k) => k.value)).toEqual([0, 0, 0]);
    // First/last keyframe times land exactly on the folded frame clock.
    expect(byTimeX[0]!.time).toBe(0);
    expect(byTimeX[2]!.time).toBe(1);
  });

  it("keeps a growing subject at constant size when applyScale is on", () => {
    const keyframes = trackingPathToKeyframes(
      {
        keyframes: [sample(0, 500, 500, 1), sample(30, 500, 500, 1.25)],
        frameRate: 30,
      },
      {
        outputWidth: OUTPUT.width,
        outputHeight: OUTPUT.height,
        source: SOURCE,
        clip: { duration: 1 },
      },
    );
    const scalesByTime = keyframes
      .filter((k) => k.property === "scale.x")
      .sort((a, b) => a.time - b.time);
    expect(scalesByTime[0]!.value).toBe(1);
    // The clip zooms out by the subject's growth: 1 / 1.25.
    expect(scalesByTime[1]!.value).toBeCloseTo(0.8, 4);
    const scaleY = keyframes
      .filter((k) => k.property === "scale.y")
      .sort((a, b) => a.time - b.time)[1]!;
    expect(scaleY.value).toBeCloseTo(0.8, 4);
  });

  it("omits scale channels when applyScale is false", () => {
    const keyframes = trackingPathToKeyframes(
      {
        keyframes: [sample(0, 500, 500, 1), sample(30, 500, 500, 2)],
        frameRate: 30,
      },
      {
        outputWidth: OUTPUT.width,
        outputHeight: OUTPUT.height,
        source: SOURCE,
        clip: { duration: 1 },
        applyScale: false,
      },
    );
    expect(keyframes.length).toBeGreaterThan(0);
    expect(keyframes.some((k) => k.property.startsWith("scale."))).toBe(false);
  });

  it("folds frame time by fps and clip speed, clamped to the clip duration", () => {
    const keyframes = trackingPathToKeyframes(
      {
        // 60fps tracking clock, clip plays at 2× speed.
        keyframes: [sample(0, 0, 0), sample(60, 10, 0), sample(120, 20, 0), sample(240, 40, 0)],
        frameRate: 60,
      },
      {
        outputWidth: OUTPUT.width,
        outputHeight: OUTPUT.height,
        source: SOURCE,
        clip: { duration: 0.75, speed: 2 },
      },
    );
    const times = keyframes
      .filter((k) => k.property === "position.x")
      .map((k) => k.time);
    // frame/60/2: 0, 0.5, 1 → clamped 0.75, 2 → clamped 0.75.
    expect(times).toEqual([0, 0.5, 0.75, 0.75]);
  });

  it("applies the GUI offset where the subject is kept", () => {
    const keyframes = trackingPathToKeyframes(
      {
        keyframes: [sample(0, 960, 540), sample(30, 1060, 640)],
        frameRate: 30,
      },
      {
        outputWidth: OUTPUT.width,
        outputHeight: OUTPUT.height,
        source: SOURCE,
        clip: { duration: 1 },
        offset: { x: 50, y: -25 },
      },
    );
    const posX = keyframes
      .filter((k) => k.property === "position.x")
      .sort((a, b) => a.time - b.time);
    expect(posX[0]!.value).toBe(50); // kept at offset + first position
    const posY = keyframes
      .filter((k) => k.property === "position.y")
      .sort((a, b) => a.time - b.time);
    expect(posY[0]!.value).toBe(-25);
  });

  it("thins long paths to the 100-point cap and preserves first and last", () => {
    const path = Array.from({ length: 251 }, (_, frame) =>
      sample(frame, 960 + frame, 540),
    );
    const keyframes = trackingPathToKeyframes(
      { keyframes: path, frameRate: 30 },
      {
        outputWidth: OUTPUT.width,
        outputHeight: OUTPUT.height,
        source: SOURCE,
        clip: { duration: 251 / 30 },
      },
    );
    const posX = keyframes.filter((k) => k.property === "position.x");
    expect(posX).toHaveLength(MAX_TRACKING_TRANSFORM_POINTS);
    // 4 channels × 100 thinned points.
    expect(keyframes).toHaveLength(4 * MAX_TRACKING_TRANSFORM_POINTS);
    const sorted = [...posX].sort((a, b) => a.time - b.time);
    expect(sorted[0]!.value).toBe(0); // first sample survives exactly
    expect(sorted[sorted.length - 1]!.value).toBe(-250); // last sample survives exactly
    // Ids stay unique across channels and points.
    expect(new Set(keyframes.map((k) => k.id)).size).toBe(keyframes.length);
  });

  it("returns [] for empty paths or invalid geometry so callers skip the write", () => {
    const options = {
      outputWidth: OUTPUT.width,
      outputHeight: OUTPUT.height,
      source: SOURCE,
      clip: { duration: 1 },
    };
    expect(trackingPathToKeyframes({ keyframes: [], frameRate: 30 }, options)).toEqual([]);
    // frameRate <= 0 falls back to 30 (same convention as the tracking
    // engine's ingestTrackingData) instead of dividing by zero.
    expect(
      trackingPathToKeyframes({ keyframes: [sample(0, 1, 1)], frameRate: 0 }, options),
    ).toHaveLength(4);
    expect(
      trackingPathToKeyframes(
        { keyframes: [sample(0, 1, 1)], frameRate: 30 },
        { ...options, clip: { duration: 0 } },
      ),
    ).toEqual([]);
    expect(
      trackingPathToKeyframes(
        { keyframes: [sample(0, 1, 1)], frameRate: 30 },
        { ...options, source: { width: 0, height: 100 } },
      ),
    ).toEqual([]);
  });

  it("scales the counter-shift by the contain fit for non-matching aspects", () => {
    // 16:9 source in a 9:16 canvas: fitWidth = 1080, fitScale = 1080/1920 = 0.5625.
    const keyframes = trackingPathToKeyframes(
      { keyframes: [sample(0, 960, 540), sample(30, 1060, 540)], frameRate: 30 },
      {
        outputWidth: 1080,
        outputHeight: 1920,
        source: SOURCE,
        clip: { duration: 1 },
      },
    );
    const byProperty = keyframesByProperty(keyframes);
    expect(byProperty.get("position.x")!.value).toBeCloseTo(-56.25, 4);
  });

  it("pins an off-center, growing subject through the renderer's scale pivot (drift < 1px)", () => {
    // Reviewer reproduction: subject sits 511px right of the canvas center
    // (1471 vs 960), does not translate, and grows 1.25x. With the emitted
    // scale s=0.8 the renderer evaluates
    //   screen = canvasCenter + position + scale * fitScale * (p - W/2)
    // so the position must compensate around the canvas-center pivot:
    //   position(t=1) = 511 - 0.8 * 511 = 102.2
    // (the old pure counter-shift would leave a (1 - 1/1.25) * 511 = 102.2px
    // drift). 1:1 source/canvas fit keeps fitScale = 1.
    const keyframes = trackingPathToKeyframes(
      {
        keyframes: [sample(0, 1471, 540, 1), sample(30, 1471, 540, 1.25)],
        frameRate: 30,
      },
      {
        outputWidth: OUTPUT.width,
        outputHeight: OUTPUT.height,
        source: SOURCE,
        clip: { duration: 1 },
      },
    );

    const evaluateAt = (property: string, time: number): number => {
      const forProperty = keyframeEngine.getKeyframesForProperty(
        keyframes,
        property,
      );
      const result = keyframeEngine.getValueAtTime(forProperty, time);
      expect(typeof result.value).toBe("number");
      return result.value as number;
    };

    // The pivot-corrected position lands exactly on the reviewer's number.
    expect(evaluateAt("position.x", 1)).toBeCloseTo(102.2, 2);
    expect(evaluateAt("scale.x", 1)).toBeCloseTo(0.8, 4);

    // Walk the evaluation path (filter + getValueAtTime, exactly what
    // video-engine's getAnimatedTransform does) and reconstruct the tracked
    // point's on-screen position: it must stay pinned at 1471/540.
    for (const time of [0, 0.25, 0.5, 0.75, 1]) {
      const position = evaluateAt("position.x", time);
      const scale = evaluateAt("scale.x", time);
      const renderedX = 960 + position + scale * (1471 - 960);
      expect(renderedX).toBeCloseTo(1471, 2); // drift < 1px (round4 only)
      const positionY = evaluateAt("position.y", time);
      const scaleY = evaluateAt("scale.y", time);
      const renderedY = 540 + positionY + scaleY * (540 - 540);
      expect(renderedY).toBeCloseTo(540, 2);
    }
  });

  it("keeps the pure-translation mapping exact when the tracked size never changes", () => {
    // s_emit = 1 must reduce to the plain counter-shift, unchanged from the
    // pre-pivot-fix math.
    const keyframes = trackingPathToKeyframes(
      {
        keyframes: [sample(0, 1471, 540), sample(30, 1571, 540)],
        frameRate: 30,
      },
      {
        outputWidth: OUTPUT.width,
        outputHeight: OUTPUT.height,
        source: SOURCE,
        clip: { duration: 1 },
      },
    );
    const posX = keyframes
      .filter((k) => k.property === "position.x")
      .sort((a, b) => a.time - b.time);
    expect(posX.map((k) => k.value)).toEqual([0, -100]);
  });

  it("lands through keyframe/setAll and evaluates the way the renderer does; one undo restores", async () => {
    const project = makeProject();
    const executor = new ActionExecutor();
    const run = async (action: Action): Promise<ActionResult> =>
      executor.execute(action, project);

    const keyframes = trackingPathToKeyframes(
      {
        keyframes: [sample(0, 960, 540), sample(30, 1060, 540)],
        frameRate: 30,
      },
      {
        outputWidth: OUTPUT.width,
        outputHeight: OUTPUT.height,
        source: SOURCE,
        clip: { duration: 1 },
      },
    );

    expect(
      (await run(act("keyframe/setAll", { clipId: "c1", keyframes }))).success,
    ).toBe(true);

    // Evaluate exactly like video-engine's getAnimatedTransform: filter by
    // property, then KeyframeEngine.getValueAtTime.
    const evaluateAt = (property: string, time: number): number | undefined => {
      const clip = project.timeline.tracks[0]!.clips[0]!;
      const forProperty = keyframeEngine.getKeyframesForProperty(
        clip.keyframes,
        property,
      );
      if (forProperty.length === 0) {
        return 0; // base position the renderer falls back to
      }
      const result = keyframeEngine.getValueAtTime(forProperty, time);
      return typeof result.value === "number" ? result.value : undefined;
    };

    expect(evaluateAt("position.x", 0)).toBeCloseTo(0, 4);
    expect(evaluateAt("position.x", 1)).toBeCloseTo(-100, 4);
    expect(evaluateAt("position.x", 0.5)).toBeCloseTo(-50, 4);
    expect(evaluateAt("position.y", 1)).toBeCloseTo(0, 4);

    expect((await executor.undo(project)).success).toBe(true);
    expect(project.timeline.tracks[0]!.clips[0]!.keyframes).toHaveLength(0);
  });
});

function act(type: string, params: Record<string, unknown>): Action {
  return {
    type,
    id: `a-${type}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    params,
  };
}

function makeProject(): Project {
  return {
    timeline: {
      tracks: [
        {
          id: "track-1",
          type: "video",
          name: "V1",
          clips: [
            {
              id: "c1",
              mediaId: "m1",
              trackId: "track-1",
              startTime: 0,
              duration: 1,
              inPoint: 0,
              outPoint: 1,
              effects: [],
              audioEffects: [],
              transform: {
                position: { x: 0, y: 0 },
                scale: { x: 1, y: 1 },
                rotation: 0,
                anchor: { x: 0.5, y: 0.5 },
                opacity: 1,
              },
              volume: 1,
              keyframes: [],
            },
          ],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
    },
  } as unknown as Project;
}
