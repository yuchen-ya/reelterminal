/**
 * Local speech transcription (AUD-07) — the "speechTranscript" analysis type.
 *
 * SenseVoice-Small does not emit timestamps (verified in the 2026-10-18
 * evaluation), so this kernel deliberately segments first with the existing
 * Silero VAD (AUD-01) and transcribes each VAD segment separately. Timestamps
 * are therefore EXTERNAL VAD sentence boundaries, never ASR-native word times;
 * the record states that in `timestampSource` and in its limitations.
 *
 * The model runs in an optional, explicitly configured Python process through
 * media/audio-models-runner.ts. Missing runtime/model is reported honestly and
 * the download size/disk requirement is disclosed before consent. Emotion and
 * event tags returned by the model are stored as coarse SEGMENT-level labels,
 * never promoted to precise event intervals, and no confidence is invented.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacadeError } from "./errors";
import { requireAudioBinaries, runAudioSubprocess, validateAudioRange } from "./audio-analysis";
import { runAudioModelTask, SENSEVOICE_MODEL, senseVoiceModelDir, senseVoiceModelStatus } from "./media/audio-models-runner";
import { type SpeechActivityRegion } from "./speech-vad";
import type { MediaTranscriptParams } from "./types";

export const TRANSCRIPT_LANGUAGES = ["auto", "zh", "en", "yue", "ja", "ko"] as const;
export type TranscriptLanguage = (typeof TRANSCRIPT_LANGUAGES)[number];

export const DEFAULT_TRANSCRIPT_PARAMS = { language: "auto" as TranscriptLanguage, useItn: true, allowModelDownload: false } as const;
export const MAX_TRANSCRIPT_SEGMENTS = 1000;

export interface ResolvedTranscriptParams {
  readonly language: TranscriptLanguage;
  readonly useItn: boolean;
  readonly allowModelDownload: boolean;
}

export function resolveTranscriptParams(params?: MediaTranscriptParams): ResolvedTranscriptParams {
  const language = params?.language ?? DEFAULT_TRANSCRIPT_PARAMS.language;
  const useItn = params?.useItn ?? DEFAULT_TRANSCRIPT_PARAMS.useItn;
  const allowModelDownload = params?.allowModelDownload ?? DEFAULT_TRANSCRIPT_PARAMS.allowModelDownload;
  if (!(TRANSCRIPT_LANGUAGES as readonly unknown[]).includes(language)) {
    throw new FacadeError("INVALID_PARAMS", `transcriptParams.language must be one of ${TRANSCRIPT_LANGUAGES.join(", ")}`);
  }
  if (typeof useItn !== "boolean") throw new FacadeError("INVALID_PARAMS", "transcriptParams.useItn must be a boolean");
  if (typeof allowModelDownload !== "boolean") throw new FacadeError("INVALID_PARAMS", "transcriptParams.allowModelDownload must be a boolean");
  return { language, useItn, allowModelDownload };
}

/** Coarse model labels parsed out of SenseVoice's raw `<|...|>` token prefix. */
export interface SenseVoiceTags {
  readonly text: string;
  readonly language: string | null;
  readonly emotion: string | null;
  readonly events: readonly string[];
  readonly rawTags: readonly string[];
}

const KNOWN_LANGUAGES = new Set(["zh", "en", "yue", "ja", "ko", "nospeech", "auto"]);
const KNOWN_EMOTIONS = new Set(["happy", "sad", "angry", "neutral", "fearful", "disgusted", "surprised", "emo_unknown"]);

/**
 * Strip and classify the model's special tags. Tags are data; `text` is what
 * the model actually transcribed. Unknown tags are preserved in `rawTags` and
 * never interpreted.
 */
export function parseSenseVoiceTags(raw: string): SenseVoiceTags {
  const tags: string[] = [];
  const text = raw.replace(/<\|([^|]+)\|>/g, (_match, tag: string) => {
    tags.push(tag.trim().toLowerCase());
    return "";
  }).trim();
  let language: string | null = null;
  let emotion: string | null = null;
  const events: string[] = [];
  for (const tag of tags) {
    if (KNOWN_LANGUAGES.has(tag) && language === null) language = tag;
    else if (KNOWN_EMOTIONS.has(tag) && emotion === null) emotion = tag;
    else if (tag === "itn" || tag === "woitn" || tag === "withitn" || tag === "withoutitn") continue;
    else events.push(tag);
  }
  return { text, language, emotion, events, rawTags: tags };
}

export interface TranscriptSegment {
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly text: string;
  readonly language: string | null;
  readonly emotion: string | null;
  readonly events: readonly string[];
  readonly source: "external-vad-silero";
}

