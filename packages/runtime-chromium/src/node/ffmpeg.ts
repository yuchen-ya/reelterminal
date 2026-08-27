/**
 * ffmpeg/ffprobe resolution + process helpers (ADR 0002 #4).
 *
 * Binaries come ONLY from explicit configuration or the system PATH — never
 * from the repository (no binaries are committed) and never from a network
 * fetch. Every invocation is spawned WITHOUT a shell (argument array, no
 * string interpolation), so paths with spaces/metacharacters cannot become
 * command injection.
 */
import { spawn } from "node:child_process";
import { delimiter, extname, join } from "node:path";
import { stat, readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

export interface FfmpegBinaries {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  readonly ffmpegVersion: string;
  readonly ffprobeVersion: string;
}

export interface FfmpegConfig {
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
}

const VERSION_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 120_000;
const MAX_STDIO_BYTES = 16 * 1024 * 1024;

export class FfmpegError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = "FfmpegError";
    this.stderr = stderr.slice(0, 4096);
  }
}

/** Spawn without a shell; capture capped stdout/stderr; reject on non-zero. */
export function runProcess(
  exe: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<{ stdout: Buffer; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const maxOutput = options.maxOutputBytes ?? MAX_STDIO_BYTES;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(exe, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new FfmpegError(`${exe} timed out after ${timeoutMs} ms`, stderrText()));
    }, timeoutMs);
    const stderrText = () =>
      Buffer.concat(stderrChunks).toString("utf8").slice(-8192);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxOutput) stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new FfmpegError(`failed to spawn ${exe}: ${error.message}`, stderrText()));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise({ stdout: Buffer.concat(stdoutChunks), stderr: stderrText() });
      } else {
        reject(
          new FfmpegError(
            `${exe} exited with code ${code}: ${args.join(" ")}`,
            stderrText(),
          ),
        );
      }
    });
  });
}

