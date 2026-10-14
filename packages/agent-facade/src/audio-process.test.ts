import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentFacade, type AgentFacade } from "./index";
import type { AudioProcessNormalizeParams, JobStatusView } from "./types";
import type { NormalizeAudioArtifact } from "./audio-normalize";
import { resolveToolFfmpeg, runToolProcess } from "./media/ffmpeg-bin";
import { AgentFacadeSession } from "./session";
import * as audioAnalysis from "./audio-analysis";

async function settle(facade: Pick<AgentFacade, "job.status">, jobId: string): Promise<JobStatusView> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const status = await facade["job.status"]({ jobId });
    if (!status.ok) throw new Error(status.error.message);
    if (["done", "error", "cancelled"].includes(status.value.state)) return status.value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("normalization did not settle");
}

describe("audio normalization asset lifecycle (isolated headless project)", () => {
  let root: string;
  let cache: string;
  let facade: AgentFacade;
  let params: AudioProcessNormalizeParams;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "audio-process-assets-"));
    cache = await mkdtemp(join(tmpdir(), "audio-process-cache-"));
    const tools = await resolveToolFfmpeg();
    if (!tools) throw new Error("FFmpeg/ffprobe required for audio-process regression tests");
    const source = join(root, "source-44100.wav");
    await runToolProcess(tools.ffmpeg, ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=44100:duration=6", "-af", "volume=0.1", "-c:a", "pcm_s16le", source]);
    facade = createAgentFacade({ mediaRoots: [root], artifactRoot: cache, projectRoots: [root] });
    await facade["project.create"]({ name: "Normalize fixture" });
    const imported = await facade["media.import"]({ path: source });
    if (!imported.ok) throw new Error(imported.error.message);
    params = { mediaId: imported.value.mediaId, audioStream: 0, startSec: 1.123, endSec: 4.234,
      targetLufs: -16, truePeakDbtp: -1, loudnessRangeLu: 11, sampleRate: 48000, channels: 1,
      expectedRevision: 1, idempotencyKey: "normalize-fixture" };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Both paths were created by this test under the OS harness temp directory.
    await rm(root, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  it("does not offer or start normalization when FFmpeg lacks loudnorm", async () => {
    vi.spyOn(audioAnalysis, "audioAnalysisPreflight").mockResolvedValue({ available: false, reason: "FFmpeg loudnorm filter missing" });
    const capabilities = await facade["capabilities.get"]();
    expect(capabilities).toMatchObject({ ok: true, value: { audioNormalize: { available: false, reason: "FFmpeg loudnorm filter missing" } } });
    expect(await facade["audio.process.normalize"](params)).toMatchObject({ ok: false, error: { code: "UNSUPPORTED", message: "FFmpeg loudnorm filter missing" } });
  });

  it("remeasures, registers once, and persists a playable reference beyond analysis-cache cleanup", async () => {
    const started = await facade["audio.process.normalize"](params);
    if (!started.ok) throw new Error(started.error.message);
    const pendingRegistration = await facade["audio.process.register"]({ jobId: started.value.jobId, expectedRevision: 1 });
    expect(pendingRegistration).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const done = await settle(facade, started.value.jobId);
    expect(done.state, done.error?.message).toBe("done");
    const artifact = done.result as NormalizeAudioArtifact;
    expect(artifact.source).toMatchObject({ mediaId: params.mediaId, startSec: 1.123, endSec: 4.234, revision: 1 });
    expect(artifact.timing).toMatchObject({ sampleRate: 48000, channels: 1, sampleCount: 149328, durationSec: 3.111, outputStartSec: 0, processingDelaySamples: 0 });
    expect(Math.abs(artifact.after.integratedLufs - params.targetLufs)).toBeLessThan(.5);
    expect(artifact.after.integratedLufs - artifact.before.integratedLufs).toBeGreaterThan(15);
    expect(artifact.after.truePeakDbtp).toBeLessThanOrEqual(-.9);
    expect(artifact.path).toContain("generated-assets");
    expect(JSON.parse(await readFile(artifact.provenancePath, "utf8"))).toMatchObject({ before: artifact.before, after: artifact.after, parameters: artifact.parameters });
    const unchanged = await facade["project.get_state"]();
    expect(unchanged.ok && unchanged.value.revision).toBe(1);
    const replay = await facade["audio.process.normalize"](params);
    expect(replay).toMatchObject({ ok: true, value: { jobId: done.jobId, replayed: true } });
    expect(await facade["audio.process.normalize"]({ ...params, targetLufs: -18 })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });

    const registered = await facade["audio.process.register"]({ jobId: done.jobId, expectedRevision: 1 });
    if (!registered.ok) throw new Error(registered.error.message);
    expect(registered.value).toMatchObject({ revision: 2, type: "audio", replayed: false });
    expect(registered.value.mediaId).not.toBe(params.mediaId);
    const duplicate = await facade["audio.process.register"]({ jobId: done.jobId, expectedRevision: 1 });
    expect(duplicate).toMatchObject({ ok: true, value: { mediaId: registered.value.mediaId, revision: 2, replayed: true } });
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error(state.error.message);
    expect(state.value.project.mediaLibrary.items).toHaveLength(2);
    expect(state.value.project.timeline.tracks).toHaveLength(0);
    const saved = await facade["project.save"]({ path: join(root, "project.openreel.json") });
    if (!saved.ok) throw new Error(saved.error.message);
    await rm(cache, { recursive: true, force: true });
    const reopened = createAgentFacade({ mediaRoots: [root], projectRoots: [root] });
    const loaded = await reopened["project.open"]({ path: saved.value.path });
    if (!loaded.ok) throw new Error(loaded.error.message);
    const item = loaded.value.project.mediaLibrary.items.find((item) => item.id === registered.value.mediaId)!;
    expect(item.originalUrl).toBe(artifact.path);
    expect((await stat(artifact.path)).size).toBe(artifact.bytes);
    const tools = (await resolveToolFfmpeg())!;
    await expect(runToolProcess(tools.ffmpeg, ["-v", "error", "-i", artifact.path, "-f", "null", "-"])).resolves.toBeDefined();
    await rm(artifact.path);
    await rm(artifact.provenancePath);
    expect(await facade["audio.process.register"]({ jobId: done.jobId, expectedRevision: 1 }))
      .toMatchObject({ ok: true, value: { mediaId: registered.value.mediaId, revision: 2, replayed: true } });
  });

  it("requires a fresh explicit revision for registration after edits, and refuses changed measured bytes", async () => {
    const started = await facade["audio.process.normalize"](params);
    if (!started.ok) throw new Error(started.error.message);
    const done = await settle(facade, started.value.jobId);
    expect(done.state, done.error?.message).toBe("done");
    await facade["project.rename"]({ name: "Edited", expectedRevision: 1 });
    expect(await facade["audio.process.register"]({ jobId: done.jobId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const artifact = done.result as NormalizeAudioArtifact;
    await writeFile(artifact.path, "changed");
    expect(await facade["audio.process.register"]({ jobId: done.jobId, expectedRevision: 2 })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const state = await facade["project.get_state"]();
    expect(state.ok && state.value.project.mediaLibrary.items.length).toBe(1);
  });

  it("cancelled and failed jobs never register an asset or leave a published file", async () => {
    const started = await facade["audio.process.normalize"](params);
    if (!started.ok) throw new Error(started.error.message);
    await facade["job.cancel"]({ jobId: started.value.jobId });
    const cancelled = await settle(facade, started.value.jobId);
    expect(cancelled).toMatchObject({ state: "cancelled", result: null, artifact: null });
    expect(await facade["audio.process.register"]({ jobId: cancelled.jobId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const failed = await facade["audio.process.normalize"]({ ...params, audioStream: 9, idempotencyKey: "missing-stream" });
    if (!failed.ok) throw new Error(failed.error.message);
    expect(await settle(facade, failed.value.jobId)).toMatchObject({ state: "error", result: null, artifact: null });
    const unattainable = await facade["audio.process.normalize"]({ ...params, targetLufs: -5, truePeakDbtp: -9, idempotencyKey: "unattainable-target" });
    if (!unattainable.ok) throw new Error(unattainable.error.message);
    const unmet = await settle(facade, unattainable.value.jobId);
    expect(unmet).toMatchObject({ state: "error", result: null, artifact: null, error: { code: "JOB_FAILED", message: expect.stringContaining("remeasured output") } });
    expect(await facade["audio.process.register"]({ jobId: unmet.jobId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const generated = join(root, "generated-assets", "audio-normalize");
    const folders = await readdir(generated).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    for (const folder of folders) expect(await readdir(join(generated, folder))).toEqual([]);
    const state = await facade["project.get_state"]();
    expect(state.ok && state.value.project.mediaLibrary.items.length).toBe(1);
  });

  it("does not expose output when terminal checkpoint persistence fails", async () => {
    const session = new AgentFacadeSession({ mediaRoots: [root] });
    await session.projectCreate({ name: "Failed checkpoint" });
    const imported = await session.mediaImport({ path: join(root, "source-44100.wav") });
    if (!imported.ok) throw new Error(imported.error.message);
    const started = await session.audioProcessNormalize({ ...params, mediaId: imported.value.mediaId });
    if (!started.ok) throw new Error(started.error.message);
    session.observeJob(started.value.jobId, (status) => { if (status.state === "done") throw new Error("disk full"); });
    const done = await settle({ "job.status": (params) => session.jobStatus(params) }, started.value.jobId);
    expect(done).toMatchObject({ state: "error", result: null, error: { code: "BATCH_PERSISTENCE_FAILED" } });
    // Wait for the worker's deterministic cleanup (the status transition precedes unlink).
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(stat(join(root, "generated-assets", "audio-normalize", done.jobId))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
