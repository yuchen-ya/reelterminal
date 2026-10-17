import type { Clip } from "../types/timeline";
import { describe, it, expect, beforeEach } from "vitest";
import { SpeedEngine } from "./speed-engine";

describe("SpeedEngine", () => {
  let speedEngine: SpeedEngine;

  beforeEach(() => {
    speedEngine = new SpeedEngine();
  });

  it("hydrates trim/speed/reverse from canonical snapshots and clears stale clip state", () => {
    const clip = { id: "canonical", inPoint: 2, outPoint: 6, speed: 2, reversed: false } as Clip;
    speedEngine.loadClips([clip]);
    expect(speedEngine.getSourceTimeAtPlaybackTime(clip.id, 1)).toBe(2);
    speedEngine.loadClips([{ ...clip, outPoint: 4, reversed: true }]);
    expect(speedEngine.getSourceTimeAtPlaybackTime(clip.id, .25)).toBe(1.5);
    expect(speedEngine.getEffectiveDuration(clip.id)).toBe(1);
    speedEngine.loadClips([]);
    expect(speedEngine.getClipIds()).toEqual([]);
  });

  it("includes every freeze in duration and resumes the same moving-source mapping", () => {
    const clip = {
      id: "freeze", inPoint: 7, outPoint: 17, speed: 2,
      freezeFrames: [
        { id: "second", clipId: "freeze", sourceTime: 6, startTime: 5, duration: 1 },
        { id: "first", clipId: "freeze", sourceTime: 2, startTime: 1, duration: 2 },
      ],
    } as Clip;
    speedEngine.loadClips([clip]);
    expect(speedEngine.getEffectiveDuration(clip.id)).toBe(8);
    expect(speedEngine.getSourceTimeAtPlaybackTime(clip.id, 2)).toBe(2);
    expect(speedEngine.getSourceTimeAtPlaybackTime(clip.id, 3)).toBe(2);
    expect(speedEngine.getSourceTimeAtPlaybackTime(clip.id, 4)).toBe(4);
    expect(speedEngine.getSourceTimeAtPlaybackTime(clip.id, 5.5)).toBe(6);
    expect(speedEngine.getSourceTimeAtPlaybackTime(clip.id, 8)).toBe(10);
  });

  it("inverts source→playback for constant, reverse, curve and frozen clips", () => {
    const cases = [
      { id: "constant", inPoint: 2, outPoint: 6, speed: 2 } as Clip,
      { id: "reverse", inPoint: 2, outPoint: 6, speed: 2, reversed: true } as Clip,
      {
        id: "curve", inPoint: 4, outPoint: 14,
        speedKeyframes: [
          { id: "a", time: 0, speed: 1, easing: "linear" },
          { id: "b", time: 10, speed: 2, easing: "linear" },
        ],
      } as Clip,
      {
        id: "frozen", inPoint: 7, outPoint: 17, speed: 2,
        freezeFrames: [
          { id: "first", clipId: "frozen", sourceTime: 2, startTime: 1, duration: 2 },
          { id: "second", clipId: "frozen", sourceTime: 6, startTime: 5, duration: 1 },
        ],
      } as Clip,
      {
        id: "reversefrozen", inPoint: 7, outPoint: 17, speed: 2, reversed: true,
        freezeFrames: [{ id: "rf", clipId: "reversefrozen", sourceTime: 4, startTime: 2, duration: 1.5 }],
      } as Clip,
    ];
    for (const clip of cases) {
      speedEngine.loadClips([clip]);
      const span = clip.outPoint - clip.inPoint;
      for (const source of [0, 0.5, 1.7, 3, 5.5, 9.9, 10].filter((value) => value <= span)) {
        const playback = speedEngine.getPlaybackTimeAtSourceTime(clip.id, source);
        expect(speedEngine.getSourceTimeAtPlaybackTime(clip.id, playback), `${clip.id} source ${source} playback ${playback}`).toBeCloseTo(source, 3);
      }
    }
  });

  it("uses one curved duration integral and handles reverse at both endpoints", () => {
    const clip = {
      id: "curve", inPoint: 4, outPoint: 14, reversed: true,
      speedKeyframes: [
        { id: "a", time: 0, speed: 1, easing: "linear" },
        { id: "b", time: 10, speed: 2, easing: "linear" },
      ],
      freezeFrames: [{ id: "f", clipId: "curve", sourceTime: 3, startTime: 1, duration: 2 }],
    } as Clip;
    speedEngine.loadClips([clip]);
    const duration = speedEngine.getEffectiveDuration(clip.id);
    expect(duration).toBeCloseTo(10 * Math.log(2) + 2, 5);
    expect(speedEngine.getSourceTimeAtPlaybackTime(clip.id, 0)).toBe(10);
    expect(speedEngine.getSourceTimeAtPlaybackTime(clip.id, 2)).toBe(3);
    expect(speedEngine.getSourceTimeAtPlaybackTime(clip.id, 10 * Math.log(1.5) + 2)).toBeCloseTo(5, 3);
    expect(speedEngine.getSourceTimeAtPlaybackTime(clip.id, duration)).toBe(0);
  });

  describe("Basic Speed Operations", () => {
    it("should return default speed of 1 for uninitialized clips", () => {
      expect(speedEngine.getClipSpeed("unknown-clip")).toBe(1);
    });

    it("should set and get clip speed", () => {
      speedEngine.setClipSpeed("clip-1", 2, 10);
      expect(speedEngine.getClipSpeed("clip-1")).toBe(2);
    });

    it("should clamp speed to valid range", () => {
      speedEngine.setClipSpeed("clip-1", 0.01, 10);
      expect(speedEngine.getClipSpeed("clip-1")).toBe(0.1);

      speedEngine.setClipSpeed("clip-2", 100, 10);
      expect(speedEngine.getClipSpeed("clip-2")).toBe(20);
    });
  });

  describe("getSourceTimeAtPlaybackTime - Critical for Playback", () => {
    it("should return same time when speed is 1x", () => {
      speedEngine.setClipSpeed("clip-1", 1, 10);

      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 0)).toBe(0);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 5)).toBe(5);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 10)).toBe(10);
    });

    it("should return doubled time when speed is 2x", () => {
      speedEngine.setClipSpeed("clip-1", 2, 10);

      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 0)).toBe(0);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 2.5)).toBe(5);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 5)).toBe(10);
    });

    it("should return halved time when speed is 0.5x", () => {
      speedEngine.setClipSpeed("clip-1", 0.5, 10);

      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 0)).toBe(0);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 10)).toBe(5);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 20)).toBe(10);
    });

    it("should clamp source time to valid range", () => {
      speedEngine.setClipSpeed("clip-1", 2, 10);

      const sourceTime = speedEngine.getSourceTimeAtPlaybackTime("clip-1", 100);
      expect(sourceTime).toBeLessThanOrEqual(10);
    });

    it("should handle reverse playback", () => {
      speedEngine.setClipSpeed("clip-1", 1, 10);
      speedEngine.setReverse("clip-1", true, 10);

      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 0)).toBe(10);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 5)).toBe(5);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 10)).toBe(0);
    });

    it("should handle reverse playback at 2x speed", () => {
      speedEngine.setClipSpeed("clip-1", 2, 10);
      speedEngine.setReverse("clip-1", true, 10);

      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 0)).toBe(10);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 2.5)).toBe(5);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 5)).toBe(0);
    });
  });

  describe("Effective Duration Calculation", () => {
    it("should calculate effective duration at 1x speed", () => {
      speedEngine.setClipSpeed("clip-1", 1, 10);
      expect(speedEngine.getEffectiveDuration("clip-1")).toBe(10);
    });

    it("should calculate effective duration at 2x speed", () => {
      speedEngine.setClipSpeed("clip-1", 2, 10);
      expect(speedEngine.getEffectiveDuration("clip-1")).toBe(5);
    });

    it("should calculate effective duration at 0.5x speed", () => {
      speedEngine.setClipSpeed("clip-1", 0.5, 10);
      expect(speedEngine.getEffectiveDuration("clip-1")).toBe(20);
    });
  });

  describe("Frame Index Calculations", () => {
    it("should get correct frame index at 1x speed", () => {
      speedEngine.setClipSpeed("clip-1", 1, 10);

      expect(speedEngine.getFrameIndexAtTime("clip-1", 0, 30)).toBe(0);
      expect(speedEngine.getFrameIndexAtTime("clip-1", 1, 30)).toBe(30);
      expect(speedEngine.getFrameIndexAtTime("clip-1", 2, 30)).toBe(60);
    });

    it("should get correct frame index at 2x speed", () => {
      speedEngine.setClipSpeed("clip-1", 2, 10);

      expect(speedEngine.getFrameIndexAtTime("clip-1", 0, 30)).toBe(0);
      expect(speedEngine.getFrameIndexAtTime("clip-1", 1, 30)).toBe(60);
      expect(speedEngine.getFrameIndexAtTime("clip-1", 2, 30)).toBe(120);
    });

    it("covers long ranges at awkward frame rates without duplicate or skipped indices", () => {
      const clip = { id: "long", inPoint: 0, outPoint: 1000, speed: 1 } as Clip;
      speedEngine.loadClips([clip]);

      // 10 fps over 1000 s: 10,000 samples. Accumulating `t += 1/10` drifts
      // off frame centers over long ranges and duplicates/skips indices;
      // deriving each time from the integer counter must not.
      const frames10 = speedEngine.getFrameIndicesInRange("long", 0, 1000, 10);
      expect(frames10).toHaveLength(10000);
      expect(new Set(frames10).size).toBe(frames10.length);
      expect(frames10[0]).toBe(0);
      expect(frames10[frames10.length - 1]).toBe(9999);

      // 29.97 fps over the same range: 29,970 samples (endTime exclusive).
      const frames2997 = speedEngine.getFrameIndicesInRange(
        "long",
        0,
        1000,
        29.97,
      );
      expect(frames2997).toHaveLength(29970);
      expect(new Set(frames2997).size).toBe(frames2997.length);
      for (let i = 1; i < frames2997.length; i++) {
        expect(frames2997[i]).toBe(frames2997[i - 1]! + 1);
      }
    });
  });

  describe("Playback Timing Invariants", () => {
    it("clipLocalTime should be independent of speed for transforms", () => {
      const originalDuration = 10;
      const clipStartTime = 5;

      speedEngine.setClipSpeed("clip-1", 2, originalDuration);

      for (let playheadTime = clipStartTime; playheadTime < clipStartTime + 5; playheadTime += 0.5) {
        const clipLocalTime = playheadTime - clipStartTime;
        expect(clipLocalTime).toBeGreaterThanOrEqual(0);
        expect(clipLocalTime).toBeLessThanOrEqual(originalDuration / 2);
      }
    });

    it("mediaTime should advance at speed rate while playhead advances at 1x", () => {
      const speed = 2;
      const originalDuration = 10;
      speedEngine.setClipSpeed("clip-1", speed, originalDuration);

      const realTimeElapsed = 1;
      const expectedMediaTimeAdvance = realTimeElapsed * speed;

      const mediaTime = speedEngine.getSourceTimeAtPlaybackTime("clip-1", realTimeElapsed);
      expect(mediaTime).toBe(expectedMediaTimeAdvance);
    });
  });
});

