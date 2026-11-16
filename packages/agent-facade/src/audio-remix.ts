/**
 * Local beat-loop audio remixing (`audio.process.remix`):
 * decodes source audio to 48 kHz stereo PCM via FFmpeg, detects/uses BPM to
 * partition into Intro / Loop Body / Outro bars, repeats or shortens Loop Body
 * to hit `targetDurationSec` while landing the genuine Outro at the end (or
 * `outroAlign.landAtSec`), aligns each loop seam within ±15 ms using normalized
 * cross-correlation + zero-crossing refinement, blends seams with cos/sin
 * equal-power crossfades, applies tail fade-out and optional EBU R128 loudness
 * normalization, and publishes a durable 48 kHz PCM WAV + provenance JSON.
 */
import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { analyzeBeatsInPcm } from "@reelterminal/core/audio/beat-detection-engine";

import { FacadeError } from "./errors";
import { assertContainedWrittenFile, prepareArtifactDir, sha256File } from "./artifact-io";
import { fingerprintFile } from "./inspection-artifacts";
import {
  FfmpegToolError,
  resolveFfmpegVersion,
  resolveToolFfmpeg,
  runToolProcess,
} from "./media/ffmpeg-bin";
import { resolveContainedPathDetailed } from "./media/path-roots";
import type { ArtifactFileTracker } from "./providers";
import type { AudioProcessRemixParams } from "./types";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const VERB = "audio.process.remix";
export const AUDIO_REMIX_MAX_DURATION_SEC = 1800;

export interface AudioRemixSeam {
  readonly timelineSec: number;
  readonly fromSourceBar: number;
  readonly toSourceBar: number;
  readonly correlation: number;
}

export interface RemixAudioArtifact {
  readonly path: string;
  readonly provenancePath: string;
  readonly source: {
    readonly mediaId: string;
    readonly path: string;
    readonly audioStream: number;
    readonly projectId: string;
    readonly workspaceId?: string;
    readonly revision: number;
  };
  readonly parameters: Omit<AudioProcessRemixParams, "expectedRevision" | "idempotencyKey">;
  readonly bpm: number;
  readonly bpmAutoDetected: boolean;
  readonly beatsPerBar: number;
  readonly actualDurationSec: number;
  readonly seams: readonly AudioRemixSeam[];
  readonly timing: {
    readonly sampleRate: 48_000;
    readonly channels: 2;
    readonly sampleCount: number;
    readonly durationSec: number;
  };
  readonly bytes: number;
  readonly sha256: string;
}

export interface ProduceRemixedAudioParams {
  readonly sourcePath: string;
  readonly mediaRoots: readonly string[];
  readonly params: Omit<AudioProcessRemixParams, "expectedRevision" | "idempotencyKey">;
  readonly sourceProjectId: string;
  readonly sourceWorkspaceId?: string;
  readonly sourceRevision: number;
  readonly signal?: AbortSignal;
  readonly artifactId: string;
  readonly progress?: (percent: number) => void;
  readonly artifactFileTracker?: ArtifactFileTracker;
}

function fail(
  code: "INVALID_PARAMS" | "NOT_FOUND" | "JOB_FAILED" | "UNSUPPORTED" | "CONFLICT",
  message: string,
): never {
  throw new FacadeError(code, `${VERB}: ${message}`);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail("JOB_FAILED", "Cancelled");
}

