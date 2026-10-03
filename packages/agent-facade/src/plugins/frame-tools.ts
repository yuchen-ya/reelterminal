/**
 * Frame-exact production tools (optimization plan M1): precise extraction,
 * contact sheets, pairwise comparison, and static-mask patches.
 *
 * All four are CANDIDATE-PRODUCING read-only tools: they never touch the
 * timeline. Adoption still flows through the existing edit.validate /
 * edit.apply / media.replace path, so GUI and CLI keep one state, revision
 * checks, and undo history. Frame numbers are zero-based with half-open
 * [startFrame, endFrame) ranges; seconds↔frame conversion is only claimed
 * for verified-CFR streams (see media/frame-exact.ts).
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { FacadeError } from "../errors";
import type { ToolContext } from "../plugin-api";
import { definePlugin, defineTool } from "../plugin-api";
import { artifactRefFor, assertContainedWrittenFile, prepareArtifactDir, requireArtifactRoot } from "../artifact-io";
import { probeLabelFont, resolveToolFfmpeg } from "../media/ffmpeg-bin";
import {
  MAX_EXTRACT_FRAMES,
  MAX_SHEET_CELLS,
  applyMaskComposite,
  bestFrameCount,
  compareFrameMetrics,
  composeCompareImage,
  composeContactSheet,
  copyUntouchedFrame,
  extractFramesExact,
  probeRasterSize,
  probeVideoFacts,
  resolveTargetFrames,
  verifyOutsideMaskUnchanged,
  type CompareLayout,
  type VideoFacts,
} from "../media/frame-exact";
import { resolveContainedPathDetailed } from "../media/path-roots";
import type { ObjectSchema } from "../validate";
import type { ArtifactRef } from "../providers";

/* ------------------------------------------------------------------ */
/* Shared input pieces                                                 */
/* ------------------------------------------------------------------ */

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

interface SourceRef {
  readonly kind: "mediaId" | "path";
  readonly value: string;
}

function parseSourceRef(v: unknown): SourceRef | null {
  if (!isPlainObject(v)) return null;
  const hasMedia = typeof v.mediaId === "string" && v.mediaId.length > 0;
  const hasPath = typeof v.path === "string" && v.path.length > 0;
  if (hasMedia === hasPath) return null;
  return hasMedia ? { kind: "mediaId", value: v.mediaId as string } : { kind: "path", value: v.path as string };
}

async function resolveSourceFile(source: SourceRef, context: ToolContext, verb: string): Promise<string> {
  if (source.kind === "mediaId") {
    const { project } = await context.snapshot();
    return context.resolveMediaPath(source.value, project);
  }
  const roots = [...context.mediaRoots, ...(context.artifactRoot ? [context.artifactRoot] : [])];
  const resolution = resolveContainedPathDetailed(source.value, roots);
  if (resolution.kind !== "ok") {
    throw new FacadeError("INVALID_PARAMS", `${verb}: input path is outside the configured media/artifact roots or unreadable`, { path: source.value });
  }
  const info = await stat(resolution.path).catch(() => null);
  if (!info?.isFile()) throw new FacadeError("INVALID_PARAMS", `${verb}: input path is not a readable file`, { path: source.value });
  return resolution.path;
}

async function requireFfmpeg(verb: string) {
  const binaries = await resolveToolFfmpeg();
  if (!binaries) {
    throw new FacadeError(
      "UNSUPPORTED",
      `${verb}: no usable ffmpeg/ffprobe — install them on PATH or set REELTERMINAL_FFMPEG_PATH / REELTERMINAL_FFPROBE_PATH`,
    );
  }
  return binaries;
}

const SOURCE_VARIANT_MEDIA: ObjectSchema = {
  mediaId: { check: (v: unknown) => typeof v === "string" && v.length > 0, describe: "an imported media id", required: true, emits: { kind: "leaf" as const, schema: { type: "string" as const, minLength: 1 } } },
};
const SOURCE_VARIANT_PATH: ObjectSchema = {
  path: { check: (v: unknown) => typeof v === "string" && v.length > 0, describe: "an absolute file path inside the configured media/artifact roots", required: true, emits: { kind: "leaf" as const, schema: { type: "string" as const, minLength: 1 } } },
};
const SOURCE_EMISSION = {
  kind: "anyOfObjects" as const,
  variants: [SOURCE_VARIANT_MEDIA, SOURCE_VARIANT_PATH] as const,
};


const sourceField = {
  check: (v: unknown) => parseSourceRef(v) !== null,
  describe: '{"mediaId": "<project media id>"} or {"path": "<absolute path inside media/artifact roots>"} — exactly one',
  required: true,
  emits: SOURCE_EMISSION,
};

const intList = (max: number, min = 0) => (v: unknown): v is number[] =>
  Array.isArray(v) && v.length > 0 && v.length <= max && v.every((item) => Number.isInteger(item) && (item as number) >= min);

const isNonNegativeInteger = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;
const nonNegativeInt = {
  check: isNonNegativeInteger,
  describe: "a non-negative integer (zero-based frame index)",
  emits: { kind: "leaf" as const, schema: { type: "integer" as const, minimum: 0 } },
};

const expectedRevisionField = {
  check: isNonNegativeInteger,
  describe: "a non-negative integer",
  emits: { kind: "leaf" as const, schema: { type: "integer" as const, minimum: 0 } },
};

const openObject = () => ({ type: "object" as const, additionalProperties: true, properties: {} });

function factsOutput(facts: VideoFacts) {
  return {
    width: facts.width,
    height: facts.height,
    codec: facts.codec,
    durationSec: facts.durationSec,
    rFrameRate: facts.rFrameRate,
    avgFrameRate: facts.avgFrameRate,
    timeBase: facts.timeBase,
    pixFmt: facts.pixFmt,
    headerFrameCount: facts.headerFrameCount,
    decodedFrameCount: facts.decodedFrameCount,
    frameTiming: facts.timing,
  };
}

const FACTS_OUTPUT = {
  type: "object" as const,
  additionalProperties: true,
  properties: {},
};

/** Snapshot the source fingerprint so stale artifacts are detectable. */
async function fingerprintOf(path: string) {
  const info = await stat(path);
  return { size: info.size, lastModified: Math.round(info.mtimeMs) };
}

