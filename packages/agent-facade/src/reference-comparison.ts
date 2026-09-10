/**
 * Reference comparison implementation (P1) — shared by the headless and live
 * facade sessions. Two artifacts on top of the canonical state:
 *
 *  - renderComparisonStill: ONE inspection still at a timeline time — left
 *    cell the decoded reference frame at the MAPPED time, right cell the
 *    canonical timeline render (the same provider as preview.render_frame),
 *    both letterboxed to preserve aspect (never cropped), or a blended
 *    overlay. Matrix-aware reference decode per docs/COLOR.md.
 *  - composeComparisonVideo: builds the side-by-side/overlay comparison
 *    EXPORT from ONE canonical timeline export plus a tagged reference
 *    decode — the timeline is rendered exactly once (no re-export loops),
 *    and one ffmpeg pass composes and re-tags the result.
 *
 * The mapping itself (rate 1, start offset, clamp-and-disclose beyond the
 * reference range) is the single shared implementation in
 * @openreel/core/types/reference-comparison — the GUI panel uses it too.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

import type { Project } from "@openreel/core/types/project";
import {
  mapTimelineToReference,
  type ReferenceComparisonConfig,
  type ReferenceComparisonLayout,
} from "@openreel/core/types/reference-comparison";

import { FacadeError } from "./errors";
import { assessColorSupport, probeColorMetadata } from "./color-policy";
import type { ArtifactRef } from "./providers";
import {
  artifactRefFor,
  prepareArtifactDir,
} from "./artifact-io";
import { fitFrameToBudget } from "./frame-budget";
import {
  discardArtifact,
  fingerprintFile,
  inspectionRequestKey,
  pendingArtifactPath,
  publishArtifact,
} from "./inspection-artifacts";
import { timelineDurationSec } from "./projection";

const execute = promisify(execFile);

const FFMPEG_TIMEOUT_MS = 600_000;
/** Comparison exports/stills keep the documented export color policy. */
const BT709_TAGS = [
  "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
  "-color_range", "tv",
] as const;

export function requireComparisonConfig(
  project: Project,
  verb: string,
): ReferenceComparisonConfig {
  const config = project.referenceComparison;
  if (!config) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: no reference comparison is configured — set one with the reference.setComparison edit op first`,
      { hint: 'edit.apply ops: [{op: "reference.setComparison", config: {...}}]' },
    );
  }
  return config;
}

/** Resolve the reference media file path from the project's media library. */
export function referenceFilePath(
  _project: Project,
  config: ReferenceComparisonConfig,
  mediaFiles: Record<string, string>,
  verb: string,
): string {
  const path = mediaFiles[config.referenceMediaId];
  if (!path) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: the reference media is not file-backed/readable in this session (mediaId ${config.referenceMediaId})`,
      { referenceMediaId: config.referenceMediaId },
    );
  }
  return path;
}

/**
 * The comparison reference is often NOT referenced by any timeline clip, so
 * the clip-driven mediaFiles map skips it. Merge it in with the caller's
 * containment/size discipline (same checks the session builders apply to
 * clip media).
 */
export async function withComparisonReference(
  project: Project,
  config: ReferenceComparisonConfig,
  mediaFiles: Record<string, string>,
  resolveOne: (item: unknown) => Promise<string | null>,
): Promise<Record<string, string>> {
  if (mediaFiles[config.referenceMediaId]) return mediaFiles;
  const item: unknown = project.mediaLibrary.items.find((entry) => entry.id === config.referenceMediaId);
  if (!item) return mediaFiles;
  const resolved = await resolveOne(item);
  return resolved ? { ...mediaFiles, [config.referenceMediaId]: resolved } : mediaFiles;
}

export interface ComparisonStillParams {
  readonly timeSec: number;
  readonly width: number;
  readonly height: number;
  readonly maxFrameBytes: number;
  /** Render-time layout override; defaults to the canonical config's layout. */
  readonly layout?: ReferenceComparisonLayout;
}

export interface ComparisonStillResult {
  readonly timeSec: number;
  readonly referenceSec: number;
  readonly clamped: "none" | "before" | "after";
  readonly layout: ReferenceComparisonLayout;
  readonly width: number;
  readonly height: number;
  readonly frameBudgetBytes: number;
  readonly artifact: ArtifactRef;
  readonly limitations: readonly string[];
}

/**
 * Render one comparison still. The timeline side comes from the canonical
 * render provider (identical pipeline to preview.render_frame); the reference
 * side is decoded matrix-aware; the composition letterboxes each cell to
 * preserve aspect ratio.
 */
