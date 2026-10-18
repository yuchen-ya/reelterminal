/**
 * AUD-10 real-sample acceptance, mirroring the 2026-10-18 evaluation cases.
 *
 * The evaluation workspace lives outside the repository and is optional, so
 * this suite skips when `REELTERMINAL_AUDIO_EVAL` is unset. It exercises the
 * pure PCM kernel against the same π speech,
 * BGM and Chinese-speech samples used in the audit; synthetic unit coverage
 * remains the CI gate.
 */
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { estimateSyncOffsetFromPcm, type ResolvedSyncOffsetParams, type SyncOffsetReference } from "./sync-offset";

const RATE = 16000;
const AUDIO_DIR = process.env.REELTERMINAL_AUDIO_EVAL ?? "";
const PI = join(AUDIO_DIR, "pi_full_16k_mono.wav");
const MUSIC = join(AUDIO_DIR, "pi_bgm_bed_44k.wav");
const ZH = join(AUDIO_DIR, "zh_2spk_clean_16k.wav");
const samplesPresent = [PI, MUSIC, ZH].every((path) => existsSync(path));
const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;

function decode(path: string, seconds: number, startSec = 0): Float32Array {
  const output = execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(startSec), "-t", String(seconds), "-i", path,
    "-map", "0:a:0", "-vn", "-ar", String(RATE), "-ac", "1", "-f", "f32le", "pipe:1",
  ], { maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  const samples = new Float32Array(output.length / 4);
  for (let index = 0; index < samples.length; index++) samples[index] = output.readFloatLE(index * 4);
  return samples;
}

function delayed(signal: Float32Array, offsetSamples: number): Float32Array {
  const out = new Float32Array(signal.length);
  if (offsetSamples > 0) out.set(signal.subarray(0, signal.length - offsetSamples), offsetSamples);
  else out.set(signal.subarray(-offsetSamples), 0);
  return out;
}

function noisy(signal: Float32Array, snrDb: number, seed = 7): Float32Array {
  let state = seed >>> 0;
  const out = signal.slice();
  let signalPower = 0;
  for (const sample of out) signalPower += sample * sample;
  const amplitude = Math.sqrt(signalPower / out.length) * 10 ** (-snrDb / 20);
  for (let index = 0; index < out.length; index++) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[index] += ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 * amplitude - amplitude;
  }
  return out;
}

function drift(signal: Float32Array, factor: number): Float32Array {
  const length = Math.floor((signal.length - 1) / factor);
  const out = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const position = index * factor;
    const base = Math.floor(position);
    const fraction = position - base;
    out[index] = signal[base]! * (1 - fraction) + signal[Math.min(base + 1, signal.length - 1)]! * fraction;
  }
  return out;
}

const reference: SyncOffsetReference = {
  mediaId: "reference",
  name: "reference",
  path: "reference",
  startSec: 0,
  endSec: 1,
  durationSec: 1,
  sourceFingerprint: { size: 1, lastModified: 1 },
};

function params(overrides: Partial<ResolvedSyncOffsetParams> = {}): ResolvedSyncOffsetParams {
  return { referenceMediaId: "reference", referenceStartSec: 0, searchRangeSec: 2, windowSec: 30, guardSec: 0.05, ...overrides };
}

function estimate(referencePcm: Float32Array, targetPcm: Float32Array, tuning = params()) {
  return estimateSyncOffsetFromPcm(referencePcm, targetPcm, {
    targetRange: { startSec: 0, endSec: referencePcm.length / RATE },
    referenceRange: { startSec: 0, endSec: referencePcm.length / RATE },
    params: tuning,
    reference,
  });
}

describe.skipIf(!samplesPresent || !ffmpegAvailable)("AUD-10 real-sample acceptance", () => {
  it("recovers known +350 ms and -200 ms offsets", () => {
    const pi = decode(PI, 30);
    const plus = estimate(pi, delayed(pi, Math.round(0.35 * RATE)));
    expect(plus.verdict).toBe("ok");
    expect(Math.abs(plus.offsetMs! - 350)).toBeLessThan(0.5);
    const minus = estimate(pi, delayed(pi, -Math.round(0.2 * RATE)));
    expect(minus.verdict).toBe("ok");
    expect(Math.abs(minus.offsetMs! + 200)).toBeLessThan(0.5);
  }, 60000);

  it("survives +350 ms with 10 dB noise", () => {
    const pi = decode(PI, 30);
    const result = estimate(pi, noisy(delayed(pi, Math.round(0.35 * RATE)), 10));
    expect(result.verdict).toBe("ok");
    expect(Math.abs(result.offsetMs! - 350)).toBeLessThan(1);
  }, 60000);

  it("recovers a +250 ms offset on the repetitive BGM bed", () => {
    const music = decode(MUSIC, 40);
    const result = estimate(music, delayed(music, Math.round(0.25 * RATE)));
    expect(result.verdict).toBe("ok");
    expect(Math.abs(result.offsetMs! - 250)).toBeLessThan(0.5);
  }, 60000);

  it("refuses unrelated Chinese speech vs the π audio", () => {
    const pi = decode(PI, 30);
    const zh = decode(ZH, 30);
    const result = estimate(pi, zh);
    expect(result.verdict).not.toBe("ok");
    expect(result.fixedOffsetSupported).toBe(false);
  }, 60000);

  it("detects 0.1% clock drift instead of reporting one fixed offset", () => {
    const pi = decode(PI, 120);
    const drifting = drift(pi, 1.001);
    const length = Math.min(pi.length, drifting.length);
    const result = estimate(pi.subarray(0, length), drifting.subarray(0, length), params({ windowSec: 30, searchRangeSec: 1 }));
    expect(result.drift.detected).toBe(true);
    expect(result.verdict).toBe("clock-drift");
    expect(result.fixedOffsetSupported).toBe(false);
    expect(Math.abs(result.drift.driftPpm! + 1000)).toBeLessThan(150);
  }, 120000);
});
