/**
 * FfmpegArtifactVerifier — backs the facade's verify.artifact verb.
 *
 * Container/codec/duration facts come from the system (or configured)
 * ffprobe; pixel comparison decodes frames with ffmpeg to raw RGBA (no image
 * library needed) and diffs them in plain TypeScript. Verification can never
 * pass vacuously: every requested expectation becomes an explicit check with
 * evidence, and infrastructure failures throw instead of passing.
 */
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type {
  ArtifactProbeReport,
  ArtifactVerifier,
  ProviderPreflight,
  VerifyArtifactRequest,
  VerifyCheck,
  VerifyReport,
} from "@reelterminal/agent-facade";
import {
  extractFrameRgba,
  ffprobeJson,
  hasImageExtension,
  looksLikeMp4,
  resolveFfmpegBinaries,
  type FfmpegBinaries,
  type FfmpegConfig,
} from "./ffmpeg";

const PIXEL_CHANNEL_THRESHOLD = 24;
const DEFAULT_SIMILAR_MAX_MEAN_ABS_DIFF = 10;
const DEFAULT_DIFFERENT_MIN_MEAN_ABS_DIFF = 1.5;
const DEFAULT_DIFFERENT_MIN_CHANGED_RATIO = 0.02;

async function sha256File(absPath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(absPath), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
    }
  });
  return hash.digest("hex");
}

function parseFrameRate(raw: string | undefined): number | null {
  if (!raw) return null;
  const [num, den] = raw.split("/").map(Number);
  if (!num || !Number.isFinite(num)) return null;
  if (den === undefined || !Number.isFinite(den)) return num > 0 ? num : null;
  return den === 0 ? null : num / den;
}

interface PixelImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Buffer;
}

export class FfmpegArtifactVerifier implements ArtifactVerifier {
  readonly id = "ffmpeg-artifact-verifier";
  private readonly config: FfmpegConfig;
  private binariesPromise: Promise<FfmpegBinaries | null> | null = null;

  constructor(config: FfmpegConfig = {}) {
    this.config = config;
  }

  private binaries(): Promise<FfmpegBinaries | null> {
    this.binariesPromise ??= resolveFfmpegBinaries(this.config);
    return this.binariesPromise;
  }

  async preflight(): Promise<ProviderPreflight> {
    const binaries = await this.binaries();
    if (!binaries) {
      return {
        available: false,
        reason:
          "no usable ffmpeg/ffprobe found — configure explicit paths or install them on PATH",
        requires: "ffmpeg + ffprobe binaries (explicit config or system PATH)",
      };
    }
    return {
      available: true,
      details: {
        ffmpeg: binaries.ffmpeg,
        ffprobe: binaries.ffprobe,
        version: binaries.ffmpegVersion,
      },
    };
  }

  async verify(request: VerifyArtifactRequest): Promise<VerifyReport> {
    const binaries = await this.binaries();
    if (!binaries) {
      throw new Error(
        "verify.artifact: ffmpeg/ffprobe are not available on this host",
      );
    }
    const checks: VerifyCheck[] = [];
    const probe = await this.probeFile(binaries, request.path);

    const expect = request.expect;
    if (expect?.container === "mp4") {
      checks.push({
        name: "container",
        pass: looksLikeMp4(probe.container),
        details: `expected mp4 container, probed "${probe.container}"`,
      });
    }
    if (expect?.videoCodec === "h264") {
      checks.push({
        name: "videoCodec",
        pass: probe.videoCodec === "h264",
        details: `expected h264, probed "${probe.videoCodec ?? "none"}"`,
      });
    }
    if (expect?.width !== undefined) {
      checks.push({
        name: "width",
        pass: probe.width === expect.width,
        details: `expected ${expect.width}, probed ${probe.width ?? "none"}`,
      });
    }
    if (expect?.height !== undefined) {
      checks.push({
        name: "height",
        pass: probe.height === expect.height,
        details: `expected ${expect.height}, probed ${probe.height ?? "none"}`,
      });
    }
    if (expect?.durationSec !== undefined) {
      const tolerance =
        expect.durationToleranceSec ??
        (probe.frameRate ? 1 / probe.frameRate + 0.05 : 0.15);
      const delta = Math.abs(probe.durationSec - expect.durationSec);
      checks.push({
        name: "duration",
        pass: delta <= tolerance,
        details: `expected ${expect.durationSec}s ±${tolerance.toFixed(3)}s, probed ${probe.durationSec.toFixed(3)}s (Δ ${delta.toFixed(3)}s)`,
      });
      if (probe.frameCount !== null && probe.frameRate !== null && probe.frameRate > 0) {
        // "5 s ± 1 frame" made exact: the decoded frame count must sit
        // within one frame of the expectation.
        const expectedFrames = expect.durationSec * probe.frameRate;
        const frameDelta = Math.abs(probe.frameCount - expectedFrames);
        checks.push({
          name: "frameCount",
          pass: frameDelta <= 1,
          details: `expected ${expectedFrames} frames ±1, decoded ${probe.frameCount}`,
        });
      }
    }
    if (probe.sizeBytes === 0) {
      checks.push({
        name: "nonEmpty",
        pass: false,
        details: "artifact is empty (0 bytes)",
      });
    }

    let compareReport: VerifyReport["compare"];
    if (request.compare) {
      compareReport = await this.compareFrames(binaries, request, checks);
    }

    const pass = checks.every((check) => check.pass);
    return {
      pass,
      probe,
      checks,
      ...(compareReport ? { compare: compareReport } : {}),
    };
  }

