/**
 * Optional local audio-model worker runtime (AUD-07, and the shared seam for
 * later AUD-09 work).
 *
 * The models are NOT bundled and no ONNX/native npm dependency is introduced:
 * an explicitly configured Python interpreter runs `python/audio_models.py`,
 * exactly the validated funasr/SenseVoice combination from the 2026-10-18
 * evaluation. The interpreter is never guessed from a hardcoded conda path
 * and the app never runs pip. When the interpreter, a required import or the
 * pinned model is missing, the capability is reported unavailable with the
 * download/disk requirement instead of claiming the feature works.
 *
 * Isolation contract: one child process per task, JSON-lines progress on
 * stdout and a single terminal result/error event. Cancellation kills the
 * process; a crash, nonzero exit, timeout, invalid event or oversized output
 * fails the task without publishing any asset. The worker never mutates the
 * project or media roots.
 */
import { readAudioEnvironment } from "./audio-environment-config";
import { resolvePythonWorkerPath } from "./python-worker-path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { FacadeError } from "../errors";

/** The single validated SenseVoice model. sha256/bytes pin exact weights. */
export const SENSEVOICE_MODEL = {
  repo: "iic/SenseVoiceSmall",
  file: "model.pt",
  bytes: 936_291_369,
  sha256: "833ca2dcfdf8ec91bd4f31cfac36d6124e0c459074d5e909aec9cabe6204a3ea",
  license: "Apache-2.0 (FunAudioLLM/SenseVoiceSmall)",
} as const;

/** The single validated CAM++ speaker-verification model. */
export const SPEAKER_DIARIZATION_MODEL = {
  repo: "iic/speech_campplus_sv_zh-cn_16k-common",
  file: "campplus_cn_common.bin",
  bytes: 28_036_335,
  sha256: "3388cf5fd3493c9ac9c69851d8e7a8badcfb4f3dc631020c4961371646d5ada8",
  license: "Apache-2.0 (3D-Speaker / iic)",
} as const;

/** Demucs htdemucs bag-of-models weight file (HF adefossez/HTDemucs). */
export const DEMUCS_MODEL = {
  repo: "adefossez/HTDemucs",
  file: "955717e8.safetensors",
  bytes: 84_025_440,
  sha256: "d9fa14133cfcc034a6758923bb3a8ca9f8dfd0b582134643bbf83f72c17576dd",
  license: "MIT (demucs; model weights released by the Demucs authors)",
} as const;

/** Optional component manifest shown before any download is authorized. */
export const AUDIO_MODEL_COMPONENTS = {
  speechTranscript: {
    implemented: true,
    task: "transcribe",
    model: { ...SENSEVOICE_MODEL, displayName: "SenseVoice-Small" },
    validatedPackages: { funasr: "1.3.1", modelscope: "1.34.0", torch: "2.10.0", soundfile: "0.13.1", numpy: "1.26.4" },
    requiredPackages: ["funasr", "modelscope", "torch", "soundfile", "numpy"],
    downloadBytes: SENSEVOICE_MODEL.bytes,
    estimatedDiskBytes: 1_100_000_000,
    timestampSource: "external-vad-silero",
  },
  speakerDiarization: {
    implemented: true,
    task: "diarize",
    model: { ...SPEAKER_DIARIZATION_MODEL, displayName: "CAM++ speaker verification" },
    validatedPackages: { modelscope: "1.34.0", torch: "2.10.0", soundfile: "0.13.1", numpy: "1.26.4" },
    requiredPackages: ["modelscope", "torch", "soundfile", "numpy"],
    downloadBytes: SPEAKER_DIARIZATION_MODEL.bytes,
    estimatedDiskBytes: 60_000_000,
    timestampSource: "external-vad-silero",
  },
  separation: {
    implemented: true,
    task: "separate",
    model: { ...DEMUCS_MODEL, displayName: "Demucs htdemucs" },
    validatedPackages: { demucs: "4.1.0", torch: "2.9.1", soundfile: "0.14.0", numpy: "1.26.4" },
    requiredPackages: ["demucs", "torch", "soundfile", "numpy"],
    downloadBytes: DEMUCS_MODEL.bytes,
    estimatedDiskBytes: 120_000_000,
    timestampSource: "source-range-start",
  },
  denoiseDeep: {
    implemented: false,
    reason: "DeepFilterNet3 needs a runtime decision (torchaudio>=2.9 incompatibility) and is not exposed.",
    validatedPackages: { deepfilternet: "0.5.6", torch: "2.9.0" },
  },
} as const;

export type AudioModelComponent = keyof typeof AUDIO_MODEL_COMPONENTS;

