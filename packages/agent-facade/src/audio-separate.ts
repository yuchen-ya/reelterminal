/**
 * Demucs htdemucs source separation (AUD-09) — `audio.process.separate`.
 *
 * The optional Python worker separates a 44.1 kHz stereo decode into the four
 * htdemucs stems; this producer keeps either the vocal stem or the sum of the
 * three accompaniment stems, resamples it to the requested 48 kHz window and
 * publishes one sample-aligned WAV plus provenance. Publication is staging
 * based and idempotent; cancellation/failure removes every owned file.
 *
 * The model is not bundled: a missing pinned weight file fails before any
 * work unless `allowModelDownload:true` is supplied, and capabilities disclose
 * the download size. The runtime and package versions are reported by the
 * worker; this module keeps its measured timing and memory in provenance.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";

import { FacadeError } from "./errors";
import { assertContainedWrittenFile, prepareArtifactDir, sha256File } from "./artifact-io";
import { fingerprintFile } from "./inspection-artifacts";
import { FfmpegToolError, resolveFfmpegVersion, resolveToolFfmpeg, runToolProcess } from "./media/ffmpeg-bin";
import { resolveContainedPathDetailed } from "./media/path-roots";
import { parseLoudnorm, probeAudioStreams, type NormalizeAudioMeasurement } from "./audio-normalize";
import { computeAudioReuseKey, findReusableAudioArtifact, recordReusableAudioArtifact, stageReusableAudioWav } from "./audio-artifact-reuse";
import type { ArtifactFileTracker } from "./providers";
import { DEMUCS_MODEL, demucsCacheDir, demucsModelStatus, runAudioModelTask } from "./media/audio-models-runner";

interface SeparateWorkerResult {
  readonly stems: ReadonlyArray<{ readonly stem: string; readonly path: string }>;
  readonly device: string;
  readonly loadSeconds: number;
  readonly inferenceSeconds: number;
  readonly realtimeFactor: number;
  readonly peakGpuMemoryMb: number | null;
  readonly peakRssMb: number | null;
}

type SeparateWorker = (request: Record<string, unknown>) => Promise<SeparateWorkerResult>;
let separateWorkerOverride: SeparateWorker | null = null;
let demucsReadyOverride: (() => Promise<{ verified: boolean; present: boolean; reason: string | null }>) | null = null;

/** Hermetic test seam for the optional Demucs worker. */
export function setSeparationWorkerForTests(worker: SeparateWorker | null): void {
  separateWorkerOverride = worker;
}

/** Hermetic test seam for the pinned-weight gate. */
export function setDemucsModelReadyForTests(fn: (() => Promise<{ verified: boolean; present: boolean; reason: string | null }>) | null): void {
  demucsReadyOverride = fn;
}
export const AUDIO_SEPARATE_MAX_RANGE_SEC = 120;
/** Bump when the separation decode/render chain changes — it invalidates reuse keys. */
export const AUDIO_SEPARATE_CHAIN_VERSION = 1;
const SAMPLE_RATE = 48_000;
const DEMUCS_RATE = 44_100;
const VERB = "audio.process.separate";

export type SeparationTarget = "vocals" | "instrumental";

export interface SeparateAudioParams {
  readonly mediaId: string;
  readonly audioStream: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly sampleRate: 48_000;
  readonly channels: 1 | 2;
  readonly target: SeparationTarget;
  readonly allowModelDownload?: boolean;
}

export interface SeparatedAudioArtifact {
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
  readonly parameters: SeparateAudioParams;
  readonly target: SeparationTarget;
  readonly before: NormalizeAudioMeasurement;
  /** Null when the target stem is too quiet/silent to measure (valid for non-vocal material). */
  readonly after: NormalizeAudioMeasurement | null;
  readonly timing: {
    readonly sampleRate: 48_000;
    readonly channels: 1 | 2;
    readonly sampleCount: number;
    readonly durationSec: number;
    readonly outputStartSec: 0;
    readonly processingDelaySamples: 0;
  };
  readonly processing: {
    readonly model: "htdemucs";
    readonly modelRepo: string;
    readonly modelSha256: string;
    readonly modelBytes: number;
    readonly modelLicense: string;
    readonly device: string;
    readonly loadSeconds: number;
    readonly inferenceSeconds: number;
    readonly realtimeFactor: number;
    readonly peakGpuMemoryMb: number | null;
    readonly peakRssMb: number | null;
    readonly stems: readonly string[];
    readonly targetMix: string;
  };
  readonly bytes: number;
  readonly sha256: string;
}