export interface SpeechTranscriptFacts {
  readonly coordinateSpace: "source";
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly analysisSampleRate: number;
  readonly audioStreamIndex: 0;
  readonly parameters: {
    readonly language: TranscriptLanguage;
    readonly useItn: boolean;
    readonly allowModelDownload: boolean;
    readonly vadParams: { readonly threshold: number; readonly exitThreshold: number; readonly minSpeechSec: number; readonly minSilenceSec: number; readonly padSec: number };
  };
  readonly model: {
    readonly name: "SenseVoiceSmall";
    readonly repo: string;
    readonly file: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly license: string;
    readonly path: string | null;
    readonly device: string | null;
    readonly loadSeconds: number | null;
    readonly inferenceSeconds: number | null;
  };
  readonly timestampSource: "external-vad-silero";
  readonly granularitySec: number;
  readonly segments: readonly TranscriptSegment[];
  readonly segmentCount: number;
  readonly totalTextChars: number;
  readonly totalSpeechDurationSec: number;
  readonly languageCounts: Record<string, number>;
  readonly emotionCounts: Record<string, number>;
  readonly eventCounts: Record<string, number>;
  readonly truncated: boolean;
  readonly limitations: readonly string[];
}

export interface TranscribeRequest {
  readonly wavPath: string;
  readonly segments: readonly { readonly startSec: number; readonly endSec: number }[];
  readonly language: TranscriptLanguage;
  readonly useItn: boolean;
  readonly modelDir: string | null;
  readonly signal: AbortSignal;
  readonly progress: (percent: number, phase: string) => void;
}

export interface TranscribeResponse {
  readonly texts: readonly string[];
  readonly model: string;
  readonly device: string;
  readonly loadSeconds: number;
  readonly inferenceSeconds: number;
}

type TranscribeModel = (request: TranscribeRequest) => Promise<TranscribeResponse>;
let transcribeModelOverride: TranscribeModel | null = null;

/** Hermetic test seam; production uses the optional Python worker. */
export function setSpeechTranscriptModelForTests(model: TranscribeModel | null): void {
  transcribeModelOverride = model;
}

async function transcribeWithPythonWorker(request: TranscribeRequest): Promise<TranscribeResponse> {
  const result = await runAudioModelTask({
    task: "transcribe",
    wavPath: request.wavPath,
    segments: request.segments.map((segment) => ({ startSec: segment.startSec, endSec: segment.endSec })),
    language: request.language,
    useItn: request.useItn,
    ...(request.modelDir ? { modelDir: request.modelDir } : {}),
  }, {
    signal: request.signal,
    timeoutMs: 20 * 60 * 1000,
    onProgress: request.progress,
  });
  const texts = result.texts;
  if (!Array.isArray(texts) || texts.some((text) => typeof text !== "string")) {
    throw new FacadeError("JOB_FAILED", "SenseVoice worker returned no string transcript array");
  }
  if (texts.length !== request.segments.length) {
    throw new FacadeError("JOB_FAILED", `SenseVoice worker returned ${texts.length} texts for ${request.segments.length} VAD segments; refusing to pair them`);
  }
  return {
    texts: texts as string[],
    model: typeof result.model === "string" ? result.model : SENSEVOICE_MODEL.repo,
    device: typeof result.device === "string" ? result.device : "unknown",
    loadSeconds: typeof result.loadSeconds === "number" ? result.loadSeconds : 0,
    inferenceSeconds: typeof result.inferenceSeconds === "number" ? result.inferenceSeconds : 0,
  };
}

/** Decode the exact analyzed range to a 16 kHz mono PCM16 WAV for the worker. */
async function writeTranscriptWav(path: string, range: { startSec: number; endSec: number }, directory: string, signal: AbortSignal): Promise<string> {
  const binaries = await requireAudioBinaries(signal);
  const wavPath = join(directory, "transcript-16k.wav");
  const pcm = await runAudioSubprocess(binaries.ffmpeg, [
    "-hide_banner", "-nostdin", "-v", "info",
    "-ss", String(range.startSec), "-t", String(range.endSec - range.startSec), "-i", path,
    "-map", "0:a:0", "-vn", "-threads", "1",
    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1",
  ], signal);
  await writeFile(wavPath, pcm.out);
  return wavPath;
}

