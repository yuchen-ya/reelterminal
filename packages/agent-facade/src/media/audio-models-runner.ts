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
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
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
    implemented: false,
    reason: "Not wired into a facade verb yet; the shared worker seam is in place for a later round.",
    validatedPackages: { modelscope: "1.34.0", torch: "2.10.0", soundfile: "0.13.1", numpy: "1.26.4" },
  },
  separation: {
    implemented: false,
    reason: "Not wired into a facade verb yet; the shared worker seam is in place for a later round.",
    validatedPackages: { demucs: "4.x", torch: "2.9.0", soundfile: "0.13.1" },
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

async function candidateInterpreters(): Promise<InterpreterCandidate[]> {
  const candidates: InterpreterCandidate[] = [];
  const explicit = process.env.REELTERMINAL_AUDIO_MODELS_PYTHON ?? process.env.REELTERMINAL_PYTHON_PATH;
  if (explicit && explicit.length > 0) candidates.push({ python: explicit });
  for (const name of ["python3", "python"]) {
    const onPath = await findOnPath(name);
    if (onPath) candidates.push({ python: onPath });
  }
  return candidates;
}

async function resolveScript(): Promise<string | null> {
  const override = process.env.REELTERMINAL_AUDIO_MODELS_SCRIPT_DIR;
  if (override && override.length > 0) {
    const candidate = join(override, "audio_models.py");
    if ((await stat(candidate).catch(() => null))?.isFile()) return candidate;
  }
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  for (const relative of ["../python", "../../python", "../../../python", "../../agent-facade/python"]) {
    const candidate = join(moduleDir, relative, "audio_models.py");
    if ((await stat(candidate).catch(() => null))?.isFile()) return candidate;
  }
  return null;
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

export function clearAudioModelsProbeCacheForTests(): void {
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
  const override = process.env.REELTERMINAL_SENSEVOICE_MODEL_DIR;
  if (override && override.length > 0) return override;
  return join(audioModelsCacheDir(), "models", "iic", "SenseVoiceSmall");
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

export interface SenseVoiceModelStatus {
  readonly path: string;
  readonly present: boolean;
  readonly bytes: number;
  readonly verified: boolean;
  readonly reason: string | null;
}

let modelStatusCache: { readonly key: string; readonly value: SenseVoiceModelStatus } | null = null;

/** Cheap presence/size check for capability reporting (no 936 MB hash). */
export async function senseVoiceModelPresence(): Promise<{ path: string; present: boolean; bytes: number }> {
  const path = join(senseVoiceModelDir(), SENSEVOICE_MODEL.file);
  const info = await stat(path).catch(() => null);
  return { path, present: info?.isFile() === true, bytes: info?.size ?? 0 };
}

/** Verify the pinned weights once per path/size/mtime (hashing 936 MB is cached). */
export async function senseVoiceModelStatus(): Promise<SenseVoiceModelStatus> {
  const directory = senseVoiceModelDir();
  const path = join(directory, SENSEVOICE_MODEL.file);
  const info = await stat(path).catch(() => null);
  const key = `${path}|${info?.size ?? 0}|${Math.round(info?.mtimeMs ?? 0)}`;
  if (modelStatusCache?.key === key) return modelStatusCache.value;
  let value: SenseVoiceModelStatus;
  if (!info?.isFile()) {
    value = {
      path,
      present: false,
      bytes: 0,
      verified: false,
      reason: `SenseVoice model is not present at ${path}. First use needs ${SENSEVOICE_MODEL.bytes} bytes (≈${Math.round(SENSEVOICE_MODEL.bytes / 1_000_000)} MB download, ≈${Math.round(AUDIO_MODEL_COMPONENTS.speechTranscript.estimatedDiskBytes / 1_000_000)} MB disk) from ${SENSEVOICE_MODEL.repo}; set REELTERMINAL_SENSEVOICE_MODEL_DIR to a local copy or authorize the download with transcriptParams.allowModelDownload:true`,
    };
  } else if (info.size !== SENSEVOICE_MODEL.bytes) {
    value = {
      path,
      present: true,
      bytes: info.size,
      verified: false,
      reason: `SenseVoice model at ${path} has ${info.size} bytes, expected ${SENSEVOICE_MODEL.bytes} (${SENSEVOICE_MODEL.repo}); replace it with the pinned weights`,
    };
  } else {
    const digest = await sha256File(path);
    value = digest === SENSEVOICE_MODEL.sha256
      ? { path, present: true, bytes: info.size, verified: true, reason: null }
      : {
          path,
          present: true,
          bytes: info.size,
          verified: false,
          reason: `SenseVoice model at ${path} does not match the pinned ${SENSEVOICE_MODEL.repo} weights (sha256 ${digest.slice(0, 12)}…); replace it from the pinned source`,
        };
  }
  modelStatusCache = { key, value };
  return value;
}

/** Clear the sha cache after tests change the model path or file. */
export function clearSenseVoiceModelStatusCacheForTests(): void {
  modelStatusCache = null;
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
        if (event.result === null || typeof event.result !== "object") {
          stop("Local audio-model worker returned no result object");
          return;
        }
        finish(null, event.result as Record<string, unknown>);
        return;
      }
      stop(`Local audio-model worker produced an unknown event: ${String(event.event)}`);
    });
    child.on("close", (code) => {
      if (settled) return;
      finish(new FacadeError(
        "JOB_FAILED",
        `Local audio-model worker exited (code ${String(code)}) without a terminal event${stderrTail.trim() ? `: ${stderrTail.trim().slice(-1500)}` : ""}`,
        { stderrTail: stderrTail.slice(-4000) },
      ));
    });
  });
}