  private async probeFile(
    binaries: FfmpegBinaries,
    filePath: string,
  ): Promise<ArtifactProbeReport> {
    const probed = await ffprobeJson(binaries.ffprobe, filePath, {
      countFrames: true,
    });
    const videoStream = probed.streams?.find((s) => s.codec_type === "video");
    const audioStream = probed.streams?.find((s) => s.codec_type === "audio");
    const fileStat = await stat(filePath);
    const formatDuration = Number(probed.format?.duration ?? NaN);
    const streamDuration = Number(videoStream?.duration ?? NaN);
    const durationSec = Number.isFinite(formatDuration)
      ? formatDuration
      : Number.isFinite(streamDuration)
        ? streamDuration
        : 0;
    const frameCountRaw =
      videoStream?.nb_read_frames ?? videoStream?.nb_frames;
    const frameCount =
      frameCountRaw !== undefined && frameCountRaw !== "N/A"
        ? Number(frameCountRaw)
        : null;
    const rangeRaw = videoStream?.color_range?.trim().toLowerCase();
    return {
      container: probed.format?.format_name ?? "unknown",
      videoCodec: videoStream?.codec_name ?? null,
      audioCodec: audioStream?.codec_name ?? null,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      durationSec,
      frameCount: frameCount !== null && Number.isFinite(frameCount) ? frameCount : null,
      frameRate: parseFrameRate(videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate),
      sizeBytes: fileStat.size,
      sha256: await sha256File(filePath),
      color: {
        matrix: videoStream?.color_space ?? null,
        primaries: videoStream?.color_primaries ?? null,
        transfer: videoStream?.color_transfer ?? null,
        range: rangeRaw === "tv" || rangeRaw === "pc" ? rangeRaw : null,
        pixFmt: videoStream?.pix_fmt ?? null,
      },
    };
  }

  private async loadPixels(
    binaries: FfmpegBinaries,
    filePath: string,
    timeSec: number,
    scaleTo?: { width: number; height: number },
    colorMatrix?: "bt601" | "bt709",
  ): Promise<PixelImage> {
    const probed = await ffprobeJson(binaries.ffprobe, filePath);
    const stream = probed.streams?.find((s) => s.codec_type === "video");
    const width = stream?.width ?? 0;
    const height = stream?.height ?? 0;
    if (width <= 0 || height <= 0) {
      throw new Error(`cannot determine video dimensions of ${filePath}`);
    }
    const matrixOptions = colorMatrix ? { colorMatrix } : {};
    if (hasImageExtension(filePath)) {
      const rgba = await extractFrameRgba(
        binaries.ffmpeg,
        filePath,
        0,
        width,
        height,
        { ...(scaleTo ? { scale: scaleTo } : {}), ...matrixOptions },
      );
      return { width: scaleTo?.width ?? width, height: scaleTo?.height ?? height, rgba };
    }
    // Clamp onto the last real frame: t == duration is past every frame's
    // [start, end) interval (frames live in [0, duration)).
    const durationSec = Number(stream?.duration ?? probed.format?.duration ?? NaN);
    const frameRate = parseFrameRate(stream?.avg_frame_rate ?? stream?.r_frame_rate);
    let t = Math.max(0, timeSec);
    if (Number.isFinite(durationSec) && durationSec > 0 && frameRate && frameRate > 0) {
      t = Math.min(t, Math.max(0, durationSec - 1 / frameRate));
    }
    const rgba = await extractFrameRgba(
      binaries.ffmpeg,
      filePath,
      t,
      width,
      height,
      { ...(scaleTo ? { scale: scaleTo } : {}), ...matrixOptions },
    );
    return { width: scaleTo?.width ?? width, height: scaleTo?.height ?? height, rgba };
  }