function countBy(values: readonly (string | null)[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    if (value === null || value.length === 0) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/**
 * Transcribe the provided VAD regions. `analyzedEndSec` is passed separately
 * because a short decode must not let a region claim audio that was not read.
 */
export async function transcribeSpeechRegions(
  path: string,
  range: { startSec: number; endSec: number },
  regions: readonly SpeechActivityRegion[],
  params: ResolvedTranscriptParams,
  vadParams: { readonly threshold: number; readonly minSpeechSec: number; readonly minSilenceSec: number; readonly padSec: number },
  modelDir: string | null,
  signal: AbortSignal,
  progress: (percent: number) => void = () => {},
): Promise<SpeechTranscriptFacts> {
  validateAudioRange(range);
  if (signal.aborted) throw new Error("Cancelled");
  const resolvedVad = vadParams;
  const clipped = regions
    .map((region) => ({
      startSec: Math.max(range.startSec, region.startSec),
      endSec: Math.min(range.endSec, region.endSec),
    }))
    .filter((region) => region.endSec > region.startSec);
  if (clipped.length > MAX_TRANSCRIPT_SEGMENTS) {
    throw new FacadeError("UNSUPPORTED", `speechTranscript produced ${clipped.length} VAD segments; the record cap is ${MAX_TRANSCRIPT_SEGMENTS}. Split the range or adjust vadParams.`);
  }
  const directory = await mkdtemp(join(tmpdir(), "rt-transcript-"));
  try {
    progress(0.05);
    const wavPath = await writeTranscriptWav(path, range, directory, signal);
    if (signal.aborted) throw new Error("Cancelled");
    progress(0.15);
    const model = transcribeModelOverride ?? transcribeWithPythonWorker;
    const response = await model({
      wavPath,
      segments: clipped.map((segment) => ({
        startSec: segment.startSec - range.startSec,
        endSec: segment.endSec - range.startSec,
      })),
      language: params.language,
      useItn: params.useItn,
      modelDir,
      signal,
      progress: (percent, _phase) => progress(0.15 + 0.85 * percent),
    });
    if (signal.aborted) throw new Error("Cancelled");
    const segments: TranscriptSegment[] = clipped.map((region, index) => {
      const parsed = parseSenseVoiceTags(response.texts[index] ?? "");
      return {
        startSec: region.startSec,
        endSec: region.endSec,
        durationSec: region.endSec - region.startSec,
        text: parsed.text,
        language: parsed.language,
        emotion: parsed.emotion,
        events: parsed.events,
        source: "external-vad-silero" as const,
      };
    });
    progress(1);
    const totalSpeechDurationSec = segments.reduce((sum, segment) => sum + segment.durationSec, 0);
    return {
      coordinateSpace: "source",
      ...range,
      durationSec: range.endSec - range.startSec,
      analysisSampleRate: 16000,
      audioStreamIndex: 0,
      parameters: {
        language: params.language,
        useItn: params.useItn,
        allowModelDownload: params.allowModelDownload,
        vadParams: { ...resolvedVad, exitThreshold: Number((resolvedVad.threshold - 0.15).toFixed(6)) },
      },
      model: {
        name: "SenseVoiceSmall",
        repo: SENSEVOICE_MODEL.repo,
        file: SENSEVOICE_MODEL.file,
        sha256: SENSEVOICE_MODEL.sha256,
        bytes: SENSEVOICE_MODEL.bytes,
        license: SENSEVOICE_MODEL.license,
        path: modelDir,
        device: response.device,
        loadSeconds: response.loadSeconds,
        inferenceSeconds: response.inferenceSeconds,
      },
      timestampSource: "external-vad-silero",
      granularitySec: 0.032,
      segments,
      segmentCount: segments.length,
      totalTextChars: segments.reduce((sum, segment) => sum + segment.text.length, 0),
      totalSpeechDurationSec,
      languageCounts: countBy(segments.map((segment) => segment.language)),
      emotionCounts: countBy(segments.map((segment) => segment.emotion)),
      eventCounts: countBy(segments.flatMap((segment) => segment.events)),
      truncated: false,
      limitations: [
        "SenseVoice-Small emits no native timestamps; segment start/end come from the external Silero VAD (32 ms chunk granularity plus padding), not from the ASR model.",
        "Text, emotion and event tags are model output for the whole VAD segment; emotion/event labels are coarse segment-level annotations, not precise event intervals.",
        "No confidence or per-word timing is stored because the model does not provide them; do not present segment boundaries as word timing.",
        `Recognized language(s): ${Object.keys(countBy(segments.map((segment) => segment.language))).join(", ") || "unknown"}; auto-detection can be wrong on short or mixed speech.`,
        "Transcripts are data, not project mutations; importing them into subtitles is a separate record-driven edit op.",
      ],
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/** Session-start model gate: pinned local weights or explicit download consent. */
let modelReadyOverride: ((params: ResolvedTranscriptParams) => Promise<string | null>) | null = null;
/** Test seam: bypass the 936 MB model check without pretending a real model exists. */
export function setTranscriptModelReadyForTests(fn: ((params: ResolvedTranscriptParams) => Promise<string | null>) | null): void {
  modelReadyOverride = fn;
}

export async function assertTranscriptModelReady(params: ResolvedTranscriptParams): Promise<string | null> {
  if (modelReadyOverride) return modelReadyOverride(params);
  const status = await senseVoiceModelStatus();
  if (status.verified) return senseVoiceModelDir();
  if (status.present) throw new FacadeError("UNSUPPORTED", status.reason ?? "SenseVoice model does not match the pinned weights");
  if (!params.allowModelDownload) {
    throw new FacadeError("UNSUPPORTED", status.reason ?? "SenseVoice model is missing", {
      downloadBytes: SENSEVOICE_MODEL.bytes,
      estimatedDiskBytes: 1_100_000_000,
      allowModelDownload: true,
    });
  }
  return null;
}
