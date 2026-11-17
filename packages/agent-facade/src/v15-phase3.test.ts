import { copyFile, mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ActionExecutor } from "@reelterminal/core/actions/action-executor";
import { ActionHistory } from "@reelterminal/core/actions/action-history";
import type { Action } from "@reelterminal/core/types/actions";
import type { Project } from "@reelterminal/core/types/project";
import {
  createAgentFacade,
  createLiveFacade,
  LiveWriterLease,
  type AgentFacade,
  type ExportProvider,
  type JobStatusView,
  type LiveAgentFacade,
  type RemixAudioArtifact,
} from "./index";
import type {
  LiveApplyActionsOptions,
  LiveEditorContext,
  LiveMediaImportRequest,
  LiveMediaImportResult,
  LiveProjectStore,
} from "./live-store";
import { resolveToolFfmpeg, runToolProcess } from "./media/ffmpeg-bin";
import { collectEntityIds, diffCreatedIdsByCategory } from "./ops";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { createEmptyProject } from "./project-factory";
import { makeTempDir, removeTempDir } from "./test-helpers";

const EIGHT_GIB = 8 * 1024 * 1024 * 1024;

class Phase3LiveStore implements LiveProjectStore {
  project: Project;
  revision = 0;
  contextRevision = 0;

  constructor(project: Project) {
    this.project = project;
  }

  async getIdentity() {
    return {
      projectId: this.project.id,
      projectName: this.project.name,
      workspaceId: "ws-phase3",
      workspaceInstanceId: "runtime-phase3",
      windowId: "win-phase3",
    };
  }

  async getState() {
    return { project: structuredClone(this.project), revision: this.revision };
  }

  async listRequirements() {
    return {
      revision: this.revision,
      requirements: [],
      summary: { total: 0, byStatus: { draft: 0, ready: 0, inProgress: 0, done: 0, blocked: 0 } },
    } as never;
  }

  async getRequirement(): Promise<never> {
    throw new Error("not implemented");
  }

  async getContext(): Promise<LiveEditorContext> {
    return {
      contextRevision: this.contextRevision,
      playheadSeconds: null,
      selectedClipIds: [],
      selectedTextIds: [],
      selectedMediaIds: [],
      timeRange: null,
      canvasPoint: null,
      references: {},
    };
  }

  async getProjectChanges() {
    return {
      fromRevision: 0,
      toRevision: this.revision,
      changes: [],
      nextCursor: null,
      requiresFullRefresh: false,
    };
  }

  async getHistory() {
    return {
      revision: this.revision,
      available: true,
      undoCount: 0,
      redoCount: 0,
      canUndo: false,
      canRedo: false,
      entries: [],
    };
  }

  async historyControl(): Promise<never> {
    throw new Error("not implemented");
  }

  async requestSave() {
    return { revision: this.revision };
  }

  async editorControl(): Promise<never> {
    throw new Error("not implemented");
  }

  async probeProjectAccess() {
    return { ok: true as const };
  }

  async applyActions(actions: readonly Action[], _opts: LiveApplyActionsOptions) {
    const draft = structuredClone(this.project);
    const createdIds = {
      tracks: [] as string[],
      clips: [] as string[],
      textClips: [] as string[],
      transitions: [] as string[],
      subtitles: [] as string[],
    };
    const executor = new ActionExecutor(new ActionHistory());
    for (const action of actions) {
      const before = collectEntityIds(draft);
      const res = await executor.execute(action, draft);
      if (!res.success) {
        throw new Error(res.error?.message || "action failed");
      }
      const diff = diffCreatedIdsByCategory(before, collectEntityIds(draft));
      createdIds.tracks.push(...diff.tracks);
      createdIds.clips.push(...diff.clips);
      createdIds.textClips.push(...diff.textClips);
      createdIds.transitions.push(...diff.transitions);
      createdIds.subtitles.push(...diff.subtitles);
    }
    this.project = draft;
    this.revision += 1;
    return { revision: this.revision, contextRevision: this.contextRevision, createdIds };
  }

  async importMedia(request: LiveMediaImportRequest): Promise<LiveMediaImportResult> {
    const id = `media-${this.project.mediaLibrary.items.length + 1}`;
    const item = {
      id,
      name: request.name,
      type: request.type,
      fileHandle: null,
      blob: null,
      metadata: {
        duration: request.metadata.durationSec,
        width: request.metadata.width,
        height: request.metadata.height,
        fps: request.metadata.frameRate ?? 30,
        hasAudio: request.type !== "image",
        fileSize: request.metadata.fileSize ?? request.sourceFile.size,
      },
      thumbnailUrl: null,
      waveformData: null,
      originalUrl: request.path,
      contentUrl: request.path,
    };
    const draft = structuredClone(this.project);
    const executor = new ActionExecutor(new ActionHistory());
    const result = await executor.execute(
      {
        type: "media/import",
        id: `import-${id}`,
        timestamp: Date.now(),
        params: { mediaItem: item },
      } as Action,
      draft,
    );
    if (!result.success) throw new Error(result.error?.message ?? "import failed");
    this.project = draft;
    this.revision += 1;
    return {
      revision: this.revision,
      mediaId: id,
    };
  }
}

