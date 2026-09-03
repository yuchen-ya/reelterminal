/**
 * The closed edit.apply op set: strict schema validation and translation
 * into core actions. Facade-level semantic checks that the generic core
 * boundary does not own (media bounds, duplicate ids, text-overlay
 * existence, normalized crop bounds) live here so every core action the
 * executor sees is already sane.
 */
import type { Action } from "@openreel/core/types/actions";
import type { Project, ProjectMarker } from "@openreel/core/types/project";
import { DEFAULT_PROJECT_MARKER_COLOR } from "@openreel/core/types/project";
import type { Transform, Transition } from "@openreel/core/types/timeline";
import { TransitionEngine } from "@openreel/core/video/transition-engine";
import type { TextClip } from "@openreel/core/text/types";
import {
  DEFAULT_TEXT_STYLE,
  DEFAULT_TEXT_TRANSFORM,
} from "@openreel/core/text/types";
import { FacadeError } from "./errors";
import { invalidParams } from "./validate";
import {
  isNonEmptyString,
  isNonNegativeNumber,
  isPlainObject,
  isPositiveInteger,
  isPositiveNumber,
  isBoolean,
  isFiniteNumber,
  isString,
  oneOf,
  validateObject,
  type ObjectSchema,
} from "./validate";
import {
  EDIT_OP_TYPES,
  EDIT_TRANSITION_TYPES,
  TRACK_TYPES,
  type ClipAddOp,
  type ClipDuplicateOp,
  type ClipMoveOp,
  type ClipRemoveOp,
  type ClipRippleDeleteOp,
  type ClipSetFadeOp,
  type ClipSetReverseOp,
  type ClipSetSpeedOp,
  type ClipSetTransformOp,
  type ClipTransformInput,
  type ClipSetVolumeOp,
  type ClipSplitOp,
  type ClipTrimOp,
  type EditOp,
  type NormalizedPoint,
  type TextCreateOp,
  type TextDeleteOp,
  type TextUpdateOp,
  type TextStyleInput,
  type TrackAddOp,
  type TrackRemoveOp,
  type MediaRemoveOp,
  type MarkerAddOp,
  type MarkerRemoveOp,
  type TransitionAddOp,
  type TransitionRemoveOp,
  type TransitionUpdateOp,
} from "./types";

/* ------------------------------------------------------------------ */
/* Strict op validation                                                */
/* ------------------------------------------------------------------ */

/**
 * The op declarations below are the SINGLE hand-maintained definition
 * of the closed edit.apply op set (ADR 0003 Decision 4): the runtime
 * validator (validateEditOp) and the emitted draft-2020-12 JSON Schema
 * (jsonschema.ts, via verb-schemas.ts) both derive from them. Rules that
 * JSON Schema cannot express (clip.trim's at-least-one-of in/out, text.update's
 * at-least-one-field, the out>in ordering, non-whitespace text) stay
 * validation-only predicates — the emitted schema is a superset filter and
 * these validators remain the only authority.
 */
export const TRACK_ADD_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "track.add",
    describe: '"track.add"',
    required: true,
    emits: { kind: "leaf", schema: { const: "track.add" } },
  },
  trackType: {
    check: oneOf(TRACK_TYPES),
    describe: `one of ${TRACK_TYPES.join(", ")}`,
    required: true,
    emits: { kind: "leaf", schema: { enum: [...TRACK_TYPES] } },
  },
  trackId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const TRACK_REMOVE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "track.remove",
    describe: '"track.remove"',
    required: true,
    emits: { kind: "leaf", schema: { const: "track.remove" } },
  },
  trackId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const MEDIA_REMOVE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "media.remove",
    describe: '"media.remove"',
    required: true,
    emits: { kind: "leaf", schema: { const: "media.remove" } },
  },
  mediaId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const CLIP_ADD_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "clip.add",
    describe: '"clip.add"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.add" } },
  },
  trackId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  mediaId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  startTime: {
    check: isNonNegativeNumber,
    describe: "a finite number >= 0",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  duration: {
    check: isPositiveNumber,
    describe: "a finite number > 0",
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
  inPoint: {
    check: isNonNegativeNumber,
    describe: "a finite number >= 0",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  outPoint: {
    check: isPositiveNumber,
    describe: "a finite number > 0",
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const CLIP_TRIM_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "clip.trim",
    describe: '"clip.trim"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.trim" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  // "at least one of inPoint/outPoint" (and out > in) is a cross-field
  // predicate enforced in validateEditOp — deliberately NOT emitted.
  inPoint: {
    check: isNonNegativeNumber,
    describe: "a finite number >= 0",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  outPoint: {
    check: isNonNegativeNumber,
    describe: "a finite number >= 0",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
};

export const CLIP_MOVE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "clip.move",
    describe: '"clip.move"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.move" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  startTime: {
    check: isNonNegativeNumber,
    describe: "a finite number >= 0",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  trackId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const CLIP_SPLIT_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "clip.split",
    describe: '"clip.split"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.split" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  time: {
    check: isNonNegativeNumber,
    describe: "a finite number >= 0",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
};

export const CLIP_DUPLICATE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "clip.duplicate",
    describe: '"clip.duplicate"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.duplicate" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  trackId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  startTime: {
    check: isNonNegativeNumber,
    describe: "a finite number >= 0",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
};

export const CLIP_RIPPLE_DELETE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "clip.rippleDelete",
    describe: '"clip.rippleDelete"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.rippleDelete" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/**
 * Normalized [0, 1] {x, y} pair (text.create/text.update position and
 * anchor). Resolution-independent: multiplied by frame width/height at
 * render time, so preview and export place it identically.
 */
export const NORMALIZED_POINT_SCHEMA: ObjectSchema = {
  x: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1,
    describe: "a finite number in [0, 1]",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
  y: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1,
    describe: "a finite number in [0, 1]",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
};

const isPlainObjectValue = (v: unknown): boolean =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const TEXT_FIELD_EMITS = {
  kind: "leaf",
  schema: { type: "string", minLength: 1 },
} as const;

export const TEXT_STYLE_SCHEMA: ObjectSchema = {
  fontFamily: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  fontSize: {
    check: isPositiveNumber,
    describe: "a finite number > 0",
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
  fontWeight: {
    check: (v) =>
      v === "normal" ||
      v === "bold" ||
      (typeof v === "number" &&
        Number.isInteger(v) &&
        v >= 100 &&
        v <= 900 &&
        v % 100 === 0),
    describe: '"normal", "bold", or a multiple of 100 in 100..900',
    emits: {
      kind: "leaf",
      schema: { enum: ["normal", "bold", 100, 200, 300, 400, 500, 600, 700, 800, 900] },
    },
  },
  color: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  textAlign: {
    check: oneOf(["left", "center", "right", "justify"]),
    describe: "one of left, center, right, justify",
    emits: { kind: "leaf", schema: { enum: ["left", "center", "right", "justify"] } },
  },
};

export const TEXT_CREATE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "text.create",
    describe: '"text.create"',
    required: true,
    emits: { kind: "leaf", schema: { const: "text.create" } },
  },
  text: {
    check: (v) => typeof v === "string" && v.trim().length > 0,
    describe: "a non-empty string",
    required: true,
    // Superset filter: whitespace-only strings stay validator-only.
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  startTime: {
    check: isNonNegativeNumber,
    describe: "a finite number >= 0",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  duration: {
    check: isPositiveNumber,
    describe: "a finite number > 0",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
  trackId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  style: {
    check: isPlainObjectValue,
    describe: "an object",
    emits: { kind: "object", schema: TEXT_STYLE_SCHEMA },
  },
  position: {
    check: isPlainObjectValue,
    describe: "an object",
    emits: { kind: "object", schema: NORMALIZED_POINT_SCHEMA },
  },
  anchor: {
    check: isPlainObjectValue,
    describe: "an object",
    emits: { kind: "object", schema: NORMALIZED_POINT_SCHEMA },
  },
};

export const TEXT_UPDATE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "text.update",
    describe: '"text.update"',
    required: true,
    emits: { kind: "leaf", schema: { const: "text.update" } },
  },
  // The id surfaced by timeline.get / project.get_state as
  // textOverlays[].id.
  overlayId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  text: {
    check: (v) => typeof v === "string" && v.trim().length > 0,
    describe: "a non-empty string",
    // Superset filter: whitespace-only strings stay validator-only.
    emits: TEXT_FIELD_EMITS,
  },
  startTime: {
    check: isNonNegativeNumber,
    describe: "a finite number >= 0",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  duration: {
    check: isPositiveNumber,
    describe: "a finite number > 0",
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
  style: {
    check: isPlainObjectValue,
    describe: "an object",
    emits: { kind: "object", schema: TEXT_STYLE_SCHEMA },
  },
  position: {
    check: isPlainObjectValue,
    describe: "an object",
    emits: { kind: "object", schema: NORMALIZED_POINT_SCHEMA },
  },
  anchor: {
    check: isPlainObjectValue,
    describe: "an object",
    emits: { kind: "object", schema: NORMALIZED_POINT_SCHEMA },
  },
};

export const TEXT_DELETE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "text.delete",
    describe: '"text.delete"',
    required: true,
    emits: { kind: "leaf", schema: { const: "text.delete" } },
  },
  overlayId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

const PIXEL_POINT_SCHEMA: ObjectSchema = {
  x: {
    check: isFiniteNumber,
    describe: "a finite number",
    required: true,
    emits: { kind: "leaf", schema: { type: "number" } },
  },
  y: {
    check: isFiniteNumber,
    describe: "a finite number",
    required: true,
    emits: { kind: "leaf", schema: { type: "number" } },
  },
};

const SCALE_POINT_SCHEMA: ObjectSchema = {
  x: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0.01 && v <= 20,
    describe: "a finite number in [0.01, 20]",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0.01, maximum: 20 } },
  },
  y: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0.01 && v <= 20,
    describe: "a finite number in [0.01, 20]",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0.01, maximum: 20 } },
  },
};