export interface ProduceSeparatedAudioParams {
  readonly sourcePath: string;
  readonly mediaRoots: readonly string[];
  readonly params: SeparateAudioParams;
  readonly sourceProjectId: string;
  readonly sourceWorkspaceId?: string;
  readonly sourceRevision: number;
  readonly signal?: AbortSignal;
  readonly artifactId: string;
  readonly artifactFileTracker?: ArtifactFileTracker;
}

function fail(code: "INVALID_PARAMS" | "NOT_FOUND" | "JOB_FAILED" | "UNSUPPORTED" | "CONFLICT", message: string): never {
  throw new FacadeError(code, `${VERB}: ${message}`);
}

function validateParams(params: SeparateAudioParams): number {
  if (!params || typeof params !== "object") fail("INVALID_PARAMS", "params are required");
  if (typeof params.mediaId !== "string" || params.mediaId.length === 0) fail("INVALID_PARAMS", "mediaId must be a non-empty string");
  if (!Number.isInteger(params.audioStream) || params.audioStream < 0) fail("INVALID_PARAMS", "audioStream must be a zero-based non-negative integer");
  if (!(Number.isFinite(params.startSec) && Number.isFinite(params.endSec) && params.startSec >= 0 && params.endSec > params.startSec)) {
    fail("INVALID_PARAMS", "source range must have finite seconds with 0 ≤ startSec < endSec");
  }
  const durationSec = params.endSec - params.startSec;
  if (durationSec > AUDIO_SEPARATE_MAX_RANGE_SEC) fail("INVALID_PARAMS", `source range may not exceed ${AUDIO_SEPARATE_MAX_RANGE_SEC} seconds`);
  if (params.sampleRate !== SAMPLE_RATE) fail("INVALID_PARAMS", `sampleRate must be ${SAMPLE_RATE} Hz`);
  if (params.channels !== 1 && params.channels !== 2) fail("INVALID_PARAMS", "channels must be 1 or 2");
  if (params.target !== "vocals" && params.target !== "instrumental") fail("INVALID_PARAMS", "target must be vocals or instrumental");
  if (params.allowModelDownload !== undefined && typeof params.allowModelDownload !== "boolean") fail("INVALID_PARAMS", "allowModelDownload must be a boolean");
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

async function decodeStereo44k(ffmpeg: string, sourcePath: string, params: SeparateAudioParams, outputPath: string, signal?: AbortSignal): Promise<void> {
  try {
    await runToolProcess(ffmpeg, [
      "-hide_banner", "-nostdin", "-v", "error",
      "-ss", String(params.startSec), "-t", String(params.endSec - params.startSec), "-i", sourcePath,
      "-map", `0:${params.audioStream}`, "-vn", "-ar", String(DEMUCS_RATE), "-ac", "2",
      "-c:a", "pcm_f32le", "-y", outputPath,
    ], { signal });
  } catch (error) {
    if (signal?.aborted) fail("JOB_FAILED", "Cancelled");
    fail("JOB_FAILED", `source decode failed: ${ffmpegMessage(error)}`);
  }
}

async function measureLoudnessOrNull(ffmpeg: string, path: string, signal?: AbortSignal): Promise<NormalizeAudioMeasurement | null> {
  try {
    const result = await runToolProcess(ffmpeg, [
      "-hide_banner", "-nostdin", "-nostats", "-v", "info", "-i", path,
      "-map", "0:a:0", "-vn", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-",
    ], { signal });
    return parseLoudnorm(result.stderr).measurement;
  } catch (error) {
    if (signal?.aborted) fail("JOB_FAILED", "Cancelled");
    if (error instanceof Error && /could not measure/.test(error.message)) return null;
    fail("JOB_FAILED", `output loudness measurement failed: ${ffmpegMessage(error)}`);
  }
}

async function measureInputLoudness(ffmpeg: string, sourcePath: string, streamIndex: number, params: SeparateAudioParams, timestampOriginSec: number, signal?: AbortSignal): Promise<NormalizeAudioMeasurement> {
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
  if (!stream || stream.codec_type !== "audio") fail("JOB_FAILED", "separated WAV has no audio stream");
  const rate = Number(stream.sample_rate);
  const ticks = Number(stream.duration_ts);
  const match = /^(\d+)\/(\d+)$/.exec(stream.time_base ?? "");
  const actual = match && Number.isSafeInteger(ticks) ? (ticks * Number(match[1]) * rate) / Number(match[2]) : Number.NaN;
  if (rate !== SAMPLE_RATE || Number(stream.channels) !== channels || actual !== expected) {
    fail("JOB_FAILED", `separated WAV sample count/rate did not match the requested window (got ${actual} samples at ${rate} Hz; expected ${expected} at ${SAMPLE_RATE} Hz)`);
  }
}

async function renderTarget(
  ffmpeg: string,
  stemPaths: Readonly<Record<string, string>>,
  params: SeparateAudioParams,
  sampleCount: number,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const layout = params.channels === 1 ? "mono" : "stereo";
  const tail = `aresample=${SAMPLE_RATE}:async=0:first_pts=0,aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=${layout},apad=whole_len=${sampleCount},atrim=end_sample=${sampleCount},asetpts=PTS-STARTPTS`;
  try {
    if (params.target === "vocals") {
      await runToolProcess(ffmpeg, [
        "-hide_banner", "-nostdin", "-nostats", "-v", "error", "-i", stemPaths.vocals!,
        "-af", tail, "-ar", String(SAMPLE_RATE), "-ac", String(params.channels), "-c:a", "pcm_s24le", "-y", outputPath,
      ], { signal });
      return;
    }
    await runToolProcess(ffmpeg, [
      "-hide_banner", "-nostdin", "-nostats", "-v", "error",
      "-i", stemPaths.drums!, "-i", stemPaths.bass!, "-i", stemPaths.other!,
      "-filter_complex", `[0:a][1:a][2:a]amix=inputs=3:normalize=0,${tail}`,
      "-ar", String(SAMPLE_RATE), "-ac", String(params.channels), "-c:a", "pcm_s24le", "-y", outputPath,
    ], { signal });
  } catch (error) {
    if (signal?.aborted) fail("JOB_FAILED", "Cancelled");
    fail("JOB_FAILED", `target render failed: ${ffmpegMessage(error)}`);
  }
}

async function inspectPublishedDirectory(outputDir: string, mediaRoot: string, expectedWavSha256: string, expectedProvenanceSha256: string): Promise<{ wavPath: string; provenancePath: string }> {
  const info = await lstat(outputDir).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) fail("CONFLICT", "artifactId is already occupied by a non-directory path");
  await prepareArtifactDir(outputDir, mediaRoot, VERB);
  const wavPath = await assertContainedWrittenFile(join(outputDir, "separated.wav"), mediaRoot, VERB);
  const provenancePath = await assertContainedWrittenFile(join(outputDir, "provenance.json"), mediaRoot, VERB);
  const [wavHash, provenanceHash] = await Promise.all([sha256File(wavPath), sha256File(provenancePath)]);
  if (wavHash !== expectedWavSha256 || provenanceHash !== expectedProvenanceSha256) {
    fail("CONFLICT", "artifactId already names a different separated result; choose a new artifactId");
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
  for (const filename of ["separated.wav", "provenance.json"]) {
    const filePath = join(directory, filename);
    const fileInfo = await lstat(filePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!fileInfo) continue;
    if (fileInfo.isDirectory()) { failures.push(`${filename}: refusing to remove an unexpected directory`); continue; }
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
    try { await rmdir(directory); } catch (error) { failures.push(`directory: ${ffmpegMessage(error)}`); }
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
}

export async function discardSeparatedAudioArtifact(artifact: SeparatedAudioArtifact, mediaRoots: readonly string[]): Promise<void> {
  await cleanupOwnedDirectory(dirname(artifact.path), resolvePath(mediaRoots[0]!));
}

/** Session-start weight gate: pinned local Demucs file or explicit download consent. */
export async function assertDemucsModelReady(params: SeparateAudioParams): Promise<void> {
  const status = demucsReadyOverride ? await demucsReadyOverride() : await demucsModelStatus();
  if (status.verified) return;
  if (status.present) fail("UNSUPPORTED", status.reason ?? "Demucs weights do not match the pinned file");
  if (params.allowModelDownload !== true) {
    throw new FacadeError("UNSUPPORTED", status.reason ?? "Demucs weights are missing", { downloadBytes: DEMUCS_MODEL.bytes, estimatedDiskBytes: 120_000_000, allowModelDownload: true });
  }
}

export async function produceSeparatedAudio(input: ProduceSeparatedAudioParams): Promise<SeparatedAudioArtifact> {
  const sampleCount = validateParams(input.params);
  throwIfCancelled(input.signal);
  if (!Array.isArray(input.mediaRoots) || input.mediaRoots.length === 0) fail("UNSUPPORTED", "no media roots configured for persistent generated audio");
  if (typeof input.artifactId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.artifactId)) fail("INVALID_PARAMS", "artifactId must contain only letters, numbers, underscore or hyphen (1–128 characters)");
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
  if (input.params.endSec > durationSec + 1 / SAMPLE_RATE) fail("INVALID_PARAMS", `source range ends after the selected audio stream (${durationSec.toFixed(3)} seconds)`);
  const sourceFingerprint = await fingerprintFile(sourcePath);
  if (sourceFingerprint.sha256 === null) fail("NOT_FOUND", "source could not be fingerprinted");
  const modelStatus = demucsReadyOverride ? await demucsReadyOverride() : await demucsModelStatus();
  if (!modelStatus.verified) {
    if (modelStatus.present) fail("UNSUPPORTED", modelStatus.reason ?? "Demucs weights do not match the pinned file");
    if (input.params.allowModelDownload !== true) {
      throw new FacadeError("UNSUPPORTED", modelStatus.reason ?? "Demucs weights are missing", { downloadBytes: DEMUCS_MODEL.bytes, estimatedDiskBytes: 120_000_000, allowModelDownload: true });
    }
  }
  const before = await measureInputLoudness(binaries.ffmpeg, sourcePath, streamIndex, input.params, timestampOriginSec, input.signal);
  throwIfCancelled(input.signal);
  const ffmpegVersion = await resolveFfmpegVersion();
  // The model sha IS the algorithm version for separation; the ffmpeg decode
  // and target render still pin the runtime version alongside it.
  const algorithmVersion = `separate@${AUDIO_SEPARATE_CHAIN_VERSION}+${DEMUCS_MODEL.sha256.slice(0, 16)}+${ffmpegVersion}`;
  const cacheKey = computeAudioReuseKey({
    verb: VERB,
    sourceSha256: sourceFingerprint.sha256,
    audioStream: input.params.audioStream,
    startSec: formatSeconds(input.params.startSec),
    endSec: formatSeconds(input.params.endSec),
    sampleRate: input.params.sampleRate,
    channels: input.params.channels,
    target: input.params.target,
    algorithm: algorithmVersion,
  });
  const workDir = await mkdtemp(join(tmpdir(), "rt-separate-"));
  const root = resolvePath(input.mediaRoots[0]!);
  const outputParent = join(root, "generated-assets", "audio-separate");
  const outputDir = join(outputParent, input.artifactId);
  const stagingDir = join(outputParent, `.${input.artifactId}.${process.pid}.${randomUUID()}.pending`);
  const stagedWavPath = join(stagingDir, "separated.wav");
  const stagedProvenancePath = join(stagingDir, "provenance.json");
  let publishedByThisAttempt = false;

  for (const file of [
    { fileId: "audio-output", path: join(outputDir, "separated.wav"), purpose: "Separated audio work output" },
    { fileId: "audio-output-provenance", path: join(outputDir, "provenance.json"), purpose: "Separated audio provenance" },
    { fileId: "audio-staged-output", path: stagedWavPath, purpose: "Temporary separated audio work" },
    { fileId: "audio-staged-provenance", path: stagedProvenancePath, purpose: "Temporary separation provenance" },
    { fileId: "audio-separate-source-decode", path: join(workDir, "source-44k.wav"), purpose: "Temporary separation source decode" },
    ...["drums", "bass", "other", "vocals"].map((stem) => ({
      fileId: `audio-separate-stem-${stem}`,
      path: join(workDir, "stems", `${stem}.wav`),
      purpose: `Temporary separation ${stem} stem`,
    })),
  ]) input.artifactFileTracker?.record({ ...file, kind: "work", rebuildable: true, deliveryStatus: "pending" });
  let after: NormalizeAudioMeasurement | null = null;
  let processing: SeparatedAudioArtifact["processing"] | null = null;
  let reusedFrom: { cacheKey: string; artifactId: string } | null = null;
  try {
    await prepareArtifactDir(stagingDir, root, VERB);
    // AUD-13 content-addressed reuse: skipping the model inference entirely
    // is the point here — a validated byte-identical prior separation is
    // copied, with its recorded device/timing facts describing these bytes.
    // A same-artifactId retry keeps compute-then-compare semantics.
    const outputDirExists = (await lstat(outputDir).catch(() => null)) !== null;
    const reuseHit = outputDirExists ? null : await findReusableAudioArtifact({
      root, kind: "audio-separate", cacheKey, algorithmVersion, wavFilename: "separated.wav",
    });
    if (reuseHit !== null && typeof reuseHit.provenance.processing === "object" && reuseHit.provenance.processing !== null) {
      const reusableBefore = reusableMeasurement(reuseHit.provenance.before);
      const matches = reusableBefore !== null &&
        (reuseHit.provenance.after === null || reusableMeasurement(reuseHit.provenance.after) !== null) &&
        reuseHit.provenance.sourceSha256 === sourceFingerprint.sha256;
      if (matches) {
        await stageReusableAudioWav(reuseHit, stagedWavPath, input.artifactFileTracker);
        after = reuseHit.provenance.after === null
          ? null
          : reusableMeasurement(reuseHit.provenance.after);
        processing = reuseHit.provenance.processing as SeparatedAudioArtifact["processing"];
        reusedFrom = { cacheKey, artifactId: reuseHit.artifactId };
      }
    }
    if (reusedFrom === null) {
      const sourceWav = join(workDir, "source-44k.wav");
      await decodeStereo44k(binaries.ffmpeg, sourcePath, input.params, sourceWav, input.signal);
      const stemsDir = join(workDir, "stems");
      const worker = separateWorkerOverride
        ? await separateWorkerOverride({ task: "separate", wavPath: sourceWav, outputDir: stemsDir, model: "htdemucs", cacheDir: demucsCacheDir(), offline: modelStatus.verified })
        : await runAudioModelTask({
            task: "separate",
            wavPath: sourceWav,
            outputDir: stemsDir,
            model: "htdemucs",
            cacheDir: demucsCacheDir(),
            offline: modelStatus.verified,
          }, {
            signal: input.signal,
            timeoutMs: 20 * 60 * 1000,
            onProgress: () => {},
          }) as unknown as SeparateWorkerResult;
      const stems = worker.stems as Array<{ stem: string; path: string }> | undefined;
      if (!Array.isArray(stems) || stems.length !== 4) fail("JOB_FAILED", "Demucs worker returned an unexpected stem set");
      const stemPaths = Object.fromEntries(stems.map((stem) => [stem.stem, stem.path]));
      for (const name of ["drums", "bass", "other", "vocals"]) {
        if (!stemPaths[name]) fail("JOB_FAILED", `Demucs worker did not return the ${name} stem`);
      }
      await renderTarget(binaries.ffmpeg, stemPaths, input.params, sampleCount, stagedWavPath, input.signal);
      processing = {
        model: "htdemucs",
        modelRepo: DEMUCS_MODEL.repo,
        modelSha256: DEMUCS_MODEL.sha256,
        modelBytes: DEMUCS_MODEL.bytes,
        modelLicense: DEMUCS_MODEL.license,
        device: typeof worker.device === "string" ? worker.device : "unknown",
        loadSeconds: typeof worker.loadSeconds === "number" ? worker.loadSeconds : 0,
        inferenceSeconds: typeof worker.inferenceSeconds === "number" ? worker.inferenceSeconds : 0,
        realtimeFactor: typeof worker.realtimeFactor === "number" ? worker.realtimeFactor : 0,
        peakGpuMemoryMb: typeof worker.peakGpuMemoryMb === "number" ? worker.peakGpuMemoryMb : null,
        peakRssMb: typeof worker.peakRssMb === "number" ? worker.peakRssMb : null,
        stems: stems.map((stem) => stem.stem),
        targetMix: input.params.target === "vocals" ? "vocals stem" : "drums + bass + other (amix normalize=0)",
      };
    }
    const verifiedStagedWav = await assertContainedWrittenFile(stagedWavPath, root, VERB);
    await verifyPublishedSamples(binaries.ffprobe, verifiedStagedWav, sampleCount, input.params.channels, input.signal);
    if (reusedFrom === null) {
      after = await measureLoudnessOrNull(binaries.ffmpeg, verifiedStagedWav, input.signal);
    }
    if (processing === null) fail("JOB_FAILED", "internal: separation facts were not established");
    throwIfCancelled(input.signal);
    const currentFingerprint = await fingerprintFile(sourcePath);
    if (currentFingerprint.sha256 !== sourceFingerprint.sha256) fail("CONFLICT", "source media changed while separation was running; retry against its current version");
    const wavStat = await stat(verifiedStagedWav);
    if (!wavStat.isFile() || wavStat.size === 0) fail("JOB_FAILED", "separated WAV is missing or empty");
    const sha256 = await sha256File(verifiedStagedWav);
    const artifact: SeparatedAudioArtifact = {
      path: join(outputDir, "separated.wav"),
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
        target: input.params.target,
        allowModelDownload: input.params.allowModelDownload === true,
      },
      target: input.params.target,
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
      algorithmVersion,
      ...(reusedFrom !== null ? { reusedFrom } : {}),
      method: `${reusedFrom !== null
        ? "Byte-identical reuse of a validated prior artifact (content-addressed cache hit; Demucs inference was not re-run — the recorded device/timing facts describe exactly these bytes)."
        : "Demucs htdemucs (4 stems at 44.1 kHz) → requested target → 48 kHz exact sample window; output sample count/rate re-verified; loudness measured on the written WAV"}`,
      limitations: [
        "Separation quality is model inference; bleed and artifacts are possible, especially with heavy reverb or unusual instruments.",
        "The vocal stem is not a diarization or speech-enhancement guarantee; overlapping speakers are not separated.",
        "The target window is aligned to the requested source range start; no drift correction is applied.",
      ],
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
        input.artifactFileTracker?.forget("audio-staged-output");
        input.artifactFileTracker?.forget("audio-staged-provenance");
        await prepareArtifactDir(outputDir, root, VERB);
        published = {
          wavPath: await assertContainedWrittenFile(join(outputDir, "separated.wav"), root, VERB),
          provenancePath: await assertContainedWrittenFile(join(outputDir, "provenance.json"), root, VERB),
        };
      } catch (error) {
        if (publishedByThisAttempt) throw error;
        const appeared = await lstat(outputDir).catch(() => null);
        if (appeared === null) throw error;
        published = await inspectPublishedDirectory(outputDir, root, sha256, provenanceSha256);
      }
    }
    if (!publishedByThisAttempt) {
      await cleanupOwnedDirectory(stagingDir, root);
      input.artifactFileTracker?.forget("audio-staged-output");
      input.artifactFileTracker?.forget("audio-staged-provenance");
    }
    throwIfCancelled(input.signal);
    // AUD-13: name this published artifact as the reusable result. Best-effort.
    await recordReusableAudioArtifact({
      root, kind: "audio-separate", cacheKey, artifactId: input.artifactId,
      wavFilename: "separated.wav", wavSha256: sha256, algorithmVersion,
    }).catch(() => {});
    return { ...artifact, path: published.wavPath, provenancePath: published.provenancePath };
  } catch (error) {
    const cleanupErrors: string[] = [];
    try {
      await cleanupOwnedDirectory(stagingDir, root);
      input.artifactFileTracker?.forget("audio-staged-output");
      input.artifactFileTracker?.forget("audio-staged-provenance");
    } catch (cleanupError) { cleanupErrors.push(`pending output cleanup failed: ${ffmpegMessage(cleanupError)}`); }
    if (publishedByThisAttempt) {
      try {
        await cleanupOwnedDirectory(outputDir, root);
        input.artifactFileTracker?.forget("audio-output");
        input.artifactFileTracker?.forget("audio-output-provenance");
      } catch (cleanupError) { cleanupErrors.push(`published output cleanup failed: ${ffmpegMessage(cleanupError)}`); }
    }
    if (cleanupErrors.length > 0) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      throw new FacadeError("JOB_FAILED", `${VERB}: ${originalMessage}; ${cleanupErrors.join("; ")}`, { cleanupFailed: true });
    }
    if (error instanceof FacadeError) throw error;
    if (input.signal?.aborted) fail("JOB_FAILED", "Cancelled");
    fail("JOB_FAILED", ffmpegMessage(error));
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
      input.artifactFileTracker?.forget("audio-separate-source-decode");
      for (const stem of ["drums", "bass", "other", "vocals"]) input.artifactFileTracker?.forget(`audio-separate-stem-${stem}`);
    } catch {
      // Exact remaining paths stay registered for task review.
    }
  }
  return fail("JOB_FAILED", "separation completed without publishing an audio artifact");
}
