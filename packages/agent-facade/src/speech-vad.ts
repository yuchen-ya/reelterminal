/**
 * Local speech-activity analysis (VAD) — the "speechActivity" analysis type.
 *
 * Runtime and model are locked to one combination, per the audio TODO's
 * AUD-01 acceptance: Silero VAD v5.1.2 ONNX weights (MIT) executed through
 * the optional onnxruntime-node package. The runtime import is dynamic and
 * optional — environments without it report the analysis type unavailable
 * instead of failing the whole facade.
 *
 * Model acquisition is explicit: REELTERMINAL_VAD_MODEL points at a local
 * copy (still sha-verified so the v5 input contract cannot silently drift),
 * otherwise the pinned file is downloaded once from the locked GitHub tag
 * into ~/.reelterminal/models/. Audio never leaves the machine: decoding is
 * the same local FFmpeg subprocess path as the other audio kernels, and only
 * scalar probabilities and merged regions are kept.
 */
import { createHash } from "node:crypto";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { homedir } from "node:os";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { FacadeError } from "./errors";
import { requireAudioBinaries, runAudioSubprocess, validateAudioRange } from "./audio-analysis";
import type { MediaSpeechVadParams } from "./types";

/** The single locked VAD model. sha256/bytes pin the exact weights. */
export const SILERO_VAD_MODEL = {
  name: "silero-vad",
  version: "5.1.2",
  file: "silero_vad.onnx",
  url: "https://github.com/snakers4/silero-vad/raw/v5.1.2/src/silero_vad/data/silero_vad.onnx",
  sha256: "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f",
  bytes: 2327524,
  license: "MIT (snakers4/silero-vad)",
} as const;

/** VAD input contract: 16 kHz mono, 512-sample (32 ms) chunks with carried state. */
export const SPEECH_VAD_ANALYSIS_RATE = 16000;
const VAD_CHUNK_SAMPLES = 512;
export const SPEECH_VAD_CHUNK_SEC = VAD_CHUNK_SAMPLES / SPEECH_VAD_ANALYSIS_RATE;

/** Silero-style hysteresis: regions close only after the exit threshold is missed. */
const EXIT_THRESHOLD_OFFSET = 0.15;

export const DEFAULT_SPEECH_VAD_PARAMS = { threshold: 0.5, minSpeechSec: 0.25, minSilenceSec: 0.1, padSec: 0.03 } as const;

/** Resolve and validate the effective tuning once at the request boundary. */
export function resolveSpeechVadParams(params?: MediaSpeechVadParams) {
  const threshold = params?.threshold ?? DEFAULT_SPEECH_VAD_PARAMS.threshold;
  const minSpeechSec = params?.minSpeechSec ?? DEFAULT_SPEECH_VAD_PARAMS.minSpeechSec;
  const minSilenceSec = params?.minSilenceSec ?? DEFAULT_SPEECH_VAD_PARAMS.minSilenceSec;
  const padSec = params?.padSec ?? DEFAULT_SPEECH_VAD_PARAMS.padSec;
  if (!(Number.isFinite(threshold) && threshold >= 0.05 && threshold <= 0.95)) throw new FacadeError("INVALID_PARAMS", "vadParams.threshold must be a finite number in [0.05, 0.95]");
  if (!(Number.isFinite(minSpeechSec) && minSpeechSec >= 0 && minSpeechSec <= 5)) throw new FacadeError("INVALID_PARAMS", "vadParams.minSpeechSec must be a finite number in [0, 5] seconds");
  if (!(Number.isFinite(minSilenceSec) && minSilenceSec >= 0 && minSilenceSec <= 10)) throw new FacadeError("INVALID_PARAMS", "vadParams.minSilenceSec must be a finite number in [0, 10] seconds");
  if (!(Number.isFinite(padSec) && padSec >= 0 && padSec <= 1)) throw new FacadeError("INVALID_PARAMS", "vadParams.padSec must be a finite number in [0, 1] seconds");
  if (threshold - EXIT_THRESHOLD_OFFSET <= 0) throw new FacadeError("INVALID_PARAMS", "vadParams.threshold must exceed 0.15 so the exit threshold stays positive");
  return { threshold, minSpeechSec, minSilenceSec, padSec };
}

/** Chunk-level inference seam. Production uses the Silero ONNX session. */
export interface VadInferenceModel {
  detect(chunk: Float32Array): Promise<number>;
}