export async function renderComparisonStill(params: {
  readonly project: Project;
  readonly sourceRevision: number;
  readonly request: ComparisonStillParams;
  readonly config: ReferenceComparisonConfig;
  readonly referencePath: string;
  readonly timelineStillPath: string;
  readonly artifactRoot: string;
}): Promise<ComparisonStillResult> {
  const { project, sourceRevision, request, config, referencePath, timelineStillPath, artifactRoot } = params;
  const mapping = mapTimelineToReference(config, request.timeSec);
  const layout = request.layout ?? config.layout;

  const facts = await probeColorMetadata(referencePath);
  const [referenceBefore, timelineFingerprint] = await Promise.all([
    referenceFingerprint(referencePath),
    fingerprintFile(timelineStillPath),
  ]);
  const tagged = facts.matrix !== null;
  const support = assessColorSupport(facts);
  const limitations: string[] = support.support === "supported-sdr" ? [] : [...support.notes];
  if (facts.source === "unavailable") {
    limitations.push("reference color metadata could not be probed; missing matrix/range use the documented BT.709-limited assumption");
  } else if (!tagged) {
    limitations.push("reference has no matrix metadata; missing matrix/range use the documented BT.709-limited assumption (docs/COLOR.md)");
  }
  if (mapping.clamped !== "none") {
    limitations.push(
      mapping.clamped === "before"
        ? `timeline time ${request.timeSec} maps before the reference range; the reference side holds its first frame at refStartSec ${config.refStartSec}`
        : `timeline time ${request.timeSec} maps past refEndSec ${config.refEndSec}; the reference side holds the last reference frame`,
    );
  }

  const halfWidth = Math.max(2, Math.floor(request.width / 2 / 2) * 2);
  const workDir = await mkdtemp(join(tmpdir(), "refcmp-"));
  try {
    const outTemp = join(workDir, "comparison.png");
    // Reference (input 0): matrix-aware decode — tagged files go through
    // their own tags, untagged files through the documented BT.709-limited
    // assumption. Timeline still (input 1) is already RGB.
    const assumptions = [!tagged ? "in_color_matrix=bt709" : "", facts.range === null ? "in_range=tv" : ""].filter(Boolean);
    const refPrefix = assumptions.length ? `scale=${assumptions.join(":")},` : "";
    const fitPad = (w: number, h: number) =>
      `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,format=rgb24`;
    let filter: string;
    if (layout === "overlay") {
      const opacity = config.overlayOpacity ?? 0.5;
      filter = [
        `[1:v]${fitPad(request.width, request.height)}[base]`,
        `[0:v]${refPrefix}${fitPad(request.width, request.height)}[over]`,
        `[base][over]blend=all_mode=normal:all_opacity=${opacity}[out]`,
      ].join(";");
    } else {
      filter = [
        `[0:v]${refPrefix}${fitPad(halfWidth, request.height)}[left]`,
        `[1:v]${fitPad(halfWidth, request.height)}[right]`,
        `[left][right]hstack=inputs=2,drawbox=x=${halfWidth - 1}:y=0:w=2:h=${request.height}:color=0x808080@0.8:t=fill[out]`,
      ].join(";");
    }
    await execute(
      "ffmpeg",
      [
        "-hide_banner", "-nostdin", "-v", "error",
        "-ss", String(mapping.referenceSec),
        "-i", referencePath,
        "-i", timelineStillPath,
        "-frames:v", "1",
        "-filter_complex", filter,
        "-map", "[out]",
        "-y", outTemp,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    const referenceAfter = await referenceFingerprint(referencePath);
    if (referenceAfter.sha256 !== referenceBefore.sha256) {
      throw new FacadeError(
        "CONFLICT",
        "preview.render_comparison: reference source changed during rendering; retry against its new version",
      );
    }
    const fitted = await fitFrameToBudget({
      pngPath: outTemp,
      width: layout === "overlay" ? request.width : halfWidth * 2,
      height: request.height,
      budgetBytes: request.maxFrameBytes,
      sourceWidth: project.settings.width,
      sourceHeight: project.settings.height,
      regionLabel: "reference comparison still",
    });
    const dir = resolvePath(artifactRoot, "renders");
    await prepareArtifactDir(dir, artifactRoot, "preview.render_comparison");
    const requestKey = inspectionRequestKey({
      projectId: project.id,
      revision: sourceRevision,
      selector: {
        kind: "comparison",
        timeSec: request.timeSec,
        layout,
        config: {
          referenceFingerprint: referenceBefore,
          timelineFingerprint,
          refStartSec: config.refStartSec,
          refEndSec: config.refEndSec,
          timelineStartSec: config.timelineStartSec,
          overlayOpacity: config.overlayOpacity ?? null,
        },
      },
      sampleTimesMs: [Math.round(mapping.referenceSec * 1000)],
      width: request.width,
      height: request.height,
      maxFrameBytes: request.maxFrameBytes,
      media: [],
    });
    const stem = `comparison-${project.id}-r${sourceRevision}-${requestKey}-t${Math.round(request.timeSec * 1000)}-${request.width}x${request.height}`;
    const pendingPath = pendingArtifactPath(dir, stem, "png");
    const { copyFile } = await import("node:fs/promises");
    await copyFile(fitted.path, pendingPath);
    if (fitted.path !== outTemp) await rm(fitted.path, { force: true });
    const finalPath = resolvePath(dir, `${stem}.${fitted.format === "jpeg" ? "jpg" : "png"}`);
    const publishedPath = await publishArtifact({
      tempPath: pendingPath,
      finalPath,
      artifactRoot,
      verb: "preview.render_comparison",
    });
    const artifact = await artifactRefFor(publishedPath, "image", fitted.format, sourceRevision);
    return {
      timeSec: request.timeSec,
      referenceSec: mapping.referenceSec,
      clamped: mapping.clamped,
      layout,
      width: request.width,
      height: request.height,
      frameBudgetBytes: request.maxFrameBytes,
      artifact,
      limitations,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function referenceFingerprint(path: string): Promise<{
  sizeBytes: number;
  mtimeMs: number;
  sha256: string | null;
}> {
  return fingerprintFile(path);
}

export interface ComparisonVideoParams {
  readonly startSec: number;
  readonly endSec: number;
}

/**
 * Compose the comparison export from ONE canonical timeline export plus a
 * matrix-aware reference decode. Layout: side-by-side cells at the export
 * raster each (total 2W x H), or overlay at the export raster. Audio comes
 * from exactly ONE side (config.audioSide) — never both. Beyond the
 * reference range the left side holds the nearest reference frame
 * (clamp-and-disclose).
 */
export async function composeComparisonVideo(params: {
  readonly config: ReferenceComparisonConfig;
  readonly referencePath: string;
  readonly timelineExportPath: string;
  readonly destPath: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly range: ComparisonVideoParams;
}): Promise<{ sizeBytes: number }> {
  const { config, referencePath, timelineExportPath, destPath, width, height, frameRate, range } = params;
  const duration = range.endSec - range.startSec;
  const refStart = mapTimelineToReference(config, range.startSec).referenceSec;
  const facts = await probeColorMetadata(referencePath);
  const tagged = facts.matrix !== null;

  // Side-by-side cells at the FULL export raster each (total 2W x H): the
  // comparison keeps each side at native export detail, letterboxed inside
  // its cell to preserve aspect (never cropped).
  // Reference (input 0): matrix-aware decode prefix for untagged files;
  // timeline export (input 1) carries its own honest tags.
  const assumptions = [!tagged ? "in_color_matrix=bt709" : "", facts.range === null ? "in_range=tv" : ""].filter(Boolean);
    const refPrefix = assumptions.length ? `scale=${assumptions.join(":")},` : "";
  const tpad = `tpad=stop_mode=clone:stop_duration=${duration.toFixed(3)}`;
  const fitPad = (w: number, h: number) =>
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,format=rgb24`;
  let filter: string;
  if (config.layout === "overlay") {
    const opacity = config.overlayOpacity ?? 0.5;
    filter = [
      `[0:v]${refPrefix}${fitPad(width, height)},${tpad}[over]`,
      `[1:v]${fitPad(width, height)}[base]`,
      `[base][over]blend=all_mode=normal:all_opacity=${opacity},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]`,
    ].join(";");
  } else {
    filter = [
      `[0:v]${refPrefix}${fitPad(width, height)},${tpad}[left]`,
      `[1:v]${fitPad(width, height)}[right]`,
      `[left][right]hstack=inputs=2,drawbox=x=${width - 1}:y=0:w=2:h=${height}:color=0x808080@0.8:t=fill,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]`,
    ].join(";");
  }

  const args: string[] = [
    "-hide_banner", "-nostdin", "-v", "error",
    "-ss", String(refStart),
    "-t", String(duration),
    "-i", referencePath,
    "-ss", String(range.startSec),
    "-t", String(duration),
    "-i", timelineExportPath,
    "-filter_complex", filter,
    "-map", "[v]",
  ];
  if (config.audioSide === "reference") {
    args.push("-map", "0:a?");
  } else if (config.audioSide === "timeline") {
    args.push("-map", "1:a?");
  } else {
    args.push("-an");
  }
  args.push(
    "-r", String(frameRate),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    ...BT709_TAGS,
    ...(config.audioSide !== "none" ? ["-c:a", "aac", "-b:a", "160k"] : []),
    "-movflags", "+faststart",
    "-y", destPath,
  );
  await execute("ffmpeg", args, { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  const fileStat = await stat(destPath);
  if (!fileStat.isFile() || fileStat.size === 0) {
    throw new FacadeError("JOB_FAILED", "reference comparison export: ffmpeg produced no output");
  }
  return { sizeBytes: fileStat.size };
}

/** Validate the comparison export range against the timeline. */
export function validateComparisonRange(
  project: Project,
  range: ComparisonVideoParams,
): void {
  const duration = timelineDurationSec(project);
  if (!(range.endSec > range.startSec)) {
    throw new FacadeError("INVALID_PARAMS", `comparison range endSec must be greater than startSec (got ${range.startSec}..${range.endSec})`);
  }
  if (range.startSec < 0 || range.endSec > duration + 1e-6) {
    throw new FacadeError("INVALID_PARAMS", `comparison range ${range.startSec}..${range.endSec} is outside the timeline duration ${duration}`);
  }
}

/** Discard helper re-export so callers can clean temps uniformly. */
export { discardArtifact };
