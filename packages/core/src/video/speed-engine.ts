import type {
  Clip,
  EasingType,
  SpeedKeyframe,
  FreezeFrame,
} from "../types/timeline";
import { AnimationEngine } from "./animation-engine";

export type { SpeedKeyframe, FreezeFrame };

export interface ClipSpeedData {
  clipId: string;
  baseSpeed: number;
  reverse: boolean;
  keyframes: SpeedKeyframe[];
  pitchCorrection: boolean;
  freezeFrames: FreezeFrame[];
  originalDuration: number;
}

export const SPEED_MIN = 0.1;
export const SPEED_MAX = 20;

/**
 * Cumulative moving-time integral for one clip: `cumulative[i]` is the moving
 * playback seconds accumulated over source seconds [0, sampleTimes[i]].
 * Built lazily per curve revision; every mutating entry point drops the entry
 * (see invalidateSpeedIntegral), so lookups never see a stale curve.
 */
interface SpeedIntegralCache {
  sampleTimes: Float64Array;
  cumulative: Float64Array;
  movingDuration: number;
}

// Target source-second accuracy when inverting the cumulative table; the
// binary search it replaced resolved playback time to 1e-4 (~2e-4 source).
const SOURCE_TIME_TOLERANCE = 1e-5;
// Upper bounds keeping a rebuild in the sub-millisecond range for typical
// clips; only pathological long-and-steep curves ever reach the caps, and
// they then degrade interpolation accuracy gracefully instead of allocating
// unbounded samples.
const MAX_SEGMENT_SAMPLES = 32768;
const MAX_TOTAL_SAMPLES = 65536;

export class SpeedEngine {
  private clipSpeedData: Map<string, ClipSpeedData> = new Map();
  private integralCaches: Map<string, SpeedIntegralCache> = new Map();
  private animationEngine: AnimationEngine;

  constructor(animationEngine?: AnimationEngine) {
    this.animationEngine = animationEngine || new AnimationEngine();
  }
  /** Restore canonical state for GUI undo/open and isolated render/export snapshots. */
  loadClips(clips: readonly Clip[]): void {
    this.clipSpeedData.clear();
    this.integralCaches.clear();
    for (const clip of clips) this.clipSpeedData.set(clip.id, {
      clipId: clip.id,
      baseSpeed: this.clampSpeed(clip.speed ?? 1),
      reverse: clip.reversed ?? false,
      originalDuration: Math.max(0, clip.outPoint - clip.inPoint),
      keyframes: structuredClone(clip.speedKeyframes ?? []).sort((a, b) => a.time - b.time),
      freezeFrames: structuredClone(clip.freezeFrames ?? []).sort((a, b) => a.startTime - b.startTime),
      pitchCorrection: clip.pitchCorrection ?? true,
    });
  }

  // Speed Control (Requirement 19.1)
  setClipSpeed(clipId: string, speed: number, originalDuration: number): void {
    const clampedSpeed = this.clampSpeed(speed);
    const data = this.getOrCreateSpeedData(clipId, originalDuration);
    data.baseSpeed = clampedSpeed;
    this.clipSpeedData.set(clipId, data);
    this.invalidateSpeedIntegral(clipId);
  }

  /** Drop the cached integral after a curve/duration/freeze mutation so the
   * next query rebuilds from the current configuration. */
  private invalidateSpeedIntegral(clipId: string): void {
    this.integralCaches.delete(clipId);
  }

  getClipSpeed(clipId: string): number {
    const data = this.clipSpeedData.get(clipId);
    return data?.baseSpeed ?? 1;
  }

  getEffectiveDuration(clipId: string): number {
    const data = this.clipSpeedData.get(clipId);
    if (!data) return 0;
    const movingDuration = data.keyframes.length > 0
      ? this.ensureIntegralTable(data).movingDuration
      : data.originalDuration / data.baseSpeed;
    return movingDuration + data.freezeFrames.reduce((sum, freeze) => sum + freeze.duration, 0);
  }

  private clampSpeed(speed: number): number {
    return Math.max(SPEED_MIN, Math.min(SPEED_MAX, speed));
  }
  // Reverse Playback (Requirement 19.2)
  // No integral invalidation: reverse only reflects the final source offset.
  setReverse(
    clipId: string,
    reverse: boolean,
    originalDuration?: number,
  ): void {
    let data = this.clipSpeedData.get(clipId);
    if (!data && originalDuration !== undefined) {
      data = this.getOrCreateSpeedData(clipId, originalDuration);
      this.clipSpeedData.set(clipId, data);
    }
    if (data) {
      data.reverse = reverse;
    }
  }

