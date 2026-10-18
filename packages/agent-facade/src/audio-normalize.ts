/**
 * Local, two-pass FFmpeg loudness normalization for durable derived audio.
 *
 * The source is trimmed in source-time coordinates, timestamps are reset to
 * zero, and the decoded range is converted to a fixed sample rate/layout. The
 * exact output sample window is established before loudnorm and re-established
 * after it, then the resulting file is measured again before publication.
 */
import { randomUUID } from "node:crypto";
import { lstat, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";

import { FacadeError } from "./errors";
import { assertContainedWrittenFile, prepareArtifactDir, sha256File } from "./artifact-io";
import { fingerprintFile } from "./inspection-artifacts";
import { FfmpegToolError, resolveFfmpegVersion, resolveToolFfmpeg, runToolProcess } from "./media/ffmpeg-bin";
import { resolveContainedPathDetailed } from "./media/path-roots";
import { computeAudioReuseKey, findReusableAudioArtifact, recordReusableAudioArtifact, stageReusableAudioWav } from "./audio-artifact-reuse";

/**
 * AUD-11: long-material cap. The two loudnorm passes stream inside one FFmpeg
 * process each (no PCM buffering in this process), so the binding budgets are
 * wall-clock per pass (audioNormalizePassTimeoutMs) and output disk size
 * (288 KB/s for stereo s24le at 48 kHz — about 1.0 GiB per hour).
 */
export const AUDIO_NORMALIZE_MAX_RANGE_SEC = 3600;
export const AUDIO_NORMALIZE_MAX_INTEGRATED_DEVIATION_LU = 1;
export const AUDIO_NORMALIZE_MAX_TRUE_PEAK_OVERSHOOT_DBTP = 0.2;
const SAMPLE_RATE = 48_000;
const VERB = "audio.process.normalize";
/** Bump when the exact-range/loudnorm chain changes — it invalidates reuse keys. */
export const AUDIO_NORMALIZE_CHAIN_VERSION = 2;

/** Per-pass wall-clock budget: 3-minute floor + 8 s per source second; cancellation stays available. */
export function audioNormalizePassTimeoutMs(durationSec: number): number {
  return 180_000 + Math.ceil(Math.max(0, durationSec)) * 8_000;
}

export interface NormalizeAudioParams {
  readonly mediaId: string;
  /** Zero-based index among the source's audio streams. */
  readonly audioStream: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly targetLufs: number;
  readonly truePeakDbtp: number;
  readonly loudnessRangeLu: number;
  readonly sampleRate: 48_000;
  readonly channels: 1 | 2;
}

export interface NormalizeAudioMeasurement {
  readonly integratedLufs: number;
  readonly truePeakDbtp: number;
  readonly loudnessRangeLu: number;
  readonly thresholdLufs: number;
}

interface LoudnormPassResult {
  readonly measurement: NormalizeAudioMeasurement;
  readonly targetOffset: number;
}

type LoudnormMode = "linear" | "dynamic";

export interface NormalizeAudioArtifact {
  readonly path: string;
  readonly provenancePath: string;
  readonly source: {
    readonly mediaId: string;
    readonly path: string;
    readonly audioStream: number;
    readonly startSec: number;
    readonly endSec: number;
    readonly projectId: string;
    readonly workspaceId?: string;
    readonly revision: number;
  };
  readonly parameters: NormalizeAudioParams;
  readonly before: NormalizeAudioMeasurement;
  readonly after: NormalizeAudioMeasurement;
  readonly timing: {
    readonly sampleRate: 48_000;
    readonly channels: 1 | 2;
    readonly sampleCount: number;
    readonly durationSec: number;
    readonly outputStartSec: 0;
    readonly processingDelaySamples: 0;
    /**
     * AUD-12: leading silence preserved in the output when the requested
     * range starts before the selected audio stream (a track offset relative
     * to the media origin). Zero unless the stream starts inside the range.
     */
    readonly leadSilenceSamples: number;
  };
  readonly bytes: number;
  readonly sha256: string;
}

export interface ProduceNormalizedAudioParams {
  readonly sourcePath: string;
  readonly mediaRoots: readonly string[];
  readonly params: NormalizeAudioParams;
  readonly sourceProjectId: string;
  readonly sourceWorkspaceId?: string;
  readonly sourceRevision: number;
  readonly signal?: AbortSignal;
  /** Stable, caller-owned identifier reserved for this normalization job. */
  readonly artifactId: string;
  /** Optional 0–1 progress observer (AUD-11): probe→first pass→second pass→verify. */
  readonly progress?: (percent: number) => void;
}

interface ProbeStream {
  readonly codec_type?: string;
  readonly start_time?: string;
  readonly duration?: string;
  readonly duration_ts?: string;
  readonly time_base?: string;
  readonly sample_rate?: string;
  readonly channels?: number;
}

interface ProbeFile {
  readonly streams?: readonly ProbeStream[];
  readonly format?: { readonly duration?: string; readonly start_time?: string };
}

function fail(code: "INVALID_PARAMS" | "NOT_FOUND" | "JOB_FAILED" | "UNSUPPORTED" | "CONFLICT", message: string): never {
  throw new FacadeError(code, `${VERB}: ${message}`);
}

function validateParams(params: NormalizeAudioParams): number {
  if (!params || typeof params !== "object") fail("INVALID_PARAMS", "params are required");
  if (typeof params.mediaId !== "string" || params.mediaId.length === 0) fail("INVALID_PARAMS", "mediaId must be a non-empty string");
  if (!Number.isInteger(params.audioStream) || params.audioStream < 0) fail("INVALID_PARAMS", "audioStream must be a zero-based non-negative integer");
  if (!(Number.isFinite(params.startSec) && Number.isFinite(params.endSec) && params.startSec >= 0 && params.endSec > params.startSec)) {
    fail("INVALID_PARAMS", "source range must have finite seconds with 0 ≤ startSec < endSec");
  }
  const durationSec = params.endSec - params.startSec;
  if (durationSec > AUDIO_NORMALIZE_MAX_RANGE_SEC) {
    fail("INVALID_PARAMS", `source range may not exceed ${AUDIO_NORMALIZE_MAX_RANGE_SEC} seconds`);
  }
  if (!(Number.isFinite(params.targetLufs) && params.targetLufs >= -70 && params.targetLufs <= -5)) {
    fail("INVALID_PARAMS", "targetLufs must be in [-70, -5] LUFS");
  }
  if (!(Number.isFinite(params.truePeakDbtp) && params.truePeakDbtp >= -9 && params.truePeakDbtp <= 0)) {
    fail("INVALID_PARAMS", "truePeakDbtp must be in [-9, 0] dBTP");
  }
  if (!(Number.isFinite(params.loudnessRangeLu) && params.loudnessRangeLu >= 1 && params.loudnessRangeLu <= 50)) {
    fail("INVALID_PARAMS", "loudnessRangeLu must be in [1, 50] LU");
  }
  if (params.sampleRate !== SAMPLE_RATE) fail("INVALID_PARAMS", `sampleRate must be ${SAMPLE_RATE} Hz`);
  if (params.channels !== 1 && params.channels !== 2) fail("INVALID_PARAMS", "channels must be 1 or 2");
  const sampleCount = Math.round(durationSec * SAMPLE_RATE);
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) fail("INVALID_PARAMS", "source range is shorter than one output sample or too long to represent");
  return sampleCount;
}