  private async compareFrames(
    binaries: FfmpegBinaries,
    request: VerifyArtifactRequest,
    checks: VerifyCheck[],
  ): Promise<VerifyReport["compare"]> {
    const compare = request.compare;
    if (!compare) return undefined;
    // Matrix-aware decode (docs/COLOR.md): `colorMatrix` pins BOTH sides to
    // one explicit YUV→RGB matrix; the per-side overrides exist for
    // mixed-matrix comparisons (e.g. a BT.601-tagged reference against a
    // BT.709 export). Without any of these, each side decodes through its own
    // container tags — correct for tagged files, but a similarity verdict on
    // untagged files must not be trusted, so the check records what was used.
    const targetMatrix = compare.targetColorMatrix ?? compare.colorMatrix;
    const referenceMatrix = compare.referenceColorMatrix ?? compare.colorMatrix;
    // The reference is scaled to the artifact's raster when sizes differ —
    // comparing an export against its full-resolution source is the normal
    // case, never a NaN failure.
    const target = await this.loadPixels(binaries, request.path, compare.timeSec, undefined, targetMatrix);
    const reference = await this.loadPixels(
      binaries,
      compare.referencePath,
      compare.referenceTimeSec ?? compare.timeSec,
      { width: target.width, height: target.height },
      referenceMatrix,
    );

    const regionNorm = compare.region ?? { x: 0, y: 0, width: 1, height: 1 };
    const x0 = Math.floor(regionNorm.x * target.width);
    const y0 = Math.floor(regionNorm.y * target.height);
    const x1 = Math.max(x0 + 1, Math.round((regionNorm.x + regionNorm.width) * target.width));
    const y1 = Math.max(y0 + 1, Math.round((regionNorm.y + regionNorm.height) * target.height));

    let sumAbs = 0;
    let changed = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
      const rowOffset = y * target.width * 4;
      for (let x = x0; x < x1; x++) {
        const i = rowOffset + x * 4;
        const dr = Math.abs(target.rgba[i]! - reference.rgba[i]!);
        const dg = Math.abs(target.rgba[i + 1]! - reference.rgba[i + 1]!);
        const db = Math.abs(target.rgba[i + 2]! - reference.rgba[i + 2]!);
        sumAbs += (dr + dg + db) / 3;
        if (Math.max(dr, dg, db) > PIXEL_CHANNEL_THRESHOLD) changed += 1;
        count += 1;
      }
    }
    const meanAbsDiff = count > 0 ? sumAbs / count : 0;
    const changedPixelsRatio = count > 0 ? changed / count : 0;

    let pass: boolean;
    const matrixNote = targetMatrix || referenceMatrix
      ? ` [decode matrix: target=${targetMatrix ?? "tags"}, reference=${referenceMatrix ?? "tags"}]`
      : " [decode matrix: tags-default per side]";
    if (compare.mode === "similar") {
      const maxMean = compare.maxMeanAbsDiff ?? DEFAULT_SIMILAR_MAX_MEAN_ABS_DIFF;
      pass = meanAbsDiff <= maxMean;
      checks.push({
        name: "compare.similar",
        pass,
        details: `mean|Δ|=${meanAbsDiff.toFixed(3)} (threshold ≤${maxMean}), changedPixels=${(changedPixelsRatio * 100).toFixed(2)}%${matrixNote}`,
      });
    } else {
      const minMean = compare.minMeanAbsDiff ?? DEFAULT_DIFFERENT_MIN_MEAN_ABS_DIFF;
      const minRatio = compare.minChangedPixelsRatio ?? DEFAULT_DIFFERENT_MIN_CHANGED_RATIO;
      pass = meanAbsDiff >= minMean && changedPixelsRatio >= minRatio;
      checks.push({
        name: "compare.different",
        pass,
        details: `mean|Δ|=${meanAbsDiff.toFixed(3)} (threshold ≥${minMean}), changedPixels=${(changedPixelsRatio * 100).toFixed(2)}% (threshold ≥${(minRatio * 100).toFixed(1)}%)${matrixNote}`,
      });
    }
    return {
      mode: compare.mode,
      meanAbsDiff,
      changedPixelsRatio,
      region: regionNorm,
      pass,
    };
  }
}
