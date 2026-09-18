/**
 * Preset-to-action expansion: turns a custom preset payload into a batch of
 * existing, reversible core actions. This is the ONE shared expansion path
 * for the GUI panels and the agent session, so both inherit identical
 * validation and placement semantics.
 *
 * Two rules are load-bearing here:
 *
 * 1. Payloads are re-validated immediately before expansion. Presets may
 *    have been created by an older build, so this second gate (beyond the
 *    create-time validation in @openreel/core/presets/validate) keeps
 *    unknown or out-of-range parameters out of project JSON — the core
 *    `effect/add` and `transition/set` executors write parameters verbatim.
 *
 * 2. Transition placement (adjacency, shared visual track, per-cut duration
 *    cap, out-point edge) is checked HERE, because `transition/set` writes
 *    the transition object verbatim: no downstream layer clamps durations or
 *    verifies adjacency for this path. A duration beyond the placement cap is
 *    rejected with PLACEMENT_INVALID; UIs that prefer clamping can compute
 *    the cap first via `transitionPlacementMaxDuration`.
 *
 * The returned actions are meant for `executeActionBatch` (one undo unit).
 */
import { v4 as uuid } from "uuid";
import type { Action, Clip, Project, Track } from "@openreel/core";
import type { TextClip } from "@openreel/core/text/types";
import {
  EFFECT_DEFINITIONS,
  type EffectDefinition,
} from "@openreel/core/types/effects";
import type { Transition } from "@openreel/core/types/timeline";
import type {
  CustomPresetRecord,
  EffectPresetItem,
  GraphicsPresetPayload,
} from "@openreel/core/presets/types";
import {
  getTransitionDefaultParams,
  validatePresetPayload,
} from "@openreel/core/presets/validate";
import { validateSvgContent } from "@openreel/core/graphics/svg-validation";
import {
  DEFAULT_GRAPHIC_TRANSFORM,
  DEFAULT_SVG_COLOR_STYLE,
  type SVGClip,
  type ViewBox,
} from "@openreel/core/graphics/types";

export type PresetApplyErrorCode =
  | "PRESET_INVALID"
  | "PAYLOAD_VERSION_UNSUPPORTED"
  | "TARGET_MISMATCH"
  | "TARGET_REQUIRED"
  | "TARGET_NOT_FOUND"
  | "PLACEMENT_INVALID"
  | "PRESET_APPLY_UNSUPPORTED";

