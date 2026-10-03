/**
 * Conservative short-range propagation for one first-frame-aligned image
 * patch and grayscale mask. The tool writes candidate PNGs and inspection
 * overlays only; adoption remains an explicit edit.apply/media.replace step.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FacadeError } from "../errors";
import type { ToolContext } from "../plugin-api";
import { definePlugin, defineTool } from "../plugin-api";
import { artifactRefFor, assertContainedWrittenFile, prepareArtifactDir, requireArtifactRoot } from "../artifact-io";
import { bestFrameCount, composeContactSheet, extractFramesExact, probeRasterSize, probeVideoFacts } from "../media/frame-exact";
import { probeLabelFont, resolveToolFfmpeg } from "../media/ffmpeg-bin";
import { opencvToolPreflight, runOpenCvScript } from "../media/opencv-runner";
import { parseSourceRef, resolveSourceFile } from "./source-ref";
import type { ArtifactRef } from "../providers";

export const MAX_PATCH_PROPAGATE_FRAMES = 120;
const MAX_DIMENSION = 4096;
const MAX_PIXELS = 16_000_000;
// A 1080p × 120 call is about 249M frame-pixels. PNG intermediates and the
// output set can occupy several times that amount on disk, so keep this cap
// explicit before extraction starts.
const MAX_TOTAL_FRAME_PIXELS = 250_000_000;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sourceField = {
  check: (value: unknown) => parseSourceRef(value) !== null,
  describe: '{"mediaId":"..."} or {"path":"absolute path inside configured media/artifact roots"} — exactly one',
  required: true,
  emits: {
    kind: "anyOfObjects" as const,
    variants: [
      { mediaId: { check: (value: unknown) => typeof value === "string" && value.length > 0, describe: "an imported media id", required: true, emits: { kind: "leaf" as const, schema: { type: "string" as const, minLength: 1 } } } },
      { path: { check: (value: unknown) => typeof value === "string" && value.length > 0, describe: "an absolute path inside configured media/artifact roots", required: true, emits: { kind: "leaf" as const, schema: { type: "string" as const, minLength: 1 } } } },
    ] as const,
  },
};

const expectedRevisionField = {
  check: (value: unknown) => Number.isInteger(value) && (value as number) >= 0,
  describe: "a non-negative integer",
  emits: { kind: "leaf" as const, schema: { type: "integer" as const, minimum: 0 } },
};

const artifactOutput = { type: "object" as const, additionalProperties: true, properties: {} };
const openObject = () => ({ type: "object" as const, additionalProperties: true, properties: {} });

export interface PatchPropagationInput {
  readonly source: { mediaId?: string; path?: string };
  /** Half-open [startFrame,endFrame) zero-based decoded-frame range. */
  readonly range: { startFrame: number; endFrame: number };
  /** Full-frame PNG aligned to the first decoded source frame. */
  readonly patch: { path: string };
  /** Full-frame 8-bit grayscale PNG; white receives the patch, black is preserved. */
  readonly mask: { path: string };
  readonly options?: {
    readonly maxForwardBackwardError?: number;
    readonly minInliers?: number;
    readonly minTrackRetention?: number;
    readonly overlayCount?: number;
  };
  readonly expectedRevision?: number;
}

export interface PatchPropagationFrame {
  readonly frame: number;
  readonly ptsTimeSec: number;
  readonly status: "patched" | "needsRepair";
  readonly artifact: ArtifactRef;
  readonly matrix3x3: readonly number[] | null;
  readonly trackedPointCount: number;
  readonly inlierCount: number;
  readonly medianForwardBackwardErrorPx?: number | null;
  readonly inlierRmsePx?: number | null;
  readonly reasonCode?: string;
  readonly reason?: string;
  readonly sceneChange?: Record<string, unknown>;
  readonly localAppearance?: Record<string, unknown>;
  readonly outsideMaskDifferingPixels?: number;
  readonly effectiveMaskBounds?: Record<string, number> | null;
}

