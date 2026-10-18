/**
 * FFmpeg/FFprobe process discipline for the facade's frame-exact tools.
 *
 * Binaries come ONLY from explicit configuration
 * (REELTERMINAL_FFMPEG_PATH / REELTERMINAL_FFPROBE_PATH) or the system PATH —
 * never from the repository and never from a network fetch. Every invocation
 * is spawned WITHOUT a shell (argument array, no string interpolation), so
 * paths with spaces, Chinese characters or metacharacters cannot become
 * command injection. The same discipline as runtime-chromium's ffmpeg.ts,
 * kept self-contained because the facade must not depend on a runtime package.
 */
import { readAudioEnvironment } from "./audio-environment-config";
import { spawn } from "node:child_process";
import { delimiter } from "node:path";
import { stat } from "node:fs/promises";

export interface FfmpegBinaries {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

export class FfmpegToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FfmpegToolError";
  }
}

export interface RunResult {
  readonly stdout: Buffer;
  readonly stderr: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/**
 * stderr carries showinfo logs that callers parse; long sequential decodes
 * legitimately produce tens of MiB. The cap exists so a runaway process
 * cannot grow the buffer without bound — past it the tool fails loudly
 * instead of exhausting memory.
 */
const MAX_STDERR_BYTES = 64 * 1024 * 1024;

/** Spawn without a shell; capture capped stdout/stderr; honor abort + timeout. */
export function runToolProcess(
  exe: string,
  args: readonly string[],
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    input?: string;
    /** Observes stdout chunks as they arrive (e.g. -progress parsing); the buffer is still returned. */
    onStdoutChunk?: (chunk: Buffer) => void;
  } = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(new FfmpegToolError("Cancelled before the process started"));
      return;
    }
    const child = spawn(exe, [...args], {
      shell: false,
      windowsHide: true,
      stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"] as const,
    });
    if (options.input !== undefined) {
      child.stdin!.on("error", () => {
        // EPIPE when the child exits before draining stdin: the close
        // handler reports the real exit status, so the pipe error itself
        // is not the failure.
      });
      child.stdin!.end(options.input);
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let failure: Error | undefined;
    const stderrText = () => Buffer.concat(stderrChunks).toString("utf8");
    const stop = (error: Error) => {
      if (settled) return;
      failure = error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => stop(new FfmpegToolError(`${exe} timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    const onAbort = () => stop(new FfmpegToolError("Cancelled"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        stop(new FfmpegToolError("tool process output exceeded the resource cap"));
      } else {
        stdoutChunks.push(chunk);
        options.onStdoutChunk?.(chunk);
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        stop(new FfmpegToolError("tool process stderr exceeded the resource cap"));
      } else {
        stderrChunks.push(chunk);
      }
    });
    child.on("error", (error) => {
      if (!settled) failure = failure ?? new FfmpegToolError(`failed to spawn ${exe}: ${error.message}`);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (code === 0) resolvePromise({ stdout: Buffer.concat(stdoutChunks), stderr: stderrText() });
      else reject(new FfmpegToolError(`${exe} exited with code ${code}: ${stderrText().slice(-4000)}`));
    });
  });
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    return info.isFile();
  } catch {
    return false;
  }
}

/** PATH lookup honoring PATHEXT on Windows. No shell involved. */
async function findOnPath(name: "ffmpeg" | "ffprobe"): Promise<string | null> {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return null;
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const lower = `${dir}/${name}${ext.toLowerCase()}`;
      if (await isExecutableFile(lower)) return lower;
      if (ext && (await isExecutableFile(`${dir}/${name}${ext}`))) {
        return `${dir}/${name}${ext}`;
      }
    }
  }
  return null;
}

async function resolveOne(
  name: "ffmpeg" | "ffprobe",
  explicitPath: string | undefined,
): Promise<string | null> {
  const candidates: string[] = [];
  if (explicitPath && explicitPath.length > 0) candidates.push(explicitPath);
  else {
    const onPath = await findOnPath(name);
    if (onPath) candidates.push(onPath);
  }
  for (const candidate of candidates) {
    if (!(await isExecutableFile(candidate))) continue;
    try {
      // Verify the binary actually runs; a broken install must surface as
      // "unavailable", never as a mid-task spawn crash.
      await runToolProcess(candidate, ["-version"], { timeoutMs: 15_000 });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

let cached: Promise<FfmpegBinaries | null> | null = null;

/**
 * Resolve ffmpeg + ffprobe from explicit configuration or PATH. Returns null
 * when either is missing — callers turn that into an honest UNSUPPORTED
 * error and an unavailable capabilities entry, never a guess.
 */
let cachedConfigKey = "";
export function clearToolFfmpegCache(): void {
  cached = null;
  cachedVersion = null;
}

export function resolveToolFfmpeg(): Promise<FfmpegBinaries | null> {
  const config = readAudioEnvironment();
  const ffmpegPath = config.ffmpeg ?? process.env.REELTERMINAL_FFMPEG_PATH;
  const ffprobePath = config.ffprobe ?? process.env.REELTERMINAL_FFPROBE_PATH;
  const key = JSON.stringify([ffmpegPath, ffprobePath, process.env.PATH]);
  if (key !== cachedConfigKey) { cached = null; cachedVersion = null; cachedConfigKey = key; }

  cached ??= (async () => {
    const [ffmpeg, ffprobe] = await Promise.all([
      resolveOne("ffmpeg", ffmpegPath),
      resolveOne("ffprobe", ffprobePath),
    ]);
    if (!ffmpeg || !ffprobe) return null;
    return { ffmpeg, ffprobe };
  })();
  return cached;
}

let cachedVersion: Promise<string> | null = null;

/**
 * First line of `ffmpeg -version` (e.g. "ffmpeg version 7.1-full_build-www.gyan.dev"),
 * memoized for the session. Used as the algorithm-runtime component of derived
 * audio cache keys; resolves to "unavailable"/"unknown" instead of throwing so
 * a probe hiccup never fails a job that does not need the version.
 */
export async function resolveFfmpegVersion(): Promise<string> {
  await resolveToolFfmpeg();
  cachedVersion ??= (async () => {
    const binaries = await resolveToolFfmpeg();
    if (!binaries) return "unavailable";
    try {
      const { stdout } = await runToolProcess(binaries.ffmpeg, ["-hide_banner", "-version"], { timeoutMs: 15_000 });
      return stdout.toString("utf8").split("\n", 1)[0]?.trim() || "unknown";
    } catch {
      return "unknown";
    }
  })();
  return cachedVersion;
}

/** Preflight shape shared with capabilities reporting. */
export async function ffmpegToolPreflight(): Promise<
  { available: true; details: { ffmpeg: string; ffprobe: string } } | { available: false; reason: string }
> {
  const binaries = await resolveToolFfmpeg();
  if (!binaries) {
    return {
      available: false,
      reason:
        "frame-exact tools need ffmpeg + ffprobe — install them on PATH or set REELTERMINAL_FFMPEG_PATH / REELTERMINAL_FFPROBE_PATH",
    };
  }
  return { available: true, details: { ffmpeg: binaries.ffmpeg, ffprobe: binaries.ffprobe } };
}

/**
 * drawtext without an explicit fontfile can crash (fontconfig with no
 * config), so contact-sheet labels probe a per-platform list of known font
 * files. Absence is honest degradation, never a failure.
 */
const FONT_CANDIDATES: readonly string[] =
  process.platform === "win32"
    ? ["C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/arial.ttf"]
    : process.platform === "darwin"
      ? [
          "/System/Library/Fonts/Supplemental/Arial.ttf",
          "/System/Library/Fonts/Helvetica.ttc",
          "/Library/Fonts/Arial.ttf",
        ]
      : [
          "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
          "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
          "/usr/share/fonts/dejavu/DejaVuSans.ttf",
          "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
        ];

let cachedFont: string | null | undefined;

/** First existing font file usable for drawtext labels; null when none. */
export async function probeLabelFont(): Promise<string | null> {
  if (cachedFont !== undefined) return cachedFont;
  for (const candidate of FONT_CANDIDATES) {
    if (await isExecutableFile(candidate)) {
      cachedFont = candidate;
      return candidate;
    }
  }
  cachedFont = null;
  return null;
}
