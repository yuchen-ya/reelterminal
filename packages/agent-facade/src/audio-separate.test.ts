import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentFacade, type AgentFacade } from "./index";
import type { AudioProcessSeparateParams, JobStatusView } from "./types";
import type { SeparatedAudioArtifact } from "./audio-separate";
import { setDemucsModelReadyForTests, setSeparationWorkerForTests } from "./audio-separate";
import { setAudioModelsProbeForTests } from "./media/audio-models-runner";
import { resolveToolFfmpeg, runToolProcess } from "./media/ffmpeg-bin";

async function settle(facade: Pick<AgentFacade, "job.status">, jobId: string): Promise<JobStatusView> {
  for (let attempt = 0; attempt < 1200; attempt++) {
    const status = await facade["job.status"]({ jobId });
    if (!status.ok) throw new Error(status.error.message);
    if (["done", "error", "cancelled"].includes(status.value.state)) return status.value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("separation did not settle");
}

describe("audio separation asset lifecycle", () => {
  let root: string;
  let cache: string;
  let facade: AgentFacade;
  let params: AudioProcessSeparateParams;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "audio-separate-assets-"));
    cache = await mkdtemp(join(tmpdir(), "audio-separate-cache-"));
    const tools = await resolveToolFfmpeg();
    if (!tools) throw new Error("FFmpeg/ffprobe required for separation regression tests");
    const source = join(root, "source.wav");
    await runToolProcess(tools.ffmpeg, ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=6:sample_rate=44100", "-f", "lavfi", "-i", "anoisesrc=d=6:c=pink:a=0.04:seed=3", "-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo", "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", source]);
    facade = createAgentFacade({ mediaRoots: [root], artifactRoot: cache, projectRoots: [root] });
    await facade["project.create"]({ name: "Separation fixture" });
    const imported = await facade["media.import"]({ path: source });
    if (!imported.ok) throw new Error(imported.error.message);
    params = { mediaId: imported.value.mediaId, audioStream: 0, startSec: 1, endSec: 4, sampleRate: 48000, channels: 1, target: "vocals", expectedRevision: 1, idempotencyKey: "separate-fixture" };
    setAudioModelsProbeForTests(async () => ({
      available: true,
      details: {
        python: "/fake/python",
        pythonVersion: "3.10.19",
        scriptDir: "/fake/python",
        packages: { demucs: true, torch: true, soundfile: true, numpy: true },
        versions: { demucs: "4.1.0", torch: "2.9.1" },
      },
    }));
    setDemucsModelReadyForTests(async () => ({ verified: true, present: true, reason: null }));
    setSeparationWorkerForTests(async (request) => {
      const wavPath = String(request.wavPath);
      return {
        stems: ["drums", "bass", "other", "vocals"].map((stem) => ({ stem, path: wavPath })),
        device: "cuda",
        loadSeconds: 0.2,
        inferenceSeconds: 1.5,
        realtimeFactor: 0.5,
        peakGpuMemoryMb: 120,
        peakRssMb: null,
      };
    });
  });

  afterEach(async () => {
    setSeparationWorkerForTests(null);
    setDemucsModelReadyForTests(null);
    setAudioModelsProbeForTests(null);
    await rm(root, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  it("publishes one sample-aligned vocal stem, measures it and registers once", async () => {
    const started = await facade["audio.process.separate"](params);
    if (!started.ok) throw new Error(started.error.message);
    const done = await settle(facade, started.value.jobId);
    expect(done.state).toBe("done");
    const artifact = done.result as SeparatedAudioArtifact;
    expect(artifact).toMatchObject({
      target: "vocals",
      source: { mediaId: params.mediaId, startSec: 1, endSec: 4 },
      parameters: { target: "vocals", sampleRate: 48000, channels: 1 },
      timing: { sampleRate: 48000, channels: 1, sampleCount: 144000, processingDelaySamples: 0 },
      processing: { model: "htdemucs", device: "cuda", realtimeFactor: 0.5, peakGpuMemoryMb: 120, targetMix: "vocals stem" },
    });
    expect(artifact.processing.stems).toEqual(["drums", "bass", "other", "vocals"]);
    expect(artifact.path).toContain(join("generated-assets", "audio-separate"));
    const provenance = JSON.parse(await readFile(artifact.provenancePath, "utf8")) as Record<string, unknown>;
    expect(provenance).toMatchObject({ schemaVersion: 2, target: "vocals", processing: { model: "htdemucs" } });
    const registered = await facade["audio.process.register"]({ jobId: done.jobId, expectedRevision: 1 });
    if (!registered.ok) throw new Error(registered.error.message);
    expect(registered.value).toMatchObject({ revision: 2, type: "audio", replayed: false });
    expect(registered.value.mediaId).not.toBe(params.mediaId);
    const replay = await facade["audio.process.separate"](params);
    if (!replay.ok) throw new Error(replay.error.message);
    expect(replay.value).toMatchObject({ jobId: done.jobId, replayed: true });
  }, 60000);

  it("renders the instrumental mix and honors cancellation cleanup", async () => {
    const started = await facade["audio.process.separate"]({ ...params, target: "instrumental", channels: 2, idempotencyKey: "separate-instrumental" });
    if (!started.ok) throw new Error(started.error.message);
    const done = await settle(facade, started.value.jobId);
    expect(done.state).toBe("done");
    const artifact = done.result as SeparatedAudioArtifact;
    expect(artifact).toMatchObject({ target: "instrumental", timing: { sampleCount: 144000, channels: 2 }, processing: { targetMix: "drums + bass + other (amix normalize=0)" } });

    const cancelling = await facade["audio.process.separate"]({ ...params, idempotencyKey: "separate-cancel" });
    if (!cancelling.ok) throw new Error(cancelling.error.message);
    await facade["job.cancel"]({ jobId: cancelling.value.jobId });
    for (let attempt = 0; attempt < 400; attempt++) {
      const status = await facade["job.status"]({ jobId: cancelling.value.jobId });
      if (status.ok && ["cancelled", "error"].includes(status.value.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }, 60000);

  it("requires explicit consent for the pinned Demucs weights", async () => {
    setDemucsModelReadyForTests(async () => ({ verified: false, present: false, reason: "Demucs htdemucs is not present; authorize allowModelDownload:true" }));
    expect(await facade["audio.process.separate"]({ ...params, idempotencyKey: "separate-missing-model" }))
      .toMatchObject({ ok: false, error: { code: "UNSUPPORTED", message: expect.stringContaining("allowModelDownload") } });
  }, 30000);
});