export interface PresetApplyError {
  readonly ok: false;
  readonly code: PresetApplyErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface PresetApplySuccess {
  readonly ok: true;
  readonly actions: readonly Action[];
  /** Group label for the enclosing executeActionBatch (one undo unit). */
  readonly groupLabel: string;
}

export type PresetApplyResult = PresetApplySuccess | PresetApplyError;

/** Target is tagged by kind so the payload/target pairing is explicit. */
export type PresetApplyTarget =
  | { readonly kind: "text"; readonly mode: "updateStyle"; readonly clipId: string }
  | { readonly kind: "effect"; readonly clipIds: readonly string[] }
  | { readonly kind: "transition"; readonly clipAId: string; readonly clipBId?: string }
  | {
      readonly kind: "graphics";
      /** Graphics track to place the SVG clip on; omitted picks/auto-creates one. */
      readonly trackId?: string;
      /** Timeline seconds; defaults to 0. */
      readonly startTime?: number;
      /** Clip duration in seconds; defaults to DEFAULT_GRAPHICS_PRESET_DURATION_SEC. */
      readonly durationSec?: number;
    };

export interface PresetApplyInput {
  readonly preset: Pick<CustomPresetRecord, "name" | "payload">;
  readonly target: PresetApplyTarget;
  readonly project: Project;
}

function fail(
  code: PresetApplyErrorCode,
  message: string,
  details?: Record<string, unknown>,
): PresetApplyError {
  return details ? { ok: false, code, message, details } : { ok: false, code, message };
}

let actionCounter = 0;

function makeAction(type: string, params: Record<string, unknown>): Action {
  actionCounter += 1;
  return {
    type,
    id: `preset-${Date.now().toString(36)}-${actionCounter}-${uuid()}`,
    timestamp: Date.now(),
    params,
  };
}

/** Deep-copies validated payloads so no record object aliases into the batch. */
function clonePayload<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/* ------------------------------ lookup ------------------------------ */

export interface TimelineClipLocation {
  readonly clip: Clip;
  readonly track: Track;
}

export function findTimelineClip(
  project: Project,
  clipId: string,
): TimelineClipLocation | undefined {
  for (const track of project.timeline.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { clip, track };
  }
  return undefined;
}

function findTextClip(project: Project, clipId: string): TextClip | undefined {
  return (project.textClips ?? []).find((clip) => clip.id === clipId);
}

/* ------------------------ transition placement ------------------------ */

/** Two clips are adjacent when their shared boundary aligns within this epsilon. */
export const TRANSITION_CUT_EPSILON = 0.001;

/**
 * Placement duration cap for a cut: twice the shorter clip for a cut between
 * two clips, the single clip's duration for an out-point edge transition.
 */
export function transitionPlacementMaxDuration(clipA: Clip, clipB?: Clip): number {
  return clipB ? Math.min(clipA.duration, clipB.duration) * 2 : clipA.duration;
}

interface TransitionPlacement {
  readonly clipA: Clip;
  readonly clipB?: Clip;
  readonly track: Track;
}

function resolveTransitionPlacement(
  project: Project,
  clipAId: string,
  clipBId: string | undefined,
): { placement: TransitionPlacement } | { error: PresetApplyError } {
  const locationA = findTimelineClip(project, clipAId);
  if (!locationA) {
    return {
      error: fail("TARGET_NOT_FOUND", `clip "${clipAId}" was not found on the timeline`, {
        clipId: clipAId,
      }),
    };
  }
  const clipA = locationA.clip;
  const track = locationA.track;

  if (clipBId === undefined) {
    return { placement: { clipA, track } };
  }

  const locationB = findTimelineClip(project, clipBId);
  if (!locationB) {
    return {
      error: fail("TARGET_NOT_FOUND", `clip "${clipBId}" was not found on the timeline`, {
        clipId: clipBId,
      }),
    };
  }
  const clipB = locationB.clip;
  if (locationB.track.id !== track.id) {
    return {
      error: fail("PLACEMENT_INVALID", "transition clips must be on the same track", {
        clipAId,
        clipBId,
        trackAId: track.id,
        trackBId: locationB.track.id,
      }),
    };
  }
  const cutTime = clipA.startTime + clipA.duration;
  if (Math.abs(cutTime - clipB.startTime) >= TRANSITION_CUT_EPSILON) {
    return {
      error: fail(
        "PLACEMENT_INVALID",
        "transition requires adjacent clips: clipA must end where clipB starts",
        { clipAId, clipBId, clipAEnd: cutTime, clipBStart: clipB.startTime },
      ),
    };
  }
  return { placement: { clipA, clipB, track } };
}

function assertVisualTrack(track: Track): PresetApplyError | undefined {
  if (track.type === "audio" || track.type === "text") {
    return fail("PLACEMENT_INVALID", "visual transitions require a visual track", {
      trackId: track.id,
      trackType: track.type,
    });
  }
  return undefined;
}

function buildTransitionAction(
  payloadType: string,
  durationSec: number | undefined,
  payloadParams: Record<string, unknown>,
  placement: TransitionPlacement,
  groupLabel: string,
): PresetApplyResult {
  const placementError = assertVisualTrack(placement.track);
  if (placementError) return placementError;

  const clipA = placement.clipA;
  const clipB = placement.clipB;
  // Placement cap: this path writes `transition/set` verbatim, so the cap is
  // enforced here or not at all. Callers that prefer clamping can pre-clamp
  // with transitionPlacementMaxDuration before choosing the duration.
  const duration = durationSec ?? 1;
  const maxDuration = transitionPlacementMaxDuration(clipA, clipB);
  if (!(duration > 0) || duration > maxDuration) {
    return fail(
      "PLACEMENT_INVALID",
      `transition duration cannot exceed ${maxDuration} seconds for this placement`,
      { duration, maxDuration, clipAId: clipA.id, clipBId: clipB?.id },
    );
  }

  const params = { ...getTransitionDefaultParams(payloadType as never), ...payloadParams };
  const transition: Transition = {
    id: `transition-${uuid()}`,
    clipAId: clipA.id,
    ...(clipB ? { clipBId: clipB.id } : {}),
    ...(!clipB ? { edge: "out" as const } : {}),
    type: payloadType as Transition["type"],
    duration,
    params,
  };
  return {
    ok: true,
    actions: [makeAction("transition/set", { transition })],
    groupLabel,
  };
}

/* ------------------------------- effects ------------------------------ */

function effectDefinitionFor(type: string): EffectDefinition | undefined {
  return EFFECT_DEFINITIONS.find((definition) => definition.type === type);
}

function buildEffectActions(
  effects: readonly EffectPresetItem[],
  clipIds: readonly string[],
  project: Project,
  groupLabel: string,
): PresetApplyResult {
  if (clipIds.length === 0) {
    return fail("TARGET_REQUIRED", "effect preset application requires at least one clip id");
  }
  for (const clipId of clipIds) {
    if (!findTimelineClip(project, clipId)) {
      return fail("TARGET_NOT_FOUND", `clip "${clipId}" was not found on the timeline`, {
        clipId,
      });
    }
  }
  const actions: Action[] = [];
  // Defaults are backfilled from the effect definitions so each action
  // carries a complete parameter object instead of relying on the engine
  // tolerating sparse parameters.
  for (const item of effects) {
    const definition = effectDefinitionFor(item.type);
    if (!definition) {
      return fail("PRESET_INVALID", `engine does not provide this effect: "${item.type}"`, {
        effectType: item.type,
      });
    }
    const params: Record<string, unknown> = {};
    for (const param of definition.params) {
      if (typeof param.default === "number") params[param.key] = param.default;
    }
    Object.assign(params, item.params);
    for (const clipId of clipIds) {
      actions.push(
        makeAction("effect/add", {
          clipId,
          effectType: item.type,
          params,
          effectId: `effect-${uuid()}`,
          enabled: true,
        }),
      );
    }
  }
  return { ok: true, actions, groupLabel };
}

/* ------------------------------- graphics ------------------------------ */

/**
 * Default duration for SVG clips created from graphics presets. The payload
 * carries the SVG source only, so duration is a target concern; GUI and
 * agent callers may override via the target's `durationSec`. UIs surface
 * this constant so the applied duration is never a surprise.
 */
export const DEFAULT_GRAPHICS_PRESET_DURATION_SEC = 5;

/**
 * String-level viewBox extraction for graphics preset application. Mirrors
 * the facade svg.create translator (ops.ts extractSvgViewBox), which itself
 * mirrors core parseSVG's fallback ladder: viewBox attribute first, else
 * width/height, else 100x100 — so a preset-applied SVG clips identically to
 * a GUI import of the same markup.
 */
function extractSvgViewBox(content: string): ViewBox {
  const fallback: ViewBox = { minX: 0, minY: 0, width: 100, height: 100 };
  const rootMatch = /<(?:[a-zA-Z][\w.-]*:)?svg(?=[\s/>])[^>]*>/.exec(content);
  if (!rootMatch) return fallback;
  const tag = rootMatch[0];
  const attr = (name: string): string | null => {
    const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
    return match ? (match[2] ?? match[3] ?? "") : null;
  };
  const viewBoxAttr = attr("viewBox");
  if (viewBoxAttr !== null) {
    const parts = viewBoxAttr.split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      return {
        minX: parts[0] as number,
        minY: parts[1] as number,
        width: parts[2] as number,
        height: parts[3] as number,
      };
    }
    return fallback;
  }
  const width = parseFloat(attr("width") ?? "");
  const height = parseFloat(attr("height") ?? "");
  if (Number.isFinite(width) && Number.isFinite(height)) {
    return { minX: 0, minY: 0, width, height };
  }
  return fallback;
}

