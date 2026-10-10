/**
 * Shared cross-field verb-parameter rules — the ONE copy of every rule that
 * was duplicated between the headless session (session.ts), the live session
 * (live-session.ts) and the factory boundary (request-validation.ts).
 *
 * These are PURE functions: they take already schema-validated params (plus
 * plain configuration values such as roots) and either return the normalized
 * slice or throw FacadeError(INVALID_PARAMS…). No session state, no I/O
 * (the verify.artifact resolvers only read the filesystem to classify a path
 * exactly as both sessions did before this extraction).
 *
 * Modes with genuinely different product contracts keep their difference as
 * an explicit parameter, not as a second copy of the rule:
 *  - verify.artifact reference resolution: headless falls back to mediaRoots,
 *    live does not (a live session has no mediaRoots — see LiveFacadeConfig).
 * Everything else was (and stays) byte-identical between the two entries.
 */
import type { Project } from "@reelterminal/core/types/project";
import { stat } from "node:fs/promises";

import { FacadeError } from "./errors";
import { validateEditBatch, validateEditOp } from "./ops";
import {
  resolveDeliveredArtifactPath,
} from "./delivery";
import { hasUrlScheme, resolveContainedPathDetailed } from "./media/path-roots";
import {
  buildVisualSamplePlan,
  MAX_VISUAL_CONTACT_SHEET_PIXELS,
  MAX_VISUAL_FRAME_PIXELS,
  visualRasterSize,
} from "./visual-inspect";
import {
  EDITOR_CONTROL_TARGET_SCHEMA,
  TIMELINE_QUERY_RANGE_SCHEMA,
  VERIFY_COMPARE_SCHEMA,
  VERIFY_EXPECT_SCHEMA,
  VERIFY_REGION_SCHEMA,
  VISUAL_INSPECT_RANGE_SCHEMA,
} from "./verb-schemas";
import { validateObject } from "./validate";
import type { LiveEditorControlParams, LiveEditorControlTarget } from "./live-store";
import type { EditOp, VisualInspectParams, VerifyArtifactParams } from "./types";

/* ---------------------------- timeline.query ------------------------- */

/**
 * timeRange cross-field rule: the nested range object re-validates against
 * its closed schema and endSec must be strictly greater than startSec.
 */
export function validateTimelineQueryTimeRange(valid: {
  readonly timeRange?: { readonly startSec: number; readonly endSec: number };
}): void {
  if (valid.timeRange !== undefined) {
    const range = validateObject<{ startSec: number; endSec: number }>(
      valid.timeRange,
      TIMELINE_QUERY_RANGE_SCHEMA,
      "timeline.query params.timeRange",
    );
    if (range.endSec <= range.startSec) {
      throw new FacadeError(
        "INVALID_PARAMS",
        "timeline.query: timeRange.endSec must be greater than startSec",
      );
    }
  }
}

/* ---------------------------- editor.control ------------------------- */

/**
 * Per-target closed-schema validation. Returns the normalized targets so the
 * live session can forward exactly these to the renderer bridge.
 */
export function validateEditorControlTargets(
  targets: LiveEditorControlParams["targets"],
): LiveEditorControlTarget[] | undefined {
  return targets?.map((target, index) =>
    validateObject<LiveEditorControlTarget>(
      target,
      EDITOR_CONTROL_TARGET_SCHEMA,
      `editor.control params.targets[${index}]`,
    ),
  );
}

/**
 * action/timeSeconds/targets cross-field rules: seek needs timeSeconds and
 * nothing else may carry it; select needs at least one target and nothing
 * else may carry targets/selectionMode.
 */
export function validateEditorControlAction(valid: LiveEditorControlParams): void {
  if (valid.action === "seek" && valid.timeSeconds === undefined) {
    throw new FacadeError("INVALID_PARAMS", "editor.control: seek requires timeSeconds");
  }
  if (valid.action !== "seek" && valid.timeSeconds !== undefined) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `editor.control: timeSeconds is only valid for seek, not ${valid.action}`,
    );
  }
  if (valid.action === "select" && (!valid.targets || valid.targets.length === 0)) {
    throw new FacadeError("INVALID_PARAMS", "editor.control: select requires at least one target");
  }
  if (
    valid.action !== "select" &&
    (valid.targets !== undefined || valid.selectionMode !== undefined)
  ) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `editor.control: targets and selectionMode are only valid for select, not ${valid.action}`,
    );
  }
}

/* ---------------------------- visual.inspect -------------------------- */

/** Nested timeRange closed-schema validation (shared pre-check). */
export function validateVisualInspectTimeRange(valid: {
  readonly timeRange?: unknown;
}): void {
  if (valid.timeRange !== undefined) {
    validateObject(
      valid.timeRange,
      VISUAL_INSPECT_RANGE_SCHEMA,
      "visual.inspect params.timeRange",
    );
  }
}

