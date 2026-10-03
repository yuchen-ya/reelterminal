/** Static alpha-mask cleanup candidates backed by the probed local OpenCV runtime. */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FacadeError } from "../errors";
import type { ToolContext } from "../plugin-api";
import { definePlugin, defineTool } from "../plugin-api";
import { artifactRefFor, assertContainedWrittenFile, prepareArtifactDir, requireArtifactRoot } from "../artifact-io";
import { opencvToolPreflight, runOpenCvScript } from "../media/opencv-runner";
import { parseSourceRef, resolveSourceFile } from "./source-ref";
import type { ObjectSchema } from "../validate";
import type { ArtifactRef } from "../providers";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));
const isSourceRef = (value: unknown): boolean =>
  isPlainObject(value) && hasOnlyKeys(value, ["mediaId", "path"]) && parseSourceRef(value) !== null;

const sourceField = {
  check: isSourceRef,
  describe: '{"mediaId":"..."} or {"path":"..."}, exactly one',
  required: true,
  emits: {
    kind: "anyOfObjects" as const,
    variants: [
      { mediaId: { check: (value: unknown) => typeof value === "string" && value.length > 0, describe: "an imported media id", required: true, emits: { kind: "leaf" as const, schema: { type: "string" as const, minLength: 1 } } } },
      { path: { check: (value: unknown) => typeof value === "string" && value.length > 0, describe: "a PNG path inside configured media/artifact roots", required: true, emits: { kind: "leaf" as const, schema: { type: "string" as const, minLength: 1 } } } },
    ] as const,
  },
};

const rectSchema: ObjectSchema = {
  x: { check: (value: unknown) => Number.isInteger(value) && (value as number) >= 0, describe: "a non-negative integer pixel coordinate", required: true, emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } } },
  y: { check: (value: unknown) => Number.isInteger(value) && (value as number) >= 0, describe: "a non-negative integer pixel coordinate", required: true, emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } } },
  width: { check: (value: unknown) => Number.isInteger(value) && (value as number) >= 2, describe: "an integer width of at least 2 pixels", required: true, emits: { kind: "leaf", schema: { type: "integer", minimum: 2 } } },
  height: { check: (value: unknown) => Number.isInteger(value) && (value as number) >= 2, describe: "an integer height of at least 2 pixels", required: true, emits: { kind: "leaf", schema: { type: "integer", minimum: 2 } } },
};

const maskInitializationSchema: ObjectSchema = {
  source: { ...sourceField, required: false },
  mask: sourceField,
};

const grabCutInitializationSchema: ObjectSchema = {
  source: sourceField,
  rect: { check: (value: unknown) => isPlainObject(value) && Object.keys(value).length === 4 && Object.entries(rectSchema).every(([key, rule]) => rule.check((value as Record<string, unknown>)[key])), describe: "an integer rectangle fully inside the source PNG (checked against its raster)", required: true, emits: { kind: "object", schema: rectSchema } },
  iterations: { check: (value: unknown) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 10, describe: "GrabCut iterations, integer 1–10 (default 5)", emits: { kind: "leaf", schema: { type: "integer", minimum: 1, maximum: 10 } } },
};

const artifactOutput = { type: "object" as const, additionalProperties: true, properties: {} };
const expectedRevisionField = {
  check: (value: unknown) => Number.isInteger(value) && (value as number) >= 0,
  describe: "a non-negative integer",
  emits: { kind: "leaf" as const, schema: { type: "integer" as const, minimum: 0 } },
};

export interface MaskRefineInput {
  readonly initialization:
    | { readonly source?: { mediaId?: string; path?: string }; readonly mask: { mediaId?: string; path?: string } }
    | { readonly source: { mediaId?: string; path?: string }; readonly rect: { x: number; y: number; width: number; height: number }; readonly iterations?: number };
  readonly dilatePx?: number;
  readonly erodePx?: number;
  readonly featherPx?: number;
  readonly expectedRevision?: number;
}

export interface MaskRefineResult {
  readonly revision: number;
  readonly sourceRevision: number;
  readonly method: "input-mask" | "grabcut-rectangle-initialization";
  readonly raster: { width: number; height: number };
  readonly alphaMask: ArtifactRef;
  readonly overlayCandidate: ArtifactRef | null;
  readonly maskStats: { foregroundPixels: number; opaquePixels: number; softEdgePixels: number };
  readonly parameters: Record<string, unknown>;
  readonly limitations: readonly string[];
}

const MAX_DIMENSION = 4096;

async function requireMaskOpenCv(): Promise<void> {
  const preflight = await opencvToolPreflight(["mask_refine.py"]);
  if (!preflight.available) {
    throw new FacadeError("UNSUPPORTED", `mask.refine: ${preflight.reason ?? "OpenCV runtime unavailable"}`);
  }
}

