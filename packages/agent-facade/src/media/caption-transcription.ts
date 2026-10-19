import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeSpeechActivity, speechVadPreflight } from "../speech-vad";
import {
  resolveTranscriptParams,
  transcribeSpeechRegions,
} from "../speech-transcript";
import {
  runAudioModelTask,
  senseVoiceModelDir,
  senseVoiceModelStatus,
} from "./audio-models-runner";
import { readAudioEnvironment } from "./audio-environment-config";
import {
  alignedWordsToCaptions,
  checkQwenCaptions,
  type CaptionEngine,
} from "./qwen-captions";

/** No implicit model downloads from a GUI caption action. */
export async function transcribeCaptionFile(
  path: string,
  duration: number,
  language: string,
  signal: AbortSignal,
  engine: CaptionEngine = "qwen",
) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 120)
    throw new Error("Caption chunks must be within 120 seconds");
  if (!(await stat(path)).isFile())
    throw new Error("Caption acceptance requires a local audio file");
  const params = resolveTranscriptParams({ language: language as "auto" });
  if (engine !== "qwen" && engine !== "sensevoice")
    throw new Error("Unknown caption engine");
  const config = readAudioEnvironment();
  const qwen = await checkQwenCaptions();
  if (!qwen.runtime.available) throw new Error(qwen.runtime.reason);
  if (!qwen.aligner.available) throw new Error(qwen.aligner.reason);
  if (engine === "qwen") {
    if (!qwen.model.available) throw new Error(qwen.model.reason);
    const result = await runAudioModelTask(
      {
        task: "caption-qwen",
        wavPath: path,
        duration,
        language,
        modelDir: config.qwenModelDir,
        alignerDir: config.qwenAlignerModelDir,
      },
      { signal, timeoutMs: 20 * 60 * 1000 },
    );
    return alignedWordsToCaptions(result.words, duration);
  }
  const [model, vad] = await Promise.all([
    senseVoiceModelStatus(),
    speechVadPreflight(),
  ]);
  if (!model.verified)
    throw new Error(model.reason ?? "SenseVoice model is not verified");
  if (!vad.available) throw new Error(vad.reason);
  const range = { startSec: 0, endSec: duration };
  const activity = await analyzeSpeechActivity(path, range, undefined, signal);
  if (activity.truncated)
    throw new Error("Audio decode was shorter than the requested range");
  if (activity.speechRegions.length === 0) return [];
  const transcript = await transcribeSpeechRegions(
    path,
    range,
    activity.speechRegions,
    params,
    activity.parameters,
    senseVoiceModelDir(),
    signal,
  );
  const result = await runAudioModelTask(
    {
      task: "caption-align",
      wavPath: path,
      duration,
      segments: transcript.segments.filter((segment) => segment.text.trim()),
      alignerDir: config.qwenAlignerModelDir,
    },
    { signal, timeoutMs: 20 * 60 * 1000 },
  );
  return alignedWordsToCaptions(result.words, duration);
}

export async function transcribeCaptionSamples(
  samples: Float32Array,
  language: string,
  signal: AbortSignal,
  engine: CaptionEngine = "qwen",
) {
  if (
    !(samples instanceof Float32Array) ||
    samples.length === 0 ||
    samples.length > 16000 * 120 ||
    samples.some((x) => !Number.isFinite(x))
  )
    throw new Error("Expected up to 120 seconds of finite 16 kHz mono samples");
  const directory = await mkdtemp(join(tmpdir(), "rt-caption-"));
  try {
    const wav = Buffer.alloc(44 + samples.length * 2);
    wav.write("RIFF");
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(samples.length * 2, 40);
    for (let i = 0; i < samples.length; i++)
      wav.writeInt16LE(
        Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767),
        44 + i * 2,
      );
    const path = join(directory, "speech.wav");
    await writeFile(path, wav);
    return await transcribeCaptionFile(
      path,
      samples.length / 16000,
      language,
      signal,
      engine,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