export interface VisualInspectRenderPlan {
  readonly plan: ReturnType<typeof buildVisualSamplePlan>;
  readonly width: number;
  readonly height: number;
  readonly sampleCount: number;
}

/**
 * Sample plan + raster resolution + the two pixel-budget ceilings. Both
 * sessions ran this exact sequence (plan → raster → frame budget → contact
 * sheet budget) before touching any provider or artifact directory.
 */
export function prepareVisualInspectRenderPlan(
  project: Project,
  valid: VisualInspectParams,
): VisualInspectRenderPlan {
  const plan = buildVisualSamplePlan(project, valid);
  const sampleCount = plan.samples.length;
  const { width, height } = visualRasterSize(project, valid.width, valid.height);
  const framePixels = width * height;
  const columns = Math.min(4, sampleCount);
  const rows = Math.ceil(sampleCount / columns);
  const sheetPixels =
    (columns * (width + 8) + 8) * (rows * (height + 28) + 8);
  if (framePixels > MAX_VISUAL_FRAME_PIXELS) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `visual.inspect: raster size ${width}x${height} exceeds the ${MAX_VISUAL_FRAME_PIXELS}-pixel frame limit`,
    );
  }
  if (sampleCount * framePixels > MAX_VISUAL_CONTACT_SHEET_PIXELS || sheetPixels > MAX_VISUAL_CONTACT_SHEET_PIXELS) {
    throw new FacadeError(
      "INVALID_PARAMS",
      "visual.inspect: requested samples exceed the contact-sheet pixel budget",
      { sampleCount, width, height },
    );
  }
  return { plan, width, height, sampleCount };
}

/* ------------------------- edit.apply / edit.validate ----------------- */

/** Per-op closed-schema validation (the batch boundary's first pass). */
export function validateEditOpList(ops: readonly unknown[]): EditOp[] {
  return ops.map((raw, index) => validateEditOp(raw, index));
}

