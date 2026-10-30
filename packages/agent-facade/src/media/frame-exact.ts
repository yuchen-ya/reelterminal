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
import { mkdir, readdir, rename, rm, stat, copyFile, open } from "node:fs/promises";
import { join } from "node:path";
import { isForbiddenLocalPath } from "@reelterminal/core/security/local-path-policy";
import { FacadeError } from "../errors";
import { FfmpegToolError, runToolProcess } from "./ffmpeg-bin";

// Exclude playlist/sequence demuxers that can open paths beyond the validated
// source. Keep MOV external tracks disabled even with a user-provided FFmpeg.
export const FRAME_INPUT_OPTIONS = [
  "-protocol_whitelist", "file",
  "-format_whitelist", "mov,matroska,webm,avi,flv,mpegts,mpeg,mpegvideo,ogg,nut,asf,wav,mp3,flac,aac,png_pipe,jpeg_pipe,bmp_pipe,webp_pipe,tiff_pipe,gif,apng",
  "-enable_drefs", "0", "-use_absolute_path", "0",
] as const;

// Other containers cannot select MOV, so MOV-only options are unnecessary.
const FRAME_NON_MOV_INPUT_OPTIONS = [
  "-protocol_whitelist", "file",
  "-format_whitelist", FRAME_INPUT_OPTIONS[3].split(",").filter((format) => format !== "mov").join(","),
] as const;

async function frameInputOptions(sourcePath: string): Promise<readonly string[]> {
  if (isForbiddenLocalPath(sourcePath)) {
    throw new FacadeError("INVALID_PARAMS", "Network and device paths are not allowed");
  }
  // Inspect only the first atom, without trusting an extension. Unrecognized
  // MOV headers fail closed because the alternate whitelist excludes MOV.
  const source = await open(sourcePath, "r");
  const header = Buffer.alloc(8);
  try {
    await source.read(header, 0, header.length, 0);
  } finally {
    await source.close();
  }
  const atom = header.toString("ascii", 4, 8);
  return ["ftyp", "moov", "mdat", "wide", "free", "skip", "uuid"].includes(atom)
    ? FRAME_INPUT_OPTIONS
    : FRAME_NON_MOV_INPUT_OPTIONS;
}

