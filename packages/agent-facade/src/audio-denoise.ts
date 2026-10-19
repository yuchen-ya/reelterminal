/**
 * Tiered local denoising for durable derived audio (AUD-08).
 *
 * The evaluation round (docs/archive/AUDIO-MODEL-EVAL-2026-10-18.md) measured a fixed
 * 1200-sample (25 ms at 48 kHz) processing delay for every FFmpeg chain
 * containing `afftdn`/`adeclick`; uncompensated it makes SI-SDR collapse and,
 * for real edits, shifts audio against picture. This producer therefore
 * measures the delay of the exact filter chain with a deterministic noise
 * probe before writing anything, trims it out, pads the tail, verifies the
 * published sample count, and cross-correlates the published output against
 * the source to prove the compensation worked. A chain whose delay cannot be
 * measured honestly fails instead of publishing a possibly misaligned asset.
 *
 * Two stationary-noise tiers are exposed. Dynamic processing ("voice chain")
 * is deliberately NOT part of denoising: the audit showed it degraded SI-SDR
 * across every case, and loudness normalization keeps its own separate verb.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";

import { FFT } from "@reelterminal/core/audio/fft";

import { FacadeError } from "./errors";
import { assertContainedWrittenFile, prepareArtifactDir, sha256File } from "./artifact-io";
import { fingerprintFile } from "./inspection-artifacts";
import { FfmpegToolError, resolveFfmpegVersion, resolveToolFfmpeg, runToolProcess } from "./media/ffmpeg-bin";
import { resolveContainedPathDetailed } from "./media/path-roots";
import { parseLoudnorm, probeAudioStreams, type NormalizeAudioMeasurement } from "./audio-normalize";
import { computeAudioReuseKey, findReusableAudioArtifact, recordReusableAudioArtifact, stageReusableAudioWav } from "./audio-artifact-reuse";

export const AUDIO_DENOISE_MAX_RANGE_SEC = 120;
/** Bump when the denoise chain changes — it invalidates reuse keys. */
export const AUDIO_DENOISE_CHAIN_VERSION = 1;
const SAMPLE_RATE = 48_000;
const VERB = "audio.process.denoise";
const DELAY_PROBE_SECONDS = 1.5;
const MAX_DELAY_SECONDS = 0.5;
const ALIGNMENT_CHECK_SECONDS = 10;

export type DenoiseProfile = "light" | "strong";

export interface DenoiseAudioParams {
  readonly mediaId: string;
  /** Zero-based index among the source's audio streams. */
  readonly audioStream: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly sampleRate: 48_000;
  readonly channels: 1 | 2;
  /** light = afftdn nr=12/nf=-25; strong = afftdn nr=24/nf=-35. */
  readonly profile: DenoiseProfile;
  /** Optional adeclick before afftdn (impulsive clicks); same fixed delay. */
  readonly declick?: boolean;
}

export interface AudioProcessDenoiseParams extends DenoiseAudioParams {
  readonly expectedRevision?: number;
  readonly idempotencyKey: string;
}

export interface DenoiseAudioArtifact {
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
  readonly parameters: DenoiseAudioParams;
  readonly before: NormalizeAudioMeasurement;
  readonly after: NormalizeAudioMeasurement;
  readonly timing: {
    readonly sampleRate: 48_000;
    readonly channels: 1 | 2;
    readonly sampleCount: number;
    readonly durationSec: number;
    readonly outputStartSec: 0;
    /** Delay is compensated, so the published output is sample-aligned. */
    readonly processingDelaySamples: 0;
  };
  readonly processing: {
    readonly profile: DenoiseProfile;
    readonly declick: boolean;
    readonly filterChain: readonly string[];
    readonly measuredFilterDelaySamples: number;
    readonly measuredFilterDelaySec: number;
    readonly measuredDelayProminenceDb: number;
    readonly alignmentCheck: {
      readonly checkedSec: number;
      readonly lagSamples: number | null;
      readonly prominenceDb: number | null;
      readonly verdict: "aligned" | "unverified";
      readonly note: string | null;
    };
  };
  readonly bytes: number;
  readonly sha256: string;
}