function ffmpegMessage(error: unknown): string {
  if (error instanceof FfmpegToolError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function validateParams(params: Omit<AudioProcessRemixParams, "expectedRevision" | "idempotencyKey">): void {
  if (!params || typeof params !== "object") fail("INVALID_PARAMS", "params are required");
  if (typeof params.mediaId !== "string" || params.mediaId.length === 0) {
    fail("INVALID_PARAMS", "mediaId must be a non-empty string");
  }
  const stream = params.audioStream ?? 0;
  if (!Number.isInteger(stream) || stream < 0) {
    fail("INVALID_PARAMS", "audioStream must be a non-negative integer");
  }
  if (
    typeof params.targetDurationSec !== "number" ||
    !Number.isFinite(params.targetDurationSec) ||
    params.targetDurationSec <= 0 ||
    params.targetDurationSec > AUDIO_REMIX_MAX_DURATION_SEC
  ) {
    fail("INVALID_PARAMS", `targetDurationSec must be in (0, ${AUDIO_REMIX_MAX_DURATION_SEC}]`);
  }
  if (
    params.bpm !== undefined &&
    (typeof params.bpm !== "number" || !Number.isFinite(params.bpm) || params.bpm < 40 || params.bpm > 240)
  ) {
    fail("INVALID_PARAMS", "bpm must be in [40, 240]");
  }
  const beatsPerBar = params.beatsPerBar ?? 4;
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1 || beatsPerBar > 12) {
    fail("INVALID_PARAMS", "beatsPerBar must be an integer in [1, 12]");
  }
  if (params.loopBodyBars !== undefined) {
    const { startBar, endBar } = params.loopBodyBars;
    if (
      !Number.isInteger(startBar) ||
      startBar < 0 ||
      !Number.isInteger(endBar) ||
      endBar <= startBar
    ) {
      fail("INVALID_PARAMS", "loopBodyBars requires integer 0 <= startBar < endBar");
    }
  }
  if (params.outroAlign !== undefined) {
    const { outroStartBar, landAtSec, tailFadeOutSec } = params.outroAlign;
    if (outroStartBar !== undefined && (!Number.isInteger(outroStartBar) || outroStartBar < 0)) {
      fail("INVALID_PARAMS", "outroAlign.outroStartBar must be a non-negative integer");
    }
    if (
      landAtSec !== undefined &&
      (typeof landAtSec !== "number" || !Number.isFinite(landAtSec) || landAtSec <= 0 || landAtSec > params.targetDurationSec)
    ) {
      fail("INVALID_PARAMS", "outroAlign.landAtSec must be in (0, targetDurationSec]");
    }
    if (
      tailFadeOutSec !== undefined &&
      (typeof tailFadeOutSec !== "number" || !Number.isFinite(tailFadeOutSec) || tailFadeOutSec < 0 || tailFadeOutSec > 30)
    ) {
      fail("INVALID_PARAMS", "outroAlign.tailFadeOutSec must be in [0, 30]");
    }
  }
  if (
    params.crossfadeMs !== undefined &&
    (typeof params.crossfadeMs !== "number" || !Number.isFinite(params.crossfadeMs) || params.crossfadeMs < 5 || params.crossfadeMs > 250)
  ) {
    fail("INVALID_PARAMS", "crossfadeMs must be in [5, 250]");
  }
  if (
    params.targetIlu !== undefined &&
    (typeof params.targetIlu !== "number" || !Number.isFinite(params.targetIlu) || params.targetIlu < -30 || params.targetIlu > -10)
  ) {
    fail("INVALID_PARAMS", "targetIlu must be in [-30, -10]");
  }
}

async function probeAudioStreamExists(
  ffprobe: string,
  sourcePath: string,
  audioStream: number,
  signal?: AbortSignal,
): Promise<{ streamIndex: number; durationSec: number }> {
  const res = await runToolProcess(
    ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "stream=index,codec_type,duration:format=duration",
      "-of",
      "json",
      sourcePath,
    ],
    { signal },
  );
  const parsed = JSON.parse(res.stdout.toString("utf8")) as {
    streams?: Array<{ index?: number; codec_type?: string; duration?: string }>;
    format?: { duration?: string };
  };
  const audioStreams = (parsed.streams ?? []).filter((s) => s.codec_type === "audio");
  const target = audioStreams[audioStream];
  if (!target || typeof target.index !== "number") {
    fail("NOT_FOUND", `audioStream ${audioStream} does not exist in source media`);
  }
  const dur = Number(target.duration ?? parsed.format?.duration ?? 0);
  return { streamIndex: target.index, durationSec: Number.isFinite(dur) ? dur : 0 };
}

function normalizedCrossCorrelation(
  a: Float32Array,
  aStart: number,
  b: Float32Array,
  bStart: number,
  len: number,
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const va = a[aStart + i] ?? 0;
    const vb = b[bStart + i] ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA * normB);
  if (denom < 1e-12) return 0;
  return Math.max(-1, Math.min(1, dot / denom));
}

function computeBarMetrics(
  mono: Float32Array,
  totalBars: number,
  barSamples: number,
): { rms: number[]; adjCorr: number[] } {
  const rms: number[] = [];
  const adjCorr: number[] = [];
  for (let b = 0; b < totalBars; b++) {
    const start = b * barSamples;
    let sumSq = 0;
    for (let i = 0; i < barSamples; i++) {
      const s = mono[start + i] ?? 0;
      sumSq += s * s;
    }
    rms.push(Math.sqrt(sumSq / barSamples));
    if (b + 1 < totalBars) {
      adjCorr.push(normalizedCrossCorrelation(mono, start, mono, (b + 1) * barSamples, barSamples));
    }
  }
  return { rms, adjCorr };
}

