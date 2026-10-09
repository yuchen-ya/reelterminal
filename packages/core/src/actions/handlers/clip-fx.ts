import type { Action, ValidationResult } from "../../types/actions";
import type { Project } from "../../types/project";
import { EASING_TYPES, type ChromaKeySettings, type Effect, type Clip } from "../../types/timeline";
import { SpeedEngine, SPEED_MIN, SPEED_MAX } from "../../video/speed-engine";
import { registerActionHandler } from "../registry";
import type { ActionHandler } from "../registry";
import { makeClipFieldHandler, findClip, patchClip } from "./clip-helpers";
import { DEFAULT_CHROMA_KEY_SETTINGS } from "../../video/chroma-key-engine";
import {
  DEFAULT_BACKGROUND_SETTINGS,
  type BackgroundRemovalSettings,
} from "../../ai/background-removal-engine";

const isNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

// The per-frame keyer lives in the clip.effects stack (video-effects-engine
// consumes the chromaKey effect item in both preview and export), while the
// clip.chromaKey field feeds the GUI green-screen panel (engine Map resync)
// and the timeline.query projection. This handler is the only writer of the
// settings field and the only path that updates BOTH representations
// together (a chromaKey item added from the Effects panel alone is absorbed
// in place, never duplicated).
const CHROMA_KEY_EFFECT_TYPE = "chromaKey";

// Exported for the project serializer's legacy-project backfill, which must
// map a stored clip.chromaKey field to the exact same effect-item shape the
// handler writes (see normalizeProjectChromaFields).
export const fullChromaKeySettings = (
  raw: unknown,
): ChromaKeySettings => {
  const partial = (raw ?? {}) as Partial<ChromaKeySettings>;
  return {
    enabled: partial.enabled ?? false,
    keyColor: partial.keyColor ?? DEFAULT_CHROMA_KEY_SETTINGS.keyColor,
    tolerance: partial.tolerance ?? DEFAULT_CHROMA_KEY_SETTINGS.tolerance,
    edgeSoftness:
      partial.edgeSoftness ?? DEFAULT_CHROMA_KEY_SETTINGS.edgeSoftness,
    spillSuppression:
      partial.spillSuppression ??
      DEFAULT_CHROMA_KEY_SETTINGS.spillSuppression,
  };
};

/**
 * Normalize a partial backgroundRemoval payload into the complete settings
 * snapshot persisted on the clip (same defaults the BackgroundRemovalEngine
 * and the GUI panel share). The facade's clip.setBackgroundRemoval op
 * translation assembles its own full snapshot (op field over the clip's
 * prior value over these shared defaults) and does not call this, so a
 * partial payload still lands as a complete field snapshot.
 */
export const fullBackgroundRemovalSettings = (
  raw: unknown,
): BackgroundRemovalSettings => {
  const partial = (raw ?? {}) as Partial<BackgroundRemovalSettings>;
  return {
    enabled: partial.enabled ?? false,
    mode: partial.mode ?? DEFAULT_BACKGROUND_SETTINGS.mode,
    blurAmount: partial.blurAmount ?? DEFAULT_BACKGROUND_SETTINGS.blurAmount,
    backgroundColor:
      partial.backgroundColor ?? DEFAULT_BACKGROUND_SETTINGS.backgroundColor,
    ...(partial.backgroundImageUrl !== undefined
      ? { backgroundImageUrl: partial.backgroundImageUrl }
      : {}),
    ...(partial.backgroundVideoUrl !== undefined
      ? { backgroundVideoUrl: partial.backgroundVideoUrl }
      : {}),
    edgeBlur: partial.edgeBlur ?? DEFAULT_BACKGROUND_SETTINGS.edgeBlur,
    threshold: partial.threshold ?? DEFAULT_BACKGROUND_SETTINGS.threshold,
  };
};