export interface ProduceDenoisedAudioParams {
  readonly sourcePath: string;
  readonly mediaRoots: readonly string[];
  readonly params: DenoiseAudioParams;
  readonly sourceProjectId: string;
  readonly sourceWorkspaceId?: string;
  readonly sourceRevision: number;
  readonly signal?: AbortSignal;
  /** Stable, caller-owned identifier reserved for this denoise job. */
  readonly artifactId: string;
}

function fail(code: "INVALID_PARAMS" | "NOT_FOUND" | "JOB_FAILED" | "UNSUPPORTED" | "CONFLICT", message: string): never {
  throw new FacadeError(code, `${VERB}: ${message}`);
}

export function resolveDenoiseProfile(profile: DenoiseProfile, declick: boolean): { filters: string[]; label: string } {
  const noise = profile === "light" ? "afftdn=nr=12:nf=-25" : "afftdn=nr=24:nf=-35";
  const filters = declick ? ["adeclick=window=55:overlap=75", noise] : [noise];
  return { filters, label: declick ? `adeclick+${noise}` : noise };
}

function validateParams(params: DenoiseAudioParams): number {
  if (!params || typeof params !== "object") fail("INVALID_PARAMS", "params are required");
  if (typeof params.mediaId !== "string" || params.mediaId.length === 0) fail("INVALID_PARAMS", "mediaId must be a non-empty string");
  if (!Number.isInteger(params.audioStream) || params.audioStream < 0) fail("INVALID_PARAMS", "audioStream must be a zero-based non-negative integer");
  if (!(Number.isFinite(params.startSec) && Number.isFinite(params.endSec) && params.startSec >= 0 && params.endSec > params.startSec)) {
    fail("INVALID_PARAMS", "source range must have finite seconds with 0 ≤ startSec < endSec");
  }
  const durationSec = params.endSec - params.startSec;
  if (durationSec > AUDIO_DENOISE_MAX_RANGE_SEC) fail("INVALID_PARAMS", `source range may not exceed ${AUDIO_DENOISE_MAX_RANGE_SEC} seconds`);
  if (params.sampleRate !== SAMPLE_RATE) fail("INVALID_PARAMS", `sampleRate must be ${SAMPLE_RATE} Hz`);
  if (params.channels !== 1 && params.channels !== 2) fail("INVALID_PARAMS", "channels must be 1 or 2");
  if (params.profile !== "light" && params.profile !== "strong") fail("INVALID_PARAMS", "profile must be light or strong");
  if (params.declick !== undefined && typeof params.declick !== "boolean") fail("INVALID_PARAMS", "declick must be a boolean");
  const sampleCount = Math.round(durationSec * SAMPLE_RATE);
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) fail("INVALID_PARAMS", "source range is shorter than one output sample or too long to represent");
  return sampleCount;
}

