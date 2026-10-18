import { describe, expect, it } from "vitest";

import {
  estimateSyncOffsetFromPcm,
  gccPhatDelay,
  planSyncOffsetWindows,
  resolveSyncOffsetParams,
  summarizeSyncDrift,
  type SyncOffsetReference,
} from "./sync-offset";

const SR = 16000;

function noise(length: number, seed: number): Float32Array {
  let state = seed >>> 0;
  const out = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[index] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  return out;
}

function delayed(signal: Float32Array, offsetSamples: number): Float32Array {
  if (offsetSamples === 0) return signal.slice();
  const out = new Float32Array(signal.length);
  if (offsetSamples > 0) out.set(signal.subarray(0, signal.length - offsetSamples), offsetSamples);
  else out.set(signal.subarray(-offsetSamples), 0);
  return out;
}

function reference(overrides: Partial<SyncOffsetReference> = {}): SyncOffsetReference {
  return {
    mediaId: "ref-media",
    name: "reference.wav",
    path: "reference.wav",
    startSec: 0,
    endSec: 5,
    durationSec: 5,
    sourceFingerprint: { size: 1, lastModified: 1 },
    ...overrides,
  };
}

describe("syncOffset parameter validation", () => {
  it("applies documented defaults and rejects unknown/missing references", () => {
    expect(resolveSyncOffsetParams({ referenceMediaId: "m1" })).toEqual({
      referenceMediaId: "m1",
      referenceStartSec: 0,
      searchRangeSec: 2,
      windowSec: 30,
      guardSec: 0.05,
    });
    expect(() => resolveSyncOffsetParams(undefined)).toThrow(/required/);
    expect(() => resolveSyncOffsetParams({ referenceMediaId: "" })).toThrow(/referenceMediaId/);
    expect(() => resolveSyncOffsetParams({ referenceMediaId: "m1", searchRangeSec: 6 })).toThrow(/searchRangeSec/);
    expect(() => resolveSyncOffsetParams({ referenceMediaId: "m1", windowSec: 5 })).toThrow(/windowSec/);
    // A 10 s window with a 5 s search has only half the window as overlap.
    expect(() => resolveSyncOffsetParams({ referenceMediaId: "m1", windowSec: 10, searchRangeSec: 5 })).toThrow(/4 ×/);
  });
});

describe("GCC-PHAT sign contract", () => {
  it("reports a positive offset when the target lags the reference", () => {
    const ref = noise(5 * SR, 1);
    const result = gccPhatDelay(ref, delayed(ref, Math.round(0.35 * SR)), { sampleRate: SR, searchRangeSec: 1 });
    expect(result.verdict).toBe("ok");
    // The raw GCC peak has the opposite sign; the public offset is the contract.
    expect(result.rawPeakLagSamples).toBeLessThan(0);
    expect(result.offsetSec).toBeGreaterThan(0.349);
    expect(result.offsetSec).toBeLessThan(0.351);
  });

  it("reports a negative offset when the target leads the reference", () => {
    const ref = noise(5 * SR, 2);
    const result = gccPhatDelay(ref, delayed(ref, -Math.round(0.2 * SR)), { sampleRate: SR, searchRangeSec: 1 });
    expect(result.verdict).toBe("ok");
    expect(result.rawPeakLagSamples).toBeGreaterThan(0);
    expect(result.offsetSec).toBeGreaterThan(-0.201);
    expect(result.offsetSec).toBeLessThan(-0.199);
  });

  it("reports zero for a sample-aligned copy", () => {
    const ref = noise(2 * SR, 3);
    const result = gccPhatDelay(ref, ref.slice(), { sampleRate: SR, searchRangeSec: 1 });
    expect(result.verdict).toBe("ok");
    expect(Math.abs(result.offsetSec)).toBeLessThan(1 / SR);
  });
});