async function waitForJob(
  facade: Pick<AgentFacade, "job.status">,
  jobId: string,
  timeoutMs = 30_000,
): Promise<JobStatusView> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await facade["job.status"]({ jobId });
    if (!res.ok) throw new Error(res.error.message);
    if (["done", "error", "cancelled"].includes(res.value.state)) {
      return res.value;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`job ${jobId} timed out`);
}

/**
 * Write a deterministic 120 BPM 48 kHz stereo PCM 16-bit WAV file:
 *  - 8 bars * 2.0 sec/bar = 16.0 seconds total
 *  - sharp percussive beat transient every 0.5 sec (for clean beat detection & cross-correlation)
 *  - 220 Hz carrier with 440/660/880 Hz overtones for intro/body/outro
 */
async function writeRhythmicMusicWav(filePath: string): Promise<void> {
  const sampleRate = 48_000;
  const channels = 2;
  const totalSec = 16;
  const totalFrames = sampleRate * totalSec;
  const beatFrames = sampleRate * 0.5; // 120 BPM
  const barFrames = sampleRate * 2.0; // 4/4 at 120 BPM
  const dataBytes = totalFrames * channels * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < totalFrames; i += 1) {
    const t = i / sampleRate;
    const bar = Math.floor(i / barFrames);
    const overtone = bar < 1 ? 440 : bar < 5 ? 660 : 880;
    const inBeat = i % beatFrames;
    const kickEnv = inBeat < 3600 ? Math.exp(-inBeat / 700) : 0;
    const carrier = 0.85 * Math.sin(2 * Math.PI * 220 * t) + 0.15 * Math.sin(2 * Math.PI * overtone * t);
    const sampleVal = carrier * (0.28 + 0.45 * kickEnv);
    const int16 = Math.max(-32767, Math.min(32767, Math.round(sampleVal * 32767)));
    const off = 44 + i * 4;
    buf.writeInt16LE(int16, off);
    buf.writeInt16LE(int16, off + 2);
  }

  await writeFile(filePath, buf);
}

