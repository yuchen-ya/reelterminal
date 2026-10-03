/**
 * Dependency probing + process discipline for the facade's OpenCV-backed
 * tools (image.align, motion.track).
 *
 * The interpreter comes ONLY from explicit configuration
 * (REELTERMINAL_OPENCV_PYTHON or REELTERMINAL_PYTHON_PATH) or the system
 * PATH — never a hardcoded conda path, never a network download. A candidate
 * interpreter is accepted only when it can actually `import cv2, numpy`,
 * so a Python without OpenCV reports as honestly unavailable instead of
 * failing mid-task. Worker scripts are bundled with the package
 * (`packages/agent-facade/python/*.py`) and located relative to this module
 * (source layout), beside the bundled desktop main (dist/python — copied by
 * apps/desktop/scripts/link-live-runtime-deps.mjs), or via an explicit
 * REELTERMINAL_OPENCV_SCRIPT_DIR override.
 *
 * The protocol is JSON over stdio: the request goes in on stdin (no argv
 * length/quoting limits), the response comes out on stdout as one JSON
 * document. Everything is spawned WITHOUT a shell (argument array), the
 * same discipline as media/ffmpeg-bin.ts.
 */
import { stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FacadeError } from "../errors";
import { runToolProcess } from "./ffmpeg-bin";

export interface OpenCvRuntime {
  readonly python: string;
  readonly cv2Version: string;
  readonly numpyVersion: string;
  /** Where the worker scripts were actually found. */
  readonly scriptDir: string;
}

const IMPORT_PROBE_SNIPPET =
  "import sys, cv2, numpy; print('cv2', cv2.__version__); print('numpy', numpy.__version__)";

/** PATH lookup honoring PATHEXT on Windows. No shell involved. */
async function findOnPath(name: string): Promise<string | null> {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return null;
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = ext ? `${dir}/${name}${ext}` : `${dir}/${name}`;
      const info = await stat(candidate).catch(() => null);
      if (info?.isFile()) return candidate;
    }
  }
  return null;
}

interface InterpreterCandidate {
  readonly python: string;
  /** Extra leading argv (e.g. ["-3"] for the Windows py launcher). */
  readonly launcherArgs?: readonly string[];
}

async function candidateInterpreters(): Promise<InterpreterCandidate[]> {
  const candidates: InterpreterCandidate[] = [];
  const explicit =
    process.env.REELTERMINAL_OPENCV_PYTHON ?? process.env.REELTERMINAL_PYTHON_PATH;
  if (explicit && explicit.length > 0) {
    candidates.push({ python: explicit });
  }
  for (const name of ["python3", "python"]) {
    const onPath = await findOnPath(name);
    if (onPath) candidates.push({ python: onPath });
  }
  return candidates;
}

async function probeInterpreter(
  candidate: InterpreterCandidate,
): Promise<{ cv2Version: string; numpyVersion: string } | null> {
  try {
    const { stdout } = await runToolProcess(
      candidate.python,
      [...(candidate.launcherArgs ?? []), "-c", IMPORT_PROBE_SNIPPET],
      { timeoutMs: 30_000 },
    );
    const cv2 = /cv2 (\S+)/.exec(stdout.toString("utf8"))?.[1];
    const numpy = /numpy (\S+)/.exec(stdout.toString("utf8"))?.[1];
    if (!cv2 || !numpy) return null;
    return { cv2Version: cv2, numpyVersion: numpy };
  } catch {
    return null;
  }
}

/** The first interpreter that actually imports cv2+numpy; null when none. */
async function findInterpreter(): Promise<
  { python: string; cv2Version: string; numpyVersion: string } | null
> {
  for (const candidate of await candidateInterpreters()) {
    const probed = await probeInterpreter(candidate);
    if (probed) return { python: candidate.python, ...probed };
  }
  return null;
}

async function isFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info?.isFile() ?? false;
}

/**
 * Worker-script location: explicit override first, then the package source
 * tree (src/media/../../python), then a dist copy beside the bundled desktop
 * main (dist/main/../../python — link-live-runtime-deps.mjs writes it).
 * Both relative forms resolve from this module's own URL, so the lookup
 * follows wherever this code actually runs from.
 */
