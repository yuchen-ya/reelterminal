import { describe, expect, it } from "vitest";
import {
  ActionExecutor,
  type AutoEditCut,
  type Clip,
  type Project,
} from "@openreel/core";
import { buildAutoEditActions } from "./AutoEditPanel";

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

function makeProject(clips: Clip[]): Project {
  return {
    timeline: {
      tracks: [
        {
          id: "track-video-1",
          type: "video",
          name: "V1",
          clips,
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
      duration: clips.reduce(
        (max, clip) => Math.max(max, clip.startTime + clip.duration),
        0,
      ),
      subtitles: [],
    },
    mediaLibrary: {
      items: [
        { id: "m1", name: "a.mp4", type: "video", metadata: { duration: 30 } },
        { id: "m2", name: "b.mp4", type: "video", metadata: { duration: 30 } },
      ],
    },
  } as unknown as Project;
}

describe("buildAutoEditActions", () => {
  const targetTrackClips = () => [
    makeClip({ id: "clip-a" }),
    makeClip({ id: "clip-b", mediaId: "m2", startTime: 10, duration: 8, outPoint: 8 }),
    makeClip({ id: "clip-c", startTime: 18, duration: 5, outPoint: 5 }),
  ];

  const plan: AutoEditCut[] = [
    { sourceClipId: "clip-a", inPoint: 2, outPoint: 4.5, startTime: 0, duration: 2.5 },
    { sourceClipId: "clip-a", inPoint: 5, outPoint: 6.5, startTime: 2.5, duration: 1.5 },
    { sourceClipId: "clip-b", inPoint: 1, outPoint: 4, startTime: 4, duration: 3 },
  ];

  it("expands the plan into remove, trim/move, and copy actions", () => {
    const actions = buildAutoEditActions(plan, {
      id: "track-video-1",
      clips: targetTrackClips(),
    });

    expect(actions.map((action) => action.type)).toEqual([
      "clip/remove",
      "clip/trim",
      "clip/move",
      "clip/add",
      "clip/trim",
      "clip/move",
    ]);

    expect(actions[0]!.params).toMatchObject({ clipId: "clip-c" });
    expect(actions[1]!.params).toMatchObject({
      clipId: "clip-a",
      inPoint: 2,
      outPoint: 4.5,
    });
    expect(actions[2]!.params).toMatchObject({
      clipId: "clip-a",
      startTime: 0,
      trackId: "track-video-1",
    });

    const copyParams = actions[3]!.params as {
      clipId: string;
      startTime: number;
      trackId: string;
      mediaId: string;
      sourceClip: Clip;
    };
    expect(copyParams.clipId).toMatch(/^auto-edit-/);
    expect(copyParams.startTime).toBe(2.5);
    expect(copyParams.trackId).toBe("track-video-1");
    expect(copyParams.mediaId).toBe("m1");
    expect(copyParams.sourceClip).toMatchObject({
      duration: 1.5,
      inPoint: 5,
      outPoint: 6.5,
    });

    expect(actions[4]!.params).toMatchObject({
      clipId: "clip-b",
      inPoint: 1,
      outPoint: 4,
    });
    expect(actions[5]!.params).toMatchObject({
      clipId: "clip-b",
      startTime: 4,
    });
  });

  it("rebuilds speed-adjusted clips as copies so plan durations survive", () => {
    const speedClip = makeClip({ id: "clip-s", speed: 2 });
    const speedPlan: AutoEditCut[] = [
      { sourceClipId: "clip-s", inPoint: 0, outPoint: 2, startTime: 0, duration: 2 },
      { sourceClipId: "clip-s", inPoint: 2, outPoint: 4, startTime: 2, duration: 2 },
    ];

    const actions = buildAutoEditActions(speedPlan, {
      id: "track-video-1",
      clips: [speedClip],
    });

    expect(actions.map((action) => action.type)).toEqual([
      "clip/add",
      "clip/remove",
      "clip/add",
    ]);
    expect(actions[0]!.params).toMatchObject({
      clipId: expect.stringMatching(/^auto-edit-/),
      startTime: 0,
    });
    expect((actions[0]!.params as { sourceClip: Clip }).sourceClip).toMatchObject({
      duration: 2,
      speed: 2,
    });
    expect(actions[1]!.params).toMatchObject({ clipId: "clip-s" });
  });

  it("skips cuts whose source clip no longer exists", () => {
    const actions = buildAutoEditActions(
      [{ sourceClipId: "ghost", inPoint: 0, outPoint: 1, startTime: 0, duration: 1 }],
      { id: "track-video-1", clips: [makeClip({ id: "clip-a" })] },
    );

    expect(actions.map((action) => action.type)).toEqual(["clip/remove"]);
    expect(actions[0]!.params).toMatchObject({ clipId: "clip-a" });
  });

  it("applies against a real project, matches the plan layout, and fully reverts", async () => {
    const clips = targetTrackClips();
    const project = makeProject(clips);
    const originalClips = JSON.parse(JSON.stringify(project.timeline.tracks[0]!.clips));

    const actions = buildAutoEditActions(plan, {
      id: "track-video-1",
      clips,
    });

    const executor = new ActionExecutor();
    for (const action of actions) {
      const result = executor.executeSync(action, project);
      expect(result.success).toBe(true);
    }

    const track = project.timeline.tracks[0]!;
    const byId = new Map(track.clips.map((clip) => [clip.id, clip]));
    expect(track.clips).toHaveLength(3);
    expect(byId.get("clip-a")).toMatchObject({
      startTime: 0,
      duration: 2.5,
      inPoint: 2,
      outPoint: 4.5,
    });
    const copy = track.clips.find((clip) => clip.id.startsWith("auto-edit-"));
    expect(copy).toMatchObject({
      startTime: 2.5,
      duration: 1.5,
      inPoint: 5,
      outPoint: 6.5,
      mediaId: "m1",
    });
    expect(byId.get("clip-b")).toMatchObject({
      startTime: 4,
      duration: 3,
      inPoint: 1,
      outPoint: 4,
    });
    expect(byId.has("clip-c")).toBe(false);
    expect(project.timeline.duration).toBeCloseTo(7);

    let undoCount = 0;
    while ((await executor.undo(project)).success) undoCount += 1;
    expect(undoCount).toBeGreaterThan(0);

    const restored = [...project.timeline.tracks[0]!.clips].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const expected = [...(originalClips as Clip[])].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    expect(restored).toEqual(expected);
    expect(project.timeline.duration).toBeCloseTo(23);
  });
});
