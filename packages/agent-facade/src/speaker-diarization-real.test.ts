/**
 * AUD-09 real CAM++ diarization acceptance. Skips unless an explicit Python
 * interpreter and the pinned CAM++ weights are available:
 *   REELTERMINAL_AUDIO_MODELS_PYTHON=<python with modelscope/torch/soundfile>
 *   REELTERMINAL_CAMPP_SV_MODEL_DIR=<.../iic/speech_campplus_sv_zh-cn_16k-common>
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentFacade } from "./index";
import type { AnalysisAgentView } from "./analysis-records";
import { runAudioModelTask } from "./media/audio-models-runner";

const PYTHON = process.env.REELTERMINAL_AUDIO_MODELS_PYTHON ?? "";
const MODEL_DIR = process.env.REELTERMINAL_CAMPP_SV_MODEL_DIR ?? "";
const EVAL_WAV = process.env.REELTERMINAL_DIARIZATION_EVAL_WAV ?? "";
const MANIFEST = process.env.REELTERMINAL_DIARIZATION_EVAL_MANIFEST ?? "";
const ENABLED = PYTHON.length > 0 && MODEL_DIR.length > 0 && existsSync(join(MODEL_DIR, "campplus_cn_common.bin")) && existsSync(EVAL_WAV) && existsSync(MANIFEST);
let previous: { python?: string; model?: string; cache?: string } = {};

beforeAll(() => {
  if (!ENABLED) return;
  previous = {
    python: process.env.REELTERMINAL_AUDIO_MODELS_PYTHON,
    model: process.env.REELTERMINAL_CAMPP_SV_MODEL_DIR,
    cache: process.env.REELTERMINAL_MODELSCOPE_CACHE,
  };
  process.env.REELTERMINAL_AUDIO_MODELS_PYTHON = PYTHON;
  process.env.REELTERMINAL_CAMPP_SV_MODEL_DIR = MODEL_DIR;
  process.env.REELTERMINAL_MODELSCOPE_CACHE ??= join(MODEL_DIR, "..", "..");
});

afterAll(() => {
  if (!ENABLED) return;
  if (previous.python === undefined) delete process.env.REELTERMINAL_AUDIO_MODELS_PYTHON;
  else process.env.REELTERMINAL_AUDIO_MODELS_PYTHON = previous.python;
  if (previous.model === undefined) delete process.env.REELTERMINAL_CAMPP_SV_MODEL_DIR;
  else process.env.REELTERMINAL_CAMPP_SV_MODEL_DIR = previous.model;
  if (previous.cache === undefined) delete process.env.REELTERMINAL_MODELSCOPE_CACHE;
  else process.env.REELTERMINAL_MODELSCOPE_CACHE = previous.cache;
});

describe.skipIf(!ENABLED)("AUD-09 real CAM++ chain", () => {
  it("clusters the known two-speaker turns into two anonymous labels", async () => {
    const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as {
      turns: Array<{ start_s: number; end_s: number }>;
    };
    const result = await runAudioModelTask({
      task: "diarize",
      wavPath: EVAL_WAV,
      segments: manifest.turns.map((turn) => ({ startSec: turn.start_s, endSec: turn.end_s })),
      threshold: 0.7,
      maxSpeakers: 8,
      modelDir: MODEL_DIR,
    }, { timeoutMs: 300_000 });
    const labels = result.labels as number[];
    expect(labels).toHaveLength(manifest.turns.length);
    expect(result.speakerCount).toBe(2);
    expect(labels[0]).not.toBe(labels[1]);
    expect(labels[0]).toBe(labels[2]);
    expect(labels[1]).toBe(labels[3]);
    expect(Number(result.inferenceSeconds)).toBeGreaterThan(0);
  }, 360_000);

  it("runs real VAD + CAM++ through the analysis record", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-diarization-real-"));
    try {
      const sourceCopy = join(root, "speech-zh.wav");
      await copyFile(EVAL_WAV, sourceCopy);
      const facade = createAgentFacade({ mediaRoots: [root], artifactRoot: join(root, "artifacts") });
      await facade["project.create"]({ name: "Real diarization" });
      const imported = await facade["media.import"]({ path: sourceCopy });
      if (!imported.ok) throw new Error(imported.error.message);
      const started = await facade["media.analyze_start"]({
        mediaId: imported.value.mediaId,
        analysisTypes: ["speakerDiarization"],
        startSec: 0,
        endSec: 27,
        diarizationParams: { threshold: 0.7, maxSpeakers: 4 },
      });
      if (!started.ok) throw new Error(started.error.message);
      let status;
      for (let attempt = 0; attempt < 1200; attempt++) {
        status = await facade["job.status"]({ jobId: started.value.jobId });
        if (status.ok && ["done", "error", "cancelled"].includes(status.value.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!status?.ok || status.value.state !== "done") throw new Error(`real diarization job failed: ${JSON.stringify(status)}`);
      const result = status.value.result;
      if (!result || !("summary" in result)) throw new Error("no analysis result");
      const summary = (result.summary as Record<string, any>).speakerDiarization;
      expect(summary.anonymousClusters).toBe(true);
      expect(summary.speakerCount).toBe(2);
      expect(summary.segmentCount).toBeGreaterThan(1);
      expect(summary.timestampSource).toBe("external-vad-silero");
      expect(summary.model.device).toMatch(/cuda|cpu/);
      const recordId = (result.summary as Record<string, any>).analysisRecord.id as string;
      const events = await facade["analysis.get"]({ recordId, view: "events", series: "speakerDiarization.segments", startSec: 0, endSec: 27, limit: 256 });
      if (!events.ok) throw new Error(events.error.message);
      const items = (events.value as AnalysisAgentView).events!.items as unknown as Array<{ speakerId: string }>;
      expect(new Set(items.map((item) => item.speakerId)).size).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 360_000);
});