export interface PatchPropagationResult {
  readonly coordinateSpace: "decoded-source-frame-raster";
  readonly matrixDirection: "first-frame->current-frame";
  readonly revision: number;
  readonly sourceRevision: number;
  readonly sourcePath: string;
  readonly sourceFingerprint: { size: number; lastModified: number };
  readonly raster: { width: number; height: number };
  readonly range: { startFrame: number; endFrame: number };
  readonly frameTiming: Record<string, unknown>;
  readonly status: "propagated" | "needsRepair";
  readonly patchedCount: number;
  readonly needsRepairCount: number;
  readonly termination: { atFrame: number; reasonCode: string; reason: string } | null;
  readonly frames: readonly PatchPropagationFrame[];
  readonly overlays: readonly { frame: number; status: "patched" | "needsRepair"; artifact: ArtifactRef }[];
  readonly overlaySheet: ArtifactRef | null;
  readonly manifestPath: string;
  readonly parameters: Record<string, unknown>;
  readonly limitations: readonly string[];
}

async function fingerprint(path: string) {
  const info = await stat(path);
  return { size: info.size, lastModified: Math.round(info.mtimeMs) };
}

function checkOptions(options: PatchPropagationInput["options"]): Required<NonNullable<PatchPropagationInput["options"]>> {
  const normalized = {
    maxForwardBackwardError: options?.maxForwardBackwardError ?? 2,
    minInliers: options?.minInliers ?? 4,
    minTrackRetention: options?.minTrackRetention ?? 0.55,
    overlayCount: options?.overlayCount ?? 12,
  };
  if (!(Number.isFinite(normalized.maxForwardBackwardError) && normalized.maxForwardBackwardError > 0 && normalized.maxForwardBackwardError <= 20)) {
    throw new FacadeError("INVALID_PARAMS", "patch.propagate: maxForwardBackwardError must be in (0, 20] pixels");
  }
  if (!Number.isInteger(normalized.minInliers) || normalized.minInliers < 4 || normalized.minInliers > 50) {
    throw new FacadeError("INVALID_PARAMS", "patch.propagate: minInliers must be an integer in [4, 50]");
  }
  if (!(Number.isFinite(normalized.minTrackRetention) && normalized.minTrackRetention >= 0.25 && normalized.minTrackRetention <= 1)) {
    throw new FacadeError("INVALID_PARAMS", "patch.propagate: minTrackRetention must be in [0.25, 1]");
  }
  if (!Number.isInteger(normalized.overlayCount) || normalized.overlayCount < 1 || normalized.overlayCount > 16) {
    throw new FacadeError("INVALID_PARAMS", "patch.propagate: overlayCount must be an integer in [1, 16]");
  }
  return normalized;
}

