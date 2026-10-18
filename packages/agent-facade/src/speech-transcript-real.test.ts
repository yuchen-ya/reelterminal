/**
 * AUD-07 real-model acceptance: optional Python runtime + SenseVoice weights.
 *
 * Skips unless an explicit interpreter and the pinned model are available.
 * Set:
 *   REELTERMINAL_AUDIO_MODELS_PYTHON=<python with funasr 1.3.1>
 *   REELTERMINAL_SENSEVOICE_MODEL_DIR=<modelscope .../iic/SenseVoiceSmall>
 * locally; CI has neither and skips.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentFacade } from "./index";
import type { AnalysisAgentView } from "./analysis-records";
import { runAudioModelTask } from "./media/audio-models-runner";
import { setSpeechTranscriptModelForTests } from "./speech-transcript";

const PYTHON = process.env.REELTERMINAL_AUDIO_MODELS_PYTHON ?? "";
const MODEL_DIR = process.env.REELTERMINAL_SENSEVOICE_MODEL_DIR ?? "";
const EVAL_WAV = process.env.REELTERMINAL_TRANSCRIPT_EVAL_WAV ?? "";
const MODEL_PRESENT = MODEL_DIR.length > 0 && existsSync(join(MODEL_DIR, "model.pt"));
const ENABLED = PYTHON.length > 0 && MODEL_PRESENT && existsSync(EVAL_WAV);

let previous: { python?: string; model?: string; cache?: string } = {};

beforeAll(() => {
  if (!ENABLED) return;
  previous = {
    python: process.env.REELTERMINAL_AUDIO_MODELS_PYTHON,
    model: process.env.REELTERMINAL_SENSEVOICE_MODEL_DIR,
    cache: process.env.REELTERMINAL_MODELSCOPE_CACHE,
  };
  process.env.REELTERMINAL_AUDIO_MODELS_PYTHON = PYTHON;
  process.env.REELTERMINAL_SENSEVOICE_MODEL_DIR = MODEL_DIR;
  process.env.REELTERMINAL_MODELSCOPE_CACHE ??= join(MODEL_DIR, "..", "..");
});

afterAll(() => {
  if (!ENABLED) return;
  setSpeechTranscriptModelForTests(null);
  if (previous.python === undefined) delete process.env.REELTERMINAL_AUDIO_MODELS_PYTHON;
  else process.env.REELTERMINAL_AUDIO_MODELS_PYTHON = previous.python;
  if (previous.model === undefined) delete process.env.REELTERMINAL_SENSEVOICE_MODEL_DIR;
  else process.env.REELTERMINAL_SENSEVOICE_MODEL_DIR = previous.model;
  if (previous.cache === undefined) delete process.env.REELTERMINAL_MODELSCOPE_CACHE;
  else process.env.REELTERMINAL_MODELSCOPE_CACHE = previous.cache;
});

describe.skipIf(!ENABLED)("AUD-07 real SenseVoice chain", () => {
  it("runs the Python worker with progress and returns Chinese text", async () => {
    const progress: Array<{ percent: number; phase: string }> = [];
    const result = await runAudioModelTask({
      task: "transcribe",
      wavPath: EVAL_WAV,
      segments: [{ startSec: 0, endSec: 2 }, { startSec: 2, endSec: 4 }],
      language: "zh",
      useItn: true,
      modelDir: MODEL_DIR,
    }, {
      timeoutMs: 300_000,
      onProgress: (percent, phase) => progress.push({ percent, phase }),
    });
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)!.percent).toBeGreaterThan(0.9);
    const texts = result.texts as string[];
    expect(texts).toHaveLength(2);
    expect(texts.join("")).toMatch(/<\|zh\|>/);
    expect(texts.join("")).toMatch(/[\u4e00-\u9fff]/);
    expect(result.device).toMatch(/cuda|cpu/);
    expect(Number(result.loadSeconds)).toBeGreaterThanOrEqual(0);
  }, 360_000);

  it("drives the full analysis + record-driven subtitle import chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-transcript-real-"));
    try {
      const sourceCopy = join(root, "speech-zh.wav");
      await copyFile(EVAL_WAV, sourceCopy);
      const facade = createAgentFacade({ mediaRoots: [root], artifactRoot: join(root, "artifacts") });
      await facade["project.create"]({ name: "Real SenseVoice" });
      const imported = await facade["media.import"]({ path: sourceCopy });
      if (!imported.ok) throw new Error(imported.error.message);
      const started = await facade["media.analyze_start"]({
        mediaId: imported.value.mediaId,
        analysisTypes: ["speechTranscript"],
        startSec: 0,
        endSec: 8,
        transcriptParams: { language: "zh", useItn: true },
      });
      if (!started.ok) throw new Error(started.error.message);
      let status;
      for (let attempt = 0; attempt < 1200; attempt++) {
        status = await facade["job.status"]({ jobId: started.value.jobId });
        if (status.ok && ["done", "error", "cancelled"].includes(status.value.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!status?.ok || status.value.state !== "done") throw new Error(`real transcript job failed: ${JSON.stringify(status)}`);
      const result = status.value.result;
      if (!result || !("summary" in result)) throw new Error("no analysis result");
      const summary = (result.summary as Record<string, any>).speechTranscript;
      expect(summary.segmentCount).toBeGreaterThan(0);
      expect(summary.timestampSource).toBe("external-vad-silero");
      expect(summary.model.device).toMatch(/cuda|cpu/);
      const recordId = (result.summary as Record<string, any>).analysisRecord.id as string;
      const record = await facade["analysis.get"]({ recordId });
      if (!record.ok) throw new Error(record.error.message);
      expect((record.value as AnalysisAgentView).provenance).toContainEqual(expect.objectContaining({ provider: "local-sensevoice-funasr-python", analysisType: "speechTranscript" }));
      const events = await facade["analysis.get"]({ recordId, view: "events", series: "speechTranscript.segments", startSec: 0, endSec: 8, limit: 256 });
      if (!events.ok) throw new Error(events.error.message);
      const segments = (events.value as AnalysisAgentView).events!.items as unknown as ReadonlyArray<{ text: string; language: string | null }>;
      expect(segments.some((segment) => segment.text.length > 0)).toBe(true);
      expect(segments.some((segment) => segment.language === "zh")).toBe(true);

      const seeded = await facade["edit.apply"]({ ops: [
        { op: "track.add", trackType: "audio", trackId: "a1" },
        { op: "clip.add", trackId: "a1", mediaId: imported.value.mediaId, startTime: 0, duration: 8, inPoint: 0, outPoint: 8, clipId: "voice" },
      ] });
      if (!seeded.ok) throw new Error(seeded.error.message);
      const applied = await facade["edit.apply"]({ ops: [{ op: "subtitle.importTranscript", recordId, clipId: "voice" }] });
      if (!applied.ok) throw new Error(applied.error.message);
      const timeline = await facade["timeline.get"]();
      if (!timeline.ok) throw new Error(timeline.error.message);
      expect(timeline.value.subtitles.length).toBeGreaterThan(0);
      expect(timeline.value.subtitles.some((cue) => /[\u4e00-\u9fff]/.test(cue.text))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 360_000);
});
