import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { produceNormalizedAudio, normalizeRangeWindow } from "./audio-normalize";
import { resolveToolFfmpeg, runToolProcess } from "./media/ffmpeg-bin";

const binaries = await resolveToolFfmpeg();
const skip = binaries === null;
let root = "";
let sourcePath = "";
let longSourcePath = "";
let silencePath = "";
let videoOnlyPath = "";
let delayedAudioPath = "";
let positiveOriginPath = "";

beforeAll(async () => {
  if (skip) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "audio-normalize-")));
  sourcePath = join(root, "right channel source 44k.mka");
  longSourcePath = join(root, "long-source.wav");
  silencePath = join(root, "silent.wav");
  videoOnlyPath = join(root, "video-only.mp4");
  delayedAudioPath = join(root, "audio-starts-after-video.mkv");
  positiveOriginPath = join(root, "positive-origin.mka");
  await runToolProcess(binaries!.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo:d=12",
    "-f", "lavfi", "-i", "aevalsrc=0|if(gte(n\\,286650)*lt(n\\,287091)\\,0.8\\,if(lt(mod(t\\,2)\\,1)\\,0.2\\,0.002)*sin(2*PI*440*t)):s=44100:d=12:c=stereo",
    "-map", "0:a:0", "-map", "1:a:0",
    "-c:a", "pcm_s16le", sourcePath,
  ]);
  await runToolProcess(binaries!.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=120",
    "-c:a", "pcm_s16le", longSourcePath,
  ]);
  await runToolProcess(binaries!.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=2",
    "-c:a", "pcm_s16le", silencePath,
  ]);
  await runToolProcess(binaries!.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=64x64:rate=2:duration=1",
    "-an", "-c:v", "mpeg4", videoOnlyPath,
  ]);
  await runToolProcess(binaries!.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=64x64:rate=2:duration=4",
    "-itsoffset", "2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "mpeg4", "-c:a", "pcm_s16le", "-t", "4", delayedAudioPath,
  ]);
  await runToolProcess(binaries!.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-itsoffset", "2", "-f", "lavfi", "-i", "aevalsrc=if(gte(n\\,60000)*lt(n\\,60441)\\,0.4\\,0.2*sin(2*PI*440*t)):s=48000:d=4",
    "-c:a", "pcm_s16le", positiveOriginPath,
  ]);
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const params = {
  mediaId: "source-media",
  audioStream: 1,
  startSec: 0.437,
  endSec: 11.013,
  targetLufs: -18,
  truePeakDbtp: -1,
  loudnessRangeLu: 7,
  sampleRate: 48_000 as const,
  channels: 2 as const,
};

function request(artifactId: string, extra: Record<string, unknown> = {}) {
  return {
    sourcePath,
    mediaRoots: [root],
    params,
    sourceProjectId: "project-test",
    sourceWorkspaceId: "workspace-test",
    sourceRevision: 12,
    artifactId,
    ...extra,
  };
}