export async function resolveOpenCvScript(name: string): Promise<string | null> {
  const override = process.env.REELTERMINAL_OPENCV_SCRIPT_DIR;
  if (override && override.length > 0) {
    const candidate = join(override, name);
    if (await isFile(candidate)) return candidate;
  }
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  for (const relative of ["../../python", "../../../python"]) {
    const candidate = join(moduleDir, relative, name);
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

let cachedRuntime: Promise<OpenCvRuntime | null> | null = null;

/**
 * Resolve the OpenCV runtime (interpreter + cv2 import + script directory).
 * Returns null when any piece is missing — callers turn that into an honest
 * UNSUPPORTED error and an unavailable capabilities entry, never a guess.
 */
export function resolveOpenCvRuntime(): Promise<OpenCvRuntime | null> {
  cachedRuntime ??= (async () => {
    const interpreter = await findInterpreter();
    if (!interpreter) return null;
    const script = await resolveOpenCvScript("align.py");
    if (!script) return null;
    return {
      python: interpreter.python,
      cv2Version: interpreter.cv2Version,
      numpyVersion: interpreter.numpyVersion,
      scriptDir: dirname(script),
    };
  })();
  return cachedRuntime;
}

/** Preflight shape shared with capabilities reporting. */
export async function opencvToolPreflight(): Promise<
  { available: true; details: { python: string; cv2Version: string; numpyVersion: string; scriptDir: string } }
  | { available: false; reason: string }
> {
  const runtime = await resolveOpenCvRuntime();
  if (!runtime) {
    const explicit =
      process.env.REELTERMINAL_OPENCV_PYTHON ?? process.env.REELTERMINAL_PYTHON_PATH;
    return {
      available: false,
      reason: explicit
        ? `REELTERMINAL_OPENCV_PYTHON/"REELTERMINAL_PYTHON_PATH" interpreter "${explicit}" cannot import cv2+numpy (or does not run); install opencv-python and numpy for it, or point the variable at an interpreter that has them`
        : "no interpreter on PATH (python3/python) can import cv2+numpy — install Python with opencv-python and numpy, or set REELTERMINAL_OPENCV_PYTHON to an interpreter that has them",
    };
  }
  return {
    available: true,
    details: {
      python: runtime.python,
      cv2Version: runtime.cv2Version,
      numpyVersion: runtime.numpyVersion,
      scriptDir: runtime.scriptDir,
    },
  };
}

/** One worker response. result is the script-defined payload on success. */
export interface OpenCvResponse {
  readonly result: Record<string, unknown>;
  readonly stderr: string;
}

async function spawnWorker(
  exe: string,
  scriptPath: string,
  request: Record<string, unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal },
): Promise<{ stdout: Buffer; stderr: string }> {
  return runToolProcess(exe, ["-I", scriptPath], { ...options, input: JSON.stringify(request) });
}

/**
 * Protocol core, injectable for tests: JSON request on stdin, JSON response
 * on stdout. Script-reported estimation failures come back as
 * { status: "failed", ... } INSIDE result (the caller decides how honest
 * failure is surfaced); a crash, a nonzero exit, or invalid JSON throws.
 */
export async function runWorkerProtocol(
  exe: string,
  scriptPath: string,
  request: Record<string, unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
  spawn: typeof spawnWorker = spawnWorker,
): Promise<OpenCvResponse> {
  const { stdout, stderr } = await spawn(exe, scriptPath, request, options);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.toString("utf8"));
  } catch (error) {
    throw new FacadeError(
      "JOB_FAILED",
      `OpenCV worker "${scriptPath}" produced invalid JSON on stdout: ${error instanceof Error ? error.message : String(error)}`,
      { stderrTail: stderr.slice(-2000) },
    );
  }
  const record = parsed as { ok?: unknown; result?: unknown; error?: { message?: unknown } } | null;
  if (typeof parsed !== "object" || parsed === null || record!.ok !== true ||
    typeof record!.result !== "object" || record!.result === null) {
    throw new FacadeError(
      "JOB_FAILED",
      `OpenCV worker "${scriptPath}" failed: ${typeof record?.error?.message === "string" ? record.error.message : "no error detail reported"}`,
      { stderrTail: stderr.slice(-2000) },
    );
  }
  return { result: record!.result as Record<string, unknown>, stderr };
}

/**
 * Run one bundled worker script with the probed OpenCV runtime.
 */
export async function runOpenCvScript(
  scriptName: string,
  request: Record<string, unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<OpenCvResponse> {
  const runtime = await resolveOpenCvRuntime();
  if (!runtime) {
    const pre = await opencvToolPreflight();
    throw new FacadeError(
      "UNSUPPORTED",
      pre.available ? "OpenCV runtime vanished between preflight and call" : pre.reason,
    );
  }
  const script = await resolveOpenCvScript(scriptName);
  if (!script) {
    throw new FacadeError(
      "JOB_FAILED",
      `OpenCV worker script "${scriptName}" is not installed beside this build (looked in REELTERMINAL_OPENCV_SCRIPT_DIR and the package python/ directory)`,
    );
  }
  return runWorkerProtocol(runtime.python, script, request, options);
}