interface InterpreterCandidate {
  readonly python: string;
}

/** PATH lookup honoring PATHEXT on Windows. No shell involved. */
async function findOnPath(name: string): Promise<string | null> {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return null;
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const directory of pathEnv.split(delimiter)) {
    if (!directory) continue;
    for (const ext of exts) {
      const candidate = ext ? `${directory}/${name}${ext}` : `${directory}/${name}`;
      const info = await stat(candidate).catch(() => null);
      if (info?.isFile()) return candidate;
    }
  }
  return null;
}

async function candidateInterpreters(task?: unknown): Promise<InterpreterCandidate[]> {
  const candidates: InterpreterCandidate[] = [];
  const explicit = task === "caption-qwen" || task === "caption-align"
    ? readAudioEnvironment().qwenPython
    : task === "separate"
    ? readAudioEnvironment().separationPython ?? process.env.REELTERMINAL_SEPARATION_PYTHON ?? readAudioEnvironment().python ?? process.env.REELTERMINAL_AUDIO_MODELS_PYTHON ?? process.env.REELTERMINAL_PYTHON_PATH
    : readAudioEnvironment().python ?? process.env.REELTERMINAL_AUDIO_MODELS_PYTHON ?? process.env.REELTERMINAL_PYTHON_PATH;
  if (explicit && explicit.length > 0) candidates.push({ python: explicit });
  if (explicit || task === "caption-qwen" || task === "caption-align") return candidates;
  for (const name of ["python3", "python"]) {
    const onPath = await findOnPath(name);
    if (onPath) candidates.push({ python: onPath });
  }
  return candidates;
}

export async function resolveAudioModelsScript(moduleDir = fileURLToPath(new URL(".", import.meta.url))): Promise<string | null> {
  return resolvePythonWorkerPath("audio_models.py", moduleDir, process.env.REELTERMINAL_AUDIO_MODELS_SCRIPT_DIR);
}

export interface AudioModelProbeResult {
  readonly python: string;
  readonly pythonVersion: string;
  readonly scriptDir: string;
  readonly packages: Readonly<Record<string, boolean>>;
  readonly versions: Readonly<Record<string, string | boolean | null>>;
}

interface ProbeState {
  readonly key: string;
  readonly result: { available: true; details: AudioModelProbeResult } | { available: false; reason: string };
}
let probeCache: ProbeState | null = null;
let probeOverride: (() => Promise<ProbeState["result"]>) | null = null;

/** Test seam: replace the interpreter/script probe without spawning Python. */
export function setAudioModelsProbeForTests(probe: (() => Promise<ProbeState["result"]>) | null): void {
  probeOverride = probe;
  probeCache = null;
}

export function clearAudioModelsProbeCache(): void {
  probeCache = null;
}

/** Where modelscope caches weights unless the user points it elsewhere. */
export function audioModelsCacheDir(): string {
  const override = process.env.REELTERMINAL_MODELSCOPE_CACHE;
  if (override && override.length > 0) return override;
  return join(homedir(), ".reelterminal", "models", "modelscope");
}

/** The exact local SenseVoice directory; env override must still match the pinned weights. */
export function senseVoiceModelDir(): string {
  const override = readAudioEnvironment().senseVoiceModelDir ?? process.env.REELTERMINAL_SENSEVOICE_MODEL_DIR;
  if (override && override.length > 0) return override;
  return join(audioModelsCacheDir(), "models", "iic", "SenseVoiceSmall");
}

/** The exact local CAM++ directory; env override must still match the pinned weights. */
export function speakerDiarizationModelDir(): string {
  const override = readAudioEnvironment().speakerModelDir ?? process.env.REELTERMINAL_CAMPP_SV_MODEL_DIR;
  if (override && override.length > 0) return override;
  return join(audioModelsCacheDir(), "models", "iic", "speech_campplus_sv_zh-cn_16k-common");
}

/** Hugging Face cache root used for the optional Demucs weights. */
export function demucsCacheDir(): string {
  const override = readAudioEnvironment().demucsCache ?? process.env.REELTERMINAL_DEMUCS_CACHE;
  if (override && override.length > 0) return override;
  return join(homedir(), ".reelterminal", "models", "demucs");
}

