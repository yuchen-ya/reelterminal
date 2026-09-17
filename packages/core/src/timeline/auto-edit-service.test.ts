import { describe, it, expect } from "vitest";
import { expandCutPlanToActions, type AutoEditCut } from "./auto-edit-service";
import type { Clip } from "../types/timeline";

const TRANSFORM = {
  position: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  rotation: 0,
  anchor: { x: 0.5, y: 0.5 },
  opacity: 1,
  fitMode: "contain" as const,
};

function makeClip(overrides: Partial<Clip> & { id: string }): Clip {
  return {
    mediaId: "m1",
    trackId: "track-video-1",
    startTime: 0,
    duration: 10,
    inPoint: 0,
    outPoint: 10,
    effects: [],
    audioEffects: [],
    transform: TRANSFORM,
    volume: 1,
    keyframes: [],
    ...overrides,
  } as Clip;
}

const plan: AutoEditCut[] = [
  { sourceClipId: "clip-a", inPoint: 2, outPoint: 4.5, startTime: 0, duration: 2.5 },
  { sourceClipId: "clip-a", inPoint: 5, outPoint: 6.5, startTime: 2.5, duration: 1.5 },
  { sourceClipId: "clip-b", inPoint: 1, outPoint: 4, startTime: 4, duration: 3 },
];

describe("expandCutPlanToActions", () => {
  it("expands a plan into remove, trim/move, and copy actions", () => {
    const actions = expandCutPlanToActions(plan, {
      id: "track-video-1",
      clips: [
        makeClip({ id: "clip-a" }),
        makeClip({ id: "clip-b", mediaId: "m2", startTime: 10, duration: 8, outPoint: 8 }),
        makeClip({ id: "clip-c", startTime: 18, duration: 5, outPoint: 5 }),
      ],
    });

    expect(actions.map((action) => action.type)).toEqual([
      "clip/remove",
      "clip/trim",
      "clip/move",
      "clip/add",
      "clip/trim",
      "clip/move",
    ]);
    // Actions carry the identity fields core actions require.
    actions.forEach((action) => {
      expect(action.id).toBeTruthy();
      expect(action.timestamp).toBeGreaterThan(0);
    });
    expect(actions[0]!.params).toMatchObject({ clipId: "clip-c" });
    expect(actions[1]!.params).toMatchObject({ clipId: "clip-a", inPoint: 2, outPoint: 4.5 });
    expect(actions[2]!.params).toMatchObject({ clipId: "clip-a", startTime: 0, trackId: "track-video-1" });
    expect(actions[3]!.params).toMatchObject({
      clipId: expect.stringMatching(/^auto-edit-/),
      startTime: 2.5,
      trackId: "track-video-1",
      mediaId: "m1",
    });
  });

  it("routes speed-adjusted sources through copies so plan durations survive", () => {
    const actions = expandCutPlanToActions(
      [
        { sourceClipId: "clip-s", inPoint: 0, outPoint: 2, startTime: 0, duration: 2 },
        { sourceClipId: "clip-s", inPoint: 2, outPoint: 4, startTime: 2, duration: 2 },
      ],
      { id: "track-video-1", clips: [makeClip({ id: "clip-s", speed: 2 })] },
    );
    expect(actions.map((action) => action.type)).toEqual(["clip/add", "clip/remove", "clip/add"]);
    expect((actions[0]!.params as { sourceClip: Clip }).sourceClip).toMatchObject({ duration: 2, speed: 2 });
    expect(actions[1]!.params).toMatchObject({ clipId: "clip-s" });
  });

  it("skips cuts whose source clip no longer exists", () => {
    const actions = expandCutPlanToActions(
      [{ sourceClipId: "ghost", inPoint: 0, outPoint: 1, startTime: 0, duration: 1 }],
      { id: "track-video-1", clips: [makeClip({ id: "clip-a" })] },
    );
    expect(actions.map((action) => action.type)).toEqual(["clip/remove"]);
    expect(actions[0]!.params).toMatchObject({ clipId: "clip-a" });
  });
});