function formatSeconds(seconds: number): string {
  return seconds.toFixed(9).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

/** Strictly validate a reuse candidate's recorded measurement; null → recompute. */
function reusableMeasurement(value: unknown): NormalizeAudioMeasurement | null {
  if (typeof value !== "object" || value === null) return null;
  const measurement = value as Record<string, unknown>;
  const finite = ["integratedLufs", "truePeakDbtp", "loudnessRangeLu", "thresholdLufs"].every(
    (key) => typeof measurement[key] === "number" && Number.isFinite(measurement[key]),
  );
  return finite ? value as NormalizeAudioMeasurement : null;
}

function ffmpegMessage(error: unknown): string {
  if (error instanceof FfmpegToolError && /cancel/i.test(error.message)) return "Cancelled";
  return error instanceof Error ? error.message : String(error);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail("JOB_FAILED", "Cancelled");
}

function readFloat32Buffer(buffer: Buffer): Float32Array {
  const samples = new Float32Array(buffer.length / 4);
  for (let index = 0; index < samples.length; index++) {
    const value = buffer.readFloatLE(index * 4);
    if (!Number.isFinite(value)) throw new Error("Nonfinite audio sample");
    samples[index] = value;
  }
  return samples;
}

/** Deterministic white noise probe: no periodicity, so the peak is unambiguous. */
function probeNoise(length: number, seed = 0x5eed1234): Float32Array {
  let state = seed >>> 0;
  const out = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[index] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  return out;
}

/**
 * Cross-correlation delay of `processed` relative to `source` (positive = the
 * processed signal is later). Plain correlation, not PHAT: the delay probe is
 * broadband noise and we want the actual peak shape, not a whitened one.
 */
export function crossCorrelationDelay(
  processed: Float32Array,
  source: Float32Array,
  sampleRate: number,
  maxDelaySec = MAX_DELAY_SECONDS,
): { lagSamples: number; prominenceDb: number } {
  const length = Math.min(processed.length, source.length);
  if (length < 2) throw new Error("delay probe produced fewer than two samples");
  const maxLag = Math.min(Math.round(maxDelaySec * sampleRate), length - 1);
  let fftSize = 1;
  while (fftSize < Math.max(processed.length, source.length) + maxLag + 1) fftSize *= 2;
  const fft = new FFT(fftSize);
  const processedInput = new Float32Array(fftSize);
  processedInput.set(processed);
  const sourceInput = new Float32Array(fftSize);
  sourceInput.set(source);
  const processedSpectrum = fft.forward(processedInput);
  const sourceSpectrum = fft.forward(sourceInput);
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);
  for (let index = 0; index < fftSize; index++) {
    const aReal = processedSpectrum.real[index]!;
    const aImag = processedSpectrum.imag[index]!;
    const bReal = sourceSpectrum.real[index]!;
    const bImag = sourceSpectrum.imag[index]!;
    real[index] = aReal * bReal + aImag * bImag;
    imag[index] = aImag * bReal - aReal * bImag;
  }
  const correlation = fft.inverse(real, imag);
  const values: number[] = [];
  let peakLag = 0;
  let peak = -1;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const value = Math.abs(lag >= 0 ? correlation[lag] ?? 0 : correlation[fftSize + lag] ?? 0);
    values.push(value);
    if (value > peak) { peak = value; peakLag = lag; }
  }
  const sorted = [...values].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return {
    lagSamples: peakLag,
    prominenceDb: Math.round(20 * Math.log10((peak + 1e-12) / (median + 1e-12)) * 10) / 10,
  };
}

/**
 * Measure the exact filter chain's delay against a white-noise probe. Throws
 * when the peak is not confidently above the correlation floor: publishing an
 * unverified delay would silently shift audio against picture.
 */