function validateMaskRefineInput(input: MaskRefineInput): void {
  for (const [name, value, maximum] of [
    ["dilatePx", input.dilatePx, 64],
    ["erodePx", input.erodePx, 64],
    ["featherPx", input.featherPx, 32],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > maximum)) {
      throw new FacadeError("INVALID_PARAMS", `mask.refine: ${name} must be an integer in [0, ${maximum}] pixels`);
    }
  }
}

async function runMaskRefine(input: MaskRefineInput, context: ToolContext): Promise<MaskRefineResult> {
  const verb = "mask.refine";
  await requireMaskOpenCv();
  validateMaskRefineInput(input);
  const revision = await context.snapshot().then((snapshot) => snapshot.revision);
  if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
    throw new FacadeError("CONFLICT", `revision conflict: expected ${input.expectedRevision}, current is ${revision}`);
  }

  const initialization = input.initialization;
  const grabCut = "rect" in initialization;
  const sourceFile = initialization.source
    ? await resolveSourceFile(parseSourceRef(initialization.source)!, context, verb)
    : null;
  const maskFile = !grabCut ? await resolveSourceFile(parseSourceRef(initialization.mask)!, context, verb) : null;
  if (sourceFile && !/\.png$/i.test(sourceFile)) {
    throw new FacadeError("INVALID_PARAMS", `${verb}: source must be a PNG still`);
  }
  if (maskFile && !/\.png$/i.test(maskFile)) {
    throw new FacadeError("INVALID_PARAMS", `${verb}: mask must be a PNG still`);
  }

  const root = requireArtifactRoot(context.artifactRoot, verb);
  const outputDir = resolve(root, "mask-tools", randomUUID());
  await prepareArtifactDir(outputDir, root, verb);
  try {
    const alphaPath = join(outputDir, "alpha-mask.png");
    const overlayPath = sourceFile ? join(outputDir, "overlay-candidate.png") : null;
    const response = await runOpenCvScript("mask_refine.py", {
      mode: grabCut ? "grabcut" : "mask",
      ...(sourceFile ? { sourcePath: sourceFile } : {}),
      ...(!grabCut && maskFile ? { maskPath: maskFile } : {}),
      ...(grabCut ? { rect: initialization.rect, iterations: initialization.iterations ?? 5 } : {}),
      dilatePx: input.dilatePx ?? 0,
      erodePx: input.erodePx ?? 0,
      featherPx: input.featherPx ?? 0,
      alphaOutput: alphaPath,
      ...(overlayPath ? { overlayOutput: overlayPath } : {}),
    }, { timeoutMs: 120_000 });
    const result = response.result as Record<string, unknown>;
    if (result.status === "rejected") {
      const reasonCode = String(result.reasonCode ?? "invalid_input");
      throw new FacadeError("INVALID_PARAMS", `${verb}: ${String(result.reason ?? reasonCode)}`, { reasonCode });
    }
    if (result.status !== "created" || result.alphaMask !== alphaPath || result.overlayCandidate !== overlayPath) {
      throw new FacadeError("JOB_FAILED", `${verb}: OpenCV worker returned an incomplete or unexpected result`);
    }
    const width = result.width;
    const height = result.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1 ||
      Math.max(width as number, height as number) > MAX_DIMENSION) {
      throw new FacadeError("JOB_FAILED", `${verb}: OpenCV worker reported an invalid output raster`);
    }
    const stats = result.maskStats as Record<string, unknown> | undefined;
    if (!stats || !Number.isInteger(stats.foregroundPixels) || !Number.isInteger(stats.opaquePixels) || !Number.isInteger(stats.softEdgePixels)) {
      throw new FacadeError("JOB_FAILED", `${verb}: OpenCV worker did not report mask statistics`);
    }
    const alphaRealPath = await assertContainedWrittenFile(alphaPath, root, verb);
    const alphaMask = await artifactRefFor(alphaRealPath, "image", "png", revision);
    let overlayCandidate: ArtifactRef | null = null;
    if (overlayPath) {
      const overlayRealPath = await assertContainedWrittenFile(overlayPath, root, verb);
      overlayCandidate = await artifactRefFor(overlayRealPath, "image", "png", revision);
    }
    return {
      revision,
      sourceRevision: revision,
      method: result.method as MaskRefineResult["method"],
      raster: { width: width as number, height: height as number },
      alphaMask,
      overlayCandidate,
      maskStats: {
        foregroundPixels: stats.foregroundPixels as number,
        opaquePixels: stats.opaquePixels as number,
        softEdgePixels: stats.softEdgePixels as number,
      },
      parameters: result.parameters as Record<string, unknown>,
      limitations: [
        "Candidate output only; no timeline, media, or project state is modified.",
        "Inputs must be 8-bit PNGs. A grayscale mask uses its gray values; RGB uses luminance; RGBA uses alpha when it is not fully opaque, otherwise RGB luminance. A standalone mask needs no source color image.",
        "A supplied RGBA source keeps its original alpha in the overlay candidate.",
        "GrabCut uses the rectangle only as an initialization hint. It is not a fully automatic or precise cutout; the result depends on foreground/background contrast and may need manual correction.",
        "Dilation runs before erosion, then optional Gaussian feathering. The source and mask must use the same raster; accepted PNGs are at most 4096 px per side and 16 megapixels.",
        ...(overlayCandidate ? [] : ["No source color image was supplied, so only the grayscale alpha mask was produced; an overlay candidate was not applicable."]),
      ],
    };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