const chromaKeyEffectParams = (settings: ChromaKeySettings): Record<string, unknown> => ({
  keyColor: { ...settings.keyColor },
  tolerance: settings.tolerance,
  edgeSoftness: settings.edgeSoftness,
  spillSuppression: settings.spillSuppression,
});

/**
 * Sync the render-side representation: upsert ONE chromaKey effect item into
 * the clip's effect stack (update-in-place when any chromaKey item already
 * exists — including one added from the Effects panel — never stack a
 * duplicate). Disabling keeps the item with its params at enabled=false,
 * matching the Effects panel's toggle semantics; a null/undefined settings
 * payload clears the keyer by removing its item(s).
 */
export const syncChromaKeyEffectItem = (
  effects: readonly Effect[],
  settings: ChromaKeySettings | null,
  newEffectId = `effect-chromakey-${Date.now()}`,
): Effect[] => {
  const index = effects.findIndex((e) => e.type === CHROMA_KEY_EFFECT_TYPE);
  if (!settings) {
    return index === -1
      ? [...effects]
      : effects.filter((e) => e.type !== CHROMA_KEY_EFFECT_TYPE);
  }
  if (index >= 0) {
    const existing = effects[index]!;
    const next = [...effects];
    next[index] = {
      ...existing,
      enabled: settings.enabled,
      params: chromaKeyEffectParams(settings),
    };
    return next;
  }
  return [
    ...effects,
    {
      id: newEffectId,
      type: CHROMA_KEY_EFFECT_TYPE,
      enabled: settings.enabled,
      params: chromaKeyEffectParams(settings),
    },
  ];
};

// Green-screen keying, persisted as one undoable unit: the clip.chromaKey
// settings field AND the chromaKey effect item in clip.effects that the frame
// pipeline actually renders (preview via the effects bridge, export via
// video-engine). The inverse carries the exact prior field + stack, so undo
// restores a user-tuned Effects-panel item bit-for-bit (effect/setStack
// pattern).
const clipSetChromaKey: ActionHandler = {
  type: "clip/setChromaKey",
  synchronous: true,
  validate(action: Action, project: Project): ValidationResult {
    const params = action.params as {
      clipId?: unknown;
      chromaKey?: unknown;
      effects?: unknown;
    };
    const errors = [];
    if (
      typeof params.clipId !== "string" ||
      !findClip(project, params.clipId)
    ) {
      errors.push({
        code: "CLIP_NOT_FOUND",
        message: `Clip not found: ${String(params.clipId)}`,
      });
    }
    if (params.chromaKey != null && typeof params.chromaKey !== "object") {
      errors.push({
        code: "INVALID_PARAMS",
        message: "chromaKey must be an object",
      });
    }
    if (params.effects !== undefined && !Array.isArray(params.effects)) {
      errors.push({
        code: "INVALID_PARAMS",
        message: "effects must be an array",
      });
    }
    return { valid: errors.length === 0, errors };
  },
  apply(action: Action, project: Project): void {
    const params = action.params as {
      clipId: string;
      chromaKey?: ChromaKeySettings | null;
      effects?: Effect[];
    };
    const clip = findClip(project, params.clipId);
    if (!clip) return;

    if (Array.isArray(params.effects)) {
      // Inverse restore: put back the exact prior field + effect stack.
      patchClip(project, params.clipId, {
        chromaKey: params.chromaKey ?? undefined,
        effects: structuredClone(params.effects),
      });
      return;
    }

    const settings =
      params.chromaKey == null ? null : fullChromaKeySettings(params.chromaKey);
    patchClip(project, params.clipId, {
      chromaKey: settings ?? undefined,
      // Defensive default: legacy/persisted clips may omit the effects array.
      effects: syncChromaKeyEffectItem(
        clip.effects ?? [],
        settings,
        `effect-chromakey-${action.id}`,
      ),
    });
  },
  invert(action: Action, projectBefore: Project): Action | null {
    const params = action.params as { clipId: string };
    const prior = findClip(projectBefore, params.clipId);
    if (!prior) return null;
    return {
      type: "clip/setChromaKey",
      id: `inverse-${action.id}`,
      timestamp: Date.now(),
      params: {
        clipId: params.clipId,
        chromaKey: prior.chromaKey,
        effects: structuredClone(prior.effects),
      },
    };
  },
};