function selectAutoLoopBars(
  mono: Float32Array,
  totalBars: number,
  barSamples: number,
): { startBar: number; endBar: number } {
  if (totalBars <= 1) return { startBar: 0, endBar: 1 };
  if (totalBars === 2) return { startBar: 0, endBar: 1 };
  if (totalBars === 3) return { startBar: 1, endBar: 2 };

  const { rms } = computeBarMetrics(mono, totalBars, barSamples);
  const sortedRms = [...rms].sort((a, b) => a - b);
  const medianRms = sortedRms[Math.floor(sortedRms.length / 2)] ?? 0;
  const energyFloor = medianRms * 0.4;

  // Reserve bar 0 as potential intro and last bar as potential outro when >= 4 bars.
  const minStart = 1;
  const maxEnd = totalBars - 1;
  let bestScore = -Infinity;
  let bestRange = { startBar: 1, endBar: Math.min(maxEnd, 3) };

  const maxWindow = Math.min(4, maxEnd - minStart);
  for (let len = 1; len <= maxWindow; len++) {
    for (let s = minStart; s + len <= maxEnd; s++) {
      const e = s + len;
      let avgRms = 0;
      for (let b = s; b < e; b++) avgRms += rms[b] ?? 0;
      avgRms /= len;
      if (avgRms < energyFloor && bestScore > -Infinity) continue;
      // Score self-loop continuity: how well bar (e-1) feeds into bar s.
      const loopTailCorr = normalizedCrossCorrelation(
        mono,
        (e - 1) * barSamples,
        mono,
        s * barSamples,
        Math.min(barSamples, SAMPLE_RATE),
      );
      const lengthBonus = len >= 2 ? 0.15 : 0;
      const energyScore = medianRms > 0 ? Math.min(1.5, avgRms / medianRms) * 0.25 : 0;
      const score = loopTailCorr + lengthBonus + energyScore;
      if (score > bestScore) {
        bestScore = score;
        bestRange = { startBar: s, endBar: e };
      }
    }
  }
  return bestRange;
}

interface PlannedSegment {
  startSample: number;
  endSample: number;
  startBar: number;
  endBar: number;
}

function buildSegmentPlan(options: {
  totalSourceSamples: number;
  barSamples: number;
  totalBars: number;
  targetSamples: number;
  desiredOutroEndSamples: number;
  loopStartBar: number;
  loopEndBar: number;
  outroStartBar: number | null;
  crossfadeSamples: number;
}): PlannedSegment[] {
  const {
    totalSourceSamples,
    barSamples,
    loopStartBar,
    loopEndBar,
    outroStartBar,
    desiredOutroEndSamples,
    crossfadeSamples,
  } = options;

  const outroStartSample = outroStartBar !== null ? outroStartBar * barSamples : totalSourceSamples;
  const rawOutroLen = outroStartBar !== null ? Math.max(0, totalSourceSamples - outroStartSample) : 0;

  // Short-circuit: target is shorter than or equal to outro alone.
  if (outroStartBar !== null && desiredOutroEndSamples <= rawOutroLen) {
    const startSample = Math.max(0, totalSourceSamples - desiredOutroEndSamples);
    return [
      {
        startSample,
        endSample: totalSourceSamples,
        startBar: Math.floor(startSample / barSamples),
        endBar: options.totalBars,
      },
    ];
  }

  const segments: PlannedSegment[] = [];
  const introEndSample = loopStartBar * barSamples;
  const maxBodyBudget = Math.max(0, desiredOutroEndSamples - rawOutroLen);

  // Include Intro when it fits alongside the Outro.
  let usedBeforeOutro = 0;
  if (introEndSample > 0 && introEndSample <= maxBodyBudget) {
    segments.push({
      startSample: 0,
      endSample: introEndSample,
      startBar: 0,
      endBar: loopStartBar,
    });
    usedBeforeOutro = introEndSample;
  }

  // Repeat Loop Body bars to fill the budget up to the Outro.
  const loopStartSample = loopStartBar * barSamples;
  const loopEndSample = loopEndBar * barSamples;
  const loopBodySamples = loopEndSample - loopStartSample;
  let remaining = maxBodyBudget - usedBeforeOutro;

  while (remaining > 0 && loopBodySamples > 0) {
    const effectiveAdd = remaining + (segments.length > 0 ? crossfadeSamples : 0);
    if (effectiveAdd >= loopBodySamples) {
      segments.push({
        startSample: loopStartSample,
        endSample: loopEndSample,
        startBar: loopStartBar,
        endBar: loopEndBar,
      });
      remaining -= loopBodySamples - (segments.length > 1 ? crossfadeSamples : 0);
      if (loopBodySamples <= crossfadeSamples) break;
    } else {
      const partialLen = Math.max(crossfadeSamples * 2, effectiveAdd);
      const clippedEnd = Math.min(loopEndSample, loopStartSample + partialLen);
      segments.push({
        startSample: loopStartSample,
        endSample: clippedEnd,
        startBar: loopStartBar,
        endBar: Math.min(loopEndBar, loopStartBar + Math.max(1, Math.round((clippedEnd - loopStartSample) / barSamples))),
      });
      remaining = 0;
    }
  }

  if (outroStartBar !== null && rawOutroLen > 0) {
    segments.push({
      startSample: outroStartSample,
      endSample: totalSourceSamples,
      startBar: outroStartBar,
      endBar: options.totalBars,
    });
  }

  if (segments.length === 0) {
    segments.push({
      startSample: 0,
      endSample: Math.min(totalSourceSamples, desiredOutroEndSamples),
      startBar: 0,
      endBar: Math.max(1, Math.floor(Math.min(totalSourceSamples, desiredOutroEndSamples) / barSamples)),
    });
  }

  return segments;
}

