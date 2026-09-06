import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeLocalAudio, audioAnalysisPreflight, summarizePcm } from "./audio-analysis";
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
function wav(data: Buffer, channels = 2, rate = 8000) {
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * 4, 28); header.writeUInt16LE(channels * 4, 32); header.writeUInt16LE(32, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("local audio analysis", () => {
  it("detects known transients, preserves anti-phase channels and reports source offsets", () => {
    const result = summarizePcm(pcm([.5, 1, 1.5, 2, 2.5, 3, 3.5]), 10);
    expect(result.onsets).toEqual([10.5, 11, 11.5, 12, 12.5, 13, 13.5]);
    expect(result.bpmCandidates[0]).toEqual({ bpm: 120, confidence: 1 });
    expect(result.downbeats).toEqual([]);
    expect(result.waveform[1].bins.length).toBeLessThanOrEqual(600);
  });
  it("does not force beats on silence or irregular impulses", () => {
    const silent = summarizePcm(pcm([]), 0);
    expect(silent.bpmCandidates).toEqual([]);
    expect(silent.silence).toEqual([{ startSec: 0, endSec: 6 }]);
    expect(summarizePcm(pcm([.3, .77, 1.6, 2.8, 3.13, 4.01]), 0).bpmCandidates).toEqual([]);
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
});