/** Locate the htdemucs weight file inside the HF snapshot layout. */
async function findDemucsWeight(): Promise<string | null> {
  const snapshots = join(demucsCacheDir(), "hub", "models--adefossez--HTDemucs", "snapshots");
  const entries = await readdir(snapshots, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(snapshots, entry.name, DEMUCS_MODEL.file);
    if ((await stat(candidate).catch(() => null))?.isFile()) return candidate;
  }
  return null;
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export interface PinnedAudioModelStatus {
  readonly path: string;
  readonly present: boolean;
  readonly bytes: number;
  readonly verified: boolean;
  readonly reason: string | null;
}
/** Backwards-compatible name used by the transcript capability. */
export type SenseVoiceModelStatus = PinnedAudioModelStatus;

const modelStatusCaches = new Map<string, { readonly key: string; readonly value: PinnedAudioModelStatus }>();

async function pinnedModelStatus(
  model: { readonly repo: string; readonly file: string; readonly bytes: number; readonly sha256: string },
  directory: string,
  envHint: string,
  allowDownloadHint: string,
): Promise<PinnedAudioModelStatus> {
  const path = join(directory, model.file);
  const info = await stat(path).catch(() => null);
  const key = `${model.file}|${path}|${info?.size ?? 0}|${Math.round(info?.mtimeMs ?? 0)}`;
  const cached = modelStatusCaches.get(key);
  if (cached) return cached.value;
  let value: PinnedAudioModelStatus;
  if (!info?.isFile()) {
    value = {
      path,
      present: false,
      bytes: 0,
      verified: false,
      reason: `${model.repo} is not present at ${path}. First use needs ${model.bytes} bytes (≈${Math.round(model.bytes / 1_000_000)} MB download) from ModelScope; set ${envHint} to a local copy or authorize the download with ${allowDownloadHint}`,
    };
  } else if (info.size !== model.bytes) {
    value = {
      path,
      present: true,
      bytes: info.size,
      verified: false,
      reason: `${model.repo} at ${path} has ${info.size} bytes, expected ${model.bytes}; replace it with the pinned weights`,
    };
  } else {
    const digest = await sha256File(path);
    value = digest === model.sha256
      ? { path, present: true, bytes: info.size, verified: true, reason: null }
      : {
          path,
          present: true,
          bytes: info.size,
          verified: false,
          reason: `${model.repo} at ${path} does not match the pinned weights (sha256 ${digest.slice(0, 12)}…); replace it from the pinned source`,
        };
  }
  modelStatusCaches.set(key, { key, value });
  return value;
}

/** Cheap presence/size check for capability reporting (no model hashing). */
export async function senseVoiceModelPresence(): Promise<{ path: string; present: boolean; bytes: number }> {
  const path = join(senseVoiceModelDir(), SENSEVOICE_MODEL.file);
  const info = await stat(path).catch(() => null);
  return { path, present: info?.isFile() === true, bytes: info?.size ?? 0 };
}

export async function speakerDiarizationModelPresence(): Promise<{ path: string; present: boolean; bytes: number }> {
  const path = join(speakerDiarizationModelDir(), SPEAKER_DIARIZATION_MODEL.file);
  const info = await stat(path).catch(() => null);
  return { path, present: info?.isFile() === true, bytes: info?.size ?? 0 };
}

/** Verify the pinned SenseVoice weights once per path/size/mtime. */
export async function senseVoiceModelStatus(): Promise<PinnedAudioModelStatus> {
  return pinnedModelStatus(SENSEVOICE_MODEL, senseVoiceModelDir(), "REELTERMINAL_SENSEVOICE_MODEL_DIR", "transcriptParams.allowModelDownload:true");
}

/** Verify the pinned CAM++ weights once per path/size/mtime. */
export async function speakerDiarizationModelStatus(): Promise<PinnedAudioModelStatus> {
  return pinnedModelStatus(SPEAKER_DIARIZATION_MODEL, speakerDiarizationModelDir(), "REELTERMINAL_CAMPP_SV_MODEL_DIR", "diarizationParams.allowModelDownload:true");
}

/** Cheap Demucs presence check (no 84 MB hash). */
export async function demucsModelPresence(): Promise<{ path: string | null; present: boolean; bytes: number }> {
  const path = await findDemucsWeight();
  const info = path ? await stat(path).catch(() => null) : null;
  return { path, present: info?.isFile() === true, bytes: info?.size ?? 0 };
}

/** Verify the pinned htdemucs weights once per path/size/mtime. */
export async function demucsModelStatus(): Promise<PinnedAudioModelStatus> {
  const path = await findDemucsWeight();
  if (!path) {
    return {
      path: join(demucsCacheDir(), "hub", "models--adefossez--HTDemucs", "snapshots", "<hash>", DEMUCS_MODEL.file),
      present: false,
      bytes: 0,
      verified: false,
      reason: `Demucs ${DEMUCS_MODEL.repo} is not present in ${demucsCacheDir()}. First use needs ${DEMUCS_MODEL.bytes} bytes (≈${Math.round(DEMUCS_MODEL.bytes / 1_000_000)} MB download) from Hugging Face; set REELTERMINAL_DEMUCS_CACHE to a populated HF cache or authorize the download with separationParams.allowModelDownload:true`,
    };
  }
  const info = await stat(path);
  const key = `demucs|${path}|${info.size}|${Math.round(info.mtimeMs)}`;
  const cached = modelStatusCaches.get(key);
  if (cached) return cached.value;
  let value: PinnedAudioModelStatus;
  if (info.size !== DEMUCS_MODEL.bytes) {
    value = { path, present: true, bytes: info.size, verified: false, reason: `Demucs weights at ${path} have ${info.size} bytes, expected ${DEMUCS_MODEL.bytes}; replace them with the pinned file` };
  } else {
    const digest = await sha256File(path);
    value = digest === DEMUCS_MODEL.sha256
      ? { path, present: true, bytes: info.size, verified: true, reason: null }
      : { path, present: true, bytes: info.size, verified: false, reason: `Demucs weights at ${path} do not match the pinned ${DEMUCS_MODEL.repo} file (sha256 ${digest.slice(0, 12)}…); replace them` };
  }
  modelStatusCaches.set(key, { key, value });
  return value;
}

/** Clear the sha caches after tests change a model path or file. */
export function clearAudioModelStatusCache(): void {
  modelStatusCaches.clear();
}

interface WorkerOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onProgress?: (percent: number, phase: string) => void;
}

