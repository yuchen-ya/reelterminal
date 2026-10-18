/**
 * AUD-11 long-material acceptance: streamed bounded decode equivalence,
 * cross-chunk event integrity, whole-range loudness and range caps.
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { detectSilenceRangesInPcm } from "@reelterminal/core/audio/audio-engine";
import { analyzeBeatsFromOnsetEnergies, analyzeBeatsInPcm } from "@reelterminal/core/audio/beat-detection-engine";

import { analyzeBeatGrid, analyzeSilence, analyzeLocalAudio, summarizePcm, runAudioSubprocess, BeatEnergyAccumulator } from "./audio-analysis";
import { AUDIO_NORMALIZE_MAX_RANGE_SEC, produceNormalizedAudio } from "./audio-normalize";
import { resolveToolFfmpeg, runToolProcess } from "./media/ffmpeg-bin";

const binaries = await resolveToolFfmpeg();
const skip = binaries === null;
let root = "";
let longPath = ""; // 400 s: 440 Hz tone with a 0.8 s silence gap every 5 s
let beatPath = ""; // 130 s click track (10 ms 1 kHz ticks every 0.5 s)

beforeAll(async () => {
  if (skip) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "audio-longrange-")));
  longPath = join(root, "long-400s.wav");
  await runToolProcess(binaries!.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "aevalsrc=0.4*sin(2*PI*440*t)*not(between(mod(t+2.5\\,5)\\,0.8\\,5)):s=16000:d=400:c=stereo",
    "-c:a", "pcm_s16le", longPath,
  ]);
  beatPath = join(root, "beats-130s.wav");
  await runToolProcess(binaries!.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "aevalsrc=0.9*sin(2*PI*1000*t)*lt(mod(t\\,0.5)\\,0.05):s=22050:d=130:c=mono",
    "-c:a", "pcm_s16le", beatPath,
  ]);
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** Decode the whole range in ONE subprocess and run the buffered core kernel (reference). */
async function referenceSilenceRegions(path: string, startSec: number, endSec: number, minDurationSec: number, paddingSec: number) {
  const pcm = await runAudioSubprocess(binaries!.ffmpeg, [
    "-hide_banner", "-nostdin", "-v", "info", "-ss", String(startSec), "-t", String(endSec - startSec), "-i", path,
    "-map", "0:a:0", "-vn", "-threads", "1", "-ar", "8000", "-ac", "1", "-f", "f32le", "pipe:1",
  ]);
  const samples = new Float32Array(pcm.out.length / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.out.readFloatLE(i * 4);
  return detectSilenceRangesInPcm(samples, 8000, -40, minDurationSec, paddingSec).map((r) => ({
    startSec: startSec + r.start,
    endSec: startSec + r.end,
    durationSec: r.end - r.start,
  }));
}

describe("AUD-11 streamed analysis on 400 s material", () => {
  it.skipIf(skip)("audioSummary matches buffered silence and BPM across many pipe chunks", async () => {
    const path = join(root, "continuous-30s.wav");
    await runToolProcess(binaries!.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=30", "-y", path]);
    for (const source of [path, beatPath]) {
      const streamed = await analyzeLocalAudio(source, { startSec: 0, endSec: 30 }, new AbortController().signal);
      const pcm = await runAudioSubprocess(binaries!.ffmpeg, ["-v", "error", "-ss", "0", "-t", "30", "-i", source, "-map", "0:a:0", "-vn", "-threads", "1", "-ar", "8000", "-ac", "2", "-f", "f32le", "pipe:1"]);
      const buffered = await summarizePcm(pcm.out, 0);
      expect(streamed.silence).toEqual(buffered.silence);
      expect(streamed.bpmCandidates).toEqual(buffered.bpmCandidates);
      expect(streamed.waveform).toEqual(buffered.waveform);
      if (source === path) expect(streamed.totalSilenceDurationSec).toBe(0);
    }
  });
  it.skipIf(skip)("analyzeSilence equals the whole-buffer core kernel exactly (no lost/duplicated regions)", async () => {
    const result = await analyzeSilence(longPath, { startSec: 0, endSec: 400 }, { thresholdDb: -40, minDurationSec: 0.5, paddingSec: 0.1 }, new AbortController().signal);
    expect(result.durationSec).toBeCloseTo(400, 1);
    const reference = await referenceSilenceRegions(longPath, 0, 400, 0.5, 0.1);
    expect(result.silentRegions).toEqual(reference);
    // The silence region straddling t=120 s must survive as ONE region
    // (the fixture period is shifted so a region spans it), not two halves.
    const straddling = result.silentRegions.find((r) => r.startSec < 119.9 && r.endSec > 120.1);
    expect(straddling).toBeDefined();
    expect(straddling!.durationSec).toBeGreaterThan(1);
    // Substantial silence was detected at all (the fixture is ~84% silence).
    expect(result.totalSilenceDurationSec).toBeGreaterThan(60);
    expect(result.regionCount).toBeGreaterThan(10);
  });

  it.skipIf(skip)("analyzeSilence on a mid-range window keeps source coordinates", async () => {
    const result = await analyzeSilence(longPath, { startSec: 115.3, endSec: 124.7 }, { thresholdDb: -40, minDurationSec: 0.3, paddingSec: 0.05 }, new AbortController().signal);
    const reference = await referenceSilenceRegions(longPath, 115.3, 124.7, 0.3, 0.05);
    expect(result.silentRegions).toEqual(reference);
    expect(result.startSec).toBe(115.3);
  });

  it.skipIf(skip)("beatGrid analyzes a 130 s click track (beyond the old 120 s cap)", async () => {
    const result = await analyzeBeatGrid(beatPath, { startSec: 0, endSec: 130 }, new AbortController().signal);
    expect(result.durationSec).toBeCloseTo(130, 1);
    expect(result.beatCount).toBeGreaterThan(100);
    // The interval histogram may settle on the half/double tempo candidate —
    // a disclosed ambiguity; this test proves the >120 s range works.
    expect(result.bpm).toBeGreaterThanOrEqual(60);
    expect(result.bpm).toBeLessThanOrEqual(240);
  });

  it.skipIf(skip)("BeatEnergyAccumulator reproduces the whole-buffer analysis for arbitrary chunkings", async () => {
    const pcm = await runAudioSubprocess(binaries!.ffmpeg, [
      "-hide_banner", "-nostdin", "-v", "info", "-ss", "10", "-t", "30", "-i", beatPath,
      "-map", "0:a:0", "-vn", "-threads", "1", "-ar", "22050", "-ac", "1", "-f", "f32le", "pipe:1",
    ]);
    const samples = new Float32Array(pcm.out.length / 4);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.out.readFloatLE(i * 4);
    const reference = await analyzeBeatsInPcm(samples, 22050);
    for (const chunkSize of [997, 4096, 100_000]) {
      const accumulator = new BeatEnergyAccumulator(2048, 512);
      for (let offset = 0; offset < samples.length; offset += chunkSize) {
        accumulator.push(samples.subarray(offset, Math.min(offset + chunkSize, samples.length)));
      }
      const fromEnergies = await analyzeBeatsFromOnsetEnergies(accumulator.finish(), 22050, samples.length / 22050);
      expect(fromEnergies).toEqual(reference);
    }
  });

  it.skipIf(skip)("a 3600 s request on shorter material still runs (cap allows hour-level input)", async () => {
    const result = await analyzeSilence(longPath, { startSec: 0, endSec: 3600 }, undefined, new AbortController().signal);
    expect(result.durationSec).toBeCloseTo(400, 1);
    await expect(analyzeSilence(longPath, { startSec: 0, endSec: 3600.5 }, undefined, new AbortController().signal))
      .rejects.toThrow("3600");
  });
});

describe("AUD-11 normalization beyond 120 s", () => {
  it.skipIf(skip)("normalizes a 125 s range end to end with real progress", async () => {
    {
      const progressValues: number[] = [];
      const artifact = await produceNormalizedAudio({
        sourcePath: longPath,
        mediaRoots: [root],
        params: {
          mediaId: "long-media", audioStream: 0, startSec: 0, endSec: 125,
          targetLufs: -18, truePeakDbtp: -1.5, loudnessRangeLu: 11,
          sampleRate: 48_000, channels: 2,
        },
        sourceProjectId: "project-long", sourceRevision: 1,
        artifactId: "long-125s",
        progress: (p) => progressValues.push(p),
      });
      expect(artifact.timing.sampleCount).toBe(Math.round(125 * 48_000));
      // Whole-range integrated loudness from one two-pass run over the range.
      expect(Math.abs(artifact.after.integratedLufs - (-18))).toBeLessThanOrEqual(1);
      expect(progressValues.length).toBeGreaterThan(1);
      expect(progressValues).toEqual([...progressValues].sort((a, b) => a - b)); // monotonic
      expect(Math.max(...progressValues)).toBeGreaterThanOrEqual(0.9);
      await rm(join(root, "generated-assets"), { recursive: true, force: true });
    }
  }, 180_000);

  it("rejects normalization beyond 3600 s before any work", async () => {
    expect(AUDIO_NORMALIZE_MAX_RANGE_SEC).toBe(3600);
    await expect(produceNormalizedAudio({
      sourcePath: "unused.wav",
      mediaRoots: ["unused-root"],
      params: {
        mediaId: "m", audioStream: 0, startSec: 0, endSec: 3600.5,
        targetLufs: -16, truePeakDbtp: -1, loudnessRangeLu: 11,
        sampleRate: 48_000, channels: 2,
      },
      sourceProjectId: "p", sourceRevision: 0,
      artifactId: "too-long",
    })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });
});