describe("GCC-PHAT rejection rule", () => {
  it("refuses unrelated content instead of inventing a match", () => {
    const ref = noise(5 * SR, 4);
    const target = noise(5 * SR, 5);
    const result = gccPhatDelay(ref, target, { sampleRate: SR, searchRangeSec: 1 });
    expect(result.verdict).not.toBe("ok");
  });

  it("marks a strong peak ambiguous when a competing arrival is within 3 dB", () => {
    // Two non-overlapping, equally strong copies of the same 1.5 s noise
    // burst: one at 0 s, one at 2 s. Both produce a full-amplitude peak, so
    // the 3 dB second-peak rule must refuse to choose one.
    const burst = noise(Math.round(1.5 * SR), 6);
    const ref = new Float32Array(3 * SR);
    ref.set(burst);
    const target = new Float32Array(3.5 * SR);
    target.set(burst);
    target.set(burst, 2 * SR);
    const result = gccPhatDelay(ref, target, { sampleRate: SR, searchRangeSec: 2.5 });
    expect(result.prominenceDb).toBeGreaterThanOrEqual(6);
    expect(result.marginToSecondPeakDb).toBeLessThan(3);
    expect(result.verdict).toBe("ambiguous");
  });
});

describe("syncOffset window planning", () => {
  it("uses one window for short ranges and fixed windows otherwise", () => {
    expect(planSyncOffsetWindows(12, 30)).toEqual([{ startSec: 0, endSec: 12 }]);
    expect(planSyncOffsetWindows(120, 30)).toEqual([
      { startSec: 0, endSec: 30 },
      { startSec: 30, endSec: 60 },
      { startSec: 60, endSec: 90 },
      { startSec: 90, endSec: 120 },
    ]);
    const partial = planSyncOffsetWindows(100, 30);
    expect(partial).toHaveLength(4);
    expect(partial[2]).toEqual({ startSec: 60, endSec: 90 });
    // The last equal-length window overlaps backwards to cover the remainder.
    expect(partial[3]).toEqual({ startSec: 70, endSec: 100 });  });
});

describe("syncOffset drift summary", () => {
  it("detects a monotonic 0.1% drift and never treats it as one fixed offset", () => {
    const windows = [0, 30, 60, 90].map((midTimeSec) => ({ midTimeSec, offsetSec: midTimeSec * 0.001 }));
    const drift = summarizeSyncDrift(windows);
    expect(drift.detected).toBe(true);
    expect(drift.driftPpm).toBeCloseTo(1000, 3);
    expect(drift.rSquared).toBeCloseTo(1, 3);
  });

  it("does not flag jitter around one fixed offset", () => {
    const windows = [0, 30, 60, 90].map((midTimeSec, index) => ({
      midTimeSec,
      offsetSec: 0.25 + (index % 2 === 0 ? 0.0001 : -0.0001),
    }));
    expect(summarizeSyncDrift(windows).detected).toBe(false);
  });
});

describe("syncOffset aggregation over windows", () => {
  it("reports the median offset, every window and the fixed-offset verdict", () => {
    const ref = noise(6 * SR, 7);
    const target = delayed(ref, Math.round(0.125 * SR));
    const facts = estimateSyncOffsetFromPcm(ref, target, {
      targetRange: { startSec: 10, endSec: 16 },
      referenceRange: { startSec: 2, endSec: 8 },
      params: { referenceMediaId: "ref-media", referenceStartSec: 2, searchRangeSec: 1, windowSec: 10, guardSec: 0.05 },
      reference: reference(),
    });
    expect(facts.verdict).toBe("ok");
    expect(facts.fixedOffsetSupported).toBe(true);
    expect(facts.offsetSec).toBeCloseTo(0.125, 3);
    expect(facts.windows).toHaveLength(1);
    expect(facts.windows[0]).toMatchObject({ startSec: 10, endSec: 16, verdict: "ok" });
    expect(facts.analyzedDurationSec).toBe(6);
    expect(facts.truncated).toBe(false);
  });

  it("discloses silent windows and refuses when no window is usable", () => {
    const silence = new Float32Array(6 * SR);
    const facts = estimateSyncOffsetFromPcm(silence, silence, {
      targetRange: { startSec: 0, endSec: 6 },
      referenceRange: { startSec: 0, endSec: 6 },
      params: { referenceMediaId: "ref-media", referenceStartSec: 0, searchRangeSec: 1, windowSec: 10, guardSec: 0.05 },
      reference: reference(),
    });
    expect(facts.verdict).toBe("no-match");
    expect(facts.fixedOffsetSupported).toBe(false);
    expect(facts.offsetSec).toBeNull();
    expect(facts.windows[0]!.verdict).toBe("silent");
  });
});