interface WorkerEvent {
  readonly event?: string;
  readonly percent?: unknown;
  readonly phase?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message?: unknown; readonly traceback?: unknown };
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * Run one worker task. Exported separately from the facade so the protocol,
 * cancellation and failure isolation can be regression-tested with a stub
 * interpreter.
 */
export async function runAudioModelProcess(
  python: string,
  script: string,
  request: Record<string, unknown>,
  options: WorkerOptions = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  if (options.signal?.aborted) throw new Error("Cancelled");
  const env = {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
    MODELSCOPE_CACHE: audioModelsCacheDir(),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-I", script], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env });
    let settled = false;
    let stdoutBytes = 0;
    let stderrTail = "";
    let terminal: { result?: unknown; error?: { message?: unknown; traceback?: unknown } } | null = null;
    const finish = (error: Error | null, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const stop = (message: string) => {
      child.kill("SIGKILL");
      finish(new FacadeError("JOB_FAILED", message, terminal?.error?.traceback ? { workerTraceback: String(terminal.error.traceback).slice(-4000) } : {}));
    };
    const abort = () => stop("Cancelled");
    const timer = setTimeout(() => stop(`Local audio-model task exceeded its ${Math.round(timeoutMs / 1000)}s deadline`), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => finish(new FacadeError("JOB_FAILED", `Local audio-model interpreter failed to start: ${error.message}`)));
    child.stdin.on("error", () => { /* the close handler reports the real failure */ });
    child.stdin.end(JSON.stringify(request));
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (settled) return;
      stdoutBytes += Buffer.byteLength(line) + 1;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        stop("Local audio-model task exceeded its output limit");
        return;
      }
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let event: WorkerEvent;
      try {
        event = JSON.parse(trimmed) as WorkerEvent;
      } catch {
        stop(`Local audio-model worker produced invalid JSON: ${trimmed.slice(0, 200)}`);
        return;
      }
      if (event === null || typeof event !== "object" || terminal !== null) {
        stop("Local audio-model worker produced an invalid or duplicate terminal event");
        return;
      }
      if (event.event === "progress") {
        const percent = typeof event.percent === "number" ? event.percent : Number(event.percent);
        const phase = typeof event.phase === "string" ? event.phase : "working";
        if (Number.isFinite(percent)) options.onProgress?.(Math.max(0, Math.min(1, percent)), phase);
        return;
      }
      if (event.event === "error") {
        terminal = { error: event.error };
        stop(`Local audio-model task failed: ${String(event.error?.message ?? "no detail reported")}`);
        return;
      }
      if (event.event === "done") {
        terminal = { result: event.result };
        if (event.result === null || typeof event.result !== "object" || Array.isArray(event.result)) {
          stop("Local audio-model worker returned no result object");
          return;
        }
        return;
      }
      stop(`Local audio-model worker produced an unknown event: ${String(event.event)}`);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0 && terminal?.result) {
        finish(null, terminal.result as Record<string, unknown>);
        return;
      }
      finish(new FacadeError(
        "JOB_FAILED",
        `Local audio-model worker exited (code ${String(code)}) ${terminal ? "after a terminal event" : "without a terminal event"}${stderrTail.trim() ? `: ${stderrTail.trim().slice(-1500)}` : ""}`,
        { stderrTail: stderrTail.slice(-4000) },
      ));
    });
  });
}