let modelFactoryOverride: (() => Promise<VadInferenceModel>) | null = null;
/** Test seam for hermetic model-free regression of the surrounding pipeline. */
export function setSpeechVadModelFactoryForTests(factory: (() => Promise<VadInferenceModel>) | null): void {
  modelFactoryOverride = factory;
}

type OrtModule = typeof import("onnxruntime-node");
let ortModule: OrtModule | null = null;

async function loadOrt(): Promise<OrtModule | null> {
  if (ortModule) return ortModule;
  try {
    ortModule = await import("onnxruntime-node") as OrtModule;
    return ortModule;
  } catch {
    return null;
  }
}

/** Runtime-only probe: is onnxruntime-node loadable here? Never downloads. */
export async function speechVadRuntimePreflight(): Promise<{ available: true } | { available: false; reason: string }> {
  if (await loadOrt()) return { available: true };
  return { available: false, reason: "Speech-activity analysis needs the optional onnxruntime-node package (install @reelterminal/agent-facade dependencies); it is absent in this runtime" };
}

/** Where the model is expected. REELTERMINAL_VAD_MODEL wins when set. */
export function speechVadModelPath(): string {
  const override = process.env.REELTERMINAL_VAD_MODEL;
  if (override) return resolve(override);
  return join(homedir(), ".reelterminal", "models", `${SILERO_VAD_MODEL.name}-${SILERO_VAD_MODEL.version}`, SILERO_VAD_MODEL.file);
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function verifyModelFile(path: string): Promise<void> {
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile()) throw new FacadeError("UNSUPPORTED", `Silero VAD model file is missing: ${path}. Download ${SILERO_VAD_MODEL.file} (${SILERO_VAD_MODEL.version}, MIT) from ${SILERO_VAD_MODEL.url} or set REELTERMINAL_VAD_MODEL to an absolute local copy.`);
  if (fileStat.size !== SILERO_VAD_MODEL.bytes) throw new FacadeError("UNSUPPORTED", `Silero VAD model file at ${path} has ${fileStat.size} bytes, expected ${SILERO_VAD_MODEL.bytes} (${SILERO_VAD_MODEL.version}); replace it with the pinned file from ${SILERO_VAD_MODEL.url}`);
  const digest = await sha256File(path);
  if (digest !== SILERO_VAD_MODEL.sha256) throw new FacadeError("UNSUPPORTED", `Silero VAD model file at ${path} does not match the pinned ${SILERO_VAD_MODEL.version} weights (sha256 ${digest.slice(0, 12)}…); replace it from ${SILERO_VAD_MODEL.url}`);
}

