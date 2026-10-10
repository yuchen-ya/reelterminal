import { describe, expect, it, vi } from "vitest";
import type { Clip } from "../types/timeline";
import { SpeedEngine } from "./speed-engine";

/**
 * Phase-4 performance regression for the speed-integral hot path
 * (changeset 10). Fixed clips cover constant speed, a variable-speed ramp,
 * reverse playback, and freeze frames.
 *
 * Recorded pre-optimization baseline (1000-step midpoint Riemann sum per
 * query, re-integrated inside the binary search): the 200-point sweep spent
 * 3784 integratePlaybackTime calls (~55ms), 100 repeated identical queries
 * spent 1920 (~26ms), and 100 duration queries recomputed 100 integrals.
 *
 * The engine now builds one cumulative integral table per curve revision and
 * answers queries by O(log n) table inversion, so `buildIntegralTable` is the
 * only remaining full-integral work; the assertions below hard-pin its count.
 * Timings are logged for comparison only — never asserted.
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

  function tableBuildCounter(engine: SpeedEngine): () => number {
    const spy = vi.spyOn(
      engine as unknown as { buildIntegralTable: () => unknown },
      "buildIntegralTable",
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

  it("builds one integral table per curve and serves a playback sweep from it", () => {
    const engine = new SpeedEngine();
    engine.loadClips([RAMP_CLIP]);
    const countBuilds = tableBuildCounter(engine);
    const duration = engine.getEffectiveDuration(RAMP_CLIP.id);
    // The duration query is the single full-integral work item.
    expect(countBuilds()).toBe(1);

    const steps = 200;
    const start = performance.now();
    let previous = 0;
    for (let i = 0; i < steps; i++) {
      const source = engine.getSourceTimeAtPlaybackTime(RAMP_CLIP.id, (i * duration) / steps);
      expect(source).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = source;
    }
    const elapsed = performance.now() - start;
    // Baseline spent 3784 integrals here; the sweep must not rebuild at all.
    expect(countBuilds()).toBe(1);
    // Memoized duration stays consistent with the table.
    expect(engine.getEffectiveDuration(RAMP_CLIP.id)).toBe(duration);
    expect(countBuilds()).toBe(1);
    console.log(
      `[perf-after][speed-sweep] queries=${steps} tableBuilds=${countBuilds()} elapsedMs=${elapsed.toFixed(1)}`,
    );
  });

  it("serves repeated identical queries and durations without rebuilding", () => {
    const engine = new SpeedEngine();
    engine.loadClips([RAMP_CLIP]);
    const countBuilds = tableBuildCounter(engine);
    const duration = engine.getEffectiveDuration(RAMP_CLIP.id);
    const playbackTime = duration * 0.37;
    expect(countBuilds()).toBe(1);

    const repeats = 100;
    const first = engine.getSourceTimeAtPlaybackTime(RAMP_CLIP.id, playbackTime);
    const start = performance.now();
    for (let i = 0; i < repeats; i++) {
      expect(engine.getSourceTimeAtPlaybackTime(RAMP_CLIP.id, playbackTime)).toBeCloseTo(first, 12);
    }
    const elapsed = performance.now() - start;
    // Baseline spent 1920 integrals on the repeats; identical queries must
    // not trigger any additional integral after the first.
    expect(countBuilds()).toBe(1);
    console.log(
      `[perf-after][speed-repeat] queries=${repeats} tableBuilds=${countBuilds()} elapsedMs=${elapsed.toFixed(1)}`,
    );

    // Baseline recomputed the duration integral on every query; memoized
    // duration must serve all repeats with zero additional builds.
    const durationStart = performance.now();
    for (let i = 0; i < repeats; i++) {
      expect(engine.getEffectiveDuration(RAMP_CLIP.id)).toBe(duration);
    }
    const durationElapsed = performance.now() - durationStart;
    expect(countBuilds()).toBe(1);
    console.log(
      `[perf-after][speed-duration] queries=${repeats} tableBuilds=${countBuilds()} elapsedMs=${durationElapsed.toFixed(1)}`,
    );
  });
});