function stitchSegmentsWithCrossfade(options: {
  left: Float32Array;
  right: Float32Array;
  mono: Float32Array;
  segments: readonly PlannedSegment[];
  crossfadeSamples: number;
  targetSamples: number;
  tailFadeOutSec: number;
}): {
  outLeft: Float32Array;
  outRight: Float32Array;
  seams: AudioRemixSeam[];
} {
  const { left, right, mono, segments, crossfadeSamples, targetSamples, tailFadeOutSec } = options;
  const searchRadius = Math.round(0.015 * SAMPLE_RATE); // ±15 ms
  const zcWindow = 96; // ±2 ms zero-crossing polish

  // Estimate worst-case buffer length then slice cleanly to targetSamples.
  let estimatedLen = targetSamples;
  for (const seg of segments) {
    estimatedLen += seg.endSample - seg.startSample + searchRadius;
  }
  const bufLeft = new Float32Array(estimatedLen);
  const bufRight = new Float32Array(estimatedLen);
  const seams: AudioRemixSeam[] = [];

  const first = segments[0]!;
  const firstLen = first.endSample - first.startSample;
  for (let i = 0; i < firstLen; i++) {
    bufLeft[i] = left[first.startSample + i] ?? 0;
    bufRight[i] = right[first.startSample + i] ?? 0;
  }
  let writePos = firstLen;
  let prevEndBar = first.endBar;

  for (let sIdx = 1; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx]!;
    const segLen = seg.endSample - seg.startSample;
    const xf = Math.min(
      crossfadeSamples,
      Math.floor(writePos / 3),
      Math.floor(segLen / 3),
    );
    if (xf < 4) {
      for (let i = 0; i < segLen; i++) {
        bufLeft[writePos + i] = left[seg.startSample + i] ?? 0;
        bufRight[writePos + i] = right[seg.startSample + i] ?? 0;
      }
      writePos += segLen;
      prevEndBar = seg.endBar;
      continue;
    }

    // Build tail snippet from current output buffer for NCC comparison.
    const tailStart = writePos - xf;
    const outTailMono = new Float32Array(xf);
    for (let i = 0; i < xf; i++) {
      outTailMono[i] = 0.5 * ((bufLeft[tailStart + i] ?? 0) + (bufRight[tailStart + i] ?? 0));
    }

    let bestDelta = 0;
    let bestCorr = -Infinity;
    const minCandidate = Math.max(0, seg.startSample - searchRadius);
    const maxCandidate = Math.min(mono.length - xf - 1, seg.startSample + searchRadius);
    for (let candidate = minCandidate; candidate <= maxCandidate; candidate++) {
      const corr = normalizedCrossCorrelation(outTailMono, 0, mono, candidate, xf);
      // Slight tie-breaker toward 0 shift when correlation is identical.
      const tieScore = corr - Math.abs(candidate - seg.startSample) * 1e-7;
      if (tieScore > bestCorr) {
        bestCorr = corr;
        bestDelta = candidate - seg.startSample;
      }
    }
    const rawBestCorr = normalizedCrossCorrelation(
      outTailMono,
      0,
      mono,
      seg.startSample + bestDelta,
      xf,
    );

    // Optional fine zero-crossing polish within ±2 ms if correlation stays >= 98% of peak.
    let alignedStart = seg.startSample + bestDelta;
    const zcMin = Math.max(minCandidate, alignedStart - zcWindow);
    const zcMax = Math.min(maxCandidate, alignedStart + zcWindow);
    for (let c = zcMin; c <= zcMax; c++) {
      const sPrev = mono[c] ?? 0;
      const sNext = mono[c + 1] ?? 0;
      if (sPrev <= 0 && sNext > 0) {
        const zcCorr = normalizedCrossCorrelation(outTailMono, 0, mono, c, xf);
        if (zcCorr >= rawBestCorr * 0.98) {
          alignedStart = c;
          break;
        }
      }
    }

    const finalCorr = normalizedCrossCorrelation(outTailMono, 0, mono, alignedStart, xf);
    seams.push({
      timelineSec: Number((tailStart / SAMPLE_RATE).toFixed(6)),
      fromSourceBar: prevEndBar,
      toSourceBar: seg.startBar,
      correlation: Number(finalCorr.toFixed(6)),
    });

    // Equal-power cos/sin crossfade over [tailStart .. writePos).
    for (let i = 0; i < xf; i++) {
      const theta = ((i + 0.5) / xf) * (Math.PI / 2);
      const wOut = Math.cos(theta);
      const wIn = Math.sin(theta);
      const inIdx = alignedStart + i;
      bufLeft[tailStart + i] =
        (bufLeft[tailStart + i] ?? 0) * wOut + (left[inIdx] ?? 0) * wIn;
      bufRight[tailStart + i] =
        (bufRight[tailStart + i] ?? 0) * wOut + (right[inIdx] ?? 0) * wIn;
    }

    const postLen = Math.max(0, seg.endSample - (alignedStart + xf));
    for (let i = 0; i < postLen; i++) {
      bufLeft[writePos + i] = left[alignedStart + xf + i] ?? 0;
      bufRight[writePos + i] = right[alignedStart + xf + i] ?? 0;
    }
    writePos += postLen;
    prevEndBar = seg.endBar;
  }

  const outLen = targetSamples;
  const outLeft = new Float32Array(outLen);
  const outRight = new Float32Array(outLen);
  const copyLen = Math.min(outLen, writePos);
  outLeft.set(bufLeft.subarray(0, copyLen));
  outRight.set(bufRight.subarray(0, copyLen));

  // Apply smooth cosine tail fade-out.
  const fadeSamples = Math.min(outLen, Math.round(tailFadeOutSec * SAMPLE_RATE));
  if (fadeSamples > 0) {
    const fadeStart = outLen - fadeSamples;
    for (let i = 0; i < fadeSamples; i++) {
      const progress = (i + 1) / fadeSamples;
      const gain = 0.5 * (1 + Math.cos(Math.PI * progress));
      outLeft[fadeStart + i] *= gain;
      outRight[fadeStart + i] *= gain;
    }
  }

  return { outLeft, outRight, seams };
}

