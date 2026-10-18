import { describe, expect, it } from "vitest";

import {
  SilenceWindowScanner,
  detectSilenceRangesInPcm,
  postprocessSilenceRanges,
  scanSilenceWindowsInPcm,
} from "./audio-engine";
import {
  analyzeBeatsFromOnsetEnergies,
  analyzeBeatsInPcm,
  computeRawBeatEnergies,
} from "./beat-detection-engine";

/** Deterministic pseudo-random PCM so regressions are reproducible. */
function pseudoRandomPcm(length: number, seed = 0x5eed): Float32Array {
  let state = seed >>> 0;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  return out;
}

/** Random chunk sizes, including sizes that straddle window/frame boundaries. */
function randomChunkSizes(length: number, maxChunk: number, seed = 0xabc): number[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const sizes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    const take = Math.max(1, Math.min(remaining, Math.round(next() * maxChunk) + 1));
    sizes.push(take);
    remaining -= take;
  }
  return sizes;
}

describe("SilenceWindowScanner equivalence (AUD-11)", () => {
  it("matches detectSilenceRangesInPcm exactly for arbitrary chunkings", () => {
    for (const rate of [8000, 22050, 44100]) {
      for (const thresholdDb of [-60, -40, -20]) {
        const pcm = pseudoRandomPcm(rate * 3 + 777, rate + thresholdDb);
        // Force long silent and loud stretches so runs span chunk boundaries.
        for (let i = rate; i < rate * 2; i++) pcm[i] = pcm[i]! * 0.0001;
        const reference = detectSilenceRangesInPcm(pcm, rate, thresholdDb, 0.2, 0.05);
        for (const maxChunk of [1, 97, 800, 50_000]) {
          const scanner = new SilenceWindowScanner(rate, thresholdDb);
          let offset = 0;
          for (const size of randomChunkSizes(pcm.length, maxChunk, maxChunk)) {
            scanner.push(pcm.subarray(offset, offset + size));
            offset += size;
          }
          const streamed = postprocessSilenceRanges(scanner.finish(), scanner.totalSamples / rate, 0.2, 0.05);
          expect(streamed).toEqual(reference);
        }
      }
    }
  });

  it("reports a trailing partial window like the buffered kernel", () => {
    const rate = 8000;
    const pcm = new Float32Array(rate + 123); // all silence
    const reference = detectSilenceRangesInPcm(pcm, rate, -40, 0, 0);
    const scanner = new SilenceWindowScanner(rate, -40);
    scanner.push(pcm);
    expect(postprocessSilenceRanges(scanner.finish(), scanner.totalSamples / rate, 0, 0)).toEqual(reference);
    expect(reference.length).toBe(1);
  });

  it("postprocess is identical to the kernel's own padding/min-duration stage", () => {
    const rate = 8000;
    const pcm = pseudoRandomPcm(rate, 7);
    for (const minDuration of [0, 0.2, 0.5]) {
      for (const padding of [0, 0.05, 0.1]) {
        expect(postprocessSilenceRanges(scanSilenceWindowsInPcm(pcm, rate, -30), pcm.length / rate, minDuration, padding))
          .toEqual(detectSilenceRangesInPcm(pcm, rate, -30, minDuration, padding));
      }
    }
  });
});

describe("raw beat energy entry points (AUD-11 refactor)", () => {
  it("whole-buffer energies + analyzeBeatsFromOnsetEnergies reproduce analyzeBeatsInPcm exactly", async () => {
    const rate = 8000;
    const pcm = pseudoRandomPcm(rate * 5, 99);
    // Add periodic attacks so onset detection has real peaks to find.
    for (let beat = 0; beat < 10; beat++) {
      for (let offset = 0; offset < 400; offset++) {
        const index = beat * 4000 + offset;
        pcm[index] = 0.9 * Math.sin(offset * 0.05) * Math.exp(-offset / 120);
      }
    }
    for (const config of [{ windowSize: 384, hopSize: 96 }, {}] as const) {
      const reference = await analyzeBeatsInPcm(pcm, rate, config);
      const streamed = await analyzeBeatsFromOnsetEnergies(
        computeRawBeatEnergies(pcm, config),
        rate,
        pcm.length / rate,
        config,
      );
      expect(streamed).toEqual(reference);
    }
  });
});