  isReverse(clipId: string): boolean {
    const data = this.clipSpeedData.get(clipId);
    return data?.reverse ?? false;
  }

  getFrameIndexAtTime(
    clipId: string,
    playbackTime: number,
    frameRate: number,
  ): number {
    const sourceTime = this.getSourceTimeAtPlaybackTime(clipId, playbackTime);
    const frameIndex = Math.floor(sourceTime * frameRate);

    return Math.max(0, frameIndex);
  }

  getFrameIndicesInRange(
    clipId: string,
    startTime: number,
    endTime: number,
    frameRate: number,
  ): number[] {
    const frameDuration = 1 / frameRate;
    const frames: number[] = [];

    // Derive each sample time from an integer counter instead of accumulating
    // `t += frameDuration`: float drift over long ranges shifts times off
    // frame centers and duplicates/skips source frame indices. Endpoint
    // semantics are unchanged — startTime inclusive, endTime exclusive (the
    // negated form keeps the old loop's NaN-safe termination).
    for (let i = 0; ; i++) {
      const t = startTime + i * frameDuration;
      if (!(t < endTime)) break;
      frames.push(this.getFrameIndexAtTime(clipId, t, frameRate));
    }

    return frames;
  }
  // Speed Ramping (Requirement 19.3)
  addSpeedKeyframe(
    clipId: string,
    time: number,
    speed: number,
    easing: EasingType = "linear",
  ): string {
    const data = this.clipSpeedData.get(clipId);
    if (!data) {
      throw new Error(`No speed data for clip ${clipId}`);
    }

    const id = `speed-kf-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 11)}`;
    const keyframe: SpeedKeyframe = {
      id,
      time,
      speed: this.clampSpeed(speed),
      easing,
    };
    const existingIndex = data.keyframes.findIndex(
      (kf) => Math.abs(kf.time - time) < 0.001,
    );

    if (existingIndex >= 0) {
      data.keyframes[existingIndex] = keyframe;
    } else {
      data.keyframes.push(keyframe);
      data.keyframes.sort((a, b) => a.time - b.time);
    }
    this.invalidateSpeedIntegral(clipId);

    return id;
  }

  removeSpeedKeyframe(clipId: string, keyframeId: string): void {
    const data = this.clipSpeedData.get(clipId);
    if (data) {
      data.keyframes = data.keyframes.filter((kf) => kf.id !== keyframeId);
      this.invalidateSpeedIntegral(clipId);
    }
  }

  /**
   * Move an existing speed keyframe to a new time and/or speed in-place,
   * preserving its id and easing. Used by the curve editor when the
   * user drags a keyframe.
   */
  updateSpeedKeyframe(
    clipId: string,
    keyframeId: string,
    updates: { time?: number; speed?: number; easing?: EasingType },
  ): void {
    const data = this.clipSpeedData.get(clipId);
    if (!data) return;
    const idx = data.keyframes.findIndex((kf) => kf.id === keyframeId);
    if (idx === -1) return;
    const current = data.keyframes[idx];
    const next: SpeedKeyframe = {
      ...current,
      time:
        updates.time !== undefined
          ? Math.max(0, Math.min(data.originalDuration, updates.time))
          : current.time,
      speed:
        updates.speed !== undefined
          ? this.clampSpeed(updates.speed)
          : current.speed,
      easing: updates.easing ?? current.easing,
    };
    data.keyframes[idx] = next;
    data.keyframes.sort((a, b) => a.time - b.time);
    this.invalidateSpeedIntegral(clipId);
  }

  getSpeedKeyframes(clipId: string): SpeedKeyframe[] {
    const data = this.clipSpeedData.get(clipId);
    return data?.keyframes ?? [];
  }

  getSpeedAtTime(clipId: string, sourceTime: number): number {
    const data = this.clipSpeedData.get(clipId);
    if (!data) return 1;

    return this.getSpeedAtSourceTime(data, sourceTime);
  }