describe("ReelTerminal v1.5 Phase 3", () => {
  let root: string;
  let cacheDir: string;
  let deliveryRoot: string;

  beforeEach(async () => {
    root = await realpath(await makeTempDir("v15-p3-media-"));
    cacheDir = await realpath(await makeTempDir("v15-p3-cache-"));
    deliveryRoot = await realpath(await makeTempDir("v15-p3-delivery-"));
  });

  afterEach(async () => {
    await removeTempDir(root);
    await removeTempDir(cacheDir);
    await removeTempDir(deliveryRoot);
  });

  describe("3.1(A) audio.process.remix beat-loop remix", () => {
    it("headless: extends music to targetDurationSec with explicit bars/outroAlign, verifies WAV via ffprobe and seam continuity, and registers idempotently", { timeout: 30_000 }, async () => {
      const bins = await resolveToolFfmpeg();
      if (!bins) throw new Error("FFmpeg/ffprobe required for Phase 3 tests");

      const musicPath = join(root, "music-120bpm.wav");
      await writeRhythmicMusicWav(musicPath);
      const sourceBytes = await readFile(musicPath);

      const facade = createAgentFacade({ mediaRoots: [root], artifactRoot: cacheDir });
      const created = await facade["project.create"]({ name: "Remix Headless" });
      expect(created.ok).toBe(true);
      const imported = await facade["media.import"]({ path: musicPath });
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;

      const caps = await facade["capabilities.get"]();
      expect(caps.ok).toBe(true);
      if (caps.ok) {
        expect(caps.value.audioRemix.available).toBe(true);
      }

      const started = await facade["audio.process.remix"]({
        mediaId: imported.value.mediaId,
        audioStream: 0,
        targetDurationSec: 22,
        bpm: 120,
        beatsPerBar: 4,
        loopBodyBars: { startBar: 1, endBar: 5 },
        outroAlign: { outroStartBar: 5, landAtSec: 22, tailFadeOutSec: 1.0 },
        crossfadeMs: 25,
        targetIlu: -16,
        expectedRevision: 1,
        idempotencyKey: "remix-extend-1",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      // Idempotent replay returns the same job without queueing another task.
      const replayed = await facade["audio.process.remix"]({
        mediaId: imported.value.mediaId,
        audioStream: 0,
        targetDurationSec: 22,
        bpm: 120,
        beatsPerBar: 4,
        loopBodyBars: { startBar: 1, endBar: 5 },
        outroAlign: { outroStartBar: 5, landAtSec: 22, tailFadeOutSec: 1.0 },
        crossfadeMs: 25,
        targetIlu: -16,
        expectedRevision: 1,
        idempotencyKey: "remix-extend-1",
      });
      expect(replayed.ok).toBe(true);
      if (replayed.ok) {
        expect(replayed.value).toMatchObject({ jobId: started.value.jobId, replayed: true });
      }

      const done = await waitForJob(facade, started.value.jobId);
      expect(done.state, done.error?.message).toBe("done");
      expect(done.route).toBe("local-beat-loop-remix");

      const artifact = done.result as RemixAudioArtifact;
      expect(artifact.bpm).toBe(120);
      expect(artifact.bpmAutoDetected).toBe(false);
      expect(artifact.beatsPerBar).toBe(4);
      expect(Math.abs(artifact.actualDurationSec - 22)).toBeLessThan(0.1);
      expect(artifact.seams.length).toBeGreaterThanOrEqual(1);
      for (const seam of artifact.seams) {
        expect(seam.correlation).toBeGreaterThan(0.5);
        expect(seam.timelineSec).toBeGreaterThan(0);
        expect(seam.timelineSec).toBeLessThan(artifact.actualDurationSec);
      }

      // Probe the encoded stream, independently of the producer's result metadata.
      const probed = await runToolProcess(bins.ffprobe, [
        "-v", "error",
        "-show_entries", "stream=codec_name,sample_rate,channels:format=duration",
        "-of", "json",
        artifact.path,
      ]);
      const probeJson = JSON.parse(probed.stdout.toString("utf8")) as {
        streams: Array<{ codec_name: string; sample_rate: string; channels: number }>;
        format: { duration: string };
      };
      expect(probeJson.streams[0]?.sample_rate).toBe("48000");
      expect(probeJson.streams[0]?.channels).toBe(2);
      expect(probeJson.streams[0]?.codec_name).toBe("pcm_s24le");
      expect(Math.abs(Number(probeJson.format.duration) - 22)).toBeLessThan(1 / 48_000);

      // Decode rather than guessing WAV chunk offsets or dropping the low PCM byte.
      const decoded = await runToolProcess(bins.ffmpeg, [
        "-v", "error", "-i", artifact.path, "-map", "0:a:0", "-f", "f32le", "pipe:1",
      ]);
      const pcm = decoded.stdout;
      expect(pcm.length).toBe(22 * 48_000 * 2 * 4);
      const sampleAt = (frame: number, channel: number) => pcm.readFloatLE((frame * 2 + channel) * 4);
      const rms = (startSec: number, endSec: number, channel: number) => {
        const start = Math.round(startSec * 48_000);
        const end = Math.round(endSec * 48_000);
        let sum = 0;
        for (let frame = start; frame < end; frame++) sum += sampleAt(frame, channel) ** 2;
        return Math.sqrt(sum / (end - start));
      };
      for (const seam of artifact.seams) {
        const first = Math.round((seam.timelineSec - 0.01) * 48_000);
        const last = Math.round((seam.timelineSec + 0.025 + 0.01) * 48_000);
        expect(first).toBeGreaterThan(0);
        expect(last).toBeLessThan(pcm.length / 8);
        for (const channel of [0, 1]) {
          let maxStep = 0;
          for (let frame = first; frame < last; frame++) {
            maxStep = Math.max(maxStep, Math.abs(sampleAt(frame, channel) - sampleAt(frame - 1, channel)));
          }
          // This fixture's highest tone is 880 Hz; normal adjacent samples are
          // within 0.08 full scale. A phase cut or click must not pass on RMS alone.
          expect(maxStep, `channel ${channel}, seam at ${seam.timelineSec}s`).toBeLessThan(0.08);
          expect(rms(seam.timelineSec, seam.timelineSec + 0.01, channel)).toBeGreaterThan(0.05);
        }
      }
      for (const channel of [0, 1]) {
        const bodyRms = rms(20.5, 20.9, channel);
        expect(bodyRms).toBeGreaterThan(0.05);
        expect(rms(21.9, 22, channel)).toBeLessThan(bodyRms * 0.03);
        expect(Math.abs(sampleAt(22 * 48_000 - 1, channel))).toBeLessThan(1e-5);
      }

      // The optional loudness target must affect the real output, not only provenance.
      const measured = await runToolProcess(bins.ffmpeg, [
        "-hide_banner", "-i", artifact.path,
        "-af", "loudnorm=I=-16:print_format=json", "-f", "null", "-",
      ]);
      const loudnessJson = measured.stderr.match(/\{\s*"input_i"[\s\S]*?\}/);
      expect(loudnessJson).not.toBeNull();
      const loudness = JSON.parse(loudnessJson![0]) as { input_i: string };
      expect(Number(loudness.input_i)).toBeCloseTo(-16, 0);

      const stateBeforeRegister = await facade["project.get_state"]();
      expect(stateBeforeRegister).toMatchObject({ ok: true, value: { revision: 1 } });
      if (stateBeforeRegister.ok) {
        expect(stateBeforeRegister.value.project.mediaLibrary.items).toHaveLength(1);
      }
      const conflictingReplay = await facade["audio.process.remix"]({
        mediaId: imported.value.mediaId,
        targetDurationSec: 23,
        idempotencyKey: "remix-extend-1",
      });
      expect(conflictingReplay).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
      const provenance = JSON.parse(await readFile(artifact.provenancePath, "utf8")) as {
        bpm: number;
        seams: unknown[];
        actualDurationSec: number;
      };
      expect(provenance.bpm).toBe(120);
      expect(provenance.seams).toEqual(artifact.seams);
      expect(provenance.actualDurationSec).toBe(22);
      expect((await readFile(musicPath)).equals(sourceBytes)).toBe(true);

      // Register output into media library without altering existing source media.
      const reg = await facade["audio.process.register"]({
        jobId: started.value.jobId,
        expectedRevision: 1,
      });
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;
      expect(reg.value.type).toBe("audio");
      expect(reg.value.mediaId).not.toBe(imported.value.mediaId);
      expect(reg.value.revision).toBe(2);
      const registeredAgain = await facade["audio.process.register"]({ jobId: started.value.jobId, expectedRevision: 2 });
      expect(registeredAgain).toMatchObject({ ok: true, value: { mediaId: reg.value.mediaId, replayed: true } });

      const state = await facade["project.get_state"]();
      expect(state.ok).toBe(true);
      if (state.ok) {
        expect(state.value.revision).toBe(2);
        expect(state.value.project.mediaLibrary.items).toHaveLength(2);
        expect(state.value.project.mediaLibrary.items[0]).toEqual(
          stateBeforeRegister.ok ? stateBeforeRegister.value.project.mediaLibrary.items[0] : undefined,
        );
      }
    });

    it("live: auto-detects BPM when omitted, shortens track cleanly, and registers through live store", { timeout: 30_000 }, async () => {
      const bins = await resolveToolFfmpeg();
      if (!bins) throw new Error("FFmpeg/ffprobe required for Phase 3 tests");

      const musicPath = join(root, "live-120bpm.wav");
      await writeRhythmicMusicWav(musicPath);

      const store = new Phase3LiveStore(createEmptyProject("Remix Live"));
      const live: LiveAgentFacade = createLiveFacade({
        store,
        lease: new LiveWriterLease(),
        sessionId: "agent-phase3-remix",
        access: "write",
        mediaRoots: [root],
        artifactRoot: cacheDir,
      });
      onTestFinished(() => live.dispose());

      const imported = await live["media.import"]({ path: musicPath });
      if (!imported.ok) throw new Error(`live media.import failed: ${imported.error.code}: ${imported.error.message}`);

      const started = await live["audio.process.remix"]({
        mediaId: imported.value.mediaId,
        targetDurationSec: 10,
        idempotencyKey: "remix-live-shorten",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      const done = await waitForJob(live, started.value.jobId);
      expect(done.state, done.error?.message).toBe("done");
      const artifact = done.result as RemixAudioArtifact;
      expect(artifact.bpmAutoDetected).toBe(true);
      expect(Math.abs(artifact.bpm - 120)).toBeLessThan(2);
      expect(artifact.actualDurationSec).toBe(10);
      expect(store.revision).toBe(1);
      expect(store.project.mediaLibrary.items).toHaveLength(1);

      const reg = await live["audio.process.register"]({
        jobId: started.value.jobId,
        expectedRevision: store.revision,
      });
      expect(reg.ok).toBe(true);
      expect(store.project.mediaLibrary.items).toHaveLength(2);
      expect(store.revision).toBe(2);
      const repeat = await live["audio.process.register"]({ jobId: started.value.jobId, expectedRevision: 2 });
      expect(repeat).toMatchObject({ ok: true, value: { replayed: true } });
      expect(store.revision).toBe(2);
      expect(store.project.mediaLibrary.items).toHaveLength(2);
    });
  });

  describe("3.1(B) clip.setDucking & clip.setDuckingFromAnalysis tailEnvelope", () => {
    it("synthesizes post-release swell and tail fade-out for clip.setDucking (auto clipDurationSec) and clip.setDuckingFromAnalysis", async () => {
      writeTinyMp4(root);
      const facade = createAgentFacade({ mediaRoots: [root], artifactRoot: cacheDir });
      await facade["project.create"]({ name: "Ducking Tail" });
      const imp = await facade["media.import"]({ path: `${root}/tiny-6s.mp4` });
      expect(imp.ok).toBe(true);
      if (!imp.ok) return;

      // Seed speech clip (track a1) + music clip (track a2, 6s duration).
      const setup = await facade["edit.apply"]({
        ops: [
          { op: "track.add", trackType: "audio", trackId: "a1" },
          { op: "track.add", trackType: "audio", trackId: "a2" },
          { op: "track.add", trackType: "audio", trackId: "a3" },
          {
            op: "clip.add",
            trackId: "a1",
            mediaId: imp.value.mediaId,
            startTime: 0,
            duration: 5,
            clipId: "speech-1",
          },
          {
            op: "clip.add",
            trackId: "a2",
            mediaId: imp.value.mediaId,
            startTime: 0,
            duration: 6,
            clipId: "music-1",
          },
          {
            op: "clip.add",
            trackId: "a3",
            mediaId: imp.value.mediaId,
            startTime: 0,
            duration: 6,
            clipId: "music-2",
          },
        ],
      });
      expect(setup.ok).toBe(true);
      if (!setup.ok) return;

      // Set music-1 base volume to 0.8, then apply clip.setDucking with tailEnvelope (auto clipDurationSec = 6s).
      const ducked = await facade["edit.apply"]({
        expectedRevision: setup.value.revision,
        ops: [
          { op: "clip.setVolume", clipId: "music-1", volume: 0.8 },
          {
            op: "clip.setDucking",
            clipId: "music-1",
            presenceRanges: [{ start: 0.5, end: 2.0 }],
            threshold: -30,
            reduction: 0.6,
            attack: 0.1,
            release: 0.2,
            holdTime: 0.15,
            tailEnvelope: {
              swellGainRatio: 1.25,
              swellRampSec: 1.0,
              fadeOutDurationSec: 1.0,
            },
          },
        ],
      });
      expect(ducked.ok).toBe(true);
      if (!ducked.ok) return;

      const state1 = await facade["project.get_state"]();
      expect(state1.ok).toBe(true);
      if (!state1.ok) return;
      const music1 = state1.value.project.timeline.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === "music-1")!;
      const vol1 = (music1.automation?.volume ?? []) as ReadonlyArray<{ time: number; value: number; curve?: string }>;
      // Ends with swell peak 0.8 * 1.25 = 1.0, then fades to 0 at clip duration 6.0.
      expect(vol1.some((p) => Math.abs(p.value - 1.0) < 1e-4 && p.curve === "s-curve")).toBe(true);
      expect(vol1[vol1.length - 1]).toMatchObject({ time: 6, value: 0, curve: "s-curve" });

      // 2) Reject passing points alongside tailEnvelope atomically.
      const invalid = await facade["edit.apply"]({
        expectedRevision: ducked.value.revision,
        ops: [
          { op: "clip.setVolume", clipId: "music-1", volume: 0.2 },
          {
            op: "clip.setDucking",
            clipId: "music-2",
            threshold: -30,
            reduction: 0.5,
            attack: 0.1,
            release: 0.2,
            holdTime: 0.15,
            points: [
              { time: 0, value: 1 },
              { time: 1, value: 0.5 },
            ],
            tailEnvelope: { swellGainRatio: 1.2 },
          },
        ],
      });
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) {
        expect(invalid.error.code).toBe("INVALID_PARAMS");
      }
      expect(await facade["project.get_state"]()).toEqual(state1);

      // 3) End-to-end clip.setDuckingFromAnalysis with a persisted speechActivity analysis record + tailEnvelope.
      const { saveAnalysisRecord } = await import("./analysis-records");
      const currentState = await facade["project.get_state"]();
      if (!currentState.ok) throw new Error("state error");
      const tinyPath = join(root, "tiny-6s.mp4");
      const tinyStat = await stat(tinyPath);
      const savedRecord = await saveAnalysisRecord(cacheDir, {
        projectId: currentState.value.project.id,
        sourceRevision: currentState.value.revision,
        coordinateSpace: "source",
        subject: {
          mediaId: imp.value.mediaId,
          name: "tiny-6s.mp4",
          sourcePath: tinyPath,
          sourceFingerprint: { size: tinyStat.size, lastModified: Math.round(tinyStat.mtimeMs) },
        },
        analysisTypes: ["speechActivity"],
        rangeSec: { startSec: 0, endSec: 5 },
        config: { analysisTypes: ["speechActivity"], startSec: 0, endSec: 5, cloudUpload: false },
        provenance: [{ kind: "local-measurement", provider: "local-silero-vad-onnx", analysisType: "speechActivity" }],
        observations: [
          {
            source: "speechActivity",
            facts: {
              speechRegions: [{ startSec: 0.5, endSec: 2.0, durationSec: 1.5 }],
              regionCount: 1,
            },
          },
        ],
        inferences: [],
        recommendations: [],
        unknowns: [],
        recheckOf: null,
        cloudOpinion: null,
      });

      const applyFromAnalysis = await facade["edit.apply"]({
        expectedRevision: ducked.value.revision,
        ops: [
          {
            op: "clip.setDuckingFromAnalysis",
            clipId: "music-2",
            speechClipId: "speech-1",
            recordId: savedRecord.id,
            threshold: -30,
            reduction: 0.5,
            attack: 0.1,
            release: 0.2,
            holdTime: 0.15,
            tailEnvelope: {
              swellGainRatio: 1.2,
              swellRampSec: 0.8,
              fadeOutDurationSec: 1.2,
            },
          },
        ],
      });
      expect(applyFromAnalysis.ok).toBe(true);
      const state2 = await facade["project.get_state"]();
      if (!state2.ok) throw new Error("state2 failed");
      const music2 = state2.value.project.timeline.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === "music-2")!;
      expect(music2.automation?.volume?.at(-1)).toMatchObject({ time: 6, value: 0, curve: "s-curve" });
    });
  });

  describe("3.2 export.start coverImagePath + SRT + Chapters publishing", () => {
    it("headless & live: muxes attached_pic PNG cover verified by ffprobe, writes SRT (subtitles + textClips fallback) and chapters.txt with 00:00 Intro prepend", { timeout: 30_000 }, async () => {
      const bins = await resolveToolFfmpeg();
      if (!bins) throw new Error("FFmpeg/ffprobe required for Phase 3 tests");

      writeTinyMp4(root);
      const coverPath = join(root, "cover.png");
      await runToolProcess(bins.ffmpeg, [
        "-y", "-v", "error",
        "-f", "lavfi", "-i", "color=c=dodgerblue:s=64x64:d=0.1",
        "-frames:v", "1",
        coverPath,
      ]);

      let exportStarts = 0;
      const exportProvider: ExportProvider = {
        id: "test-ffmpeg",
        preflight: async () => ({ available: true, details: { route: "test-ffmpeg" } }),
        startExport: async (req, cb) => {
          exportStarts++;
          cb.onRunning();
          const outputPath = join(req.jobDir, "output.mp4");
          await mkdir(req.jobDir, { recursive: true });
          await runToolProcess(bins.ffmpeg, [
            "-y", "-v", "error",
            "-f", "lavfi", "-i", "color=c=black:s=64x64:d=2",
            "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=2",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest",
            outputPath,
          ]);
          const sizeBytes = (await stat(outputPath)).size;
          cb.onDone({
            path: outputPath,
            sizeBytes,
            route: "chromium-frames-ffmpeg",
            framesEncoded: 60,
          });
        },
        cancel: async () => undefined,
      };

      const facade = createAgentFacade({
        mediaRoots: [root],
        artifactRoot: cacheDir,
        deliveryRoots: [deliveryRoot],
        exportProvider,
      });

      await facade["project.create"]({ name: "Publishing Test" });
      const imp = await facade["media.import"]({ path: `${root}/tiny-6s.mp4` });
      expect(imp.ok).toBe(true);
      if (!imp.ok) return;

      const edit = await facade["edit.apply"]({
        ops: [
          { op: "track.add", trackType: "video", trackId: "v1" },
          { op: "track.add", trackType: "text", trackId: "t1" },
          { op: "clip.add", trackId: "v1", mediaId: imp.value.mediaId, startTime: 0, duration: 5 },
          { op: "text.create", trackId: "t1", startTime: 0.5, duration: 2, text: "Must not override actual subtitles" },
          { op: "marker.add", target: { kind: "timeRange", start: 5, end: 6 }, label: "Main Topic" },
          {
            op: "subtitle.importSrt",
            srtContent: "1\n00:00:00,000 --> 00:00:02,000\nHello World\n",
          },
        ],
      });
      expect(edit.ok).toBe(true);

      // Path traversal / outside mediaRoots rejected before creating any job.
      const outsideCover = await facade["export.start"]({
        coverImagePath: join(deliveryRoot, "evil-cover.png"),
        idempotencyKey: "exp-bad-cover",
      });
      expect(outsideCover.ok).toBe(false);
      if (!outsideCover.ok) expect(outsideCover.error.code).toBe("INVALID_PARAMS");

      // Sidecar path escaping delivery output dir is rejected with INVALID_PARAMS.
      const escapedSidecar = await facade["export.start"]({
        exportSubtitlesSrt: join(deliveryRoot, "escaped.srt"),
        idempotencyKey: "exp-bad-sidecar",
      });
      expect(escapedSidecar.ok).toBe(false);
      if (!escapedSidecar.ok) expect(escapedSidecar.error.code).toBe("INVALID_PARAMS");
      expect(exportStarts).toBe(0);

      const invalidCoverPath = join(root, "invalid.png");
      await writeFile(invalidCoverPath, "not an image");
      expect(await facade["export.start"]({ coverImagePath: invalidCoverPath })).toMatchObject({
        ok: false, error: { code: "INVALID_PARAMS" },
      });
      expect(exportStarts).toBe(0);

      const protectedMp4 = join(deliveryRoot, "jobs", "protected", "output", "final.mp4");
      await mkdir(dirname(protectedMp4), { recursive: true });
      const protectedSrt = protectedMp4.replace(/\.mp4$/, ".srt");
      await writeFile(protectedSrt, "user-authored subtitles");
      expect(await facade["export.start"]({ destinationPath: protectedMp4, exportSubtitlesSrt: true })).toMatchObject({
        ok: false, error: { code: "CONFLICT" },
      });
      expect(await readFile(protectedSrt, "utf8")).toBe("user-authored subtitles");
      expect(exportStarts).toBe(0);

      const deliveredMp4 = join(deliveryRoot, "jobs", "phase3-pub", "output", "final.mp4");
      await mkdir(dirname(deliveredMp4), { recursive: true });
      const started = await facade["export.start"]({
        destinationPath: deliveredMp4,
        coverImagePath: coverPath,
        exportSubtitlesSrt: true,
        exportChaptersTxt: true,
        idempotencyKey: "exp-pub-1",
      });
      if (!started.ok) throw new Error(`export.start failed: ${started.error.code}: ${started.error.message}`);

      const done = await waitForJob(facade, started.value.jobId);
      expect(done.state, done.error?.message).toBe("done");
      expect(done.deliveredTo).toBe(deliveredMp4);
      expect(done.artifact?.sidecarArtifacts?.subtitlesSrtPath).toBe(deliveredMp4.replace(/\.mp4$/, ".srt"));
      expect(done.artifact?.sidecarArtifacts?.chaptersTxtPath).toBe(deliveredMp4.replace(/\.mp4$/, ".chapters.txt"));
      expect(done.artifact?.sidecarArtifacts?.hasAttachedCover).toBe(true);

      // Verify embedded attached_pic stream via ffprobe.
      const probe = await runToolProcess(bins.ffprobe, [
        "-v", "error",
        "-show_entries", "stream=index,codec_type,codec_name:stream_disposition=attached_pic",
        "-of", "json",
        deliveredMp4,
      ]);
      const parsed = JSON.parse(probe.stdout.toString("utf8")) as {
        streams: Array<{ index: number; codec_type: string; codec_name: string; disposition?: { attached_pic?: number } }>;
      };
      const videoStreams = parsed.streams.filter((s) => s.codec_type === "video");
      expect(videoStreams).toHaveLength(2);
      expect(videoStreams.filter(s => s.disposition?.attached_pic === 1)).toEqual([
        expect.objectContaining({ codec_name: "png" }),
      ]);
      expect(videoStreams.filter(s => s.disposition?.attached_pic !== 1)).toEqual([
        expect.objectContaining({ codec_name: "h264" }),
      ]);
      expect(parsed.streams.filter(s => s.codec_type === "audio")).toEqual([
        expect.objectContaining({ codec_name: "aac" }),
      ]);

      // Verify delivered sidecar files (.srt & .chapters.txt).
      const deliveredSrt = deliveredMp4.replace(/\.mp4$/, ".srt");
      const deliveredChapters = deliveredMp4.replace(/\.mp4$/, ".chapters.txt");
      expect(await readFile(deliveredSrt, "utf8")).toBe("1\n00:00:00,000 --> 00:00:02,000\nHello World");
      const chaptersText = await readFile(deliveredChapters, "utf8");
      expect(chaptersText).toBe("00:00 Intro\n00:05 Main Topic\n");

      // Test textClips SRT fallback & live parity via LiveAgentFacade!
      const liveProject = createEmptyProject("Live Pub");
      const store = new Phase3LiveStore(liveProject);
      const live = createLiveFacade({
        store,
        lease: new LiveWriterLease(),
        sessionId: "agent-phase3-export",
        access: "write",
        mediaRoots: [root],
        artifactRoot: cacheDir,
        deliveryRoots: [deliveryRoot],
        exportProvider,
      });
      onTestFinished(() => live.dispose());
      const liveImp = await live["media.import"]({ path: `${root}/tiny-6s.mp4` });
      if (!liveImp.ok) throw new Error(liveImp.error.message);
      const liveEdits = await live["edit.apply"]({
        ops: [
          { op: "track.add", trackType: "video", trackId: "v1" },
          { op: "track.add", trackType: "text", trackId: "t1" },
          { op: "clip.add", trackId: "v1", mediaId: liveImp.value.mediaId, startTime: 0, duration: 4 },
          { op: "text.create", trackId: "t1", startTime: 0.5, duration: 2.0, text: "Fallback Overlay Caption" },
          { op: "marker.add", target: { kind: "timeRange", start: 0, end: 1 }, label: "Opening Hook" },
          { op: "marker.add", target: { kind: "timeRange", start: 2, end: 3 }, label: "Mid Cut" },
          { op: "marker.add", target: { kind: "timeRange", start: 3665, end: 3670 }, label: "Hour Mark" },
        ],
      });
      expect(liveEdits.ok).toBe(true);

      const liveOutMp4 = join(deliveryRoot, "jobs", "phase3-live", "output", "live.mp4");
      await mkdir(dirname(liveOutMp4), { recursive: true });
      const liveStart = await live["export.start"]({
        destinationPath: liveOutMp4,
        coverImagePath: coverPath,
        exportSubtitlesSrt: true,
        exportChaptersTxt: true,
        idempotencyKey: "live-exp-pub-1",
      });
      if (!liveStart.ok) throw new Error(`live export.start failed: ${liveStart.error.code}: ${liveStart.error.message}`);
      const liveDone = await waitForJob(live, liveStart.value.jobId);
      expect(liveDone.state, liveDone.error?.message).toBe("done");
      expect(await readFile(liveOutMp4.replace(/\.mp4$/, ".srt"), "utf8")).toBe(
        "1\n00:00:00,500 --> 00:00:02,500\nFallback Overlay Caption",
      );
      expect(await readFile(liveOutMp4.replace(/\.mp4$/, ".chapters.txt"), "utf8")).toBe(
        "00:00:00 Opening Hook\n00:00:02 Mid Cut\n01:01:05 Hour Mark\n",
      );
      expect(exportStarts).toBe(2);
    });

    it.each(["headless", "live"] as const)("%s: sidecars use the export snapshot when edits occur before encoding completes", async (mode) => {
      writeTinyMp4(root);
      const sourcePath = join(root, "tiny-6s.mp4");
      let release!: () => void;
      const encoderGate = new Promise<void>(resolve => { release = resolve; });
      onTestFinished(() => release());
      const startExport = vi.fn<ExportProvider["startExport"]>(async (request, callbacks) => {
        callbacks.onRunning();
        await encoderGate;
        await mkdir(request.jobDir, { recursive: true });
        const outputPath = join(request.jobDir, "snapshot.mp4");
        await copyFile(sourcePath, outputPath);
        callbacks.onDone({ path: outputPath, sizeBytes: (await stat(outputPath)).size, route: "chromium-frames-ffmpeg", framesEncoded: 60 });
      });
      const exportProvider: ExportProvider = {
        id: "snapshot-fixture",
        preflight: async () => ({ available: true }),
        startExport,
        cancel: async () => { release(); },
      };
      const options = { mediaRoots: [root], artifactRoot: cacheDir, exportProvider };
      const store = new Phase3LiveStore(createEmptyProject("Snapshot Live"));
      const facade = mode === "headless"
        ? createAgentFacade(options)
        : createLiveFacade({ ...options, store, lease: new LiveWriterLease(), sessionId: "snapshot-export", access: "write" });
      if (mode === "headless") {
        expect(await facade["project.create"]({ name: "Snapshot Headless" })).toMatchObject({ ok: true });
      } else {
        onTestFinished(() => (facade as LiveAgentFacade).dispose());
      }
      const imported = await facade["media.import"]({ path: sourcePath });
      if (!imported.ok) throw new Error(imported.error.message);
      const initial = await facade["edit.apply"]({ ops: [
        { op: "track.add", trackId: "v1", trackType: "video" },
        { op: "clip.add", trackId: "v1", mediaId: imported.value.mediaId, startTime: 0, duration: 6 },
        { op: "subtitle.importSrt", srtContent: "1\n00:00:01,000 --> 00:00:02,000\nOriginal caption\n" },
        { op: "marker.add", target: { kind: "timeRange", start: 1, end: 2 }, label: "Original chapter" },
      ] });
      if (!initial.ok) throw new Error(initial.error.message);
      const started = await facade["export.start"]({
        expectedRevision: initial.value.revision,
        exportSubtitlesSrt: true,
        exportChaptersTxt: true,
      });
      if (!started.ok) throw new Error(started.error.message);
      const laterEdit = await facade["edit.apply"]({ expectedRevision: initial.value.revision, ops: [
        { op: "subtitle.importSrt", srtContent: "1\n00:00:03,000 --> 00:00:04,000\nLater caption\n" },
        { op: "marker.add", target: { kind: "timeRange", start: 3, end: 4 }, label: "Later chapter" },
      ] });
      expect(laterEdit).toMatchObject({ ok: true, value: { revision: initial.value.revision + 1 } });
      release();
      const done = await waitForJob(facade, started.value.jobId);
      expect(done.state, done.error?.message).toBe("done");
      expect(done.sourceRevision).toBe(initial.value.revision);
      expect(startExport).toHaveBeenCalledTimes(1);
      const sidecars = done.artifact?.sidecarArtifacts;
      expect(sidecars?.subtitlesSrtPath).toBeDefined();
      expect(sidecars?.chaptersTxtPath).toBeDefined();
      expect(await readFile(sidecars!.subtitlesSrtPath!, "utf8")).toBe("1\n00:00:01,000 --> 00:00:02,000\nOriginal caption");
      expect(await readFile(sidecars!.chaptersTxtPath!, "utf8")).toBe("00:00 Intro\n00:01 Original chapter\n");
    });
  });

  describe("3.3 8 GiB live media import limit", () => {
    it("imports valid padded MP4s at 300 MiB and exactly 8 GiB, and rejects one byte over without committing", async () => {
      const store = new Phase3LiveStore(createEmptyProject("Big Media"));
      const importMedia = vi.spyOn(store, "importMedia");
      const live = createLiveFacade({
        store,
        lease: new LiveWriterLease(),
        sessionId: "agent-phase3-8gib",
        access: "write",
        mediaRoots: [root],
        artifactRoot: cacheDir,
      });
      onTestFinished(() => live.dispose());

      const caps = await live["capabilities.get"]();
      expect(caps.ok).toBe(true);
      if (caps.ok) {
        expect(caps.value.mediaImport.limits?.maxFileBytes).toBe(EIGHT_GIB);
      }

      writeTinyMp4(root);
      const sourcePath = join(root, "tiny-6s.mp4");
      const sourceSize = (await stat(sourcePath)).size;
      for (const size of [300 * 1024 * 1024, EIGHT_GIB]) {
        const bigPath = join(root, `padded-${size}.mp4`);
        await copyFile(sourcePath, bigPath);
        const file = await open(bigPath, "r+");
        try {
          // A valid extended-size MP4 free box lets ffprobe skip sparse padding.
          const freeBox = Buffer.alloc(16);
          freeBox.writeUInt32BE(1, 0);
          freeBox.write("free", 4);
          freeBox.writeBigUInt64BE(BigInt(size - sourceSize), 8);
          await file.write(freeBox, 0, freeBox.length, sourceSize);
          await file.truncate(size);
        } finally {
          await file.close();
        }
        const imported = await live["media.import"]({ path: bigPath, expectedRevision: store.revision });
        expect(imported, `valid ${size}-byte media must reach the live bridge`).toMatchObject({ ok: true });
        expect(importMedia).toHaveBeenLastCalledWith(expect.objectContaining({
          path: bigPath,
          type: "video",
          sourceFile: expect.objectContaining({ size }),
          metadata: expect.objectContaining({ durationSec: 6, width: 320, height: 180, fileSize: size }),
        }), expect.objectContaining({ expectedRevision: store.revision - 1 }));
      }
      expect(store.revision).toBe(2);
      expect(store.project.mediaLibrary.items).toHaveLength(2);
      const beforeReject = structuredClone(store.project);

      // Create a sparse file >8 GiB and verify it hits the 8 GiB size limit immediately.
      const hugePath = join(root, "sparse-over-8gib.mp4");
      const fhHuge = await open(hugePath, "w");
      try {
        await fhHuge.truncate(EIGHT_GIB + 1);
      } finally {
        await fhHuge.close();
      }

      const over8GiB = await live["media.import"]({ path: hugePath });
      expect(over8GiB.ok).toBe(false);
      if (!over8GiB.ok) {
        expect(over8GiB.error.code).toBe("INVALID_PARAMS");
        expect(over8GiB.error.details).toMatchObject({ bytes: EIGHT_GIB + 1, maxBytes: EIGHT_GIB });
      }
      expect(importMedia).toHaveBeenCalledTimes(2);
      expect(store.revision).toBe(2);
      expect(store.project).toEqual(beforeReject);
    });
  });
});
