import { describe, it, expect } from "vitest";
import { ActionExecutor } from "../action-executor";
import type { Project } from "../../types/project";
import type { Action } from "../../types/actions";
import { SpeedEngine } from "../../video/speed-engine";
import { ProjectSerializer } from "../../storage/project-serializer";
import type { IStorageEngine } from "../../storage/types";
import type {
  ChromaKeySettings,
  SpeedKeyframe,
  FreezeFrame,
} from "../../types/timeline";

function makeProjectWithClip(overrides: Record<string, unknown> = {}): Project {
  const clip = {
    id: "c1",
    mediaId: "m1",
    trackId: "t1",
    startTime: 0,
    duration: 5,
    inPoint: 0,
    outPoint: 5,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      anchor: { x: 0.5, y: 0.5 },
      rotation: 0,
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
    ...overrides,
  };
  return {
    id: "p1",
    name: "Test",
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
      subtitles: [],
      markers: [],
      tracks: [
        {
          id: "t1",
          type: "video",
          name: "V1",
          clips: [clip],
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

function act(type: string, params: Record<string, unknown>): Action {
  return { type, id: `a-${type}`, timestamp: Date.now(), params };
}

function clipOf(project: Project) {
  return project.timeline.tracks[0].clips[0];
}

describe("clip fx handlers", () => {
  it("persists one complete speed configuration with derived duration across undo, redo and JSON reload", async () => {
    const executor = new ActionExecutor();
    const project = makeProjectWithClip({ inPoint: 4, outPoint: 9 });
    const prior = structuredClone(clipOf(project));
    const result = await executor.execute(act("speed/setRampData", {
      clipId: "c1", speed: 2, reversed: true, pitchCorrection: false,
      keyframes: [
        { id: "k1", time: 0, speed: 2, easing: "linear" },
        { id: "k2", time: 5, speed: 2, easing: "linear" },
      ],
      freezeFrames: [{ id: "f1", clipId: "c1", sourceTime: 3, startTime: 1, duration: 2 }],
    }), project);
    expect(result.success).toBe(true);
    const committed = structuredClone(clipOf(project));
    expect(committed).toMatchObject({ speed: 2, reversed: true, pitchCorrection: false });
    expect(committed.duration).toBeCloseTo(4.5);
    expect(project.timeline.duration).toBeCloseTo(4.5);
    await executor.undo(project);
    expect(clipOf(project)).toEqual(prior);
    expect(project.timeline.duration).toBe(5);
    await executor.redo(project);
    expect(clipOf(project)).toEqual(committed);
    const serializer = new ProjectSerializer({} as IStorageEngine);
    const reloaded = serializer.importFromJson(serializer.exportToJson(project));
    const engine = new SpeedEngine();
    engine.loadClips(reloaded.timeline.tracks.flatMap((track) => track.clips));
    expect(engine.getEffectiveDuration("c1")).toBeCloseTo(committed.duration);
    expect(engine.getSourceTimeAtPlaybackTime("c1", 0)).toBe(5);
    expect(engine.getSourceTimeAtPlaybackTime("c1", 2)).toBe(3);
    expect(engine.getSourceTimeAtPlaybackTime("c1", committed.duration)).toBe(0);
  });

  it("recalculates ramps/freezes for every writer without moving the following clip", async () => {
    const executor = new ActionExecutor();
    const project = makeProjectWithClip();
    const next = { ...clipOf(project), id: "c2", startTime: 5 };
    (project.timeline.tracks[0].clips as typeof next[]).push(next);
    await executor.execute(act("speed/setKeyframes", { clipId: "c1", keyframes: [{ id: "k1", time: 0, speed: 0.5, easing: "linear" }] }), project);
    expect(clipOf(project).duration).toBeCloseTo(10);
    await executor.execute(act("speed/setFreezeFrames", { clipId: "c1", freezeFrames: [{ id: "f", clipId: "c1", sourceTime: 1, startTime: 1, duration: 2 }] }), project);
    expect(clipOf(project).duration).toBeCloseTo(12);
    await executor.execute(act("clip/setSpeed", { clipId: "c1", speed: 4 }), project);
    expect(clipOf(project).duration).toBeCloseTo(12); // Curve takes precedence over base speed.
    expect(project.timeline.tracks[0].clips[1].startTime).toBe(5);
    expect(project.timeline.duration).toBeCloseTo(12);
  });

  it.each([
    ["clip/trim", { inPoint: 1 }],
    ["clip/split", { time: 2 }],
    ["clip/slip", { delta: 1 }],
    ["clip/trimToPlayhead", { playheadTime: 2, trimStart: true }],
    ["clip/roll", { leftClipId: "c1", rightClipId: "c2", delta: 1 }],
    ["clip/slide", { clipId: "c2", prevClipId: "c1", delta: 1 }],
  ])("keeps unsupported nonlinear source edits from corrupting canonical state: %s", async (type, params) => {
    const project = makeProjectWithClip({
      freezeFrames: [{ id: "f", clipId: "c1", sourceTime: 1, startTime: 1, duration: 1 }],
      duration: 6,
    });
    const before = structuredClone(project);
    const result = await new ActionExecutor().execute(act(type, { clipId: "c1", ...params }), project);
    expect(result.success).toBe(false);
    expect(project).toEqual(before);
  });

  it.each([
    [{ id: "f", clipId: "c1", sourceTime: 6, startTime: 0, duration: 1 }],
    [{ id: "f", clipId: "c1", sourceTime: 1, startTime: 6, duration: 1 }],
    [{ id: "f", clipId: "c1", sourceTime: 1, startTime: 0, duration: 0 }],
    [{ id: "f", clipId: "c1", sourceTime: 1, startTime: 0, duration: 2 }, { id: "g", clipId: "c1", sourceTime: 2, startTime: 1, duration: 1 }],
  ].map((freezeFrames) => ({ freezeFrames })))("rejects invalid freezes without committing state: %j", async ({ freezeFrames }) => {
    const project = makeProjectWithClip();
    const before = structuredClone(project);
    const result = await new ActionExecutor().execute(act("speed/setRampData", { clipId: "c1", freezeFrames }), project);
    expect(result.success).toBe(false);
    expect(project).toEqual(before);
  });
  it("clip/setSpeed sets speed and is undoable", async () => {
    const executor = new ActionExecutor();
    const project = makeProjectWithClip({ speed: 1 });

    const res = await executor.execute(act("clip/setSpeed", { clipId: "c1", speed: 2 }), project);
    expect(res.success).toBe(true);
    expect(clipOf(project).speed).toBe(2);

    await executor.undo(project);
    expect(clipOf(project).speed).toBe(1);
  });

  it("clip/setSpeed clamps out-of-range speed", async () => {
    const executor = new ActionExecutor();
    const project = makeProjectWithClip({ speed: 1 });
    await executor.execute(act("clip/setSpeed", { clipId: "c1", speed: 999 }), project);
    expect(clipOf(project).speed).toBeLessThanOrEqual(20);
  });

  it("clip/setSpeed rejects unknown clip", async () => {
    const executor = new ActionExecutor();
    const project = makeProjectWithClip();
    const res = await executor.execute(act("clip/setSpeed", { clipId: "nope", speed: 2 }), project);
    expect(res.success).toBe(false);
  });

  it("clip/setReverse toggles reversed and is undoable", async () => {
    const executor = new ActionExecutor();
    const project = makeProjectWithClip({ reversed: false });
    await executor.execute(act("clip/setReverse", { clipId: "c1", reversed: true }), project);
    expect(clipOf(project).reversed).toBe(true);
    await executor.undo(project);
    expect(clipOf(project).reversed).toBe(false);
  });

  it("clip/setStabilization sets and undoes", async () => {
    const executor = new ActionExecutor();
    const project = makeProjectWithClip();
    const stabilization = { enabled: true, strength: 0.5, cropMode: "auto" as const };
    await executor.execute(act("clip/setStabilization", { clipId: "c1", stabilization }), project);
    expect(clipOf(project).stabilization?.enabled).toBe(true);
    await executor.undo(project);
    expect(clipOf(project).stabilization).toBeUndefined();
  });

  it("clip/setChromaKey sets and undoes", async () => {
    const executor = new ActionExecutor();
    const project = makeProjectWithClip();
    const chromaKey: ChromaKeySettings = {
      enabled: true,
      keyColor: { r: 0, g: 1, b: 0 },
      tolerance: 0.3,
      edgeSoftness: 0.1,
      spillSuppression: 0.5,
    };
    await executor.execute(act("clip/setChromaKey", { clipId: "c1", chromaKey }), project);
    expect(clipOf(project).chromaKey?.enabled).toBe(true);
    await executor.undo(project);
    expect(clipOf(project).chromaKey).toBeUndefined();
  });

  it("speed/setKeyframes sets and undoes speed ramp", async () => {
    const executor = new ActionExecutor();
    const project = makeProjectWithClip();
    const keyframes: SpeedKeyframe[] = [
      { id: "k1", time: 0, speed: 1, easing: "linear" },
      { id: "k2", time: 2, speed: 2, easing: "linear" },
    ];
    await executor.execute(act("speed/setKeyframes", { clipId: "c1", keyframes }), project);
    expect(clipOf(project).speedKeyframes).toHaveLength(2);
    await executor.undo(project);
    expect(clipOf(project).speedKeyframes ?? []).toHaveLength(0);
  });

  it("speed/setFreezeFrames sets and undoes", async () => {
    const executor = new ActionExecutor();
    const project = makeProjectWithClip();
    const freezeFrames: FreezeFrame[] = [
      { id: "f1", clipId: "c1", sourceTime: 1, startTime: 1, duration: 0.5 },
    ];
    await executor.execute(act("speed/setFreezeFrames", { clipId: "c1", freezeFrames }), project);
    expect(clipOf(project).freezeFrames).toHaveLength(1);
    await executor.undo(project);
    expect(clipOf(project).freezeFrames ?? []).toHaveLength(0);
  });

  it("clip/setPitchCorrection sets and undoes", async () => {
    const executor = new ActionExecutor();
    const project = makeProjectWithClip();
    await executor.execute(act("clip/setPitchCorrection", { clipId: "c1", pitchCorrection: true }), project);
    expect(clipOf(project).pitchCorrection).toBe(true);
    await executor.undo(project);
    expect(clipOf(project).pitchCorrection ?? false).toBe(false);
  });
});