export const DEFAULT_AUDIO_MODEL_PACKAGES = ["funasr", "modelscope", "torch", "soundfile"] as const;

/** Per-task import requirements; transcript and diarization need different packages. */
export function requiredAudioModelPackages(task: unknown): readonly string[] {
  if (task === "caption-qwen" || task === "caption-align") return ["transformers", "torch", "soundfile", "numpy", "librosa"];
  if (task === "diarize") return ["modelscope", "torch", "soundfile", "numpy"];
  if (task === "separate") return ["demucs", "torch", "soundfile", "numpy"];
  if (task === "deepfilter") return ["deepfilternet", "torch", "soundfile", "numpy"];
  return DEFAULT_AUDIO_MODEL_PACKAGES;
}

/** Test seam for the process runner (the transcript kernel takes an injected transcribe). */
export async function runAudioModelTask(
  request: Record<string, unknown>,
  options: WorkerOptions = {},
): Promise<Record<string, unknown>> {
  const runtime = await probeAudioModelsRuntime(requiredAudioModelPackages(request.task), request.task);
  if (!runtime.available) throw new FacadeError("UNSUPPORTED", runtime.reason);
  const expectedModel = request.task === "transcribe" ? SENSEVOICE_MODEL
    : request.task === "diarize" ? SPEAKER_DIARIZATION_MODEL
      : request.task === "separate" ? DEMUCS_MODEL : undefined;
  const modelWeightPath = request.task === "separate" ? (await demucsModelPresence()).path : undefined;
  return runAudioModelProcess(runtime.details.python, join(runtime.details.scriptDir, "audio_models.py"), {
    ...request,
    ...(expectedModel ? { expectedModel } : {}),
    ...(modelWeightPath ? { modelWeightPath } : {}),
  }, options);
}

/** Probe once per process: interpreter + script + import availability. */
export async function probeAudioModelsRuntime(
  requiredPackages: readonly string[] = DEFAULT_AUDIO_MODEL_PACKAGES,
  task?: unknown,
): Promise<
  { available: true; details: AudioModelProbeResult } | { available: false; reason: string }
> {
  if (probeOverride) return probeOverride();
  const script = await resolveAudioModelsScript();
  if (!script) {
    return { available: false, reason: "the audio-model worker script audio_models.py was not found beside this build — set REELTERMINAL_AUDIO_MODELS_SCRIPT_DIR or restore packages/agent-facade/python" };
  }
  const candidates = await candidateInterpreters(task);
  if (candidates.length === 0) {
    return { available: false, reason: "no Python interpreter is available for optional audio models — set REELTERMINAL_AUDIO_MODELS_PYTHON to an interpreter with the required packages" };
  }
  const scriptInfo = await stat(script);
  const key = `${requiredPackages.join(",")}|${task ?? "default"}|${candidates.map((candidate) => candidate.python).join("|")}|${script}|${scriptInfo.size}|${Math.round(scriptInfo.mtimeMs)}`;
  if (probeCache?.key === key) return probeCache.result;
  let lastReason = "no candidate interpreter could run the audio-model probe";
  for (const candidate of candidates) {
    try {
      const result = await runAudioModelProcess(candidate.python, script, { task: "probe", qwen: task === "caption-qwen" || task === "caption-align" }, { timeoutMs: 180_000 });
      const packages = (result.packages ?? {}) as Record<string, boolean>;
      const missing = requiredPackages.filter((name) => !packages[name]);
      if (missing.length > 0) {
        lastReason = `interpreter "${candidate.python}" cannot import the required audio-model packages (${missing.join(", ")}); install them or point REELTERMINAL_AUDIO_MODELS_PYTHON at an environment that has them`;
        continue;
      }
      const details: AudioModelProbeResult = {
        python: candidate.python,
        pythonVersion: String(result.python ?? "unknown"),
        scriptDir: dirname(script),
        packages,
        versions: (result.versions ?? {}) as Record<string, string | boolean | null>,
      };
      const value = { available: true as const, details };
      probeCache = { key, result: value };
      return value;
    } catch (error) {
      lastReason = `interpreter "${candidate.python}" failed the audio-model probe: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const value = { available: false as const, reason: lastReason };
  probeCache = { key, result: value };
  return value;
}