// Image-only inputs cannot select MOV or any playlist demuxer.
const FRAME_IMAGE_INPUT_OPTIONS = [
  "-protocol_whitelist", "file",
  "-format_whitelist", "png_pipe,jpeg_pipe,bmp_pipe,webp_pipe,tiff_pipe,gif,apng",
] as const;

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
  readonly nb_read_packets?: string;
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
  options: { countFrames?: boolean; countPackets?: boolean; readIntervalsSec?: number; signal?: AbortSignal } = {},
): Promise<ProbeJson> {
  const args = ["-v", "error", ...FRAME_INPUT_OPTIONS, "-select_streams", "v:0"];
  if (options.readIntervalsSec !== undefined) {
    args.push("-read_intervals", `%+${options.readIntervalsSec}`);
  }
  if (options.countFrames) args.push("-count_frames");
  if (options.countPackets) args.push("-count_packets");
  args.push("-show_entries",
    "stream=codec_name,codec_type,width,height,r_frame_rate,avg_frame_rate,nb_frames,nb_read_packets,nb_read_frames,duration,time_base,pix_fmt",
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
  /**
   * Demuxed nb_read_packets — one packet ≈ one frame for typical video, no
   * decoding. The DEFAULT count source when the header lacks nb_frames;
   * corrupt streams can carry undecodable packets, so it is a proxy.
   */
  readonly packetFrameCount: number | null;
  /** Decoded nb_read_frames (exact) — only computed when explicitly requested. */
  readonly decodedFrameCount: number | null;
  readonly timing: FrameTimingAssessment;
}

/* ------------------------------------------------------------------ */
/* Demux-only packet scan (the shared seek table)                      */
/* ------------------------------------------------------------------ */

/**
 * One demux pass over the container — NO decoding — yielding every video
 * packet's PTS in presentation order plus keyframe stats. This single scan
 * serves three callers (frame counting, CFR/VFR timing verification, and
 * index→PTS addressing for seek-based extraction) and is cached per source
 * fingerprint so one tool call does not pay for it three times.
 */
export interface PacketScan {
  /** PTS seconds in PRESENTATION order (sorted); one entry per packet. */
  readonly pts: readonly number[];
  readonly packetCount: number;
  readonly keyframeCount: number;
  /** False when a bound (packet cap, wall time, output cap) truncated it. */
  readonly completed: boolean;
  readonly boundNote: string | null;
}

const MAX_PACKET_SCAN_PACKETS = 50_000;
const PACKET_SCAN_TIMEOUT_MS = 30_000;
const PACKET_SCAN_CACHE_LIMIT = 6;

const packetScanCache = new Map<string, { fingerprint: string; scan: PacketScan }>();

/** Test seam: drop cached scans so behavior under cold cache is provable. */
export function clearPacketScanCacheForTests(): void {
  packetScanCache.clear();
}

const truncatedScan = (note: string, sampled: number): PacketScan => ({
  pts: [], packetCount: sampled, keyframeCount: 0, completed: false, boundNote: note,
});

export async function scanPacketPts(
  ffprobe: string,
  sourcePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<PacketScan> {
  const info = await stat(sourcePath);
  const fingerprint = `${info.size}:${Math.round(info.mtimeMs)}`;
  const cached = packetScanCache.get(sourcePath);
  if (cached && cached.fingerprint === fingerprint) return cached.scan;

  // CSV keeps the payload ~20 bytes/packet (JSON would be ~150 and can hit
  // the stdout cap on long streams).
  let scan: PacketScan;
  const result = await runToolProcess(
    ffprobe,
    ["-v", "error", ...FRAME_INPUT_OPTIONS, "-select_streams", "v:0",
      "-read_intervals", `%+#${MAX_PACKET_SCAN_PACKETS}`,
      "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", sourcePath],
    { timeoutMs: PACKET_SCAN_TIMEOUT_MS, signal: options.signal },
  ).catch((error: unknown) => {
    if (error instanceof FfmpegToolError &&
        (/timed out after \d+ ms/.test(error.message) || error.message.includes("exceeded the resource cap"))) {
      return null;
    }
    throw error;
  });
  if (result === null) {
    scan = truncatedScan(
      `packet PTS scan exceeded its ${PACKET_SCAN_TIMEOUT_MS} ms or output limit; constant timing cannot be verified and index addressing is unavailable`,
      0,
    );
  } else {
    const pts: number[] = [];
    let keyframes = 0;
    let nonFinite = false;
    for (const line of result.stdout.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [ptsField, flagsField] = line.split(",");
      const value = Number(ptsField);
      if (!Number.isFinite(value)) { nonFinite = true; continue; }
      pts.push(value);
      if (flagsField !== undefined && flagsField.includes("K")) keyframes += 1;
    }
    if (nonFinite) {
      scan = truncatedScan(
        "one or more packets have no finite PTS; constant timing cannot be verified",
        pts.length,
      );
    } else if (pts.length >= MAX_PACKET_SCAN_PACKETS) {
      scan = truncatedScan(
        `packet PTS scan reached its ${MAX_PACKET_SCAN_PACKETS}-packet limit; constant timing cannot be verified`,
        pts.length,
      );
      scan = { ...scan, pts: [] }; // partial PTS would invite wrong addressing
    } else {
      pts.sort((a, b) => a - b);
      scan = { pts, packetCount: pts.length, keyframeCount: keyframes, completed: true, boundNote: null };
    }
  }
  if (packetScanCache.size >= PACKET_SCAN_CACHE_LIMIT && !packetScanCache.has(sourcePath)) {
    const oldest = packetScanCache.keys().next().value;
    if (oldest !== undefined) packetScanCache.delete(oldest);
  }
  packetScanCache.set(sourcePath, { fingerprint, scan });
  return scan;
}

/**
 * Inspect the complete packet PTS sequence before claiming stream-wide CFR.
 * Demux-only (packet PTS, no -show_frames decode). The scan is bounded by
 * packet count and wall time; if either limit is hit, timing is unknown and
 * callers must not convert seconds to frame indices.
 */
export async function assessFrameTiming(
  ffprobe: string,
  filePath: string,
  options: { signal?: AbortSignal; stream?: ProbeStreamJson } = {},
): Promise<FrameTimingAssessment> {
  const nominalFps = (stream: ProbeStreamJson | undefined): number | null =>
    parseFrameRate(stream?.avg_frame_rate ?? stream?.r_frame_rate);
  const scan = await scanPacketPts(ffprobe, filePath, { signal: options.signal });
  if (!scan.completed) {
    return { timing: "unknown", fps: null, method: scan.boundNote!, sampledFrameCount: scan.packetCount };
  }
  const stream = options.stream ?? (await ffprobeJson(ffprobe, filePath, { signal: options.signal })).streams?.find((entry) => entry.codec_type === "video");
  const pts = scan.pts;
  if (pts.length < 3) {
    return {
      timing: "unknown",
      fps: nominalFps(stream),
      method: `only ${pts.length} packet PTS; cannot verify constant spacing`,
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
      method: `all ${pts.length} packet PTS are spaced ${median.toFixed(6)}s apart, agreeing with header r/avg_frame_rate`,
      sampledFrameCount: pts.length,
    };
  }
  return {
    timing: "vfr",
    fps: headerAgrees ? avgRate : null,
    method: constant
      ? "all packet PTS spacing is constant but disagrees with the header rates"
      : `packet PTS spacing varies (min ${deltas[0]!.toFixed(6)}s, max ${deltas[deltas.length - 1]!.toFixed(6)}s)`,
    sampledFrameCount: pts.length,
  };
}

/** Safety bound on the (explicit-only) full-decode frame count. */
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

  // Frame counting, cheap-first: a completed packet scan already counted
  // them (demux-only, usually already cached); a truncated scan falls back
  // to -count_packets (also demux-only, no accumulation); the exact DECODED
  // count is computed only when the caller explicitly asks for it.
  const scan = await scanPacketPts(ffprobe, filePath, { signal: options.signal });
  let packetCount: number | null = scan.completed ? scan.packetCount : null;
  if (packetCount === null && header === null) {
    const counted = await ffprobeJson(ffprobe, filePath, { countPackets: true, signal: options.signal }).catch(() => null);
    const read = counted?.streams?.[0]?.nb_read_packets;
    packetCount = read !== undefined && read !== "N/A" && Number.isFinite(Number(read)) ? Number(read) : null;
  }

  let decoded: number | null = null;
  if (options.decodedFrameCount === true && durationSec > 0 && durationSec <= COUNT_FRAMES_MAX_DURATION_SEC) {
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
    packetFrameCount: packetCount,
    decodedFrameCount: decoded !== null && Number.isFinite(decoded) ? decoded : null,
    // Cache hit inside: the scan above already ran for the same fingerprint.
    timing: await assessFrameTiming(ffprobe, filePath, { signal: options.signal, stream }),
  };
}

/** Frame count to validate requested indices against (decoded > header > packet). */
export function bestFrameCount(facts: VideoFacts): number | null {
  return facts.decodedFrameCount ?? facts.headerFrameCount ?? facts.packetFrameCount ?? null;
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
 * Scaled extraction ceiling: a fixed 180 s default starved long sources
 * while a healthy extraction only needs time proportional to the source.
 * 2 min base + 2 s per source second, capped at 10 min.
 */
export function suggestedExtractTimeoutMs(durationSec: number): number {
  return Math.min(600_000, 120_000 + Math.round(Math.max(0, durationSec) * 2_000));
}

/** Ordered-decode fallback cap: beyond this, refuse instead of grinding. */
const MAX_ORDERED_DECODE_FRAMES = 50_000;

/**
 * Extract exact frames as lossless PNGs, named f<frame:06d>.png, with the
 * showinfo-verified PTS mapping.
 *
 * Fast path: showinfo logs EVERY decoded frame with its global counter n
 * BEFORE the select filter, so the counter is the true decode index. The
 * requested indices are trusted only when the passed-through frames' counters
 * match them exactly. Some sources (concat-demuxer VFR files, streams with
 * discontinuities) RESET that counter mid-stream — trusting it would silently
 * return the WRONG frames, so any disagreement (including duplicate matches)
 * falls back to an ordered decode of frames [0, maxRequested], pairing the
 * k-th decoded output with requested position k. The ordered pairing is
 * correct by construction for "the n-th frame when played" and independent
 * of any in-stream counter.
 */
/**
 * Seek-addressed extraction: one ffmpeg invocation per cluster of nearby
 * requests, `-ss` input seeking (keyframe jump + decode-forward) and a
 * PTS-window select. Pairing trusts ONLY measured PTS — never decode
 * counters — so a pairing disagreement falls back instead of guessing.
 */
const CLUSTER_MAX_FRAME_GAP = 64;
const MAX_SEEK_CLUSTERS = 24;

/** Internal: seek-mode could not pair outputs honestly; caller falls back. */
class PtsModeFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PtsModeFallbackError";
  }
}

