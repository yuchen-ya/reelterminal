import { describe, it, expect } from "vitest";
import { ActionExecutor } from "../action-executor";
import type { Project } from "../../types/project";
import type { Action } from "../../types/actions";
import type { AutomationPoint } from "../../types/timeline";
import type { VolumeKeyframe } from "../../audio/volume-automation";
import { generateDuckingKeyframesFromRanges, VolumeAutomation } from "../../audio/volume-automation";

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
  return { type, id: `a-${type}-${Math.random()}`, timestamp: Date.now(), params };
}

function clipOf(project: Project) {
  return project.timeline.tracks[0]!.clips[0]!;
}

const SETTINGS = {
  enabled: true,
  sourceTrackId: "t2",
  threshold: -30,
  reduction: 0.7,
  attack: 0.1,
  release: 0.3,
  holdTime: 0.2,
};

const POINTS: AutomationPoint[] = [
  { time: 0, value: 1 },
  { time: 1, value: 0.3 },
  { time: 2, value: 1 },
];

describe("audio ducking handlers", () => {
  it("audio/setDucking writes automation.volume and metadata.audioDucking and undoes both fields", async () => {
    const executor = new ActionExecutor();
    const project = makeProjectWithClip();

    const res = await executor.execute(
      act("audio/setDucking", { clipId: "c1", settings: SETTINGS, points: POINTS }),
      project,
    );
    expect(res.success).toBe(true);
    expect(clipOf(project).automation?.volume).toEqual(POINTS);
    expect(clipOf(project).metadata?.audioDucking).toEqual(SETTINGS);

    // Undo restores BOTH fields (the pre-action clip had neither).
    await executor.undo(project);
    expect(clipOf(project).automation).toBeUndefined();
    expect(clipOf(project).metadata?.audioDucking).toBeUndefined();

    // Redo re-applies both.
    await executor.redo(project);
    expect(clipOf(project).automation?.volume).toEqual(POINTS);
    expect(clipOf(project).metadata?.audioDucking).toEqual(SETTINGS);
  });

  it("audio/setDucking undo restores prior ducking bit-for-bit", async () => {
    const executor = new ActionExecutor();
    const priorPoints: VolumeKeyframe[] = [
      { time: 0.5, value: 0.8, curve: "s-curve" },
      { time: 3, value: 0.8 },
    ];
    const priorSettings = { ...SETTINGS, sourceTrackId: null, threshold: -40 };
    const project = makeProjectWithClip({
      automation: { volume: priorPoints },
      metadata: { audioDucking: priorSettings },
    });

    await executor.execute(
      act("audio/setDucking", { clipId: "c1", settings: SETTINGS, points: POINTS }),
      project,
    );
    expect(clipOf(project).automation?.volume).toEqual(POINTS);

    await executor.undo(project);
    expect(clipOf(project).automation?.volume).toEqual(priorPoints);
    expect(clipOf(project).metadata?.audioDucking).toEqual(priorSettings);
  });

  it("audio/setDucking undo restores prior volume automation that came from audio/addAutomation", async () => {
    const executor = new ActionExecutor();
    const project = makeProjectWithClip();
    const manualPoints: AutomationPoint[] = [{ time: 0, value: 0.5 }, { time: 4, value: 1.5 }];

    await executor.execute(
      act("audio/addAutomation", { clipId: "c1", points: manualPoints }),
      project,
    );
    await executor.execute(
      act("audio/setDucking", { clipId: "c1", settings: SETTINGS, points: POINTS }),
      project,
    );
    expect(clipOf(project).automation?.volume).toEqual(POINTS);

    await executor.undo(project);
    expect(clipOf(project).automation?.volume).toEqual(manualPoints);
    expect(clipOf(project).metadata?.audioDucking).toBeUndefined();
  });

  it("audio/clearDucking removes both fields and undo restores them", async () => {
    const executor = new ActionExecutor();
    const project = makeProjectWithClip({
      automation: { volume: POINTS, pan: [{ time: 0, value: 0 }] },
      metadata: { audioDucking: SETTINGS, templateSource: "manual" },
    });

    const res = await executor.execute(
      act("audio/clearDucking", { clipId: "c1" }),
      project,
    );
    expect(res.success).toBe(true);
    expect(clipOf(project).automation?.volume).toBeUndefined();
    expect(clipOf(project).metadata?.audioDucking).toBeUndefined();
    // Unrelated siblings survive.
    expect(clipOf(project).automation?.pan).toEqual([{ time: 0, value: 0 }]);
    expect(clipOf(project).metadata?.templateSource).toBe("manual");

    await executor.undo(project);
    expect(clipOf(project).automation?.volume).toEqual(POINTS);
    expect(clipOf(project).metadata?.audioDucking).toEqual(SETTINGS);
  });

  it("audio/clearDucking on a clip without ducking is a successful no-op", async () => {
    const executor = new ActionExecutor();
    const project = makeProjectWithClip();
    const res = await executor.execute(
      act("audio/clearDucking", { clipId: "c1" }),
      project,
    );
    expect(res.success).toBe(true);
    // Nothing changed, so there is no inverse to replay.
    const undone = await executor.undo(project);
    expect(undone.success).toBe(false);
  });

  it("audio/setDucking rejects unknown clips, malformed snapshots and out-of-range points", async () => {
    const executor = new ActionExecutor();
    const project = makeProjectWithClip();

    expect(
      (
        await executor.execute(
          act("audio/setDucking", { clipId: "nope", settings: SETTINGS, points: POINTS }),
          project,
        )
      ).success,
    ).toBe(false);

    expect(
      (
        await executor.execute(
          act("audio/setDucking", {
            clipId: "c1",
            settings: { ...SETTINGS, threshold: "low" },
            points: POINTS,
          }),
          project,
        )
      ).success,
    ).toBe(false);

    expect(
      (
        await executor.execute(
          act("audio/setDucking", {
            clipId: "c1",
            settings: SETTINGS,
            points: [{ time: 0, value: 99 }],
          }),
          project,
        )
      ).success,
    ).toBe(false);

    expect(
      (
        await executor.execute(
          act("audio/setDucking", { clipId: "c1", settings: null, points: [] }),
          project,
        )
      ).success,
    ).toBe(false);

    // Nothing was written by the failed attempts.
    expect(clipOf(project).automation).toBeUndefined();
    expect(clipOf(project).metadata?.audioDucking).toBeUndefined();
  });

  it("generateDuckingKeyframesFromRanges matches the AudioDucker envelope contract", () => {
    // Same kernel AudioDucker.generateDuckingKeyframes delegates to; shape is
    // 4 keyframes per merged presence range (normal→duck→hold→release).
    const keyframes = generateDuckingKeyframesFromRanges(
      [{ start: 1, end: 2 }],
      { threshold: -30, reduction: 0.7, attack: 0.1, release: 0.3, holdTime: 0.2 },
      1,
    );
    expect(keyframes).toHaveLength(4);
    expect(keyframes[0]!.time).toBeCloseTo(0.9, 5);
    expect(keyframes[0]!.value).toBeCloseTo(1, 5);
    expect(keyframes[1]!.time).toBeCloseTo(1, 5);
    expect(keyframes[1]!.value).toBeCloseTo(0.3, 5);
    expect(keyframes[2]!.time).toBeCloseTo(2, 5);
    expect(keyframes[2]!.value).toBeCloseTo(0.3, 5);
    expect(keyframes[3]!.time).toBeCloseTo(2.3, 5);
    expect(keyframes[3]!.value).toBeCloseTo(1, 5);

    // Ranges within holdTime merge into one duck window.
    const merged = generateDuckingKeyframesFromRanges(
      [
        { start: 1, end: 1.5 },
        { start: 1.6, end: 2 },
      ],
      { threshold: -30, reduction: 0.5, attack: 0.1, release: 0.2, holdTime: 0.2 },
      1,
    );
    expect(merged).toHaveLength(4);
    expect(merged[0]!.time).toBeCloseTo(0.9, 5);
    expect(merged[3]!.time).toBeCloseTo(2.2, 5);

    // Empty presence produces no keyframes (GUI surfaces this as an error).
    expect(
      generateDuckingKeyframesFromRanges(
        [],
        { threshold: -30, reduction: 0.5, attack: 0.1, release: 0.2, holdTime: 0.2 },
        1,
      ),
    ).toEqual([]);
  });

  it("generateDuckingKeyframesFromRanges synthesizes tailEnvelope swell and tail fade-out", () => {
    const automation = new VolumeAutomation();
    const keyframes = generateDuckingKeyframesFromRanges(
      [{ start: 1, end: 3 }],
      { threshold: -30, reduction: 0.6, attack: 0.1, release: 0.25, holdTime: 0.2 },
      0.8,
      {
        startAfterLastPresenceSec: 0.4,
        swellRampSec: 1.0,
        swellGainRatio: 1.25,
        fadeOutDurationSec: 1.5,
        clipDurationSec: 8,
      },
    );

    // Sample the public evaluator: duck, recover, wait, swell, hold and fade.
    // Quarter-ramp samples distinguish an S curve from a linear ramp.
    for (const [time, volume] of [
      [2, 0.32], [3.125, 0.56], [3.3, 0.8], [3.4, 0.8],
      [3.65, 0.83125], [3.9, 0.9], [4.4, 1], [6.5, 1],
      [6.875, 0.84375], [7.25, 0.5], [8, 0],
    ]) {
      expect(automation.getVolumeAtTime(time!, keyframes)).toBeCloseTo(volume!, 5);
    }

    // When clipDurationSec <= swellPeak, fade-out is omitted and swell stands
    // (release point and swell-start point at 3.2 coalesce via deduplication).
    const noFade = generateDuckingKeyframesFromRanges(
      [{ start: 1, end: 3 }],
      { threshold: -30, reduction: 0.5, attack: 0.1, release: 0.2, holdTime: 0.2 },
      0.5,
      {
        swellRampSec: 1.0,
        swellGainRatio: 1.5,
        fadeOutDurationSec: 1.0,
        clipDurationSec: 4.0,
      },
    );
    expect(noFade).toHaveLength(5);
    expect(noFade[4]!.value).toBeCloseTo(0.75, 5);
  });

  it.each([undefined, 0, 0.1])("starts the tail swell after release when the requested delay is %s", (delay) => {
    const keyframes = generateDuckingKeyframesFromRanges(
      [{ start: 1, end: 3 }],
      { ...SETTINGS, reduction: 0.5, release: 0.5 },
      0.8,
      { startAfterLastPresenceSec: delay, swellRampSec: 1, swellGainRatio: 1.5 },
    );
    const automation = new VolumeAutomation();
    expect(automation.getVolumeAtTime(3.25, keyframes)).toBeCloseTo(0.6);
    expect(automation.getVolumeAtTime(3.5, keyframes)).toBeCloseTo(0.8);
    expect(automation.getVolumeAtTime(4, keyframes)).toBeCloseTo(1);
    expect(automation.getVolumeAtTime(4.5, keyframes)).toBeCloseTo(1.2);
  });

  it("anchors a single tail to the last merged presence window", () => {
    const keyframes = generateDuckingKeyframesFromRanges(
      [{ start: 5, end: 6 }, { start: 1, end: 2 }, { start: 1.9, end: 3 }, { start: 6.1, end: 7 }],
      { ...SETTINGS, reduction: 0.5, release: 0.5 },
      0.8,
      { swellRampSec: 1, swellGainRatio: 1.5 },
    );
    const automation = new VolumeAutomation();
    for (const [time, volume] of [[2.5, 0.4], [4, 0.8], [6.5, 0.4], [7.5, 0.8], [8, 1], [8.5, 1.2]]) {
      expect(automation.getVolumeAtTime(time!, keyframes)).toBeCloseTo(volume!, 5);
    }
  });

  it.each([
    { backgroundVolume: 3, swellGainRatio: 2, expectedPeak: 4 },
    { backgroundVolume: 0, swellGainRatio: 4, expectedPeak: 0 },
  ])("keeps the tail volume in range for background $backgroundVolume and swell $swellGainRatio", ({ backgroundVolume, swellGainRatio, expectedPeak }) => {
    const keyframes = generateDuckingKeyframesFromRanges(
      [{ start: 1, end: 3 }],
      { ...SETTINGS, release: 0.5 },
      backgroundVolume,
      { swellRampSec: 1, swellGainRatio },
    );
    expect(new VolumeAutomation().getVolumeAtTime(4.5, keyframes)).toBe(expectedPeak);
    expect(keyframes.every(({ value }) => value >= 0 && value <= 4)).toBe(true);
  });

  it("does not create a tail swell or fade when there is no presence", () => {
    const keyframes = generateDuckingKeyframesFromRanges([], SETTINGS, 0.8, {
      swellGainRatio: 2, swellRampSec: 1, fadeOutDurationSec: 2, clipDurationSec: 8,
    });
    expect(keyframes).toEqual([]);
    expect(new VolumeAutomation().getVolumeAtTime(8, keyframes, 0.8)).toBe(0.8);
  });

  it("reaches the requested tail gain immediately when swellRampSec is zero", () => {
    const keyframes = generateDuckingKeyframesFromRanges(
      [{ start: 1, end: 3 }],
      { ...SETTINGS, release: 0.5 },
      0.8,
      { startAfterLastPresenceSec: 0.75, swellRampSec: 0, swellGainRatio: 1.5 },
    );
    // Release finishes at 3.5; the instantaneous swell at 3.75 must then hold.
    const automation = new VolumeAutomation();
    expect(automation.getVolumeAtTime(3.74, keyframes)).toBeCloseTo(0.8);
    expect(automation.getVolumeAtTime(3.75, keyframes)).toBeCloseTo(1.2);
    expect(automation.getVolumeAtTime(3.8, keyframes)).toBeCloseTo(1.2);
  });
});
