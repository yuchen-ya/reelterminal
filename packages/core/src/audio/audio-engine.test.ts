import { describe, it, expect } from "vitest";
import { AudioEngine, detectSilenceRangesInPcm } from "./audio-engine";

const RATE = 8000;

/** Mono PCM: 6s, tone (amplitude 0.5) between startSec and endSec, zeros elsewhere. */
function pcmWithTone(startSec: number, endSec: number, amplitude = 0.5, duration = 6): Float32Array {
  const pcm = new Float32Array(RATE * duration);
  for (let i = Math.round(startSec * RATE); i < Math.round(endSec * RATE); i++) {
    pcm[i] = amplitude * Math.sin(i * 0.05);
  }
  return pcm;
}

function fakeBuffer(data: Float32Array) {
  return {
    getChannelData: () => data,
    sampleRate: RATE,
    duration: data.length / RATE,
  } as unknown as AudioBuffer;
}

describe("detectSilenceRangesInPcm", () => {
  it("reports one range over all-silent PCM", () => {
    // Defaults apply padding and the minimum duration even to a single range.
    expect(detectSilenceRangesInPcm(new Float32Array(RATE * 6), RATE, -40, 0.5, 0.1)).toEqual([{ start: 0.1, end: 5.9 }]);
    // Raw scan (no padding/minimum) covers the whole buffer.
    expect(detectSilenceRangesInPcm(new Float32Array(RATE * 6), RATE, -40, 0, 0)).toEqual([{ start: 0, end: 6 }]);
  });

  it("finds silent gaps around a tone with GUI defaults (padding + min duration)", () => {
    const ranges = detectSilenceRangesInPcm(pcmWithTone(2, 4), RATE, -40, 0.5, 0.1);
    expect(ranges).toEqual([
      { start: 0.1, end: 1.9 },
      { start: 4.1, end: 5.9 },
    ]);
  });

  it("drops ranges shorter than minDurationSec and keeps exact-length ones", () => {
    // Silent window [0, 0.5): exactly 0.5s — kept with minDurationSec 0.5.
    const pcm = new Float32Array(RATE * 2);
    for (let i = Math.round(0.5 * RATE); i < pcm.length; i++) pcm[i] = 0.5;
    expect(detectSilenceRangesInPcm(pcm, RATE, -40, 0.5, 0)).toEqual([{ start: 0, end: 0.5 }]);
    expect(detectSilenceRangesInPcm(pcm, RATE, -40, 0.500001, 0)).toEqual([]);
  });

  it("applies padding on both sides and clamps to the PCM duration", () => {
    const ranges = detectSilenceRangesInPcm(pcmWithTone(3, 3.5), RATE, -40, 0, 0.25);
    // Ranges [0,3] and [3.5,6] padded to [0.25,2.75] and [3.75,5.75].
    expect(ranges).toEqual([
      { start: 0.25, end: 2.75 },
      { start: 3.75, end: 5.75 },
    ]);
  });

  it("judges silence against the dBFS threshold on window max amplitude", () => {
    // 0.009 amplitude is below −40 dBFS (0.01 linear): everything is silent.
    expect(detectSilenceRangesInPcm(pcmWithTone(0, 6, 0.009), RATE, -40, 0, 0)).toEqual([{ start: 0, end: 6 }]);
    // 0.02 amplitude is above it: nothing is silent.
    expect(detectSilenceRangesInPcm(pcmWithTone(0, 6, 0.02), RATE, -40, 0, 0)).toEqual([]);
  });

  it("AudioEngine.detectSilence delegates to the same kernel with no post-filtering (GUI semantics)", () => {
    const engine = new AudioEngine();
    const data = pcmWithTone(2, 4, 0.5);
    // Raw scan: no padding, no minimum — the GUI bridge applies its own filters.
    expect(engine.detectSilence(fakeBuffer(data), -40)).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ]);
    // Default threshold remains −60 dB.
    expect(engine.detectSilence(fakeBuffer(new Float32Array(RATE * 2)))).toEqual([{ start: 0, end: 2 }]);
  });
});
