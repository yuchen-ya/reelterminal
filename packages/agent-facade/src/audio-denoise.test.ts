import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentFacade, type AgentFacade } from "./index";
import type { AudioProcessDenoiseParams, JobStatusView } from "./types";
import type { DenoiseAudioArtifact } from "./audio-denoise";
import { resolveToolFfmpeg, runToolProcess } from "./media/ffmpeg-bin";

async function settle(facade: Pick<AgentFacade, "job.status">, jobId: string): Promise<JobStatusView> {
  for (let attempt = 0; attempt < 1200; attempt++) {
    const status = await facade["job.status"]({ jobId });
    if (!status.ok) throw new Error(status.error.message);
    if (["done", "error", "cancelled"].includes(status.value.state)) return status.value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("denoise did not settle");
}

describe("audio denoise asset lifecycle (isolated headless project)", () => {
  let root: string;
  let cache: string;
  let facade: AgentFacade;
  let params: AudioProcessDenoiseParams;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "audio-denoise-assets-"));
    cache = await mkdtemp(join(tmpdir(), "audio-denoise-cache-"));
    const tools = await resolveToolFfmpeg();
    if (!tools) throw new Error("FFmpeg/ffprobe required for audio-denoise regression tests");
    // A chirp (non-periodic enough for correlation) plus deterministic pink
    // noise gives the denoiser real work and the alignment check a real peak.
    const source = join(root, "source-44100.wav");
    await runToolProcess(tools.ffmpeg, [
      "-hide_banner", "-v", "error",
      "-f", "lavfi", "-i", "aevalsrc=0.20*sin(2*PI*(220+80*t)*t)+0.05*sin(2*PI*660*t):d=6:s=44100",
      "-f", "lavfi", "-i", "anoisesrc=d=6:c=pink:a=0.05:seed=7",
      "-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0",
      "-c:a", "pcm_s16le", source,
    ]);
    facade = createAgentFacade({ mediaRoots: [root], artifactRoot: cache, projectRoots: [root] });
    await facade["project.create"]({ name: "Denoise fixture" });
    const imported = await facade["media.import"]({ path: source });
    if (!imported.ok) throw new Error(imported.error.message);
    params = {
      mediaId: imported.value.mediaId, audioStream: 0, startSec: 1.123, endSec: 4.234,
      sampleRate: 48000, channels: 1, profile: "light",
      expectedRevision: 1, idempotencyKey: "denoise-fixture",
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  it("publishes a sample-aligned artifact, remeasures it and registers once", async () => {
    const started = await facade["audio.process.denoise"](params);
    if (!started.ok) throw new Error(started.error.message);
    const done = await settle(facade, started.value.jobId);
    expect(done.state).toBe("done");
    const artifact = done.result as DenoiseAudioArtifact;
    expect(artifact.source).toMatchObject({ mediaId: params.mediaId, startSec: 1.123, endSec: 4.234, revision: 1 });
    expect(artifact.parameters).toMatchObject({ profile: "light", declick: false, sampleRate: 48000, channels: 1 });
    const expectedSamples = Math.round((params.endSec - params.startSec) * 48000);
    expect(artifact.timing).toMatchObject({ sampleRate: 48000, channels: 1, sampleCount: expectedSamples, processingDelaySamples: 0 });
    expect(artifact.after.integratedLufs).toBeLessThan(0);
    expect(Number.isFinite(artifact.before.integratedLufs)).toBe(true);
    // The documented FFmpeg afftdn delay is 1200 samples at 48 kHz; the producer
    // must measure (not hardcode) it and compensate it.
    expect(artifact.processing.measuredFilterDelaySamples).toBe(1200);
    expect(artifact.processing.alignmentCheck).toMatchObject({ lagSamples: 0, verdict: "aligned" });
    expect(artifact.path).toContain(join("generated-assets", "audio-denoise"));
    const provenance = JSON.parse(await readFile(artifact.provenancePath, "utf8")) as Record<string, unknown>;
    expect(provenance).toMatchObject({ schemaVersion: 1, chainLabel: "afftdn=nr=12:nf=-25", method: expect.stringContaining("measured chain delay") });
    expect(provenance).toMatchObject({ processing: { measuredFilterDelaySamples: 1200 }, timing: { sampleCount: expectedSamples } });

    const registered = await facade["audio.process.register"]({ jobId: done.jobId, expectedRevision: 1 });
    if (!registered.ok) throw new Error(registered.error.message);
    expect(registered.value).toMatchObject({ revision: 2, type: "audio", replayed: false });
    expect(registered.value.mediaId).not.toBe(params.mediaId);

    const replay = await facade["audio.process.denoise"](params);
    if (!replay.ok) throw new Error(replay.error.message);
    expect(replay.value).toMatchObject({ jobId: done.jobId, replayed: true });
  }, 60000);

  it("supports the strong profile with declick and keeps the measured chain in provenance", async () => {
    const started = await facade["audio.process.denoise"]({ ...params, profile: "strong", declick: true, idempotencyKey: "denoise-strong" });
    if (!started.ok) throw new Error(started.error.message);
    const done = await settle(facade, started.value.jobId);
    expect(done.state).toBe("done");
    const artifact = done.result as DenoiseAudioArtifact;
    expect(artifact.processing.filterChain).toEqual(["adeclick=window=55:overlap=75", "afftdn=nr=24:nf=-35"]);
    expect(artifact.processing.measuredFilterDelaySamples).toBe(1200);
    expect(artifact.processing.alignmentCheck.verdict).toBe("aligned");
    expect(artifact.processing.alignmentCheck.lagSamples).toBe(0);
  }, 60000);

  it("gates ranges and sources without leaving partial assets", async () => {
    expect(await facade["audio.process.denoise"]({ ...params, endSec: 121.5, idempotencyKey: "too-long" }))
      .toMatchObject({ ok: false, error: { code: "INVALID_PARAMS", message: expect.stringContaining("120 seconds") } });
    expect(await facade["audio.process.denoise"]({ ...params, endSec: 99, idempotencyKey: "past-source" }))
      .toMatchObject({ ok: false, error: { code: "INVALID_PARAMS", message: expect.stringContaining("exceeds source duration") } });
    const before = await readdir(join(root, "generated-assets")).catch(() => []);
    expect(before).toEqual([]);
  }, 30000);

  it("cancels without publishing or leaving a pending directory", async () => {
    const started = await facade["audio.process.denoise"]({ ...params, idempotencyKey: "denoise-cancel" });
    if (!started.ok) throw new Error(started.error.message);
    expect(await facade["job.cancel"]({ jobId: started.value.jobId })).toMatchObject({ ok: true });
    for (let attempt = 0; attempt < 400; attempt++) {
      const status = await facade["job.status"]({ jobId: started.value.jobId });
      if (status.ok && ["cancelled", "error"].includes(status.value.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const generated = join(root, "generated-assets", "audio-denoise");
    const entries = await readdir(generated).catch(() => []);
    expect(entries).toEqual([]);
  }, 30000);
});