const CROP_RECT_SCHEMA: ObjectSchema = {
  x: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1,
    describe: "a finite number in [0, 1)",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
  y: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1,
    describe: "a finite number in [0, 1)",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
  width: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1,
    describe: "a finite number in (0, 1]",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0, maximum: 1 } },
  },
  height: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1,
    describe: "a finite number in (0, 1]",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0, maximum: 1 } },
  },
};

const CLIP_TRANSFORM_SCHEMA: ObjectSchema = {
  position: {
    check: isPlainObjectValue,
    describe: "an object",
    emits: { kind: "object", schema: PIXEL_POINT_SCHEMA },
  },
  scale: {
    check: isPlainObjectValue,
    describe: "an object",
    emits: { kind: "object", schema: SCALE_POINT_SCHEMA },
  },
  rotation: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= -360 && v <= 360,
    describe: "a finite number in [-360, 360]",
    emits: { kind: "leaf", schema: { type: "number", minimum: -360, maximum: 360 } },
  },
  anchor: {
    check: isPlainObjectValue,
    describe: "an object",
    emits: { kind: "object", schema: NORMALIZED_POINT_SCHEMA },
  },
  opacity: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1,
    describe: "a finite number in [0, 1]",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
  fitMode: {
    check: oneOf(["contain", "cover", "stretch", "none"]),
    describe: "one of contain, cover, stretch, none",
    emits: { kind: "leaf", schema: { enum: ["contain", "cover", "stretch", "none"] } },
  },
  crop: {
    check: isPlainObjectValue,
    describe: "an object",
    emits: { kind: "object", schema: CROP_RECT_SCHEMA },
  },
  clearCrop: {
    check: (v) => v === true,
    describe: "true",
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
};

export const CLIP_SET_TRANSFORM_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "clip.setTransform",
    describe: '"clip.setTransform"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.setTransform" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  transform: {
    check: isPlainObjectValue,
    describe: "an object",
    required: true,
    emits: { kind: "object", schema: CLIP_TRANSFORM_SCHEMA },
  },
};

export const CLIP_SET_VOLUME_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "clip.setVolume",
    describe: '"clip.setVolume"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.setVolume" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  // Linear gain; matches core's realtime clamp ceiling (0 = mute, 1 = unity).
  volume: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 4,
    describe: "a finite number in [0, 4]",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 4 } },
  },
};

export const CLIP_SET_SPEED_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "clip.setSpeed",
    describe: '"clip.setSpeed"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.setSpeed" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  speed: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0.1 && v <= 20,
    describe: "a finite number in [0.1, 20]",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0.1, maximum: 20 } },
  },
};

export const CLIP_SET_REVERSE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "clip.setReverse",
    describe: '"clip.setReverse"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.setReverse" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  reversed: {
    check: isBoolean,
    describe: "a boolean",
    required: true,
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
};

export const CLIP_SET_FADE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "clip.setFade",
    describe: '"clip.setFade"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.setFade" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  fadeIn: {
    check: isNonNegativeNumber,
    describe: "a finite number >= 0",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  fadeOut: {
    check: isNonNegativeNumber,
    describe: "a finite number >= 0",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
};

export const CLIP_REMOVE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "clip.remove",
    describe: '"clip.remove"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.remove" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const TRANSITION_ADD_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "transition.add",
    describe: '"transition.add"',
    required: true,
    emits: { kind: "leaf", schema: { const: "transition.add" } },
  },
  clipAId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  clipBId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  type: {
    check: oneOf(EDIT_TRANSITION_TYPES),
    describe: `one of ${EDIT_TRANSITION_TYPES.join(", ")}`,
    required: true,
    emits: { kind: "leaf", schema: { enum: [...EDIT_TRANSITION_TYPES] } },
  },
  duration: {
    check: isPositiveNumber,
    describe: "a finite number > 0",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
};