async function measureFilterDelay(
  ffmpeg: string,
  filters: readonly string[],
  signal?: AbortSignal,
): Promise<{ samples: number; prominenceDb: number }> {
  throwIfCancelled(signal);
  const directory = await mkdtemp(join(tmpdir(), "rt-denoise-delay-"));
  const probePath = join(directory, "probe.f32");
  const source = probeNoise(Math.round(DELAY_PROBE_SECONDS * SAMPLE_RATE));
  const buffer = Buffer.alloc(source.length * 4);
  for (let index = 0; index < source.length; index++) buffer.writeFloatLE(source[index]!, index * 4);
  try {
    await writeFile(probePath, buffer, { flag: "wx" });
    let output: Buffer;
    try {
      const result = await runToolProcess(ffmpeg, [
        "-hide_banner", "-nostdin", "-v", "error",
        "-f", "f32le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", probePath,
        "-af", filters.join(","), "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "f32le", "pipe:1",
      ], { signal });
      output = result.stdout;
    } catch (error) {
      if (signal?.aborted) fail("JOB_FAILED", "Cancelled");
      fail("JOB_FAILED", `delay probe failed: ${ffmpegMessage(error)}`);
    }
    const measured = crossCorrelationDelay(readFloat32Buffer(output), source, SAMPLE_RATE);
    if (measured.lagSamples < 0 || measured.prominenceDb < 6) {
      fail("JOB_FAILED", `could not measure the denoise filter delay reliably (lag ${measured.lagSamples}, prominence ${measured.prominenceDb.toFixed(1)} dB); refusing to publish an unaligned asset`);
    }
    return { samples: measured.lagSamples, prominenceDb: measured.prominenceDb };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function measureInputLoudness(
  ffmpeg: string,
  sourcePath: string,
  streamIndex: number,
  params: DenoiseAudioParams,
  timestampOriginSec: number,
  signal?: AbortSignal,
): Promise<NormalizeAudioMeasurement> {
  const layout = params.channels === 1 ? "mono" : "stereo";
  const filter = [
    `atrim=start=${formatSeconds(timestampOriginSec + params.startSec)}:end=${formatSeconds(timestampOriginSec + params.endSec)}`,
    "asetpts=PTS-STARTPTS",
    `aresample=${SAMPLE_RATE}:async=0:first_pts=0`,
    `aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=${layout}`,
    "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
  ].join(",");
  try {
    const result = await runToolProcess(ffmpeg, [
      "-hide_banner", "-nostdin", "-nostats", "-v", "info", "-copyts", "-i", sourcePath,
      "-map", `0:${streamIndex}`, "-vn", "-af", filter, "-f", "null", "-",
    ], { signal });
    return parseLoudnorm(result.stderr).measurement;
  } catch (error) {
    if (signal?.aborted) fail("JOB_FAILED", "Cancelled");
    if (error instanceof FacadeError) throw error;
    fail("JOB_FAILED", `input loudness measurement failed: ${ffmpegMessage(error)}`);
  }
}

async function measureOutputLoudness(ffmpeg: string, wavPath: string, signal?: AbortSignal): Promise<NormalizeAudioMeasurement> {
  try {
    const result = await runToolProcess(ffmpeg, [
      "-hide_banner", "-nostdin", "-nostats", "-v", "info", "-i", wavPath,
      "-map", "0:a:0", "-vn", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-",
    ], { signal });
    return parseLoudnorm(result.stderr).measurement;
  } catch (error) {
    if (signal?.aborted) fail("JOB_FAILED", "Cancelled");
    if (error instanceof FacadeError) throw error;
    fail("JOB_FAILED", `output loudness measurement failed: ${ffmpegMessage(error)}`);
  }
}

async function verifyPublishedSamples(ffprobe: string, wavPath: string, expected: number, channels: 1 | 2, signal?: AbortSignal): Promise<void> {
  let parsed: { streams?: Array<{ codec_type?: string; sample_rate?: string; channels?: number; duration_ts?: string; time_base?: string }> };
  try {
    const { stdout } = await runToolProcess(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_streams", "-of", "json", wavPath], { signal });
    parsed = JSON.parse(stdout.toString("utf8")) as typeof parsed;
  } catch (error) {
    if (signal?.aborted) fail("JOB_FAILED", "Cancelled");
    fail("JOB_FAILED", `could not verify output WAV: ${ffmpegMessage(error)}`);
  }
  const stream = parsed.streams?.[0];
  if (!stream || stream.codec_type !== "audio") fail("JOB_FAILED", "denoised WAV has no audio stream");
  const rate = Number(stream.sample_rate);
  const ticks = Number(stream.duration_ts);
  const match = /^(\d+)\/(\d+)$/.exec(stream.time_base ?? "");
  const actual = match && Number.isSafeInteger(ticks)
    ? (ticks * Number(match[1]) * rate) / Number(match[2])
    : Number.NaN;
  if (rate !== SAMPLE_RATE || Number(stream.channels) !== channels || actual !== expected) {
    fail("JOB_FAILED", `denoised WAV sample count/rate did not match the requested window (got ${actual} samples at ${rate} Hz; expected ${expected} at ${SAMPLE_RATE} Hz)`);
  }
}

/** Decode a bounded mono slice at 48 kHz for the post-publication alignment check. */
async function decodeMonoSlice(ffmpeg: string, path: string, streamIndex: number, startSec: number, durationSec: number, signal?: AbortSignal): Promise<Float32Array> {
  const { stdout } = await runToolProcess(ffmpeg, [
    "-hide_banner", "-nostdin", "-v", "error", "-ss", String(startSec), "-t", String(durationSec), "-i", path,
    "-map", `0:${streamIndex}`, "-vn", "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "f32le", "pipe:1",
  ], { signal });
  return readFloat32Buffer(stdout);
}

async function writeDenoisedWav(
  ffmpeg: string,
  sourcePath: string,
  streamIndex: number,
  outputPath: string,
  params: DenoiseAudioParams,
  sampleCount: number,
  timestampOriginSec: number,
  delaySamples: number,
  filters: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const layout = params.channels === 1 ? "mono" : "stereo";
  const delaySec = delaySamples / SAMPLE_RATE;
  // Decode the range plus the chain's fixed delay so trimming the delay still
  // leaves the full requested tail; when the source ends at the range end the
  // missing tail is zero-padded and disclosed by exact sample-count checks.
  const filter = [
    `atrim=start=${formatSeconds(timestampOriginSec + params.startSec)}:end=${formatSeconds(timestampOriginSec + params.endSec + delaySec)}`,
    "asetpts=PTS-STARTPTS",
    `aresample=${SAMPLE_RATE}:async=0:first_pts=0`,
    `aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=${layout}`,
    ...filters,
    `atrim=start_sample=${delaySamples}`,
    "asetpts=PTS-STARTPTS",
    `apad=whole_len=${sampleCount}`,
    `atrim=end_sample=${sampleCount}`,
    "asetpts=PTS-STARTPTS",
  ].join(",");
  try {
    await runToolProcess(ffmpeg, [
      "-hide_banner", "-nostdin", "-nostats", "-v", "error", "-copyts", "-i", sourcePath,
      "-map", `0:${streamIndex}`, "-vn", "-af", filter,
      "-ar", String(SAMPLE_RATE), "-ac", String(params.channels), "-c:a", "pcm_s24le",
      "-f", "wav", "-y", outputPath,
    ], { signal });
  } catch (error) {
    if (signal?.aborted) fail("JOB_FAILED", "Cancelled");
    fail("JOB_FAILED", `denoise pass failed: ${ffmpegMessage(error)}`);
  }
}

async function inspectPublishedDirectory(
  outputDir: string,
  mediaRoot: string,
  expectedWavSha256: string,
  expectedProvenanceSha256: string,
): Promise<{ wavPath: string; provenancePath: string }> {
  const info = await lstat(outputDir).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) fail("CONFLICT", "artifactId is already occupied by a non-directory path");
  await prepareArtifactDir(outputDir, mediaRoot, VERB);
  const wavPath = await assertContainedWrittenFile(join(outputDir, "denoised.wav"), mediaRoot, VERB);
  const provenancePath = await assertContainedWrittenFile(join(outputDir, "provenance.json"), mediaRoot, VERB);
  const [wavHash, provenanceHash] = await Promise.all([sha256File(wavPath), sha256File(provenancePath)]);
  if (wavHash !== expectedWavSha256 || provenanceHash !== expectedProvenanceSha256) {
    fail("CONFLICT", "artifactId already names a different denoised result; choose a new artifactId");
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
  for (const filename of ["denoised.wav", "provenance.json"]) {
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
export async function discardDenoisedAudioArtifact(artifact: DenoiseAudioArtifact, mediaRoots: readonly string[]): Promise<void> {
  await cleanupOwnedDirectory(dirname(artifact.path), resolvePath(mediaRoots[0]!));
}

/**
 * Produce one denoised WAV plus its provenance JSON under the first media
 * root. Publication is staging-directory based and idempotent by artifactId;
 * the output is sample-aligned and remeasured before it is published.
 */
export async function produceDenoisedAudio(input: ProduceDenoisedAudioParams): Promise<DenoiseAudioArtifact> {
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
  const { durationSec, streamIndex, timestampOriginSec } = await probeAudioStreams(binaries.ffprobe, sourcePath, input.params.audioStream, input.signal);
  if (input.params.endSec > durationSec + 1 / SAMPLE_RATE) {
    fail("INVALID_PARAMS", `source range ends after the selected audio stream (${durationSec.toFixed(3)} seconds)`);
  }
  const sourceFingerprint = await fingerprintFile(sourcePath);
  if (sourceFingerprint.sha256 === null) fail("NOT_FOUND", "source could not be fingerprinted");

  const chain = resolveDenoiseProfile(input.params.profile, input.params.declick === true);
  const ffmpegVersion = await resolveFfmpegVersion();
  const algorithmVersion = `denoise@${AUDIO_DENOISE_CHAIN_VERSION}+${ffmpegVersion}`;
  const cacheKey = computeAudioReuseKey({
    verb: VERB,
    sourceSha256: sourceFingerprint.sha256,
    audioStream: input.params.audioStream,
    startSec: formatSeconds(input.params.startSec),
    endSec: formatSeconds(input.params.endSec),
    sampleRate: input.params.sampleRate,
    channels: input.params.channels,
    profile: input.params.profile,
    declick: input.params.declick === true,
    algorithm: algorithmVersion,
  });
  throwIfCancelled(input.signal);

  const root = resolvePath(input.mediaRoots[0]!);
  const outputParent = join(root, "generated-assets", "audio-denoise");
  const outputDir = join(outputParent, input.artifactId);
  const stagingDir = join(outputParent, `.${input.artifactId}.${process.pid}.${randomUUID()}.pending`);
  const stagedWavPath = join(stagingDir, "denoised.wav");
  const stagedProvenancePath = join(stagingDir, "provenance.json");
  let publishedByThisAttempt = false;

  let before: NormalizeAudioMeasurement | null = null;
  let after: NormalizeAudioMeasurement | null = null;
  let processing: DenoiseAudioArtifact["processing"] | null = null;
  let reusedFrom: { cacheKey: string; artifactId: string } | null = null;

  try {
    await prepareArtifactDir(stagingDir, root, VERB);
    // AUD-13 content-addressed reuse (validated prior result, byte-identical);
    // a same-artifactId retry keeps compute-then-compare semantics.
    const outputDirExists = (await lstat(outputDir).catch(() => null)) !== null;
    const reuseHit = outputDirExists ? null : await findReusableAudioArtifact({
      root, kind: "audio-denoise", cacheKey, algorithmVersion, wavFilename: "denoised.wav",
    });
    if (reuseHit !== null && typeof reuseHit.provenance.processing === "object" && reuseHit.provenance.processing !== null) {
      const reusableBefore = reusableMeasurement(reuseHit.provenance.before);
      const reusableAfter = reusableMeasurement(reuseHit.provenance.after);
      if (reuseHit.provenance.sourceSha256 === sourceFingerprint.sha256 && reusableBefore !== null && reusableAfter !== null) {
        await stageReusableAudioWav(reuseHit, stagedWavPath);
        before = reusableBefore;
        after = reusableAfter;
        processing = reuseHit.provenance.processing as DenoiseAudioArtifact["processing"];
        reusedFrom = { cacheKey, artifactId: reuseHit.artifactId };
      }
    }
    if (reusedFrom === null) {
      const delay = await measureFilterDelay(binaries.ffmpeg, chain.filters, input.signal);
      throwIfCancelled(input.signal);
      before = await measureInputLoudness(binaries.ffmpeg, sourcePath, streamIndex, input.params, timestampOriginSec, input.signal);
      throwIfCancelled(input.signal);
      await writeDenoisedWav(binaries.ffmpeg, sourcePath, streamIndex, stagedWavPath, input.params, sampleCount, timestampOriginSec, delay.samples, chain.filters, input.signal);
      const verifiedFreshWav = await assertContainedWrittenFile(stagedWavPath, root, VERB);
      await verifyPublishedSamples(binaries.ffprobe, verifiedFreshWav, sampleCount, input.params.channels, input.signal);
      // Prove the compensation on the actual published signal, not just the
      // synthetic probe: a nonzero measured lag would be detectable drift.
      const checkSeconds = Math.min(ALIGNMENT_CHECK_SECONDS, sampleCount / SAMPLE_RATE);
      let alignmentLag: number | null = null;
      let alignmentProminence: number | null = null;
      let alignmentVerdict: "aligned" | "unverified" = "unverified";
      let alignmentNote: string | null = null;
      try {
        const [sourceSlice, outputSlice] = await Promise.all([
          decodeMonoSlice(binaries.ffmpeg, sourcePath, streamIndex, input.params.startSec, checkSeconds, input.signal),
          decodeMonoSlice(binaries.ffmpeg, verifiedFreshWav, 0, 0, checkSeconds, input.signal),
        ]);
        const measured = crossCorrelationDelay(outputSlice, sourceSlice, SAMPLE_RATE, 0.2);
        alignmentLag = measured.lagSamples;
        alignmentProminence = measured.prominenceDb;
        if (measured.lagSamples !== 0 && measured.prominenceDb >= 6) {
          throw new FacadeError("JOB_FAILED", `${VERB}: published output is shifted by ${measured.lagSamples} samples against the source after delay compensation; no asset was published`, { lagSamples: measured.lagSamples, prominenceDb: measured.prominenceDb });
        }
        alignmentVerdict = measured.prominenceDb >= 6 ? "aligned" : "unverified";
        if (alignmentVerdict === "unverified") alignmentNote = `correlation prominence ${measured.prominenceDb.toFixed(1)} dB is too low to prove alignment on this material; the measured ${delay.samples}-sample filter delay was still compensated`;
      } catch (error) {
        if (error instanceof FacadeError) throw error;
        alignmentNote = `alignment check could not run: ${ffmpegMessage(error)}`;
      }
      after = await measureOutputLoudness(binaries.ffmpeg, verifiedFreshWav, input.signal);
      processing = {
        profile: input.params.profile,
        declick: input.params.declick === true,
        filterChain: chain.filters,
        measuredFilterDelaySamples: delay.samples,
        measuredFilterDelaySec: delay.samples / SAMPLE_RATE,
        measuredDelayProminenceDb: delay.prominenceDb,
        alignmentCheck: {
          checkedSec: checkSeconds,
          lagSamples: alignmentLag,
          prominenceDb: alignmentProminence,
          verdict: alignmentVerdict,
          note: alignmentNote,
        },
      };
    }
    if (before === null || after === null || processing === null) {
      fail("JOB_FAILED", "internal: denoise facts were not established");
    }
    const verifiedStagedWav = await assertContainedWrittenFile(stagedWavPath, root, VERB);
    await verifyPublishedSamples(binaries.ffprobe, verifiedStagedWav, sampleCount, input.params.channels, input.signal);
    throwIfCancelled(input.signal);
    const currentFingerprint = await fingerprintFile(sourcePath);
    if (currentFingerprint.sha256 !== sourceFingerprint.sha256) {
      fail("CONFLICT", "source media changed while denoising was running; retry against its current version");
    }
    const wavStat = await stat(verifiedStagedWav);
    if (!wavStat.isFile() || wavStat.size === 0) fail("JOB_FAILED", "denoised WAV is missing or empty");
    const sha256 = await sha256File(verifiedStagedWav);
    const artifact: DenoiseAudioArtifact = {
      path: join(outputDir, "denoised.wav"),
      provenancePath: join(outputDir, "provenance.json"),
      source: {
        mediaId: input.params.mediaId,
        path: sourcePath,
        audioStream: input.params.audioStream,
        startSec: input.params.startSec,
        endSec: input.params.endSec,
        projectId: input.sourceProjectId,
        ...(input.sourceWorkspaceId !== undefined ? { workspaceId: input.sourceWorkspaceId } : {}),
        revision: input.sourceRevision,
      },
      parameters: {
        mediaId: input.params.mediaId,
        audioStream: input.params.audioStream,
        startSec: input.params.startSec,
        endSec: input.params.endSec,
        sampleRate: SAMPLE_RATE as 48_000,
        channels: input.params.channels,
        profile: input.params.profile,
        declick: input.params.declick === true,
      },
      before,
      after,
      timing: {
        sampleRate: SAMPLE_RATE as 48_000,
        channels: input.params.channels,
        sampleCount,
        durationSec: sampleCount / SAMPLE_RATE,
        outputStartSec: 0 as const,
        processingDelaySamples: 0 as const,
      },
      processing,
      bytes: wavStat.size,
      sha256,
    };
    const provenance = {
      schemaVersion: 2,
      ...artifact,
      sourceSha256: sourceFingerprint.sha256,
      sourceTimestampOriginSec: timestampOriginSec,
      chainLabel: chain.label,
      algorithmVersion,
      ...(reusedFrom !== null ? { reusedFrom } : {}),
      method: `${reusedFrom !== null
        ? "Byte-identical reuse of a validated prior artifact (content-addressed cache hit; the denoise chain, delay measurement and alignment check were not re-run — the recorded facts describe exactly these bytes)."
        : "FFmpeg afftdn tier (+ optional adeclick); exact 48 kHz sample window; measured chain delay trimmed and tail padded; output sample count verified; published output cross-correlated against the source; PCM s24le WAV; final loudness measured on the written WAV"}`,
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
          wavPath: await assertContainedWrittenFile(join(outputDir, "denoised.wav"), root, VERB),
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
    // AUD-13: name this published artifact as the reusable result. Best-effort.
    await recordReusableAudioArtifact({
      root, kind: "audio-denoise", cacheKey, artifactId: input.artifactId,
      wavFilename: "denoised.wav", wavSha256: sha256, algorithmVersion,
    }).catch(() => {});
    return { ...artifact, path: published.wavPath, provenancePath: published.provenancePath };
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
