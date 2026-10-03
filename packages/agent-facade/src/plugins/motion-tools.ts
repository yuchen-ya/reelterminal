/**
 * Motion & alignment production tools (optimization plan M2), backed by a
 * probed local OpenCV runtime (see media/opencv-runner.ts — no hardcoded
 * interpreter, no downloads; absence is an honest UNSUPPORTED).
 *
 * Both verbs are CANDIDATE-PRODUCING read-only tools under the artifact
 * root: they never touch the timeline, the project, or the GUI's simulated
 * motion-tracking engine state. Adoption still flows through the existing
 * edit.apply / media.replace path. image.align estimates a bounded
 * translation/similarity/affine transform between two stills and reports
 * method-specific scores (never a unified confidence); motion.track follows
 * a user-drawn region with LK sparse optical flow + forward-backward checks
 * + RANSAC similarity, stops at the first loss (never re-seeds across cuts)
 * and reports per-frame validity, errors and the termination reason. Frames
 * for tracking are extracted by the M1 frame-exact core, so frame indices
 * and PTS mapping stay exact even for VFR sources.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FacadeError } from "../errors";
import type { ToolContext } from "../plugin-api";
import { definePlugin, defineTool } from "../plugin-api";
import { artifactRefFor, assertContainedWrittenFile, prepareArtifactDir, requireArtifactRoot } from "../artifact-io";
import { probeRasterSize, extractFramesExact, probeVideoFacts, bestFrameCount, composeContactSheet } from "../media/frame-exact";
import { probeLabelFont, resolveToolFfmpeg } from "../media/ffmpeg-bin";
import { opencvToolPreflight, resolveOpenCvRuntime, runOpenCvScript } from "../media/opencv-runner";
import { parseSourceRef, resolveSourceFile } from "./source-ref";
import type { ArtifactRef } from "../providers";

/* ------------------------------------------------------------------ */
/* Shared input pieces                                                 */
/* ------------------------------------------------------------------ */

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const sourceField = {
  check: (v: unknown) => parseSourceRef(v) !== null,
  describe: '{"mediaId": "<project media id>"} or {"path": "<absolute path inside media/artifact roots>"} — exactly one',
  required: true,
  emits: {
    kind: "anyOfObjects" as const,
    variants: [
      { mediaId: { check: (v: unknown) => typeof v === "string" && v.length > 0, describe: "an imported media id", required: true, emits: { kind: "leaf" as const, schema: { type: "string" as const, minLength: 1 } } } },
      { path: { check: (v: unknown) => typeof v === "string" && v.length > 0, describe: "an absolute file path inside the configured media/artifact roots", required: true, emits: { kind: "leaf" as const, schema: { type: "string" as const, minLength: 1 } } } },
    ] as const,
  },
};

const expectedRevisionField = {
  check: (v: unknown) => Number.isInteger(v) && (v as number) >= 0,
  describe: "a non-negative integer",
  emits: { kind: "leaf" as const, schema: { type: "integer" as const, minimum: 0 } },
};

const openObject = () => ({ type: "object" as const, additionalProperties: true, properties: {} });

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

async function requireOpenCv(verb: string) {
  const runtime = await resolveOpenCvRuntime();
  if (!runtime) {
    const pre = await opencvToolPreflight();
    throw new FacadeError("UNSUPPORTED", `${verb}: ${pre.available ? "OpenCV runtime unavailable" : pre.reason}`);
  }
  return runtime;
}

const MAX_ALIGN_DIMENSION = 4096;

/* ------------------------------------------------------------------ */
/* image.align                                                         */
/* ------------------------------------------------------------------ */

export type AlignTransform = "translation" | "similarity" | "affine";

export interface ImageAlignInput {
  readonly reference: { mediaId?: string; path?: string };
  readonly moving: { mediaId?: string; path?: string };
  readonly transform: AlignTransform;
  readonly stableRegion?: { x: number; y: number; width: number; height: number };
  readonly eccIterations?: number;
  readonly eccEpsilon?: number;
  readonly expectedRevision?: number;
}

