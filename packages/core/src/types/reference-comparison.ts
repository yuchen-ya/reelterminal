/**
 * Reference comparison — canonical project state shared by the GUI and the
 * Agent (P1). Exactly ONE configuration lives on the project; both surfaces
 * read and write it through the same actions, so undo/redo, persistence and
 * revision CAS treat it like every other piece of edit state.
 *
 * The mapping from timeline time to reference time is EXPLICIT and narrow by
 * design for v1: constant rate 1.0 with a start offset
 *
 *   referenceSec(timelineSec) = refStartSec + (timelineSec - timelineStartSec)
 *
 * Anything else (retiming, looping, reverse) is rejected at validation time
 * with a clear error instead of being silently approximated.
 */

export type ReferenceComparisonAudioSide = "timeline" | "reference" | "none";
export type ReferenceComparisonLayout = "side-by-side" | "overlay";

export interface ReferenceComparisonConfig {
  /** Project media item used as the reference (must exist in mediaLibrary). */
  readonly referenceMediaId: string;
  /** Reference in-point that aligns with timelineStartSec. */
  readonly refStartSec: number;
  /** Reference out-point; comparison beyond it clamps onto the last frame (disclosed, never extrapolated). */
  readonly refEndSec: number;
  /** Timeline time that aligns with refStartSec. */
  readonly timelineStartSec: number;
  /** v1: exactly 1 — kept explicit so future rates are a schema change, not a silent guess. */
  readonly rate: 1;
  /** Which audio the comparison plays/exports. Exactly one side (or none); never both. */
  readonly audioSide: ReferenceComparisonAudioSide;
  /** side-by-side (left reference / right timeline) or transparent overlay. */
  readonly layout: ReferenceComparisonLayout;
  /** overlay mode only: reference opacity over the timeline frame, (0,1]. */
  readonly overlayOpacity?: number;
}

/** Pure validation of one candidate config against the owning project facts. */
export function validateReferenceComparisonConfig(
  config: ReferenceComparisonConfig,
  context: {
    readonly referenceMediaExists: boolean;
    readonly referenceDurationSec: number;
    readonly timelineDurationSec: number;
  },
): { ok: true } | { ok: false; reason: string } {
  if (!config.referenceMediaId || typeof config.referenceMediaId !== "string") {
    return { ok: false, reason: "referenceMediaId must be a non-empty string" };
  }
  if (!context.referenceMediaExists) {
    return {
      ok: false,
      reason: `reference media "${config.referenceMediaId}" is not in the project media library`,
    };
  }
  if (!(config.rate === 1)) {
    return {
      ok: false,
      reason: `rate ${config.rate} is not supported — the reference mapping is constant rate 1.0 with a start offset; export the reference re-timed first if you need another rate`,
    };
  }
  const finite = [config.refStartSec, config.refEndSec, config.timelineStartSec];
  if (finite.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
    return { ok: false, reason: "refStartSec, refEndSec and timelineStartSec must be finite non-negative numbers" };
  }
  if (!(config.refEndSec > config.refStartSec)) {
    return { ok: false, reason: "refEndSec must be greater than refStartSec" };
  }
  if (context.referenceDurationSec > 0 && config.refEndSec > context.referenceDurationSec + 1e-6) {
    return {
      ok: false,
      reason: `refEndSec ${config.refEndSec} exceeds the reference duration ${context.referenceDurationSec}`,
    };
  }
  if (config.timelineStartSec > context.timelineDurationSec + 1e-6) {
    return {
      ok: false,
      reason: `timelineStartSec ${config.timelineStartSec} is beyond the timeline duration ${context.timelineDurationSec}`,
    };
  }
  if (config.audioSide !== "timeline" && config.audioSide !== "reference" && config.audioSide !== "none") {
    return { ok: false, reason: `audioSide must be "timeline", "reference" or "none"` };
  }
  if (config.layout !== "side-by-side" && config.layout !== "overlay") {
    return { ok: false, reason: `layout must be "side-by-side" or "overlay"` };
  }
  if (config.overlayOpacity !== undefined) {
    if (typeof config.overlayOpacity !== "number" || !(config.overlayOpacity > 0) || config.overlayOpacity > 1) {
      return { ok: false, reason: "overlayOpacity must be a number in (0, 1]" };
    }
  }
  return { ok: true };
}

export interface ReferenceMappingResult {
  /** Reference time the timeline time maps to. */
  readonly referenceSec: number;
  /** True when the timeline time is outside [refStartSec, refEndSec] and the value was clamped. */
  readonly clamped: "none" | "before" | "after";
}

/**
 * The one mapping the whole product agrees on (GUI panel, comparison preview,
 * comparison export, tests). Out-of-range times CLAMP onto the reference's
 * first/last available frame and say so — they never extrapolate motion.
 */
export function mapTimelineToReference(
  config: ReferenceComparisonConfig,
  timelineSec: number,
): ReferenceMappingResult {
  const raw = config.refStartSec + (timelineSec - config.timelineStartSec) * config.rate;
  if (raw < config.refStartSec) {
    return { referenceSec: config.refStartSec, clamped: "before" };
  }
  if (raw > config.refEndSec) {
    return { referenceSec: config.refEndSec, clamped: "after" };
  }
  return { referenceSec: raw, clamped: "none" };
}