// All speed writers use the canonical clip and the renderer's duration kernel.
// Supplied fields change; explicit undefined restores an absent field on undo.
const speedFields = {
  speed: "speed",
  reversed: "reversed",
  keyframes: "speedKeyframes",
  freezeFrames: "freezeFrames",
  pitchCorrection: "pitchCorrection",
} as const;

function speedPatch(
  params: Record<string, unknown>,
  fields: readonly (keyof typeof speedFields)[],
): Partial<Clip> {
  const patch: Record<string, unknown> = {};
  for (const param of fields) {
    if (Object.hasOwn(params, param)) {
      patch[speedFields[param]] = param === "speed" && params[param] !== undefined
        ? Math.max(SPEED_MIN, Math.min(SPEED_MAX, params[param] as number))
        : structuredClone(params[param]);
    }
  }
  return patch;
}

/** Shared semantic validation for actions and stored canonical speed data. */
export function validateClipSpeedConfiguration(clip: Clip): string | null {
  const span = clip.outPoint - clip.inPoint;
  if (clip.speed !== undefined && !isNumber(clip.speed)) return "speed must be finite";
  for (const field of ["reversed", "pitchCorrection"] as const) {
    if (clip[field] !== undefined && typeof clip[field] !== "boolean") return `${field} must be a boolean`;
  }
  const keyframes = clip.speedKeyframes ?? [];
  if (!Array.isArray(keyframes)) return "keyframes must be an array";
  const ids = new Set<string>();
  const times = new Set<number>();
  for (const kf of keyframes) {
    if (!kf || typeof kf.id !== "string" || !kf.id || ids.has(kf.id)) return "keyframes need unique non-empty ids";
    if (!isNumber(kf.time) || kf.time < 0 || kf.time > span || times.has(kf.time)) return "keyframe times must be unique source offsets within outPoint - inPoint";
    if (!isNumber(kf.speed) || kf.speed < SPEED_MIN || kf.speed > SPEED_MAX) return "keyframe speeds must be in [0.1, 20]";
    if (!EASING_TYPES.includes(kf.easing)) return "unsupported speed keyframe easing";
    ids.add(kf.id);
    times.add(kf.time);
  }
  const freezes = clip.freezeFrames ?? [];
  if (!Array.isArray(freezes)) return "freezeFrames must be an array";
  ids.clear();
  for (const ff of freezes) {
    if (!ff || typeof ff.id !== "string" || !ff.id || ids.has(ff.id)) return "freezeFrames need unique non-empty ids";
    if (ff.clipId !== clip.id) return "freezeFrame clipId must match the clip";
    if (!isNumber(ff.sourceTime) || ff.sourceTime < 0 || ff.sourceTime > span) return "freezeFrame sourceTime must be a source offset within outPoint - inPoint";
    if (!isNumber(ff.startTime) || ff.startTime < 0 || !isNumber(ff.duration) || ff.duration <= 0) return "freezeFrame startTime must be non-negative and duration positive";
    ids.add(ff.id);
  }
  const engine = new SpeedEngine();
  engine.loadClips([{ ...clip, freezeFrames: [] }]);
  const movingDuration = engine.getEffectiveDuration(clip.id);
  let priorEnd = 0;
  let insertedDuration = 0;
  for (const ff of [...freezes].sort((a, b) => a.startTime - b.startTime)) {
    if (ff.startTime < priorEnd) return "freezeFrames must not overlap";
    if (ff.startTime - insertedDuration > movingDuration + 1e-6) return "freezeFrame startTime exceeds moving playback duration plus preceding freezes";
    insertedDuration += ff.duration;
    priorEnd = ff.startTime + ff.duration;
    if (!Number.isFinite(insertedDuration) || !Number.isFinite(priorEnd)) {
      return "freezeFrame playback times must remain finite";
    }
  }
  if (!Number.isFinite(clip.startTime + movingDuration + insertedDuration)) {
    return "effective clip end time must remain finite";
  }
  return null;
}

