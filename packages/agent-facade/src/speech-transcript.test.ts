import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionExecutor } from "@reelterminal/core/actions/action-executor";
import { ActionHistory } from "@reelterminal/core/actions/action-history";

import { createAgentFacade } from "./index";
import type { AnalysisAgentView } from "./analysis-records";
import { opToCoreActions } from "./ops";
import { setSpeechVadModelFactoryForTests } from "./speech-vad";
import {
  parseSenseVoiceTags,
  setSpeechTranscriptModelForTests,
  setTranscriptModelReadyForTests,
} from "./speech-transcript";
import { setAudioModelsProbeForTests } from "./media/audio-models-runner";
import { enrichSubtitleImportTranscriptOps } from "./subtitle-import-transcript";

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
  throw new Error("transcript job did not settle");
}

afterEach(() => {
  setSpeechVadModelFactoryForTests(null);
  setSpeechTranscriptModelForTests(null);
  setTranscriptModelReadyForTests(null);
  setAudioModelsProbeForTests(null);
});

describe("SenseVoice tag parsing", () => {
  it("separates text from language/emotion/event labels and keeps unknown tags as data", () => {
    expect(parseSenseVoiceTags("<|zh|><|HAPPY|><|BGM|><|itn|>你好世界")).toEqual({
      text: "你好世界",
      language: "zh",
      emotion: "happy",
      events: ["bgm"],
      rawTags: ["zh", "happy", "bgm", "itn"],
    });
    expect(parseSenseVoiceTags("<|yue|><|EMO_UNKNOWN|><|Speech|>早晨")).toMatchObject({
      text: "早晨",
      language: "yue",
      emotion: "emo_unknown",
      events: ["speech"],
    });
    expect(parseSenseVoiceTags("plain text")).toMatchObject({ text: "plain text", language: null, events: [] });
  });
});