export const TRANSITION_UPDATE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "transition.update",
    describe: '"transition.update"',
    required: true,
    emits: { kind: "leaf", schema: { const: "transition.update" } },
  },
  transitionId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  type: {
    check: oneOf(EDIT_TRANSITION_TYPES),
    describe: `one of ${EDIT_TRANSITION_TYPES.join(", ")}`,
    emits: { kind: "leaf", schema: { enum: [...EDIT_TRANSITION_TYPES] } },
  },
  duration: {
    check: isPositiveNumber,
    describe: "a finite number > 0",
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
};

export const TRANSITION_REMOVE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "transition.remove",
    describe: '"transition.remove"',
    required: true,
    emits: { kind: "leaf", schema: { const: "transition.remove" } },
  },
  transitionId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/* marker.add target: the closed 4-variant union (one object per kind). */
export const MARKER_TARGET_ASSET_SCHEMA: ObjectSchema = {
  kind: {
    check: (v) => v === "asset",
    describe: '"asset"',
    required: true,
    emits: { kind: "leaf", schema: { const: "asset" } },
  },
  mediaId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const MARKER_TARGET_CLIP_SCHEMA: ObjectSchema = {
  kind: {
    check: (v) => v === "clip",
    describe: '"clip"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const MARKER_TARGET_TEXT_SCHEMA: ObjectSchema = {
  kind: {
    check: (v) => v === "text",
    describe: '"text"',
    required: true,
    emits: { kind: "leaf", schema: { const: "text" } },
  },
  textClipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const MARKER_TARGET_TIME_RANGE_SCHEMA: ObjectSchema = {
  kind: {
    check: (v) => v === "timeRange",
    describe: '"timeRange"',
    required: true,
    emits: { kind: "leaf", schema: { const: "timeRange" } },
  },
  start: {
    check: isNonNegativeNumber,
    describe: "a finite number >= 0",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  end: {
    check: isNonNegativeNumber,
    describe: "a finite number >= 0",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
};

const MARKER_TARGET_VARIANTS = [
  MARKER_TARGET_ASSET_SCHEMA,
  MARKER_TARGET_CLIP_SCHEMA,
  MARKER_TARGET_TEXT_SCHEMA,
  MARKER_TARGET_TIME_RANGE_SCHEMA,
] as const;

/**
 * Structural target check: exactly one closed variant by `kind`. Reference
 * existence and the end >= start ordering are semantic rules owned by
 * opToCoreActions / the core validator, not this boundary shape check.
 */
function isMarkerTarget(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const variant = MARKER_TARGET_VARIANTS.find(
    (schema) => schema.kind?.check(value.kind) ?? false,
  );
  if (!variant) return false;
  try {
    validateObject(value, variant, "target");
    return true;
  } catch {
    return false;
  }
}

/** The 200-character label cap is validation-only (not emitted). */
const isMarkerLabel = (v: unknown): boolean =>
  typeof v === "string" && v.length <= 200;

export const MARKER_ADD_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "marker.add",
    describe: '"marker.add"',
    required: true,
    emits: { kind: "leaf", schema: { const: "marker.add" } },
  },
  target: {
    check: isMarkerTarget,
    describe: "a marker target object ({kind:\"asset\",mediaId}, {kind:\"clip\",clipId}, {kind:\"text\",textClipId}, or {kind:\"timeRange\",start,end})",
    required: true,
    emits: { kind: "anyOfObjects", variants: MARKER_TARGET_VARIANTS },
  },
  label: {
    check: isMarkerLabel,
    describe: "a string of at most 200 characters",
    emits: { kind: "leaf", schema: { type: "string" } },
  },
  color: {
    check: isString,
    describe: "a string",
    emits: { kind: "leaf", schema: { type: "string" } },
  },
};

export const MARKER_REMOVE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "marker.remove",
    describe: '"marker.remove"',
    required: true,
    emits: { kind: "leaf", schema: { const: "marker.remove" } },
  },
  number: {
    check: isPositiveInteger,
    describe: "a positive integer",
    required: true,
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
};

/**
 * Rebind nested style/position/anchor to SANITIZED copies: opToCoreActions
 * spreads them into the canonical TextClip, so what flows downstream must be
 * the fresh validated objects — never the raw nested caller objects (whose
 * getters could yield different values post-validation).
 */
function sanitizeTextFields<T extends TextCreateOp | TextUpdateOp>(
  op: T,
  label: string,
): T {
  const out: Record<string, unknown> = { ...op };
  if (op.style !== undefined) {
    out.style = validateObject<TextStyleInput>(
      op.style,
      TEXT_STYLE_SCHEMA,
      `${label}.style`,
    );
  }
  for (const field of ["position", "anchor"] as const) {
    const value = op[field];
    if (value !== undefined) {
      out[field] = validateObject<NormalizedPoint>(
        value,
        NORMALIZED_POINT_SCHEMA,
        `${label}.${field}`,
      );
    }
  }
  return out as unknown as T;
}

function sanitizeClipTransform(
  op: ClipSetTransformOp,
  label: string,
): ClipSetTransformOp {
  const transform = validateObject<ClipTransformInput>(
    op.transform,
    CLIP_TRANSFORM_SCHEMA,
    `${label}.transform`,
  );
  if (Object.keys(transform).length === 0) {
    throw invalidParams(`${label}: transform must set at least one field`);
  }
  const sanitized: Record<string, unknown> = { ...transform };
  if (transform.position !== undefined) {
    sanitized.position = validateObject<{ x: number; y: number }>(
      transform.position,
      PIXEL_POINT_SCHEMA,
      `${label}.transform.position`,
    );
  }
  if (transform.scale !== undefined) {
    sanitized.scale = validateObject<{ x: number; y: number }>(
      transform.scale,
      SCALE_POINT_SCHEMA,
      `${label}.transform.scale`,
    );
  }
  if (transform.anchor !== undefined) {
    sanitized.anchor = validateObject<NormalizedPoint>(
      transform.anchor,
      NORMALIZED_POINT_SCHEMA,
      `${label}.transform.anchor`,
    );
  }
  if (transform.crop !== undefined) {
    const crop = validateObject<NonNullable<ClipTransformInput["crop"]>>(
      transform.crop,
      CROP_RECT_SCHEMA,
      `${label}.transform.crop`,
    );
    if (crop.x + crop.width > 1 || crop.y + crop.height > 1) {
      throw invalidParams(
        `${label}: crop must stay within the normalized source bounds`,
        { crop },
      );
    }
    sanitized.crop = crop;
  }
  if (transform.crop !== undefined && transform.clearCrop === true) {
    throw invalidParams(`${label}: crop and clearCrop cannot be combined`);
  }
  return { ...op, transform: sanitized as ClipTransformInput };
}

/**
 * Validate one raw op against its closed schema. Throws INVALID_PARAMS on
 * unknown fields, wrong field names, missing required fields, wrong types.
 */
export function validateEditOp(raw: unknown, index: number): EditOp {
  const label = `ops[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalidParams(`${label} must be an object`);
  }
  const opType = (raw as Record<string, unknown>).op;
  if (typeof opType !== "string" || !(EDIT_OP_TYPES as readonly string[]).includes(opType)) {
    throw invalidParams(
      `${label}: unsupported op ${JSON.stringify(opType)} — allowed: ${EDIT_OP_TYPES.join(", ")}`,
      { op: opType, allowedOps: [...EDIT_OP_TYPES] },
    );
  }
  switch (opType as EditOp["op"]) {
    case "track.add":
      return validateObject<TrackAddOp>(raw, TRACK_ADD_SCHEMA, label);
    case "track.remove":
      return validateObject<TrackRemoveOp>(raw, TRACK_REMOVE_SCHEMA, label);
    case "media.remove":
      return validateObject<MediaRemoveOp>(raw, MEDIA_REMOVE_SCHEMA, label);
    case "clip.add":
      return validateObject<ClipAddOp>(raw, CLIP_ADD_SCHEMA, label);
    case "clip.move":
      return validateObject<ClipMoveOp>(raw, CLIP_MOVE_SCHEMA, label);
    case "clip.trim": {
      const op = validateObject<ClipTrimOp>(raw, CLIP_TRIM_SCHEMA, label);
      if (op.inPoint === undefined && op.outPoint === undefined) {
        throw invalidParams(`${label}: at least one of inPoint/outPoint is required`);
      }
      if (
        op.inPoint !== undefined &&
        op.outPoint !== undefined &&
        op.outPoint <= op.inPoint
      ) {
        throw invalidParams(`${label}: outPoint must be greater than inPoint`, {
          inPoint: op.inPoint,
          outPoint: op.outPoint,
        });
      }
      return op;
    }
    case "clip.split":
      return validateObject<ClipSplitOp>(raw, CLIP_SPLIT_SCHEMA, label);
    case "clip.duplicate":
      return validateObject<ClipDuplicateOp>(raw, CLIP_DUPLICATE_SCHEMA, label);
    case "clip.rippleDelete":
      return validateObject<ClipRippleDeleteOp>(
        raw,
        CLIP_RIPPLE_DELETE_SCHEMA,
        label,
      );
    case "text.create": {
      const op = validateObject<TextCreateOp>(raw, TEXT_CREATE_SCHEMA, label);
      return sanitizeTextFields(op, label);
    }
    case "text.update": {
      const op = validateObject<TextUpdateOp>(raw, TEXT_UPDATE_SCHEMA, label);
      // "at least one updatable field" is a cross-field predicate enforced
      // here — deliberately NOT emitted.
      if (
        op.text === undefined &&
        op.startTime === undefined &&
        op.duration === undefined &&
        op.style === undefined &&
        op.position === undefined &&
        op.anchor === undefined
      ) {
        throw invalidParams(
          `${label}: at least one of text/startTime/duration/style/position/anchor is required`,
        );
      }
      return sanitizeTextFields(op, label);
    }
    case "text.delete":
      return validateObject<TextDeleteOp>(raw, TEXT_DELETE_SCHEMA, label);
    case "clip.setSpeed":
      return validateObject<ClipSetSpeedOp>(raw, CLIP_SET_SPEED_SCHEMA, label);
    case "clip.setReverse":
      return validateObject<ClipSetReverseOp>(raw, CLIP_SET_REVERSE_SCHEMA, label);
    case "clip.setTransform": {
      const op = validateObject<ClipSetTransformOp>(
        raw,
        CLIP_SET_TRANSFORM_SCHEMA,
        label,
      );
      return sanitizeClipTransform(op, label);
    }
    case "clip.setVolume":
      return validateObject<ClipSetVolumeOp>(raw, CLIP_SET_VOLUME_SCHEMA, label);
    case "clip.setFade": {
      const op = validateObject<ClipSetFadeOp>(raw, CLIP_SET_FADE_SCHEMA, label);
      if (op.fadeIn === undefined && op.fadeOut === undefined) {
        throw invalidParams(`${label}: at least one of fadeIn/fadeOut is required`);
      }
      return op;
    }
    case "clip.remove":
      return validateObject<ClipRemoveOp>(raw, CLIP_REMOVE_SCHEMA, label);
    case "transition.add":
      return validateObject<TransitionAddOp>(raw, TRANSITION_ADD_SCHEMA, label);
    case "transition.update": {
      const op = validateObject<TransitionUpdateOp>(
        raw,
        TRANSITION_UPDATE_SCHEMA,
        label,
      );
      if (op.type === undefined && op.duration === undefined) {
        throw invalidParams(
          `${label}: at least one of type/duration is required`,
        );
      }
      return op;
    }
    case "transition.remove":
      return validateObject<TransitionRemoveOp>(
        raw,
        TRANSITION_REMOVE_SCHEMA,
        label,
      );
    case "marker.add":
      return validateObject<MarkerAddOp>(raw, MARKER_ADD_SCHEMA, label);
    case "marker.remove":
      return validateObject<MarkerRemoveOp>(raw, MARKER_REMOVE_SCHEMA, label);
    default:
      // Unreachable: opType was allowlist-checked above. Keeps the function
      // total for the compiler and fail-closed for the runtime.
      throw invalidParams(`${label}: unsupported op ${JSON.stringify(opType)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Op → core action translation                                        */
/* ------------------------------------------------------------------ */

let actionCounter = 0;

function makeAction(type: string, params: Record<string, unknown>): Action {
  actionCounter += 1;
  return {
    type,
    id: `facade-${Date.now().toString(36)}-${actionCounter}-${crypto.randomUUID()}`,
    timestamp: Date.now(),
    params,
  };
}

/** Ids of every entity class the facade can create, for created-id diffing. */
export interface EntityIdSets {
  readonly tracks: ReadonlySet<string>;
  readonly clips: ReadonlySet<string>;
  readonly textOverlays: ReadonlySet<string>;
  readonly transitions: ReadonlySet<string>;
}

export function collectEntityIds(project: Project): EntityIdSets {
  const tracks = new Set<string>();
  const clips = new Set<string>();
  const transitions = new Set<string>();
  for (const track of project.timeline.tracks) {
    tracks.add(track.id);
    for (const clip of track.clips) clips.add(clip.id);
    for (const transition of track.transitions ?? []) transitions.add(transition.id);
  }
  const textOverlays = new Set((project.textClips ?? []).map((c) => c.id));
  return { tracks, clips, textOverlays, transitions };
}

/** Created entity ids, partitioned by category (the live seam's shape). */
export interface CreatedIdsByCategory {
  readonly tracks: readonly string[];
  readonly clips: readonly string[];
  readonly textClips: readonly string[];
  readonly transitions: readonly string[];
}

export function diffCreatedIdsByCategory(
  before: EntityIdSets,
  after: EntityIdSets,
): CreatedIdsByCategory {
  return {
    tracks: [...after.tracks].filter((id) => !before.tracks.has(id)),
    clips: [...after.clips].filter((id) => !before.clips.has(id)),
    textClips: [...after.textOverlays].filter(
      (id) => !before.textOverlays.has(id),
    ),
    transitions: [...after.transitions].filter(
      (id) => !before.transitions.has(id),
    ),
  };
}

export function diffCreatedIds(before: EntityIdSets, after: EntityIdSets): string[] {
  const byCategory = diffCreatedIdsByCategory(before, after);
  return [
    ...byCategory.tracks,
    ...byCategory.clips,
    ...byCategory.textClips,
    ...byCategory.transitions,
  ];
}

/**
 * Post-execution id override for clip.add with an explicit clipId: core
 * mints a random id, so the facade renames the just-created clip inside the
 * draft transaction. Runs BEFORE the created-id report is finalized so
 * results report the caller-visible id.
 */
export function applyClipIdOverride(
  op: EditOp,
  draft: Project,
  createdIds: readonly string[],
): void {
  if (op.op !== "clip.add" || op.clipId === undefined) return;
  const mintedId = createdIds[0];
  if (mintedId === undefined) return;
  const timeline = draft.timeline as unknown as {
    tracks: Array<{ clips: Array<{ id: string }> }>;
  };
  for (const track of timeline.tracks) {
    track.clips = track.clips.map((clip) =>
      clip.id === mintedId ? { ...clip, id: op.clipId as string } : clip,
    );
  }
}

/**
 * Facade-level semantic pre-checks + translation. Runs against the in-flight
 * DRAFT (so sequential intra-batch references resolve), throws FacadeError
 * before any core action is produced when the op cannot succeed.
 */
export function opToCoreActions(op: EditOp, draft: Project): Action[] {
  switch (op.op) {
    case "track.add": {
      if (
        op.trackId !== undefined &&
        draft.timeline.tracks.some((t) => t.id === op.trackId)
      ) {
        throw new FacadeError(
          "CONFLICT",
          `track.add: a track with id "${op.trackId}" already exists`,
          { trackId: op.trackId },
        );
      }
      return [
        makeAction("track/add", {
          trackType: op.trackType,
          ...(op.trackId !== undefined ? { trackId: op.trackId } : {}),
        }),
      ];
    }

    case "track.remove": {
      const track = draft.timeline.tracks.find((candidate) => candidate.id === op.trackId);
      if (!track) {
        throw new FacadeError(
          "NOT_FOUND",
          `track.remove: track "${op.trackId}" not found`,
          { trackId: op.trackId },
        );
      }

      // A track can carry timeline clips or engine-backed overlays. Refuse
      // non-empty tracks rather than silently orphaning content. This keeps
      // the operation safe for both headless state and the live renderer.
      const clipIds = track.clips.map((clip) => clip.id);
      const transitionIds = (track.transitions ?? []).map((transition) => transition.id);
      const overlayIds = [
        ...(draft.textClips ?? []),
        ...(draft.shapeClips ?? []),
        ...(draft.svgClips ?? []),
        ...(draft.stickerClips ?? []),
      ]
        .filter((clip) => clip.trackId === op.trackId)
        .map((clip) => clip.id);
      if (clipIds.length > 0 || transitionIds.length > 0 || overlayIds.length > 0) {
        throw new FacadeError(
          "CONFLICT",
          `track.remove: track "${op.trackId}" is not empty — remove its clips and overlays first`,
          {
            reason: "TRACK_NOT_EMPTY",
            trackId: op.trackId,
            ...(clipIds.length > 0 ? { clipIds } : {}),
            ...(overlayIds.length > 0 ? { overlayIds } : {}),
            ...(transitionIds.length > 0 ? { transitionIds } : {}),
          },
        );
      }
      return [makeAction("track/remove", { trackId: op.trackId })];
    }

    case "media.remove": {
      const media = draft.mediaLibrary.items.find((item) => item.id === op.mediaId);
      if (!media) {
        throw new FacadeError(
          "NOT_FOUND",
          `media.remove: media "${op.mediaId}" not found`,
          { mediaId: op.mediaId },
        );
      }
      const clipIds = draft.timeline.tracks
        .flatMap((track) => track.clips)
        .filter((clip) => clip.mediaId === op.mediaId)
        .map((clip) => clip.id);
      if (clipIds.length > 0) {
        throw new FacadeError(
          "CONFLICT",
          `media.remove: media "${op.mediaId}" is still referenced by timeline clips — remove the clips first`,
          { reason: "MEDIA_IN_USE", mediaId: op.mediaId, clipIds },
        );
      }
      return [makeAction("media/delete", { mediaId: op.mediaId })];
    }

    case "clip.add": {
      const track = draft.timeline.tracks.find((t) => t.id === op.trackId);
      if (!track) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.add: track "${op.trackId}" not found`,
          { trackId: op.trackId },
        );
      }
      const media = draft.mediaLibrary.items.find((m) => m.id === op.mediaId);
      if (!media) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.add: media "${op.mediaId}" not found`,
          { mediaId: op.mediaId },
        );
      }
      if (
        op.outPoint !== undefined &&
        op.inPoint !== undefined &&
        op.outPoint <= op.inPoint
      ) {
        throw invalidParams(
          `clip.add: outPoint must be greater than inPoint`,
          { inPoint: op.inPoint, outPoint: op.outPoint },
        );
      }
      // Canonical-state invariant: the committed range must satisfy
      // outPoint > inPoint and stay inside the source media. Reproduce core's
      // own defaulting (action-executor clip/add: duration → outPoint, with
      // inPoint defaulting independently) so degenerate combinations like
      // {inPoint:5, duration:3} or {inPoint:8} on 6s media are REJECTED here
      // instead of silently committing inverted ranges.
      // (Media with unknown/zero duration — images, placeholders — is exempt
      // from the upper bound, matching core's 5-second default convention.)
      const mediaDuration = media.metadata.duration ?? 0;
      const effectiveIn = op.inPoint ?? 0;
      const effectiveDuration =
        op.duration ?? (mediaDuration > 0 ? mediaDuration : 5);
      const effectiveOut = op.outPoint ?? effectiveDuration;
      if (effectiveOut <= effectiveIn) {
        throw invalidParams(
          `clip.add: resulting range must satisfy outPoint > inPoint`,
          {
            mediaId: op.mediaId,
            inPoint: effectiveIn,
            outPoint: effectiveOut,
          },
        );
      }
      if (mediaDuration > 0) {
        if (effectiveIn > mediaDuration + 1e-6) {
          throw invalidParams(
            `clip.add: inPoint ${effectiveIn} exceeds media duration ${mediaDuration}`,
            { mediaId: op.mediaId, mediaDuration, inPoint: effectiveIn },
          );
        }
        if (effectiveOut > mediaDuration + 1e-6) {
          throw invalidParams(
            `clip.add: clip range exceeds media duration ${mediaDuration}`,
            { mediaId: op.mediaId, mediaDuration, outPoint: effectiveOut },
          );
        }
      }
      if (
        op.clipId !== undefined &&
        draft.timeline.tracks.some((t) => t.clips.some((c) => c.id === op.clipId))
      ) {
        throw new FacadeError(
          "CONFLICT",
          `clip.add: a clip with id "${op.clipId}" already exists`,
          { clipId: op.clipId },
        );
      }
      return [
        makeAction("clip/add", {
          trackId: op.trackId,
          mediaId: op.mediaId,
          startTime: op.startTime,
          ...(op.duration !== undefined ? { duration: op.duration } : {}),
          ...(op.inPoint !== undefined ? { inPoint: op.inPoint } : {}),
          ...(op.outPoint !== undefined ? { outPoint: op.outPoint } : {}),
        }),
      ];
    }

    case "clip.trim": {
      const clip = draft.timeline.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === op.clipId);
      if (!clip) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.trim: clip "${op.clipId}" not found`,
          { clipId: op.clipId },
        );
      }
      const newIn = op.inPoint ?? clip.inPoint;
      const newOut = op.outPoint ?? clip.outPoint;
      if (newOut <= newIn) {
        throw invalidParams(
          `clip.trim: resulting range must satisfy outPoint > inPoint`,
          { clipId: op.clipId, inPoint: newIn, outPoint: newOut },
        );
      }
      const media = draft.mediaLibrary.items.find((m) => m.id === clip.mediaId);
      const mediaDuration = media?.metadata.duration ?? 0;
      if (mediaDuration > 0 && newOut > mediaDuration + 1e-6) {
        throw invalidParams(
          `clip.trim: outPoint ${newOut} exceeds media duration ${mediaDuration}`,
          { clipId: op.clipId, mediaId: clip.mediaId, mediaDuration },
        );
      }
      return [
        makeAction("clip/trim", {
          clipId: op.clipId,
          ...(op.inPoint !== undefined ? { inPoint: op.inPoint } : {}),
          ...(op.outPoint !== undefined ? { outPoint: op.outPoint } : {}),
        }),
      ];
    }

    case "clip.move": {
      const clip = draft.timeline.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === op.clipId);
      if (!clip) {
        throw new FacadeError("NOT_FOUND", `clip.move: clip "${op.clipId}" not found`, {
          clipId: op.clipId,
        });
      }
      if (
        op.trackId !== undefined &&
        !draft.timeline.tracks.some((track) => track.id === op.trackId)
      ) {
        throw new FacadeError("NOT_FOUND", `clip.move: track "${op.trackId}" not found`, {
          trackId: op.trackId,
        });
      }
      return [
        makeAction("clip/move", {
          clipId: op.clipId,
          startTime: op.startTime,
          ...(op.trackId !== undefined ? { trackId: op.trackId } : {}),
        }),
      ];
    }

    case "clip.split": {
      const clip = draft.timeline.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === op.clipId);
      if (!clip) {
        throw new FacadeError("NOT_FOUND", `clip.split: clip "${op.clipId}" not found`, {
          clipId: op.clipId,
        });
      }
      if (
        (clip.speedKeyframes?.length ?? 0) > 0 ||
        (clip.freezeFrames?.length ?? 0) > 0
      ) {
        throw new FacadeError(
          "UNSUPPORTED",
          "clip.split: variable-speed and freeze-frame clips are not supported yet",
          { clipId: op.clipId },
        );
      }
      const endTime = clip.startTime + clip.duration;
      if (!(op.time > clip.startTime && op.time < endTime)) {
        throw invalidParams("clip.split: time must be strictly inside the clip bounds", {
          clipId: op.clipId,
          time: op.time,
          startTime: clip.startTime,
          endTime,
        });
      }
      return [makeAction("clip/split", { clipId: op.clipId, time: op.time })];
    }

    case "clip.duplicate": {
      const sourceTrack = draft.timeline.tracks.find((track) =>
        track.clips.some((clip) => clip.id === op.clipId),
      );
      const clip = sourceTrack?.clips.find((candidate) => candidate.id === op.clipId);
      if (!sourceTrack || !clip) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.duplicate: clip "${op.clipId}" not found`,
          { clipId: op.clipId },
        );
      }
      const targetTrack = op.trackId
        ? draft.timeline.tracks.find((track) => track.id === op.trackId)
        : sourceTrack;
      if (!targetTrack) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.duplicate: track "${op.trackId}" not found`,
          { trackId: op.trackId },
        );
      }
      if (targetTrack.type !== sourceTrack.type) {
        throw invalidParams(
          "clip.duplicate: destination track must have the same type as the source track",
          {
            clipId: op.clipId,
            sourceTrackType: sourceTrack.type,
            destinationTrackType: targetTrack.type,
          },
        );
      }

      // Match the editor's Duplicate command: start after the source, then
      // scan forward until the full duplicate fits in a gap. An explicit
      // startTime remains available when the caller intentionally wants an
      // overlap or a precise placement.
      let startTime = op.startTime ?? clip.startTime + clip.duration;
      if (op.startTime === undefined) {
        const epsilon = 0.0001;
        const sortedClips = [...targetTrack.clips].sort(
          (a, b) => a.startTime - b.startTime,
        );
        for (const other of sortedClips) {
          if (other.id === clip.id) continue;
          if (other.startTime + other.duration <= startTime + epsilon) continue;
          if (other.startTime >= startTime + clip.duration - epsilon) break;
          startTime = other.startTime + other.duration;
        }
      }
      return [
        makeAction("clip/add", {
          trackId: targetTrack.id,
          mediaId: clip.mediaId,
          startTime,
          sourceClip: structuredClone(clip),
        }),
      ];
    }

    case "clip.rippleDelete": {
      const exists = draft.timeline.tracks.some((track) =>
        track.clips.some((clip) => clip.id === op.clipId),
      );
      if (!exists) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.rippleDelete: clip "${op.clipId}" not found`,
          { clipId: op.clipId },
        );
      }
      return [makeAction("clip/rippleDelete", { clipId: op.clipId })];
    }

    case "text.create": {
      let trackId = op.trackId;
      let autoCreatedTrackId: string | undefined;
      if (trackId !== undefined) {
        const track = draft.timeline.tracks.find((t) => t.id === trackId);
        if (!track) {
          throw new FacadeError(
            "NOT_FOUND",
            `text.create: track "${trackId}" not found`,
            { trackId },
          );
        }
        if (track.type !== "text") {
          throw invalidParams(
            `text.create: track "${trackId}" is a ${track.type} track, expected a text track`,
            { trackId, trackType: track.type },
          );
        }
      } else {
        const textTrack = draft.timeline.tracks.find((t) => t.type === "text");
        if (textTrack) {
          trackId = textTrack.id;
        } else {
          // A text overlay is a higher-level intent: when the project has no
          // text lane yet, create one in the same action stream and point the
          // overlay at its explicit id. Both headless drafts and live stores
          // therefore commit/undo this as one atomic edit.apply unit.
          autoCreatedTrackId = `track-${crypto.randomUUID()}`;
          trackId = autoCreatedTrackId;
        }
      }

      const clip: TextClip = {
        id: `text-${crypto.randomUUID()}`,
        trackId,
        startTime: op.startTime,
        duration: op.duration,
        text: op.text,
        style: { ...DEFAULT_TEXT_STYLE, ...(op.style ?? {}) },
        transform: {
          ...DEFAULT_TEXT_TRANSFORM,
          ...(op.position !== undefined ? { position: { ...op.position } } : {}),
          ...(op.anchor !== undefined ? { anchor: { ...op.anchor } } : {}),
        },
        keyframes: [],
      };
      return [
        ...(autoCreatedTrackId !== undefined
          ? [
              makeAction("track/add", {
                trackType: "text",
                trackId: autoCreatedTrackId,
              }),
            ]
          : []),
        makeAction("text/create", { clip }),
      ];
    }

    case "text.update": {
      const existing = (draft.textClips ?? []).find(
        (c) => c.id === op.overlayId,
      );
      if (!existing) {
        throw new FacadeError(
          "NOT_FOUND",
          `text.update: text overlay "${op.overlayId}" not found`,
          { overlayId: op.overlayId },
        );
      }
      // Core text/update SHALLOW-spreads `updates` onto the clip, so merged
      // style/transform must be sent whole — a partial object would drop the
      // existing keys. Only keys the caller actually set go out.
      const updates: Partial<TextClip> = {
        ...(op.text !== undefined ? { text: op.text } : {}),
        ...(op.startTime !== undefined ? { startTime: op.startTime } : {}),
        ...(op.duration !== undefined ? { duration: op.duration } : {}),
        ...(op.style !== undefined
          ? { style: { ...existing.style, ...op.style } }
          : {}),
        ...(op.position !== undefined || op.anchor !== undefined
          ? {
              transform: {
                ...existing.transform,
                ...(op.position !== undefined ? { position: { ...op.position } } : {}),
                ...(op.anchor !== undefined ? { anchor: { ...op.anchor } } : {}),
              },
            }
          : {}),
      };
      return [makeAction("text/update", { clipId: op.overlayId, updates })];
    }

    case "text.delete": {
      const exists = (draft.textClips ?? []).some(
        (c) => c.id === op.overlayId,
      );
      if (!exists) {
        throw new FacadeError(
          "NOT_FOUND",
          `text.delete: text overlay "${op.overlayId}" not found`,
          { overlayId: op.overlayId },
        );
      }
      return [makeAction("text/remove", { clipId: op.overlayId })];
    }

    case "clip.setVolume": {
      const clip = draft.timeline.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === op.clipId);
      if (!clip) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.setVolume: clip "${op.clipId}" not found`,
          { clipId: op.clipId },
        );
      }
      return [
        makeAction("audio/setVolume", { clipId: op.clipId, volume: op.volume }),
      ];
    }

    case "clip.setSpeed": {
      const clip = draft.timeline.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === op.clipId);
      if (!clip) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.setSpeed: clip "${op.clipId}" not found`,
          { clipId: op.clipId },
        );
      }
      return [makeAction("clip/setSpeed", { clipId: op.clipId, speed: op.speed })];
    }

    case "clip.setReverse": {
      const clip = draft.timeline.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === op.clipId);
      if (!clip) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.setReverse: clip "${op.clipId}" not found`,
          { clipId: op.clipId },
        );
      }
      return [
        makeAction("clip/setReverse", {
          clipId: op.clipId,
          reversed: op.reversed,
        }),
      ];
    }

    case "clip.setTransform": {
      const track = draft.timeline.tracks.find((candidate) =>
        candidate.clips.some((clip) => clip.id === op.clipId),
      );
      if (!track) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.setTransform: clip "${op.clipId}" not found`,
          { clipId: op.clipId },
        );
      }
      if (track.type === "audio") {
        throw invalidParams(
          "clip.setTransform: visual transforms are unavailable on audio tracks",
          { clipId: op.clipId, trackId: track.id },
        );
      }
      const patch: Partial<Transform> = {
        ...(op.transform.position !== undefined
          ? { position: { ...op.transform.position } }
          : {}),
        ...(op.transform.scale !== undefined
          ? { scale: { ...op.transform.scale } }
          : {}),
        ...(op.transform.rotation !== undefined
          ? { rotation: op.transform.rotation }
          : {}),
        ...(op.transform.anchor !== undefined
          ? { anchor: { ...op.transform.anchor } }
          : {}),
        ...(op.transform.opacity !== undefined
          ? { opacity: op.transform.opacity }
          : {}),
        ...(op.transform.fitMode !== undefined
          ? { fitMode: op.transform.fitMode }
          : {}),
        ...(op.transform.crop !== undefined
          ? { crop: { ...op.transform.crop } }
          : {}),
        ...(op.transform.clearCrop === true ? { crop: undefined } : {}),
      };
      return [
        makeAction("transform/update", { clipId: op.clipId, transform: patch }),
      ];
    }

    case "clip.setFade": {
      const clip = draft.timeline.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === op.clipId);
      if (!clip) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.setFade: clip "${op.clipId}" not found`,
          { clipId: op.clipId },
        );
      }
      for (const [field, value] of [["fadeIn", op.fadeIn], ["fadeOut", op.fadeOut]] as const) {
        if (value !== undefined && value > clip.duration) {
          throw invalidParams(`clip.setFade: ${field} cannot exceed clip duration`, {
            clipId: op.clipId,
            [field]: value,
            duration: clip.duration,
          });
        }
      }
      return [
        makeAction("audio/setFade", {
          clipId: op.clipId,
          ...(op.fadeIn !== undefined ? { fadeIn: op.fadeIn } : {}),
          ...(op.fadeOut !== undefined ? { fadeOut: op.fadeOut } : {}),
        }),
      ];
    }

    case "clip.remove": {
      // Timeline clips only (video/audio/image tracks) — text overlays live
      // in draft.textClips and are removed via text.delete.
      const clip = draft.timeline.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === op.clipId);
      if (!clip) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.remove: clip "${op.clipId}" not found`,
          { clipId: op.clipId },
        );
      }
      // The SAME core action the UI's delete-clip path dispatches
      // (apps/web clip-slice), so model compatibility holds by construction.
      return [makeAction("clip/remove", { clipId: op.clipId })];
    }

    case "transition.add": {
      const trackA = draft.timeline.tracks.find((track) =>
        track.clips.some((clip) => clip.id === op.clipAId),
      );
      const trackB = draft.timeline.tracks.find((track) =>
        track.clips.some((clip) => clip.id === op.clipBId),
      );
      const clipA = trackA?.clips.find((clip) => clip.id === op.clipAId);
      const clipB = trackB?.clips.find((clip) => clip.id === op.clipBId);
      if (!trackA || !clipA) {
        throw new FacadeError(
          "NOT_FOUND",
          `transition.add: outgoing clip "${op.clipAId}" not found`,
          { clipAId: op.clipAId },
        );
      }
      if (!trackB || !clipB) {
        throw new FacadeError(
          "NOT_FOUND",
          `transition.add: incoming clip "${op.clipBId}" not found`,
          { clipBId: op.clipBId },
        );
      }
      if (trackA.id !== trackB.id) {
        throw invalidParams("transition.add: clips must be on the same track", {
          clipAId: op.clipAId,
          clipBId: op.clipBId,
        });
      }
      if (trackA.type === "audio" || trackA.type === "text") {
        throw invalidParams(
          "transition.add: visual transitions require a visual track",
          { trackId: trackA.id, trackType: trackA.type },
        );
      }
      const cutTime = clipA.startTime + clipA.duration;
      if (Math.abs(cutTime - clipB.startTime) >= 0.001) {
        throw invalidParams(
          "transition.add: clipA must end where clipB starts",
          {
            clipAId: op.clipAId,
            clipBId: op.clipBId,
            clipAEnd: cutTime,
            clipBStart: clipB.startTime,
          },
        );
      }
      const existing = (trackA.transitions ?? []).find(
        (transition) =>
          transition.clipAId === op.clipAId &&
          transition.clipBId === op.clipBId &&
          transition.edge === undefined,
      );
      if (existing) {
        throw new FacadeError(
          "CONFLICT",
          "transition.add: this cut already has a transition; update or remove it first",
          { transitionId: existing.id },
        );
      }
      const maxDuration = Math.min(clipA.duration, clipB.duration) * 2;
      if (op.duration > maxDuration) {
        throw invalidParams(
          `transition.add: duration cannot exceed ${maxDuration} seconds for this cut`,
          { duration: op.duration, maxDuration },
        );
      }
      const engine = new TransitionEngine({
        width: draft.settings.width,
        height: draft.settings.height,
        useGPU: false,
      });
      const transition: Transition = {
        id: `transition-${crypto.randomUUID()}`,
        clipAId: op.clipAId,
        clipBId: op.clipBId,
        type: op.type,
        duration: op.duration,
        params: engine.getDefaultParams(op.type),
      };
      return [makeAction("transition/set", { transition })];
    }

    case "transition.update": {
      let ownerTrack: Project["timeline"]["tracks"][number] | undefined;
      let transition: Transition | undefined;
      for (const track of draft.timeline.tracks) {
        const candidate = (track.transitions ?? []).find(
          (item) => item.id === op.transitionId,
        );
        if (candidate) {
          ownerTrack = track;
          transition = candidate;
          break;
        }
      }
      if (!ownerTrack || !transition) {
        throw new FacadeError(
          "NOT_FOUND",
          `transition.update: transition "${op.transitionId}" not found`,
          { transitionId: op.transitionId },
        );
      }
      if (op.duration !== undefined) {
        const clipA = ownerTrack.clips.find(
          (clip) => clip.id === transition?.clipAId,
        );
        const clipB = transition.clipBId
          ? ownerTrack.clips.find((clip) => clip.id === transition?.clipBId)
          : undefined;
        const maxDuration = clipB
          ? Math.min(clipA?.duration ?? 0, clipB.duration) * 2
          : (clipA?.duration ?? 0);
        if (maxDuration <= 0 || op.duration > maxDuration) {
          throw invalidParams(
            `transition.update: duration cannot exceed ${maxDuration} seconds for this placement`,
            { transitionId: op.transitionId, duration: op.duration, maxDuration },
          );
        }
      }
      const engine = new TransitionEngine({
        width: draft.settings.width,
        height: draft.settings.height,
        useGPU: false,
      });
      return [
        makeAction("transition/update", {
          transitionId: op.transitionId,
          ...(op.type !== undefined
            ? { type: op.type, params: engine.getDefaultParams(op.type) }
            : {}),
          ...(op.duration !== undefined ? { duration: op.duration } : {}),
        }),
      ];
    }

    case "transition.remove": {
      const exists = draft.timeline.tracks.some((track) =>
        (track.transitions ?? []).some(
          (transition) => transition.id === op.transitionId,
        ),
      );
      if (!exists) {
        throw new FacadeError(
          "NOT_FOUND",
          `transition.remove: transition "${op.transitionId}" not found`,
          { transitionId: op.transitionId },
        );
      }
      return [
        makeAction("transition/remove", { transitionId: op.transitionId }),
      ];
    }

    case "marker.add": {
      const target = op.target;
      switch (target.kind) {
        case "asset":
          if (
            !draft.mediaLibrary.items.some((item) => item.id === target.mediaId)
          ) {
            throw new FacadeError(
              "NOT_FOUND",
              `marker.add: media "${target.mediaId}" not found`,
              { mediaId: target.mediaId },
            );
          }
          break;
        case "clip":
          if (
            !draft.timeline.tracks.some((track) =>
              track.clips.some((clip) => clip.id === target.clipId),
            )
          ) {
            throw new FacadeError(
              "NOT_FOUND",
              `marker.add: clip "${target.clipId}" not found`,
              { clipId: target.clipId },
            );
          }
          break;
        case "text":
          if (
            !(draft.textClips ?? []).some(
              (clip) => clip.id === target.textClipId,
            )
          ) {
            throw new FacadeError(
              "NOT_FOUND",
              `marker.add: text overlay "${target.textClipId}" not found`,
              { textClipId: target.textClipId },
            );
          }
          break;
        case "timeRange":
          if (target.end < target.start) {
            throw invalidParams(
              "marker.add: target.end must be greater than or equal to target.start",
              { start: target.start, end: target.end },
            );
          }
          break;
      }
      // The number comes from the DRAFT's watermark: ops in one batch are
      // translated and executed sequentially against the same in-flight
      // draft and every applied add raises nextNumber, so N marker.add ops
      // in ONE batch mint N consecutive numbers — identically in headless
      // and live (one translator, one dry-run executor). Removes never free
      // numbers, so no per-batch counter is needed.
      const marker: ProjectMarker = {
        id: `marker-${crypto.randomUUID()}`,
        number: draft.markers?.nextNumber ?? 1,
        target: { ...target },
        ...(op.label !== undefined ? { label: op.label } : {}),
        color: op.color ?? DEFAULT_PROJECT_MARKER_COLOR,
        createdAt: Date.now(),
      };
      return [makeAction("projectMarker/add", { marker })];
    }

    case "marker.remove": {
      const items = draft.markers?.items ?? [];
      const marker = items.find((m) => m.number === op.number);
      if (!marker) {
        const assigned = items.map((m) => m.number).sort((a, b) => a - b);
        throw new FacadeError(
          "NOT_FOUND",
          `marker.remove: no marker with number ${op.number} — assigned marker numbers: ${
            assigned.length > 0 ? assigned.join(", ") : "(none)"
          }`,
          { number: op.number, assignedNumbers: assigned },
        );
      }
      return [makeAction("projectMarker/remove", { markerId: marker.id })];
    }
  }
}