async function versionOf(exe: string): Promise<string | null> {
  try {
    const { stdout } = await runProcess(exe, ["-version"], {
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    const firstLine = stdout.toString("utf8").split("\n")[0]?.trim();
    return firstLine && firstLine.length > 0 ? firstLine : null;
  } catch {
    return null;
  }
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const fileStat = await stat(candidate);
    return fileStat.isFile();
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
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir}/${name}${ext.toLowerCase()}`;
      if (await isExecutableFile(candidate)) return candidate;
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
): Promise<{ path: string; version: string } | null> {
  const candidates: string[] = [];
  if (explicitPath !== undefined && explicitPath.length > 0) {
    candidates.push(explicitPath);
  } else {
    const onPath = await findOnPath(name);
    if (onPath) candidates.push(onPath);
  }
  for (const candidate of candidates) {
    if (!(await isExecutableFile(candidate))) continue;
    const version = await versionOf(candidate);
    if (version !== null) return { path: candidate, version };
  }
  return null;
}

/**
 * Resolve ffmpeg + ffprobe from explicit config or PATH, verifying each
 * binary actually runs (`-version`). Returns null when either is missing —
 * callers turn that into an honest "unavailable" capability, never a guess.
 */
export async function resolveFfmpegBinaries(
  config: FfmpegConfig = {},
): Promise<FfmpegBinaries | null> {
  const [ffmpeg, ffprobe] = await Promise.all([
    resolveOne("ffmpeg", config.ffmpegPath),
    resolveOne("ffprobe", config.ffprobePath),
  ]);
  if (!ffmpeg || !ffprobe) return null;
  return {
    ffmpeg: ffmpeg.path,
    ffprobe: ffprobe.path,
    ffmpegVersion: ffmpeg.version,
    ffprobeVersion: ffprobe.version,
  };
}

/* ------------------------------------------------------------------ */
/* ffprobe                                                             */
/* ------------------------------------------------------------------ */

export interface FfprobeStream {
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly avg_frame_rate?: string;
  readonly r_frame_rate?: string;
  readonly nb_frames?: string;
  readonly nb_read_frames?: string;
  readonly duration?: string;
  readonly pix_fmt?: string;
}

export interface FfprobeOutput {
  readonly streams?: FfprobeStream[];
  readonly format?: {
    readonly format_name?: string;
    readonly duration?: string;
    readonly size?: string;
  };
}

/** Structured probe; `-count_frames` gives the real decoded frame count. */
export async function ffprobeJson(
  ffprobePath: string,
  filePath: string,
  options: { countFrames?: boolean } = {},
): Promise<FfprobeOutput> {
  const args = ["-v", "error"];
  if (options.countFrames) args.push("-count_frames");
  args.push("-show_format", "-show_streams", "-of", "json", filePath);
  const { stdout } = await runProcess(ffprobePath, args);
  try {
    return JSON.parse(stdout.toString("utf8")) as FfprobeOutput;
  } catch (error) {
    throw new FfmpegError(
      `ffprobe produced invalid JSON for ${filePath}: ${error instanceof Error ? error.message : error}`,
      "",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Frame extraction (raw RGBA — no image codec needed on the Node side) */
/* ------------------------------------------------------------------ */

/** Hard sanity cap for one extracted RGBA frame (512 MiB ≈ 8K×8K). */
const MAX_FRAME_BYTES = 512 * 1024 * 1024;

/**
 * Extract one frame as raw RGBA bytes. Seeking is accurate (decode-then-seek)
 * so the extracted frame is the frame AT timeSec, not the nearest keyframe.
 * The frame streams to a temp file (NOT stdout), so arbitrarily large rasters
 * never hit a stdio cap; the byte count is validated exactly.
 */
export async function extractFrameRgba(
  ffmpegPath: string,
  inputPath: string,
  timeSec: number,
  width: number,
  height: number,
  options: { timeoutMs?: number } = {},
): Promise<Buffer> {
  const expected = width * height * 4;
  if (expected <= 0 || expected > MAX_FRAME_BYTES) {
    throw new FfmpegError(
      `refusing to extract a ${width}x${height} RGBA frame (${expected} bytes; cap is ${MAX_FRAME_BYTES})`,
      "",
    );
  }
  const tempDir = await mkdtemp(join(tmpdir(), "oframe-"));
  const rawPath = join(tempDir, "frame.rgba");
  try {
    const args = [
      "-v", "error",
      "-i", inputPath,
      "-ss", String(timeSec),
      "-frames:v", "1",
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      rawPath,
    ];
    await runProcess(ffmpegPath, args, options);
    const raw = await readFile(rawPath);
    if (raw.length !== expected) {
      throw new FfmpegError(
        `frame extraction returned ${raw.length} bytes, expected ${expected} (${width}x${height} RGBA) — the source may have no frame at t=${timeSec}`,
        "",
      );
    }
    return raw;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Frames → MP4 encoding (Route F fallback)                            */
/* ------------------------------------------------------------------ */

export interface FramesEncoderOptions {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  /** x264 CRF; 18 is visually transparent at these sizes. */
  readonly crf?: number;
  readonly preset?: string;
  readonly destPath: string;
}

export interface FramesEncoderHandle {
  /** Feed one PNG frame. Resolves when ffmpeg accepted the bytes. */
  writeFrame(png: Buffer): Promise<void>;
  /** Close input and await the finished MP4. Resolves with bytes written. */
  finish(): Promise<number>;
  /** Abort immediately: kill the process and report through finish(). */
  abort(): void;
  readonly stderrTail: () => string;
}

/**
 * Stream PNG frames into a long-running ffmpeg (`image2pipe` → libx264 →
 * MP4). Frames flow one at a time with write backpressure — the whole video
 * never accumulates in Node memory either.
 */
export function startFramesEncoder(
  ffmpegPath: string,
  options: FramesEncoderOptions,
): FramesEncoderHandle {
  const args = [
    "-y",
    "-f", "image2pipe",
    "-framerate", String(options.frameRate),
    "-i", "pipe:0",
    "-an",
    "-c:v", "libx264",
    "-preset", options.preset ?? "veryfast",
    "-crf", String(options.crf ?? 18),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    // Explicit format: destPath may be a `.part` temp name, whose extension
    // would break ffmpeg's format inference.
    "-f", "mp4",
    options.destPath,
  ];
  const child = spawn(ffmpegPath, args, {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "ignore", "pipe"],
  });
  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const stderrTail = () =>
    Buffer.concat(stderrChunks).toString("utf8").slice(-4096);

  let aborted = false;
  const exitPromise = new Promise<{ code: number | null; error: Error | null }>(
    (resolvePromise) => {
      child.on("error", (error) => resolvePromise({ code: null, error }));
      child.on("close", (code) => resolvePromise({ code, error: null }));
    },
  );

  return {
    stderrTail,
    writeFrame(png: Buffer): Promise<void> {
      return new Promise((resolvePromise, reject) => {
        if (aborted || child.stdin.destroyed) {
          reject(new FfmpegError("encoder stdin is closed", stderrTail()));
          return;
        }
        child.stdin.write(png, (error) => {
          if (error) {
            reject(new FfmpegError(`failed to feed encoder: ${error.message}`, stderrTail()));
          } else {
            resolvePromise();
          }
        });
      });
    },
    async finish(): Promise<number> {
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
      const { code, error } = await exitPromise;
      if (aborted) {
        throw new FfmpegError("encoding aborted", stderrTail());
      }
      if (error) {
        throw new FfmpegError(`ffmpeg failed: ${error.message}`, stderrTail());
      }
      if (code !== 0) {
        throw new FfmpegError(`ffmpeg exited with code ${code}`, stderrTail());
      }
      const fileStat = await stat(options.destPath);
      return fileStat.size;
    },
    abort(): void {
      aborted = true;
      try {
        child.stdin.destroy();
      } catch {
        /* already closed */
      }
      child.kill("SIGKILL");
    },
  };
}

/** Container the acceptance contract demands — checked from ffprobe facts. */
export function looksLikeMp4(formatName: string | undefined): boolean {
  if (!formatName) return false;
  return formatName.split(",").some((token) => token.trim() === "mp4" || token.trim() === "mov");
}

export function hasImageExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".bmp";
}