  private getSpeedAtSourceTime(
    data: ClipSpeedData,
    sourceTime: number,
  ): number {
    const keyframes = data.keyframes;

    if (keyframes.length === 0) {
      return data.baseSpeed;
    }

    // Hydration and every keyframe writer keep this array sorted.
    const sorted = keyframes;

    if (sourceTime <= sorted[0].time) {
      return sorted[0].speed;
    }

    if (sourceTime >= sorted[sorted.length - 1].time) {
      return sorted[sorted.length - 1].speed;
    }
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sourceTime >= sorted[i].time && sourceTime <= sorted[i + 1].time) {
        const kf1 = sorted[i];
        const kf2 = sorted[i + 1];
        const duration = kf2.time - kf1.time;
        const elapsed = sourceTime - kf1.time;
        const linearProgress = duration > 0 ? elapsed / duration : 0;
        const easedProgress = this.animationEngine.applyEasing(
          linearProgress,
          kf1.easing,
        );
        return this.clampSpeed(kf1.speed + (kf2.speed - kf1.speed) * easedProgress);
      }
    }

    return data.baseSpeed;
  }
  // Freeze Frames (Requirement 19.4)
  createFreezeFrame(
    clipId: string,
    sourceTime: number,
    startTime: number,
    duration: number,
  ): FreezeFrame {
    const data = this.clipSpeedData.get(clipId);
    if (!data) {
      throw new Error(`No speed data for clip ${clipId}`);
    }

    const id = `freeze-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 11)}`;
    const freezeFrame: FreezeFrame = {
      id,
      clipId,
      sourceTime,
      startTime,
      duration,
    };

    data.freezeFrames.push(freezeFrame);
    data.freezeFrames.sort((a, b) => a.startTime - b.startTime);
    // Freezes extend the effective duration (and playback offsets) without
    // touching the moving integral, so drop the whole cached entry.
    this.invalidateSpeedIntegral(clipId);

    return freezeFrame;
  }

  removeFreezeFrame(clipId: string, freezeFrameId: string): void {
    const data = this.clipSpeedData.get(clipId);
    if (data) {
      data.freezeFrames = data.freezeFrames.filter(
        (ff) => ff.id !== freezeFrameId,
      );
      this.invalidateSpeedIntegral(clipId);
    }
  }

  getFreezeFrames(clipId: string): FreezeFrame[] {
    const data = this.clipSpeedData.get(clipId);
    return data?.freezeFrames ?? [];
  }

  getFreezeFrameAtTime(
    clipId: string,
    playbackTime: number,
  ): FreezeFrame | null {
    const data = this.clipSpeedData.get(clipId);
    if (!data) return null;

    for (const ff of data.freezeFrames) {
      if (
        playbackTime >= ff.startTime &&
        playbackTime < ff.startTime + ff.duration
      ) {
        return ff;
      }
    }

    return null;
  }

  /** Clip-local playback seconds -> source seconds relative to inPoint.
   * Freezes hold the specified source frame, then resume the moving-time mapping.
   * Reverse reflects the moving source offset; freeze sourceTime is already the
   * desired source offset and is not reflected again.
   */
  getSourceTimeAtPlaybackTime(clipId: string, playbackTime: number): number {
    const data = this.clipSpeedData.get(clipId);
    if (!data) return playbackTime;
    const freezeFrame = this.getFreezeFrameAtTime(clipId, playbackTime);
    if (freezeFrame) {
      return freezeFrame.sourceTime;
    }
    // One duration per query: the boundary check and the variable-speed
    // inverse share the cached value instead of integrating twice.
    // Compare against the complete duration before subtracting holds: floating
    // point subtraction can otherwise put the final endpoint just inside the
    // binary-search interval instead of returning the exact source boundary.
    const effectiveDuration = this.getEffectiveDuration(clipId);
    if (playbackTime >= effectiveDuration) {
      return data.reverse ? 0 : data.originalDuration;
    }

    let adjustedTime = playbackTime;
    for (const ff of data.freezeFrames) {
      if (ff.startTime + ff.duration <= playbackTime) {
        adjustedTime -= ff.duration;
      } else if (ff.startTime < playbackTime) {
        break;
      }
    }
    if (data.keyframes.length > 0) {
      return this.calculateSourceTimeWithVariableSpeed(
        data,
        adjustedTime,
        effectiveDuration,
      );
    }

    let sourceTime = adjustedTime * data.baseSpeed;
    if (data.reverse) {
      sourceTime = data.originalDuration - sourceTime;
    }

    return Math.max(0, Math.min(data.originalDuration, sourceTime));
  }

  private calculateSourceTimeWithVariableSpeed(
    data: ClipSpeedData,
    playbackTime: number,
    effectiveDuration: number,
  ): number {
    if (playbackTime <= 0) return data.reverse ? data.originalDuration : 0;
    if (playbackTime >= effectiveDuration) return data.reverse ? 0 : data.originalDuration;

    // Invert the cached cumulative integral; monotone interpolation keeps the
    // result monotone in playbackTime without re-integrating per step.
    const cache = this.ensureIntegralTable(data);
    let sourceTime = this.sourceTimeForCumulativePlayback(cache, playbackTime);
    if (data.reverse) {
      sourceTime = data.originalDuration - sourceTime;
    }

    return Math.max(0, Math.min(data.originalDuration, sourceTime));
  }

  /** Lazily build (or return) the clip's cumulative moving-time integral. */
  private ensureIntegralTable(data: ClipSpeedData): SpeedIntegralCache {
    let cache = this.integralCaches.get(data.clipId);
    if (!cache) {
      cache = this.buildIntegralTable(data);
      this.integralCaches.set(data.clipId, cache);
    }
    return cache;
  }

  /**
   * Integrate the speed curve into a cumulative table over source time. The
   * domain is segmented at the keyframe kinks so quadrature and interpolation
   * never straddle an easing boundary, and each segment is subdivided finely
   * enough that linear interpolation of the inverse stays within
   * SOURCE_TIME_TOLERANCE source seconds. Segment counts derive from a
   * bounded slope estimate (smooth easings stay near slope ~3, so 4x the
   * mean slope is a safe envelope; elastic/bounce/back can exceed it, which
   * only loosens the inverse error — still within the legacy 1e-4 source
   * tolerance), and per-segment values are 2-point Gauss quadrature, which
   * resolves smooth segments to well below the duration tests' 5-decimal
   * tolerance.
   */
  private buildIntegralTable(data: ClipSpeedData): SpeedIntegralCache {
    const total = data.originalDuration;
    if (!(total > 0)) {
      return {
        sampleTimes: Float64Array.of(0),
        cumulative: Float64Array.of(0),
        movingDuration: 0,
      };
    }

    const bounds: number[] = [0];
    for (const kf of data.keyframes) {
      if (kf.time > 0 && kf.time < total && kf.time > bounds[bounds.length - 1]) {
        bounds.push(kf.time);
      }
    }
    bounds.push(total);

    // Size each segment's sample count from the inverse-interpolation error
    // model: linear interpolation of the inverse errs by ~h^2/8 * |ds/dt| / s.
    const perSegment: number[] = [];
    for (let s = 0; s < bounds.length - 1; s++) {
      const span = bounds[s + 1] - bounds[s];
      if (!(span > 0)) {
        perSegment.push(0);
        continue;
      }
      const speedA = this.getSpeedAtSourceTime(data, bounds[s]);
      const speedB = this.getSpeedAtSourceTime(data, bounds[s + 1]);
      const slopeBound = (4 * Math.abs(speedB - speedA)) / span;
      const speedFloor = Math.max(Math.min(speedA, speedB), SPEED_MIN);
      const step = Math.sqrt(
        (8 * SOURCE_TIME_TOLERANCE * speedFloor) / Math.max(slopeBound, 1e-12),
      );
      perSegment.push(
        Math.min(Math.max(Math.ceil(span / step), 2), MAX_SEGMENT_SAMPLES),
      );
    }
    let planned = 0;
    for (const n of perSegment) planned += n;
    if (planned > MAX_TOTAL_SAMPLES) {
      const scale = MAX_TOTAL_SAMPLES / planned;
      for (let i = 0; i < perSegment.length; i++) {
        perSegment[i] = Math.max(2, Math.floor(perSegment[i] * scale));
      }
    }

    let count = 0;
    for (const n of perSegment) count += n;
    const sampleTimes = new Float64Array(count);
    const cumulative = new Float64Array(count);
    const gaussShift = 1 / Math.sqrt(3);
    let moving = 0;
    let w = 0;
    for (let s = 0; s < bounds.length - 1; s++) {
      const n = perSegment[s];
      if (n <= 0) continue;
      const a = bounds[s];
      const step = (bounds[s + 1] - a) / n;
      for (let i = 1; i <= n; i++) {
        const mid = a + (i - 0.5) * step;
        const delta = (step / 2) * gaussShift;
        moving +=
          (step / 2) *
          (1 / this.getSpeedAtSourceTime(data, mid - delta) +
            1 / this.getSpeedAtSourceTime(data, mid + delta));
        sampleTimes[w] = a + i * step;
        cumulative[w] = moving;
        w++;
      }
    }

    return { sampleTimes, cumulative, movingDuration: moving };
  }

  /** Inverse of the cumulative table: source time whose moving playback time
   * equals the query. Monotone because the table is strictly increasing. */
  private sourceTimeForCumulativePlayback(
    cache: SpeedIntegralCache,
    playbackTime: number,
  ): number {
    const { sampleTimes, cumulative } = cache;
    const last = cumulative.length - 1;
    if (playbackTime <= 0) return 0;
    if (playbackTime >= cache.movingDuration) return sampleTimes[last];
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < playbackTime) lo = mid + 1;
      else hi = mid;
    }
    const tLow = lo === 0 ? 0 : sampleTimes[lo - 1];
    const fLow = lo === 0 ? 0 : cumulative[lo - 1];
    const tHigh = sampleTimes[lo];
    const fSpan = cumulative[lo] - fLow;
    if (!(fSpan > 0)) return tHigh;
    return Math.min(
      sampleTimes[last],
      Math.max(0, tLow + ((playbackTime - fLow) / fSpan) * (tHigh - tLow)),
    );
  }
  // Pitch Correction
  // No integral invalidation: pitch correction never affects the mapping.
  setPitchCorrection(clipId: string, enabled: boolean): void {
    const data = this.clipSpeedData.get(clipId);
    if (data) {
      data.pitchCorrection = enabled;
    }
  }

  isPitchCorrectionEnabled(clipId: string): boolean {
    const data = this.clipSpeedData.get(clipId);
    return data?.pitchCorrection ?? true;
  }

  getInterpolationInfo(
    clipId: string,
    playbackTime: number,
    sourceFrameRate: number,
  ): {
    needsInterpolation: boolean;
    frameBefore: number;
    frameAfter: number;
    t: number;
  } {
    const sourceTime = this.getSourceTimeAtPlaybackTime(clipId, playbackTime);
    const frameDuration = 1 / sourceFrameRate;
    const exactFrame = sourceTime / frameDuration;
    const frameBeforeIndex = Math.floor(exactFrame);
    const frameAfterIndex = frameBeforeIndex + 1;
    const t = exactFrame - frameBeforeIndex;

    const needsInterpolation = t > 0.01 && t < 0.99;

    return {
      needsInterpolation,
      frameBefore: frameBeforeIndex * frameDuration,
      frameAfter: frameAfterIndex * frameDuration,
      t,
    };
  }
  private getOrCreateSpeedData(
    clipId: string,
    originalDuration: number,
  ): ClipSpeedData {
    let data = this.clipSpeedData.get(clipId);
    if (!data) {
      data = {
        clipId,
        baseSpeed: 1,
        reverse: false,
        keyframes: [],
        pitchCorrection: true,
        freezeFrames: [],
        originalDuration,
      };
      this.clipSpeedData.set(clipId, data);
    }
    if (data.originalDuration !== originalDuration) {
      // The integral domain is [0, originalDuration]; rescaling it invalidates.
      this.invalidateSpeedIntegral(clipId);
    }
    data.originalDuration = originalDuration;
    return data;
  }

  initializeClip(clipId: string, originalDuration: number): void {
    this.getOrCreateSpeedData(clipId, originalDuration);
  }

  removeClip(clipId: string): void {
    this.clipSpeedData.delete(clipId);
    this.integralCaches.delete(clipId);
  }

  getClipIds(): string[] {
    return Array.from(this.clipSpeedData.keys());
  }

  getClipSpeedData(clipId: string): ClipSpeedData | undefined {
    return this.clipSpeedData.get(clipId);
  }

  clear(): void {
    this.clipSpeedData.clear();
    this.integralCaches.clear();
  }
}
let speedEngineInstance: SpeedEngine | null = null;

export function getSpeedEngine(): SpeedEngine {
  if (!speedEngineInstance) {
    speedEngineInstance = new SpeedEngine();
  }
  return speedEngineInstance;
}
