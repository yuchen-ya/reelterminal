/**
 * Anonymous speaker diarization (AUD-09) — the "speakerDiarization" analysis type.
 *
 * Segments come from the existing Silero VAD (AUD-01); CAM++ speaker-verification
 * embeddings are extracted in the optional Python worker, pairwise cosine
 * similarities are thresholded, and connected components are numbered by first
 * appearance. Labels are ANONYMOUS CLUSTERS — the record never claims a real
 * identity. Overlapping speech is not separated (the model sees one mixed
 * segment) and very short segments are inherently less stable; both limits are
 * disclosed in the facts.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacadeError } from "./errors";
import { requireAudioBinaries, runAudioSubprocess, validateAudioRange } from "./audio-analysis";
import {
  runAudioModelTask,
  speakerDiarizationModelDir,
  speakerDiarizationModelStatus,
  SPEAKER_DIARIZATION_MODEL,
} from "./media/audio-models-runner";
import type { SpeechActivityRegion } from "./speech-vad";
import type { MediaDiarizationParams } from "./types";

export const DEFAULT_DIARIZATION_PARAMS = { threshold: 0.7, maxSpeakers: 8, allowModelDownload: false } as const;
export const MAX_DIARIZATION_CHUNKS = 400;

export interface ResolvedDiarizationParams {
  readonly threshold: number;
  readonly maxSpeakers: number;
  readonly allowModelDownload: boolean;
}

export function resolveDiarizationParams(params?: MediaDiarizationParams): ResolvedDiarizationParams {
  const threshold = params?.threshold ?? DEFAULT_DIARIZATION_PARAMS.threshold;
  const maxSpeakers = params?.maxSpeakers ?? DEFAULT_DIARIZATION_PARAMS.maxSpeakers;
  const allowModelDownload = params?.allowModelDownload ?? DEFAULT_DIARIZATION_PARAMS.allowModelDownload;
  if (!(Number.isFinite(threshold) && threshold >= 0.3 && threshold <= 0.95)) {
    throw new FacadeError("INVALID_PARAMS", "diarizationParams.threshold must be a finite number in [0.3, 0.95] cosine similarity");
  }
  if (!Number.isInteger(maxSpeakers) || maxSpeakers < 1 || maxSpeakers > 20) {
    throw new FacadeError("INVALID_PARAMS", "diarizationParams.maxSpeakers must be an integer in [1, 20]");
  }
  if (typeof allowModelDownload !== "boolean") throw new FacadeError("INVALID_PARAMS", "diarizationParams.allowModelDownload must be a boolean");
  return { threshold, maxSpeakers, allowModelDownload };
}

export interface DiarizationSegment {
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  /** Anonymous cluster label, e.g. "speaker-1". Never a real identity. */
  readonly speakerId: string;
  readonly speakerIndex: number;
  /** Which VAD segment(s) this merged diarization segment came from. */
  readonly sourceSegmentIndices: readonly number[];
}