async function revisionGuard(context: ToolContext, expectedRevision: number | undefined) {
  const { revision } = await context.snapshot();
  if (expectedRevision !== undefined && expectedRevision !== revision) {
    throw new FacadeError("CONFLICT", `revision conflict: expected ${expectedRevision}, current is ${revision}`);
  }
  return revision;
}

/* ------------------------------------------------------------------ */
/* frames.extract                                                      */
/* ------------------------------------------------------------------ */

export interface FramesExtractInput {
  readonly source: { mediaId?: string; path?: string };
  /** One selection shape: an explicit frame list OR a half-open range. */
  readonly selection: { frames?: readonly number[]; startFrame?: number; endFrame?: number };
  readonly expectedRevision?: number;
}

export interface FramesExtractResult {
  readonly coordinateSpace: "source-frame-index";
  readonly sourceFingerprint: { size: number; lastModified: number };
  readonly revision: number;
  readonly sourceRevision: number;
  readonly sourcePath: string;
  readonly outputDir: string;
  readonly requestedCount: number;
  readonly facts: ReturnType<typeof factsOutput>;
  readonly frames: readonly { frame: number; ptsTimeSec: number; artifact: ArtifactRef }[];
  readonly limitations: readonly string[];
}

async function runFramesExtract(input: FramesExtractInput, context: ToolContext): Promise<FramesExtractResult> {
  const binaries = await requireFfmpeg("frames.extract");
  const revision = await revisionGuard(context, input.expectedRevision);
  const sourceFile = await resolveSourceFile(parseSourceRef(input.source)!, context, "frames.extract");
  const root = requireArtifactRoot(context.artifactRoot, "frames.extract");
  const outputDir = resolve(root, "frame-tools", randomUUID());
  await prepareArtifactDir(outputDir, root, "frames.extract");
  try {
    const before = await fingerprintOf(sourceFile);
    const facts = await probeVideoFacts(binaries.ffprobe, sourceFile);
    const total = bestFrameCount(facts);
    const indices = resolveTargetFrames({
      ...(input.selection.frames !== undefined ? { frames: input.selection.frames } : {}),
      ...(input.selection.startFrame !== undefined ? { startFrame: input.selection.startFrame } : {}),
      ...(input.selection.endFrame !== undefined ? { endFrame: input.selection.endFrame } : {}),
      totalFrames: total,
    });
    const framesDir = join(outputDir, "frames");
    const { frames, limitations } = await extractFramesExact(binaries.ffmpeg, sourceFile, indices, framesDir);
    const artifacts: (FramesExtractResult["frames"][number])[] = [];
    for (const frame of frames) {
      const verified = await assertContainedWrittenFile(frame.path, root, "frames.extract");
      const artifact = await artifactRefFor(verified, "image", "png", revision);
      artifacts.push({ frame: frame.frame, ptsTimeSec: frame.ptsTimeSec, artifact });
    }
    const after = await fingerprintOf(sourceFile);
    if (after.size !== before.size || after.lastModified !== before.lastModified) {
      throw new FacadeError("CONFLICT", "Source changed during extraction; retry against its new version");
    }
    if (facts.timing.timing !== "cfr") {
      limitations.push(
        `Frame timing is ${facts.timing.timing} (${facts.timing.method}); frame numbers are exact decode/presentation indices, but per-frame seconds are the REAL PTS shown in ptsTimeSec — never nominal-rate arithmetic.`,
      );
    }
    limitations.push("Lossless PNG decodes of the requested source frames; no timeline or project state changed. Adopt results through edit.apply / media.replace.");
    return {
      coordinateSpace: "source-frame-index",
      sourceFingerprint: before,
      revision,
      sourceRevision: revision,
      sourcePath: sourceFile,
      outputDir,
      requestedCount: indices.length,
      facts: factsOutput(facts),
      frames: artifacts,
      limitations,
    };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* frames.contact_sheet                                                */
/* ------------------------------------------------------------------ */

const LABEL_PATTERN = /^[A-Za-z0-9 .:_\-]{1,24}$/;

export interface FramesContactSheetInput {
  readonly frames: readonly { path: string; frame?: number; label?: string }[];
  readonly columns?: number;
  readonly cellWidth?: number;
  readonly roi?: { x: number; y: number; width: number; height: number };
  readonly expectedRevision?: number;
}

export interface FramesContactSheetResult {
  readonly revision: number;
  readonly sourceRevision: number;
  readonly artifact: ArtifactRef;
  readonly labeled: boolean;
  readonly grid: { columns: number; rows: number; cellWidth: number; cellInnerHeight: number; labelStripHeight: number };
  readonly cells: readonly { label: string; frame: number | null; sourcePath: string; column: number; row: number }[];
  readonly roi: { x: number; y: number; width: number; height: number } | null;
  readonly limitations: readonly string[];
}

async function runFramesContactSheet(input: FramesContactSheetInput, context: ToolContext): Promise<FramesContactSheetResult> {
  const binaries = await requireFfmpeg("frames.contact_sheet");
  const revision = await revisionGuard(context, input.expectedRevision);
  const root = requireArtifactRoot(context.artifactRoot, "frames.contact_sheet");
  const roots = [...context.mediaRoots, root];
  if (input.frames.length === 0 || input.frames.length > MAX_SHEET_CELLS) {
    throw new FacadeError("INVALID_PARAMS", `frames.contact_sheet: pass 1 to ${MAX_SHEET_CELLS} frame images`);
  }
  // Containment + uniform raster first — a mixed-size sheet would stretch.
  const probed: { path: string; width: number; height: number; label: string; frame: number | null }[] = [];
  for (const entry of input.frames) {
    const resolution = resolveContainedPathDetailed(entry.path, roots);
    if (resolution.kind !== "ok") {
      throw new FacadeError("INVALID_PARAMS", `frames.contact_sheet: frame path is outside the configured media/artifact roots or unreadable`, { path: entry.path });
    }
    if (!/\.png$/i.test(resolution.path)) {
      throw new FacadeError("INVALID_PARAMS", `frames.contact_sheet: input must be a PNG still (extract frames with frames.extract first): ${entry.path}`);
    }
    if (entry.label !== undefined && !LABEL_PATTERN.test(entry.label)) {
      throw new FacadeError("INVALID_PARAMS", `frames.contact_sheet: label must match ${LABEL_PATTERN} (at most 24 characters)`, { label: entry.label });
    }
    const raster = await probeRasterSize(binaries.ffprobe, resolution.path);
    probed.push({
      path: resolution.path,
      width: raster.width,
      height: raster.height,
      frame: entry.frame ?? null,
      label: entry.label ?? (entry.frame !== undefined ? `frame ${entry.frame}` : basename(resolution.path)),
    });
  }
  const first = probed[0]!;
  const mismatched = probed.filter((item) => item.width !== first.width || item.height !== first.height);
  if (mismatched.length > 0) {
    throw new FacadeError("INVALID_PARAMS", "frames.contact_sheet: all frames must share one raster size; re-extract or crop first", {
      expected: `${first.width}x${first.height}`,
      mismatched: mismatched.map((item) => ({ path: item.path, size: `${item.width}x${item.height}` })),
    });
  }
  const roi = input.roi;
  if (roi) {
    if (![roi.x, roi.y, roi.width, roi.height].every((n) => Number.isInteger(n) && n >= 0)) {
      throw new FacadeError("INVALID_PARAMS", "frames.contact_sheet: roi uses non-negative integer PIXELS in the source frame raster");
    }
    if (roi.width < 1 || roi.height < 1 || roi.x + roi.width > first.width || roi.y + roi.height > first.height) {
      throw new FacadeError("INVALID_PARAMS", `frames.contact_sheet: roi exceeds the ${first.width}x${first.height} frame raster`);
    }
  }
  const cellWidth = input.cellWidth ?? 256;
  if (!Number.isInteger(cellWidth) || cellWidth < 64 || cellWidth > 512 || cellWidth % 2 !== 0) {
    throw new FacadeError("INVALID_PARAMS", "frames.contact_sheet: cellWidth is an even integer in [64, 512]");
  }
  const columns = input.columns ?? 4;
  if (!Number.isInteger(columns) || columns < 1 || columns > 12) {
    throw new FacadeError("INVALID_PARAMS", "frames.contact_sheet: columns is an integer in [1, 12]");
  }
  const effectiveWidth = roi ? roi.width : first.width;
  const effectiveHeight = roi ? roi.height : first.height;
  const cellInnerHeight = Math.max(2, Math.round((cellWidth * effectiveHeight) / effectiveWidth / 2) * 2);
  const labelStripHeight = 18;
  const rows = Math.ceil(probed.length / columns);
  const font = await probeLabelFont();
  const outputDir = resolve(root, "frame-tools", randomUUID());
  await prepareArtifactDir(outputDir, root, "frames.contact_sheet");
  const destPath = join(outputDir, "contact-sheet.png");
  const limitations: string[] = [];
  try {
    const { labeled } = await composeContactSheet(
      binaries.ffmpeg,
      probed.map((item) => ({ path: item.path, width: item.width, height: item.height, label: item.label })),
      destPath,
      { cellWidth, cellInnerHeight, labelStripHeight, columns, rows },
      { ...(roi ? { roi } : {}), fontFile: font },
    );
    const verified = await assertContainedWrittenFile(destPath, root, "frames.contact_sheet");
    const artifact = await artifactRefFor(verified, "image", "png", revision);
    if (!labeled) {
      limitations.push("No usable label font was found on this machine; the sheet has no per-cell text labels — the cells[] mapping lists every cell's frame and position instead.");
    }
    limitations.push("Cells are scaled to fit without distortion (never stretched); labels sit in a black strip below the content.");
    if (roi) {
      limitations.push(`ROI ${JSON.stringify(roi)} is in source-frame PIXELS applied identically to every cell.`);
    }
    return {
      revision,
      sourceRevision: revision,
      artifact,
      labeled,
      grid: { columns, rows, cellWidth, cellInnerHeight, labelStripHeight },
      cells: probed.map((item, index) => ({
        label: item.label,
        frame: item.frame,
        sourcePath: item.path,
        column: index % columns,
        row: Math.floor(index / columns),
      })),
      roi: roi ?? null,
      limitations,
    };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* video.compare                                                       */
/* ------------------------------------------------------------------ */

export interface VideoCompareInput {
  readonly reference: { mediaId?: string; path?: string };
  readonly candidate: { mediaId?: string; path?: string };
  readonly positions: readonly { referenceFrame: number; candidateFrame: number }[];
  readonly layout?: CompareLayout;
  readonly overlayOpacity?: number;
  readonly roi?: { x: number; y: number; width: number; height: number };
  readonly maxHeight?: number;
  readonly expectedRevision?: number;
}

export interface VideoCompareResult {
  readonly revision: number;
  readonly sourceRevision: number;
  readonly reference: { path: string; width: number; height: number; isImage: boolean };
  readonly candidate: { path: string; width: number; height: number; isImage: boolean };
  readonly layout: CompareLayout;
  readonly roi: { x: number; y: number; width: number; height: number } | null;
  readonly pairs: readonly {
    referenceFrame: number;
    candidateFrame: number;
    referencePtsSec: number | null;
    candidatePtsSec: number | null;
    artifact: ArtifactRef;
    metrics: { meanAbsDiff: number; changedPixelsRatio: number; sampledPixels: number };
  }[];
  readonly limitations: readonly string[];
}

async function runVideoCompare(input: VideoCompareInput, context: ToolContext): Promise<VideoCompareResult> {
  const binaries = await requireFfmpeg("video.compare");
  const revision = await revisionGuard(context, input.expectedRevision);
  const root = requireArtifactRoot(context.artifactRoot, "video.compare");
  if (input.positions.length === 0 || input.positions.length > 6) {
    throw new FacadeError("INVALID_PARAMS", "video.compare: pass 1 to 6 compare positions");
  }
  if (input.overlayOpacity !== undefined && !(input.overlayOpacity >= 0 && input.overlayOpacity <= 1)) {
    throw new FacadeError("INVALID_PARAMS", "video.compare: overlayOpacity is a number in [0, 1]");
  }
  const layout: CompareLayout = input.layout ?? "side-by-side";
  const referenceFile = await resolveSourceFile(parseSourceRef(input.reference)!, context, "video.compare");
  const candidateFile = await resolveSourceFile(parseSourceRef(input.candidate)!, context, "video.compare");
  const refFacts = await probeVideoFacts(binaries.ffprobe, referenceFile);
  const candFacts = await probeVideoFacts(binaries.ffprobe, candidateFile);
  const refIsImage = /\.(png|jpe?g|bmp|webp)$/i.test(referenceFile);
  const candIsImage = /\.(png|jpe?g|bmp|webp)$/i.test(candidateFile);
  const roi = input.roi;
  if (roi && (![roi.x, roi.y, roi.width, roi.height].every((n) => Number.isInteger(n) && n >= 0) ||
    roi.width < 1 || roi.height < 1 || roi.x + roi.width > refFacts.width || roi.y + roi.height > refFacts.height)) {
    throw new FacadeError("INVALID_PARAMS", `video.compare: roi must be a positive integer rectangle inside the ${refFacts.width}x${refFacts.height} REFERENCE raster (pixels)`);
  }
  const outputDir = resolve(root, "frame-tools", randomUUID());
  await prepareArtifactDir(outputDir, root, "video.compare");
  try {
    const work = join(outputDir, "work");
    await mkdir(work, { recursive: true });
    const pairs: (VideoCompareResult["pairs"][number])[] = [];
    for (const [index, position] of input.positions.entries()) {
      if (!Number.isInteger(position.referenceFrame) || position.referenceFrame < 0 ||
        !Number.isInteger(position.candidateFrame) || position.candidateFrame < 0) {
        throw new FacadeError("INVALID_PARAMS", "video.compare: positions use non-negative zero-based frame indices");
      }
      // Frames come from the ORIGINAL SOURCES (not timeline renders): a video
      // is decoded at its own frame index; a still is used as-is (index 0).
      let referencePng: string;
      let referencePts: number | null = null;
      if (refIsImage) {
        referencePng = referenceFile;
      } else {
        const refTotal = bestFrameCount(refFacts);
        if (refTotal !== null && position.referenceFrame >= refTotal) {
          throw new FacadeError("INVALID_PARAMS", `video.compare: referenceFrame ${position.referenceFrame} is beyond the reference's ${refTotal} frames`);
        }
        const extracted = await extractFramesExact(binaries.ffmpeg, referenceFile, [position.referenceFrame], join(work, `ref-${index}`));
        referencePng = extracted.frames[0]!.path;
        referencePts = extracted.frames[0]!.ptsTimeSec;
      }
      let candidatePng: string;
      let candidatePts: number | null = null;
      if (candIsImage) {
        candidatePng = candidateFile;
      } else {
        const candTotal = bestFrameCount(candFacts);
        if (candTotal !== null && position.candidateFrame >= candTotal) {
          throw new FacadeError("INVALID_PARAMS", `video.compare: candidateFrame ${position.candidateFrame} is beyond the candidate's ${candTotal} frames`);
        }
        const extracted = await extractFramesExact(binaries.ffmpeg, candidateFile, [position.candidateFrame], join(work, `cand-${index}`));
        candidatePng = extracted.frames[0]!.path;
        candidatePts = extracted.frames[0]!.ptsTimeSec;
      }
      const destPath = join(outputDir, `compare-${String(index + 1).padStart(2, "0")}.png`);
      await composeCompareImage(binaries.ffmpeg, referencePng, candidatePng, destPath, {
        layout,
        referenceSize: { width: refFacts.width, height: refFacts.height },
        ...(input.overlayOpacity !== undefined ? { overlayOpacity: input.overlayOpacity } : {}),
        ...(roi ? { roi } : {}),
        ...(input.maxHeight !== undefined ? { maxHeight: input.maxHeight } : {}),
      });
      const metrics = await compareFrameMetrics(binaries.ffmpeg, referencePng, candidatePng, { width: refFacts.width, height: refFacts.height }, ...(roi ? [{ roi }] : []));
      const verified = await assertContainedWrittenFile(destPath, root, "video.compare");
      const artifact = await artifactRefFor(verified, "image", "png", revision);
      pairs.push({
        referenceFrame: position.referenceFrame,
        candidateFrame: position.candidateFrame,
        referencePtsSec: referencePts,
        candidatePtsSec: candidatePts,
        artifact,
        metrics,
      });
    }
    const limitations = [
      "Comparison targets are the ORIGINAL SOURCE FILES (or stills), not timeline renders — preview.render_comparison compares a timeline render against a reference instead.",
      "The candidate is scaled to the reference raster before overlay/difference/metrics; pixels decode through each file's own color tags (PNG intermediates). Pin explicit matrices via verify.artifact when comparing mixed-matrix exports.",
      "Audio is out of scope for frame comparison; use the shared reference comparison config's audioSide for export-time audio.",
      "meanAbsDiff/changedPixelsRatio are computed only inside the ROI (whole frame when omitted) — alignment evidence, not a naturalness verdict.",
    ];
    if (refFacts.timing.timing !== "cfr" || candFacts.timing.timing !== "cfr") {
      limitations.push("A side's frame timing is not verified CFR; its frame index is still the exact decode index, and ptsSec carries the real PTS.");
    }
    return {
      revision,
      sourceRevision: revision,
      reference: { path: referenceFile, width: refFacts.width, height: refFacts.height, isImage: refIsImage },
      candidate: { path: candidateFile, width: candFacts.width, height: candFacts.height, isImage: candIsImage },
      layout,
      roi: roi ?? null,
      pairs,
      limitations,
    };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* patch.apply (static rectangle mask, candidate frames only)          */
/* ------------------------------------------------------------------ */

export interface PatchApplyInput {
  readonly source: { mediaId?: string; path?: string };
  /** Half-open range plus an optional in-range subset that receives the patch. */
  readonly range: { startFrame: number; endFrame: number; frames?: readonly number[] };
  readonly patch: { path: string; x: number; y: number; width: number; height: number };
  readonly expectedRevision?: number;
}

export interface PatchApplyResult {
  readonly coordinateSpace: "source-frame-index";
  readonly revision: number;
  readonly sourceRevision: number;
  readonly sourceFingerprint: { size: number; lastModified: number };
  readonly sourcePath: string;
  readonly outputDir: string;
  readonly manifestPath: string;
  readonly range: { startFrame: number; endFrame: number };
  readonly mask: { x: number; y: number; width: number; height: number };
  readonly frameCount: number;
  readonly patchedCount: number;
  readonly untouchedCount: number;
  readonly verification: { outsideMaskPixelExact: boolean; maxDifferingOutsidePixels: number };
  readonly limitations: readonly string[];
}

async function runPatchApply(input: PatchApplyInput, context: ToolContext): Promise<PatchApplyResult> {
  const binaries = await requireFfmpeg("patch.apply");
  const revision = await revisionGuard(context, input.expectedRevision);
  const root = requireArtifactRoot(context.artifactRoot, "patch.apply");
  const sourceFile = await resolveSourceFile(parseSourceRef(input.source)!, context, "patch.apply");
  const before = await fingerprintOf(sourceFile);
  const facts = await probeVideoFacts(binaries.ffprobe, sourceFile);
  const total = bestFrameCount(facts);
  const { startFrame, endFrame } = input.range;
  if (total !== null && endFrame > total) {
    throw new FacadeError("INVALID_PARAMS", `patch.apply: endFrame ${endFrame} exceeds the source's ${total} frames`);
  }
  if (endFrame - startFrame > MAX_EXTRACT_FRAMES) {
    throw new FacadeError("INVALID_PARAMS", `patch.apply: range spans ${endFrame - startFrame} frames; split into calls of at most ${MAX_EXTRACT_FRAMES}`);
  }
  const mask = input.patch;
  if (![mask.x, mask.y, mask.width, mask.height].every((n) => Number.isInteger(n) && n >= 0) ||
    mask.width < 1 || mask.height < 1 ||
    mask.x + mask.width > facts.width || mask.y + mask.height > facts.height) {
    throw new FacadeError("INVALID_PARAMS", `patch.apply: mask must be a positive integer rectangle inside the ${facts.width}x${facts.height} source raster (pixels)`);
  }
  // The patch image is a FULL-FRAME replacement layer at the source raster.
  const patchResolution = resolveContainedPathDetailed(input.patch.path, [...context.mediaRoots, root]);
  if (patchResolution.kind !== "ok") {
    throw new FacadeError("INVALID_PARAMS", "patch.apply: patch path is outside the configured media/artifact roots or unreadable", { path: input.patch.path });
  }
  if (!/\.png$/i.test(patchResolution.path)) {
    throw new FacadeError("INVALID_PARAMS", "patch.apply: the patch image must be a PNG", { path: patchResolution.path });
  }
  const patchRaster = await probeRasterSize(binaries.ffprobe, patchResolution.path);
  if (patchRaster.width !== facts.width || patchRaster.height !== facts.height) {
    throw new FacadeError("INVALID_PARAMS",
      `patch.apply: patch image is ${patchRaster.width}x${patchRaster.height} but source frames are ${facts.width}x${facts.height} — supply a full-frame patch`);
  }
  const indices = resolveTargetFrames({ startFrame, endFrame, totalFrames: total });
  const patchedSet = new Set(input.range.frames ?? indices);
  const outputDir = resolve(root, "frame-tools", randomUUID());
  await prepareArtifactDir(outputDir, root, "patch.apply");
  try {
    const extractedDir = join(outputDir, "extracted");
    const framesDir = join(outputDir, "frames");
    await mkdir(framesDir, { recursive: true });
    const extracted = await extractFramesExact(binaries.ffmpeg, sourceFile, indices, extractedDir);
    const manifestFrames: { frame: number; status: "patched" | "untouched"; path: string; sha256: string }[] = [];
    const verificationFailures: { frame: number; differingPixels: number }[] = [];
    for (const frame of extracted.frames) {
      const finalPath = join(framesDir, `f${String(frame.frame).padStart(6, "0")}.png`);
      if (patchedSet.has(frame.frame)) {
        await applyMaskComposite(binaries.ffmpeg, frame.path, patchResolution.path, finalPath, mask);
        const verification = await verifyOutsideMaskUnchanged(
          binaries.ffmpeg, frame.path, finalPath, { width: facts.width, height: facts.height }, mask,
        );
        if (!verification.unchanged) {
          // Keep going so ONE bad frame's error lists every failing frame,
          // then fail the whole call — nothing partial is ever published.
          verificationFailures.push({ frame: frame.frame, differingPixels: verification.differingPixels });
        }
      } else {
        await copyUntouchedFrame(frame.path, finalPath);
      }
      const artifact = await artifactRefFor(finalPath, "image", "png", revision);
      manifestFrames.push({ frame: frame.frame, status: patchedSet.has(frame.frame) ? "patched" : "untouched", path: finalPath, sha256: artifact.sha256 });
    }
    if (verificationFailures.length > 0) {
      throw new FacadeError("JOB_FAILED",
        "patch.apply: outside-mask pixel verification failed — pixels outside the mask changed; refusing to publish",
        { failingFrames: verificationFailures },
      );
    }
    // The source must not have moved under us mid-patch.
    const after = await fingerprintOf(sourceFile);
    if (after.size !== before.size || after.lastModified !== before.lastModified) {
      throw new FacadeError("CONFLICT", "Source changed during patching; retry against its new version");
    }
    const manifest = {
      verb: "patch.apply",
      coordinateSpace: "source-frame-index",
      source: { path: sourceFile, fingerprint: before, width: facts.width, height: facts.height, frameTiming: facts.timing },
      range: { startFrame, endFrame, halfOpen: true },
      patch: { path: patchResolution.path, mask },
      patchedFrames: [...patchedSet].sort((a, b) => a - b),
      frameCount: manifestFrames.length,
      verification: { outsideMaskPixelExact: true, maxDifferingOutsidePixels: 0 },
      frames: manifestFrames,
      limitations: [
        "Candidate output only — the timeline and source file are untouched. Adopt through edit.apply / media.replace (undoable there).",
        "Untouched frames are byte-identical copies of the lossless extraction; patched frames re-encode as lossless PNG with the outside-mask region verified pixel-exact.",
      ],
    };
    const manifestPath = join(outputDir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const verifiedManifest = await assertContainedWrittenFile(manifestPath, root, "patch.apply");
    return {
      coordinateSpace: "source-frame-index",
      revision,
      sourceRevision: revision,
      sourceFingerprint: before,
      sourcePath: sourceFile,
      outputDir,
      manifestPath: verifiedManifest,
      range: { startFrame, endFrame },
      mask,
      frameCount: manifestFrames.length,
      patchedCount: manifestFrames.filter((f) => f.status === "patched").length,
      untouchedCount: manifestFrames.filter((f) => f.status === "untouched").length,
      verification: { outsideMaskPixelExact: true, maxDifferingOutsidePixels: 0 },
      limitations: manifest.limitations,
    };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Plugin registration                                                 */
/* ------------------------------------------------------------------ */

const SELECTION_LIST_SCHEMA: ObjectSchema = {
  frames: { check: intList(MAX_EXTRACT_FRAMES), describe: `1–${MAX_EXTRACT_FRAMES} zero-based frame indices`, required: true, emits: { kind: "leaf", schema: { type: "array", minItems: 1, maxItems: MAX_EXTRACT_FRAMES, items: { type: "integer", minimum: 0 } } } },
};
const SELECTION_RANGE_SCHEMA: ObjectSchema = {
  startFrame: { ...nonNegativeInt, required: true },
  endFrame: { check: (v: unknown) => Number.isInteger(v) && (v as number) > 0, describe: "exclusive end of the half-open range", required: true, emits: { kind: "leaf", schema: { type: "integer", exclusiveMinimum: 0 } } },
};

const pixelRoi = (v: unknown): boolean => {
  if (!isPlainObject(v)) return false;
  const q = v as Record<string, number>;
  return Object.keys(q).length === 4 && [q.x, q.y, q.width, q.height].every(Number.isInteger) &&
    q.x >= 0 && q.y >= 0 && q.width > 0 && q.height > 0;
};

const ROI_EMITS = {
  kind: "leaf" as const,
  schema: {
    type: "object" as const,
    additionalProperties: false as const,
    properties: {
      x: { type: "integer" as const, minimum: 0 },
      y: { type: "integer" as const, minimum: 0 },
      width: { type: "integer" as const, exclusiveMinimum: 0 },
      height: { type: "integer" as const, exclusiveMinimum: 0 },
    },
    required: ["x", "y", "width", "height"],
  },
};

const artifactOutput = openObject();

export const frameToolsPlugin = definePlugin({
  id: "frame-tools",
  tools: [
    defineTool({
      name: "frames.extract",
      description:
        "Extract EXACT source frames as lossless PNGs by zero-based frame index (explicit list or half-open [startFrame,endFrame) range; at most 600 per call). Selection runs on decode indices — never seconds×rate — and every returned frame carries its real PTS from showinfo. Seconds↔frame conversion is only claimed for verified-CFR streams; VFR sources keep real PTS with honest notes. Works with paths containing spaces and Chinese characters. Read-only: results are candidates under the artifact root; adopt via edit.apply/media.replace.",
      schemaCases: [
        { name: "range", params: { source: { mediaId: "m1" }, selection: { startFrame: 0, endFrame: 5 } }, expectValid: true },
        { name: "explicit list", params: { source: { path: "C:/a b/素材.mp4" }, selection: { frames: [1, 5, 9] } }, expectValid: true },
        { name: "both selector kinds", params: { source: { mediaId: "m1" }, selection: { frames: [1], startFrame: 0, endFrame: 2 } }, expectValid: false },
        { name: "missing source", params: { selection: { startFrame: 0, endFrame: 2 } }, expectValid: false },
        { name: "ambiguous source", params: { source: { mediaId: "m1", path: "C:/x.mp4" }, selection: { startFrame: 0, endFrame: 2 } }, expectValid: false },
        { name: "negative frame", params: { source: { mediaId: "m1" }, selection: { frames: [-1] } }, expectValid: false },
        { name: "empty selection", params: { source: { mediaId: "m1" }, selection: {} }, expectValid: false },
      ],
      effect: "read",
      requires: ["artifactRoot", "mediaRoots"],
      presentation: "image-collection",
      input: {
        source: sourceField,
        selection: {
          check: (v: unknown) => {
            if (!isPlainObject(v)) return false;
            const hasList = v.frames !== undefined;
            const hasRange = v.startFrame !== undefined || v.endFrame !== undefined;
            if (hasList === hasRange) return false;
            if (hasList) return intList(MAX_EXTRACT_FRAMES)(v.frames);
            return nonNegativeInt.check(v.startFrame ?? 0) && Number.isInteger(v.endFrame) && (v.endFrame as number) > 0;
          },
          describe: '{"frames": [zero-based indices]} or {"startFrame": n, "endFrame": m} (half-open) — exactly one shape, at most 600 frames',
          required: true,
          emits: { kind: "anyOfObjects", variants: [SELECTION_LIST_SCHEMA, SELECTION_RANGE_SCHEMA] as const },
        },
        expectedRevision: expectedRevisionField,
      },
      output: {
        type: "object",
        additionalProperties: false,
        properties: {
          coordinateSpace: { const: "source-frame-index" },
          sourceFingerprint: openObject(),
          revision: { type: "integer", minimum: 0 },
          sourceRevision: { type: "integer", minimum: 0 },
          sourcePath: { type: "string" },
          outputDir: { type: "string" },
          requestedCount: { type: "integer", minimum: 1 },
          facts: FACTS_OUTPUT,
          frames: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { frame: { type: "integer", minimum: 0 }, ptsTimeSec: { type: "number", minimum: 0 }, artifact: artifactOutput }, required: ["frame", "ptsTimeSec", "artifact"] } },
          limitations: { type: "array", items: { type: "string" } },
        },
        required: ["coordinateSpace", "revision", "sourceRevision", "sourcePath", "outputDir", "requestedCount", "facts", "frames", "limitations"],
      },
      async execute(input: FramesExtractInput, context) {
        return runFramesExtract(input, context);
      },
    }),
    defineTool({
      name: "frames.contact_sheet",
      description:
        "Compose a contact sheet PNG from 1–96 frame images (e.g. frames.extract output): grid cells scaled to fit without stretching, a black label strip BELOW each cell (frame number or custom label), optional pixel ROI cropped identically in every cell. All inputs must share one raster size and live inside the media/artifact roots. Returns the artifact plus a cells[] position mapping. Without a usable system font the sheet omits text labels and says so.",
      schemaCases: [
        { name: "two frames", params: { frames: [{ path: "C:/a/f000001.png", frame: 1 }, { path: "C:/a/f000002.png", frame: 2 }] }, expectValid: true },
        { name: "empty", params: { frames: [] }, expectValid: false },
        { name: "missing frame path", params: { frames: [{ frame: 1 }] }, expectValid: false },
        { name: "bad label", params: { frames: [{ path: "C:/a/f1.png", label: "no;injection" }] }, expectValid: false, schemaValid: true },
        { name: "bad columns", params: { frames: [{ path: "C:/a/f1.png" }], columns: 13 }, expectValid: false },
      ],
      effect: "read",
      requires: ["artifactRoot", "mediaRoots"],
      presentation: "image-collection",
      input: {
        frames: {
          check: (v: unknown) => Array.isArray(v) && v.length >= 1 && v.length <= MAX_SHEET_CELLS && v.every((item) =>
            isPlainObject(item) && typeof item.path === "string" && item.path.length > 0 &&
            (item.frame === undefined || (Number.isInteger(item.frame) && (item.frame as number) >= 0)) &&
            (item.label === undefined || (typeof item.label === "string" && LABEL_PATTERN.test(item.label as string)))),
          describe: `1–${MAX_SHEET_CELLS} entries {path, frame?, label?}; labels match ${LABEL_PATTERN}`,
          required: true,
          emits: { kind: "array", minItems: 1, maxItems: MAX_SHEET_CELLS, items: { kind: "object", schema: {
            path: { check: (v: unknown) => typeof v === "string" && v.length > 0, describe: "a PNG frame path", required: true, emits: { kind: "leaf", schema: { type: "string", minLength: 1 } } },
            frame: { check: isNonNegativeInteger, describe: "optional zero-based source frame for the default label", emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } } },
            label: { check: (v: unknown) => typeof v === "string" && LABEL_PATTERN.test(v as string), describe: "optional cell label (at most 24 safe characters)", emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: 24 } } },
          } } },
        },
        columns: { check: (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 12, describe: "grid columns (integer 1–12, default 4)", emits: { kind: "leaf", schema: { type: "integer", minimum: 1, maximum: 12 } } },
        cellWidth: { check: (v: unknown) => Number.isInteger(v) && (v as number) >= 64 && (v as number) <= 512 && (v as number) % 2 === 0, describe: "even cell width in [64, 512] pixels (default 256)", emits: { kind: "leaf", schema: { type: "integer", minimum: 64, maximum: 512 } } },
        roi: { check: pixelRoi, describe: "optional integer-pixel rectangle in the shared frame raster, cropped identically in every cell", emits: ROI_EMITS },
        expectedRevision: expectedRevisionField,
      },
      output: {
        type: "object",
        additionalProperties: false,
        properties: {
          revision: { type: "integer", minimum: 0 },
          sourceRevision: { type: "integer", minimum: 0 },
          artifact: artifactOutput,
          labeled: { type: "boolean" },
          grid: openObject(),
          cells: { type: "array", items: openObject() },
          roi: { anyOf: [ROI_EMITS.schema, { const: null }] },
          limitations: { type: "array", items: { type: "string" } },
        },
        required: ["revision", "sourceRevision", "artifact", "labeled", "grid", "cells", "roi", "limitations"],
      },
      async execute(input: FramesContactSheetInput, context) {
        return runFramesContactSheet(input, context);
      },
    }),
    defineTool({
      name: "video.compare",
      description:
        "Compare ORIGINAL SOURCE FILES (or stills) frame-by-frame at explicit zero-based frame indices — NOT timeline renders (use preview.render_comparison for those). 1–6 positions each produce one composite (side-by-side | overlay with opacity | difference) plus ROI-restricted meanAbsDiff/changedPixelsRatio computed after scaling the candidate to the reference raster. ROI is in reference-raster pixels. Metrics are alignment evidence, never a naturalness verdict; audio is out of scope.",
      schemaCases: [
        { name: "two positions", params: { reference: { mediaId: "m1" }, candidate: { path: "C:/cand.mp4" }, positions: [{ referenceFrame: 0, candidateFrame: 3 }, { referenceFrame: 10, candidateFrame: 13 }] }, expectValid: true },
        { name: "no positions", params: { reference: { mediaId: "m1" }, candidate: { mediaId: "m2" }, positions: [] }, expectValid: false },
        { name: "negative frame", params: { reference: { mediaId: "m1" }, candidate: { mediaId: "m2" }, positions: [{ referenceFrame: -1, candidateFrame: 0 }] }, expectValid: false },
        { name: "bad layout", params: { reference: { mediaId: "m1" }, candidate: { mediaId: "m2" }, positions: [{ referenceFrame: 0, candidateFrame: 0 }], layout: "wipe" }, expectValid: false },
        { name: "missing reference", params: { candidate: { mediaId: "m2" }, positions: [{ referenceFrame: 0, candidateFrame: 0 }] }, expectValid: false },
      ],
      effect: "read",
      requires: ["artifactRoot", "mediaRoots"],
      presentation: "image-collection",
      input: {
        reference: sourceField,
        candidate: sourceField,
        positions: {
          check: (v: unknown) => Array.isArray(v) && v.length >= 1 && v.length <= 6 && v.every((item) =>
            isPlainObject(item) && Number.isInteger(item.referenceFrame) && (item.referenceFrame as number) >= 0 &&
            Number.isInteger(item.candidateFrame) && (item.candidateFrame as number) >= 0),
          describe: "1–6 entries {referenceFrame, candidateFrame} (zero-based decode indices)",
          required: true,
          emits: { kind: "array", minItems: 1, maxItems: 6, items: { kind: "object", schema: {
            referenceFrame: { check: isNonNegativeInteger, describe: "reference frame index", required: true, emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } } },
            candidateFrame: { check: isNonNegativeInteger, describe: "candidate frame index", required: true, emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } } },
          } } },
        },
        layout: { check: (v: unknown) => v === "side-by-side" || v === "overlay" || v === "difference", describe: '"side-by-side" (default), "overlay" or "difference"', emits: { kind: "leaf", schema: { enum: ["side-by-side", "overlay", "difference"] } } },
        overlayOpacity: { check: (v: unknown) => typeof v === "number" && Number.isFinite(v) && (v as number) >= 0 && (v as number) <= 1, describe: "overlay blend opacity in [0, 1] (default 0.5)", emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } } },
        roi: { check: pixelRoi, describe: "optional integer-pixel rectangle inside the REFERENCE raster restricting crops and metrics", emits: ROI_EMITS },
        maxHeight: { check: (v: unknown) => Number.isInteger(v) && (v as number) >= 64 && (v as number) <= 2160, describe: "side-by-side cell height cap in [64, 2160] pixels", emits: { kind: "leaf", schema: { type: "integer", minimum: 64, maximum: 2160 } } },
        expectedRevision: expectedRevisionField,
      },
      output: {
        type: "object",
        additionalProperties: false,
        properties: {
          revision: { type: "integer", minimum: 0 },
          sourceRevision: { type: "integer", minimum: 0 },
          reference: openObject(),
          candidate: openObject(),
          layout: { enum: ["side-by-side", "overlay", "difference"] },
          roi: { anyOf: [ROI_EMITS.schema, { const: null }] },
          pairs: { type: "array", minItems: 1, items: openObject() },
          limitations: { type: "array", items: { type: "string" } },
        },
        required: ["revision", "sourceRevision", "reference", "candidate", "layout", "roi", "pairs", "limitations"],
      },
      async execute(input: VideoCompareInput, context) {
        return runVideoCompare(input, context);
      },
    }),
    defineTool({
      name: "patch.apply",
      description:
        'Static rectangle-mask patch over a source frame SEGMENT: extract [startFrame,endFrame) losslessly, replace the mask rectangle\'s pixels from a FULL-FRAME patch image on the selected frames, byte-copy the rest. Output = candidate frame PNGs (f<frame:06d>.png) + manifest.json with per-frame status/hashes under the artifact root; every patched frame is pixel-verified so everything OUTSIDE the mask is identical to the original. Frame count and order are preserved. Timeline and source stay untouched — adopt through edit.apply / media.replace.',
      schemaCases: [
        { name: "range patch", params: { source: { mediaId: "m1" }, range: { startFrame: 10, endFrame: 14 }, patch: { path: "C:/w/fix.png", x: 40, y: 30, width: 100, height: 80 } }, expectValid: true },
        { name: "subset frames", params: { source: { mediaId: "m1" }, range: { startFrame: 10, endFrame: 14, frames: [11] }, patch: { path: "C:/w/fix.png", x: 0, y: 0, width: 64, height: 64 } }, expectValid: true },
        { name: "subset outside range", params: { source: { mediaId: "m1" }, range: { startFrame: 10, endFrame: 14, frames: [99] }, patch: { path: "C:/w/fix.png", x: 0, y: 0, width: 8, height: 8 } }, expectValid: false, schemaValid: true },
        { name: "empty range", params: { source: { mediaId: "m1" }, range: { startFrame: 10, endFrame: 10 }, patch: { path: "C:/w/fix.png", x: 0, y: 0, width: 8, height: 8 } }, expectValid: false, schemaValid: true },
        { name: "negative mask", params: { source: { mediaId: "m1" }, range: { startFrame: 0, endFrame: 2 }, patch: { path: "C:/w/fix.png", x: -1, y: 0, width: 8, height: 8 } }, expectValid: false },
        { name: "missing patch path", params: { source: { mediaId: "m1" }, range: { startFrame: 0, endFrame: 2 }, patch: { x: 0, y: 0, width: 8, height: 8 } }, expectValid: false },
      ],
      effect: "read",
      requires: ["artifactRoot", "mediaRoots"],
      input: {
        source: sourceField,
        range: {
          check: (v: unknown) => {
            if (!isPlainObject(v)) return false;
            const { startFrame, endFrame, frames } = v;
            if (!isNonNegativeInteger(startFrame) || !Number.isInteger(endFrame) || (endFrame as number) <= (startFrame as number)) return false;
            if (frames === undefined) return true;
            if (!intList(MAX_EXTRACT_FRAMES)(frames)) return false;
            const list = frames as number[];
            if (new Set(list).size !== list.length) return false;
            return list.every((frame) => frame >= (startFrame as number) && frame < (endFrame as number));
          },
          describe: '{"startFrame": n, "endFrame": m, "frames": [subset]?}: half-open range (≤600 frames per call) plus an optional unique in-range subset that receives the patch (default: all)',
          required: true,
          emits: { kind: "object", schema: {
            startFrame: { ...nonNegativeInt, required: true },
            endFrame: { check: (v: unknown) => Number.isInteger(v) && (v as number) > 0, describe: "exclusive end of the half-open patched range", required: true, emits: { kind: "leaf", schema: { type: "integer", exclusiveMinimum: 0 } } },
            frames: { check: intList(MAX_EXTRACT_FRAMES), describe: "optional unique subset of range frames that get the patch (default: all)", emits: { kind: "leaf", schema: { type: "array", minItems: 1, maxItems: MAX_EXTRACT_FRAMES, items: { type: "integer", minimum: 0 } } } },
          } },
        },
        patch: {
          check: (v: unknown) => isPlainObject(v) && typeof v.path === "string" && v.path.length > 0 && pixelRoi({ x: v.x, y: v.y, width: v.width, height: v.height }),
          describe: "{path, x, y, width, height}: a FULL-FRAME patch image at the source raster plus the integer-pixel mask rectangle (in source-raster pixels)",
          required: true,
          emits: { kind: "object", schema: {
            path: { check: (v: unknown) => typeof v === "string" && v.length > 0, describe: "patch image path inside the media/artifact roots", required: true, emits: { kind: "leaf", schema: { type: "string", minLength: 1 } } },
            x: { check: isNonNegativeInteger, describe: "mask left edge (source-raster pixels)", required: true, emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } } },
            y: { check: isNonNegativeInteger, describe: "mask top edge (source-raster pixels)", required: true, emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } } },
            width: { check: (v: unknown) => Number.isInteger(v) && (v as number) > 0, describe: "mask width (pixels)", required: true, emits: { kind: "leaf", schema: { type: "integer", exclusiveMinimum: 0 } } },
            height: { check: (v: unknown) => Number.isInteger(v) && (v as number) > 0, describe: "mask height (pixels)", required: true, emits: { kind: "leaf", schema: { type: "integer", exclusiveMinimum: 0 } } },
          } },
        },
        expectedRevision: expectedRevisionField,
      },
      output: {
        type: "object",
        additionalProperties: false,
        properties: {
          coordinateSpace: { const: "source-frame-index" },
          revision: { type: "integer", minimum: 0 },
          sourceRevision: { type: "integer", minimum: 0 },
          sourceFingerprint: openObject(),
          sourcePath: { type: "string" },
          outputDir: { type: "string" },
          manifestPath: { type: "string" },
          range: openObject(),
          mask: ROI_EMITS.schema,
          frameCount: { type: "integer", minimum: 1 },
          patchedCount: { type: "integer", minimum: 0 },
          untouchedCount: { type: "integer", minimum: 0 },
          verification: openObject(),
          limitations: { type: "array", items: { type: "string" } },
        },
        required: ["coordinateSpace", "revision", "sourceRevision", "sourcePath", "outputDir", "manifestPath", "range", "mask", "frameCount", "patchedCount", "untouchedCount", "verification", "limitations"],
      },
      async execute(input: PatchApplyInput, context) {
        return runPatchApply(input, context);
      },
    }),
  ],
});
