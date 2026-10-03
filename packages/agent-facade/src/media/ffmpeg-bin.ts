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

/** Spawn without a shell; capture capped stdout/stderr; honor abort + timeout. */
export function runToolProcess(
  exe: string,
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
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
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
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
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        stop(new FfmpegToolError("tool process output exceeded the resource cap"));
      } else {
        stdoutChunks.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
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
export function resolveToolFfmpeg(): Promise<FfmpegBinaries | null> {
  cached ??= (async () => {
    const [ffmpeg, ffprobe] = await Promise.all([
      resolveOne("ffmpeg", process.env.REELTERMINAL_FFMPEG_PATH),
      resolveOne("ffprobe", process.env.REELTERMINAL_FFPROBE_PATH),
    ]);
    if (!ffmpeg || !ffprobe) return null;
    return { ffmpeg, ffprobe };
  })();
  return cached;
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
