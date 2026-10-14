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
/** Sharp attacks encoded in the right channel only. */
function rightChannelBurstPcm(times: number[], duration = 6) {
  const data = Buffer.alloc(8000 * duration * 8);
  for (const time of times) for (let i = 0; i < 960; i++) {
    const index = Math.round(time * 8000) + i;
    if (index * 8 + 7 >= data.length) break;
    const sample = .8 * Math.sin(i * .06) * Math.exp(-i / 220);
    data.writeFloatLE(sample, index * 8 + 4);
  }
  return data;
}
/** Alternating 100ms silence/tone windows produce many distinct detector ranges. */
function manySilenceRangesPcm(count: number) {
  const windowSamples = 800;
  const windowCount = count * 2 - 1;
  const data = Buffer.alloc(windowSamples * windowCount * 8);
  for (let window = 1; window < windowCount; window += 2) {
    for (let i = 0; i < windowSamples; i++) {
      const sample = .5 * Math.sin(i * .05);
      const offset = (window * windowSamples + i) * 8;
      data.writeFloatLE(sample, offset);
      data.writeFloatLE(sample, offset + 4);
    }
  }
  return data;
}
/** Each event has three 100ms silent windows followed by one tone window. */
function manySummarySilenceRangesPcm(count: number) {
  const windowSamples = 800;
  const windowCount = count * 4;
  const data = Buffer.alloc(windowSamples * windowCount * 8);
  for (let window = 3; window < windowCount; window += 4) {
    for (let i = 0; i < windowSamples; i++) {
      const sample = .5 * Math.sin(i * .05);
      const offset = (window * windowSamples + i) * 8;
      data.writeFloatLE(sample, offset);
      data.writeFloatLE(sample, offset + 4);
    }
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
    // pcm() writes opposite polarity to the two channels; shared-core input
    // must preserve this real signal instead of averaging it away.
    const steady = await summarizePcm(pcm([.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]), 0);
    expect(steady.bpmCandidates).toHaveLength(1);
    const candidate = steady.bpmCandidates[0]!;
    expect(candidate.bpm).toBeGreaterThan(100);
    expect(candidate.bpm).toBeLessThan(135);
    expect(candidate.confidence).toBeGreaterThan(.7);
    expect(steady.silence).not.toEqual([{ startSec: 0, endSec: 6 }]);
    // Silence forces zero confidence: no bpm candidates are invented.
    const silent = await summarizePcm(pcm([]), 0);
    expect(silent.bpmCandidates).toEqual([]);
    expect(silent.silence).toEqual([{ startSec: 0, endSec: 6 }]);
    expect(await summarizePcm(pcm([.3, .77, 1.6, 2.8, 3.13, 4.01]), 0).then((r) => r.bpmCandidates)).toEqual([]);
  });
  it("uses right-channel-only transients for onsets, silence and beat analysis", async () => {
    const rightOnly = await summarizePcm(rightChannelBurstPcm([.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]), 0);
    expect(rightOnly.onsets.length).toBeGreaterThan(0);
    expect(rightOnly.bpmCandidates).toHaveLength(1);
    expect(rightOnly.bpmCandidates[0]!.confidence).toBeGreaterThan(.7);
    expect(rightOnly.silence).not.toEqual([{ startSec: 0, endSec: 6 }]);
  });
  it("runs real FFmpeg loudness, bounded jobs and cancellation without changing revision", async () => {
    expect((await audioAnalysisPreflight()).available).toBe(true);
    const root = await mkdtemp(join(tmpdir(), "rt-audio-fixture-"));
    try {
      const path = join(root, "clicks.wav");
      await writeFile(path, wav(pcm([.5, 1, 1.5, 2, 2.5, 3])));
      const noRecordFacade = createAgentFacade({ mediaRoots: [root] });
      await noRecordFacade["project.create"]({ name: "Audio without storage" });
      const noRecordImport = await noRecordFacade["media.import"]({ path });
      if (!noRecordImport.ok) throw new Error(noRecordImport.error.message);
      expect(await noRecordFacade["media.analyze_start"]({ mediaId: noRecordImport.value.mediaId, analysisTypes: ["audioSummary"] }))
        .toMatchObject({ ok: false, error: { code: "UNSUPPORTED", message: expect.stringContaining("artifactRoot") } });
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
      const facade = createAgentFacade({ mediaRoots: [root], artifactRoot: join(root, "artifacts") });
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
      if (status?.ok) {
        const result = status.value.result;
        if (!result || !("summary" in result)) throw new Error("audio analysis returned no analysis result");
        const jobAudio = (result.summary as Record<string, any>).audioSummary;
        expect(jobAudio).not.toHaveProperty("waveform");
        expect(jobAudio).not.toHaveProperty("onsets");
        expect(jobAudio).not.toHaveProperty("silence");
      }
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

  it("returns all silence ranges and counts their full duration", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-many-silence-fixture-"));
    try {
      const rangeCount = 257;
      const path = join(root, "many-gaps.wav");
      await writeFile(path, wav(manySilenceRangesPcm(rangeCount)));
      const result = await analyzeSilence(path, { startSec: 0, endSec: (rangeCount * 2 - 1) / 10 }, { minDurationSec: 0.05, paddingSec: 0 }, new AbortController().signal);
      expect(result.regionCount).toBe(rangeCount);
      expect(result.silentRegions).toHaveLength(rangeCount);
      expect(result.truncated).toBe(false);
      const reportedDuration = result.silentRegions.reduce((sum, region) => sum + region.durationSec, 0);
      expect(result.totalSilenceDurationSec).toBeCloseTo(rangeCount / 10, 5);
      expect(result.totalSilenceDurationSec).toBeCloseTo(reportedDuration, 5);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);

  it("keeps audioSummary events beyond the former 256-event preview boundary", async () => {
    const rangeCount = 257;
    const summary = await summarizePcm(manySummarySilenceRangesPcm(rangeCount), 3);
    expect(summary.silenceCount).toBe(rangeCount);
    expect(summary.silence).toHaveLength(rangeCount);
    expect(summary.onsetCount).toBeGreaterThan(256);
    expect(summary.onsets).toHaveLength(summary.onsetCount);
    expect(summary.totalSilenceDurationSec).toBeCloseTo(rangeCount * 0.3, 4);
    expect(summary.truncated).toBe(false);
  });

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
      expect(result.beats).toHaveLength(result.beatCount);
      expect(result.truncated).toBe(false);
      expect(result.beats[0]!.index).toBe(0);
      expect(Math.abs(result.beats[0]!.timeSec - 0.5)).toBeLessThan(0.15);
      expect(result.beats.every((b) => Number.isFinite(b.timeSec) && b.strength > 0)).toBe(true);
      await expect(analyzeBeatGrid(path, { startSec: 0, endSec: 121 }, signal)).rejects.toThrow("120");
      const artifactRoot = join(root, "artifacts");
      const facade = createAgentFacade({ mediaRoots: [root], artifactRoot });
      await facade["project.create"]({ name: "Beat test" });
      const imported = await facade["media.import"]({ path });
      if (!imported.ok) throw new Error(imported.error.message);
      const waitForJob = async (jobId: string) => {
        for (let i = 0; i < 200; i++) {
          const next = await facade["job.status"]({ jobId });
          if (next.ok && ["done", "error", "cancelled"].includes(next.value.state)) return next;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`Audio analysis job ${jobId} did not finish`);
      };
      // silenceParams without the silence type are rejected.
      const bad = await facade["media.analyze_start"]({ mediaId: imported.value.mediaId, analysisTypes: ["beatGrid"], silenceParams: { thresholdDb: -40 } });
      expect(bad).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
      const silenceParams = { thresholdDb: -35, minDurationSec: 0.3, paddingSec: 0.2 };
      const started = await facade["media.analyze_start"]({ mediaId: imported.value.mediaId, analysisTypes: ["silence", "beatGrid"], silenceParams });
      if (!started.ok) throw new Error(started.error.message);
      const status = await waitForJob(started.value.jobId);
      expect(status).toMatchObject({ ok: true, value: { state: "done" } });
      const summary = (status as { ok: true; value: { result: { summary: Record<string, any> } } }).value.result.summary;
      expect(summary.silence.parameters).toEqual(silenceParams);
      expect(summary.silence.mediaId).toBe(imported.value.mediaId);
      expect(summary.silence.sourceFingerprint).toHaveProperty("size");
      expect(summary.silence).not.toHaveProperty("silentRegions");
      expect(summary.beatGrid.bpm).toBeGreaterThan(100);
      expect(summary.beatGrid.beatCount).toBeGreaterThan(0);
      expect(summary.beatGrid).not.toHaveProperty("beats");
      expect(summary.beatGrid).not.toHaveProperty("downbeats");
      expect(summary.technicalQuality).toHaveProperty("readable", true);

      const originalRecordId = (summary.analysisRecord as { id: string }).id;
      const originalRecordResult = await facade["analysis.get"]({ recordId: originalRecordId });
      if (!originalRecordResult.ok) throw new Error(originalRecordResult.error.message);
      const originalRecord = originalRecordResult.value as { config: { analysisTypes: ("silence" | "beatGrid")[]; startSec: number; endSec: number; silenceParams: typeof silenceParams } };
      expect(originalRecord.config.silenceParams).toEqual(silenceParams);

      const recheckStarted = await facade["media.analyze_start"]({
        mediaId: imported.value.mediaId,
        analysisTypes: originalRecord.config.analysisTypes,
        startSec: originalRecord.config.startSec,
        endSec: originalRecord.config.endSec,
        silenceParams: originalRecord.config.silenceParams,
        recheckOfRecordId: originalRecordId,
      });
      if (!recheckStarted.ok) throw new Error(recheckStarted.error.message);
      const recheckStatus = await waitForJob(recheckStarted.value.jobId);
      expect(recheckStatus).toMatchObject({ ok: true, value: { state: "done" } });
      const recheckSummary = (recheckStatus as { ok: true; value: { result: { summary: Record<string, any> } } }).value.result.summary;
      expect(recheckSummary.silence.parameters).toEqual(originalRecord.config.silenceParams);
      const recheckRecordResult = await facade["analysis.get"]({ recordId: (recheckSummary.analysisRecord as { id: string }).id });
      if (!recheckRecordResult.ok) throw new Error(recheckRecordResult.error.message);
      expect(recheckRecordResult.value).toMatchObject({
        config: { silenceParams: originalRecord.config.silenceParams },
        recheckOf: originalRecordId,
      });

      const defaultStarted = await facade["media.analyze_start"]({
        mediaId: imported.value.mediaId,
        analysisTypes: ["silence"],
        startSec: originalRecord.config.startSec,
        endSec: originalRecord.config.endSec,
      });
      if (!defaultStarted.ok) throw new Error(defaultStarted.error.message);
      const defaultStatus = await waitForJob(defaultStarted.value.jobId);
      expect(defaultStatus).toMatchObject({ ok: true, value: { state: "done" } });
      const defaultSummary = (defaultStatus as { ok: true; value: { result: { summary: Record<string, any> } } }).value.result.summary;
      const defaultRecord = await facade["analysis.get"]({ recordId: (defaultSummary.analysisRecord as { id: string }).id });
      expect(defaultRecord).toMatchObject({ ok: true, value: { config: { silenceParams: DEFAULT_SILENCE_ANALYSIS_PARAMS } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);

  it("returns all beat grid events beyond the former 256-event preview boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-many-beats-fixture-"));
    try {
      const beatTimes = Array.from({ length: 300 }, (_, index) => .5 + index * .3);
      const path = join(root, "many-beats.wav");
      await writeFile(path, wav(burstPcm(beatTimes, 91)));
      const result = await analyzeBeatGrid(path, { startSec: 0, endSec: 91 }, new AbortController().signal);
      expect(result.beatCount).toBeGreaterThan(256);
      expect(result.beats).toHaveLength(result.beatCount);
      expect(result.truncated).toBe(false);
      expect(result.beats.at(-1)!.index).toBe(result.beatCount - 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);
});
