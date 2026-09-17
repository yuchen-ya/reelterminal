import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeLocalAudio, analyzeSilence, analyzeBeatGrid, audioAnalysisPreflight, summarizePcm, DEFAULT_SILENCE_ANALYSIS_PARAMS } from "./audio-analysis";
import { createAgentFacade } from "./index";

function pcm(times: number[], duration = 6) {
  const data = Buffer.alloc(8000 * duration * 8);
  for (const time of times) for (let i = 0; i < 160; i++) {
    const sample = .8 * Math.sin(i * .6) * (1 - i / 160);
    data.writeFloatLE(sample, (Math.round(time * 8000) + i) * 8);
    data.writeFloatLE(-sample, (Math.round(time * 8000) + i) * 8 + 4);
  }
  return data;
}
/** Tone (in-phase so the ffmpeg mono downmix keeps it) between startSec and endSec. */
function tonePcm(ranges: Array<{ startSec: number; endSec: number }>, duration = 6) {
  const data = Buffer.alloc(8000 * duration * 8);
  for (const range of ranges) for (let i = Math.round(range.startSec * 8000); i < Math.round(range.endSec * 8000); i++) {
    const sample = .5 * Math.sin(i * .05);
    data.writeFloatLE(sample, i * 8);
    data.writeFloatLE(sample, i * 8 + 4);
  }
  return data;
}
/** 0.12s sharp-attack bursts at each time — beat content the shared kernel locks onto. */
function burstPcm(times: number[], duration = 6) {
  const data = Buffer.alloc(8000 * duration * 8);
  for (const time of times) for (let i = 0; i < 960; i++) {
    const index = Math.round(time * 8000) + i;
    if (index * 8 + 5 >= data.length) break;
    const sample = .8 * Math.sin(i * .06) * Math.exp(-i / 220);
    data.writeFloatLE(sample, index * 8);
    data.writeFloatLE(sample, index * 8 + 4);
  }
  return data;
}
function wav(data: Buffer, channels = 2, rate = 8000) {
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * 4, 28); header.writeUInt16LE(channels * 4, 32); header.writeUInt16LE(32, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("local audio analysis", () => {
  it("detects known transients, preserves anti-phase channels and reports source offsets", async () => {
    const result = await summarizePcm(pcm([.5, 1, 1.5, 2, 2.5, 3, 3.5]), 10);
    expect(result.onsets).toEqual([10.5, 11, 11.5, 12, 12.5, 13, 13.5]);
    // The beat placeholders are gone: request the beatGrid type instead.
    expect(Object.keys(result)).not.toContain("downbeats");
    expect(Object.keys(result)).not.toContain("beatGrid");
    expect(result.waveform[1].bins.length).toBeLessThanOrEqual(600);
    // Silence ranges come from the shared core kernel: gaps between clicks are
    // ≥ the 0.2s minimum, so they are reported (leading/trailing included).
    expect(result.silence[0]).toEqual({ startSec: 10, endSec: 10.5 });
    expect(result.silence.at(-1)).toEqual({ startSec: 13.6, endSec: 16 });
    expect(result.silenceCount).toBe(8);
  });
  it("derives bpmCandidates from the shared beat kernel only above its confidence gate", async () => {
    // A click train spanning the whole buffer matches the kernel's beat grid.
    const steady = await summarizePcm(pcm([.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]), 0);
    expect(steady.bpmCandidates).toHaveLength(1);
    const candidate = steady.bpmCandidates[0]!;
    expect(candidate.bpm).toBeGreaterThan(100);
    expect(candidate.bpm).toBeLessThan(135);
    expect(candidate.confidence).toBeGreaterThan(.7);
    // Silence forces zero confidence: no bpm candidates are invented.
    const silent = await summarizePcm(pcm([]), 0);
    expect(silent.bpmCandidates).toEqual([]);
    expect(silent.silence).toEqual([{ startSec: 0, endSec: 6 }]);
    expect(await summarizePcm(pcm([.3, .77, 1.6, 2.8, 3.13, 4.01]), 0).then((r) => r.bpmCandidates)).toEqual([]);
  });
  it("runs real FFmpeg loudness, bounded jobs and cancellation without changing revision", async () => {
    expect((await audioAnalysisPreflight()).available).toBe(true);
    const root = await mkdtemp(join(tmpdir(), "rt-audio-fixture-"));
    try {
      const path = join(root, "clicks.wav");
      await writeFile(path, wav(pcm([.5, 1, 1.5, 2, 2.5, 3])));
      const result = await analyzeLocalAudio(path, { startSec: 0, endSec: 6 }, new AbortController().signal);
      expect(result.channels).toBe(2); expect(result.sampleRate).toBe(8000);
      expect(result.integratedLufs).not.toBeNull(); expect(result.truePeakDbtp).not.toBeNull();
      await expect(analyzeLocalAudio(path, { startSec: 0, endSec: 121 }, new AbortController().signal)).rejects.toThrow("120");
      const silentPath = join(root, "silence.wav");
      await writeFile(silentPath, wav(pcm([])));
      const silentResult = await analyzeLocalAudio(silentPath, { startSec: 1, endSec: 3 }, new AbortController().signal);
      expect(silentResult.integratedLufs).toBeNull();
      expect(silentResult.silence).toEqual([{ startSec: 1, endSec: 3 }]);
      expect(silentResult.onsets).toEqual([]);
      const monoPath = join(root, "mono-44100.wav");
      await writeFile(monoPath, wav(Buffer.alloc(44100 * 4), 1, 44100));
      const monoResult = await analyzeLocalAudio(monoPath, { startSec: 0, endSec: 1 }, new AbortController().signal);
      expect(monoResult.channels).toBe(1); expect(monoResult.sampleRate).toBe(44100);
      expect(monoResult.durationSec).toBeCloseTo(1, 2);
      const controller = new AbortController(); controller.abort();
      await expect(analyzeLocalAudio(path, { startSec: 0, endSec: 6 }, controller.signal)).rejects.toThrow("Cancelled");
      const facade = createAgentFacade({ mediaRoots: [root] });
      await facade["project.create"]({ name: "Audio test" });
      const imported = await facade["media.import"]({ path });
      if (!imported.ok) throw new Error(imported.error.message);
      const before = await facade["project.get_state"]();
      const started = await facade["media.analyze_start"]({ mediaId: imported.value.mediaId, analysisTypes: ["audioSummary"], startSec: 0, endSec: 6 });
      if (!started.ok) throw new Error(started.error.message);
      let status;
      for (let i = 0; i < 200; i++) {
        status = await facade["job.status"]({ jobId: started.value.jobId });
        if (status.ok && ["done", "error", "cancelled"].includes(status.value.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(status).toMatchObject({ ok: true, value: { state: "done", result: { summary: { audioSummary: { coordinateSpace: "source" } } } } });
      expect(await facade["project.get_state"]()).toEqual(before);
      const next = await facade["media.analyze_start"]({ mediaId: imported.value.mediaId, analysisTypes: ["audioSummary"], endSec: 6 });
      if (!next.ok) throw new Error(next.error.message);
      await facade["job.cancel"]({ jobId: next.value.jobId });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await facade["job.status"]({ jobId: next.value.jobId })).toMatchObject({ ok: true, value: { state: "cancelled", result: null } });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);

  it("analyzes silence through the shared kernel with GUI-aligned defaults", async () => {
    expect(DEFAULT_SILENCE_ANALYSIS_PARAMS).toEqual({ thresholdDb: -40, minDurationSec: 0.5, paddingSec: 0.1 });
    const root = await mkdtemp(join(tmpdir(), "rt-silence-fixture-"));
    try {
      // silence [0, 2] — tone [2, 4] — silence [4, 6]
      const path = join(root, "gaps.wav");
      await writeFile(path, wav(tonePcm([{ startSec: 2, endSec: 4 }])));
      const signal = new AbortController().signal;
      const result = await analyzeSilence(path, { startSec: 0, endSec: 6 }, undefined, signal);
      expect(result.coordinateSpace).toBe("source");
      expect(result.parameters).toEqual({ thresholdDb: -40, minDurationSec: 0.5, paddingSec: 0.1 });
      expect(result.silentRegions.map((r) => [r.startSec, r.endSec].map((v) => Math.round(v * 100) / 100))).toEqual([[0.1, 1.9], [4.1, 5.9]]);
      expect(result.regionCount).toBe(2);
      expect(result.truncated).toBe(false);
      expect(result.totalSilenceDurationSec).toBeCloseTo(3.6, 5);
      // Custom tuning: a 2.5s minimum drops both 1.8s regions.
      const strict = await analyzeSilence(path, { startSec: 0, endSec: 6 }, { minDurationSec: 2.5 }, signal);
      expect(strict.silentRegions).toEqual([]);
      // Padding wider than the region invalidates it (clamped, then filtered).
      const wide = await analyzeSilence(path, { startSec: 0, endSec: 6 }, { paddingSec: 2 }, signal);
      expect(wide.silentRegions).toEqual([]);
      // Range validation and source offsets both apply.
      await expect(analyzeSilence(path, { startSec: 0, endSec: 121 }, undefined, signal)).rejects.toThrow("120");
      const offset = await analyzeSilence(path, { startSec: 1, endSec: 5 }, undefined, signal);
      expect(offset.silentRegions[0]).toEqual({ startSec: 1.1, endSec: 1.9, durationSec: 0.8 });
      expect(offset.silentRegions[1]!.startSec).toBeCloseTo(4.1, 5);
      expect(offset.silentRegions[1]!.endSec).toBeCloseTo(4.9, 5);
      expect(offset.silentRegions[1]!.durationSec).toBeCloseTo(0.8, 5);
      // Out-of-range params are rejected before any process spawns.
      await expect(analyzeSilence(path, { startSec: 0, endSec: 6 }, { thresholdDb: 10 }, signal)).rejects.toThrow("thresholdDb");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);

  it("analyzes beat grids through the shared beat engine and omits downbeats", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-beat-fixture-"));
    try {
      const path = join(root, "beat.wav");
      await writeFile(path, wav(burstPcm([.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5])));
      const signal = new AbortController().signal;
      const result = await analyzeBeatGrid(path, { startSec: 0, endSec: 6 }, signal);
      expect(result.coordinateSpace).toBe("source");
      expect(result.analysisSampleRate).toBe(22050);
      expect(Object.keys(result)).not.toContain("downbeats");
      expect(result.bpm).toBeGreaterThan(100);
      expect(result.bpm).toBeLessThan(135);
      expect(result.confidence).toBeGreaterThan(.7);
      expect(result.beatCount).toBeGreaterThanOrEqual(10);
      expect(result.truncated).toBe(false);
      expect(result.beats[0]!.index).toBe(0);
      expect(Math.abs(result.beats[0]!.timeSec - 0.5)).toBeLessThan(0.15);
      expect(result.beats.every((b) => Number.isFinite(b.timeSec) && b.strength > 0)).toBe(true);
      await expect(analyzeBeatGrid(path, { startSec: 0, endSec: 121 }, signal)).rejects.toThrow("120");
      const facade = createAgentFacade({ mediaRoots: [root] });
      await facade["project.create"]({ name: "Beat test" });
      const imported = await facade["media.import"]({ path });
      if (!imported.ok) throw new Error(imported.error.message);
      // silenceParams without the silence type are rejected.
      const bad = await facade["media.analyze_start"]({ mediaId: imported.value.mediaId, analysisTypes: ["beatGrid"], silenceParams: { thresholdDb: -40 } });
      expect(bad).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
      const started = await facade["media.analyze_start"]({ mediaId: imported.value.mediaId, analysisTypes: ["silence", "beatGrid"], silenceParams: { minDurationSec: 0.3 } });
      if (!started.ok) throw new Error(started.error.message);
      let status;
      for (let i = 0; i < 200; i++) {
        status = await facade["job.status"]({ jobId: started.value.jobId });
        if (status.ok && ["done", "error", "cancelled"].includes(status.value.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(status).toMatchObject({ ok: true, value: { state: "done" } });
      const summary = (status as { ok: true; value: { result: { summary: Record<string, any> } } }).value.result.summary;
      expect(summary.silence.parameters).toEqual({ thresholdDb: -40, minDurationSec: 0.3, paddingSec: 0.1 });
      expect(summary.silence.mediaId).toBe(imported.value.mediaId);
      expect(summary.silence.sourceFingerprint).toHaveProperty("size");
      expect(summary.beatGrid.bpm).toBeGreaterThan(100);
      expect(summary.beatGrid.beats.length).toBeGreaterThan(0);
      expect(summary.beatGrid).not.toHaveProperty("downbeats");
      expect(summary.technicalQuality).toHaveProperty("readable", true);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);
});