/** Test seam for the process runner (the transcript kernel takes an injected transcribe). */
export async function runAudioModelTask(
  request: Record<string, unknown>,
  options: WorkerOptions = {},
): Promise<Record<string, unknown>> {
  const runtime = await probeAudioModelsRuntime();
  if (!runtime.available) throw new FacadeError("UNSUPPORTED", runtime.reason);
  return runAudioModelProcess(runtime.details.python, join(runtime.details.scriptDir, "audio_models.py"), request, options);
}

/** Probe once per process: interpreter + script + import availability. */
export async function probeAudioModelsRuntime(): Promise<
  { available: true; details: AudioModelProbeResult } | { available: false; reason: string }
> {
  if (probeOverride) return probeOverride();
  const script = await resolveScript();
  if (!script) {
    return { available: false, reason: "the audio-model worker script audio_models.py was not found beside this build — set REELTERMINAL_AUDIO_MODELS_SCRIPT_DIR or restore packages/agent-facade/python" };
  }
  const candidates = await candidateInterpreters();
  if (candidates.length === 0) {
    return { available: false, reason: "no Python interpreter is available for optional audio models — set REELTERMINAL_AUDIO_MODELS_PYTHON to an interpreter with funasr/modelscope/torch/soundfile" };
  }
  const scriptInfo = await stat(script);
  const key = `${candidates.map((candidate) => candidate.python).join("|")}|${script}|${scriptInfo.size}|${Math.round(scriptInfo.mtimeMs)}`;
  if (probeCache?.key === key) return probeCache.result;
  let lastReason = "no candidate interpreter could run the audio-model probe";
  for (const candidate of candidates) {
    try {
      const result = await runAudioModelProcess(candidate.python, script, { task: "probe" }, { timeoutMs: 180_000 });
      const packages = (result.packages ?? {}) as Record<string, boolean>;
      if (!packages.funasr || !packages.modelscope || !packages.torch || !packages.soundfile) {
        lastReason = `interpreter "${candidate.python}" cannot import the required audio-model packages (funasr/modelscope/torch/soundfile); install them or point REELTERMINAL_AUDIO_MODELS_PYTHON at an environment that has them`;
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