function formatSeconds(seconds: number): string {
  return seconds.toFixed(9).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

function parseFiniteMetric(value: unknown, key: string): number {
  const metric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(metric)) {
    fail("JOB_FAILED", `loudnorm could not measure ${key}; silent or otherwise unmeasurable audio cannot be normalized`);
  }
  return metric;
}

export function parseLoudnorm(stderr: string): LoudnormPassResult {
  const jsonBlocks = stderr.match(/\{\s*"input_i"[\s\S]*?\}/g) ?? [];
  const last = jsonBlocks.at(-1);
  if (!last) fail("JOB_FAILED", "FFmpeg loudnorm returned no measurement block");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(last) as Record<string, unknown>;
  } catch (error) {
    fail("JOB_FAILED", `FFmpeg loudnorm returned invalid measurement JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    measurement: {
      integratedLufs: parseFiniteMetric(parsed.input_i, "integrated loudness"),
      truePeakDbtp: parseFiniteMetric(parsed.input_tp, "true peak"),
      loudnessRangeLu: parseFiniteMetric(parsed.input_lra, "loudness range"),
      thresholdLufs: parseFiniteMetric(parsed.input_thresh, "loudness threshold"),
    },
    targetOffset: parseFiniteMetric(parsed.target_offset, "target offset"),
  };
}

function parseTimeBase(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  return numerator > 0 && denominator > 0 ? numerator / denominator : null;
}

function parseTimeBaseRatio(value: string | undefined): { numerator: number; denominator: number } | null {
  if (!value) return null;
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  return numerator > 0 && denominator > 0 ? { numerator, denominator } : null;
}

function streamDuration(stream: ProbeStream): number | null {
  const durationTicks = Number(stream.duration_ts);
  const timeBase = parseTimeBase(stream.time_base);
  if (Number.isFinite(durationTicks) && timeBase !== null && durationTicks >= 0) return durationTicks * timeBase;
  const duration = Number(stream.duration);
  if (Number.isFinite(duration) && duration >= 0) return duration;
  return null;
}

function ffmpegMessage(error: unknown): string {
  if (error instanceof FfmpegToolError && /cancel/i.test(error.message)) return "Cancelled";
  return error instanceof Error ? error.message : String(error);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail("JOB_FAILED", "Cancelled");
}

export interface ProbedAudioStream {
  readonly durationSec: number;
  readonly streamIndex: number;
  /** Container/format timestamp origin: source time 0 refers to it. */
  readonly timestampOriginSec: number;
  /** Raw stream start_time from the probe; null when the container reports none. */
  readonly streamStartSec: number | null;
  /**
   * streamStartSec − timestampOriginSec: where the audio track begins in
   * source media time. Positive means the track starts after the media origin
   * (a leading delay); negative means it starts before it. Zero when unknown.
   */
  readonly streamOffsetSec: number;
}

export async function probeAudioStreams(
  ffprobe: string,
  sourcePath: string,
  audioStream: number,
  signal?: AbortSignal,
  options: { allowStreamOffset?: boolean } = {},
): Promise<ProbedAudioStream> {
  let result: ProbeFile;
  try {
    const { stdout } = await runToolProcess(ffprobe, [
      "-v", "error", "-show_streams", "-show_format", "-of", "json", sourcePath,
    ], { signal });
    result = JSON.parse(stdout.toString("utf8")) as ProbeFile;
  } catch (error) {
    if (signal?.aborted) fail("JOB_FAILED", "Cancelled");
    fail("JOB_FAILED", `could not probe source: ${ffmpegMessage(error)}`);
  }
  const allStreams = result.streams ?? [];
  const audioStreams = allStreams
    .map((stream, streamIndex) => ({ stream, streamIndex }))
    .filter(({ stream }) => stream.codec_type === "audio");
  if (audioStreams.length === 0) fail("INVALID_PARAMS", "source has no audio stream");
  const selected = audioStreams[audioStream];
  if (!selected) fail("INVALID_PARAMS", `audioStream ${audioStream} does not exist in the source`);
  const formatStart = Number(result.format?.start_time);
  const timestampOriginSec = Number.isFinite(formatStart) ? formatStart : 0;
  const streamStart = Number(selected.stream.start_time);
  const sourceSampleRate = Number(selected.stream.sample_rate);
  const startToleranceSec = 1 / (Number.isFinite(sourceSampleRate) && sourceSampleRate > 0 ? sourceSampleRate : SAMPLE_RATE);
  const streamStartSec = Number.isFinite(streamStart) ? streamStart : null;
  const streamOffsetSec = streamStartSec === null ? 0 : streamStartSec - timestampOriginSec;
  let durationSec = streamDuration(selected.stream);
  if (durationSec === null) {
    // Containers such as Matroska omit stream duration. The container end
    // may belong to another track, so measure this track's packet endpoint.
    const packets = await runToolProcess(ffprobe, [
      "-v", "error", "-select_streams", `a:${audioStream}`, "-show_packets",
      "-show_entries", "packet=pts_time,duration_time", "-of", "compact=p=0:nk=0", sourcePath,
    ], { signal });
    let endSec = -Infinity;
    for (const line of packets.stdout.toString("utf8").split(/\r?\n/)) {
      const fields = Object.fromEntries(line.split("|").map((field) => field.split("=")));
      const pts = Number(fields.pts_time);
      const duration = Number(fields.duration_time);
      if (Number.isFinite(pts) && Number.isFinite(duration) && duration > 0) endSec = Math.max(endSec, pts + duration);
    }
    durationSec = endSec - (streamStartSec ?? timestampOriginSec);
    if (!Number.isFinite(durationSec) || durationSec < 0) fail("JOB_FAILED", "the selected audio stream has no measurable duration");
  }
  if (streamStartSec !== null && Math.abs(streamOffsetSec) > startToleranceSec && options.allowStreamOffset !== true) {
    fail("INVALID_PARAMS", "selected audio track starts at a different source time than the media; audio tracks with a nonzero start offset are not supported");
  }
  return { durationSec, streamIndex: selected.streamIndex, timestampOriginSec, streamStartSec, streamOffsetSec };
}

/** The audited source-range window for one normalization request (AUD-12). */
export interface NormalizeRangeWindow {
  /** Container-PTS atrim start: origin + the first source second that carries audio. */
  readonly trimStartSec: number;
  /** Container-PTS atrim end: origin + endSec. */
  readonly trimEndSec: number;
  /** Output samples of real silence before the track begins; the legal leading delay is preserved, never dropped. */
  readonly leadSilenceSamples: number;
  /** Last source-media second covered by audio: streamOffsetSec + stream duration. */
  readonly coverageEndSec: number;
}

/**
 * AUD-12 time mapping, explicit and testable:
 *   source media time = container time − timestampOriginSec
 *   audio track time  = source media time − streamOffsetSec
 *   output time zero  = the requested range start in source media time
 * A range starting before the track begins keeps the gap as real output
 * silence (`leadSilenceSamples`); a negative offset simply means the track
 * has content before the media origin, which the PTS-based trim ignores.
 */
export function normalizeRangeWindow(
  params: { readonly startSec: number; readonly endSec: number },
  timing: { readonly timestampOriginSec: number; readonly streamOffsetSec: number },
  streamDurationSec: number,
): NormalizeRangeWindow {
  const audioFromSec = Math.max(params.startSec, timing.streamOffsetSec);
  return {
    trimStartSec: timing.timestampOriginSec + audioFromSec,
    trimEndSec: timing.timestampOriginSec + params.endSec,
    leadSilenceSamples: Math.max(0, Math.round((timing.streamOffsetSec - params.startSec) * SAMPLE_RATE)),
    coverageEndSec: timing.streamOffsetSec + streamDurationSec,
  };
}

export function exactRangeFilters(
  params: NormalizeAudioParams,
  sampleCount: number,
  timing: { readonly timestampOriginSec: number; readonly streamOffsetSec: number },
  streamDurationSec: number,
): string {
  const layout = params.channels === 1 ? "mono" : "stereo";
  const window = normalizeRangeWindow(params, timing, streamDurationSec);
  return [
    `atrim=start=${formatSeconds(window.trimStartSec)}:end=${formatSeconds(window.trimEndSec)}`,
    "asetpts=PTS-STARTPTS",
    `aresample=${SAMPLE_RATE}:async=0:first_pts=0`,
    `aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=${layout}`,
    ...(window.leadSilenceSamples > 0 ? [`adelay=delays=${window.leadSilenceSamples}S:all=1`] : []),
    `apad=whole_len=${sampleCount}`,
    `atrim=end_sample=${sampleCount}`,
  ].join(",");
}

function loudnormOptions(params: NormalizeAudioParams): string {
  return `I=${params.targetLufs}:TP=${params.truePeakDbtp}:LRA=${params.loudnessRangeLu}`;
}

/**
 * Incremental parser for ffmpeg `-progress pipe:1` blocks. Both out_time_us
 * and out_time_ms report microseconds (a documented ffmpeg quirk), and blocks
 * can split across chunk boundaries, so keep a small tail buffer.
 */
export function createFfmpegProgressWatcher(totalSec: number, report: (fraction: number) => void): (chunk: Buffer) => void {
  let tail = "";
  return (chunk: Buffer) => {
    tail = `${tail}${chunk.toString("latin1")}`.slice(-512);
    const matches = [...tail.matchAll(/out_time_(?:us|ms)=(\d+)/g)];
    const last = matches.at(-1);
    if (!last || !(totalSec > 0)) return;
    const seconds = Number(last[1]) / 1_000_000;
    if (Number.isFinite(seconds)) report(Math.min(1, Math.max(0, seconds / totalSec)));
  };
}

async function runMeasure(
  ffmpeg: string,
  sourcePath: string,
  streamIndex: number,
  params: NormalizeAudioParams,
  sampleCount: number,
  timing: { readonly timestampOriginSec: number; readonly streamOffsetSec: number },
  streamDurationSec: number,
  progress: ((percent: number) => void) | undefined,
  signal?: AbortSignal,
): Promise<LoudnormPassResult> {
  const durationSec = params.endSec - params.startSec;
  const filter = `${exactRangeFilters(params, sampleCount, timing, streamDurationSec)},loudnorm=${loudnormOptions(params)}:print_format=json`;
  const watcher = progress ? createFfmpegProgressWatcher(durationSec, (fraction) => progress(0.05 + 0.45 * fraction)) : undefined;
  try {
    const result = await runToolProcess(ffmpeg, [
      "-hide_banner", "-nostdin", "-nostats", "-v", "info", "-copyts", "-i", sourcePath,
      "-map", `0:${streamIndex}`, "-vn", "-af", filter, "-progress", "pipe:1", "-f", "null", "-",
    ], { signal, timeoutMs: audioNormalizePassTimeoutMs(durationSec), ...(watcher ? { onStdoutChunk: watcher } : {}) });
    return parseLoudnorm(result.stderr);
  } catch (error) {
    if (signal?.aborted) fail("JOB_FAILED", "Cancelled");
    if (error instanceof FacadeError) throw error;
    fail("JOB_FAILED", `first-pass loudness measurement failed: ${ffmpegMessage(error)}`);
  }
}

async function writeNormalizedWav(
  ffmpeg: string,
  sourcePath: string,
  streamIndex: number,
  outputPath: string,
  params: NormalizeAudioParams,
  sampleCount: number,
  timing: { readonly timestampOriginSec: number; readonly streamOffsetSec: number },
  streamDurationSec: number,
  firstPass: LoudnormPassResult,
  progress: ((percent: number) => void) | undefined,
  signal?: AbortSignal,
): Promise<LoudnormMode> {
  const durationSec = params.endSec - params.startSec;
  const filter = [
    exactRangeFilters(params, sampleCount, timing, streamDurationSec),
    `loudnorm=${loudnormOptions(params)}:measured_I=${firstPass.measurement.integratedLufs}:measured_TP=${firstPass.measurement.truePeakDbtp}:measured_LRA=${firstPass.measurement.loudnessRangeLu}:measured_thresh=${firstPass.measurement.thresholdLufs}:offset=${firstPass.targetOffset}:linear=true:print_format=json`,
    `aresample=${SAMPLE_RATE}:async=0:first_pts=0`,
    `aformat=sample_rates=${SAMPLE_RATE}`,
    `apad=whole_len=${sampleCount}`,
    `atrim=end_sample=${sampleCount}`,
    "asetpts=PTS-STARTPTS",
  ].join(",");
  const watcher = progress ? createFfmpegProgressWatcher(durationSec, (fraction) => progress(0.5 + 0.4 * fraction)) : undefined;
  try {
    const result = await runToolProcess(ffmpeg, [
      "-hide_banner", "-nostdin", "-nostats", "-v", "info", "-copyts", "-i", sourcePath,
      "-map", `0:${streamIndex}`, "-vn", "-af", filter,
      "-ar", String(SAMPLE_RATE), "-ac", String(params.channels), "-c:a", "pcm_s24le",
      "-f", "wav", "-y", outputPath,
    ], { signal, timeoutMs: audioNormalizePassTimeoutMs(durationSec), ...(watcher ? { onStdoutChunk: watcher } : {}) });
    const blocks = result.stderr.match(/\{\s*"input_i"[\s\S]*?\}/g) ?? [];
    const block = blocks.at(-1);
    if (!block) fail("JOB_FAILED", "second-pass loudnorm returned no measurement block");
    const parsed = JSON.parse(block) as Record<string, unknown>;
    if (parsed.normalization_type !== "linear" && parsed.normalization_type !== "dynamic") {
      fail("JOB_FAILED", "second-pass loudnorm did not report its applied normalization mode");
    }
    return parsed.normalization_type;
  } catch (error) {
    if (signal?.aborted) fail("JOB_FAILED", "Cancelled");
    fail("JOB_FAILED", `second-pass normalization failed: ${ffmpegMessage(error)}`);
  }
}

async function measurePublishedSamples(ffprobe: string, wavPath: string, expected: number, channels: 1 | 2, signal?: AbortSignal): Promise<void> {
  let result: ProbeFile;
  try {
    const { stdout } = await runToolProcess(ffprobe, [
      "-v", "error", "-select_streams", "a:0", "-show_streams", "-of", "json", wavPath,
    ], { signal });
    result = JSON.parse(stdout.toString("utf8")) as ProbeFile;
  } catch (error) {
    if (signal?.aborted) fail("JOB_FAILED", "Cancelled");
    fail("JOB_FAILED", `could not verify output WAV: ${ffmpegMessage(error)}`);
  }
  const stream = result.streams?.[0];
  if (!stream || stream.codec_type !== "audio") fail("JOB_FAILED", "normalized WAV has no audio stream");
  const rate = Number(stream.sample_rate);
  const tickRatio = parseTimeBaseRatio(stream.time_base);
  const ticks = Number(stream.duration_ts);
  const actual = Number.isSafeInteger(ticks) && tickRatio !== null && (ticks * tickRatio.numerator * rate) % tickRatio.denominator === 0
    ? (ticks * tickRatio.numerator * rate) / tickRatio.denominator
    : Number.NaN;
  if (rate !== SAMPLE_RATE || Number(stream.channels) !== channels || actual !== expected) {
    fail("JOB_FAILED", `normalized WAV sample count/rate did not match the requested window (got ${actual} samples at ${rate} Hz; expected ${expected} at ${SAMPLE_RATE} Hz)`);
  }
}

async function measureOutput(
  ffmpeg: string,
  wavPath: string,
  params: NormalizeAudioParams,
  progress: ((percent: number) => void) | undefined,
  signal?: AbortSignal,
): Promise<NormalizeAudioMeasurement> {
  const filter = `loudnorm=${loudnormOptions(params)}:print_format=json`;
  const durationSec = params.endSec - params.startSec;
  const watcher = progress ? createFfmpegProgressWatcher(durationSec, (fraction) => progress(0.9 + 0.08 * fraction)) : undefined;
  try {
    const result = await runToolProcess(ffmpeg, [
      "-hide_banner", "-nostdin", "-nostats", "-v", "info", "-i", wavPath,
      "-map", "0:a:0", "-vn", "-af", filter, "-progress", "pipe:1", "-f", "null", "-",
    ], { signal, timeoutMs: audioNormalizePassTimeoutMs(durationSec), ...(watcher ? { onStdoutChunk: watcher } : {}) });
    return parseLoudnorm(result.stderr).measurement;
  } catch (error) {
    if (signal?.aborted) fail("JOB_FAILED", "Cancelled");
    if (error instanceof FacadeError) throw error;
    fail("JOB_FAILED", `final loudness measurement failed: ${ffmpegMessage(error)}`);
  }
}

async function inspectPublishedDirectory(
  outputDir: string,
  mediaRoot: string,
  expectedWavSha256: string,
  expectedProvenanceSha256: string,
): Promise<{ wavPath: string; provenancePath: string }> {
  const info = await lstat(outputDir).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    fail("CONFLICT", "artifactId is already occupied by a non-directory path");
  }
  await prepareArtifactDir(outputDir, mediaRoot, VERB);
  const wavPath = await assertContainedWrittenFile(join(outputDir, "normalized.wav"), mediaRoot, VERB);
  const provenancePath = await assertContainedWrittenFile(join(outputDir, "provenance.json"), mediaRoot, VERB);
  const [wavHash, provenanceHash] = await Promise.all([sha256File(wavPath), sha256File(provenancePath)]);
  if (wavHash !== expectedWavSha256 || provenanceHash !== expectedProvenanceSha256) {
    fail("CONFLICT", "artifactId already names a different normalized result; choose a new artifactId");
  }
  return { wavPath, provenancePath };
}

async function cleanupOwnedDirectory(directory: string, mediaRoot: string): Promise<void> {
  const failures: string[] = [];
  let directoryInfo;
  try {
    directoryInfo = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || resolveContainedPathDetailed(directory, [mediaRoot]).kind !== "ok") {
    throw new Error(`refusing to clean an output directory that is no longer a real contained directory: ${directory}`);
  }

  for (const filename of ["normalized.wav", "provenance.json"]) {
    const filePath = join(directory, filename);
    let fileInfo;
    try {
      fileInfo = await lstat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      failures.push(`${filename}: ${ffmpegMessage(error)}`);
      continue;
    }
    if (fileInfo.isDirectory()) {
      failures.push(`${filename}: refusing to remove an unexpected directory`);
      continue;
    }
    if (!fileInfo.isSymbolicLink() && resolveContainedPathDetailed(filePath, [mediaRoot]).kind !== "ok") {
      failures.push(`${filename}: refusing to remove a file outside the configured media root`);
      continue;
    }
    try {
      // Removing a final symlink unlinks only the link itself.
      await rm(filePath, { force: true });
    } catch (error) {
      failures.push(`${filename}: ${ffmpegMessage(error)}`);
    }
  }
  if (failures.length === 0) {
    try {
      await rmdir(directory);
    } catch (error) {
      failures.push(`directory: ${ffmpegMessage(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
}

/** Roll back an unregistered output if cancellation/checkpointing wins publication. */
export async function discardNormalizedAudioArtifact(artifact: NormalizeAudioArtifact, mediaRoots: readonly string[]): Promise<void> {
  await cleanupOwnedDirectory(dirname(artifact.path), resolvePath(mediaRoots[0]!));
}

/**
 * Normalize one selected source range and publish an immutable WAV plus its
 * provenance JSON under the first configured media root.
 */
/** Strictly validate a reuse candidate's recorded measurements; null → recompute. */
function readReusableMeasurements(provenance: Record<string, unknown>, expectedSourceSha256: string): {
  before: NormalizeAudioMeasurement;
  after: NormalizeAudioMeasurement;
  normalizationMode: LoudnormMode;
  firstPassTargetOffset: number;
} | null {
  const isMeasurement = (value: unknown): value is NormalizeAudioMeasurement =>
    typeof value === "object" && value !== null &&
    Number.isFinite((value as NormalizeAudioMeasurement).integratedLufs) &&
    Number.isFinite((value as NormalizeAudioMeasurement).truePeakDbtp) &&
    Number.isFinite((value as NormalizeAudioMeasurement).loudnessRangeLu) &&
    Number.isFinite((value as NormalizeAudioMeasurement).thresholdLufs);
  const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  if (provenance.sourceSha256 !== expectedSourceSha256) return null;
  if (!isMeasurement(provenance.before) || !isMeasurement(provenance.after)) return null;
  if ((provenance.normalizationMode !== "linear" && provenance.normalizationMode !== "dynamic") || !finiteNumber(provenance.firstPassTargetOffset)) return null;
  return {
    before: provenance.before,
    after: provenance.after,
    normalizationMode: provenance.normalizationMode,
    firstPassTargetOffset: provenance.firstPassTargetOffset,
  };
}

export async function produceNormalizedAudio(input: ProduceNormalizedAudioParams): Promise<NormalizeAudioArtifact> {
  const sampleCount = validateParams(input.params);
  throwIfCancelled(input.signal);
  if (!Array.isArray(input.mediaRoots) || input.mediaRoots.length === 0) fail("UNSUPPORTED", "no media roots configured for persistent generated audio");
  if (typeof input.artifactId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.artifactId)) {
    fail("INVALID_PARAMS", "artifactId must contain only letters, numbers, underscore or hyphen (1–128 characters)");
  }
  if (typeof input.sourceProjectId !== "string" || input.sourceProjectId.length === 0 || !Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 0) {
    fail("INVALID_PARAMS", "source project identity and non-negative integer revision are required");
  }

  const sourceResolution = resolveContainedPathDetailed(input.sourcePath, input.mediaRoots);
  if (sourceResolution.kind === "outside") fail("INVALID_PARAMS", "sourcePath escapes the configured media roots");
  if (sourceResolution.kind === "unresolvable") fail("NOT_FOUND", "sourcePath cannot be read");
  const sourceInfo = await stat(sourceResolution.path).catch(() => null);
  if (!sourceInfo?.isFile()) fail("INVALID_PARAMS", "sourcePath is not a regular file");
  const sourcePath = sourceResolution.path;

  const binaries = await resolveToolFfmpeg();
  if (!binaries) fail("UNSUPPORTED", "FFmpeg and FFprobe are required (install them on PATH or configure REELTERMINAL_FFMPEG_PATH / REELTERMINAL_FFPROBE_PATH)");
  throwIfCancelled(input.signal);
  input.progress?.(0.02);

  const { durationSec, streamIndex, timestampOriginSec, streamStartSec, streamOffsetSec } = await probeAudioStreams(binaries.ffprobe, sourcePath, input.params.audioStream, input.signal, { allowStreamOffset: true });
  const rangeWindow = normalizeRangeWindow(input.params, { timestampOriginSec, streamOffsetSec }, durationSec);
  if (input.params.endSec > rangeWindow.coverageEndSec + 1 / SAMPLE_RATE) {
    fail("INVALID_PARAMS", `source range ends after the selected audio stream (audio covers source time ${streamOffsetSec.toFixed(3)}–${rangeWindow.coverageEndSec.toFixed(3)} seconds; stream duration ${durationSec.toFixed(3)})`);
  }
  if (input.params.endSec <= streamOffsetSec) {
    fail("INVALID_PARAMS", `source range ends before the selected audio track starts (the track begins at source time ${streamOffsetSec.toFixed(3)} seconds); the output would contain no audio`);
  }
  const sourceFingerprint = await fingerprintFile(sourcePath);
  if (sourceFingerprint.sha256 === null) fail("NOT_FOUND", "source could not be fingerprinted");
  const timing = { timestampOriginSec, streamOffsetSec };
  const ffmpegVersion = await resolveFfmpegVersion();
  const algorithmVersion = `normalize@${AUDIO_NORMALIZE_CHAIN_VERSION}+${ffmpegVersion}`;
  const cacheKey = computeAudioReuseKey({
    verb: VERB,
    sourceSha256: sourceFingerprint.sha256,
    audioStream: input.params.audioStream,
    startSec: formatSeconds(input.params.startSec),
    endSec: formatSeconds(input.params.endSec),
    targetLufs: input.params.targetLufs,
    truePeakDbtp: input.params.truePeakDbtp,
    loudnessRangeLu: input.params.loudnessRangeLu,
    sampleRate: input.params.sampleRate,
    channels: input.params.channels,
    leadSilenceSamples: rangeWindow.leadSilenceSamples,
    algorithm: algorithmVersion,
  });

  const root = resolvePath(input.mediaRoots[0]!);
  const outputParent = join(root, "generated-assets", "audio-normalize");
  const outputDir = join(outputParent, input.artifactId);
  const stagingDir = join(outputParent, `.${input.artifactId}.${process.pid}.${randomUUID()}.pending`);
  const stagedWavPath = join(stagingDir, "normalized.wav");
  const stagedProvenancePath = join(stagingDir, "provenance.json");
  let publishedByThisAttempt = false;

  let before: NormalizeAudioMeasurement | null = null;
  let after: NormalizeAudioMeasurement | null = null;
  let normalizationMode: LoudnormMode | null = null;
  let firstPassTargetOffset: number | null = null;
  let reusedFrom: { cacheKey: string; artifactId: string } | null = null;

  try {
    await prepareArtifactDir(stagingDir, root, VERB);
    // AUD-13 content-addressed reuse: a validated byte-identical prior result
    // is copied instead of recomputing; its recorded measurements describe
    // exactly these bytes. Any doubt recomputes. A same-artifactId retry keeps
    // the compute-then-compare semantics below, so reuse only applies to a
    // fresh artifactId.
    const outputDirExists = (await lstat(outputDir).catch(() => null)) !== null;
    const reuseHit = outputDirExists ? null : await findReusableAudioArtifact({
      root, kind: "audio-normalize", cacheKey, algorithmVersion, wavFilename: "normalized.wav",
    });
    if (reuseHit !== null) {
      const reusableMeasurements = readReusableMeasurements(reuseHit.provenance, sourceFingerprint.sha256);
      if (reusableMeasurements !== null) {
        await stageReusableAudioWav(reuseHit, stagedWavPath);
        before = reusableMeasurements.before;
        after = reusableMeasurements.after;
        normalizationMode = reusableMeasurements.normalizationMode;
        firstPassTargetOffset = reusableMeasurements.firstPassTargetOffset;
        reusedFrom = { cacheKey, artifactId: reuseHit.artifactId };
        input.progress?.(0.9);
      }
    }
    if (reusedFrom === null) {
      const firstPass = await runMeasure(binaries.ffmpeg, sourcePath, streamIndex, input.params, sampleCount, timing, durationSec, input.progress, input.signal);
      before = firstPass.measurement;
      throwIfCancelled(input.signal);
      normalizationMode = await writeNormalizedWav(binaries.ffmpeg, sourcePath, streamIndex, stagedWavPath, input.params, sampleCount, timing, durationSec, firstPass, input.progress, input.signal);
      firstPassTargetOffset = firstPass.targetOffset;
      input.progress?.(0.9);
    }
    const verifiedStagedWav = await assertContainedWrittenFile(stagedWavPath, root, VERB);
    await measurePublishedSamples(binaries.ffprobe, verifiedStagedWav, sampleCount, input.params.channels, input.signal);
    if (reusedFrom === null) {
      after = await measureOutput(binaries.ffmpeg, verifiedStagedWav, input.params, input.progress, input.signal);
    }
    if (before === null || after === null || normalizationMode === null || firstPassTargetOffset === null) {
      fail("JOB_FAILED", "internal: normalization measurements were not established");
    }
    throwIfCancelled(input.signal);
    const integratedDeviation = Math.abs(after.integratedLufs - input.params.targetLufs);
    const truePeakOvershoot = after.truePeakDbtp - input.params.truePeakDbtp;
    if (
      integratedDeviation > AUDIO_NORMALIZE_MAX_INTEGRATED_DEVIATION_LU ||
      truePeakOvershoot > AUDIO_NORMALIZE_MAX_TRUE_PEAK_OVERSHOOT_DBTP
    ) {
      throw new FacadeError(
        "JOB_FAILED",
        `${VERB}: remeasured output misses the requested targets (LUFS ${after.integratedLufs.toFixed(2)} vs ${input.params.targetLufs.toFixed(2)}; true peak ${after.truePeakDbtp.toFixed(2)} vs ${input.params.truePeakDbtp.toFixed(2)} dBTP; allowed ${AUDIO_NORMALIZE_MAX_INTEGRATED_DEVIATION_LU.toFixed(1)} LU / ${AUDIO_NORMALIZE_MAX_TRUE_PEAK_OVERSHOOT_DBTP.toFixed(1)} dBTP); no asset was published`,
        {
          before,
          after,
          targets: {
            integratedLufs: input.params.targetLufs,
            truePeakDbtp: input.params.truePeakDbtp,
          },
          tolerance: {
            integratedDeviationLu: AUDIO_NORMALIZE_MAX_INTEGRATED_DEVIATION_LU,
            truePeakOvershootDbtp: AUDIO_NORMALIZE_MAX_TRUE_PEAK_OVERSHOOT_DBTP,
          },
        },
      );
    }

    const currentFingerprint = await fingerprintFile(sourcePath);
    if (currentFingerprint.sha256 !== sourceFingerprint.sha256) {
      fail("CONFLICT", "source media changed while normalization was running; retry against its current version");
    }
    const wavStat = await stat(verifiedStagedWav);
    if (!wavStat.isFile() || wavStat.size === 0) fail("JOB_FAILED", "normalized WAV is missing or empty");
    const sha256 = await sha256File(verifiedStagedWav);
    const source = {
      mediaId: input.params.mediaId,
      path: sourcePath,
      audioStream: input.params.audioStream,
      startSec: input.params.startSec,
      endSec: input.params.endSec,
      projectId: input.sourceProjectId,
      ...(input.sourceWorkspaceId !== undefined ? { workspaceId: input.sourceWorkspaceId } : {}),
      revision: input.sourceRevision,
    };
    const timingFacts = {
      sampleRate: SAMPLE_RATE as 48_000,
      channels: input.params.channels,
      sampleCount,
      durationSec: sampleCount / SAMPLE_RATE,
      outputStartSec: 0 as const,
      processingDelaySamples: 0 as const,
      leadSilenceSamples: rangeWindow.leadSilenceSamples,
    };
    const artifact: NormalizeAudioArtifact = {
      path: join(outputDir, "normalized.wav"),
      provenancePath: join(outputDir, "provenance.json"),
      source,
      parameters: input.params,
      before,
      after,
      timing: timingFacts,
      bytes: wavStat.size,
      sha256,
    };
    const provenance = {
      schemaVersion: 2,
      ...artifact,
      sourceSha256: sourceFingerprint.sha256,
      firstPassTargetOffset,
      normalizationMode,
      sourceTimestampOriginSec: timestampOriginSec,
      sourceStreamStartSec: streamStartSec,
      sourceStreamOffsetSec: streamOffsetSec,
      algorithmVersion,
      ...(reusedFrom !== null ? { reusedFrom } : {}),
      method: `${reusedFrom !== null
        ? "Byte-identical reuse of a validated prior artifact (content-addressed cache hit; the loudnorm passes were not re-run — the recorded measurements describe exactly these bytes)."
        : "FFmpeg two-pass loudnorm; source range is trimmed then mapped to output time zero; exact 48 kHz sample window; PCM s24le WAV; final measurements are from the written WAV."} Audio-track offset relative to the media origin is mapped explicitly: a range starting before the track begins keeps the gap as real output silence (timing.leadSilenceSamples), so nothing is silently shifted.`,
    };
    await writeFile(stagedProvenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { flag: "wx" });
    throwIfCancelled(input.signal);
    const verifiedStagedProvenance = await assertContainedWrittenFile(stagedProvenancePath, root, VERB);
    const provenanceSha256 = await sha256File(verifiedStagedProvenance);
    let published: { wavPath: string; provenancePath: string };
    const existing = await lstat(outputDir).catch(() => null);
    if (existing !== null) {
      published = await inspectPublishedDirectory(outputDir, root, sha256, provenanceSha256);
    } else {
      try {
        await rename(stagingDir, outputDir);
        publishedByThisAttempt = true;
        await prepareArtifactDir(outputDir, root, VERB);
        published = {
          wavPath: await assertContainedWrittenFile(join(outputDir, "normalized.wav"), root, VERB),
          provenancePath: await assertContainedWrittenFile(join(outputDir, "provenance.json"), root, VERB),
        };
      } catch (error) {
        if (publishedByThisAttempt) throw error;
        const appeared = await lstat(outputDir).catch(() => null);
        if (appeared === null) throw error;
        published = await inspectPublishedDirectory(outputDir, root, sha256, provenanceSha256);
      }
    }
    if (!publishedByThisAttempt) await cleanupOwnedDirectory(stagingDir, root);
    throwIfCancelled(input.signal);
    // AUD-13: name this published artifact as the reusable result for the
    // computed key. Best-effort — an indexing failure never fails the job.
    await recordReusableAudioArtifact({
      root, kind: "audio-normalize", cacheKey, artifactId: input.artifactId,
      wavFilename: "normalized.wav", wavSha256: sha256, algorithmVersion,
    }).catch(() => {});
    return {
      ...artifact,
      path: published.wavPath,
      provenancePath: published.provenancePath,
    };
  } catch (error) {
    const cleanupErrors: string[] = [];
    try {
      await cleanupOwnedDirectory(stagingDir, root);
    } catch (cleanupError) {
      cleanupErrors.push(`pending output cleanup failed: ${ffmpegMessage(cleanupError)}`);
    }
    if (publishedByThisAttempt) {
      try {
        await cleanupOwnedDirectory(outputDir, root);
      } catch (cleanupError) {
        cleanupErrors.push(`published output cleanup failed: ${ffmpegMessage(cleanupError)}`);
      }
    }
    if (cleanupErrors.length > 0) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      throw new FacadeError("JOB_FAILED", `${VERB}: ${originalMessage}; ${cleanupErrors.join("; ")}`, { cleanupFailed: true });
    }
    if (error instanceof FacadeError) throw error;
    if (input.signal?.aborted) fail("JOB_FAILED", "Cancelled");
    fail("JOB_FAILED", ffmpegMessage(error));
  }
}
