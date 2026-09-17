import type { Action, ValidationResult } from "../../types/actions";
import type { Project } from "../../types/project";
import type { ChromaKeySettings, Effect } from "../../types/timeline";
import { registerActionHandler } from "../registry";
import type { ActionHandler } from "../registry";
import { makeClipFieldHandler, findClip, patchClip } from "./clip-helpers";
import { DEFAULT_CHROMA_KEY_SETTINGS } from "../../video/chroma-key-engine";
import {
  DEFAULT_BACKGROUND_SETTINGS,
  type BackgroundRemovalSettings,
} from "../../ai/background-removal-engine";

const SPEED_MIN = 0.1;
const SPEED_MAX = 20;

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
      id: `effect-chromakey-${Date.now()}`,
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
      effects: syncChromaKeyEffectItem(clip.effects ?? [], settings),
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

// Speed changes also recompute the clip's timeline duration from its source
// span (outPoint - inPoint) / speed. Duration is derived, so the inverse just
// restores the prior speed.
const clipSetSpeed: ActionHandler = {
  type: "clip/setSpeed",
  synchronous: true,
  validate(action: Action, project: Project): ValidationResult {
    const params = action.params as { clipId?: string; speed?: unknown };
    const errors = [];
    if (typeof params.clipId !== "string" || !findClip(project, params.clipId)) {
      errors.push({
        code: "CLIP_NOT_FOUND",
        message: `Clip not found: ${String(params.clipId)}`,
      });
    }
    if (params.speed != null && !isNumber(params.speed)) {
      errors.push({ code: "INVALID_PARAMS", message: "speed must be a number" });
    }
    return { valid: errors.length === 0, errors };
  },
  apply(action: Action, project: Project): void {
    const params = action.params as { clipId: string; speed: number };
    const clip = findClip(project, params.clipId);
    if (!clip) return;
    const speed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, Number(params.speed)));
    const sourceSpan = clip.outPoint - clip.inPoint;
    patchClip(project, params.clipId, {
      speed,
      duration: sourceSpan > 0 ? sourceSpan / speed : clip.duration,
    });
  },
  invert(action: Action, projectBefore: Project): Action | null {
    const params = action.params as { clipId: string };
    const prior = findClip(projectBefore, params.clipId);
    if (!prior) return null;
    return {
      type: "clip/setSpeed",
      id: `inverse-${action.id}`,
      timestamp: Date.now(),
      params: { clipId: params.clipId, speed: prior.speed ?? 1 },
    };
  },
};

// Consolidated speed-ramp persistence: keyframes + freeze frames + pitch in one
// undoable unit (the ramp UI mutates the speed engine, then persists here).
const speedSetRampData: ActionHandler = {
  type: "speed/setRampData",
  synchronous: true,
  validate(action: Action, project: Project): ValidationResult {
    const params = action.params as { clipId?: string };
    return typeof params.clipId === "string" && findClip(project, params.clipId)
      ? { valid: true, errors: [] }
      : {
          valid: false,
          errors: [
            {
              code: "CLIP_NOT_FOUND",
              message: `Clip not found: ${String(params.clipId)}`,
            },
          ],
        };
  },
  apply(action: Action, project: Project): void {
    const params = action.params as {
      clipId: string;
      keyframes?: unknown;
      freezeFrames?: unknown;
      pitchCorrection?: unknown;
    };
    patchClip(project, params.clipId, {
      speedKeyframes: params.keyframes as never,
      freezeFrames: params.freezeFrames as never,
      pitchCorrection: params.pitchCorrection as never,
    });
  },
  invert(action: Action, projectBefore: Project): Action | null {
    const params = action.params as { clipId: string };
    const prior = findClip(projectBefore, params.clipId);
    if (!prior) return null;
    return {
      type: "speed/setRampData",
      id: `inverse-${action.id}`,
      timestamp: Date.now(),
      params: {
        clipId: params.clipId,
        keyframes: prior.speedKeyframes,
        freezeFrames: prior.freezeFrames,
        pitchCorrection: prior.pitchCorrection,
      },
    };
  },
};

const handlers = [
  clipSetSpeed,
  speedSetRampData,
  makeClipFieldHandler({
    type: "clip/setReverse",
    paramKey: "reversed",
    field: "reversed",
    validateValue: (v) =>
      v == null || typeof v === "boolean" ? null : "reversed must be a boolean",
  }),
  makeClipFieldHandler({
    type: "clip/setPitchCorrection",
    paramKey: "pitchCorrection",
    field: "pitchCorrection",
    validateValue: (v) =>
      v == null || typeof v === "boolean"
        ? null
        : "pitchCorrection must be a boolean",
  }),
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
  makeClipFieldHandler({
    type: "speed/setKeyframes",
    paramKey: "keyframes",
    field: "speedKeyframes",
    validateValue: (v) =>
      v == null || Array.isArray(v) ? null : "keyframes must be an array",
  }),
  makeClipFieldHandler({
    type: "speed/setFreezeFrames",
    paramKey: "freezeFrames",
    field: "freezeFrames",
    validateValue: (v) =>
      v == null || Array.isArray(v) ? null : "freezeFrames must be an array",
  }),
];

for (const handler of handlers) {
  registerActionHandler(handler);
}