export interface ImageAlignResult {
  readonly revision: number;
  readonly sourceRevision: number;
  readonly reference: { path: string; width: number; height: number };
  readonly moving: { path: string; width: number; height: number };
  readonly transform: AlignTransform;
  readonly stableRegion: { x: number; y: number; width: number; height: number } | null;
  readonly status: "aligned" | "failed";
  readonly reasonCode: string | null;
  readonly reason: string | null;
  readonly method: string;
  readonly matrix3x3: readonly number[] | null;
  readonly matrixDirection: "moving->reference";
  readonly coordinateSpace: string;
  readonly alignedImage: ArtifactRef | null;
  readonly validCoverage: { polygon: readonly (readonly number[])[]; pixelCount: number } | null;
  readonly residual: Record<string, unknown> | null;
  readonly diagnostics: Record<string, unknown>;
  readonly limitations: readonly string[];
}

async function runImageAlign(input: ImageAlignInput, context: ToolContext): Promise<ImageAlignResult> {
  const verb = "image.align";
  await requireOpenCv(verb);
  const revision = await context.snapshot().then((s) => s.revision);
  if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
    throw new FacadeError("CONFLICT", `revision conflict: expected ${input.expectedRevision}, current is ${revision}`);
  }
  const referenceFile = await resolveSourceFile(parseSourceRef(input.reference)!, context, verb);
  const movingFile = await resolveSourceFile(parseSourceRef(input.moving)!, context, verb);
  for (const [role, path] of [["reference", referenceFile], ["moving", movingFile]] as const) {
    if (!/\.png$/i.test(path)) {
      throw new FacadeError("INVALID_PARAMS", `${verb}: ${role} must be a PNG still (extract video frames with frames.extract first): ${path}`);
    }
  }
  const root = requireArtifactRoot(context.artifactRoot, verb);
  const binaries = await resolveToolFfmpeg();
  if (!binaries) throw new FacadeError("UNSUPPORTED", `${verb}: raster probing needs ffmpeg/ffprobe (see the frameTools capability)`);
  const refRaster = await probeRasterSize(binaries.ffprobe, referenceFile);
  const movRaster = await probeRasterSize(binaries.ffprobe, movingFile);
  if (refRaster.width !== movRaster.width || refRaster.height !== movRaster.height) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: reference is ${refRaster.width}x${refRaster.height} but moving is ${movRaster.width}x${movRaster.height} — resize the moving image to the reference raster first; this verb refuses to guess the relation`,
    );
  }
  if (Math.max(refRaster.width, refRaster.height) > MAX_ALIGN_DIMENSION) {
    throw new FacadeError("INVALID_PARAMS", `${verb}: rasters above ${MAX_ALIGN_DIMENSION}px are not supported (reference is ${refRaster.width}x${refRaster.height})`);
  }
  const stableRegion = input.stableRegion;
  if (stableRegion &&
    (stableRegion.x + stableRegion.width > refRaster.width || stableRegion.y + stableRegion.height > refRaster.height)) {
    throw new FacadeError("INVALID_PARAMS", `${verb}: stableRegion exceeds the ${refRaster.width}x${refRaster.height} reference raster`);
  }
  const outputDir = resolve(root, "motion-tools", randomUUID());
  await prepareArtifactDir(outputDir, root, verb);
  try {
    const alignedPath = join(outputDir, "aligned.png");
    const response = await runOpenCvScript("align.py", {
      reference: referenceFile,
      moving: movingFile,
      alignedOutput: alignedPath,
      transform: input.transform,
      ...(stableRegion ? { stableRegion } : {}),
      ...(input.eccIterations !== undefined ? { eccIterations: input.eccIterations } : {}),
      ...(input.eccEpsilon !== undefined ? { eccEpsilon: input.eccEpsilon } : {}),
    }, { timeoutMs: 300_000 });
    const result = response.result as Record<string, unknown>;
    const status = result.status === "aligned" ? "aligned" : "failed";
    let alignedArtifact: ArtifactRef | null = null;
    if (status === "aligned") {
      const verified = await assertContainedWrittenFile(String(result.alignedImage), root, verb);
      alignedArtifact = await artifactRefFor(verified, "image", "png", revision);
    }
    const limitations = [
      "Candidate output only — nothing on the timeline changes. Adopt through edit.apply / media.replace.",
      "Scores are method-specific: the ECC correlation coefficient and the ORB inlier statistics measure different things and are NOT comparable — never treat either as a unified confidence.",
      "Residuals are grayscale mean-abs-diff computed only inside validCoverage ∩ stableRegion, excluding the black fill outside the warped moving image.",
      "Estimation failures (low texture, too few features, no overlap, no consistent model) return status \"failed\" with a reasonCode — never an identity matrix.",
    ];
    if (status === "failed") {
      limitations.push("No aligned image was produced for this failed estimation; the reported diagnostics describe why.");
    }
    return {
      revision,
      sourceRevision: revision,
      reference: { path: referenceFile, width: refRaster.width, height: refRaster.height },
      moving: { path: movingFile, width: movRaster.width, height: movRaster.height },
      transform: input.transform,
      stableRegion: stableRegion ?? null,
      status,
      reasonCode: (result.reasonCode as string | undefined) ?? null,
      reason: (result.reason as string | undefined) ?? null,
      method: result.method as string,
      matrix3x3: (result.matrix3x3 as number[] | undefined) ?? null,
      matrixDirection: "moving->reference",
      coordinateSpace: (result.coordinateSpace as string | undefined) ?? "reference-raster pixels, origin top-left",
      alignedImage: alignedArtifact,
      validCoverage: (result.validCoverage as ImageAlignResult["validCoverage"]) ?? null,
      residual: (result.residual as Record<string, unknown> | undefined) ?? null,
      diagnostics: (result.diagnostics as Record<string, unknown> | undefined) ?? {},
      limitations,
    };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* motion.track                                                        */
/* ------------------------------------------------------------------ */

export const MAX_TRACK_FRAMES = 240;

export interface MotionTrackInput {
  readonly source: { mediaId?: string; path?: string };
  /** Half-open [startFrame, endFrame) zero-based decode range, ≥ 2 frames. */
  readonly range: { startFrame: number; endFrame: number };
  /** Region in DECODED-frame raster pixels, evaluated at startFrame. */
  readonly region: { x: number; y: number; width: number; height: number };
  readonly options?: {
    readonly gridStep?: number;
    readonly maxForwardBackwardError?: number;
    readonly minInliers?: number;
    readonly overlayCount?: number;
  };
  readonly expectedRevision?: number;
}

export interface MotionTrackResult {
  readonly coordinateSpace: "decoded-source-frame-raster";
  readonly revision: number;
  readonly sourceRevision: number;
  readonly sourcePath: string;
  readonly sourceFingerprint: { size: number; lastModified: number };
  readonly raster: { width: number; height: number };
  readonly range: { startFrame: number; endFrame: number };
  readonly initialRegion: { x: number; y: number; width: number; height: number };
  readonly frameTiming: Record<string, unknown>;
  readonly status: "tracked" | "lost";
  readonly trackedFrameCount: number;
  readonly lostAtFrame: number | null;
  readonly terminationReasonCode: string | null;
  readonly terminationReason: string | null;
  readonly frames: readonly Record<string, unknown>[];
  readonly frameMapping: readonly { frame: number; ptsTimeSec: number }[];
  readonly overlays: readonly { frame: number; artifact: ArtifactRef }[];
  readonly overlaySheet: ArtifactRef | null;
  readonly manifestPath: string;
  readonly parameters: Record<string, unknown>;
  readonly limitations: readonly string[];
}

async function runMotionTrack(input: MotionTrackInput, context: ToolContext): Promise<MotionTrackResult> {
  const verb = "motion.track";
  const binaries = await requireFfmpegBinaries(verb);
  await requireOpenCv(verb);
  const revision = await context.snapshot().then((s) => s.revision);
  if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
    throw new FacadeError("CONFLICT", `revision conflict: expected ${input.expectedRevision}, current is ${revision}`);
  }
  const sourceFile = await resolveSourceFile(parseSourceRef(input.source)!, context, verb);
  const root = requireArtifactRoot(context.artifactRoot, verb);
  const { startFrame, endFrame } = input.range;
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || endFrame <= startFrame + 1) {
    throw new FacadeError("INVALID_PARAMS", `${verb}: range must satisfy 0 ≤ startFrame and endFrame ≥ startFrame + 2 (at least two frames to track)`);
  }
  if (endFrame - startFrame > MAX_TRACK_FRAMES) {
    throw new FacadeError("INVALID_PARAMS", `${verb}: range spans ${endFrame - startFrame} frames; track at most ${MAX_TRACK_FRAMES} per call`);
  }
  const region = input.region;
  const options = input.options ?? {};
  if (options.gridStep !== undefined && (!Number.isInteger(options.gridStep) || options.gridStep < 2 || options.gridStep > 128)) {
    throw new FacadeError("INVALID_PARAMS", `${verb}: gridStep is an integer in [2, 128] pixels`);
  }
  if (options.maxForwardBackwardError !== undefined &&
    (!(options.maxForwardBackwardError > 0) || options.maxForwardBackwardError > 20)) {
    throw new FacadeError("INVALID_PARAMS", `${verb}: maxForwardBackwardError is a number in (0, 20] pixels`);
  }
  if (options.minInliers !== undefined && (!Number.isInteger(options.minInliers) || options.minInliers < 4 || options.minInliers > 50)) {
    throw new FacadeError("INVALID_PARAMS", `${verb}: minInliers is an integer in [4, 50]`);
  }
  if (options.overlayCount !== undefined && (!Number.isInteger(options.overlayCount) || options.overlayCount < 1 || options.overlayCount > 16)) {
    throw new FacadeError("INVALID_PARAMS", `${verb}: overlayCount is an integer in [1, 16]`);
  }

  const outputDir = resolve(root, "motion-tools", randomUUID());
  await prepareArtifactDir(outputDir, root, verb);
  try {
    const facts = await probeVideoFacts(binaries.ffprobe, sourceFile);
    const total = bestFrameCount(facts);
    if (total !== null && endFrame > total) {
      throw new FacadeError("INVALID_PARAMS", `${verb}: endFrame ${endFrame} exceeds the source's ${total} frames`);
    }
    const indices = Array.from({ length: endFrame - startFrame }, (_, i) => startFrame + i);
    const framesDir = join(outputDir, "frames");
    const extracted = await extractFramesExact(binaries.ffmpeg, sourceFile, indices, framesDir);
    const firstPng = await probeRasterSize(binaries.ffprobe, extracted.frames[0]!.path);
    // Decoded PNGs carry the AUTOROTATED raster; when it differs from the
    // coded stream dimensions, every coordinate below is in the decoded
    // raster and the result says so.
    const rotated = firstPng.width !== facts.width || firstPng.height !== facts.height;
    if (!(region.width >= 4 && region.height >= 4) ||
      region.x + region.width > firstPng.width || region.y + region.height > firstPng.height) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: region must be a ≥4x4 rectangle inside the ${firstPng.width}x${firstPng.height} decoded frame raster`,
      );
    }
    const overlayDir = join(outputDir, "overlays");
    await mkdir(overlayDir, { recursive: true });
    const response = await runOpenCvScript("track.py", {
      framesDir,
      frameIndices: indices,
      region,
      ...(options.gridStep !== undefined ? { gridStep: options.gridStep } : {}),
      ...(options.maxForwardBackwardError !== undefined ? { maxForwardBackwardError: options.maxForwardBackwardError } : {}),
      ...(options.minInliers !== undefined ? { minInliers: options.minInliers } : {}),
      overlayDir,
      ...(options.overlayCount !== undefined ? { overlayCount: options.overlayCount } : {}),
    }, { timeoutMs: 120_000 + (endFrame - startFrame) * 2_000 });
    const track = response.result as Record<string, unknown>;
    const frames = (track.frames as Record<string, unknown>[] | undefined) ?? [];
    if (frames.length !== indices.length) {
      throw new FacadeError("JOB_FAILED", `${verb}: tracker returned ${frames.length} frame entries for ${indices.length} requested frames`);
    }
    const overlays: { frame: number; artifact: ArtifactRef }[] = [];
    for (const entry of (track.overlays as { frame: number; path: string }[] | undefined) ?? []) {
      const verified = await assertContainedWrittenFile(entry.path, root, verb);
      overlays.push({ frame: entry.frame, artifact: await artifactRefFor(verified, "image", "png", revision) });
    }
    let overlaySheet: ArtifactRef | null = null;
    if (overlays.length > 1) {
      const font = await probeLabelFont();
      const sheetPath = join(outputDir, "overlay-sheet.png");
      const raster = await probeRasterSize(binaries.ffprobe, overlays[0]!.artifact.path);
      const cellWidth = 256;
      const cellInnerHeight = Math.max(2, Math.round((cellWidth * raster.height) / raster.width / 2) * 2);
      const columns = Math.min(4, overlays.length);
      const rows = Math.ceil(overlays.length / columns);
      await composeContactSheet(
        binaries.ffmpeg,
        overlays.map((o) => ({ path: o.artifact.path, width: raster.width, height: raster.height, label: `frame ${o.frame}` })),
        sheetPath,
        { cellWidth, cellInnerHeight, labelStripHeight: 18, columns, rows },
        { fontFile: font },
      );
      const verified = await assertContainedWrittenFile(sheetPath, root, verb);
      overlaySheet = await artifactRefFor(verified, "image", "png", revision);
    }
    const termination = (track.termination as { atFrame?: number; reasonCode?: string; reason?: string } | null) ?? null;
    const sourceStat = await stat(sourceFile);
    const manifest = {
      verb,
      coordinateSpace: "decoded-source-frame-raster",
      source: { path: sourceFile, fingerprint: { size: sourceStat.size, lastModified: Math.round(sourceStat.mtimeMs) }, frameTiming: facts.timing },
      range: { startFrame, endFrame, halfOpen: true },
      initialRegion: region,
      raster: firstPng,
      parameters: track.parameters ?? {},
      status: track.status,
      termination,
      seedPointCount: track.seedPointCount,
      frames,
      frameMapping: extracted.frames.map((f) => ({ frame: f.frame, ptsTimeSec: f.ptsTimeSec })),
      limitations: [
        "Candidate tracking data only — no timeline keyframes are written and the GUI motion engine state is untouched. Drive keyframes yourself through edit.apply if wanted.",
        "The tracker never re-seeds across a loss: the first frame that fails forward-backward checking or RANSAC ends the run with a reason; every later frame is not_tracked with a null matrix.",
        "Matrices map the start-frame region into each frame's coordinates (cumulative similarity, row-major 3x3); drift shows in inlierRmsePx and the shrinking trackedPointCount.",
      ],
    };
    const manifestPath = join(outputDir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const verifiedManifest = await assertContainedWrittenFile(manifestPath, root, verb);
    const limitations = [
      ...manifest.limitations,
      ...(rotated
        ? [`The source carries rotation metadata: the coded raster is ${facts.width}x${facts.height} but decoded frames are ${firstPng.width}x${firstPng.height}; every region/matrix coordinate is in the DECODED (autorotated) raster.`]
        : []),
      "Tracking runs on EXACT extracted source frames (zero-based decode indices with real PTS in frameMapping) — it is defined for source-native playback only; timeline speed/reverse mapping is the caller's job and is deliberately not guessed.",
      "Success means a trustworthy report, not that the motion is physically plausible: the numbers are correspondence statistics, never an action-naturalness verdict.",
    ];
    return {
      coordinateSpace: "decoded-source-frame-raster",
      revision,
      sourceRevision: revision,
      sourcePath: sourceFile,
      sourceFingerprint: { size: sourceStat.size, lastModified: Math.round(sourceStat.mtimeMs) },
      raster: firstPng,
      range: { startFrame, endFrame },
      initialRegion: region,
      frameTiming: facts.timing as unknown as Record<string, unknown>,
      status: (track.status as "tracked" | "lost") ?? "lost",
      trackedFrameCount: frames.filter((f) => f.status === "tracked").length,
      lostAtFrame: termination?.atFrame ?? null,
      terminationReasonCode: termination?.reasonCode ?? null,
      terminationReason: termination?.reason ?? null,
      frames,
      frameMapping: manifest.frameMapping,
      overlays,
      overlaySheet,
      manifestPath: verifiedManifest,
      parameters: (track.parameters as Record<string, unknown> | undefined) ?? {},
      limitations,
    };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

async function requireFfmpegBinaries(verb: string) {
  const binaries = await resolveToolFfmpeg();
  if (!binaries) {
    throw new FacadeError(
      "UNSUPPORTED",
      `${verb}: no usable ffmpeg/ffprobe — install them on PATH or set REELTERMINAL_FFMPEG_PATH / REELTERMINAL_FFPROBE_PATH`,
    );
  }
  return binaries;
}

/* ------------------------------------------------------------------ */
/* Plugin registration                                                 */
/* ------------------------------------------------------------------ */

export const motionToolsPlugin = definePlugin({
  id: "motion-tools",
  tools: [
    defineTool({
      name: "image.align",
      description:
        "Estimate how one PNG still must be transformed to align with another: translation (ECC), similarity (ORB+RANSAC, rotation+uniform scale+translation) or affine (ORB+RANSAC, 6-DOF). Optional stableRegion restricts estimation (and residual scoring) to the part of the scene you trust. Output: the homogeneous moving->reference matrix (row-major 3x3), the aligned candidate PNG, its valid-coverage polygon (fill excluded), a grayscale residual inside the scored region, and METHOD-SPECIFIC scores (ECC correlation vs ORB inlier stats — never one unified confidence). Both rasters must match exactly; failures (low texture, too few features, no overlap) return status \"failed\" with a reasonCode — never an identity matrix. Read-only candidate producer.",
      schemaCases: [
        { name: "translation", params: { reference: { path: "C:/w/ref.png" }, moving: { path: "C:/w/mov.png" }, transform: "translation" }, expectValid: true },
        { name: "similarity with region", params: { reference: { mediaId: "m1" }, moving: { path: "C:/w/mov.png" }, transform: "similarity", stableRegion: { x: 10, y: 10, width: 100, height: 80 } }, expectValid: true },
        { name: "bad transform", params: { reference: { path: "C:/w/ref.png" }, moving: { path: "C:/w/mov.png" }, transform: "homography" }, expectValid: false },
        { name: "missing moving", params: { reference: { path: "C:/w/ref.png" }, transform: "affine" }, expectValid: false },
        { name: "bad region", params: { reference: { path: "C:/w/ref.png" }, moving: { path: "C:/w/mov.png" }, transform: "affine", stableRegion: { x: -1, y: 0, width: 10, height: 10 } }, expectValid: false },
      ],
      effect: "read",
      requires: ["artifactRoot", "mediaRoots"],
      presentation: "image-collection",
      input: {
        reference: sourceField,
        moving: sourceField,
        transform: {
          check: (v: unknown) => v === "translation" || v === "similarity" || v === "affine",
          describe: '"translation" | "similarity" | "affine" — bounded transform classes only; no free-form deformation',
          required: true,
          emits: { kind: "leaf", schema: { enum: ["translation", "similarity", "affine"] } },
        },
        stableRegion: {
          check: pixelRoi,
          describe: "optional integer-pixel rectangle in the REFERENCE raster restricting estimation and residual scoring to the stable scene part",
          emits: ROI_EMITS,
        },
        eccIterations: {
          check: (v: unknown) => Number.isInteger(v) && (v as number) >= 10 && (v as number) <= 1000,
          describe: "ECC iteration cap in [10, 1000] (translation method; default 200)",
          emits: { kind: "leaf", schema: { type: "integer", minimum: 10, maximum: 1000 } },
        },
        eccEpsilon: {
          check: (v: unknown) => typeof v === "number" && Number.isFinite(v) && (v as number) > 0 && (v as number) <= 0.1,
          describe: "ECC convergence epsilon in (0, 0.1] (translation method; default 1e-6)",
          emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0, maximum: 0.1 } },
        },
        expectedRevision: expectedRevisionField,
      },
      output: {
        type: "object",
        additionalProperties: false,
        properties: {
          revision: { type: "integer", minimum: 0 },
          sourceRevision: { type: "integer", minimum: 0 },
          reference: openObject(),
          moving: openObject(),
          transform: { enum: ["translation", "similarity", "affine"] },
          stableRegion: { anyOf: [ROI_EMITS.schema, { const: null }] },
          status: { enum: ["aligned", "failed"] },
          reasonCode: { anyOf: [{ type: "string" }, { const: null }] },
          reason: { anyOf: [{ type: "string" }, { const: null }] },
          method: { type: "string" },
          matrix3x3: { anyOf: [{ type: "array", minItems: 9, maxItems: 9, items: { type: "number" } }, { const: null }] },
          matrixDirection: { const: "moving->reference" },
          coordinateSpace: { type: "string" },
          alignedImage: { anyOf: [artifactOutput, { const: null }] },
          validCoverage: { anyOf: [openObject(), { const: null }] },
          residual: { anyOf: [openObject(), { const: null }] },
          diagnostics: openObject(),
          limitations: { type: "array", items: { type: "string" } },
        },
        required: ["revision", "sourceRevision", "reference", "moving", "transform", "stableRegion", "status", "reasonCode", "reason", "method", "matrix3x3", "matrixDirection", "coordinateSpace", "alignedImage", "validCoverage", "residual", "diagnostics", "limitations"],
      },
      async execute(input: ImageAlignInput, context) {
        return runImageAlign(input, context);
      },
    }),
    defineTool({
      name: "motion.track",
      description:
        "Follow a user-drawn region through an explicit source-frame range with LK sparse optical flow + forward-backward checking + RANSAC similarity estimation. Frames are extracted by the frame-exact core (zero-based decode indices, real PTS per frame — exact even for VFR sources). Output: per-frame cumulative region transform (row-major 3x3, start-frame region -> this frame), validity, forward-backward/inlier error statistics, the loss frame + reason on failure, trajectory overlay PNGs and a review sheet, all as candidates under the artifact root. The tracker NEVER re-seeds across a loss: cuts, occlusions and drift collapse end the run with an honest termination reason. No timeline keyframes are written; nothing about physical plausibility is claimed. At most 240 frames per call.",
      schemaCases: [
        { name: "range track", params: { source: { mediaId: "m1" }, range: { startFrame: 10, endFrame: 42 }, region: { x: 20, y: 20, width: 60, height: 60 } }, expectValid: true },
        { name: "single frame", params: { source: { mediaId: "m1" }, range: { startFrame: 10, endFrame: 11 }, region: { x: 20, y: 20, width: 60, height: 60 } }, expectValid: false, schemaValid: true },
        { name: "too long", params: { source: { mediaId: "m1" }, range: { startFrame: 0, endFrame: 241 }, region: { x: 20, y: 20, width: 60, height: 60 } }, expectValid: false, schemaValid: true },
        { name: "bad region", params: { source: { mediaId: "m1" }, range: { startFrame: 0, endFrame: 10 }, region: { x: 20, y: 20, width: 3, height: 60 } }, expectValid: false, schemaValid: true },
        { name: "bad gridStep", params: { source: { mediaId: "m1" }, range: { startFrame: 0, endFrame: 10 }, region: { x: 20, y: 20, width: 60, height: 60 }, options: { gridStep: 1 } }, expectValid: false },
        { name: "missing source", params: { range: { startFrame: 0, endFrame: 10 }, region: { x: 20, y: 20, width: 60, height: 60 } }, expectValid: false },
      ],
      effect: "read",
      requires: ["artifactRoot", "mediaRoots"],
      presentation: "image-collection",
      input: {
        source: sourceField,
        range: {
          check: (v: unknown) => {
            if (!isPlainObject(v)) return false;
            const { startFrame, endFrame } = v;
            return Number.isInteger(startFrame) && (startFrame as number) >= 0 &&
              Number.isInteger(endFrame) && (endFrame as number) > (startFrame as number) + 1 &&
              (endFrame as number) - (startFrame as number) <= MAX_TRACK_FRAMES;
          },
          describe: `{"startFrame": n, "endFrame": m}: half-open zero-based decode range, 2–${MAX_TRACK_FRAMES} frames`,
          required: true,
          emits: { kind: "object", schema: {
            startFrame: { check: (v: unknown) => Number.isInteger(v) && (v as number) >= 0, describe: "first tracked frame (zero-based)", required: true, emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } } },
            endFrame: { check: (v: unknown) => Number.isInteger(v) && (v as number) > 1, describe: "exclusive end frame", required: true, emits: { kind: "leaf", schema: { type: "integer", exclusiveMinimum: 1 } } },
          } },
        },
        region: {
          check: (v: unknown) => {
            if (!pixelRoi(v)) return false;
            const q = v as Record<string, number>;
            return q.width >= 4 && q.height >= 4;
          },
          describe: "integer-pixel rectangle (≥4x4) in the DECODED frame raster, positioned at startFrame",
          required: true,
          emits: ROI_EMITS,
        },
        options: {
          check: (v: unknown) => {
            if (v === undefined) return true;
            if (!isPlainObject(v)) return false;
            const q = v as Record<string, unknown>;
            const keys = Object.keys(q);
            if (keys.some((k) => !["gridStep", "maxForwardBackwardError", "minInliers", "overlayCount"].includes(k))) return false;
            if (q.gridStep !== undefined && (!Number.isInteger(q.gridStep) || (q.gridStep as number) < 2 || (q.gridStep as number) > 128)) return false;
            if (q.maxForwardBackwardError !== undefined && (!(q.maxForwardBackwardError as number > 0) || (q.maxForwardBackwardError as number) > 20)) return false;
            if (q.minInliers !== undefined && (!Number.isInteger(q.minInliers) || (q.minInliers as number) < 4 || (q.minInliers as number) > 50)) return false;
            if (q.overlayCount !== undefined && (!Number.isInteger(q.overlayCount) || (q.overlayCount as number) < 1 || (q.overlayCount as number) > 16)) return false;
            return true;
          },
          describe: "{gridStep?, maxForwardBackwardError?, minInliers?, overlayCount?}: feature seed spacing px [2,128] (corner minDistance ≈ gridStep/2), FB-error threshold px (0,20] (default 2), RANSAC inlier floor [4,50] (default 4), overlay image count [1,16] (default 12)",
          emits: { kind: "object", schema: {
            gridStep: { check: (v: unknown) => Number.isInteger(v) && (v as number) >= 2 && (v as number) <= 128, describe: "feature seed spacing in [2, 128] px (corner minDistance ≈ gridStep/2)", emits: { kind: "leaf", schema: { type: "integer", minimum: 2, maximum: 128 } } },
            maxForwardBackwardError: { check: (v: unknown) => typeof v === "number" && v > 0 && v <= 20, describe: "forward-backward error threshold in (0, 20] px (default 2)", emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0, maximum: 20 } } },
            minInliers: { check: (v: unknown) => Number.isInteger(v) && (v as number) >= 4 && (v as number) <= 50, describe: "minimum RANSAC inliers in [4, 50] (default 4)", emits: { kind: "leaf", schema: { type: "integer", minimum: 4, maximum: 50 } } },
            overlayCount: { check: (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 16, describe: "overlay image count in [1, 16] (default 12)", emits: { kind: "leaf", schema: { type: "integer", minimum: 1, maximum: 16 } } },
          } },
        },
        expectedRevision: expectedRevisionField,
      },
      output: {
        type: "object",
        additionalProperties: false,
        properties: {
          coordinateSpace: { const: "decoded-source-frame-raster" },
          revision: { type: "integer", minimum: 0 },
          sourceRevision: { type: "integer", minimum: 0 },
          sourcePath: { type: "string" },
          sourceFingerprint: openObject(),
          raster: openObject(),
          range: openObject(),
          initialRegion: ROI_EMITS.schema,
          frameTiming: openObject(),
          status: { enum: ["tracked", "lost"] },
          trackedFrameCount: { type: "integer", minimum: 1 },
          lostAtFrame: { anyOf: [{ type: "integer", minimum: 0 }, { const: null }] },
          terminationReasonCode: { anyOf: [{ type: "string" }, { const: null }] },
          terminationReason: { anyOf: [{ type: "string" }, { const: null }] },
          frames: { type: "array", minItems: 2, items: openObject() },
          frameMapping: { type: "array", minItems: 2, items: openObject() },
          overlays: { type: "array", items: openObject() },
          overlaySheet: { anyOf: [artifactOutput, { const: null }] },
          manifestPath: { type: "string" },
          parameters: openObject(),
          limitations: { type: "array", items: { type: "string" } },
        },
        required: ["coordinateSpace", "revision", "sourceRevision", "sourcePath", "sourceFingerprint", "raster", "range", "initialRegion", "frameTiming", "status", "trackedFrameCount", "lostAtFrame", "terminationReasonCode", "terminationReason", "frames", "frameMapping", "overlays", "overlaySheet", "manifestPath", "parameters", "limitations"],
      },
      async execute(input: MotionTrackInput, context) {
        return runMotionTrack(input, context);
      },
    }),
  ],
});