export const maskToolsPlugin = definePlugin({
  id: "mask-tools",
  tools: [
    defineTool({
      name: "mask.refine",
      description:
        "Create a candidate grayscale alpha mask from either an 8-bit input PNG mask (source image optional) or an 8-bit source PNG plus a GrabCut initialization rectangle. Apply optional pixel-radius dilation, erosion, and Gaussian feathering; when a source image is supplied, also create a tinted overlay for visual review. GrabCut is only an initialization hint and is not a fully automatic precise cutout. Results are artifacts only; this read-only tool never changes the timeline.",
      schemaCases: [
        { name: "mask-only input without source color image", params: { initialization: { mask: { path: "C:/w/mask.png" } } }, expectValid: true },
        { name: "mask input with overlay source", params: { initialization: { source: { mediaId: "m1" }, mask: { path: "C:/w/mask.png" } }, dilatePx: 2, featherPx: 1 }, expectValid: true },
        { name: "GrabCut rectangle", params: { initialization: { source: { path: "C:/w/source.png" }, rect: { x: 10, y: 12, width: 100, height: 80 }, iterations: 5 } }, expectValid: true },
        { name: "missing initialization", params: {}, expectValid: false },
        { name: "rect without source", params: { initialization: { rect: { x: 0, y: 0, width: 20, height: 20 } } }, expectValid: false },
        { name: "ambiguous mask and rectangle", params: { initialization: { source: { path: "C:/w/source.png" }, mask: { path: "C:/w/mask.png" }, rect: { x: 0, y: 0, width: 20, height: 20 } } }, expectValid: false },
        { name: "negative dilation", params: { initialization: { mask: { path: "C:/w/mask.png" } }, dilatePx: -1 }, expectValid: false },
        { name: "oversized feather", params: { initialization: { mask: { path: "C:/w/mask.png" } }, featherPx: 33 }, expectValid: false },
      ],
      effect: "read",
      requires: ["artifactRoot", "mediaRoots"],
      presentation: "image-collection",
      input: {
        initialization: {
      check: (value: unknown) => {
            if (!isPlainObject(value)) return false;
            const hasMask = value.mask !== undefined;
            const hasRect = value.rect !== undefined;
            if (hasMask === hasRect) return false;
            if (hasMask) return hasOnlyKeys(value, ["source", "mask"]) && isSourceRef(value.mask) && (value.source === undefined || isSourceRef(value.source));
            return hasOnlyKeys(value, ["source", "rect", "iterations"]) && isSourceRef(value.source) && isPlainObject(value.rect) &&
              Object.keys(value.rect).length === 4 && Object.entries(rectSchema).every(([key, rule]) => rule.check((value.rect as Record<string, unknown>)[key])) &&
              (value.iterations === undefined || (Number.isInteger(value.iterations) && (value.iterations as number) >= 1 && (value.iterations as number) <= 10));
          },
          describe: "{mask, source?} for a supplied mask, or {source, rect, iterations?} for GrabCut; exactly one initialization mode",
          required: true,
          emits: { kind: "anyOfObjects", variants: [maskInitializationSchema, grabCutInitializationSchema] },
        },
        dilatePx: { check: (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 64, describe: "integer radius 0–64 px (default 0)", emits: { kind: "leaf", schema: { type: "integer", minimum: 0, maximum: 64 } } },
        erodePx: { check: (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 64, describe: "integer radius 0–64 px (default 0)", emits: { kind: "leaf", schema: { type: "integer", minimum: 0, maximum: 64 } } },
        featherPx: { check: (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 32, describe: "Gaussian sigma integer 0–32 px (default 0)", emits: { kind: "leaf", schema: { type: "integer", minimum: 0, maximum: 32 } } },
        expectedRevision: expectedRevisionField,
      },
      output: {
        type: "object",
        additionalProperties: false,
        properties: {
          revision: { type: "integer", minimum: 0 },
          sourceRevision: { type: "integer", minimum: 0 },
          method: { enum: ["input-mask", "grabcut-rectangle-initialization"] },
          raster: artifactOutput,
          alphaMask: artifactOutput,
          overlayCandidate: { anyOf: [artifactOutput, { const: null }] },
          maskStats: artifactOutput,
          parameters: artifactOutput,
          limitations: { type: "array", items: { type: "string" } },
        },
        required: ["revision", "sourceRevision", "method", "raster", "alphaMask", "overlayCandidate", "maskStats", "parameters", "limitations"],
      },
      async execute(input: MaskRefineInput, context) {
        return runMaskRefine(input, context);
      },
    }),
  ],
});