/** Cross-op constraints, then the non-empty rule. */
export function assertValidEditBatch(
  verb: "edit.apply" | "edit.validate",
  ops: readonly EditOp[],
): void {
  validateEditBatch(ops);
  if (ops.length === 0) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: ops must contain at least one op`,
    );
  }
}

/**
 * Batch boundary in one call: every op against its closed schema, then the
 * cross-op constraints, then the non-empty rule — the zero-side-effect
 * ordering both sessions use before any enrichment, ledger lookup or store
 * access (edit.apply). edit.validate keeps its enrich-then-assert order and
 * calls the two pieces separately.
 */
export function parseEditOps(
  verb: "edit.apply" | "edit.validate",
  ops: readonly unknown[],
): EditOp[] {
  const parsed = validateEditOpList(ops);
  assertValidEditBatch(verb, parsed);
  return parsed;
}

/* ---------------------------- verify.artifact ------------------------- */

/** Nested expect closed-schema validation (shared pre-check). */
export function parseVerifyExpect(valid: VerifyArtifactParams) {
  if (valid.expect === undefined) return undefined;
  return validateObject<NonNullable<VerifyArtifactParams["expect"]>>(
    valid.expect,
    VERIFY_EXPECT_SCHEMA,
    "verify.artifact params.expect",
  );
}

export interface ParsedVerifyCompare {
  readonly compare: NonNullable<VerifyArtifactParams["compare"]>;
  /** Region re-validated against its closed schema with the unit-square rule. */
  readonly region: NonNullable<
    NonNullable<VerifyArtifactParams["compare"]>["region"]
  > | undefined;
}

/**
 * Nested compare closed-schema validation plus the region x+width ≤ 1 /
 * y+height ≤ 1 cross-field rule. Reference path containment is NOT part of
 * this function (it needs the session's configured roots); see
 * resolveVerifyReferencePath.
 */
export function parseVerifyCompare(
  compare: NonNullable<VerifyArtifactParams["compare"]>,
): ParsedVerifyCompare {
  const validCompare = validateObject<NonNullable<VerifyArtifactParams["compare"]>>(
    compare,
    VERIFY_COMPARE_SCHEMA,
    "verify.artifact params.compare",
  );
  let region: ParsedVerifyCompare["region"];
  if (validCompare.region !== undefined) {
    region = validateObject<NonNullable<typeof validCompare.region>>(
      validCompare.region,
      VERIFY_REGION_SCHEMA,
      "verify.artifact params.compare.region",
    );
    if (region.x + region.width > 1 || region.y + region.height > 1) {
      throw new FacadeError(
        "INVALID_PARAMS",
        "verify.artifact: compare.region must satisfy x+width ≤ 1 and y+height ≤ 1",
        { region },
      );
    }
  }
  return { compare: validCompare, region };
}

/**
 * Target path containment for verify.artifact: local paths only, inside
 * artifactRoot — except the delivered copy of a verified artifact, which
 * lives outside artifactRoot BY CONTRACT at its exact deliveredTo location
 * (`<deliveryRoot>/jobs/<slug>/output/`, the export.start destinationPath
 * rule). Both sessions ran this identical sequence before any probing.
 */
export async function resolveVerifyArtifactTarget(
  path: string,
  artifactRoot: string,
  deliveryRoots: readonly string[] | undefined,
): Promise<string> {
  if (hasUrlScheme(path)) {
    throw new FacadeError(
      "INVALID_PARAMS",
      "verify.artifact: URLs are not accepted — pass a local artifact path inside artifactRoot",
      { path },
    );
  }
  let target = resolveContainedPathDetailed(path, [artifactRoot]);
  if (target.kind === "outside") {
    const delivered = await resolveDeliveredArtifactPath(
      path,
      deliveryRoots ?? [],
    );
    if (delivered === null) {
      throw new FacadeError(
        "INVALID_PARAMS",
        "verify.artifact: path escapes the configured artifactRoot and every delivery root's job deliverables directory (<deliveryRoot>/jobs/<slug>/output/)",
        { path },
      );
    }
    target = { kind: "ok", path: delivered };
  }
  if (target.kind === "unresolvable") {
    throw new FacadeError(
      "INVALID_PARAMS",
      "verify.artifact: path cannot be read (not found or unreadable)",
      { path },
    );
  }
  const targetStat = await stat(target.path).catch(() => null);
  if (!targetStat || !targetStat.isFile()) {
    throw new FacadeError(
      "INVALID_PARAMS",
      "verify.artifact: path is not a regular file",
      { path },
    );
  }
  return target.path;
}

/**
 * Compare reference containment. The sessions legitimately differ here:
 * headless falls back to mediaRoots (pass the configured array — possibly
 * empty), while a live session has no mediaRoots and must reject with its
 * own message (pass `undefined`). This parameter IS the documented product
 * difference, not a duplicated rule.
 */
export function resolveVerifyReferencePath(
  referencePath: string,
  artifactRoot: string,
  mediaRoots: readonly string[] | undefined,
): string {
  if (mediaRoots === undefined) {
    // Live contract: artifactRoot only.
    if (hasUrlScheme(referencePath)) {
      throw new FacadeError(
        "INVALID_PARAMS",
        "verify.artifact: reference URLs are not accepted — pass a local path inside artifactRoot",
      );
    }
    const reference = resolveContainedPathDetailed(referencePath, [artifactRoot]);
    if (reference.kind !== "ok") {
      throw new FacadeError(
        "INVALID_PARAMS",
        "verify.artifact: referencePath escapes the configured artifactRoot (a live session has no mediaRoots to fall back to)",
        { referencePath },
      );
    }
    return reference.path;
  }
  // Headless contract: artifactRoot, then mediaRoots fallback.
  if (hasUrlScheme(referencePath)) {
    throw new FacadeError(
      "INVALID_PARAMS",
      "verify.artifact: reference URLs are not accepted — pass a local path inside mediaRoots or artifactRoot",
    );
  }
  let reference = resolveContainedPathDetailed(referencePath, [artifactRoot]);
  if (reference.kind !== "ok") {
    reference = resolveContainedPathDetailed(referencePath, mediaRoots);
  }
  if (reference.kind === "outside") {
    throw new FacadeError(
      "INVALID_PARAMS",
      "verify.artifact: referencePath escapes both artifactRoot and mediaRoots",
      { referencePath },
    );
  }
  if (reference.kind === "unresolvable") {
    throw new FacadeError(
      "INVALID_PARAMS",
      "verify.artifact: referencePath cannot be read (not found or unreadable)",
      { referencePath },
    );
  }
  return reference.path;
}

/**
 * The compare → PixelCompareRequest projection both sessions apply after
 * containment, kept next to the rules so the field mapping cannot drift
 * between the two entries.
 */
export function buildVerifyCompareRequest(
  parsed: ParsedVerifyCompare,
  referencePath: string,
): NonNullable<import("./providers").VerifyArtifactRequest["compare"]> {
  const { compare, region } = parsed;
  return {
    referencePath,
    timeSec: compare.timeSec,
    ...(compare.referenceTimeSec !== undefined
      ? { referenceTimeSec: compare.referenceTimeSec }
      : {}),
    ...(region !== undefined ? { region } : {}),
    mode: compare.mode,
    ...(compare.maxMeanAbsDiff !== undefined
      ? { maxMeanAbsDiff: compare.maxMeanAbsDiff }
      : {}),
    ...(compare.minMeanAbsDiff !== undefined
      ? { minMeanAbsDiff: compare.minMeanAbsDiff }
      : {}),
    ...(compare.minChangedPixelsRatio !== undefined
      ? { minChangedPixelsRatio: compare.minChangedPixelsRatio }
      : {}),
  };
}
