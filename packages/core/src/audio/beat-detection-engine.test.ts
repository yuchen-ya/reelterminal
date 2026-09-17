import { describe, it, expect } from "vitest";
import { analyzeBeatsInPcm, BeatDetectionEngine } from "./beat-detection-engine";

/** 22050 Hz — the analysis rate the agent facade uses for beat grids. */
const RATE = 22050;
/** 0.12s burst with a sharp attack and exponential decay, like a musical hit. */
const BURST_SAMPLES = Math.round(0.12 * RATE);

/** Mono PCM with sharp-attack decaying bursts at every given time. */
function burstPcm(times: number[], duration: number): Float32Array {
  const pcm = new Float32Array(RATE * duration);
  for (const time of times) {
    const base = Math.round(time * RATE);
    for (let i = 0; i < BURST_SAMPLES && base + i < pcm.length; i++) {
      pcm[base + i] = 0.8 * Math.sin(i * 0.6) * Math.exp(-i / 600);
    }
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

describe("analyzeBeatsInPcm (shared beat kernel)", () => {
  it("finds the grid of a steady burst train with high confidence", async () => {
    const result = await analyzeBeatsInPcm(burstPcm([.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5], 6), RATE);
    expect(result.bpm).toBeGreaterThan(100);
    expect(result.bpm).toBeLessThan(140);
    expect(result.confidence).toBeGreaterThan(.7);
    expect(result.beats.length).toBeGreaterThanOrEqual(10);
    expect(result.beats[0]!.index).toBe(0);
    expect(Math.abs(result.beats[0]!.time - 0.5)).toBeLessThan(0.15);
    // Beats are sequential and every strength is populated.
    result.beats.forEach((beat, i) => {
      expect(beat.index).toBe(i);
      expect(beat.strength).toBeGreaterThan(0);
    });
  });

  it("reports zero confidence on silence without throwing", async () => {
    const result = await analyzeBeatsInPcm(new Float32Array(RATE * 6), RATE);
    expect(result.bpm).toBe(120); // default fallback bpm
    expect(result.confidence).toBe(0);
    expect(result.duration).toBeCloseTo(6, 5);
  });

  it("honors detection config overrides", async () => {
    // A config scaled to the sample rate (the 8kHz audio summary uses the
    // same time-domain proportions) still locks onto the grid.
    const at8k = 8000;
    const pcm = new Float32Array(at8k * 6);
    for (const time of [.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]) {
      const base = Math.round(time * at8k);
      for (let i = 0; i < 160 && base + i < pcm.length; i++) {
        pcm[base + i] = 0.8 * Math.sin(i * 0.6) * (1 - i / 160);
      }
    }
    const result = await analyzeBeatsInPcm(pcm, at8k, { windowSize: 384, hopSize: 96 });
    expect(result.bpm).toBeGreaterThan(100);
    expect(result.bpm).toBeLessThan(140);
    expect(result.confidence).toBeGreaterThan(.7);
  });

  it("analyzeAudioBuffer delegates to the same implementation as analyzePcm", async () => {
    const pcm = burstPcm([.5, 1, 1.5, 2, 2.5, 3, 3.5], 6);
    const engine = new BeatDetectionEngine();
    const viaBuffer = await engine.analyzeAudioBuffer(fakeBuffer(pcm));
    const viaPcm = await engine.analyzePcm(Float32Array.from(pcm), RATE);
    expect(viaBuffer).toEqual(viaPcm);
    expect(viaBuffer.beats.length).toBeGreaterThan(0);
    expect(viaBuffer.duration).toBeCloseTo(6, 5);
  });
});