describe("speechTranscript analysis + record-driven subtitles", () => {
  it("persists paged segments, discloses VAD timestamps, and imports cues with one undo unit", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-transcript-"));
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
          packages: { funasr: true, modelscope: true, torch: true, soundfile: true, numpy: true },
          versions: { funasr: "1.3.1", torch: "2.10.0+cu128" },
        },
      }));
      setTranscriptModelReadyForTests(async () => null);
      setSpeechTranscriptModelForTests(async (request) => ({
        texts: request.segments.map((_segment, index) => index === 0
          ? "<|zh|><|HAPPY|>第一句"
          : "<|zh|><|BGM|>第二句"),
        model: "iic/SenseVoiceSmall",
        device: "cuda:0",
        loadSeconds: 1.2,
        inferenceSeconds: 0.4,
      }));
      const facade = createAgentFacade({ mediaRoots: [root], artifactRoot: join(root, "artifacts") });
      await facade["project.create"]({ name: "Transcript" });
      const imported = await facade["media.import"]({ path: sourcePath });
      if (!imported.ok) throw new Error(imported.error.message);
      const started = await facade["media.analyze_start"]({
        mediaId: imported.value.mediaId,
        analysisTypes: ["speechTranscript"],
        startSec: 0,
        endSec: 5,
        transcriptParams: { language: "zh", useItn: true },
      });
      if (!started.ok) throw new Error(started.error.message);
      const status = await settle(facade, started.value.jobId);
      if (!status.ok || status.value.state !== "done") throw new Error(`job failed: ${JSON.stringify(status)}`);
      const result = status.value.result;
      if (!result || !("summary" in result)) throw new Error("no analysis result");
      const summary = result.summary as Record<string, any>;
      expect(summary.speechTranscript).toMatchObject({
        coordinateSpace: "source",
        segmentCount: 2,
        timestampSource: "external-vad-silero",
        languageCounts: { zh: 2 },
        emotionCounts: { happy: 1 },
        model: { name: "SenseVoiceSmall", repo: "iic/SenseVoiceSmall", device: "cuda:0" },
      });
      expect(summary.speechTranscript).not.toHaveProperty("segments");
      const recordId = summary.analysisRecord.id as string;
      const events = await facade["analysis.get"]({ recordId, view: "events", series: "speechTranscript.segments", startSec: 0, endSec: 5, limit: 1 });
      if (!events.ok) throw new Error(events.error.message);
      const page = (events.value as AnalysisAgentView).events!;
      expect(page.totalMatched).toBe(2);
      expect(page.items[0]).toMatchObject({ startSec: expect.any(Number), endSec: expect.any(Number), text: "第一句", language: "zh" });
      const record = await facade["analysis.get"]({ recordId });
      if (!record.ok) throw new Error(record.error.message);
      const view = record.value as AnalysisAgentView;
      expect(view.config.transcriptParams).toMatchObject({ language: "zh", useItn: true, allowModelDownload: false });
      expect(view.provenance).toContainEqual(expect.objectContaining({ provider: "local-sensevoice-funasr-python", analysisType: "speechTranscript" }));
      expect(view.unknowns).toContainEqual(expect.objectContaining({ field: "speechTranscript.wordTimestamps" }));
      expect(view.inferences).toContainEqual(expect.objectContaining({ source: "speechTranscript" }));

      const seeded = await facade["edit.apply"]({
        ops: [
          { op: "track.add", trackType: "audio", trackId: "a1" },
          { op: "clip.add", trackId: "a1", mediaId: imported.value.mediaId, startTime: 10, duration: 5, inPoint: 0, outPoint: 5, clipId: "voice" },
        ],
      });
      if (!seeded.ok) throw new Error(seeded.error.message);
      const applied = await facade["edit.apply"]({
        ops: [{ op: "subtitle.importTranscript", recordId, clipId: "voice" }],
      });
      expect(applied).toMatchObject({ ok: true });
      if (!applied.ok) throw new Error(applied.error.message);
      expect(applied.value.applied[0]!.createdIds).toHaveLength(2);
      const timeline = await facade["timeline.get"]();
      if (!timeline.ok) throw new Error(timeline.error.message);
      const subtitles = timeline.value.subtitles as ReadonlyArray<{ text: string; startTime: number; endTime: number }>;
      expect(subtitles.map((subtitle) => subtitle.text)).toEqual(["第一句", "第二句"]);
      expect(subtitles[0]!.startTime).toBeGreaterThan(10.9);
      expect(subtitles[0]!.startTime).toBeLessThan(11.1);
      expect(subtitles[1]!.startTime).toBeGreaterThan(12.9);
      expect(subtitles[1]!.startTime).toBeLessThan(13.1);

      // Record-driven preparation + the core subtitle/setAll inverse restore
      // the prior (empty) subtitle list in one undo step.
      const state = await facade["project.get_state"]();
      if (!state.ok) throw new Error(state.error.message);
      const project = state.value.project;
      const prepared = await enrichSubtitleImportTranscriptOps(
        [{ op: "subtitle.importTranscript", recordId, clipId: "voice" }],
        join(root, "artifacts"),
        async () => project,
      );
      const [action] = opToCoreActions(prepared[0]!, project);
      const history = new ActionHistory();
      const executor = new ActionExecutor(history);
      const beforeCount = project.timeline.subtitles.length;
      await executor.execute(action!, project);
      expect(project.timeline.subtitles.length).toBe(beforeCount + 2);
      const inverse = history.undo();
      expect(inverse).not.toBeNull();
      await executor.execute(inverse!, project);
      expect(project.timeline.subtitles).toHaveLength(beforeCount);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);

  it("refuses missing records and stale records before mutating subtitles", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-transcript-gate-"));
    try {
      const sourcePath = join(root, "speech.wav");
      await writeFile(sourcePath, toneWav([{ startSec: 1, endSec: 2 }], 4));
      const facade = createAgentFacade({ mediaRoots: [root], artifactRoot: join(root, "artifacts") });
      await facade["project.create"]({ name: "Transcript gate" });
      const imported = await facade["media.import"]({ path: sourcePath });
      if (!imported.ok) throw new Error(imported.error.message);
      expect(await facade["media.analyze_start"]({
        mediaId: imported.value.mediaId,
        analysisTypes: ["silence"],
        transcriptParams: { language: "zh" },
      })).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS", message: expect.stringContaining("speechTranscript") } });
      await facade["edit.apply"]({ ops: [
        { op: "track.add", trackType: "audio", trackId: "a1" },
        { op: "clip.add", trackId: "a1", mediaId: imported.value.mediaId, startTime: 0, duration: 4, inPoint: 0, outPoint: 4, clipId: "voice" },
      ] });
      expect(await facade["edit.apply"]({
        ops: [{ op: "subtitle.importTranscript", recordId: "analysis-00000000-0000-0000-0000-000000000000", clipId: "voice" }],
      })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      expect(await facade["edit.apply"]({
        ops: [{ op: "subtitle.importTranscript", recordId: "analysis-00000000-0000-0000-0000-000000000000", clipId: "missing" }],
      })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      const timeline = await facade["timeline.get"]();
      if (!timeline.ok) throw new Error(timeline.error.message);
      expect(timeline.value.subtitles).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
