import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentFacade } from "./index";
import type { AnalysisAgentView } from "./analysis-records";
import { setSpeechVadModelFactoryForTests } from "./speech-vad";
import {
  mergeDiarizationChunks,
  resolveDiarizationParams,
  setDiarizationModelForTests,
  setDiarizationModelReadyForTests,
} from "./speaker-diarization";
import { setAudioModelsProbeForTests } from "./media/audio-models-runner";

const RATE = 16000;

function toneWav(windows: ReadonlyArray<{ startSec: number; endSec: number }>, durationSec: number): Buffer {
  const data = Buffer.alloc(RATE * durationSec * 4);
  for (const window of windows) {
    for (let index = Math.round(window.startSec * RATE); index < Math.round(window.endSec * RATE); index++) {
      data.writeFloatLE(0.5 * Math.sin(index * 0.07), index * 4);
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(32, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function amplitudeFakeVad() {
  return async () => ({
    async detect(chunk: Float32Array) {
      let sum = 0;
      for (const sample of chunk) sum += sample * sample;
      return Math.sqrt(sum / chunk.length) > 0.02 ? 0.9 : 0.05;
    },
  });
}

async function settle(facade: ReturnType<typeof createAgentFacade>, jobId: string) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const status = await facade["job.status"]({ jobId });
    if (status.ok && ["done", "error", "cancelled"].includes(status.value.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("diarization job did not settle");
}

afterEach(() => {
  setSpeechVadModelFactoryForTests(null);
  setDiarizationModelForTests(null);
  setDiarizationModelReadyForTests(null);
  setAudioModelsProbeForTests(null);
  delete process.env.REELTERMINAL_CAMPP_SV_MODEL_DIR;
});

describe("diarization parameter validation and chunk merging", () => {
  it("validates tuning and merges adjacent same-cluster chunks", () => {
    expect(resolveDiarizationParams({ threshold: 0.72, maxSpeakers: 4 })).toEqual({ threshold: 0.72, maxSpeakers: 4, allowModelDownload: false });
    expect(() => resolveDiarizationParams({ threshold: 0.2 })).toThrow(/threshold/);
    expect(() => resolveDiarizationParams({ maxSpeakers: 21 })).toThrow(/maxSpeakers/);
    const merged = mergeDiarizationChunks(
      [0, 0, 1, 1, 0],
      [
        { startSec: 1, endSec: 2, segmentIndex: 0 },
        { startSec: 2.01, endSec: 3, segmentIndex: 1 },
        { startSec: 5, endSec: 6, segmentIndex: 2 },
        { startSec: 6.01, endSec: 7, segmentIndex: 3 },
        { startSec: 10, endSec: 11, segmentIndex: 4 },
      ],
    );
    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ startSec: 1, endSec: 3, speakerId: "speaker-1", sourceSegmentIndices: [0, 1] });
    expect(merged[1]).toMatchObject({ startSec: 5, endSec: 7, speakerId: "speaker-2" });
    expect(merged[2]).toMatchObject({ startSec: 10, endSec: 11, speakerId: "speaker-1" });
  });
});

describe("speakerDiarization session integration", () => {
  it("persists anonymous clusters compactly and pages segments", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-diarization-"));
    try {
      const sourcePath = join(root, "speech.wav");
      await writeFile(sourcePath, toneWav([{ startSec: 1, endSec: 2 }, { startSec: 3, endSec: 4 }], 6));
      setSpeechVadModelFactoryForTests(amplitudeFakeVad());
      setAudioModelsProbeForTests(async () => ({
        available: true,
        details: {
          python: "/fake/python",
          pythonVersion: "3.10.19",
          scriptDir: "/fake/python",
          packages: { modelscope: true, torch: true, soundfile: true, numpy: true },
          versions: { modelscope: "1.34.0", torch: "2.10.0+cu128" },
        },
      }));
      setDiarizationModelReadyForTests(async () => null);
      setDiarizationModelForTests(async (request) => ({
        labels: [0, 1],
        spans: request.segments.map((segment, index) => ({ ...segment, segmentIndex: index })),
        speakerCount: 2,
        model: "iic/speech_campplus_sv_zh-cn_16k-common",
        device: "cuda:0",
        loadSeconds: 0.2,
        inferenceSeconds: 0.1,
      }));
      const facade = createAgentFacade({ mediaRoots: [root], artifactRoot: join(root, "artifacts") });
      await facade["project.create"]({ name: "Diarization" });
      const imported = await facade["media.import"]({ path: sourcePath });
      if (!imported.ok) throw new Error(imported.error.message);
      const started = await facade["media.analyze_start"]({
        mediaId: imported.value.mediaId,
        analysisTypes: ["speakerDiarization"],
        startSec: 0,
        endSec: 5,
        diarizationParams: { threshold: 0.72, maxSpeakers: 4 },
      });
      if (!started.ok) throw new Error(started.error.message);
      const status = await settle(facade, started.value.jobId);
      if (!status.ok || status.value.state !== "done") throw new Error(`job failed: ${JSON.stringify(status)}`);
      const result = status.value.result;
      if (!result || !("summary" in result)) throw new Error("no analysis result");
      const summary = (result.summary as Record<string, any>).speakerDiarization;
      expect(summary).toMatchObject({
        coordinateSpace: "source",
        speakerCount: 2,
        segmentCount: 2,
        anonymousClusters: true,
        timestampSource: "external-vad-silero",
        parameters: { threshold: 0.72, maxSpeakers: 4 },
        model: { name: "campplus-speaker-verification", device: "cuda:0" },
      });
      expect(summary).not.toHaveProperty("segments");
      const recordId = (result.summary as Record<string, any>).analysisRecord.id as string;
      const events = await facade["analysis.get"]({ recordId, view: "events", series: "speakerDiarization.segments", startSec: 0, endSec: 5, limit: 10 });
      if (!events.ok) throw new Error(events.error.message);
      const items = (events.value as AnalysisAgentView).events!.items as unknown as Array<{ speakerId: string; startSec: number }>;
      expect(items.map((item) => item.speakerId)).toEqual(["speaker-1", "speaker-2"]);
      const record = await facade["analysis.get"]({ recordId });
      if (!record.ok) throw new Error(record.error.message);
      const view = record.value as AnalysisAgentView;
      expect(view.config.diarizationParams).toMatchObject({ threshold: 0.72, maxSpeakers: 4 });
      expect(view.provenance).toContainEqual(expect.objectContaining({ provider: "local-campplus-modelscope-python", analysisType: "speakerDiarization" }));
      expect(view.unknowns).toContainEqual(expect.objectContaining({ field: "speakerDiarization.identity" }));
      expect(view.inferences).toContainEqual(expect.objectContaining({ source: "speakerDiarization" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);

  it("requires explicit consent before the pinned CAM++ model can be downloaded", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-diarization-gate-"));
    try {
      const sourcePath = join(root, "speech.wav");
      await writeFile(sourcePath, toneWav([{ startSec: 0, endSec: 1 }], 2));
      process.env.REELTERMINAL_CAMPP_SV_MODEL_DIR = join(root, "missing-model");
      setAudioModelsProbeForTests(async () => ({
        available: true,
        details: {
          python: "/fake/python",
          pythonVersion: "3.10.19",
          scriptDir: "/fake/python",
          packages: { modelscope: true, torch: true, soundfile: true, numpy: true },
          versions: {},
        },
      }));
      const facade = createAgentFacade({ mediaRoots: [root], artifactRoot: join(root, "artifacts") });
      await facade["project.create"]({ name: "Diarization gate" });
      const imported = await facade["media.import"]({ path: sourcePath });
      if (!imported.ok) throw new Error(imported.error.message);
      const refused = await facade["media.analyze_start"]({
        mediaId: imported.value.mediaId,
        analysisTypes: ["speakerDiarization"],
        diarizationParams: { threshold: 0.7 },
      });
      expect(refused).toMatchObject({ ok: false, error: { code: "UNSUPPORTED", message: expect.stringContaining("allowModelDownload") } });
      expect(await facade["media.analyze_start"]({
        mediaId: imported.value.mediaId,
        analysisTypes: ["silence"],
        diarizationParams: { threshold: 0.7 },
      })).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS", message: expect.stringContaining("speakerDiarization") } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
