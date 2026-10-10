import { describe, expect, it, vi } from "vitest";
import type { Clip } from "../types/timeline";
import { SpeedEngine } from "./speed-engine";

/**
 * Phase-4 performance baseline for the speed-integral hot path
 * (changeset 10). Fixed clips cover constant speed, a variable-speed ramp,
 * reverse playback, and freeze frames. The tests only assert mapping
 * invariants that hold before AND after the optimization, so the suite
 * stays green throughout; integratePlaybackTime call counts and timings
 * logged here are the recorded baseline, and changeset 10's own regression
 * test hard-asserts the reduced counts.
 */
describe("SpeedEngine perf baselines", () => {
  const RAMP_CLIP = {
    id: "perf-ramp",
    inPoint: 0,
    outPoint: 10,
    speedKeyframes: [
      { id: "k0", time: 0, speed: 0.5, easing: "linear" },
      { id: "k1", time: 5, speed: 2, easing: "linear" },
      { id: "k2", time: 10, speed: 1, easing: "linear" },
    ],
  } as Clip;
  const REVERSE_CLIP = {
    id: "perf-reverse",
    inPoint: 0,
    outPoint: 10,
    reversed: true,
    speedKeyframes: [
      { id: "r0", time: 0, speed: 1, easing: "linear" },
      { id: "r1", time: 10, speed: 2, easing: "linear" },
    ],
  } as Clip;
  const FREEZE_CLIP = {
    id: "perf-freeze",
    inPoint: 0,
    outPoint: 10,
    speed: 2,
    freezeFrames: [
      { id: "f0", clipId: "perf-freeze", sourceTime: 3, startTime: 2, duration: 1.5 },
    ],
  } as Clip;
  const CONSTANT_CLIP = { id: "perf-constant", inPoint: 0, outPoint: 10, speed: 2 } as Clip;

  function integralCounter(engine: SpeedEngine): () => number {
    const spy = vi.spyOn(
      engine as unknown as { integratePlaybackTime: () => number },
      "integratePlaybackTime",
    );
    return () => spy.mock.calls.length;
  }

  it("maps boundaries and freeze holds identically before and after caching", () => {
    const engine = new SpeedEngine();
    engine.loadClips([RAMP_CLIP, REVERSE_CLIP, FREEZE_CLIP, CONSTANT_CLIP]);

    // Forward ramp boundaries.
    expect(engine.getSourceTimeAtPlaybackTime(RAMP_CLIP.id, 0)).toBeCloseTo(0, 6);
    const rampDuration = engine.getEffectiveDuration(RAMP_CLIP.id);
    expect(engine.getSourceTimeAtPlaybackTime(RAMP_CLIP.id, rampDuration)).toBeCloseTo(10, 3);
    // Reverse boundaries: playback 0 is the source end.
    expect(engine.getSourceTimeAtPlaybackTime(REVERSE_CLIP.id, 0)).toBeCloseTo(10, 3);
    expect(engine.getSourceTimeAtPlaybackTime(REVERSE_CLIP.id, engine.getEffectiveDuration(REVERSE_CLIP.id))).toBeCloseTo(0, 3);
    // Freeze holds the pinned source time across its whole window.
    expect(engine.getSourceTimeAtPlaybackTime(FREEZE_CLIP.id, 2)).toBeCloseTo(3, 6);
    expect(engine.getSourceTimeAtPlaybackTime(FREEZE_CLIP.id, 3.4)).toBeCloseTo(3, 6);
    // Constant speed stays linear.
    expect(engine.getSourceTimeAtPlaybackTime(CONSTANT_CLIP.id, 2.5)).toBeCloseTo(5, 6);
  });

  it("measures a playback sweep of the variable-speed ramp", () => {
    const engine = new SpeedEngine();
    engine.loadClips([RAMP_CLIP]);
    const countIntegrals = integralCounter(engine);
    const duration = engine.getEffectiveDuration(RAMP_CLIP.id);

    const steps = 200;
    const start = performance.now();
    let previous = 0;
    for (let i = 0; i < steps; i++) {
      const source = engine.getSourceTimeAtPlaybackTime(RAMP_CLIP.id, (i * duration) / steps);
      expect(source).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = source;
    }
    const elapsed = performance.now() - start;
    console.log(
      `[perf-baseline][speed-sweep] queries=${steps} integrateCalls=${countIntegrals()} elapsedMs=${elapsed.toFixed(1)}`,
    );
  });

  it("measures repeated identical queries", () => {
    const engine = new SpeedEngine();
    engine.loadClips([RAMP_CLIP]);
    const countIntegrals = integralCounter(engine);
    const duration = engine.getEffectiveDuration(RAMP_CLIP.id);
    const playbackTime = duration * 0.37;

    const repeats = 100;
    const first = engine.getSourceTimeAtPlaybackTime(RAMP_CLIP.id, playbackTime);
    const start = performance.now();
    for (let i = 0; i < repeats; i++) {
      expect(engine.getSourceTimeAtPlaybackTime(RAMP_CLIP.id, playbackTime)).toBeCloseTo(first, 10);
    }
    const elapsed = performance.now() - start;
    console.log(
      `[perf-baseline][speed-repeat] queries=${repeats} integrateCalls=${countIntegrals()} elapsedMs=${elapsed.toFixed(1)}`,
    );

    // Repeated duration queries are pure recomputation today.
    const durationStart = performance.now();
    for (let i = 0; i < repeats; i++) engine.getEffectiveDuration(RAMP_CLIP.id);
    const durationElapsed = performance.now() - durationStart;
    console.log(
      `[perf-baseline][speed-duration] queries=${repeats} integrateCalls=${countIntegrals()} elapsedMs=${durationElapsed.toFixed(1)}`,
    );
    expect(engine.getEffectiveDuration(RAMP_CLIP.id)).toBe(duration);
  });
});