function buildGraphicsActions(
  payload: GraphicsPresetPayload,
  target: Extract<PresetApplyTarget, { kind: "graphics" }>,
  project: Project,
  groupLabel: string,
): PresetApplyResult {
  // Same-source SVG gate as create time (validateGraphicsPresetSvg runs
  // validateSvgContent inside validatePresetPayload, which already ran
  // above). Re-checking here keeps the expansion safe even if the payload
  // dispatch ever loosens — the svg/create executor ingests verbatim.
  const svg = validateSvgContent(payload.svg);
  if (!svg.ok) {
    return fail("PRESET_INVALID", svg.message, { validationCode: svg.code });
  }

  const startTime = target.startTime ?? 0;
  if (!Number.isFinite(startTime) || startTime < 0) {
    return fail("PLACEMENT_INVALID", "graphics preset startTime must be a finite number >= 0", {
      startTime: target.startTime,
    });
  }
  const duration = target.durationSec ?? DEFAULT_GRAPHICS_PRESET_DURATION_SEC;
  if (!Number.isFinite(duration) || duration <= 0) {
    return fail("PLACEMENT_INVALID", "graphics preset durationSec must be a finite number > 0", {
      durationSec: target.durationSec,
    });
  }

  // Track resolution mirrors the facade svg.create translator: explicit
  // trackId must exist and be a graphics track, otherwise the first
  // graphics track is used, otherwise one is created in the same batch —
  // one atomic undo unit either way.
  let trackId = target.trackId;
  let autoCreatedTrackId: string | undefined;
  if (trackId !== undefined) {
    const track = project.timeline.tracks.find((candidate) => candidate.id === trackId);
    if (!track) {
      return fail("TARGET_NOT_FOUND", `track "${trackId}" was not found on the timeline`, {
        trackId,
      });
    }
    if (track.type !== "graphics") {
      return fail(
        "PLACEMENT_INVALID",
        `track "${trackId}" is a ${track.type} track, expected a graphics track`,
        { trackId, trackType: track.type },
      );
    }
  } else {
    const graphicsTrack = project.timeline.tracks.find(
      (candidate) => candidate.type === "graphics",
    );
    if (graphicsTrack) {
      trackId = graphicsTrack.id;
    } else {
      autoCreatedTrackId = `track-${uuid()}`;
      trackId = autoCreatedTrackId;
    }
  }

  // Same clip shape the facade svg.create op and the GUI SVG import build
  // (defaults for preserveAspectRatio/colorStyle/animations), so a
  // preset-applied SVG is indistinguishable from an imported one.
  const clip: SVGClip = {
    id: `svg-${uuid()}`,
    trackId,
    startTime,
    duration,
    type: "svg",
    svgContent: payload.svg,
    viewBox: extractSvgViewBox(payload.svg),
    preserveAspectRatio: "xMidYMid",
    transform: { ...DEFAULT_GRAPHIC_TRANSFORM },
    keyframes: [],
    colorStyle: { ...DEFAULT_SVG_COLOR_STYLE },
    entryAnimation: { type: "none", duration: 0.5, easing: "ease-out" },
    exitAnimation: { type: "none", duration: 0.5, easing: "ease-in" },
  };
  return {
    ok: true,
    actions: [
      ...(autoCreatedTrackId !== undefined
        ? [makeAction("track/add", { trackType: "graphics", trackId: autoCreatedTrackId })]
        : []),
      makeAction("svg/create", { clip }),
    ],
    groupLabel,
  };
}