async function writeStereoS24Wav(
  filePath: string,
  left: Float32Array,
  right: Float32Array,
): Promise<void> {
  const numSamples = left.length;
  const bytesPerSample = 3; // PCM s24le
  const dataBytes = numSamples * CHANNELS * bytesPerSample;
  const buffer = Buffer.allocUnsafe(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * bytesPerSample, 28);
  buffer.writeUInt16LE(CHANNELS * bytesPerSample, 32);
  buffer.writeUInt16LE(24, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const cl = Math.max(-1, Math.min(1, left[i] ?? 0));
    const cr = Math.max(-1, Math.min(1, right[i] ?? 0));
    const il = Math.round(cl * 8388607);
    const ir = Math.round(cr * 8388607);
    buffer[offset] = il & 0xff;
    buffer[offset + 1] = (il >> 8) & 0xff;
    buffer[offset + 2] = (il >> 16) & 0xff;
    buffer[offset + 3] = ir & 0xff;
    buffer[offset + 4] = (ir >> 8) & 0xff;
    buffer[offset + 5] = (ir >> 16) & 0xff;
    offset += 6;
  }

  await writeFile(filePath, buffer);
}

async function applyLoudnormToWav(
  ffmpeg: string,
  wavPath: string,
  targetIlu: number,
  signal?: AbortSignal,
): Promise<void> {
  const pass1 = await runToolProcess(
    ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      wavPath,
      "-af",
      `loudnorm=I=${targetIlu}:TP=-1.0:LRA=11:print_format=json`,
      "-f",
      "null",
      "-",
    ],
    { signal },
  );
  const blocks = pass1.stderr.match(/\{\s*"input_i"[\s\S]*?\}/g) ?? [];
  const last = blocks.at(-1);
  if (!last) return;
  const parsed = JSON.parse(last) as Record<string, string>;
  const tempNorm = `${wavPath}.norm.wav`;
  await runToolProcess(
    ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      wavPath,
      "-af",
      `loudnorm=I=${targetIlu}:TP=-1.0:LRA=11:measured_I=${parsed.input_i}:measured_TP=${parsed.input_tp}:measured_LRA=${parsed.input_lra}:measured_thresh=${parsed.input_thresh}:offset=${parsed.target_offset}:linear=true`,
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      String(CHANNELS),
      "-c:a",
      "pcm_s24le",
      tempNorm,
    ],
    { signal },
  );
  await rename(tempNorm, wavPath);
}