describe("produceNormalizedAudio", () => {
  it.skipIf(skip)("normalizes a right-channel-only 44.1 kHz source range into an exact durable 48 kHz WAV", async () => {
    const artifact = await produceNormalizedAudio(request("right-only"));
    const expectedSamples = Math.round((params.endSec - params.startSec) * 48_000);

    expect(artifact.path).toBe(join(root, "generated-assets", "audio-normalize", "right-only", "normalized.wav"));
    expect(artifact.path).not.toContain(`${join(root, "jobs")}`);
    expect(artifact.provenancePath).toBe(join(root, "generated-assets", "audio-normalize", "right-only", "provenance.json"));
    expect(artifact.timing).toEqual({
      sampleRate: 48_000,
      channels: 2,
      sampleCount: expectedSamples,
      durationSec: expectedSamples / 48_000,
      outputStartSec: 0,
      processingDelaySamples: 0,
      leadSilenceSamples: 0,
    });
    expect(Number.isFinite(artifact.before.integratedLufs)).toBe(true);
    expect(Number.isFinite(artifact.before.truePeakDbtp)).toBe(true);
    expect(Number.isFinite(artifact.after.integratedLufs)).toBe(true);
    expect(Number.isFinite(artifact.after.truePeakDbtp)).toBe(true);
    expect((await stat(artifact.path)).size).toBe(artifact.bytes);

    const sidecar = JSON.parse(await readFile(artifact.provenancePath, "utf8")) as Record<string, unknown>;
    expect(sidecar.source).toEqual(artifact.source);
    expect(sidecar.parameters).toEqual(params);
    expect(sidecar.before).toEqual(artifact.before);
    expect(sidecar.after).toEqual(artifact.after);
    expect(sidecar.normalizationMode).toBe("dynamic");
    expect(Math.abs(artifact.after.integratedLufs - params.targetLufs)).toBeLessThanOrEqual(1);
    expect(artifact.after.truePeakDbtp).toBeLessThanOrEqual(params.truePeakDbtp + 0.2);

    const decoded = await runToolProcess(binaries!.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", artifact.path,
      "-map", "0:a:0", "-f", "f32le", "pipe:1",
    ]);
    const reference = await runToolProcess(binaries!.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", sourcePath,
      "-map", "0:1", "-af", `atrim=start=${params.startSec}:end=${params.endSec},asetpts=PTS-STARTPTS,aresample=48000:async=0:first_pts=0,aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_len=${expectedSamples},atrim=end_sample=${expectedSamples}`,
      "-ar", "48000", "-ac", "2", "-f", "f32le", "pipe:1",
    ]);
    const peakFrame = (pcm: Buffer) => {
      let index = 0;
      let amplitude = 0;
      for (let frame = 0; frame < expectedSamples; frame++) {
        const current = Math.max(Math.abs(pcm.readFloatLE(frame * 8)), Math.abs(pcm.readFloatLE(frame * 8 + 4)));
        if (current > amplitude) {
          amplitude = current;
          index = frame;
        }
      }
      return index;
    };
    const outputPeak = peakFrame(decoded.stdout);
    const referencePeak = peakFrame(reference.stdout);
    expect(Math.abs(outputPeak - referencePeak)).toBeLessThanOrEqual(2);
    const expectedPulseSample = Math.round((6.5 - params.startSec) * 48_000);
    expect(Math.abs(referencePeak - expectedPulseSample)).toBeLessThanOrEqual(2);

    const repeated = await produceNormalizedAudio(request("right-only"));
    expect(repeated.path).toBe(artifact.path);
    expect(repeated.provenancePath).toBe(artifact.provenancePath);
    expect(repeated.sha256).toBe(artifact.sha256);
    expect(await readdir(join(root, "generated-assets", "audio-normalize", "right-only"))).toEqual([
      "normalized.wav",
      "provenance.json",
    ]);
    expect((await readdir(join(root, "generated-assets", "audio-normalize"))).some((name) => name.startsWith(".right-only.") && name.endsWith(".pending"))).toBe(false);
  });

  it.skipIf(skip)("fails a short high-crest-factor range that misses the target and publishes no asset", async () => {
    const shortParams = { ...params, startSec: 5.5, endSec: 7.5, targetLufs: -10 };
    await expect(produceNormalizedAudio(request("short-high-crest", { params: shortParams })))
      .rejects.toMatchObject({
        message: expect.stringMatching(/remeasured output misses.*LUFS.*true peak/i),
        code: "JOB_FAILED",
        details: {
          before: { integratedLufs: expect.any(Number) },
          after: { integratedLufs: expect.any(Number) },
          targets: { integratedLufs: shortParams.targetLufs },
          tolerance: { integratedDeviationLu: 1, truePeakOvershootDbtp: 0.2 },
        },
      });
    await expect(stat(join(root, "generated-assets", "audio-normalize", "short-high-crest")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(skip)("rejects silence and sources without audio without publishing output", async () => {
    await expect(produceNormalizedAudio(request("silent", {
      sourcePath: silencePath,
      params: { ...params, audioStream: 0, endSec: 1.5 },
    }))).rejects.toThrow(/silent|unmeasurable/i);
    await expect(produceNormalizedAudio(request("no-audio", {
      sourcePath: videoOnlyPath,
      params: { ...params, endSec: 0.5 },
    }))).rejects.toThrow(/no audio stream/i);

    await expect(stat(join(root, "generated-assets", "audio-normalize", "silent"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, "generated-assets", "audio-normalize", "no-audio"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(skip)("normalizes an offset audio track and preserves its leading delay as real silence (AUD-12)", async () => {
    // delayedAudioPath: 4 s video, audio stream starts at +2 s and is 2 s long.
    const artifact = await produceNormalizedAudio(request("offset-track", {
      sourcePath: delayedAudioPath,
      params: { ...params, audioStream: 0, startSec: 0, endSec: 3.5, targetLufs: -20, channels: 1 },
    }));
    expect(artifact.timing.sampleCount).toBe(Math.round(3.5 * 48_000));
    expect(artifact.timing.leadSilenceSamples).toBe(96_000);
    const provenance = JSON.parse(await readFile(artifact.provenancePath, "utf8")) as Record<string, unknown>;
    expect(provenance.sourceStreamOffsetSec).toBeCloseTo(2, 4);
    expect(provenance.sourceStreamStartSec).toBeCloseTo(2, 4);
    expect(Math.abs(artifact.after.integratedLufs - (-20))).toBeLessThanOrEqual(1);

    // No silent shifting: the first audible output sample sits at ~2 s.
    const decoded = await runToolProcess(binaries!.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", artifact.path,
      "-map", "0:a:0", "-ar", "48000", "-ac", "1", "-f", "f32le", "pipe:1",
    ]);
    let firstAudible = -1;
    for (let i = 0; i < artifact.timing.sampleCount && firstAudible < 0; i++) {
      if (Math.abs(decoded.stdout.readFloatLE(i * 4)) > 0.001) firstAudible = i;
    }
    expect(firstAudible).toBeGreaterThanOrEqual(96_000 - 4);
    expect(firstAudible).toBeLessThanOrEqual(96_000 + 4);
    // The tail after the track ends (3.5 s requested > 2+2 s coverage) is padded silence.
    let lastAudible = -1;
    for (let i = artifact.timing.sampleCount - 1; i >= 0 && lastAudible < 0; i--) {
      if (Math.abs(decoded.stdout.readFloatLE(i * 4)) > 0.001) lastAudible = i;
    }
    expect(lastAudible).toBeLessThanOrEqual(Math.round(4 * 48_000) + 4);
  });

  it.skipIf(skip)("maps an offset track from inside the track with no lead silence (AUD-12)", async () => {
    const artifact = await produceNormalizedAudio(request("offset-inside", {
      sourcePath: delayedAudioPath,
      params: { ...params, audioStream: 0, startSec: 2.5, endSec: 3.5, targetLufs: -20, channels: 1 },
    }));
    expect(artifact.timing.leadSilenceSamples).toBe(0);
    expect(artifact.timing.sampleCount).toBe(48_000);
    const decoded = await runToolProcess(binaries!.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", artifact.path,
      "-map", "0:a:0", "-f", "f32le", "pipe:1",
    ]);
    // Content starts immediately: no leading gap, nothing shifted.
    let firstAudible = -1;
    for (let i = 0; i < 48_000 && firstAudible < 0; i++) {
      if (Math.abs(decoded.stdout.readFloatLE(i * 4)) > 0.001) firstAudible = i;
    }
    expect(firstAudible).toBeLessThanOrEqual(4);
  });

  it.skipIf(skip)("rejects offset ranges that end before the track starts or after its coverage (AUD-12)", async () => {
    await expect(produceNormalizedAudio(request("offset-before-track", {
      sourcePath: delayedAudioPath,
      params: { ...params, audioStream: 0, startSec: 0, endSec: 1.5, targetLufs: -20, channels: 1 },
    }))).rejects.toThrow(/ends before the selected audio track starts/i);
    // The container reports no per-stream duration, so the coverage bound is
    // the format duration; a range past the real content still fails loudly
    // at measurement instead of publishing padded silence as "normalized".
    await expect(produceNormalizedAudio(request("offset-past-coverage", {
      sourcePath: delayedAudioPath,
      params: { ...params, audioStream: 0, startSec: 4.5, endSec: 5.2, targetLufs: -20, channels: 1 },
    }))).rejects.toThrow(/could not measure|unmeasurable|ends after the selected audio stream/i);
    for (const id of ["offset-before-track", "offset-past-coverage"]) {
      await expect(stat(join(root, "generated-assets", "audio-normalize", id))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.skipIf(skip)("normalizes an offset track in a different container (mp4, AUD-12)", async () => {
    const offsetMp4Path = join(root, "audio-starts-after-video.mp4");
    await runToolProcess(binaries!.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=64x64:rate=2:duration=4",
      "-itsoffset", "2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-t", "4", offsetMp4Path,
    ]);
    const artifact = await produceNormalizedAudio(request("offset-mp4", {
      sourcePath: offsetMp4Path,
      params: { ...params, audioStream: 0, startSec: 0, endSec: 3.5, targetLufs: -20, channels: 1 },
    }));
    // AAC priming shifts the container's reported stream start (~1.978 s), so
    // the preserved lead is ≈2 s within encoder tolerance, not exactly 96000.
    expect(artifact.timing.leadSilenceSamples).toBeGreaterThanOrEqual(94_000);
    expect(artifact.timing.leadSilenceSamples).toBeLessThanOrEqual(96_000);
    expect(artifact.timing.sampleCount).toBe(Math.round(3.5 * 48_000));
    const provenance = JSON.parse(await readFile(artifact.provenancePath, "utf8")) as Record<string, unknown>;
    expect(Number(provenance.sourceStreamOffsetSec)).toBeCloseTo(2, 1);
  });

  it.skipIf(skip)("normalizeRangeWindow maps negative stream offsets onto PTS trims", () => {
    // A track starting 1 s BEFORE the media origin: audio covers source time
    // [-1, duration-1]; ranges inside [0, duration-1] trim directly with no
    // lead silence, and the pre-origin content is simply never requested.
    const window = normalizeRangeWindow(
      { startSec: 0.5, endSec: 2.5 },
      { timestampOriginSec: 0, streamOffsetSec: -1 },
      3,
    );
    expect(window.trimStartSec).toBeCloseTo(0.5, 9);
    expect(window.trimEndSec).toBeCloseTo(2.5, 9);
    expect(window.leadSilenceSamples).toBe(0);
    expect(window.coverageEndSec).toBeCloseTo(2, 9);
    const lateStart = normalizeRangeWindow(
      { startSec: 0, endSec: 2 },
      { timestampOriginSec: 0, streamOffsetSec: -1 },
      3,
    );
    expect(lateStart.leadSilenceSamples).toBe(0);
    expect(lateStart.trimStartSec).toBeCloseTo(0, 9);
  });

  it.skipIf(skip)("uses a shared positive format/audio timestamp origin as source time zero", async () => {
    const artifact = await produceNormalizedAudio(request("positive-origin", {
      sourcePath: positiveOriginPath,
      params: { ...params, audioStream: 0, startSec: 0.5, endSec: 3.5, targetLufs: -20, channels: 1 },
    }));
    const provenance = JSON.parse(await readFile(artifact.provenancePath, "utf8")) as Record<string, unknown>;
    expect(provenance.sourceTimestampOriginSec).toBeCloseTo(2, 5);
    expect(artifact.timing.sampleCount).toBe(144_000);
    expect(Math.abs(artifact.after.integratedLufs + 20)).toBeLessThanOrEqual(1);
    const [output, reference] = await Promise.all([
      runToolProcess(binaries!.ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-i", artifact.path,
        "-map", "0:a:0", "-f", "f32le", "pipe:1",
      ]),
      runToolProcess(binaries!.ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-copyts", "-i", positiveOriginPath,
        "-map", "0:a:0", "-af", "atrim=start=2.5:end=5.5,asetpts=PTS-STARTPTS,aresample=48000:async=0:first_pts=0,aformat=sample_rates=48000:channel_layouts=mono,apad=whole_len=144000,atrim=end_sample=144000",
        "-ar", "48000", "-ac", "1", "-f", "f32le", "pipe:1",
      ]),
    ]);
    const peakFrame = (pcm: Buffer) => {
      let peak = 0;
      for (let frame = 0; frame < 144_000; frame++) {
        if (Math.abs(pcm.readFloatLE(frame * 4)) > Math.abs(pcm.readFloatLE(peak * 4))) peak = frame;
      }
      return peak;
    };
    const outputPeak = peakFrame(output.stdout);
    const referencePeak = peakFrame(reference.stdout);
    expect(Math.abs(outputPeak - referencePeak)).toBeLessThanOrEqual(2);
    expect(Math.abs(referencePeak - 36_000)).toBeLessThanOrEqual(2);
  });

  it.skipIf(skip)("honors pre-cancelled work and refuses a source outside the configured media roots", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(produceNormalizedAudio(request("cancelled", { signal: controller.signal }))).rejects.toThrow(/cancel/i);
    await expect(produceNormalizedAudio(request("outside", { sourcePath: videoOnlyPath, mediaRoots: [join(root, "elsewhere")] })))
      .rejects.toThrow(/escapes the configured media roots/i);
    await expect(stat(join(root, "generated-assets", "audio-normalize", "cancelled"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, "generated-assets", "audio-normalize", "outside"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(skip)("cancels during the second pass and removes its pending directory", async () => {
    const outputParent = join(root, "generated-assets", "audio-normalize");
    await mkdir(outputParent, { recursive: true });
    const controller = new AbortController();
    const artifactId = "cancel-in-flight";
    const work = produceNormalizedAudio(request(artifactId, {
      sourcePath: longSourcePath,
      signal: controller.signal,
      params: {
        ...params,
        audioStream: 0,
        startSec: 0,
        endSec: 120,
        targetLufs: -20,
        channels: 1,
      }
    }));
    const cancelled = expect(work).rejects.toThrow(/cancel/i);
    const deadline = Date.now() + 8_000;
    let foundStagedWav = false;
    while (Date.now() < deadline && !foundStagedWav) {
      for (const name of await readdir(outputParent)) {
        if (!name.startsWith(`.${artifactId}.`) || !name.endsWith(".pending")) continue;
        const stagedWav = join(outputParent, name, "normalized.wav");
        try {
          await stat(stagedWav);
          foundStagedWav = true;
          controller.abort();
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (!foundStagedWav) await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(foundStagedWav).toBe(true);
    await cancelled;
    await expect(stat(join(outputParent, artifactId))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(outputParent)).some((name) => name.includes(`.${artifactId}.`) && name.endsWith(".pending"))).toBe(false);
  });

  it.skipIf(skip)("reuses a validated byte-identical prior result for a fresh artifactId (AUD-13)", async () => {
    const reuseParams = { ...params, audioStream: 1, startSec: 1, endSec: 6, targetLufs: -17 };
    const first = await produceNormalizedAudio(request("reuse-first", { params: reuseParams }));
    const firstProvenance = JSON.parse(await readFile(first.provenancePath, "utf8")) as Record<string, unknown>;
    expect(firstProvenance.reusedFrom).toBeUndefined();

    const second = await produceNormalizedAudio(request("reuse-second", { params: reuseParams }));
    expect(second.sha256).toBe(first.sha256);
    expect(second.path).not.toBe(first.path);
    const secondProvenance = JSON.parse(await readFile(second.provenancePath, "utf8")) as Record<string, unknown>;
    expect(secondProvenance.reusedFrom).toMatchObject({ artifactId: "reuse-first" });
    expect(secondProvenance.before).toEqual(first.before);
    expect(secondProvenance.after).toEqual(first.after);
    expect(second.after.integratedLufs).toBeCloseTo(first.after.integratedLufs, 10);

    const index = JSON.parse(await readFile(join(root, "generated-assets", "audio-normalize", ".reuse-index.json"), "utf8")) as { entries: Record<string, { artifactId: string; files: Record<string, string> }> };
    const entry = Object.values(index.entries).find((e) => e.artifactId === "reuse-second");
    expect(entry).toBeDefined();
    expect(entry!.files["normalized.wav"]).toBe(second.sha256);
  });

  it.skipIf(skip)("recomputes and repairs the index when the cached output no longer matches its sha (AUD-13)", async () => {
    const reuseParams = { ...params, audioStream: 1, startSec: 2, endSec: 5, targetLufs: -16 };
    const first = await produceNormalizedAudio(request("reuse-stale-first", { params: reuseParams }));
    // Corrupt the recorded artifact: the next hit must validate, miss, recompute.
    const { writeFile: overwrite } = await import("node:fs/promises");
    await overwrite(first.path, Buffer.alloc(1024, 1));
    const second = await produceNormalizedAudio(request("reuse-stale-second", { params: reuseParams }));
    const secondProvenance = JSON.parse(await readFile(second.provenancePath, "utf8")) as Record<string, unknown>;
    expect(secondProvenance.reusedFrom).toBeUndefined();
    // Deterministic recompute of the clean bytes equals the original result.
    expect(second.sha256).toBe(first.sha256);
    expect(second.bytes).toBe(first.bytes);
    // The corrupted directory is user-owned data, NOT cache — it must survive.
    expect((await stat(first.path)).size).toBe(1024);
  });

  it.skipIf(skip)("recomputes instead of trusting modified cached measurements", async () => {
    const reuseParams = { ...params, audioStream: 1, startSec: 2, endSec: 5, targetLufs: -19 };
    const first = await produceNormalizedAudio(request("provenance-first", { params: reuseParams }));
    const provenance = JSON.parse(await readFile(first.provenancePath, "utf8"));
    provenance.after.integratedLufs = -40;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(first.provenancePath, JSON.stringify(provenance));
    const second = await produceNormalizedAudio(request("provenance-second", { params: reuseParams }));
    const result = JSON.parse(await readFile(second.provenancePath, "utf8"));
    expect(result.reusedFrom).toBeUndefined();
    expect(second.sha256).toBe(first.sha256);
    expect(second.after.integratedLufs).toBe(first.after.integratedLufs);
  });
});