interface PtsRequest {
  readonly frame: number;
  readonly pts: number;
}

function clusterByFrameGap(indices: readonly number[]): number[][] {
  const clusters: number[][] = [];
  for (const index of indices) {
    const current = clusters[clusters.length - 1];
    if (current !== undefined && index - current[current.length - 1]! <= CLUSTER_MAX_FRAME_GAP) {
      current.push(index);
    } else {
      clusters.push([index]);
    }
  }
  return clusters;
}

function medianFrameDelta(pts: readonly number[]): number | null {
  if (pts.length < 2) return null;
  const deltas: number[] = [];
  for (let i = 1; i < pts.length; i++) deltas.push(pts[i]! - pts[i - 1]!);
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)] ?? null;
}

/** Choose seek addressing only when it is clearly cheaper than sequential. */
function planSeekExtraction(
  indices: readonly number[],
  scan: PacketScan,
): { requests: PtsRequest[]; frameDeltaSec: number } | null {
  const maxIndex = indices[indices.length - 1]!;
  if (!scan.completed || scan.pts.length <= maxIndex || scan.pts.length < 3) return null;
  const median = medianFrameDelta(scan.pts);
  if (median === null || !(median > 0)) return null;
  const clusters = clusterByFrameGap(indices);
  if (clusters.length > MAX_SEEK_CLUSTERS) return null;
  // Each cluster pays one keyframe-seek back + its own span.
  const averageGop = scan.pts.length / Math.max(1, scan.keyframeCount);
  const estimatedSeekFrames = clusters.reduce(
    (sum, cluster) => sum + (cluster[cluster.length - 1]! - cluster[0]! + 1) + averageGop,
    0,
  );
  if (estimatedSeekFrames * 2 >= maxIndex + 1) return null;
  return {
    requests: indices.map((frame) => ({ frame, pts: scan.pts[frame]! })),
    frameDeltaSec: median,
  };
}