async function cleanupOwnedDirectory(directory: string, mediaRoot: string): Promise<void> {
  const info = await lstat(directory).catch(() => null);
  if (!info) return;
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    resolveContainedPathDetailed(directory, [mediaRoot]).kind !== "ok"
  ) {
    throw new Error(`refusing to clean unexpected remix directory: ${directory}`);
  }
  for (const name of ["remixed.wav", "provenance.json", "decoded.f32", "remixed.wav.norm.wav"]) {
    const file = join(directory, name);
    await rm(file, { force: true }).catch(() => undefined);
  }
  await rmdir(directory).catch(() => undefined);
}

export async function discardRemixedAudioArtifact(
  artifact: RemixAudioArtifact,
  mediaRoots: readonly string[],
): Promise<void> {
  await cleanupOwnedDirectory(dirname(artifact.path), resolvePath(mediaRoots[0]!));
}

export async function produceRemixedAudio(
  input: ProduceRemixedAudioParams,
): Promise<RemixAudioArtifact> {
  validateParams(input.params);
  throwIfCancelled(input.signal);
  if (!Array.isArray(input.mediaRoots) || input.mediaRoots.length === 0) {
    fail("UNSUPPORTED", "no media roots configured for persistent generated audio");
  }
  if (
    typeof input.artifactId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.artifactId)
  ) {
    fail("INVALID_PARAMS", "artifactId must contain only letters, numbers, underscore or hyphen");
  }

  const sourceResolution = resolveContainedPathDetailed(input.sourcePath, input.mediaRoots);
  if (sourceResolution.kind === "outside") fail("INVALID_PARAMS", "sourcePath escapes configured media roots");
  if (sourceResolution.kind === "unresolvable") fail("NOT_FOUND", "sourcePath cannot be read");
  const sourceInfo = await stat(sourceResolution.path).catch(() => null);
  if (!sourceInfo?.isFile()) fail("INVALID_PARAMS", "sourcePath is not a regular file");
  const sourcePath = sourceResolution.path;

  const binaries = await resolveToolFfmpeg();
  if (!binaries) fail("UNSUPPORTED", "FFmpeg and FFprobe are required");
  throwIfCancelled(input.signal);
  input.progress?.(0.05);

  const audioStreamIndex = input.params.audioStream ?? 0;
  const { streamIndex } = await probeAudioStreamExists(
    binaries.ffprobe,
    sourcePath,
    audioStreamIndex,
    input.signal,
  );
  const sourceFingerprint = await fingerprintFile(sourcePath);
  if (sourceFingerprint.sha256 === null) fail("NOT_FOUND", "source could not be fingerprinted");

  const root = resolvePath(input.mediaRoots[0]!);
  const outputParent = join(root, "generated-assets", "audio-remix");
  const outputDir = join(outputParent, input.artifactId);
  const stagingDir = join(
    outputParent,
    `.${input.artifactId}.${process.pid}.${randomUUID()}.pending`,
  );
  const decodedPcmPath = join(stagingDir, "decoded.f32");
  const stagedWavPath = join(stagingDir, "remixed.wav");
  const stagedProvenancePath = join(stagingDir, "provenance.json");
  let publishedByThisAttempt = false;

  for (const file of [
    { fileId: "audio-output", path: join(outputDir, "remixed.wav"), purpose: "Remixed audio work output" },
    { fileId: "audio-output-provenance", path: join(outputDir, "provenance.json"), purpose: "Remixed audio provenance" },
    { fileId: "audio-staged-output", path: stagedWavPath, purpose: "Temporary remixed audio work" },
    { fileId: "audio-staged-provenance", path: stagedProvenancePath, purpose: "Temporary remix provenance" },
  ]) {
    input.artifactFileTracker?.record({
      ...file,
      kind: "work",
      rebuildable: true,
      deliveryStatus: "pending",
    });
  }

  try {
    await prepareArtifactDir(stagingDir, root, VERB);
    throwIfCancelled(input.signal);

    // Decode source audio stream to interleaved stereo float32 PCM at 48 kHz.
    await runToolProcess(
      binaries.ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-v",
        "error",
        "-i",
        sourcePath,
        "-map",
        `0:${streamIndex}`,
        "-vn",
        "-ar",
        String(SAMPLE_RATE),
        "-ac",
        String(CHANNELS),
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-y",
        decodedPcmPath,
      ],
      { signal: input.signal },
    );
    input.progress?.(0.25);

    const rawBytes = await readFile(decodedPcmPath);
    await rm(decodedPcmPath, { force: true }).catch(() => undefined);
    const totalSamples = Math.floor(rawBytes.byteLength / (4 * CHANNELS));
    if (totalSamples < SAMPLE_RATE * 0.25) {
      fail("INVALID_PARAMS", "source audio is too short to remix");
    }

    const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
    const left = new Float32Array(totalSamples);
    const right = new Float32Array(totalSamples);
    const mono = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      const l = view.getFloat32(i * 8, true);
      const r = view.getFloat32(i * 8 + 4, true);
      left[i] = l;
      right[i] = r;
      mono[i] = 0.5 * (l + r);
    }

    let bpm = input.params.bpm;
    let bpmAutoDetected = false;
    if (bpm === undefined) {
      bpmAutoDetected = true;
      const decimation = 6; // 48 kHz -> 8 kHz for core BeatDetectionEngine
      const downLen = Math.floor(totalSamples / decimation);
      const down = new Float32Array(downLen);
      for (let i = 0; i < downLen; i++) {
        down[i] = mono[i * decimation] ?? 0;
      }
      const beatRes = await analyzeBeatsInPcm(down, SAMPLE_RATE / decimation);
      let detected = beatRes.bpm;
      if (!Number.isFinite(detected) || detected <= 0) {
        fail("JOB_FAILED", "could not auto-detect BPM from source audio; pass explicit bpm");
      }
      while (detected < 40) detected *= 2;
      while (detected > 240) detected /= 2;
      bpm = Math.max(40, Math.min(240, Math.round(detected * 100) / 100));
    }
    input.progress?.(0.45);

    const beatsPerBar = input.params.beatsPerBar ?? 4;
    const barSec = (60 / bpm) * beatsPerBar;
    const barSamples = Math.max(1, Math.round(barSec * SAMPLE_RATE));
    const totalBars = Math.floor(totalSamples / barSamples);
    if (totalBars < 1) {
      fail("INVALID_PARAMS", "source audio is shorter than one musical bar at the resolved BPM");
    }

    if (input.params.loopBodyBars && input.params.loopBodyBars.endBar > totalBars) {
      fail(
        "INVALID_PARAMS",
        `loopBodyBars.endBar (${input.params.loopBodyBars.endBar}) exceeds detected source bars (${totalBars})`,
      );
    }
    if (
      input.params.outroAlign?.outroStartBar !== undefined &&
      input.params.outroAlign.outroStartBar >= totalBars
    ) {
      fail(
        "INVALID_PARAMS",
        `outroAlign.outroStartBar (${input.params.outroAlign.outroStartBar}) must be < source bars (${totalBars})`,
      );
    }

    const chosenLoop =
      input.params.loopBodyBars ?? selectAutoLoopBars(mono, totalBars, barSamples);
    const outroStartBar =
      input.params.outroAlign?.outroStartBar !== undefined
        ? input.params.outroAlign.outroStartBar
        : chosenLoop.endBar < totalBars
          ? chosenLoop.endBar
          : null;

    const targetSamples = Math.max(1, Math.round(input.params.targetDurationSec * SAMPLE_RATE));
    const desiredOutroEndSamples = Math.min(
      targetSamples,
      Math.round((input.params.outroAlign?.landAtSec ?? input.params.targetDurationSec) * SAMPLE_RATE),
    );
    const crossfadeSamples = Math.max(
      4,
      Math.round(((input.params.crossfadeMs ?? 36) / 1000) * SAMPLE_RATE),
    );

    const segments = buildSegmentPlan({
      totalSourceSamples: totalSamples,
      barSamples,
      totalBars,
      targetSamples,
      desiredOutroEndSamples,
      loopStartBar: chosenLoop.startBar,
      loopEndBar: chosenLoop.endBar,
      outroStartBar,
      crossfadeSamples,
    });

    const { outLeft, outRight, seams } = stitchSegmentsWithCrossfade({
      left,
      right,
      mono,
      segments,
      crossfadeSamples,
      targetSamples,
      tailFadeOutSec: input.params.outroAlign?.tailFadeOutSec ?? 3.0,
    });
    input.progress?.(0.75);

    await writeStereoS24Wav(stagedWavPath, outLeft, outRight);
    if (input.params.targetIlu !== undefined) {
      await applyLoudnormToWav(binaries.ffmpeg, stagedWavPath, input.params.targetIlu, input.signal);
    }
    input.progress?.(0.9);

    const verifiedWav = await assertContainedWrittenFile(stagedWavPath, root, VERB);
    const wavStat = await stat(verifiedWav);
    const sha256 = await sha256File(verifiedWav);
    const actualDurationSec = Number((targetSamples / SAMPLE_RATE).toFixed(6));
    const ffmpegVersion = await resolveFfmpegVersion();

    const artifact: RemixAudioArtifact = {
      path: join(outputDir, "remixed.wav"),
      provenancePath: join(outputDir, "provenance.json"),
      source: {
        mediaId: input.params.mediaId,
        path: sourcePath,
        audioStream: audioStreamIndex,
        projectId: input.sourceProjectId,
        ...(input.sourceWorkspaceId !== undefined ? { workspaceId: input.sourceWorkspaceId } : {}),
        revision: input.sourceRevision,
      },
      parameters: input.params,
      bpm,
      bpmAutoDetected,
      beatsPerBar,
      actualDurationSec,
      seams,
      timing: {
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        sampleCount: targetSamples,
        durationSec: actualDurationSec,
      },
      bytes: wavStat.size,
      sha256,
    };

    const provenance = {
      schemaVersion: 1,
      ...artifact,
      sourceSha256: sourceFingerprint.sha256,
      ffmpegVersion,
      algorithmVersion: `remix@1+${ffmpegVersion}`,
    };
    await writeFile(stagedProvenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { flag: "wx" });
    await assertContainedWrittenFile(stagedProvenancePath, root, VERB);

    await rename(stagingDir, outputDir);
    publishedByThisAttempt = true;
    input.artifactFileTracker?.forget("audio-staged-output");
    input.artifactFileTracker?.forget("audio-staged-provenance");
    await prepareArtifactDir(outputDir, root, VERB);
    const publishedWav = await assertContainedWrittenFile(join(outputDir, "remixed.wav"), root, VERB);
    const publishedProvenance = await assertContainedWrittenFile(join(outputDir, "provenance.json"), root, VERB);

    return {
      ...artifact,
      path: publishedWav,
      provenancePath: publishedProvenance,
    };
  } catch (error) {
    try {
      await cleanupOwnedDirectory(stagingDir, root);
      input.artifactFileTracker?.forget("audio-staged-output");
      input.artifactFileTracker?.forget("audio-staged-provenance");
    } catch {
      // Ignore staging cleanup error while propagating root failure.
    }
    if (publishedByThisAttempt) {
      await cleanupOwnedDirectory(outputDir, root).catch(() => undefined);
      input.artifactFileTracker?.forget("audio-output");
      input.artifactFileTracker?.forget("audio-output-provenance");
    }
    if (error instanceof FacadeError) throw error;
    if (input.signal?.aborted) fail("JOB_FAILED", "Cancelled");
    fail("JOB_FAILED", ffmpegMessage(error));
  }
}