function makeSpeedHandler(type: string, fields: readonly (keyof typeof speedFields)[]): ActionHandler {
  return {
    type,
    synchronous: true,
    validate(action, project) {
      const params = action.params as Record<string, unknown>;
      const clip = typeof params.clipId === "string" ? findClip(project, params.clipId) : undefined;
      if (!clip) return { valid: false, errors: [{ code: "CLIP_NOT_FOUND", message: `Clip not found: ${String(params.clipId)}` }] };
      if (params.speed !== undefined && !isNumber(params.speed)) return { valid: false, errors: [{ code: "INVALID_PARAMS", message: "speed must be finite" }] };
      if (params.keyframes === null || params.freezeFrames === null) return { valid: false, errors: [{ code: "INVALID_PARAMS", message: "keyframes and freezeFrames must be arrays" }] };
      const message = validateClipSpeedConfiguration({ ...clip, ...speedPatch(params, fields) });
      return { valid: !message, errors: message ? [{ code: "INVALID_PARAMS", message }] : [] };
    },
    apply(action, project) {
      const params = action.params as Record<string, unknown>;
      const clip = findClip(project, params.clipId as string)!;
      const patch = speedPatch(params, fields);
      const engine = new SpeedEngine();
      engine.loadClips([{ ...clip, ...patch }]);
      patchClip(project, clip.id, { ...patch, duration: engine.getEffectiveDuration(clip.id) });
    },
    invert(action, projectBefore) {
      const params = action.params as Record<string, unknown>;
      const prior = findClip(projectBefore, params.clipId as string)!;
      const restore: Record<string, unknown> = { clipId: prior.id };
      for (const field of fields) {
        if (Object.hasOwn(params, field)) restore[field] = structuredClone(prior[speedFields[field]]);
      }
      return { type, id: `inverse-${action.id}`, timestamp: Date.now(), params: restore };
    },
  };
}

const handlers = [
  makeSpeedHandler("clip/setSpeed", ["speed"]),
  makeSpeedHandler("speed/setRampData", Object.keys(speedFields) as (keyof typeof speedFields)[]),
  makeSpeedHandler("clip/setReverse", ["reversed"]),
  makeSpeedHandler("clip/setPitchCorrection", ["pitchCorrection"]),
  makeClipFieldHandler({
    type: "clip/setStabilization",
    paramKey: "stabilization",
    field: "stabilization",
    validateValue: (v) =>
      v == null || typeof v === "object"
        ? null
        : "stabilization must be an object",
  }),
  clipSetChromaKey,
  // Person-segmentation matte settings persisted as the clip.backgroundRemoval
  // field (makeClipFieldHandler gives validate/apply/invert). Render reads the
  // field first and seeds the engine's in-memory session Map from it; a null
  // payload clears the field via the transform below. Undo/redo and project
  // save/load come free with the field handler.
  makeClipFieldHandler({
    type: "clip/setBackgroundRemoval",
    paramKey: "backgroundRemoval",
    field: "backgroundRemoval",
    transform: (value) =>
      value == null ? undefined : fullBackgroundRemovalSettings(value),
    validateValue: (v) =>
      v == null || typeof v === "object"
        ? null
        : "backgroundRemoval must be an object",
  }),
  makeSpeedHandler("speed/setKeyframes", ["keyframes"]),
  makeSpeedHandler("speed/setFreezeFrames", ["freezeFrames"]),
];

for (const handler of handlers) {
  registerActionHandler(handler);
}
