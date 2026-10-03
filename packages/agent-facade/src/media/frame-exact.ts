/**
 * Frame-exact algorithms over local FFmpeg/FFprobe.
 *
 * Coordinates: frame numbers are ZERO-BASED DECODE/PRESENTATION indices of
 * the source video (the n-th frame when played); ranges are HALF-OPEN
 * [startFrame, endFrame). Extraction selects on those indices directly — it
 * never approximates with `seconds × nominal rate`. Every extracted frame's
 * actual PTS comes back from showinfo, and seconds↔frames conversion is only
 * claimed when the stream's frame timing was verified CFR; VFR streams get
 * real PTS values and honest nulls instead of guessed indices.
 *
 * All processes run through runToolProcess: argument arrays, no shell,
 * timeouts, abort support. Paths with spaces/Chinese characters are ordinary
 * argv values.
 */
import { mkdir, readdir, rename, rm, stat, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { FacadeError } from "../errors";
import { runToolProcess } from "./ffmpeg-bin";

/* ------------------------------------------------------------------ */
/* ffprobe facts                                                       */
/* ------------------------------------------------------------------ */

export interface ProbeStreamJson {
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly r_frame_rate?: string;
  readonly avg_frame_rate?: string;
  readonly nb_frames?: string;
  readonly nb_read_frames?: string;
  readonly duration?: string;
  readonly time_base?: string;
  readonly pix_fmt?: string;
}

export interface ProbeFormatJson {
  readonly duration?: string;
  readonly format_name?: string;
}

export interface ProbeJson {
  readonly streams?: readonly ProbeStreamJson[];
  readonly format?: ProbeFormatJson;
}

export function parseFrameRate(raw: string | undefined): number | null {
  if (!raw) return null;
  const [numRaw, denRaw] = raw.split("/");
  const num = Number(numRaw);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (denRaw === undefined) return num;
  const den = Number(denRaw);
  if (!Number.isFinite(den) || den <= 0) return null;
  return num / den;
}

export async function ffprobeJson(
  ffprobe: string,
  filePath: string,
  options: { countFrames?: boolean; readIntervalsSec?: number; signal?: AbortSignal } = {},
): Promise<ProbeJson> {
  const args = ["-v", "error", "-select_streams", "v:0"];
  if (options.readIntervalsSec !== undefined) {
    args.push("-read_intervals", `%+${options.readIntervalsSec}`);
  }
  if (options.countFrames) args.push("-count_frames");
  args.push("-show_entries",
    "stream=codec_name,codec_type,width,height,r_frame_rate,avg_frame_rate,nb_frames,nb_read_frames,duration,time_base,pix_fmt",
    "-show_format", "-of", "json", filePath);
  const { stdout } = await runToolProcess(ffprobe, args, { signal: options.signal });
  try {
    return JSON.parse(stdout.toString("utf8")) as ProbeJson;
  } catch (error) {
    throw new FacadeError("JOB_FAILED", `ffprobe produced invalid JSON for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** How the frame timing of a stream was established. */
export interface FrameTimingAssessment {
  readonly timing: "cfr" | "vfr" | "unknown";
  /** Verified constant rate when timing === "cfr"; nominal otherwise. */
  readonly fps: number | null;
  readonly method: string;
  readonly sampledFrameCount: number;
}

export interface VideoFacts {
  readonly width: number;
  readonly height: number;
  readonly codec: string | null;
  readonly durationSec: number;
  readonly rFrameRate: number | null;
  readonly avgFrameRate: number | null;
  readonly timeBase: string | null;
  readonly pixFmt: string | null;
  /** Header nb_frames (instant) — may be absent. */
  readonly headerFrameCount: number | null;
  /** Decoded nb_read_frames (exact) — only computed when requested. */
  readonly decodedFrameCount: number | null;
  readonly timing: FrameTimingAssessment;
}

/**
 * Sample real frame PTS to tell CFR from VFR. CFR requires BOTH a constant
 * sampled delta AND agreement with the header rates — a nominal rate alone
 * proves nothing (that is exactly the approximation this module refuses to
 * make for seconds→frame claims).
 */
export async function assessFrameTiming(
  ffprobe: string,
  filePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<FrameTimingAssessment> {
  const sampled = await ffprobeJson(ffprobe, filePath, { readIntervalsSec: 3, signal: options.signal });
  const stream = sampled.streams?.[0];
  const csv = await runToolProcess(
    ffprobe,
    ["-v", "error", "-select_streams", "v:0", "-read_intervals", "%+3",
      "-show_entries", "frame=pts_time", "-of", "csv=p=0", filePath],
    { signal: options.signal },
  );
  const pts = csv.stdout
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0) // the trailing empty line is Number("") === 0, not a frame
    .map((line) => Number(line.trim().replace(/,$/, "")))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (pts.length < 3) {
    return {
      timing: "unknown",
      fps: parseFrameRate(stream?.avg_frame_rate ?? stream?.r_frame_rate),
      method: `only ${pts.length} sampled frame PTS; cannot verify constant spacing`,
      sampledFrameCount: pts.length,
    };
  }
  const deltas: number[] = [];
  for (let i = 1; i < pts.length; i++) deltas.push(pts[i]! - pts[i - 1]!);
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)]!;
  const tolerance = Math.max(median * 0.05, 1e-6);
  const constant = deltas.every((delta) => Math.abs(delta - median) <= tolerance);
  const sampledFps = median > 0 ? 1 / median : null;
  const rRate = parseFrameRate(stream?.r_frame_rate);
  const avgRate = parseFrameRate(stream?.avg_frame_rate);
  const headerAgrees =
    rRate !== null && avgRate !== null && Math.abs(rRate - avgRate) / avgRate < 0.02;
  if (constant && sampledFps !== null && headerAgrees && Math.abs(sampledFps - avgRate!) / avgRate! < 0.02) {
    return {
      timing: "cfr",
      fps: avgRate,
      method: `${pts.length} sampled frame PTS spaced ${median.toFixed(6)}s apart, agreeing with header r/avg_frame_rate`,
      sampledFrameCount: pts.length,
    };
  }
  return {
    timing: "vfr",
    fps: headerAgrees ? avgRate : null,
    method: constant
      ? "sampled PTS spacing is constant but disagrees with the header rates"
      : `sampled PTS spacing varies (min ${deltas[0]!.toFixed(6)}s, max ${deltas[deltas.length - 1]!.toFixed(6)}s)`,
    sampledFrameCount: pts.length,
  };
}

const COUNT_FRAMES_MAX_DURATION_SEC = 600;

export async function probeVideoFacts(
  ffprobe: string,
  filePath: string,
  options: { decodedFrameCount?: boolean; signal?: AbortSignal } = {},
): Promise<VideoFacts> {
  let basic: ProbeJson;
  try {
    basic = await ffprobeJson(ffprobe, filePath, { signal: options.signal });
  } catch (error) {
    // ffprobe's own nonzero exit (invalid data, missing file…) becomes the
    // facade's honest INVALID_PARAMS instead of a raw process error.
    throw new FacadeError(
      "INVALID_PARAMS",
      `cannot probe ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const stream = basic.streams?.find((s) => s.codec_type === "video") ?? basic.streams?.[0];
  if (!stream || !stream.width || !stream.height) {
    throw new FacadeError("INVALID_PARAMS", `no decodable video stream in ${filePath}`);
  }
  const formatDuration = Number(basic.format?.duration);
  const streamDuration = Number(stream.duration);
  const durationSec = Number.isFinite(formatDuration) && formatDuration > 0
    ? formatDuration
    : Number.isFinite(streamDuration) && streamDuration > 0
      ? streamDuration
      : 0;
  const header = stream.nb_frames !== undefined && stream.nb_frames !== "N/A"
    ? Number(stream.nb_frames)
    : null;
  let decoded: number | null = null;
  const wantsDecoded = options.decodedFrameCount
    ?? (header === null && durationSec > 0 && durationSec <= COUNT_FRAMES_MAX_DURATION_SEC);
  if (wantsDecoded && durationSec > 0 && durationSec <= COUNT_FRAMES_MAX_DURATION_SEC) {
    const counted = await ffprobeJson(ffprobe, filePath, { countFrames: true, signal: options.signal });
    const read = counted.streams?.[0]?.nb_read_frames;
    decoded = read !== undefined && read !== "N/A" ? Number(read) : null;
  }
  return {
    width: stream.width,
    height: stream.height,
    codec: stream.codec_name ?? null,
    durationSec,
    rFrameRate: parseFrameRate(stream.r_frame_rate),
    avgFrameRate: parseFrameRate(stream.avg_frame_rate),
    timeBase: stream.time_base ?? null,
    pixFmt: stream.pix_fmt ?? null,
    headerFrameCount: header !== null && Number.isFinite(header) ? header : null,
    decodedFrameCount: decoded !== null && Number.isFinite(decoded) ? decoded : null,
    timing: await assessFrameTiming(ffprobe, filePath, { signal: options.signal }),
  };
}

/** Frame count to validate requested indices against (decoded > header). */
export function bestFrameCount(facts: VideoFacts): number | null {
  return facts.decodedFrameCount ?? facts.headerFrameCount ?? null;
}

/**
 * Cheap raster probe for still images (one ffprobe call; no timing
 * sampling, no decode) — contact sheets and patch layers only need the
 * pixel size.
 */
export async function probeRasterSize(ffprobe: string, filePath: string): Promise<{ width: number; height: number }> {
  const probed = await ffprobeJson(ffprobe, filePath).catch(() => null);
  const stream = probed?.streams?.find((s) => s.codec_type === "video") ?? probed?.streams?.[0];
  if (!stream?.width || !stream?.height) {
    throw new FacadeError("INVALID_PARAMS", `cannot probe the raster size of ${filePath}`);
  }
  return { width: stream.width, height: stream.height };
}

/** Verified-CFR-only seconds→frame conversion; VFR/unknown returns null. */
export function frameIndexFromPts(ptsSec: number, facts: VideoFacts): number | null {
  if (facts.timing.timing !== "cfr" || facts.timing.fps === null) return null;
  return Math.round(ptsSec * facts.timing.fps);
}

/* ------------------------------------------------------------------ */
/* Exact extraction                                                    */
/* ------------------------------------------------------------------ */

export interface ExtractedFrame {
  /** Absolute path of the lossless PNG (named f<frame:06d>.png). */
  readonly path: string;
  readonly frame: number;
  /** Actual PTS from showinfo — the honest mapping, not a rate guess. */
  readonly ptsTimeSec: number;
}

export interface ExtractResult {
  readonly frames: readonly ExtractedFrame[];
  readonly facts: VideoFacts;
  readonly requestedCount: number;
  readonly limitations: readonly string[];
}

export const MAX_EXTRACT_FRAMES = 600;

/**
 * Normalize an explicit frame list (sorted, deduplicated) and a half-open
 * range into one sorted unique index list, enforcing the global cap.
 */
export function resolveTargetFrames(input: {
  readonly frames?: readonly number[];
  readonly startFrame?: number;
  readonly endFrame?: number;
  readonly totalFrames: number | null;
}): number[] {
  const hasList = input.frames !== undefined;
  const hasRange = input.startFrame !== undefined || input.endFrame !== undefined;
  if (hasList === hasRange) {
    throw new FacadeError("INVALID_PARAMS", "pass exactly one of frames (explicit zero-based list) or startFrame/endFrame (half-open range)");
  }
  let indices: number[];
  if (hasList) {
    indices = [...new Set(input.frames as readonly number[])].sort((a, b) => a - b);
    if (indices.some((index) => !Number.isInteger(index) || index < 0)) {
      throw new FacadeError("INVALID_PARAMS", "frames must be non-negative zero-based integers");
    }
  } else {
    const start = input.startFrame ?? 0;
    const end = input.endFrame ?? (input.totalFrames ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
      throw new FacadeError("INVALID_PARAMS", "range must satisfy 0 ≤ startFrame < endFrame (half-open, zero-based)");
    }
    indices = Array.from({ length: end - start }, (_, i) => start + i);
  }
  if (indices.length === 0) throw new FacadeError("INVALID_PARAMS", "no frames selected");
  if (indices.length > MAX_EXTRACT_FRAMES) {
    throw new FacadeError("INVALID_PARAMS", `too many frames requested (${indices.length}); split into calls of at most ${MAX_EXTRACT_FRAMES}`);
  }
  if (input.totalFrames !== null && indices[indices.length - 1]! >= input.totalFrames) {
    throw new FacadeError("INVALID_PARAMS", `frame ${indices[indices.length - 1]} is beyond the last frame (source has ${input.totalFrames})`);
  }
  return indices;
}

/** select expression over decode indices, e.g. 'eq(n,3)+between(n,40,44)'. */
export function buildSelectExpr(indices: readonly number[]): string {
  const parts: string[] = [];
  let runStart = indices[0]!;
  let prev = runStart;
  const flush = (endExclusive: number) => {
    if (endExclusive - runStart === 1) parts.push(`eq(n,${runStart})`);
    else parts.push(`between(n,${runStart},${endExclusive - 1})`);
  };
  for (let i = 1; i <= indices.length; i++) {
    const current = indices[i];
    if (current === undefined || current !== prev + 1) {
      flush(prev + 1);
      if (current !== undefined) runStart = current;
    }
    prev = current ?? prev;
  }
  return `select='${parts.join("+")}'`;
}

const SHOWINFO_FRAME = /n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:(-?[\d.]+)/g;

/** Parse showinfo stderr in emission order → [{frameCounter, ptsTimeSec}]. */
export function parseShowinfo(stderr: string): { counter: number; ptsTimeSec: number }[] {
  const out: { counter: number; ptsTimeSec: number }[] = [];
  for (const match of stderr.matchAll(SHOWINFO_FRAME)) {
    out.push({ counter: Number(match[1]), ptsTimeSec: Number(match[3]) });
  }
  return out;
}

/**
 * Extract exact frames as lossless PNGs, named f<frame:06d>.png, with the
 * showinfo-verified PTS mapping. The select filter matches decode indices,
 * so precision does not depend on the frame rate at all; the PTS cross-check
 * additionally catches CFR-index disagreements loudly instead of silently.
 */
export async function extractFramesExact(
  ffmpeg: string,
  sourcePath: string,
  indices: readonly number[],
  destDir: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ frames: ExtractedFrame[]; limitations: string[] }> {
  await mkdir(destDir, { recursive: true });
  const tempPattern = join(destDir, "tmp-%06d.png");
  const expr = buildSelectExpr(indices);
  const { stderr } = await runToolProcess(
    ffmpeg,
    ["-hide_banner", "-nostdin", "-loglevel", "info", "-i", sourcePath,
      "-vf", `${expr},showinfo`, "-an", "-fps_mode", "passthrough", tempPattern],
    options,
  );
  const shown = parseShowinfo(stderr);
  if (shown.length !== indices.length) {
    await rm(destDir, { recursive: true, force: true });
    throw new FacadeError(
      "JOB_FAILED",
      `extraction mismatch: requested ${indices.length} frame(s) but ffmpeg emitted ${shown.length} — the requested indices may exceed the source's frame count`,
    );
  }
  const limitations: string[] = [];
  const frames: ExtractedFrame[] = [];
  for (const [position, requested] of indices.entries()) {
    const tempPath = join(destDir, `tmp-${String(position + 1).padStart(6, "0")}.png`);
    const info = await stat(tempPath).catch(() => null);
    if (!info?.isFile()) {
      await rm(destDir, { recursive: true, force: true });
      throw new FacadeError("JOB_FAILED", `extraction output missing for requested frame ${requested}`);
    }
    const finalPath = join(destDir, `f${String(requested).padStart(6, "0")}.png`);
    await rename(tempPath, finalPath);
    frames.push({ path: finalPath, frame: requested, ptsTimeSec: shown[position]!.ptsTimeSec });
  }
  // Clean any stragglers (defensive; count check above should prevent them).
  for (const entry of await readdir(destDir)) {
    if (entry.startsWith("tmp-")) await rm(join(destDir, entry), { force: true });
  }
  return { frames, limitations };
}

/* ------------------------------------------------------------------ */
/* Candidate detection (scene / black / freeze)                        */
/* ------------------------------------------------------------------ */

export interface SceneCandidate {
  /** Zero-based index of the first frame AFTER the cut; null when timing is not verified CFR. */
  readonly frameIndex: number | null;
  /** Absolute source seconds of the boundary (frame's own PTS). */
  readonly ptsTimeSec: number;
  readonly score: number;
}

const METADATA_FRAME = /frame:(\d+)\s+pts:(\d+)\s+pts_time:([\d.]+)[^\n]*\n(?:[^\n]*\n)? ?lavfi\.scene_score=([\d.]+)/g;

export function parseSceneStdout(stdout: string): { ptsTimeSec: number; score: number }[] {
  const out: { ptsTimeSec: number; score: number }[] = [];
  for (const match of stdout.matchAll(METADATA_FRAME)) {
    out.push({ ptsTimeSec: Number(match[3]), score: Number(match[4]) });
  }
  return out;
}

/** Best-effort progress from ffmpeg's stderr time= lines. */
const TIME_LINE = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/g;

export function parseProgressSeconds(stderr: string): number | null {
  let last: number | null = null;
  for (const match of stderr.matchAll(TIME_LINE)) {
    last = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  return last;
}

export interface DetectionRange {
  readonly startSec: number;
  readonly endSec: number;
}

export async function detectSceneCandidates(
  ffmpeg: string,
  sourcePath: string,
  range: DetectionRange,
  params: { threshold: number },
  facts: VideoFacts,
  options: { signal?: AbortSignal; onProgress?: (seconds: number) => void } = {},
): Promise<{ candidates: SceneCandidate[]; limitations: string[] }> {
  const duration = Math.max(0, range.endSec - range.startSec);
  const timeoutMs = 120_000 + Math.round(duration * 4_000);
  const args = ["-hide_banner", "-nostdin", "-loglevel", "warning", "-stats", "-stats_period", "1",
    "-ss", String(range.startSec), "-t", String(duration), "-i", sourcePath,
    "-vf", `select='gt(scene,${params.threshold})',metadata=print:file=-`,
    "-an", "-fps_mode", "passthrough", "-f", "null", "-"];
  const { stdout, stderr } = await runToolProcess(ffmpeg, args, { timeoutMs, signal: options.signal });
  options.onProgress?.(parseProgressSeconds(stderr) ?? 0);
  const parsed = parseSceneStdout(stdout.toString("utf8"));
  const limitations = [
    `Content-value candidates at threshold ${params.threshold}; fades, flashes and dissolves near the threshold may be missed or split — verify boundaries with frames.extract before editing.`,
    "A cut within one frame of the range start cannot be scored (its predecessor is outside the decoded range) and may be missed.",
  ];
  if (facts.timing.timing !== "cfr") {
    limitations.push(
      `Frame timing is ${facts.timing.timing} (${facts.timing.method}); candidates carry absolute PTS seconds and frameIndex is null rather than converted through a nominal rate.`,
    );
  }
  return {
    candidates: parsed.map((item) => ({
      ptsTimeSec: range.startSec + item.ptsTimeSec,
      score: item.score,
      frameIndex: frameIndexFromPts(range.startSec + item.ptsTimeSec, facts),
    })),
    limitations,
  };
}

export interface RangeCandidate {
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly startFrameIndex: number | null;
  readonly endFrameIndexExclusive: number | null;
}

const BLACK_LINE = /black_start:\s*([\d.]+) black_end:\s*([\d.]+) black_duration:\s*([\d.]+)/g;
// freezedetect logs each field on its own line with a space after the colon
// (unlike blackdetect's single space-free line).
const FREEZE_START_LINE = /lavfi\.freezedetect\.freeze_start:\s*([\d.]+)/g;
const FREEZE_END_LINE = /lavfi\.freezedetect\.freeze_end:\s*([\d.]+)/g;

function toRangeCandidates(
  raw: { start: number; end: number }[],
  facts: VideoFacts,
  range: DetectionRange,
): RangeCandidate[] {
  return raw.map((item) => ({
    startSec: range.startSec + item.start,
    endSec: range.startSec + item.end,
    durationSec: item.end - item.start,
    startFrameIndex: frameIndexFromPts(range.startSec + item.start, facts),
    endFrameIndexExclusive: frameIndexFromPts(range.startSec + item.end, facts),
  }));
}

export async function detectBlackCandidates(
  ffmpeg: string,
  sourcePath: string,
  range: DetectionRange,
  params: { minDurationSec: number; pixelThreshold: number },
  facts: VideoFacts,
  options: { signal?: AbortSignal; onProgress?: (seconds: number) => void } = {},
): Promise<{ candidates: RangeCandidate[]; limitations: string[] }> {
  const duration = Math.max(0, range.endSec - range.startSec);
  const { stderr } = await runToolProcess(
    ffmpeg,
    ["-hide_banner", "-nostdin", "-loglevel", "info", "-stats", "-stats_period", "1",
      "-ss", String(range.startSec), "-t", String(duration), "-i", sourcePath,
      "-vf", `blackdetect=d=${params.minDurationSec}:pix_th=${params.pixelThreshold}`,
      "-an", "-f", "null", "-"],
    { timeoutMs: 120_000 + Math.round(duration * 4_000), signal: options.signal },
  );
  options.onProgress?.(parseProgressSeconds(stderr) ?? 0);
  const raw: { start: number; end: number }[] = [];
  for (const match of stderr.matchAll(BLACK_LINE)) {
    raw.push({ start: Number(match[1]), end: Number(match[2]) });
  }
  return {
    candidates: toRangeCandidates(raw, facts, range),
    limitations: [
      `Luma-threshold candidates (pix_th ${params.pixelThreshold}, minimum ${params.minDurationSec}s); intentional dark scenes, fades and letterboxed bars are NOT failures — review before acting.`,
      ...(facts.timing.timing !== "cfr"
        ? [`Frame timing is ${facts.timing.timing}; range endpoints carry seconds and null frame indices.`]
        : []),
    ],
  };
}

export interface FreezeRangeCandidate extends RangeCandidate {
  /**
   * True when freezedetect never emitted an end line because the freeze ran
   * into the end of the analyzed stream (the filter flushes no closing line
   * at EOF) — closed at the range end, not a measured end.
   */
  readonly closedAtStreamEnd: boolean;
}

export async function detectFreezeCandidates(
  ffmpeg: string,
  sourcePath: string,
  range: DetectionRange,
  params: { minDurationSec: number; noiseThreshold: number },
  facts: VideoFacts,
  options: { signal?: AbortSignal; onProgress?: (seconds: number) => void } = {},
): Promise<{ candidates: FreezeRangeCandidate[]; limitations: string[] }> {
  const duration = Math.max(0, range.endSec - range.startSec);
  const { stderr } = await runToolProcess(
    ffmpeg,
    ["-hide_banner", "-nostdin", "-loglevel", "info", "-stats", "-stats_period", "1",
      "-ss", String(range.startSec), "-t", String(duration), "-i", sourcePath,
      "-vf", `freezedetect=n=${params.noiseThreshold}:d=${params.minDurationSec}`,
      "-an", "-f", "null", "-"],
    { timeoutMs: 120_000 + Math.round(duration * 4_000), signal: options.signal },
  );
  options.onProgress?.(parseProgressSeconds(stderr) ?? 0);
  // freezedetect prints start/duration/end as SEPARATE log lines (unlike
  // blackdetect's single line) — collect starts and ends in order and pair.
  const starts: number[] = [];
  const ends: number[] = [];
  for (const match of stderr.matchAll(FREEZE_START_LINE)) starts.push(Number(match[1]));
  for (const match of stderr.matchAll(FREEZE_END_LINE)) ends.push(Number(match[1]));
  // A freeze still holding at EOF gets NO end line from the filter; that
  // trailing range is closed at the analyzed range end and marked honestly.
  const trailingOpen = starts.length === ends.length + 1;
  if (!trailingOpen && starts.length !== ends.length) {
    throw new FacadeError("JOB_FAILED", `freezedetect emitted ${starts.length} start(s) but ${ends.length} end(s); cannot pair ranges`);
  }
  const raw = starts.map((start, index) => ({
    start,
    end: ends[index] ?? range.endSec - range.startSec,
    closedAtStreamEnd: index >= ends.length,
  }));
  return {
    candidates: raw.map((item) => ({
      ...toRangeCandidates([{ start: item.start, end: item.end }], facts, range)[0]!,
      closedAtStreamEnd: item.closedAtStreamEnd,
    })),
    limitations: [
      `Noise-threshold repetition candidates (n=${params.noiseThreshold}, minimum ${params.minDurationSec}s); intentional freeze frames, static graphics, still shots and low-noise gradients repeat legitimately — these are review candidates, never failures.`,
      "A freeze starting within one frame of the range start may be under-reported (no predecessor decoded).",
      ...(trailingOpen
        ? ["The last candidate ran to the end of the analyzed stream without a measured end (closedAtStreamEnd: true)."]
        : []),
      ...(facts.timing.timing !== "cfr"
        ? [`Frame timing is ${facts.timing.timing}; range endpoints carry seconds and null frame indices.`]
        : []),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Contact sheet                                                       */
/* ------------------------------------------------------------------ */

export interface SheetInput {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly label: string;
}

export const MAX_SHEET_CELLS = 96;

/** Escape a string for use as a drawtext `text=` value (expansion=none). */
export function escapeDrawtext(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

/** Escape a filesystem path for use inside a filter option value. */
export function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export interface SheetGeometry {
  readonly cellWidth: number;
  readonly cellInnerHeight: number;
  readonly labelStripHeight: number;
  readonly columns: number;
  readonly rows: number;
}

/**
 * Compose a contact sheet PNG: every frame scaled to fit its cell without
 * distortion, padded (never stretched), a black label strip BELOW each cell
 * carrying the frame label, then tiled into the grid.
 */
export async function composeContactSheet(
  ffmpeg: string,
  inputs: readonly SheetInput[],
  destPath: string,
  geometry: SheetGeometry,
  options: { roi?: { x: number; y: number; width: number; height: number }; fontFile?: string | null; signal?: AbortSignal } = {},
): Promise<{ labeled: boolean }> {
  const chains: string[] = [];
  inputs.forEach((input, index) => {
    const filters = [
      ...(options.roi ? [`crop=${options.roi.width}:${options.roi.height}:${options.roi.x}:${options.roi.y}`] : []),
      `scale=${geometry.cellWidth}:${geometry.cellInnerHeight}:force_original_aspect_ratio=decrease`,
      `pad=${geometry.cellWidth}:${geometry.cellInnerHeight + geometry.labelStripHeight}:0:0:color=black`,
    ];
    if (options.fontFile) {
      const text = escapeDrawtext(input.label);
      filters.push(
        `drawtext=text='${text}':fontcolor=white:fontsize=11:x=(w-text_w)/2:y=${geometry.cellInnerHeight + Math.floor(geometry.labelStripHeight / 2) - 6}:fontfile='${escapeFilterPath(options.fontFile)}':expansion=none`,
      );
    }
    chains.push(`[${index}:v]${filters.join(",")}[v${index}]`);
  });
  const concat = `${inputs.map((_, index) => `[v${index}]`).join("")}concat=n=${inputs.length}[seq]`;
  const tile = `[seq]tile=${geometry.columns}x${geometry.rows}:padding=6:margin=4:color=black[out]`;
  const args = [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    ...inputs.flatMap((input) => ["-i", input.path]),
    "-filter_complex", `${chains.join(";")};${concat};${tile}`,
    "-map", "[out]", "-frames:v", "1", destPath,
  ];
  await runToolProcess(ffmpeg, args, { signal: options.signal });
  return { labeled: options.fontFile != null };
}

/* ------------------------------------------------------------------ */
/* Pairwise compare composites + pixel metrics                         */
/* ------------------------------------------------------------------ */

export type CompareLayout = "side-by-side" | "overlay" | "difference";

export async function composeCompareImage(
  ffmpeg: string,
  referencePath: string,
  candidatePath: string,
  destPath: string,
  options: {
    layout: CompareLayout;
    referenceSize: { width: number; height: number };
    overlayOpacity?: number;
    roi?: { x: number; y: number; width: number; height: number };
    maxHeight?: number;
    signal?: AbortSignal;
  },
): Promise<void> {
  const { width, height } = options.referenceSize;
  const roi = options.roi ?? { x: 0, y: 0, width, height };
  const cropRef = `crop=${roi.width}:${roi.height}:${roi.x}:${roi.y}`;
  const scaleCand = `scale=${roi.width}:${roi.height}`;
  const cap = options.maxHeight
    ? `scale=-2:'min(${options.maxHeight},ih)':force_original_aspect_ratio=decrease`
    : null;
  let graph: string;
  if (options.layout === "side-by-side") {
    const size = cap ? `${cap}` : "null";
    graph = `[0:v]${cropRef},${size}[a];[1:v]${scaleCand},${size}[b];[a][b]hstack[out]`;
  } else if (options.layout === "overlay") {
    const opacity = options.overlayOpacity ?? 0.5;
    graph = `[0:v]${cropRef}[a];[1:v]${scaleCand},format=yuva444p,colorchannelmixer=aa=${opacity}[b];[a][b]overlay=0:0[out]`;
  } else {
    graph = `[0:v]${cropRef}[a];[1:v]${scaleCand}[b];[a][b]blend=all_mode=difference[out]`;
  }
  await runToolProcess(
    ffmpeg,
    ["-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      "-i", referencePath, "-i", candidatePath,
      "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", destPath],
    { signal: options.signal },
  );
}

const PIXEL_CHANNEL_THRESHOLD = 24;

/**
 * Decode both PNGs to raw RGBA at the reference raster (candidate scaled)
 * and compute ROI-restricted mean-absolute difference and changed-pixel
 * ratio — the same semantics verify.artifact uses, so numbers are
 * comparable across the two verbs.
 */
export async function compareFrameMetrics(
  ffmpeg: string,
  referencePath: string,
  candidatePath: string,
  referenceSize: { width: number; height: number },
  options: { roi?: { x: number; y: number; width: number; height: number }; signal?: AbortSignal } = {},
): Promise<{ meanAbsDiff: number; changedPixelsRatio: number; sampledPixels: number }> {
  const { width, height } = referenceSize;
  const decode = async (path: string, scale: boolean) => {
    const filters = scale ? [`scale=${width}:${height}`] : [];
    const { stdout } = await runToolProcess(
      ffmpeg,
      ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", path,
        ...(filters.length > 0 ? ["-vf", filters.join(",")] : []),
        "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
      { signal: options.signal },
    );
    const expected = width * height * 4;
    if (stdout.length !== expected) {
      throw new FacadeError("JOB_FAILED", `decoded ${stdout.length} bytes from ${path}, expected ${expected} (${width}x${height} RGBA)`);
    }
    return stdout;
  };
  const ref = await decode(referencePath, false);
  const cand = await decode(candidatePath, true);
  const roi = options.roi ?? { x: 0, y: 0, width, height };
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(roi.x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(roi.y)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.round(roi.x + roi.width)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.round(roi.y + roi.height)));
  let sumAbs = 0;
  let changed = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    const rowOffset = y * width * 4;
    for (let x = x0; x < x1; x++) {
      const i = rowOffset + x * 4;
      const dr = Math.abs(ref[i]! - cand[i]!);
      const dg = Math.abs(ref[i + 1]! - cand[i + 1]!);
      const db = Math.abs(ref[i + 2]! - cand[i + 2]!);
      sumAbs += (dr + dg + db) / 3;
      if (Math.max(dr, dg, db) > PIXEL_CHANNEL_THRESHOLD) changed += 1;
      count += 1;
    }
  }
  return {
    meanAbsDiff: count > 0 ? sumAbs / count : 0,
    changedPixelsRatio: count > 0 ? changed / count : 0,
    sampledPixels: count,
  };
}

/* ------------------------------------------------------------------ */
/* Static mask patch                                                   */
/* ------------------------------------------------------------------ */

/**
 * Composite a rectangular static-mask patch: the patch's own pixels inside
 * the mask rectangle replace the frame's; everything outside is carried
 * from the (already lossless PNG) original. Output is again lossless PNG.
 */
export async function applyMaskComposite(
  ffmpeg: string,
  originalFramePath: string,
  patchImagePath: string,
  destPath: string,
  mask: { x: number; y: number; width: number; height: number },
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  await runToolProcess(
    ffmpeg,
    ["-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      "-i", originalFramePath, "-i", patchImagePath,
      "-filter_complex",
      `[1:v]crop=${mask.width}:${mask.height}:${mask.x}:${mask.y}[p];[0:v][p]overlay=${mask.x}:${mask.y}:format=auto`,
      "-frames:v", "1", destPath],
    { signal: options.signal },
  );
}

/**
 * Verify the composite contract: every pixel OUTSIDE the mask must be
 * identical to the original frame's decoded pixels.
 */
export async function verifyOutsideMaskUnchanged(
  ffmpeg: string,
  originalPath: string,
  compositedPath: string,
  size: { width: number; height: number },
  mask: { x: number; y: number; width: number; height: number },
  options: { signal?: AbortSignal } = {},
): Promise<{ unchanged: boolean; differingPixels: number }> {
  const decode = async (path: string) => {
    const { stdout } = await runToolProcess(
      ffmpeg,
      ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", path,
        "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
      { signal: options.signal },
    );
    return stdout;
  };
  const [a, b] = await Promise.all([decode(originalPath), decode(compositedPath)]);
  const expected = size.width * size.height * 4;
  if (a.length !== expected || b.length !== expected) {
    throw new FacadeError("JOB_FAILED", `pixel verification decode size mismatch (${a.length} / ${b.length} vs ${expected})`);
  }
  let differing = 0;
  for (let y = 0; y < size.height; y++) {
    const inMaskRows = y >= mask.y && y < mask.y + mask.height;
    const rowOffset = y * size.width * 4;
    for (let x = 0; x < size.width; x++) {
      if (inMaskRows && x >= mask.x && x < mask.x + mask.width) continue;
      const i = rowOffset + x * 4;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) differing += 1;
    }
  }
  return { unchanged: differing === 0, differingPixels: differing };
}

/** Byte-identical copy for untouched frames (lossless passthrough). */
export async function copyUntouchedFrame(from: string, to: string): Promise<void> {
  await copyFile(from, to);
}