async function runPatchPropagation(input: PatchPropagationInput, context: ToolContext): Promise<PatchPropagationResult> {
  const verb = "patch.propagate";
  const binaries = await resolveToolFfmpeg();
  if (!binaries) {
    throw new FacadeError("UNSUPPORTED", `${verb}: needs ffmpeg + ffprobe on PATH or REELTERMINAL_FFMPEG_PATH / REELTERMINAL_FFPROBE_PATH`);
  }
  const preflight = await opencvToolPreflight(["propagate.py"]);
  if (!preflight.available) throw new FacadeError("UNSUPPORTED", `${verb}: ${preflight.reason}`);

  const { revision } = await context.snapshot();
  if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
    throw new FacadeError("CONFLICT", `revision conflict: expected ${input.expectedRevision}, current is ${revision}`);
  }
  const { startFrame, endFrame } = input.range;
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || endFrame <= startFrame + 1) {
    throw new FacadeError("INVALID_PARAMS", `${verb}: range must be a half-open interval containing at least two non-negative decoded-frame indices`);
  }
  if (endFrame - startFrame > MAX_PATCH_PROPAGATE_FRAMES) {
    throw new FacadeError("INVALID_PARAMS", `${verb}: range spans ${endFrame - startFrame} frames; at most ${MAX_PATCH_PROPAGATE_FRAMES} frames per call`);
  }
  const options = checkOptions(input.options);
  const root = requireArtifactRoot(context.artifactRoot, verb);
  const sourceFile = await resolveSourceFile(parseSourceRef(input.source)!, context, verb);
  const patchFile = await resolveSourceFile(parseSourceRef({ path: input.patch.path })!, context, verb);
  const maskFile = await resolveSourceFile(parseSourceRef({ path: input.mask.path })!, context, verb);
  for (const [role, path] of [["patch", patchFile], ["mask", maskFile]] as const) {
    if (!/\.png$/i.test(path)) throw new FacadeError("INVALID_PARAMS", `${verb}: ${role} must be a full-frame PNG`);
  }
  const before = await Promise.all([fingerprint(sourceFile), fingerprint(patchFile), fingerprint(maskFile)]);
  const facts = await probeVideoFacts(binaries.ffprobe, sourceFile);
  const total = bestFrameCount(facts);
  const codedPixels = facts.width * facts.height;
  if (Math.max(facts.width, facts.height) > MAX_DIMENSION || codedPixels > MAX_PIXELS) {
    throw new FacadeError("INVALID_PARAMS", `${verb}: source coded raster ${facts.width}x${facts.height} exceeds the 4096px / 16MP per-frame limit`);
  }
  if (codedPixels * (endFrame - startFrame) > MAX_TOTAL_FRAME_PIXELS) {
    throw new FacadeError("INVALID_PARAMS", `${verb}: requested frame range exceeds the ${MAX_TOTAL_FRAME_PIXELS.toLocaleString()} frame-pixel budget; shorten the range or use a smaller source`);
  }
  if (total !== null && endFrame > total) {
    throw new FacadeError("INVALID_PARAMS", `${verb}: endFrame ${endFrame} exceeds the source's ${total} decoded frames`);
  }
  const indices = Array.from({ length: endFrame - startFrame }, (_, offset) => startFrame + offset);
  const outputDir = resolve(root, "patch-propagation", randomUUID());
  await prepareArtifactDir(outputDir, root, verb);
  try {
    const extractedDir = join(outputDir, "extracted");
    const framesDir = join(outputDir, "frames");
    const overlayDir = join(outputDir, "overlays");
    await mkdir(framesDir, { recursive: true });
    await mkdir(overlayDir, { recursive: true });
    const extracted = await extractFramesExact(binaries.ffmpeg, sourceFile, indices, extractedDir, { timeoutMs: 300_000 });
    if (extracted.frames.length !== indices.length) {
      throw new FacadeError("JOB_FAILED", `${verb}: exact extraction returned ${extracted.frames.length} of ${indices.length} requested frames`);
    }
    const firstRaster = await probeRasterSize(binaries.ffprobe, extracted.frames[0]!.path);
    if (firstRaster.width > MAX_DIMENSION || firstRaster.height > MAX_DIMENSION || firstRaster.width * firstRaster.height > MAX_PIXELS) {
      throw new FacadeError("INVALID_PARAMS", `${verb}: decoded source raster ${firstRaster.width}x${firstRaster.height} exceeds the 4096px / 16MP limit`);
    }
    for (const [role, path] of [["patch", patchFile], ["mask", maskFile]] as const) {
      const raster = await probeRasterSize(binaries.ffprobe, path);
      if (raster.width !== firstRaster.width || raster.height !== firstRaster.height) {
        throw new FacadeError("INVALID_PARAMS", `${verb}: ${role} is ${raster.width}x${raster.height}, but the first decoded source frame is ${firstRaster.width}x${firstRaster.height}`);
      }
    }
    const worker = await runOpenCvScript("propagate.py", {
      framesDir: extractedDir,
      frameIndices: indices,
      patchPath: patchFile,
      maskPath: maskFile,
      outputDir: framesDir,
      overlayDir,
      options,
    }, { timeoutMs: 180_000 + indices.length * 2_000 });
    const raw = worker.result as Record<string, unknown>;
    const rawFrames = raw.frames as Record<string, unknown>[] | undefined;
    if (!Array.isArray(rawFrames) || rawFrames.length !== indices.length) {
      throw new FacadeError("JOB_FAILED", `${verb}: worker returned an incomplete frame list`);
    }
    if (raw.status !== "propagated" && raw.status !== "needsRepair") {
      throw new FacadeError("JOB_FAILED", `${verb}: worker returned an unknown run status`);
    }
    const termination = isPlainObject(raw.termination) && Number.isInteger(raw.termination.atFrame) &&
      typeof raw.termination.reasonCode === "string" && typeof raw.termination.reason === "string"
      ? { atFrame: raw.termination.atFrame as number, reasonCode: raw.termination.reasonCode, reason: raw.termination.reason }
      : null;
    if ((raw.status === "needsRepair") !== (termination !== null) ||
      (termination !== null && (termination.atFrame < startFrame || termination.atFrame >= endFrame))) {
      throw new FacadeError("JOB_FAILED", `${verb}: worker status and termination frame disagree with the requested range`);
    }
    const rawOverlays = raw.overlays as { frame: number; path: string; status: string }[] | undefined;
    if (!Array.isArray(rawOverlays) || rawOverlays.length < 1) throw new FacadeError("JOB_FAILED", `${verb}: worker returned no review overlays`);
    const overlayFrames = rawOverlays.map((overlay) => overlay.frame);
    const overlayFrameSet = new Set(overlayFrames);
    const expectedOverlayCount = Math.min(options.overlayCount, indices.length);
    if (rawOverlays.length !== expectedOverlayCount || overlayFrameSet.size !== rawOverlays.length ||
      overlayFrames.some((frame) => !Number.isInteger(frame) || frame < startFrame || frame >= endFrame)) {
      throw new FacadeError("JOB_FAILED", `${verb}: worker returned duplicate, out-of-range, or over/under-counted overlays`);
    }
    if (options.overlayCount >= 2 && (!overlayFrameSet.has(startFrame) || !overlayFrameSet.has(endFrame - 1))) {
      throw new FacadeError("JOB_FAILED", `${verb}: overlay samples must include both ends of the selected range when at least two slots are requested`);
    }
    if (options.overlayCount >= 3 && termination !== null && termination.atFrame > startFrame && termination.atFrame < endFrame - 1 &&
      !overlayFrameSet.has(termination.atFrame)) {
      throw new FacadeError("JOB_FAILED", `${verb}: overlay samples omitted the first unreliable frame despite an available slot`);
    }
    for (const overlay of rawOverlays) {
      const frame = rawFrames.find((entry) => entry.frame === overlay.frame);
      if (!frame || frame.status !== overlay.status) {
        throw new FacadeError("JOB_FAILED", `${verb}: overlay status does not match frame ${overlay.frame}`);
      }
    }

    const outputFrames: PatchPropagationFrame[] = [];
    let repairStarted = false;
    for (let position = 0; position < rawFrames.length; position++) {
      const row = rawFrames[position]!;
      const expectedIndex = indices[position]!;
      if (row.frame !== expectedIndex || (row.status !== "patched" && row.status !== "needsRepair")) {
        throw new FacadeError("JOB_FAILED", `${verb}: worker returned an invalid status/index at output frame ${position}`);
      }
      if (row.status === "patched" && repairStarted) {
        throw new FacadeError("JOB_FAILED", `${verb}: worker resumed propagation after a needsRepair frame`);
      }
      if (row.status === "needsRepair") repairStarted = true;
      if (!Number.isInteger(row.trackedPointCount) || (row.trackedPointCount as number) < 0 ||
        !Number.isInteger(row.inlierCount) || (row.inlierCount as number) < 0) {
        throw new FacadeError("JOB_FAILED", `${verb}: worker returned invalid point counts for frame ${expectedIndex}`);
      }
      if (row.status === "patched" && (!Array.isArray(row.matrix3x3) || row.matrix3x3.length !== 9 ||
        !row.matrix3x3.every((value) => typeof value === "number" && Number.isFinite(value)))) {
        throw new FacadeError("JOB_FAILED", `${verb}: worker returned an invalid similarity matrix for patched frame ${expectedIndex}`);
      }
      if (row.status === "needsRepair" && row.matrix3x3 !== null) {
        throw new FacadeError("JOB_FAILED", `${verb}: worker must not report a transform for needsRepair frame ${expectedIndex}`);
      }
      if (row.status === "patched" && row.outsideMaskDifferingPixels !== 0) {
        throw new FacadeError("JOB_FAILED", `${verb}: frame ${expectedIndex} failed exact outside-mask verification`);
      }
      const verified = await assertContainedWrittenFile(String(row.path), root, verb);
      const artifact = await artifactRefFor(verified, "image", "png", revision);
      outputFrames.push({
        frame: expectedIndex,
        ptsTimeSec: extracted.frames[position]!.ptsTimeSec,
        status: row.status,
        artifact,
        matrix3x3: Array.isArray(row.matrix3x3) ? row.matrix3x3 as number[] : null,
        trackedPointCount: Number(row.trackedPointCount ?? 0),
        inlierCount: Number(row.inlierCount ?? 0),
        ...(typeof row.medianForwardBackwardErrorPx === "number" || row.medianForwardBackwardErrorPx === null ? { medianForwardBackwardErrorPx: row.medianForwardBackwardErrorPx as number | null } : {}),
        ...(typeof row.inlierRmsePx === "number" || row.inlierRmsePx === null ? { inlierRmsePx: row.inlierRmsePx as number | null } : {}),
        ...(typeof row.reasonCode === "string" ? { reasonCode: row.reasonCode } : {}),
        ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
        ...(isPlainObject(row.sceneChange) ? { sceneChange: row.sceneChange } : {}),
        ...(isPlainObject(row.localAppearance) ? { localAppearance: row.localAppearance } : {}),
        ...(typeof row.outsideMaskDifferingPixels === "number" ? { outsideMaskDifferingPixels: row.outsideMaskDifferingPixels } : {}),
        ...(isPlainObject(row.effectiveMaskBounds) || row.effectiveMaskBounds === null ? { effectiveMaskBounds: row.effectiveMaskBounds as Record<string, number> | null } : {}),
      });
    }
    const overlays: PatchPropagationResult["overlays"][number][] = [];
    for (const row of rawOverlays) {
      if (!Number.isInteger(row.frame) || (row.status !== "patched" && row.status !== "needsRepair")) {
        throw new FacadeError("JOB_FAILED", `${verb}: worker returned malformed overlay metadata`);
      }
      const verified = await assertContainedWrittenFile(row.path, root, verb);
      overlays.push({ frame: row.frame, status: row.status, artifact: await artifactRefFor(verified, "image", "png", revision) });
    }
    let overlaySheet: ArtifactRef | null = null;
    if (overlays.length > 1) {
      const font = await probeLabelFont();
      const overlaySheetPath = join(outputDir, "overlay-sheet.png");
      const cellWidth = 256;
      const cellHeight = Math.max(2, Math.round((cellWidth * firstRaster.height) / firstRaster.width / 2) * 2);
      const columns = Math.min(4, overlays.length);
      await composeContactSheet(
        binaries.ffmpeg,
        overlays.map((entry) => ({ path: entry.artifact.path, width: firstRaster.width, height: firstRaster.height, label: `frame ${entry.frame} ${entry.status}` })),
        overlaySheetPath,
        { cellWidth, cellInnerHeight: cellHeight, labelStripHeight: 18, columns, rows: Math.ceil(overlays.length / columns) },
        { fontFile: font },
      );
      const verified = await assertContainedWrittenFile(overlaySheetPath, root, verb);
      overlaySheet = await artifactRefFor(verified, "image", "png", revision);
    }

    const after = await Promise.all([fingerprint(sourceFile), fingerprint(patchFile), fingerprint(maskFile)]);
    if (before.some((initial, index) => initial.size !== after[index]!.size || initial.lastModified !== after[index]!.lastModified)) {
      throw new FacadeError("CONFLICT", `${verb}: the source, patch, or mask changed while propagation was running`);
    }
    const limitations = Array.isArray(raw.limitations) ? raw.limitations.filter((item): item is string => typeof item === "string") : [];
    const sourceFingerprint = before[0]!;
    const manifest = {
      verb,
      coordinateSpace: "decoded-source-frame-raster",
      matrixDirection: "first-frame->current-frame",
      source: { path: sourceFile, fingerprint: sourceFingerprint, frameTiming: facts.timing },
      patch: { path: patchFile, fingerprint: before[1] },
      mask: { path: maskFile, fingerprint: before[2], semantics: "8-bit grayscale: black preserves source, white receives patch" },
      range: { startFrame, endFrame, halfOpen: true },
      raster: firstRaster,
      frameMapping: extracted.frames.map((frame) => ({ frame: frame.frame, ptsTimeSec: frame.ptsTimeSec })),
      status: raw.status,
      algorithm: raw.algorithm,
      parameters: raw.parameters,
      termination,
      frames: outputFrames.map(({ artifact, ...frame }) => ({ ...frame, path: artifact.path, sha256: artifact.sha256 })),
      overlays: overlays.map(({ artifact, ...entry }) => ({ ...entry, path: artifact.path, sha256: artifact.sha256 })),
      limitations,
    };
    const manifestPath = join(outputDir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const verifiedManifest = await assertContainedWrittenFile(manifestPath, root, verb);
    return {
      coordinateSpace: "decoded-source-frame-raster",
      matrixDirection: "first-frame->current-frame",
      revision,
      sourceRevision: revision,
      sourcePath: sourceFile,
      sourceFingerprint,
      raster: firstRaster,
      range: { startFrame, endFrame },
      frameTiming: facts.timing as unknown as Record<string, unknown>,
      status: raw.status,
      patchedCount: outputFrames.filter((frame) => frame.status === "patched").length,
      needsRepairCount: outputFrames.filter((frame) => frame.status === "needsRepair").length,
      termination,
      frames: outputFrames,
      overlays,
      overlaySheet,
      manifestPath: verifiedManifest,
      parameters: isPlainObject(raw.parameters) ? raw.parameters : {},
      limitations,
    };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

const patchPropagationOptions = {
  check: (value: unknown) => {
    if (!isPlainObject(value)) return false;
    return Object.entries(value).every(([key, item]) => {
      if (key === "maxForwardBackwardError") return typeof item === "number" && Number.isFinite(item) && item > 0 && item <= 20;
      if (key === "minInliers") return Number.isInteger(item) && (item as number) >= 4 && (item as number) <= 50;
      if (key === "minTrackRetention") return typeof item === "number" && Number.isFinite(item) && item >= 0.25 && item <= 1;
      if (key === "overlayCount") return Number.isInteger(item) && (item as number) >= 1 && (item as number) <= 16;
      return false;
    });
  },
  describe: "optional {maxForwardBackwardError?, minInliers?, minTrackRetention?, overlayCount?}",
  emits: { kind: "object" as const, schema: {
    maxForwardBackwardError: { check: (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 20, describe: "forward/backward point error threshold in (0,20] px", emits: { kind: "leaf" as const, schema: { type: "number" as const, exclusiveMinimum: 0, maximum: 20 } } },
    minInliers: { check: (value: unknown) => Number.isInteger(value) && (value as number) >= 4 && (value as number) <= 50, describe: "minimum similarity-fit points in [4,50]", emits: { kind: "leaf" as const, schema: { type: "integer" as const, minimum: 4, maximum: 50 } } },
    minTrackRetention: { check: (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0.25 && value <= 1, describe: "minimum surviving fraction of first-frame seed features [0.25,1]", emits: { kind: "leaf" as const, schema: { type: "number" as const, minimum: 0.25, maximum: 1 } } },
    overlayCount: { check: (value: unknown) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 16, describe: "maximum number of unique review overlays [1,16]; first/last are anchored when ≥2, and the first loss frame gets a slot when ≥3", emits: { kind: "leaf" as const, schema: { type: "integer" as const, minimum: 1, maximum: 16 } } },
  } },
};

export const patchPropagationPlugin = definePlugin({
  id: "patch-propagation",
  tools: [
    defineTool({
      name: "patch.propagate",
      description: "Propagate one full-frame PNG patch and grayscale mask, aligned to the first frame, across a short source-frame range using LK point tracking with a RANSAC similarity transform. This is similarity-only propagation, not dense/non-rigid optical flow. At the first weak correspondence, suspected occlusion/cut, invalid fit or out-of-frame mask, the failing frame and all later frames stay original and are marked needsRepair. Outputs lossless candidate frame PNGs, exact PTS mapping and review overlays only; it never writes video or changes the timeline. At most 120 frames per call.",
      schemaCases: [
        { name: "short range", params: { source: { mediaId: "m1" }, range: { startFrame: 10, endFrame: 26 }, patch: { path: "C:/w/patch.png" }, mask: { path: "C:/w/mask.png" } }, expectValid: true },
        { name: "single frame", params: { source: { mediaId: "m1" }, range: { startFrame: 10, endFrame: 11 }, patch: { path: "C:/w/patch.png" }, mask: { path: "C:/w/mask.png" } }, expectValid: false, schemaValid: true },
        { name: "too long", params: { source: { mediaId: "m1" }, range: { startFrame: 0, endFrame: 121 }, patch: { path: "C:/w/patch.png" }, mask: { path: "C:/w/mask.png" } }, expectValid: false, schemaValid: true },
        { name: "missing mask", params: { source: { mediaId: "m1" }, range: { startFrame: 0, endFrame: 4 }, patch: { path: "C:/w/patch.png" } }, expectValid: false },
        { name: "bad retention", params: { source: { mediaId: "m1" }, range: { startFrame: 0, endFrame: 4 }, patch: { path: "C:/w/patch.png" }, mask: { path: "C:/w/mask.png" }, options: { minTrackRetention: 0.1 } }, expectValid: false },
      ],
      effect: "read",
      requires: ["artifactRoot", "mediaRoots"],
      presentation: "image-collection",
      input: {
        source: sourceField,
        range: {
          check: (value: unknown) => isPlainObject(value) && Number.isInteger(value.startFrame) && Number.isInteger(value.endFrame) &&
            (value.startFrame as number) >= 0 && (value.endFrame as number) >= (value.startFrame as number) + 2 &&
            (value.endFrame as number) - (value.startFrame as number) <= MAX_PATCH_PROPAGATE_FRAMES,
          describe: `{startFrame,endFrame}: zero-based half-open decoded-frame range with 2–${MAX_PATCH_PROPAGATE_FRAMES} frames`,
          required: true,
          emits: { kind: "object" as const, schema: {
            startFrame: { check: (value: unknown) => Number.isInteger(value) && (value as number) >= 0, describe: "first included frame", required: true, emits: { kind: "leaf" as const, schema: { type: "integer" as const, minimum: 0 } } },
            endFrame: { check: (value: unknown) => Number.isInteger(value) && (value as number) > 1, describe: "exclusive end frame", required: true, emits: { kind: "leaf" as const, schema: { type: "integer" as const, exclusiveMinimum: 1 } } },
          } },
        },
        patch: {
          check: (value: unknown) => isPlainObject(value) && typeof value.path === "string" && value.path.length > 0,
          describe: "{path}: full-frame PNG patch aligned to the first selected frame (RGBA alpha is respected)",
          required: true,
          emits: { kind: "object" as const, schema: { path: { check: (value: unknown) => typeof value === "string" && value.length > 0, describe: "PNG path inside configured media/artifact roots", required: true, emits: { kind: "leaf" as const, schema: { type: "string" as const, minLength: 1 } } } } },
        },
        mask: {
          check: (value: unknown) => isPlainObject(value) && typeof value.path === "string" && value.path.length > 0,
          describe: "{path}: full-frame 8-bit grayscale PNG aligned to the first selected frame; black preserves source, white receives patch",
          required: true,
          emits: { kind: "object" as const, schema: { path: { check: (value: unknown) => typeof value === "string" && value.length > 0, describe: "grayscale PNG path inside configured media/artifact roots", required: true, emits: { kind: "leaf" as const, schema: { type: "string" as const, minLength: 1 } } } } },
        },
        options: patchPropagationOptions,
        expectedRevision: expectedRevisionField,
      },
      output: {
        type: "object",
        additionalProperties: false,
        properties: {
          coordinateSpace: { const: "decoded-source-frame-raster" },
          matrixDirection: { const: "first-frame->current-frame" },
          revision: { type: "integer", minimum: 0 },
          sourceRevision: { type: "integer", minimum: 0 },
          sourcePath: { type: "string" },
          sourceFingerprint: openObject(),
          raster: openObject(),
          range: openObject(),
          frameTiming: openObject(),
          status: { enum: ["propagated", "needsRepair"] },
          patchedCount: { type: "integer", minimum: 0 },
          needsRepairCount: { type: "integer", minimum: 0 },
          termination: { anyOf: [openObject(), { const: null }] },
          frames: { type: "array", minItems: 2, items: openObject() },
          overlays: { type: "array", minItems: 1, items: openObject() },
          overlaySheet: { anyOf: [artifactOutput, { const: null }] },
          manifestPath: { type: "string" },
          parameters: openObject(),
          limitations: { type: "array", items: { type: "string" } },
        },
        required: ["coordinateSpace", "matrixDirection", "revision", "sourceRevision", "sourcePath", "sourceFingerprint", "raster", "range", "frameTiming", "status", "patchedCount", "needsRepairCount", "termination", "frames", "overlays", "overlaySheet", "manifestPath", "parameters", "limitations"],
      },
      async execute(input: PatchPropagationInput, context) {
        return runPatchPropagation(input, context);
      },
    }),
  ],
});