/** Bounded, redirect-following download of the pinned model (first use only). */
async function downloadVadModel(destination: string, signal: AbortSignal, urlOverride?: string): Promise<void> {
  const MAX_REDIRECTS = 4;
  const TIMEOUT_MS = 30000;
  const MAX_BYTES = SILERO_VAD_MODEL.bytes * 2;
  const fetchToBuffer = (url: string, redirects: number): Promise<Buffer> => new Promise((resolvePromise, rejectPromise) => {
    if (redirects < 0) { rejectPromise(new FacadeError("UNSUPPORTED", `Silero VAD model download exceeded ${MAX_REDIRECTS} redirects from ${urlOverride ?? SILERO_VAD_MODEL.url}`)); return; }
    // The pinned source is https; plain http only arises from the local-server
    // test override, so dispatch on the URL protocol.
    const getFor = new URL(url).protocol === "http:" ? httpGet : httpsGet;
    const request = getFor(url, { timeout: TIMEOUT_MS, headers: { "user-agent": "ReelTerminal-agent-facade" } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolvePromise(fetchToBuffer(new URL(response.headers.location, url).toString(), redirects - 1));
        return;
      }
      if (status !== 200) { response.resume(); rejectPromise(new FacadeError("UNSUPPORTED", `Silero VAD model download from ${url} returned HTTP ${status}`)); return; }
      const chunks: Buffer[] = []; let size = 0; let failed = false;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { failed = true; response.destroy(); rejectPromise(new FacadeError("UNSUPPORTED", `Silero VAD model download exceeded ${MAX_BYTES} bytes; ${SILERO_VAD_MODEL.url} no longer serves the pinned file`)); return; }
        if (!failed) chunks.push(chunk);
      });
      response.on("end", () => { if (!failed) resolvePromise(Buffer.concat(chunks)); });
      response.on("error", (error) => rejectPromise(new FacadeError("UNSUPPORTED", `Silero VAD model download failed: ${error.message}`)));
    });
    request.on("timeout", () => { request.destroy(new Error("timeout")); });
    request.on("error", (error) => rejectPromise(new FacadeError("UNSUPPORTED", `Silero VAD model download from ${url} failed: ${error.message}`)));
    const abort = () => { request.destroy(new Error("Cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    request.on("close", () => signal.removeEventListener("abort", abort));
  });
  const buffer = await fetchToBuffer(urlOverride ?? SILERO_VAD_MODEL.url, MAX_REDIRECTS);
  const digest = createHash("sha256").update(buffer).digest("hex");
  if (digest !== SILERO_VAD_MODEL.sha256 || buffer.length !== SILERO_VAD_MODEL.bytes) {
    throw new FacadeError("UNSUPPORTED", `Downloaded Silero VAD model does not match the pinned ${SILERO_VAD_MODEL.version} weights (${buffer.length} bytes, sha256 ${digest.slice(0, 12)}…); leaving cache empty`);
  }
  await mkdir(dirname(destination), { recursive: true });
  const staging = `${destination}.${process.pid}.tmp`;
  await writeFile(staging, buffer);
  try { await rename(staging, destination); } catch (error) {
    await unlink(staging).catch(() => {});
    throw new FacadeError("UNSUPPORTED", `Silero VAD model could not be published to ${destination}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Env override must exist and be pinned; the default cache downloads once. */
async function ensureVadModel(signal: AbortSignal): Promise<string> {
  const path = speechVadModelPath();
  if (process.env.REELTERMINAL_VAD_MODEL) {
    await verifyModelFile(path);
    return path;
  }
  const existing = await stat(path).catch(() => null);
  if (existing?.isFile()) {
    await verifyModelFile(path);
    return path;
  }
  await downloadVadModel(path, signal);
  await verifyModelFile(path);
  return path;
}

/** Local-server download-mechanics regression (redirect, size, sha, atomic publish, abort). */
export const downloadVadModelForTests =
  (url: string, destination: string, signal: AbortSignal) => downloadVadModel(destination, signal, url);

async function createSileroModel(modelPath: string): Promise<VadInferenceModel> {
  const ort = await loadOrt();
  if (!ort) throw new FacadeError("UNSUPPORTED", "onnxruntime-node is not installed; speech-activity analysis is unavailable in this runtime");
  const session = await ort.InferenceSession.create(modelPath);
  const inputNames = [...session.inputNames].sort();
  const expected = ["input", "sr", "state"].sort().join(",");
  if (inputNames.join(",") !== expected) {
    throw new FacadeError("UNSUPPORTED", `Model at ${modelPath} does not expose the Silero v5 inputs (input/state/sr); refusing to guess its contract`);
  }
  let state: import("onnxruntime-node").Tensor = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  const sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(SPEECH_VAD_ANALYSIS_RATE)]), []);
  return {
    async detect(chunk) {
      const outputs = await session.run({
        input: new ort.Tensor("float32", chunk, [1, chunk.length]),
        state,
        sr,
      });
      state = outputs.stateN!;
      return Number(outputs.output!.data[0]);
    },
  };
}

/** Reported exit threshold, kept free of float-accumulation noise. */
function exitThresholdOf(threshold: number): number {
  return Number((threshold - EXIT_THRESHOLD_OFFSET).toFixed(6));
}

/**
 * Hysteresis segmentation over per-chunk speech probabilities. Region
 * boundaries land on 32 ms chunk edges (± the requested padding); regions
 * shorter than minSpeechSec (unpadded) are dropped, mirroring Silero's
 * VADIterator semantics. Pure so tests can pin the exact behavior.
 */
export function segmentsFromProbabilities(
  probabilities: readonly number[],
  params: { threshold: number; minSpeechSec: number; minSilenceSec: number; padSec: number },
  range: { startSec: number; endSec: number },
): Array<{ startSec: number; endSec: number }> {
  const exitThreshold = params.threshold - EXIT_THRESHOLD_OFFSET;
  const minSilenceChunks = Math.max(1, Math.ceil(params.minSilenceSec / SPEECH_VAD_CHUNK_SEC));
  const closed: Array<{ startChunk: number; endChunk: number }> = [];
  let inSpeech = false;
  let startChunk = 0;
  let lastActiveChunk = -1;
  for (let index = 0; index < probabilities.length; index++) {
    const probability = probabilities[index]!;
    if (!inSpeech) {
      if (probability >= params.threshold) { inSpeech = true; startChunk = index; lastActiveChunk = index; }
      continue;
    }
    if (probability >= exitThreshold) { lastActiveChunk = index; continue; }
    if (index - lastActiveChunk >= minSilenceChunks) {
      closed.push({ startChunk, endChunk: lastActiveChunk + 1 });
      inSpeech = false;
      lastActiveChunk = -1;
    }
  }
  if (inSpeech) closed.push({ startChunk, endChunk: lastActiveChunk + 1 });
  return closed
    .filter((region) => (region.endChunk - region.startChunk) * SPEECH_VAD_CHUNK_SEC >= params.minSpeechSec)
    .map((region) => ({
      startSec: Math.max(range.startSec, range.startSec + region.startChunk * SPEECH_VAD_CHUNK_SEC - params.padSec),
      endSec: Math.min(range.endSec, range.startSec + region.endChunk * SPEECH_VAD_CHUNK_SEC + params.padSec),
    }))
    .filter((region) => region.endSec > region.startSec);
}

/** Full capability probe for disclosure: runtime + model + a real session. Never downloads. */
export async function speechVadPreflight(): Promise<{ available: true; details: Record<string, unknown> } | { available: false; reason: string; requires?: string }> {
  const runtime = await speechVadRuntimePreflight();
  if (!runtime.available) return runtime;
  const path = speechVadModelPath();
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile()) {
    return {
      available: false,
      reason: `Silero VAD ${SILERO_VAD_MODEL.version} model is not present at ${path}. The first media.analyze_start with analysisTypes ["speechActivity"] downloads it once (≈2.2 MiB, MIT) from ${SILERO_VAD_MODEL.url}; on restricted networks download that file manually and point REELTERMINAL_VAD_MODEL at it.`,
      requires: `Silero VAD ${SILERO_VAD_MODEL.version} weights (${SILERO_VAD_MODEL.bytes} bytes, sha256 ${SILERO_VAD_MODEL.sha256})`,
    };
  }
  try {
    await verifyModelFile(path);
    await createSileroModel(path);
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return {
    available: true,
    details: {
      model: { ...SILERO_VAD_MODEL, path },
      runtime: "onnxruntime-node (optional dependency, loaded dynamically)",
      chunkSec: SPEECH_VAD_CHUNK_SEC,
      defaults: { ...DEFAULT_SPEECH_VAD_PARAMS },
    },
  };
}

/** Stereo f32le decode at the VAD rate, then the repo-wide strongest-sample mono mix. */
async function extractVadPcm(path: string, range: { startSec: number; endSec: number }, signal: AbortSignal) {
  const binaries = await requireAudioBinaries(signal);
  const input = ["-hide_banner", "-nostdin", "-v", "info", "-ss", String(range.startSec), "-t", String(range.endSec - range.startSec), "-i", path, "-map", "0:a:0", "-vn", "-threads", "1"];
  const pcm = await runAudioSubprocess(binaries.ffmpeg, [...input, "-ar", String(SPEECH_VAD_ANALYSIS_RATE), "-ac", "2", "-f", "f32le", "pipe:1"], signal);
  const frames = Math.floor(pcm.out.length / 8);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const left = pcm.out.readFloatLE(i * 8);
    const right = pcm.out.readFloatLE(i * 8 + 4);
    if (!Number.isFinite(left) || !Number.isFinite(right)) throw new Error("Nonfinite audio sample");
    // Same strategy as the silence/BPM kernels: keep the stronger channel's
    // signed sample so right-only speech survives and anti-phase channels
    // cannot cancel in an arithmetic downmix.
    mono[i] = Math.abs(left) >= Math.abs(right) ? left : right;
  }
  return mono;
}

export interface SpeechActivityRegion {
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
}

/** The "speechActivity" observation facts, in original source seconds. */
export interface SpeechActivityFacts {
  readonly coordinateSpace: "source";
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly analysisSampleRate: number;
  readonly parameters: { readonly threshold: number; readonly exitThreshold: number; readonly minSpeechSec: number; readonly minSilenceSec: number; readonly padSec: number };
  readonly speechRegions: readonly SpeechActivityRegion[];
  readonly regionCount: number;
  readonly totalSpeechDurationSec: number;
  readonly speechRatio: number;
  readonly truncated: boolean;
  readonly granularitySec: number;
  readonly boundaryUncertaintySec: number;
  readonly model: { readonly name: string; readonly version: string; readonly file: string; readonly url: string; readonly sha256: string; readonly bytes: number; readonly license: string; readonly path: string | null };
  readonly algorithm: string;
  readonly limitations: readonly string[];
}

/**
 * "speechActivity" analysis: Silero VAD over locally decoded 16 kHz mono PCM.
 * Regions are model inferences in source seconds — not semantics, and never
 * an automatic edit decision. Progress maps decode → inference → done.
 */
export async function analyzeSpeechActivity(
  path: string,
  range: { startSec: number; endSec: number },
  params: MediaSpeechVadParams | undefined,
  signal: AbortSignal,
  progress: (percent: number) => void = () => {},
): Promise<SpeechActivityFacts> {
  validateAudioRange(range);
  const resolved = resolveSpeechVadParams(params);
  const model = modelFactoryOverride ? await modelFactoryOverride() : await (async () => {
    const modelPath = await ensureVadModel(signal);
    return createSileroModel(modelPath);
  })();
  if (signal.aborted) throw new Error("Cancelled");
  const pcm = await extractVadPcm(path, range, signal);
  progress(.4);
  const chunkCount = Math.ceil(pcm.length / VAD_CHUNK_SAMPLES);
  const probabilities: number[] = [];
  const chunk = new Float32Array(VAD_CHUNK_SAMPLES);
  for (let index = 0; index < chunkCount; index++) {
    if (signal.aborted) throw new Error("Cancelled");
    chunk.fill(0);
    const offset = index * VAD_CHUNK_SAMPLES;
    // The final partial chunk is zero-padded; region ends clamp to the range.
    pcm.subarray(offset, Math.min(offset + VAD_CHUNK_SAMPLES, pcm.length)).forEach((sample, i) => { chunk[i] = sample; });
    probabilities.push(await model.detect(chunk));
    if (index % 64 === 0) progress(.4 + .6 * (index / Math.max(1, chunkCount)));
  }
  progress(1);
  const regions = segmentsFromProbabilities(probabilities, resolved, range);
  const durationSec = pcm.length / SPEECH_VAD_ANALYSIS_RATE;
  const totalSpeechDurationSec = regions.reduce((sum, region) => sum + region.endSec - region.startSec, 0);
  return {
    coordinateSpace: "source" as const,
    ...range,
    durationSec,
    analysisSampleRate: SPEECH_VAD_ANALYSIS_RATE,
    parameters: { ...resolved, exitThreshold: exitThresholdOf(resolved.threshold) },
    speechRegions: regions.map((region) => ({ ...region, durationSec: region.endSec - region.startSec })),
    regionCount: regions.length,
    totalSpeechDurationSec,
    speechRatio: durationSec > 0 ? totalSpeechDurationSec / durationSec : 0,
    truncated: false,
    granularitySec: SPEECH_VAD_CHUNK_SEC,
    boundaryUncertaintySec: SPEECH_VAD_CHUNK_SEC,
    model: { ...SILERO_VAD_MODEL, path: modelFactoryOverride ? null : speechVadModelPath() },
    algorithm: `Silero VAD ${SILERO_VAD_MODEL.version} ONNX via onnxruntime-node: per-chunk speech probabilities over ${SPEECH_VAD_CHUNK_SEC.toFixed(3)}s windows at 16 kHz with carried model state, hysteresis enter/exit thresholds (${resolved.threshold.toFixed(2)}/${exitThresholdOf(resolved.threshold).toFixed(2)}), minimum speech/silence durations and padding; FFmpeg-decoded strongest-absolute-sample mono mix`,
    limitations: [
      "Speech regions are acoustic model inferences, not semantic understanding: singing, some music and speech-like sounds can be missed or falsely included.",
      "Non-speech intervals are not automatically deletable gaps; review before editing.",
      "Region boundaries land on 32 ms chunk edges (plus the requested padding); the final partial chunk is zero-padded and region ends clamp to the analyzed range.",
      "Per-chunk probabilities are not persisted; merged regions are the stored granularity.",
      "Source seconds only; map through clip trim/offset/speed before editing. Results do not change gain, markers, playback, selection or project revision.",
    ],
  };
}