describe("SpeedEngine - Playback Time vs Media Time", () => {
  let speedEngine: SpeedEngine;

  beforeEach(() => {
    speedEngine = new SpeedEngine();
  });

  it("should correctly separate playhead time from media time at various speeds", () => {
    const speeds = [0.5, 1, 1.5, 2, 3];
    const originalDuration = 60;

    for (const speed of speeds) {
      speedEngine.setClipSpeed(`clip-${speed}`, speed, originalDuration);

      const playbackDuration = originalDuration / speed;
      const testPoints = [0, 0.25, 0.5, 0.75, 1];

      for (const fraction of testPoints) {
        const playheadTime = playbackDuration * fraction;
        const expectedMediaTime = Math.min(originalDuration, playheadTime * speed);

        const actualMediaTime = speedEngine.getSourceTimeAtPlaybackTime(
          `clip-${speed}`,
          playheadTime
        );

        expect(actualMediaTime).toBeCloseTo(expectedMediaTime, 5);
      }
    }
  });
});

describe("SpeedEngine - integral cache invalidation", () => {
  /** Ramp used to warm the integral cache before every mutation below. */
  const RAMP = {
    id: "cached",
    inPoint: 0,
    outPoint: 10,
    speedKeyframes: [
      { id: "a", time: 0, speed: 0.5, easing: "linear" },
      { id: "b", time: 10, speed: 2, easing: "linear" },
    ],
  } as Clip;

  let engine: SpeedEngine;

  /**
   * Both engines run the same deterministic table build, so a cached engine
   * whose invalidation fired matches a fresh engine bit for bit; 12 decimals
   * leaves room only for float noise, never for a stale curve.
   */
  function expectMatchesFreshEngine(finalClip: Clip, playbackTimes: number[]): void {
    const fresh = new SpeedEngine();
    fresh.loadClips([finalClip]);
    expect(engine.getEffectiveDuration(finalClip.id)).toBeCloseTo(
      fresh.getEffectiveDuration(finalClip.id),
      12,
    );
    for (const t of playbackTimes) {
      expect(engine.getSourceTimeAtPlaybackTime(finalClip.id, t)).toBeCloseTo(
        fresh.getSourceTimeAtPlaybackTime(finalClip.id, t),
        12,
      );
    }
  }

  beforeEach(() => {
    engine = new SpeedEngine();
  });

  it("reflects setClipSpeed immediately after a cached constant-speed query", () => {
    engine.setClipSpeed("c", 1, 10);
    expect(engine.getEffectiveDuration("c")).toBe(10); // warms the memo path
    engine.setClipSpeed("c", 2, 10);
    expect(engine.getEffectiveDuration("c")).toBe(5);
    expect(engine.getSourceTimeAtPlaybackTime("c", 2.5)).toBe(5);
    expectMatchesFreshEngine(
      { id: "c", inPoint: 0, outPoint: 10, speed: 2 } as Clip,
      [0, 1, 4.9, 5],
    );
  });

  it("reflects addSpeedKeyframe immediately after caching the constant curve", () => {
    engine.setClipSpeed("c", 2, 10);
    expect(engine.getEffectiveDuration("c")).toBe(5); // warms non-keyframed path
    engine.addSpeedKeyframe("c", 0, 0.5, "linear");
    engine.addSpeedKeyframe("c", 10, 2, "linear");
    expect(engine.getEffectiveDuration("c")).not.toBe(5); // cache invalidated
    expectMatchesFreshEngine(
      {
        id: "c",
        inPoint: 0,
        outPoint: 10,
        speedKeyframes: [
          { id: "a", time: 0, speed: 0.5, easing: "linear" },
          { id: "b", time: 10, speed: 2, easing: "linear" },
        ],
      } as Clip,
      [0, 1, 3, 6.9],
    );
  });

  it("reflects updateSpeedKeyframe during curve editing without serving the stale table", () => {
    engine.loadClips([RAMP]);
    const before = engine.getEffectiveDuration(RAMP.id);
    engine.getSourceTimeAtPlaybackTime(RAMP.id, before / 2); // builds the table
    engine.updateSpeedKeyframe(RAMP.id, "b", { speed: 4 });
    const after = engine.getEffectiveDuration(RAMP.id);
    expect(after).not.toBeCloseTo(before, 6); // the new curve took effect
    expectMatchesFreshEngine(
      {
        ...RAMP,
        speedKeyframes: [
          { id: "a", time: 0, speed: 0.5, easing: "linear" },
          { id: "b", time: 10, speed: 4, easing: "linear" },
        ],
      } as Clip,
      [0, 0.5, 2, 4, 6],
    );
  });

  it("reflects updateSpeedKeyframe time moves and removeSpeedKeyframe", () => {
    engine.loadClips([RAMP]);
    engine.getSourceTimeAtPlaybackTime(RAMP.id, 3); // builds the table
    engine.updateSpeedKeyframe(RAMP.id, "b", { time: 5 });
    expectMatchesFreshEngine(
      {
        ...RAMP,
        speedKeyframes: [
          { id: "a", time: 0, speed: 0.5, easing: "linear" },
          { id: "b", time: 5, speed: 2, easing: "linear" },
        ],
      } as Clip,
      [0, 1, 5, 8],
    );
    engine.removeSpeedKeyframe(RAMP.id, "a");
    expectMatchesFreshEngine(
      {
        ...RAMP,
        speedKeyframes: [{ id: "b", time: 5, speed: 2, easing: "linear" }],
      } as Clip,
      [0, 1, 5, 8],
    );
  });

  it("re-hydrates loadClips over a cached previous configuration", () => {
    engine.loadClips([RAMP]);
    const staleDuration = engine.getEffectiveDuration(RAMP.id);
    engine.getSourceTimeAtPlaybackTime(RAMP.id, staleDuration / 2);
    const replaced = {
      ...RAMP,
      inPoint: 2,
      outPoint: 6,
      speedKeyframes: [{ id: "z", time: 0, speed: 4, easing: "linear" }],
    } as Clip;
    engine.loadClips([replaced]);
    expect(engine.getEffectiveDuration(replaced.id)).toBe(1);
    expect(engine.getSourceTimeAtPlaybackTime(replaced.id, 0.5)).toBe(2);
    expectMatchesFreshEngine(replaced, [0, 0.25, 0.75, 1]);
    expect(engine.getEffectiveDuration(replaced.id)).not.toBe(staleDuration);
  });

  it("extends and shrinks the duration for createFreezeFrame and removeFreezeFrame", () => {
    engine.loadClips([RAMP]);
    const movingDuration = engine.getEffectiveDuration(RAMP.id);
    engine.getSourceTimeAtPlaybackTime(RAMP.id, 1); // builds the table
    const freeze = engine.createFreezeFrame(RAMP.id, 4, 1, 2.5);
    expect(engine.getEffectiveDuration(RAMP.id)).toBeCloseTo(movingDuration + 2.5, 12);
    // Between 1s and 3.5s playback the clip holds source second 4.
    expect(engine.getSourceTimeAtPlaybackTime(RAMP.id, 1)).toBe(4);
    expect(engine.getSourceTimeAtPlaybackTime(RAMP.id, 3.4)).toBe(4);
    expectMatchesFreshEngine(
      {
        ...RAMP,
        freezeFrames: [{ id: freeze.id, clipId: RAMP.id, sourceTime: 4, startTime: 1, duration: 2.5 }],
      } as Clip,
      [0, 0.5, 4, 7],
    );
    engine.removeFreezeFrame(RAMP.id, freeze.id);
    expect(engine.getEffectiveDuration(RAMP.id)).toBeCloseTo(movingDuration, 12);
    expectMatchesFreshEngine(RAMP, [0, 0.5, 1, 3.4]);
  });

  it("reflects initializeClip duration changes after the integral was cached", () => {
    engine.setClipSpeed("c", 2, 10);
    engine.addSpeedKeyframe("c", 0, 1, "linear");
    engine.addSpeedKeyframe("c", 10, 2, "linear");
    engine.getEffectiveDuration("c"); // builds the table over [0, 10]
    engine.initializeClip("c", 20);
    // The keyframe at 10 is now interior: curve integral over [0, 10] plus
    // the constant last-keyframe speed (2x) across [10, 20].
    expect(engine.getEffectiveDuration("c")).toBeCloseTo(10 * Math.log(2) + 5, 5);
    expectMatchesFreshEngine(
      {
        id: "c",
        inPoint: 0,
        outPoint: 20,
        speedKeyframes: [
          { id: "a", time: 0, speed: 1, easing: "linear" },
          { id: "b", time: 10, speed: 2, easing: "linear" },
        ],
      } as Clip,
      [0, 1, 5, 9],
    );
  });

  it("applies setReverse and setPitchCorrection to queries immediately", () => {
    engine.loadClips([RAMP]);
    engine.getSourceTimeAtPlaybackTime(RAMP.id, 3); // builds the table
    engine.setReverse(RAMP.id, true, 10);
    expect(engine.getSourceTimeAtPlaybackTime(RAMP.id, 0)).toBe(10);
    expectMatchesFreshEngine({ ...RAMP, reversed: true } as Clip, [0, 1, 3, 7]);
    engine.setReverse(RAMP.id, false);
    expectMatchesFreshEngine(RAMP, [0, 1, 3, 7]);
    engine.setPitchCorrection(RAMP.id, false);
    // Pitch correction never affects the mapping or duration.
    expectMatchesFreshEngine(RAMP, [0, 1, 3, 7]);
  });

  it("matches a fresh engine sweep after a full mutation sequence", () => {
    engine.loadClips([RAMP]);
    engine.getEffectiveDuration(RAMP.id);
    engine.addSpeedKeyframe(RAMP.id, 5, 4, "linear");
    engine.updateSpeedKeyframe(RAMP.id, "b", { time: 8, speed: 1 });
    const freeze = engine.createFreezeFrame(RAMP.id, 2, 0.5, 1);
    engine.removeSpeedKeyframe(RAMP.id, "a");
    engine.removeFreezeFrame(RAMP.id, freeze.id);
    const finalClip = {
      ...RAMP,
      speedKeyframes: [
        { id: "kf5", time: 5, speed: 4, easing: "linear" },
        { id: "b", time: 8, speed: 1, easing: "linear" },
      ],
    } as Clip;
    expectMatchesFreshEngine(finalClip, [0, 0.5, 1, 2, 4, 6, 8.5, 11]);

    // And the resulting curve still sweeps monotonically end to end.
    const duration = engine.getEffectiveDuration(finalClip.id);
    let previous = 0;
    for (let i = 0; i <= 100; i++) {
      const source = engine.getSourceTimeAtPlaybackTime(finalClip.id, (i * duration) / 100);
      expect(source).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = source;
    }
    expect(previous).toBeCloseTo(10, 3);
  });

  it("forgets removed clips and rebuilds on re-initialization", () => {
    engine.loadClips([RAMP]);
    engine.getEffectiveDuration(RAMP.id);
    engine.removeClip(RAMP.id);
    expect(engine.getEffectiveDuration(RAMP.id)).toBe(0);
    expect(engine.getSourceTimeAtPlaybackTime(RAMP.id, 3)).toBe(3);
    engine.loadClips([RAMP]);
    expectMatchesFreshEngine(RAMP, [0, 3, 7]);
    engine.clear();
    expect(engine.getEffectiveDuration(RAMP.id)).toBe(0);
  });
});