export interface SpeakerDiarizationFacts {
  readonly coordinateSpace: "source";
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly analysisSampleRate: number;
  readonly audioStreamIndex: 0;
  readonly parameters: { readonly threshold: number; readonly maxSpeakers: number; readonly allowModelDownload: boolean };
  readonly model: {
    readonly name: "campplus-speaker-verification";
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
  readonly anonymousClusters: true;
  readonly segments: readonly DiarizationSegment[];
  readonly segmentCount: number;
  readonly speakerCount: number;
  readonly totalSpeechDurationSec: number;
  readonly chunkCount: number;
  readonly limitations: readonly string[];
}

export interface DiarizeRequest {
  readonly wavPath: string;
  readonly segments: readonly { readonly startSec: number; readonly endSec: number }[];
  readonly threshold: number;
  readonly maxSpeakers: number;
  readonly modelDir: string | null;
  readonly signal: AbortSignal;
  readonly progress: (percent: number, phase: string) => void;
}

export interface DiarizeResponse {
  readonly labels: readonly number[];
  readonly spans: readonly { readonly startSec: number; readonly endSec: number; readonly segmentIndex: number }[];
  readonly speakerCount: number;
  readonly model: string;
  readonly device: string;
  readonly loadSeconds: number;
  readonly inferenceSeconds: number;
}

type DiarizeModel = (request: DiarizeRequest) => Promise<DiarizeResponse>;
let diarizeModelOverride: DiarizeModel | null = null;

/** Hermetic test seam; production uses the optional Python worker. */
export function setDiarizationModelForTests(model: DiarizeModel | null): void {
  diarizeModelOverride = model;
}

async function diarizeWithPythonWorker(request: DiarizeRequest): Promise<DiarizeResponse> {
  const result = await runAudioModelTask({
    task: "diarize",
    wavPath: request.wavPath,
    segments: request.segments.map((segment) => ({ startSec: segment.startSec, endSec: segment.endSec })),
    threshold: request.threshold,
    maxSpeakers: request.maxSpeakers,
    ...(request.modelDir ? { modelDir: request.modelDir } : {}),
  }, {
    signal: request.signal,
    timeoutMs: 20 * 60 * 1000,
    onProgress: request.progress,
  });
  const labels = result.labels;
  const spans = result.spans;
  if (!Array.isArray(labels) || labels.some((label) => !Number.isInteger(label))) {
    throw new FacadeError("JOB_FAILED", "CAM++ worker returned invalid cluster labels");
  }
  if (!Array.isArray(spans) || spans.length !== labels.length) {
    throw new FacadeError("JOB_FAILED", "CAM++ worker returned spans that do not match its labels");
  }
  return {
    labels: labels as number[],
    spans: spans as DiarizeResponse["spans"],
    speakerCount: typeof result.speakerCount === "number" ? result.speakerCount : 0,
    model: typeof result.model === "string" ? result.model : SPEAKER_DIARIZATION_MODEL.repo,
    device: typeof result.device === "string" ? result.device : "unknown",
    loadSeconds: typeof result.loadSeconds === "number" ? result.loadSeconds : 0,
    inferenceSeconds: typeof result.inferenceSeconds === "number" ? result.inferenceSeconds : 0,
  };
}

/** Decode the exact analyzed range to a 16 kHz mono PCM16 WAV for the worker. */
async function writeDiarizationWav(path: string, range: { startSec: number; endSec: number }, directory: string, signal: AbortSignal): Promise<string> {
  const binaries = await requireAudioBinaries(signal);
  const wavPath = join(directory, "diarization-16k.wav");
  const pcm = await runAudioSubprocess(binaries.ffmpeg, [
    "-hide_banner", "-nostdin", "-v", "info",
    "-ss", String(range.startSec), "-t", String(range.endSec - range.startSec), "-i", path,
    "-map", "0:a:0", "-vn", "-threads", "1",
    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1",
  ], signal);
  await writeFile(wavPath, pcm.out);
  return wavPath;
}

/** Merge adjacent same-cluster chunks into diarization segments (pure). */
export function mergeDiarizationChunks(
  labels: readonly number[],
  spans: readonly { readonly startSec: number; readonly endSec: number; readonly segmentIndex: number }[],
  mergeGapSec = 0.05,
): DiarizationSegment[] {
  if (labels.length !== spans.length) throw new FacadeError("JOB_FAILED", "diarization labels/spans length mismatch");
  const ordered = spans.map((span, index) => ({ ...span, label: labels[index]! }))
    .sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec);
  const merged: Array<{ startSec: number; endSec: number; label: number; sources: number[] }> = [];
  for (const span of ordered) {
    const last = merged.at(-1);
    if (last && last.label === span.label && span.startSec - last.endSec <= mergeGapSec) {
      last.endSec = Math.max(last.endSec, span.endSec);
      if (!last.sources.includes(span.segmentIndex)) last.sources.push(span.segmentIndex);
      continue;
    }
    merged.push({ startSec: span.startSec, endSec: span.endSec, label: span.label, sources: [span.segmentIndex] });
  }
  const labelToIndex = new Map<number, number>();
  return merged.map((segment) => {
    if (!labelToIndex.has(segment.label)) labelToIndex.set(segment.label, labelToIndex.size);
    const speakerIndex = labelToIndex.get(segment.label)!;
    return {
      startSec: segment.startSec,
      endSec: segment.endSec,
      durationSec: segment.endSec - segment.startSec,
      speakerId: `speaker-${speakerIndex + 1}`,
      speakerIndex,
      sourceSegmentIndices: segment.sources,
    };
  });
}