/* ------------------------------- dispatch ------------------------------ */

/**
 * Expands one preset into core actions for the given target and project
 * snapshot. Pure: reads the project, never mutates it.
 */
export function expandPresetActions(input: PresetApplyInput): PresetApplyResult {
  const revalidated = validatePresetPayload(input.preset.payload);
  if (!revalidated.ok) {
    return fail(
      revalidated.code === "PAYLOAD_VERSION_UNSUPPORTED"
        ? "PAYLOAD_VERSION_UNSUPPORTED"
        : "PRESET_INVALID",
      revalidated.message,
      { validationCode: revalidated.code, details: revalidated.details },
    );
  }
  const payload = clonePayload(revalidated.value);
  const groupLabel = `preset.apply ${input.preset.name}`;
  const target = input.target;

  // Dispatch on the target's kind tag: each case re-checks the payload kind
  // so both union members are narrowed in the branch body.
  switch (target.kind) {
    case "text": {
      if (payload.kind !== "text") {
        return kindMismatch(payload.kind, target.kind);
      }
      if (target.mode !== "updateStyle") {
        return fail(
          "PRESET_APPLY_UNSUPPORTED",
          "creating a text clip from a preset is handled by the text panel flow",
        );
      }
      const clip = findTextClip(input.project, target.clipId);
      if (!clip) {
        return fail("TARGET_NOT_FOUND", `text clip "${target.clipId}" was not found`, {
          clipId: target.clipId,
        });
      }
      // Shallow-merge onto the live style: the payload is a partial
      // whitelist subset, while TextStyle carries required fields the
      // text/update handler would otherwise replace wholesale. An existing
      // shader on the clip stays untouched — presets never carry shader data.
      const mergedStyle = { ...clip.style, ...payload.style };
      return {
        ok: true,
        actions: [
          makeAction("text/update", { clipId: clip.id, updates: { style: mergedStyle } }),
        ],
        groupLabel,
      };
    }
    case "effect": {
      if (payload.kind !== "effect") {
        return kindMismatch(payload.kind, target.kind);
      }
      return buildEffectActions(payload.effects, target.clipIds, input.project, groupLabel);
    }
    case "transition": {
      if (payload.kind !== "transition") {
        return kindMismatch(payload.kind, target.kind);
      }
      const resolved = resolveTransitionPlacement(
        input.project,
        target.clipAId,
        target.clipBId,
      );
      if ("error" in resolved) return resolved.error;
      return buildTransitionAction(
        payload.type,
        payload.durationSec,
        payload.params,
        resolved.placement,
        groupLabel,
      );
    }
    case "graphics": {
      if (payload.kind !== "graphics") {
        return kindMismatch(payload.kind, target.kind);
      }
      return buildGraphicsActions(payload, target, input.project, groupLabel);
    }
    default:
      return fail(
        "PRESET_APPLY_UNSUPPORTED",
        `preset application for this target kind is not available`,
      );
  }
}

function kindMismatch(payloadKind: string, targetKind: string): PresetApplyError {
  return fail(
    "TARGET_MISMATCH",
    `preset payload kind "${payloadKind}" does not match target kind "${targetKind}"`,
    { payloadKind, targetKind },
  );
}