async function extractByPtsWindows(
  ffmpeg: string,
  sourcePath: string,
  requests: readonly PtsRequest[],
  destDir: string,
  frameDeltaSec: number,
  options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<ExtractedFrame[]> {
  // eps stays under half the frame delta so a decoded frame can match at
  // most one window and a window at most one decoded frame.
  const eps = Math.min(0.05, Math.max(frameDeltaSec * 0.45, 1e-4));
  const clusters = clusterByFrameGap(requests.map((request) => request.frame));
  if (clusters.length > MAX_SEEK_CLUSTERS) {
    throw new PtsModeFallbackError(`seek mode needs at most ${MAX_SEEK_CLUSTERS} clusters, got ${clusters.length}`);
  }
  const inputOptions = await frameInputOptions(sourcePath);
  const ptsByFrame = new Map(requests.map((request) => [request.frame, request.pts]));
  const frames: ExtractedFrame[] = [];
  for (const [clusterIndex, clusterIndices] of clusters.entries()) {
    const cluster = clusterIndices.map((frame) => ({ frame, pts: ptsByFrame.get(frame)! }));
    const firstPts = cluster[0]!.pts;
    const lastPts = cluster[cluster.length - 1]!.pts;
    // Window bounds are clamped at 0: the filter expression parser rejects
    // a unary minus, and no PTS is negative anyway.
    const windows = cluster
      .map(({ pts }) => `between(pts_time,${Math.max(0, pts - eps).toFixed(6)},${(pts + eps).toFixed(6)})`)
      .join("+");
    const prefix = `tmpC${clusterIndex}`;
    // Seek one frame before the first window so the target always sits
    // inside the decoded range; -t bounds the read just past the last one.
    // Packet/decoded PTS are container timestamps. Preserve them with copyts
    // and interpret -ss in that same timeline, including a nonzero start.
    const seekSec = Math.max(0, firstPts - frameDeltaSec);
    const readSec = lastPts - seekSec + frameDeltaSec * 3 + eps * 2;
    const stderr = await runToolProcess(
      ffmpeg,
      ["-hide_banner", "-nostdin", "-loglevel", "info", "-copyts",
        "-seek_timestamp", "1", "-ss", seekSec.toFixed(6), "-t", readSec.toFixed(6), ...inputOptions, "-i", sourcePath,
        "-vf", `showinfo,select='${windows}'`, "-an", "-fps_mode", "passthrough",
        join(destDir, `${prefix}-%06d.png`)],
      options,
    ).then((result) => result.stderr, (error: unknown) => {
      // Any invocation failure (not an abort) defers to the sequential
      // path, which is authoritative and reports the real error if it fails.
      if (error instanceof FfmpegToolError && !/Cancel/.test(error.message)) {
        throw new PtsModeFallbackError(`seek-mode invocation failed: ${error.message.slice(-300)}`);
      }
      throw error;
    });
    const decoded = parseShowinfo(stderr);
    const passed = decoded.filter((entry) =>
      cluster.some(({ pts }) => Math.abs(entry.ptsTimeSec - pts) <= eps));
    if (passed.length !== cluster.length) {
      throw new PtsModeFallbackError(
        `seek-mode pairing mismatch near ${firstPts.toFixed(3)}s: decoded ${passed.length} of ${cluster.length} requested frames`,
      );
    }
    for (const [position, request] of cluster.entries()) {
      if (Math.abs(passed[position]!.ptsTimeSec - request.pts) > eps) {
        throw new PtsModeFallbackError(`seek-mode pairing out of order for frame ${request.frame}`);
      }
      const tempPath = join(destDir, `${prefix}-${String(position + 1).padStart(6, "0")}.png`);
      const finalPath = join(destDir, `f${String(request.frame).padStart(6, "0")}.png`);
      const info = await stat(tempPath).catch(() => null);
      if (!info?.isFile()) {
        throw new PtsModeFallbackError(`seek-mode output missing for frame ${request.frame}`);
      }
      await rename(tempPath, finalPath);
      frames.push({ path: finalPath, frame: request.frame, ptsTimeSec: passed[position]!.ptsTimeSec });
    }
  }
  return frames;
}

export async function extractFramesExact(
  ffmpeg: string,
  sourcePath: string,
  indices: readonly number[],
  destDir: string,
  options: { signal?: AbortSignal; timeoutMs?: number; ffprobe?: string } = {},
): Promise<{ frames: ExtractedFrame[]; limitations: string[] }> {
  await mkdir(destDir, { recursive: true });
  const limitations: string[] = [];
  // Sparse requests on long sources: address frames through the packet PTS
  // table and decode only covering clusters instead of a whole prefix.
  if (options.ffprobe && indices.length > 0) {
    try {
      const scan = await scanPacketPts(options.ffprobe, sourcePath, { signal: options.signal });
      const plan = planSeekExtraction(indices, scan);
      if (plan) {
        try {
          const frames = await extractByPtsWindows(ffmpeg, sourcePath, plan.requests, destDir, plan.frameDeltaSec, options);
          return { frames, limitations };
        } catch (error) {
          if (!(error instanceof PtsModeFallbackError)) throw error;
          // Seek pairing disagreed — wipe partial outputs and let the
          // sequential pass produce the authoritative answer.
          for (const entry of await readdir(destDir)) {
            if (entry.startsWith("tmpC") || /^f\d{6}\.png$/.test(entry)) {
              await rm(join(destDir, entry), { force: true });
            }
          }
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // The index is unavailable (odd container, probe hiccup): the
      // sequential path below remains fully honest on its own.
    }
  }
  const expr = buildSelectExpr(indices);
  let decoded: { counter: number; ptsTimeSec: number }[];
  try {
    // showinfo BEFORE select: its counter is the global decode index.
    // copyts prevents FFmpeg from subtracting the input's starting timestamp.
    // -frames:v stops the pipeline once every requested frame has passed
    // through select, so decode does not grind on to the end of the file.
    const { stderr } = await runToolProcess(
      ffmpeg,
      ["-hide_banner", "-nostdin", "-loglevel", "info", "-copyts", ...(await frameInputOptions(sourcePath)), "-i", sourcePath,
        "-vf", `showinfo,${expr}`, "-an", "-fps_mode", "passthrough",
        "-frames:v", String(indices.length), join(destDir, "tmp-%06d.png")],
      options,
    );
    decoded = parseShowinfo(stderr);
  } catch (error) {
    await rm(destDir, { recursive: true, force: true });
    throw error;
  }
  // The k-th tmp file is the k-th frame select passed through; recover the
  // decode index of each passed frame from the full showinfo log.
  const requested = new Set(indices);
  const passed = decoded.filter((item) => requested.has(item.counter));
  const counterTrusted = passed.length === indices.length &&
    passed.every((item, position) => item.counter === indices[position]!);
  if (!counterTrusted) {
    // The decode counter disagrees with the request (reset, drift or
    // duplicate matches) — wipe the pass-1 output and re-extract by ordered
    // decoding, which cannot drift because it pairs by output position.
    for (const entry of await readdir(destDir)) {
      if (entry.startsWith("tmp-")) await rm(join(destDir, entry), { force: true });
    }
    limitations.push(
      "The stream's decoded-frame counter was not continuous (select-based indexing unsafe — typical of concat-demuxer VFR sources); extraction fell back to ordered decoding and paired frames by output position.",
    );
    return extractFramesOrdered(ffmpeg, sourcePath, indices, destDir, limitations, options);
  }
  return finalizeExtractedFrames(indices, passed, destDir, limitations);
}

/**
 * Ordered decode of [0, maxRequested]. Pass 1 decodes to `-f null` with
 * showinfo ONLY (no maxIndex PNG files written to disk); pass 2 extracts the
 * requested positions through the shared PTS-window seeker. The historical
 * whole-PNG ordered pass stays as the final safety net if seek pairing
 * disagrees on an unusual container.
 */
async function extractFramesOrdered(
  ffmpeg: string,
  sourcePath: string,
  indices: readonly number[],
  destDir: string,
  limitations: string[],
  options: { signal?: AbortSignal; timeoutMs?: number; ffprobe?: string } = {},
): Promise<{ frames: ExtractedFrame[]; limitations: string[] }> {
  const maxIndex = indices[indices.length - 1]!;
  if (maxIndex + 1 > MAX_ORDERED_DECODE_FRAMES) {
    await rm(destDir, { recursive: true, force: true });
    throw new FacadeError(
      "JOB_FAILED",
      `extraction: the source's decoded-frame counter is not continuous and the highest requested index (${maxIndex}) exceeds the ordered-decode cap (${MAX_ORDERED_DECODE_FRAMES}) — split the source or re-encode it to a continuous stream first`,
    );
  }
  let stderr: string;
  try {
    ({ stderr } = await runToolProcess(
      ffmpeg,
      ["-hide_banner", "-nostdin", "-loglevel", "info", "-copyts", ...(await frameInputOptions(sourcePath)), "-i", sourcePath,
        "-vf", "showinfo", "-an", "-fps_mode", "passthrough",
        "-frames:v", String(maxIndex + 1), "-f", "null", "-"],
      options,
    ));
  } catch (error) {
    await rm(destDir, { recursive: true, force: true });
    throw error;
  }
  const shown = parseShowinfo(stderr);
  if (shown.length < maxIndex + 1) {
    await rm(destDir, { recursive: true, force: true });
    throw new FacadeError(
      "JOB_FAILED",
      `extraction mismatch: requested frame ${maxIndex} but the source decodes only ${shown.length} frame(s) — the requested index is beyond the last frame`,
    );
  }
  const median = medianFrameDelta([...shown].map((entry) => entry.ptsTimeSec).sort((a, b) => a - b));
  if (median !== null && median > 0) {
    try {
      const frames = await extractByPtsWindows(
        ffmpeg,
        sourcePath,
        indices.map((index) => ({ frame: index, pts: shown[index]!.ptsTimeSec })),
        destDir,
        median,
        options,
      );
      return { frames, limitations };
    } catch (error) {
      if (!(error instanceof PtsModeFallbackError)) throw error;
      for (const entry of await readdir(destDir)) {
        if (entry.startsWith("tmpC") || /^f\d{6}\.png$/.test(entry)) {
          await rm(join(destDir, entry), { force: true });
        }
      }
    }
  }
  return extractFramesOrderedPng(ffmpeg, sourcePath, indices, destDir, limitations, options);
}

/** Historical whole-PNG ordered pass — the never-guess safety net. */
async function extractFramesOrderedPng(
  ffmpeg: string,
  sourcePath: string,
  indices: readonly number[],
  destDir: string,
  limitations: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ frames: ExtractedFrame[]; limitations: string[] }> {
  const maxIndex = indices[indices.length - 1]!;
  let stderr: string;
  try {
    ({ stderr } = await runToolProcess(
      ffmpeg,
      ["-hide_banner", "-nostdin", "-loglevel", "info", "-copyts", ...(await frameInputOptions(sourcePath)), "-i", sourcePath,
        "-vf", "showinfo", "-an", "-fps_mode", "passthrough",
        "-frames:v", String(maxIndex + 1), join(destDir, "tmp-%06d.png")],
      options,
    ));
  } catch (error) {
    await rm(destDir, { recursive: true, force: true });
    throw error;
  }
  const pngShown = parseShowinfo(stderr);
  if (pngShown.length < maxIndex + 1) {
    await rm(destDir, { recursive: true, force: true });
    throw new FacadeError(
      "JOB_FAILED",
      `extraction mismatch: requested frame ${maxIndex} but the source decodes only ${pngShown.length} frame(s) — the requested index is beyond the last frame`,
    );
  }
  return finalizeExtractedFrames(indices, indices.map((index) => pngShown[index]!), destDir, limitations);
}

/** Rename tmp outputs (pass-position order) and attach the showinfo PTS. */
async function finalizeExtractedFrames(
  indices: readonly number[],
  shown: readonly { ptsTimeSec: number }[],
  destDir: string,
  limitations: string[],
): Promise<{ frames: ExtractedFrame[]; limitations: string[] }> {
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
  // Clean any stragglers (defensive; count checks above should prevent them).
  for (const entry of await readdir(destDir)) {
    if (entry.startsWith("tmp-")) await rm(join(destDir, entry), { force: true });
  }
  return { frames, limitations };
}

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
    "-ss", String(range.startSec), "-t", String(duration), ...(await frameInputOptions(sourcePath)), "-i", sourcePath,
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
      "-ss", String(range.startSec), "-t", String(duration), ...(await frameInputOptions(sourcePath)), "-i", sourcePath,
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
      "-ss", String(range.startSec), "-t", String(duration), ...(await frameInputOptions(sourcePath)), "-i", sourcePath,
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
    ...inputs.flatMap((input) => [...FRAME_IMAGE_INPUT_OPTIONS, "-i", input.path]),
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
      ...FRAME_IMAGE_INPUT_OPTIONS, "-i", referencePath, ...FRAME_IMAGE_INPUT_OPTIONS, "-i", candidatePath,
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
      ["-hide_banner", "-nostdin", "-loglevel", "error", ...FRAME_IMAGE_INPUT_OPTIONS, "-i", path,
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
      ...FRAME_IMAGE_INPUT_OPTIONS, "-i", originalFramePath, ...FRAME_IMAGE_INPUT_OPTIONS, "-i", patchImagePath,
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
      ["-hide_banner", "-nostdin", "-loglevel", "error", ...FRAME_IMAGE_INPUT_OPTIONS, "-i", path,
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