export async function analyzeSpeakerDiarization(
  path: string,
  range: { startSec: number; endSec: number },
  regions: readonly SpeechActivityRegion[],
  params: ResolvedDiarizationParams,
  modelDir: string | null,
  signal: AbortSignal,
  progress: (percent: number) => void = () => {},
): Promise<SpeakerDiarizationFacts> {
  validateAudioRange(range);
  if (signal.aborted) throw new Error("Cancelled");
  const clipped = regions
    .map((region) => ({ startSec: Math.max(range.startSec, region.startSec), endSec: Math.min(range.endSec, region.endSec) }))
    .filter((region) => region.endSec > region.startSec);
  if (clipped.length === 0) throw new FacadeError("INVALID_PARAMS", "speakerDiarization: the VAD found no speech in this range");
  const directory = await mkdtemp(join(tmpdir(), "rt-diarization-"));
  try {
    progress(0.05);
    const wavPath = await writeDiarizationWav(path, range, directory, signal);
    if (signal.aborted) throw new Error("Cancelled");
    progress(0.15);
    const model = diarizeModelOverride ?? diarizeWithPythonWorker;
    const response = await model({
      wavPath,
      segments: clipped,
      threshold: params.threshold,
      maxSpeakers: params.maxSpeakers,
      modelDir,
      signal,
      progress: (percent, _phase) => progress(0.15 + 0.85 * percent),
    });
    if (signal.aborted) throw new Error("Cancelled");
    const segments = mergeDiarizationChunks(response.labels, response.spans);
    const speakerCount = new Set(segments.map((segment) => segment.speakerIndex)).size;
    progress(1);
    return {
      coordinateSpace: "source",
      ...range,
      durationSec: range.endSec - range.startSec,
      analysisSampleRate: 16000,
      audioStreamIndex: 0,
      parameters: { threshold: params.threshold, maxSpeakers: params.maxSpeakers, allowModelDownload: params.allowModelDownload },
      model: {
        name: "campplus-speaker-verification",
        repo: SPEAKER_DIARIZATION_MODEL.repo,
        file: SPEAKER_DIARIZATION_MODEL.file,
        sha256: SPEAKER_DIARIZATION_MODEL.sha256,
        bytes: SPEAKER_DIARIZATION_MODEL.bytes,
        license: SPEAKER_DIARIZATION_MODEL.license,
        path: modelDir,
        device: response.device,
        loadSeconds: response.loadSeconds,
        inferenceSeconds: response.inferenceSeconds,
      },
      timestampSource: "external-vad-silero",
      granularitySec: 0.032,
      anonymousClusters: true,
      segments,
      segmentCount: segments.length,
      speakerCount,
      totalSpeechDurationSec: segments.reduce((sum, segment) => sum + segment.durationSec, 0),
      chunkCount: response.labels.length,
      limitations: [
        "Speaker labels are anonymous clusters (speaker-1, speaker-2, …), not identities; the analysis never claims who a person is.",
        "Overlapping speech is not separated: the model receives one mixed VAD segment and the cluster reflects the dominant voice.",
        "Segment boundaries are external Silero VAD sentence boundaries (32 ms chunk granularity), not speaker-change timestamps.",
        "Very short segments and noisy/mixed speech make cosine clustering less stable; the threshold is a tuning knob, not a calibrated probability.",
        "The CAM++ model was validated on clean zh-CN two-speaker material; other languages, heavy reverb or more than ~4 speakers are not quantitatively validated.",
      ],
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/** Session-start model gate: pinned local weights or explicit download consent. */
let modelReadyOverride: ((params: ResolvedDiarizationParams) => Promise<string | null>) | null = null;
/** Test seam: bypass the model check without pretending real weights exist. */
export function setDiarizationModelReadyForTests(fn: ((params: ResolvedDiarizationParams) => Promise<string | null>) | null): void {
  modelReadyOverride = fn;
}

export async function assertDiarizationModelReady(params: ResolvedDiarizationParams): Promise<string | null> {
  if (modelReadyOverride) return modelReadyOverride(params);
  const status = await speakerDiarizationModelStatus();
  if (status.verified) return speakerDiarizationModelDir();
  if (status.present) throw new FacadeError("UNSUPPORTED", status.reason ?? "CAM++ model does not match the pinned weights");
  if (!params.allowModelDownload) {
    throw new FacadeError("UNSUPPORTED", status.reason ?? "CAM++ model is missing", {
      downloadBytes: SPEAKER_DIARIZATION_MODEL.bytes,
      estimatedDiskBytes: 60_000_000,
      allowModelDownload: true,
    });
  }
  return null;
}
