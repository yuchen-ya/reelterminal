/**
 * reframeKeyframesToTransformKeyframes — the shared conversion from Auto
 * Reframe analysis output (source-space crop rectangles) to the transform
 * keyframes the renderer consumes through keyframe/setAll.
 *
 * Covered behavior:
 *  - exact scale/position math for the engine's contain-fit draw path
 *    (16:9 source → 9:16 output), center and off-center crops,
 *  - time folding from the source-analysis clock onto the clip-local
 *    keyframe clock (divided by clip speed, clamped to the clip duration),
 *  - the ≤100-keyframe cap with first/last analysis points preserved,
 *  - the red-line contract: after the produced actions land through the real
 *    core executor (project/updateSettings + keyframe/setAll), evaluating
 *    the clip's keyframes the way video-engine's getAnimatedTransform does
 *    (property filter + KeyframeEngine.getValueAtTime) yields the reframed
 *    scale/position — and a single undo restores both prior fields.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_REFRAME_TRANSFORM_KEYFRAMES,
  reframeKeyframesToTransformKeyframes,
  type ReframeKeyframe,
} from "./auto-reframe-engine";
import { ActionExecutor } from "../actions/action-executor";
import { keyframeEngine } from "../video/keyframe-engine";
import type { Action, ActionResult } from "../types/actions";
import type { Project } from "../types/project";

const SOURCE = { width: 1920, height: 1080 };
const OUTPUT = { width: 1080, height: 1920 };

function crop(partial: Partial<ReframeKeyframe>): ReframeKeyframe {
  return {
    time: 0,
    cropX: 656.25,
    cropY: 0,
    cropWidth: 607.5,
    cropHeight: 1080,
    scale: 1,
    ...partial,
  };
}

describe("reframeKeyframesToTransformKeyframes", () => {
  it("maps a centered 16:9→9:16 crop to zero position and the exact contain-fit zoom", () => {
    const keyframes = reframeKeyframesToTransformKeyframes(
      {
        keyframes: [crop({})],
        outputWidth: OUTPUT.width,
        outputHeight: OUTPUT.height,
        success: true,
      },
      SOURCE,
      { duration: 5 },
    );

    expect(keyframes).toHaveLength(4);
    const byProperty = new Map(keyframes.map((k) => [k.property, k]));
    // fitWidth=1080, fitScale=1080/1920=0.5625 → scale=(1080/607.5)/0.5625.
    expect(byProperty.get("scale.x")!.value).toBeCloseTo(3.1605, 4);
    expect(byProperty.get("scale.y")!.value).toBeCloseTo(3.1605, 4);
    // Crop centered on the source center: no shift.
    expect(byProperty.get("position.x")!.value).toBe(0);
    expect(byProperty.get("position.y")!.value).toBe(0);
    expect(byProperty.get("position.x")!.time).toBe(0);
  });

  it("shifts position so the crop window exactly covers the output canvas", () => {
    const cropRight = crop({ cropX: 1920 - 607.5 });
    const keyframes = reframeKeyframesToTransformKeyframes(
      {
        keyframes: [cropRight],
        outputWidth: OUTPUT.width,
        outputHeight: OUTPUT.height,
        success: true,
      },
      SOURCE,
      { duration: 5 },
    );
    const byProperty = new Map(keyframes.map((k) => [k.property, k]));
    const scale = byProperty.get("scale.x")!.value;
    const positionX = byProperty.get("position.x")!.value;
    expect(positionX).toBeCloseTo(-1166.6667, 4);

    // Replay the renderer's draw math: canvas coord of the crop's left edge
    // must be 0 (and the right edge the canvas width). The emitted values are
    // rounded to 4 decimals, so allow the amplified sub-pixel residual.
    const fitWidth = 1080;
    const fitScaleX = fitWidth / SOURCE.width;
    const canvasCenter = OUTPUT.width / 2;
    const cropLeft =
      canvasCenter + positionX + scale * (fitScaleX * (1920 - 607.5) - fitWidth / 2);
    const cropRightEdge =
      canvasCenter + positionX + scale * (fitScaleX * 1920 - fitWidth / 2);
    expect(cropLeft).toBeCloseTo(0, 1);
    expect(cropRightEdge).toBeCloseTo(OUTPUT.width, 1);
  });

  it("folds analysis times onto the clip-local clock by speed and clamps to duration", () => {
    const result = {
      keyframes: [
        crop({ time: 1 }),
        crop({ time: 2, cropX: 0 }),
        crop({ time: 20, cropX: 100 }),
      ],
      outputWidth: OUTPUT.width,
      outputHeight: OUTPUT.height,
      success: true,
    };

    const atSpeed2 = reframeKeyframesToTransformKeyframes(
      result,
      SOURCE,
      { duration: 5, speed: 2 },
    );
    expect(
      atSpeed2.filter((k) => k.property === "position.x").map((k) => k.time),
    ).toEqual([0.5, 1, 5]);

    const atHalfSpeed = reframeKeyframesToTransformKeyframes(
      result,
      SOURCE,
      { duration: 5, speed: 0.5 },
    );
    // time 20/0.5=40 clamps to the 5s clip duration.
    expect(atHalfSpeed.filter((k) => k.property === "position.x").map((k) => k.time)).toEqual([
      2, 4, 5,
    ]);
  });

  it("caps the emitted keyframes at 100 with first and last crops preserved", () => {
    const many: ReframeKeyframe[] = Array.from({ length: 801 }, (_, i) =>
      crop({ time: i * 0.1, cropX: (i % 2) * 100 }),
    );
    const keyframes = reframeKeyframesToTransformKeyframes(
      {
        keyframes: many,
        outputWidth: OUTPUT.width,
        outputHeight: OUTPUT.height,
        success: true,
      },
      SOURCE,
      { duration: 100 },
    );
    expect(keyframes.length).toBe(MAX_REFRAME_TRANSFORM_KEYFRAMES);
    const times = keyframes
      .filter((k) => k.property === "position.x")
      .map((k) => k.time);
    expect(times[0]).toBe(0);
    expect(times[times.length - 1]).toBeCloseTo(80, 5);
  });

  it("returns nothing for an empty or degenerate result", () => {
    expect(
      reframeKeyframesToTransformKeyframes(
        { keyframes: [], outputWidth: 1080, outputHeight: 1920, success: true },
        SOURCE,
        { duration: 5 },
      ),
    ).toEqual([]);
    expect(
      reframeKeyframesToTransformKeyframes(
        { keyframes: [crop({ cropWidth: 0 })], outputWidth: 0, outputHeight: 0, success: true },
        SOURCE,
        { duration: 5 },
      ),
    ).toEqual([]);
  });
});

describe("reframe keyframes land and evaluate through the real action chain", () => {
  const BASE_TRANSFORM = {
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    anchor: { x: 0.5, y: 0.5 },
    opacity: 1,
  };

  function makeProject(): Project {
    return {
      id: "p1",
      name: "Reframe",
      createdAt: 0,
      modifiedAt: 0,
      settings: {
        width: 1920,
        height: 1080,
        frameRate: 30,
        sampleRate: 48000,
        channels: 2,
      },
      timeline: {
        duration: 5,
        markers: [],
        subtitles: [],
        tracks: [
          {
            id: "t1",
            type: "video",
            name: "V1",
            clips: [
              {
                id: "c1",
                mediaId: "m1",
                trackId: "t1",
                startTime: 0,
                duration: 5,
                inPoint: 0,
                outPoint: 5,
                effects: [],
                audioEffects: [],
                transform: BASE_TRANSFORM,
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
      mediaLibrary: { items: [] },
    } as unknown as Project;
  }

  const act = (type: string, params: Record<string, unknown>): Action => ({
    type,
    id: `a-${type}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    params,
  });

  /**
   * Evaluates a clip's transform keyframes exactly the way the renderer's
   * getAnimatedTransform does (video-engine.ts): filter by property, then
   * KeyframeEngine.getValueAtTime.
   */
  function evaluateAt(
    project: Project,
    property: string,
    time: number,
  ): number | undefined {
    const clip = project.timeline.tracks[0]!.clips[0]!;
    const forProperty = keyframeEngine.getKeyframesForProperty(
      clip.keyframes,
      property,
    );
    if (forProperty.length === 0) {
      return clip.transform.scale.x; // base value the renderer falls back to
    }
    const result = keyframeEngine.getValueAtTime(forProperty, time);
    return typeof result.value === "number" ? result.value : undefined;
  }

  it("setAll changes the evaluated transform and one undo restores everything", async () => {
    const project = makeProject();
    const executor = new ActionExecutor();
    const run = async (action: Action): Promise<ActionResult> =>
      executor.execute(action, project);

    const keyframes = reframeKeyframesToTransformKeyframes(
      {
        keyframes: [crop({ time: 0 }), crop({ time: 4, cropX: 1920 - 607.5 })],
        outputWidth: OUTPUT.width,
        outputHeight: OUTPUT.height,
        success: true,
      },
      SOURCE,
      { duration: 5 },
    );

    expect((await run(act("project/updateSettings", { width: 1080, height: 1920 }))).success).toBe(
      true,
    );
    expect(
      (await run(act("keyframe/setAll", { clipId: "c1", keyframes }))).success,
    ).toBe(true);

    expect(project.settings.width).toBe(1080);
    expect(project.settings.height).toBe(1920);

    // The evaluated transform now follows the analysis: zoomed-in and panning
    // from the center crop to the right-hand crop.
    const scaleAtStart = evaluateAt(project, "scale.x", 0)!;
    expect(scaleAtStart).toBeCloseTo(3.1605, 4);
    const positionXAtStart = evaluateAt(project, "position.x", 0)!;
    const positionXAtEnd = evaluateAt(project, "position.x", 4)!;
    expect(positionXAtStart).toBeCloseTo(0, 4);
    expect(positionXAtEnd).toBeCloseTo(-1166.6667, 3);
    expect(positionXAtEnd).not.toBeCloseTo(positionXAtStart, 3);

    // One undo step restores the keyframes; the next restores the settings.
    expect((await executor.undo(project)).success).toBe(true);
    expect(project.timeline.tracks[0]!.clips[0]!.keyframes).toHaveLength(0);
    expect(evaluateAt(project, "scale.x", 0)).toBe(1);
    expect((await executor.undo(project)).success).toBe(true);
    expect(project.settings.width).toBe(1920);
    expect(project.settings.height).toBe(1080);
  });
});
