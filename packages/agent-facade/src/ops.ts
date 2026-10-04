import { verifyReplacementFrames } from "./media/strict-replacement";
import { validateMediaProduction } from "@reelterminal/core/types/media-production";
import type { MediaSetProductionOp } from "./types";
/**
 * The closed edit.apply op set: strict schema validation and translation
 * into core actions. Facade-level semantic checks that the generic core
 * boundary does not own (media bounds, duplicate ids, text-overlay
 * existence, normalized crop bounds) live here so every core action the
 * executor sees is already sane.
 */
import type { Action } from "@reelterminal/core/types/actions";
import type { Project, ProjectMarker } from "@reelterminal/core/types/project";
import { DEFAULT_PROJECT_MARKER_COLOR } from "@reelterminal/core/types/project";
import type { Clip, Transform, Transition } from "@reelterminal/core/types/timeline";
import { TransitionEngine } from "@reelterminal/core/video/transition-engine";
import type { TextClip } from "@reelterminal/core/text/types";
import { parseSRT } from "@reelterminal/core/text/subtitle-engine";
import {
  DEFAULT_GRAPHIC_TRANSFORM,
  DEFAULT_SVG_COLOR_STYLE,
  type SVGClip,
  type ViewBox,
} from "@reelterminal/core/graphics/types";
import {
  DEFAULT_TEXT_STYLE,
  DEFAULT_TEXT_TRANSFORM,
} from "@reelterminal/core/text/types";
import { FacadeError } from "./errors";
import { invalidParams } from "./validate";
import {
  isNonEmptyString,
  isNonNegativeInteger,
  isNonNegativeNumber,
  isPlainObject,
  isPositiveInteger,
  isPositiveNumber,
  isBoolean,
  isFiniteNumber,
  isString,
  oneOf,
  validateObject,
  type FieldEmits,
  type ObjectSchema,
} from "./validate";
import {
  EDIT_OP_TYPES,
  EDIT_TRANSITION_TYPES,
  TRACK_TYPES,
  CLIP_VIDEO_EFFECT_TYPES,
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
  type SvgCreateOp,
  type SvgUpdateOp,
  type SvgRemoveOp,
  type TrackAddOp,
  type TrackUpdateOp,
  type TrackRemoveOp,
  type MediaRemoveOp,
  type MarkerAddOp,
  type MarkerRemoveOp,
  type RequirementUpdateOp,
  type TransitionAddOp,
  type TransitionRemoveOp,
  type TransitionUpdateOp,
  type SubtitleImportSrtOp,
  type ClipSetColorGradeOp,
  type ClipSetKeyframesOp,
  type ClipApplyReframeOp,
  type FacadeKeyframeInput,
  type ReferenceSetComparisonOp,
  type ReferenceClearComparisonOp,
  type MediaReplaceOp,
  type MediaRelinkOp,
  type MediaRenameOp,
  type ClipSetChromaKeyOp,
  type ClipSetNoiseReductionOp,
  type ClipSetDuckingOp,
  type ClipSetBackgroundRemovalOp,
  type ClipAddVideoEffectOp,
  type ClipVideoEffectType,
  type WorkAssetCaptureOp,
  type WorkAssetRenameOp,
  type WorkAssetDeleteOp,
  type WorkAssetInstantiateOp,
} from "./types";
import { validateReferenceComparisonConfig } from "@reelterminal/core/types/reference-comparison";
import { DEFAULT_CHROMA_KEY_SETTINGS } from "@reelterminal/core/video/chroma-key-engine";
import { DEFAULT_BACKGROUND_SETTINGS } from "@reelterminal/core/ai/background-removal-engine";
import { reframeKeyframesToTransformKeyframes } from "@reelterminal/core/ai/auto-reframe-engine";
import {
  DEFAULT_NOISE_REDUCTION_SETTINGS,
  getNoiseReductionPreset,
  NOISE_REDUCTION_FOCUS_OPTIONS,
} from "@reelterminal/core/audio/noise-reduction-presets";
import { isSerializedNoiseProfile } from "@reelterminal/core/audio/audio-effect-routing";
import { generateDuckingKeyframesFromRanges } from "@reelterminal/core/audio/volume-automation";
import { resolveAudibleAudioTarget } from "@reelterminal/core/audio/clip-audio-resolution";
import { getMotionShaderEffectDefs } from "@reelterminal/core/motion/shaders";
import {
  captureWorkAssetFromClip,
  captureWorkAssetFromClips,
} from "@reelterminal/core/work-assets/capture";
import { buildWorkAssetInstantiateActions } from "@reelterminal/core/work-assets/instantiate";
import { WORK_ASSET_MAX_MEMBERS } from "@reelterminal/core/types/work-asset";
import { timelineDurationSec } from "./projection";
import { basename } from "node:path";
import { resolveContainedPathDetailed } from "./media/path-roots";

/* ------------------------------------------------------------------ */
/* Strict op validation                                                */
/* ------------------------------------------------------------------ */

/**
 * These declarations define the closed edit.apply op set. The runtime
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
  position: {
    check: isNonNegativeInteger,
    describe: "a non-negative integer — zero-based z-order insertion index in project.timeline.tracks (later tracks composite on top); omit to append on top",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
};

export const TRACK_UPDATE_SCHEMA: ObjectSchema = {
  op: {
    check: (value) => value === "track.update",
    describe: '"track.update"',
    required: true,
    emits: { kind: "leaf", schema: { const: "track.update" } },
  },
  trackId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  name: {
    check: (value) =>
      typeof value === "string" && value.trim().length > 0 && value.length <= 120,
    describe: "a non-empty track name of at most 120 characters",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  locked: {
    check: isBoolean,
    describe: "a boolean",
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
  hidden: {
    check: isBoolean,
    describe: "a boolean",
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
  muted: {
    check: isBoolean,
    describe: "a boolean",
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
  solo: {
    check: isBoolean,
    describe: "a boolean",
    emits: { kind: "leaf", schema: { type: "boolean" } },
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

export const SVG_CREATE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "svg.create",
    describe: '"svg.create"',
    required: true,
    emits: { kind: "leaf", schema: { const: "svg.create" } },
  },
  // Only string constraints here — the content policy (scripts, foreign
  // objects, event handlers, unsafe schemes, external references, size) is
  // owned by the shared core ingest gate that the svg/create action handler
  // runs on every apply.
  svgContent: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a non-empty string of inline SVG markup",
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
    required: true,
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
  trackId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
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

export const SVG_UPDATE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "svg.update",
    describe: '"svg.update"',
    required: true,
    emits: { kind: "leaf", schema: { const: "svg.update" } },
  },
  // The id surfaced by timeline.query as an svg entity.
  overlayId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  svgContent: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a non-empty string of inline SVG markup",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
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

export const SVG_REMOVE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "svg.remove",
    describe: '"svg.remove"',
    required: true,
    emits: { kind: "leaf", schema: { const: "svg.remove" } },
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

const isRequirementResultMediaIds = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length <= 100 &&
  value.every((item) => typeof item === "string" && item.length > 0);

export const REQUIREMENT_UPDATE_SCHEMA: ObjectSchema = {
  op: {
    check: (value) => value === "requirement.update",
    describe: '"requirement.update"',
    required: true,
    emits: { kind: "leaf", schema: { const: "requirement.update" } },
  },
  requirementId: {
    check: isNonEmptyString,
    describe: "a requirement ref such as Q3 or an internal requirement id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  status: {
    check: oneOf(["draft", "ready", "in_progress", "blocked", "review", "done"]),
    describe: "draft, ready, in_progress, blocked, review (awaiting user acceptance), or done",
    emits: { kind: "leaf", schema: { enum: ["draft", "ready", "in_progress", "blocked", "review", "done"] } },
  },
  agentNote: {
    check: (value) => typeof value === "string" && value.length <= 10_000,
    describe: "a string of at most 10000 characters",
    emits: { kind: "leaf", schema: { type: "string" } },
  },
  resultMediaIds: {
    check: isRequirementResultMediaIds,
    describe: "an array of at most 100 project media ids",
    emits: {
      kind: "array",
      maxItems: 100,
      items: { kind: "leaf", schema: { type: "string", minLength: 1 } },
    },
  },
};

/** The 200-character name cap is validation-only (not emitted). */
const isWorkAssetName = (v: unknown): boolean =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 200;

/**
 * Multi capture set: 2..64 unique non-empty clip ids. The 64 cap and the
 * uniqueness requirement are validation-only (not emitted) — the emitted
 * schema is the boundary superset (array of ≥2 strings); core enforces the
 * same caps authoritatively at capture time.
 */
const isWorkAssetClipIdSet = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.length >= 2 &&
  v.length <= WORK_ASSET_MAX_MEMBERS &&
  v.every((id) => isNonEmptyString(id)) &&
  new Set(v).size === v.length;

export const WORK_ASSET_CAPTURE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "workAsset.capture",
    describe: '"workAsset.capture"',
    required: true,
    emits: { kind: "leaf", schema: { const: "workAsset.capture" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe:
      "a non-empty string — single-clip form; exactly one of clipId / clipIds must be given",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  clipIds: {
    check: isWorkAssetClipIdSet,
    describe:
      "2..64 unique non-empty clip ids — multi-clip form captured as ONE kind:\"multi\" asset; exactly one of clipId / clipIds must be given",
    emits: {
      kind: "array",
      items: { kind: "leaf", schema: { type: "string", minLength: 1 } },
      minItems: 2,
    },
  },
  name: {
    check: isWorkAssetName,
    describe: "a non-empty string of at most 200 characters",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  captureRequestId: {
    check: isNonEmptyString,
    describe: "a non-empty string echoed onto the asset for traceability",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const WORK_ASSET_RENAME_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "workAsset.rename",
    describe: '"workAsset.rename"',
    required: true,
    emits: { kind: "leaf", schema: { const: "workAsset.rename" } },
  },
  workAssetId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  name: {
    check: isWorkAssetName,
    describe: "a non-empty string of at most 200 characters",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const WORK_ASSET_DELETE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "workAsset.delete",
    describe: '"workAsset.delete"',
    required: true,
    emits: { kind: "leaf", schema: { const: "workAsset.delete" } },
  },
  workAssetId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const WORK_ASSET_INSTANTIATE_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "workAsset.instantiate",
    describe: '"workAsset.instantiate"',
    required: true,
    emits: { kind: "leaf", schema: { const: "workAsset.instantiate" } },
  },
  workAssetId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  trackId: {
    check: isNonEmptyString,
    describe:
      "a non-empty string — existing lane matching the source media's type (multi assets: binds the anchor lane only; every other lane is created fresh)",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  startTime: {
    check: isNonNegativeNumber,
    describe:
      "a finite number >= 0 (timeline seconds; defaults to the timeline end; multi assets: the anchor time T0 the relative member layout starts from)",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
};

export const SUBTITLE_IMPORT_SRT_SCHEMA: ObjectSchema = {
  op: {
    check: (value) => value === "subtitle.importSrt",
    describe: '"subtitle.importSrt"',
    required: true,
    emits: { kind: "leaf", schema: { const: "subtitle.importSrt" } },
  },
  srtContent: {
    check: (value) =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      new TextEncoder().encode(value).byteLength <= 256 * 1024,
    describe: "non-empty SRT text of at most 256 KiB",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

const isColorTemperature = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= -100 && value <= 100;

export const CLIP_SET_COLOR_GRADE_SCHEMA: ObjectSchema = {
  op: {
    check: (value) => value === "clip.setColorGrade",
    describe: '"clip.setColorGrade"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.setColorGrade" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  temperature: {
    check: isColorTemperature,
    describe: "a finite number in [-100, 100]",
    emits: { kind: "leaf", schema: { type: "number", minimum: -100, maximum: 100 } },
  },
  tint: {
    check: isColorTemperature,
    describe: "a finite number in [-100, 100]",
    emits: { kind: "leaf", schema: { type: "number", minimum: -100, maximum: 100 } },
  },
  clear: {
    check: (value) => value === true,
    describe: "true",
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
};

const KEYFRAME_PROPERTIES = [
  "opacity",
  "position.x",
  "position.y",
  "scale.x",
  "scale.y",
  "rotation",
] as const;

const KEYFRAME_EASINGS = [
  "linear",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "hold",
  "smoothstep",
  "smootherstep",
] as const;

export const FACADE_KEYFRAME_SCHEMA: ObjectSchema = {
  property: {
    check: oneOf(KEYFRAME_PROPERTIES),
    describe: "a renderer-supported transform/opacity keyframe property",
    required: true,
    emits: { kind: "leaf", schema: { enum: KEYFRAME_PROPERTIES } },
  },
  time: {
    check: isNonNegativeNumber,
    describe: "a non-negative clip-local time",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  value: {
    check: isFiniteNumber,
    describe: "a finite numeric value",
    required: true,
    emits: { kind: "leaf", schema: { type: "number" } },
  },
  easing: {
    check: oneOf(KEYFRAME_EASINGS),
    describe: "a supported easing",
    emits: { kind: "leaf", schema: { enum: KEYFRAME_EASINGS } },
  },
};

export const REFERENCE_COMPARISON_CONFIG_SCHEMA: ObjectSchema = {
  referenceMediaId: {
    check: isNonEmptyString,
    describe: "a non-empty project media id (the reference source)",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  refStartSec: {
    check: isNonNegativeNumber,
    describe: "reference in-point (seconds) aligned to timelineStartSec",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  refEndSec: {
    check: isNonNegativeNumber,
    describe: "reference out-point (seconds); beyond it comparisons clamp onto the last frame and say so",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  timelineStartSec: {
    check: isNonNegativeNumber,
    describe: "timeline time (seconds) aligned to refStartSec",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  rate: {
    check: (v) => v === 1,
    describe: "exactly 1 — only constant-rate mapping with a start offset is supported",
    required: true,
    emits: { kind: "leaf", schema: { enum: [1] } },
  },
  audioSide: {
    check: oneOf(["timeline", "reference", "none"]),
    describe: "which side's audio the comparison uses — exactly one side, never both",
    required: true,
    emits: { kind: "leaf", schema: { enum: ["timeline", "reference", "none"] } },
  },
  layout: {
    check: oneOf(["side-by-side", "overlay"]),
    describe: "side-by-side (left reference / right timeline) or transparent overlay",
    required: true,
    emits: { kind: "leaf", schema: { enum: ["side-by-side", "overlay"] } },
  },
  overlayOpacity: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1,
    describe: "overlay layout only: reference opacity over the timeline frame, in (0, 1]",
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0, maximum: 1 } },
  },
};

export const MEDIA_REPLACE_SCHEMA: ObjectSchema = {
  preserveFrames: { check: isBoolean, describe: "Require equal decoded frame counts and verified CFR rate; preserve all clip timing", emits: { kind: "leaf", schema: { type: "boolean" } } },
  op: {
    check: (value) => value === "media.replace",
    describe: '"media.replace"',
    required: true,
    emits: { kind: "leaf", schema: { const: "media.replace" } },
  },
  mediaId: {
    check: isNonEmptyString,
    describe: "the media item whose source the references switch away from",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  filePath: {
    check: isNonEmptyString,
    describe: "absolute path of the new production version, inside a configured media root",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  scope: {
    check: oneOf(["project", "clip"]),
    describe: '"project" repoints every clip referencing mediaId; "clip" only the clip named by clipId',
    required: true,
    emits: { kind: "leaf", schema: { enum: ["project", "clip"] } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "required when scope is clip: the single clip to repoint",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const MEDIA_RELINK_SCHEMA: ObjectSchema = {
  op: {
    check: (value) => value === "media.relink",
    describe: '"media.relink"',
    required: true,
    emits: { kind: "leaf", schema: { const: "media.relink" } },
  },
  mediaId: {
    check: isNonEmptyString,
    describe: "the media item whose source file moved",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  filePath: {
    check: isNonEmptyString,
    describe: "absolute path of the SAME content at its new location, inside a configured media root",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const MEDIA_PRODUCTION_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "media.setProduction",
    describe: "media.setProduction",
    required: true,
    emits: { kind: "leaf", schema: { const: "media.setProduction" } },
  },
  mediaId: {
    check: isNonEmptyString,
    describe: "Project media version",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  production: {
    check: (v) => validateMediaProduction(v) === null,
    describe:
      "Candidate status (pending/adopted/rejected), notes, and steps: operation (original/generation/redraw/composite/resize/modelEnhancement), tool, optional model, inputMediaIds, optional zero-based half-open source-frame range. modelEnhancement requires model. Declaration only; does not run a backend or change timeline references.",
    required: true,
    emits: {
      kind: "leaf",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["status", "notes", "steps"],
        properties: {
          status: { enum: ["pending", "adopted", "rejected"] },
          notes: { type: "string", maxLength: 4000 },
          steps: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["operation", "tool", "inputMediaIds"],
              properties: {
                operation: {
                  enum: [
                    "original",
                    "generation",
                    "redraw",
                    "composite",
                    "resize",
                    "modelEnhancement",
                  ],
                },
                tool: { type: "string", minLength: 1, maxLength: 200 },
                model: { type: "string", minLength: 1, maxLength: 200 },
                inputMediaIds: {
                  type: "array",
                  maxItems: 100,
                  items: { type: "string", minLength: 1 },
                },
                range: {
                  type: "object",
                  additionalProperties: false,
                  required: ["startFrame", "endFrame"],
                  properties: {
                    startFrame: { type: "integer", minimum: 0 },
                    endFrame: { type: "integer", minimum: 1 },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

export const MEDIA_RENAME_SCHEMA: ObjectSchema = {
  op: {
    check: (value) => value === "media.rename",
    describe: '"media.rename"',
    required: true,
    emits: { kind: "leaf", schema: { const: "media.rename" } },
  },
  mediaId: {
    check: isNonEmptyString,
    describe: "the media item to rename",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  displayName: {
    check: (value) =>
      typeof value === "string" && value.trim().length > 0 && value.length <= 120,
    describe:
      "new display name, 1-120 characters (trimmed); the source filename and the file on disk are never changed",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: 120 } },
  },
};

export const REFERENCE_SET_COMPARISON_SCHEMA: ObjectSchema = {
  op: {
    check: (value) => value === "reference.setComparison",
    describe: '"reference.setComparison"',
    required: true,
    emits: { kind: "leaf", schema: { const: "reference.setComparison" } },
  },
  config: {
    check: isPlainObject,
    describe: "the shared reference-comparison configuration",
    required: true,
    emits: { kind: "object", schema: REFERENCE_COMPARISON_CONFIG_SCHEMA },
  },
};

export const REFERENCE_CLEAR_COMPARISON_SCHEMA: ObjectSchema = {
  op: {
    check: (value) => value === "reference.clearComparison",
    describe: '"reference.clearComparison"',
    required: true,
    emits: { kind: "leaf", schema: { const: "reference.clearComparison" } },
  },
};

export const CLIP_SET_KEYFRAMES_SCHEMA: ObjectSchema = {
  op: {
    check: (value) => value === "clip.setKeyframes",
    describe: '"clip.setKeyframes"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.setKeyframes" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  keyframes: {
    check: (value) => Array.isArray(value) && value.length <= 100,
    describe: "an array of at most 100 keyframes",
    required: true,
    emits: {
      kind: "array",
      maxItems: 100,
      items: { kind: "anyOfObjects", variants: [FACADE_KEYFRAME_SCHEMA] },
    },
  },
};

/** One source-space crop rectangle of an Auto Reframe plan. */
const REFRAME_CROP_KEYFRAME_SCHEMA: ObjectSchema = {
  time: {
    check: isNonNegativeNumber,
    describe:
      "a non-negative source-analysis time in seconds (from the clip in-point)",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  cropX: {
    check: isNonNegativeNumber,
    describe: "a non-negative pixel offset",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  cropY: {
    check: isNonNegativeNumber,
    describe: "a non-negative pixel offset",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  cropWidth: {
    check: isPositiveNumber,
    describe: "a positive pixel width",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
  cropHeight: {
    check: isPositiveNumber,
    describe: "a positive pixel height",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
};

/**
 * Relative tolerance for clip.applyReframe crop-vs-output aspect-ratio
 * drift (|cropRatio − outputRatio| / outputRatio). The conversion fills the
 * canvas exactly only when every crop keeps the output ratio; the analysis
 * path guarantees it up to per-pixel rounding, so hand-written plans get a
 * tight ±2% band instead of a schema-level ratio constraint (the op's
 * internal callers always satisfy it).
 */
const REFRAME_CROP_RATIO_TOLERANCE = 0.02;

export const CLIP_APPLY_REFRAME_SCHEMA: ObjectSchema = {
  op: {
    check: (value) => value === "clip.applyReframe",
    describe: '"clip.applyReframe"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.applyReframe" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  keyframes: {
    check: (value) =>
      Array.isArray(value) && value.length > 0 && value.length <= 100,
    describe: "a non-empty array of at most 100 crop keyframes",
    required: true,
    emits: {
      kind: "array",
      minItems: 1,
      maxItems: 100,
      items: { kind: "object", schema: REFRAME_CROP_KEYFRAME_SCHEMA },
    },
  },
  outputWidth: {
    check: isPositiveInteger,
    describe: "a positive integer (project canvas width in pixels)",
    required: true,
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
  outputHeight: {
    check: isPositiveInteger,
    describe: "a positive integer (project canvas height in pixels)",
    required: true,
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
};

const CHROMA_KEY_COLOR_SCHEMA: ObjectSchema = {
  r: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1,
    describe: "a finite number in [0, 1]",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
  g: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1,
    describe: "a finite number in [0, 1]",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
  b: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1,
    describe: "a finite number in [0, 1]",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
};

const isUnitRange = (v: unknown): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

export const CLIP_SET_CHROMA_KEY_SCHEMA: ObjectSchema = {
  op: {
    check: (value) => value === "clip.setChromaKey",
    describe: '"clip.setChromaKey"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.setChromaKey" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  enabled: {
    check: isBoolean,
    describe: "a boolean",
    required: true,
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
  keyColor: {
    check: isPlainObjectValue,
    describe: "an object",
    emits: { kind: "object", schema: CHROMA_KEY_COLOR_SCHEMA },
  },
  tolerance: {
    check: isUnitRange,
    describe: "a finite number in [0, 1]",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
  edgeSoftness: {
    check: isUnitRange,
    describe: "a finite number in [0, 1]",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
  spillSuppression: {
    check: isUnitRange,
    describe: "a finite number in [0, 1]",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
};

/** Upper bound on per-array profile bins (FFT 32768 → 16384 bins). */
const NOISE_REDUCTION_PROFILE_MAX_BINS = 16384;

const isFiniteArrayBounded = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.length <= NOISE_REDUCTION_PROFILE_MAX_BINS &&
  v.every((entry) => typeof entry === "number" && Number.isFinite(entry));

const isPositiveFiniteNumber = (v: unknown): boolean =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

const NOISE_REDUCTION_PROFILE_SCHEMA: ObjectSchema = {
  frequencyBins: {
    check: isFiniteArrayBounded,
    describe: `a non-empty array of at most ${NOISE_REDUCTION_PROFILE_MAX_BINS} finite numbers`,
    required: true,
    emits: {
      kind: "array",
      minItems: 1,
      maxItems: NOISE_REDUCTION_PROFILE_MAX_BINS,
      items: { kind: "leaf", schema: { type: "number" } },
    },
  },
  magnitudes: {
    check: isFiniteArrayBounded,
    describe: `a non-empty array of at most ${NOISE_REDUCTION_PROFILE_MAX_BINS} finite numbers`,
    required: true,
    emits: {
      kind: "array",
      minItems: 1,
      maxItems: NOISE_REDUCTION_PROFILE_MAX_BINS,
      items: { kind: "leaf", schema: { type: "number" } },
    },
  },
  standardDeviations: {
    check: isFiniteArrayBounded,
    describe: `a non-empty array of at most ${NOISE_REDUCTION_PROFILE_MAX_BINS} finite numbers`,
    emits: {
      kind: "array",
      minItems: 1,
      maxItems: NOISE_REDUCTION_PROFILE_MAX_BINS,
      items: { kind: "leaf", schema: { type: "number" } },
    },
  },
  sampleRate: {
    check: isPositiveFiniteNumber,
    describe: "a positive finite number",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
  fftSize: {
    check: isPositiveInteger,
    describe: "a positive integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
};

export const CLIP_SET_NOISE_REDUCTION_SCHEMA: ObjectSchema = {
  op: {
    check: (value) => value === "clip.setNoiseReduction",
    describe: '"clip.setNoiseReduction"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.setNoiseReduction" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  enabled: {
    check: isBoolean,
    describe: "a boolean",
    required: true,
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
  preset: {
    check: oneOf(NOISE_REDUCTION_FOCUS_OPTIONS),
    describe: `one of ${NOISE_REDUCTION_FOCUS_OPTIONS.join(", ")}`,
    emits: { kind: "leaf", schema: { enum: [...NOISE_REDUCTION_FOCUS_OPTIONS] } },
  },
  threshold: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= -80 && v <= 0,
    describe: "a finite number in [-80, 0] (dB)",
    emits: { kind: "leaf", schema: { type: "number", minimum: -80, maximum: 0 } },
  },
  reduction: {
    check: isUnitRange,
    describe: "a finite number in [0, 1]",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
  attack: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100,
    describe: "a finite number in [0, 100] (ms)",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 100 } },
  },
  release: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 500,
    describe: "a finite number in [0, 500] (ms)",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 500 } },
  },
  profile: {
    check: isPlainObjectValue,
    describe: "an object",
    emits: { kind: "object", schema: NOISE_REDUCTION_PROFILE_SCHEMA },
  },
};

/**
 * Rebind nested style/position/anchor to SANITIZED copies: opToCoreActions
 * spreads them into the canonical TextClip, so what flows downstream must be
 * the fresh validated objects — never the raw nested caller objects (whose
 * getters could yield different values post-validation).
 */

/** Upper bound on ducking points / presence ranges per op (envelope output). */
const DUCKING_MAX_POINTS = 512;
const DUCKING_MAX_RANGES = 1024;

const isFiniteNonNegative = (v: unknown): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

const DUCKING_POINT_SCHEMA: ObjectSchema = {
  time: {
    check: isFiniteNonNegative,
    describe: "a finite number >= 0 (clip-relative seconds)",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  value: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 4,
    describe: "a finite number in [0, 4]",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 4 } },
  },
};

const DUCKING_PRESENCE_RANGE_SCHEMA: ObjectSchema = {
  start: {
    check: isFiniteNonNegative,
    describe: "a finite number >= 0 (clip-relative seconds)",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  end: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
    describe: "a finite number > start (clip-relative seconds)",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
};

export const CLIP_SET_DUCKING_SCHEMA: ObjectSchema = {
  op: {
    check: (value) => value === "clip.setDucking",
    describe: '"clip.setDucking"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.setDucking" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  threshold: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= -60 && v <= 0,
    describe: "a finite number in [-60, 0] (dB)",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: -60, maximum: 0 } },
  },
  reduction: {
    check: isUnitRange,
    describe: "a finite number in [0, 1]",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
  attack: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1,
    describe: "a finite number in [0, 1] (seconds)",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
  release: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 2,
    describe: "a finite number in [0, 2] (seconds)",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 2 } },
  },
  holdTime: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1,
    describe: "a finite number in [0, 1] (seconds)",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
  points: {
    check: (v) =>
      Array.isArray(v) &&
      v.length >= 1 &&
      v.length <= DUCKING_MAX_POINTS,
    describe: `an array of 1-${DUCKING_MAX_POINTS} ducking keyframes (or pass presenceRanges instead)`,
    emits: {
      kind: "array",
      minItems: 1,
      maxItems: DUCKING_MAX_POINTS,
      items: { kind: "object", schema: DUCKING_POINT_SCHEMA },
    },
  },
  presenceRanges: {
    check: (v) =>
      Array.isArray(v) &&
      v.length >= 1 &&
      v.length <= DUCKING_MAX_RANGES,
    describe: `an array of 1-${DUCKING_MAX_RANGES} speech-active ranges (or pass points instead)`,
    emits: {
      kind: "array",
      minItems: 1,
      maxItems: DUCKING_MAX_RANGES,
      items: { kind: "object", schema: DUCKING_PRESENCE_RANGE_SCHEMA },
    },
  },
};

/** GUI sliders and the shared engine defaults bound these matte values. */
const BACKGROUND_MODES = ["blur", "color", "image", "video", "transparent"] as const;

const isCssHexColor = (v: unknown): boolean =>
  typeof v === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v);

const isBoundedUrlString = (v: unknown): boolean =>
  typeof v === "string" && v.length > 0 && v.length <= 2048;

export const CLIP_SET_BACKGROUND_REMOVAL_SCHEMA: ObjectSchema = {
  op: {
    check: (value) => value === "clip.setBackgroundRemoval",
    describe: '"clip.setBackgroundRemoval"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.setBackgroundRemoval" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  enabled: {
    check: isBoolean,
    describe: "a boolean",
    required: true,
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
  mode: {
    check: oneOf(BACKGROUND_MODES),
    describe: `one of ${BACKGROUND_MODES.join(", ")}`,
    emits: { kind: "leaf", schema: { enum: [...BACKGROUND_MODES] } },
  },
  blurAmount: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 50,
    describe: "a finite number in [0, 50] (px)",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 50 } },
  },
  backgroundColor: {
    // Runtime authority is isCssHexColor (hex-only, validated at this
    // boundary). The emitted JSON-schema leaf vocabulary has no `pattern`,
    // so the schema is a boundary superset here — the ordering-pin corpus
    // case pins the divergence (schema-valid, facade-rejected).
    check: isCssHexColor,
    describe: "a hex color string (#RGB, #RGBA, #RRGGBB or #RRGGBBAA)",
    emits: { kind: "leaf", schema: { type: "string", minLength: 2, maxLength: 9 } },
  },
  backgroundImageUrl: {
    check: isBoundedUrlString,
    describe: "a non-empty URL string (at most 2048 chars)",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: 2048 } },
  },
  backgroundVideoUrl: {
    check: isBoundedUrlString,
    describe: "a non-empty URL string (at most 2048 chars)",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: 2048 } },
  },
  edgeBlur: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10,
    describe: "a finite number in [0, 10] (px)",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 10 } },
  },
  threshold: {
    check: isUnitRange,
    describe: "a finite number in [0, 1]",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
};

/* ------------------------------------------------------------------ */
/* clip.addVideoEffect — the clip video-effect stack's add entry       */
/* ------------------------------------------------------------------ */

/**
 * Per-effect-type parameter rules for clip.addVideoEffect. Keys and ranges
 * mirror the GUI inspector's effect sliders (VideoEffectsSection) — the same
 * bounds the GUI enforces when a human drags them — plus the parameter keys
 * the core video effects engine consumes. The "shader" type validates
 * against the core motion shader library's own parameter definitions (the
 * very module the GUI shader controls render from), so a shader parameter
 * can never drift from what the engine reads.
 *
 * `Auto-Color` in the GUI is a FIXED PRESET on top of this op vocabulary —
 * three effects with constant parameters (saturation 1.15, contrast 1.1,
 * brightness 5), no image analysis anywhere.
 */
type EffectParamRule =
  | { readonly kind: "number"; readonly min: number; readonly max: number }
  | { readonly kind: "boolean" }
  | { readonly kind: "string"; readonly maxLength: number }
  | { readonly kind: "hexColor" }
  | { readonly kind: "rgb01" };

const EFFECT_PARAM_RULES: Readonly<
  Record<ClipVideoEffectType, Readonly<Record<string, EffectParamRule>>>
> = {
  brightness: { value: { kind: "number", min: -100, max: 100 } },
  contrast: { value: { kind: "number", min: 0, max: 2 } },
  saturation: { value: { kind: "number", min: 0, max: 2 } },
  grayscale: { amount: { kind: "number", min: 0, max: 1 } },
  sepia: { amount: { kind: "number", min: 0, max: 1 } },
  invert: { amount: { kind: "number", min: 0, max: 1 } },
  hue: { rotation: { kind: "number", min: -360, max: 360 } },
  blur: { radius: { kind: "number", min: 0, max: 100 } },
  sharpen: {
    amount: { kind: "number", min: 0, max: 200 },
    radius: { kind: "number", min: 0.1, max: 10 },
  },
  vignette: {
    amount: { kind: "number", min: 0, max: 100 },
    midpoint: { kind: "number", min: 0, max: 1 },
    feather: { kind: "number", min: 0, max: 1 },
  },
  grain: {
    amount: { kind: "number", min: 0, max: 100 },
    size: { kind: "number", min: 0.5, max: 5 },
    roughness: { kind: "number", min: 0, max: 1 },
    colored: { kind: "boolean" },
  },
  temperature: { value: { kind: "number", min: -100, max: 100 } },
  tint: { value: { kind: "number", min: -100, max: 100 } },
  tonal: {
    shadows: { kind: "number", min: -100, max: 100 },
    midtones: { kind: "number", min: -100, max: 100 },
    highlights: { kind: "number", min: -100, max: 100 },
  },
  chromaKey: {
    keyColor: { kind: "rgb01" },
    tolerance: { kind: "number", min: 0, max: 1 },
    edgeSoftness: { kind: "number", min: 0, max: 1 },
    spillSuppression: { kind: "number", min: 0, max: 1 },
  },
  shadow: {
    offsetX: { kind: "number", min: -100, max: 100 },
    offsetY: { kind: "number", min: -100, max: 100 },
    blur: { kind: "number", min: 0, max: 100 },
    opacity: { kind: "number", min: 0, max: 1 },
    color: { kind: "hexColor" },
  },
  glow: {
    radius: { kind: "number", min: 0, max: 100 },
    intensity: { kind: "number", min: 0, max: 3 },
    color: { kind: "hexColor" },
  },
  "motion-blur": {
    angle: { kind: "number", min: 0, max: 360 },
    distance: { kind: "number", min: 0, max: 100 },
  },
  "radial-blur": {
    amount: { kind: "number", min: 0, max: 100 },
    centerX: { kind: "number", min: 0, max: 100 },
    centerY: { kind: "number", min: 0, max: 100 },
  },
  "chromatic-aberration": {
    amount: { kind: "number", min: 0, max: 50 },
    angle: { kind: "number", min: 0, max: 360 },
  },
  shader: { shaderId: { kind: "string", maxLength: 64 } },
};

/** Upper bound on parameter keys per effect (every GUI slider set fits). */
const MAX_EFFECT_PARAMS = 24;

const isEffectParamsShape = (v: unknown): boolean =>
  isPlainObjectValue(v) &&
  Object.keys(v as Record<string, unknown>).length <= MAX_EFFECT_PARAMS &&
  Object.values(v as Record<string, unknown>).every(
    (value) =>
      typeof value === "boolean" ||
      (typeof value === "string" && value.length <= 256) ||
      (typeof value === "number" && Number.isFinite(value)),
  );

const effectParamCheck = (rule: EffectParamRule) => (v: unknown): boolean => {
  switch (rule.kind) {
    case "number":
      return typeof v === "number" && Number.isFinite(v) && v >= rule.min && v <= rule.max;
    case "boolean":
      return isBoolean(v);
    case "string":
      return typeof v === "string" && v.length > 0 && v.length <= rule.maxLength;
    case "hexColor":
      return isCssHexColor(v);
    case "rgb01":
      return (
        isPlainObjectValue(v) &&
        Object.values(v as Record<string, unknown>).every(isUnitRange)
      );
  }
};

const effectParamEmits = (rule: EffectParamRule): FieldEmits => {
  switch (rule.kind) {
    case "number":
      return {
        kind: "leaf",
        schema: { type: "number", minimum: rule.min, maximum: rule.max },
      };
    case "boolean":
      return { kind: "leaf", schema: { type: "boolean" } };
    case "string":
      return {
        kind: "leaf",
        schema: { type: "string", minLength: 1, maxLength: rule.maxLength },
      };
    case "hexColor":
      // The emitted leaf vocabulary has no `pattern`; the boundary stays the
      // hex authority (same superset ordering as backgroundColor above).
      return { kind: "leaf", schema: { type: "string", minLength: 2, maxLength: 9 } };
    case "rgb01":
      return { kind: "object", schema: CHROMA_KEY_COLOR_SCHEMA };
  }
};

/**
 * Shader parameter rules straight from the core motion shader library's
 * effect-category definitions (builtin set — project-generated shaders are
 * a GUI-session concept and are not addressable through this closed schema).
 */
const SHADER_PARAM_RULES: Readonly<Record<string, EffectParamRule>> =
  Object.fromEntries(
    getMotionShaderEffectDefs().flatMap((def) =>
      def.params.map((param): [string, EffectParamRule] => [
        param.name,
        param.type === "number"
          ? { kind: "number", min: param.min, max: param.max }
          : { kind: "hexColor" },
      ]),
    ),
  );

/**
 * The EMITTED params schema: closed union of every key any effect type (or
 * builtin effect shader) accepts, each bounded by its widest declared range.
 * Deliberately a SUPERSET across types — which keys are legal for WHICH
 * effectType is a cross-field predicate the emitted vocabulary cannot
 * express, so the per-type table in validateAddVideoEffectParams stays the
 * runtime authority (the same schema-valid-but-facade-rejected ordering the
 * corpus pins elsewhere).
 */
const EFFECT_PARAM_BUNDLE_SCHEMA: ObjectSchema = (() => {
  const merged = new Map<string, EffectParamRule>();
  const merge = (key: string, rule: EffectParamRule): void => {
    const existing = merged.get(key);
    if (
      existing &&
      existing.kind === "number" &&
      rule.kind === "number"
    ) {
      merged.set(key, {
        kind: "number",
        min: Math.min(existing.min, rule.min),
        max: Math.max(existing.max, rule.max),
      });
      return;
    }
    merged.set(key, rule);
  };
  for (const rules of Object.values(EFFECT_PARAM_RULES)) {
    for (const [key, rule] of Object.entries(rules)) merge(key, rule);
  }
  for (const [key, rule] of Object.entries(SHADER_PARAM_RULES)) merge(key, rule);
  return Object.fromEntries(
    [...merged.entries()].map(([key, rule]) => [
      key,
      { check: effectParamCheck(rule), describe: effectParamDescribe(rule), emits: effectParamEmits(rule) },
    ]),
  );
})();

function effectParamDescribe(rule: EffectParamRule): string {
  switch (rule.kind) {
    case "number":
      return `a finite number in [${rule.min}, ${rule.max}]`;
    case "boolean":
      return "a boolean";
    case "string":
      return `a non-empty string of at most ${rule.maxLength} chars`;
    case "hexColor":
      return "a hex color string (#RGB, #RGBA, #RRGGBB or #RRGGBBAA)";
    case "rgb01":
      return "an object with r/g/b channels each in [0, 1]";
  }
}

/**
 * Per-type parameter authority for clip.addVideoEffect: keys are closed to
 * the addressed effect's contract and values to its bounds (rejected, never
 * clamped); shader effects resolve their parameter contract from the same
 * core shader definition the GUI renders with. Runs at the validateEditOp
 * boundary AFTER the top-level schema (which has already shape-checked the
 * bundle) — this refinement is validation-only and deliberately NOT emitted.
 */
function validateAddVideoEffectParams(
  effectType: ClipVideoEffectType,
  params: Readonly<Record<string, unknown>>,
  label: string,
): Record<string, unknown> {
  const entries = Object.entries(params);
  if (entries.length === 0) return { ...params };
  if (effectType === "shader") {
    const shaderId = params.shaderId;
    if (typeof shaderId !== "string" || shaderId.length === 0) {
      throw invalidParams(
        `${label}.params.shaderId is required for shader effects (one of the builtin effect shaders)`,
      );
    }
    const def = getMotionShaderEffectDefs().find((candidate) => candidate.id === shaderId);
    if (!def) {
      throw invalidParams(
        `${label}.params.shaderId "${shaderId}" is not a builtin effect shader`,
      );
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      if (key === "shaderId") {
        out[key] = value;
        continue;
      }
      const paramDef = def.params.find((candidate) => candidate.name === key);
      if (!paramDef) {
        throw invalidParams(
          `${label}.params.${key} is not a parameter of shader "${shaderId}" (accepted: ${def.params.map((p) => p.name).join(", ") || "none"})`,
        );
      }
      const checked = effectParamCheck(
        paramDef.type === "number"
          ? { kind: "number", min: paramDef.min, max: paramDef.max }
          : { kind: "hexColor" },
      )(value);
      if (!checked) {
        throw invalidParams(
          paramDef.type === "number"
            ? `${label}.params.${key} must be a finite number in [${paramDef.min}, ${paramDef.max}]`
            : `${label}.params.${key} must be a hex color string`,
        );
      }
      out[key] = value;
    }
    return out;
  }
  const rules = EFFECT_PARAM_RULES[effectType];
  const out: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const rule = rules[key];
    if (!rule) {
      const accepted = Object.keys(rules).join(", ") || "none";
      throw invalidParams(
        `${label}.params.${key} is not a parameter of the "${effectType}" effect (accepted: ${accepted})`,
      );
    }
    if (!effectParamCheck(rule)(value)) {
      throw invalidParams(
        `${label}.params.${key}: ${effectParamDescribe(rule)}`,
      );
    }
    out[key] = value;
  }
  return out;
}

export const CLIP_ADD_VIDEO_EFFECT_SCHEMA: ObjectSchema = {
  op: {
    check: (value) => value === "clip.addVideoEffect",
    describe: '"clip.addVideoEffect"',
    required: true,
    emits: { kind: "leaf", schema: { const: "clip.addVideoEffect" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  effectType: {
    check: oneOf(CLIP_VIDEO_EFFECT_TYPES),
    describe: `one of the GUI effect-stack types: ${CLIP_VIDEO_EFFECT_TYPES.join(", ")}`,
    required: true,
    emits: { kind: "leaf", schema: { enum: [...CLIP_VIDEO_EFFECT_TYPES] } },
  },
  params: {
    check: isEffectParamsShape,
    describe: `an object of at most ${MAX_EFFECT_PARAMS} scalar parameters (keys and ranges depend on effectType)`,
    emits: { kind: "object", schema: EFFECT_PARAM_BUNDLE_SCHEMA },
  },
  effectId: {
    check: isNonEmptyString,
    describe: "a non-empty string (deterministic effect id for later ops in the same batch)",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

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
    case "track.update": {
      const op = validateObject<TrackUpdateOp>(raw, TRACK_UPDATE_SCHEMA, label);
      if (
        op.name === undefined &&
        op.locked === undefined &&
        op.hidden === undefined &&
        op.muted === undefined &&
        op.solo === undefined
      ) {
        throw invalidParams(
          `${label}: at least one of name/locked/hidden/muted/solo is required`,
        );
      }
      return op;
    }
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
    case "svg.create":
      return validateObject<SvgCreateOp>(raw, SVG_CREATE_SCHEMA, label);
    case "svg.update": {
      const op = validateObject<SvgUpdateOp>(raw, SVG_UPDATE_SCHEMA, label);
      // "at least one updatable field" is a cross-field predicate enforced
      // here — deliberately NOT emitted.
      if (
        op.svgContent === undefined &&
        op.startTime === undefined &&
        op.duration === undefined &&
        op.position === undefined &&
        op.anchor === undefined
      ) {
        throw invalidParams(
          `${label}: at least one of svgContent/startTime/duration/position/anchor is required`,
        );
      }
      return op;
    }
    case "svg.remove":
      return validateObject<SvgRemoveOp>(raw, SVG_REMOVE_SCHEMA, label);
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
    case "requirement.update": {
      const op = validateObject<RequirementUpdateOp>(raw, REQUIREMENT_UPDATE_SCHEMA, label);
      if (op.status === undefined && op.agentNote === undefined && op.resultMediaIds === undefined) {
        throw invalidParams(`${label}: at least one of status, agentNote, or resultMediaIds is required`);
      }
      return op;
    }
    case "workAsset.capture": {
      const op = validateObject<WorkAssetCaptureOp>(
        raw,
        WORK_ASSET_CAPTURE_SCHEMA,
        label,
      );
      // Cross-field, validation-only (the emitted schema is a boundary
      // superset): exactly one capture form per op.
      if ((op.clipId !== undefined) === (op.clipIds !== undefined)) {
        throw invalidParams(
          `${label}: exactly one of clipId / clipIds is required`,
        );
      }
      return op;
    }
    case "workAsset.rename":
      return validateObject<WorkAssetRenameOp>(
        raw,
        WORK_ASSET_RENAME_SCHEMA,
        label,
      );
    case "workAsset.delete":
      return validateObject<WorkAssetDeleteOp>(
        raw,
        WORK_ASSET_DELETE_SCHEMA,
        label,
      );
    case "workAsset.instantiate":
      return validateObject<WorkAssetInstantiateOp>(
        raw,
        WORK_ASSET_INSTANTIATE_SCHEMA,
        label,
      );
    case "subtitle.importSrt": {
      const op = validateObject<SubtitleImportSrtOp>(
        raw,
        SUBTITLE_IMPORT_SRT_SCHEMA,
        label,
      );
      const parsed = parseSRT(op.srtContent);
      if (!parsed.success || parsed.subtitles.length === 0 || parsed.errors.length > 0) {
        throw invalidParams(`${label}: SRT parsing failed`, {
          errors: parsed.errors.slice(0, 20),
        });
      }
      if (parsed.subtitles.length > 500) {
        throw invalidParams(`${label}: SRT contains more than 500 cues`);
      }
      return op;
    }
    case "clip.setColorGrade": {
      const op = validateObject<ClipSetColorGradeOp>(
        raw,
        CLIP_SET_COLOR_GRADE_SCHEMA,
        label,
      );
      if (op.temperature === undefined && op.tint === undefined && op.clear !== true) {
        throw invalidParams(`${label}: temperature, tint, or clear is required`);
      }
      if (op.clear === true && (op.temperature !== undefined || op.tint !== undefined)) {
        throw invalidParams(`${label}: clear cannot be combined with temperature or tint`);
      }
      return op;
    }
    case "clip.setKeyframes": {
      const op = validateObject<ClipSetKeyframesOp>(
        raw,
        CLIP_SET_KEYFRAMES_SCHEMA,
        label,
      );
      const keyframes = op.keyframes.map((value, keyframeIndex) =>
        validateObject<FacadeKeyframeInput>(
          value,
          FACADE_KEYFRAME_SCHEMA,
          `${label}.keyframes[${keyframeIndex}]`,
        ),
      );
      const seen = new Set<string>();
      for (const keyframe of keyframes) {
        const key = `${keyframe.property}:${keyframe.time}`;
        if (seen.has(key)) {
          throw invalidParams(`${label}: duplicate keyframe at ${key}`);
        }
        seen.add(key);
        const [min, max] =
          keyframe.property === "opacity"
            ? [0, 1]
            : keyframe.property === "scale.x" || keyframe.property === "scale.y"
              ? [0.01, 20]
              : keyframe.property === "rotation"
                ? [-360, 360]
                : [-8192, 8192];
        if (keyframe.value < min || keyframe.value > max) {
          throw invalidParams(
            `${label}: ${keyframe.property} value must be in [${min}, ${max}]`,
          );
        }
      }
      return { ...op, keyframes };
    }
    case "clip.applyReframe": {
      // Crop rectangles are validated per-item (validateObject only checks
      // top-level fields), mirroring clip.setKeyframes' per-keyframe loop.
      // The draft-dependent predicates (source span, media dimensions, the
      // crop→transform conversion) run in opToCoreActions.
      const op = validateObject<ClipApplyReframeOp>(
        raw,
        CLIP_APPLY_REFRAME_SCHEMA,
        label,
      );
      op.keyframes.forEach((value, keyframeIndex) =>
        validateObject(
          value,
          REFRAME_CROP_KEYFRAME_SCHEMA,
          `${label}.keyframes[${keyframeIndex}]`,
        ),
      );
      return op;
    }
    case "clip.setChromaKey": {
      // No cross-field predicate: `enabled` is required and every tuning
      // field is independently bounded in the declaration above. Omitted
      // tuning fields merge onto the clip's prior settings in
      // opToCoreActions (same full-settings action the GUI panel emits).
      const op = validateObject<ClipSetChromaKeyOp>(
        raw,
        CLIP_SET_CHROMA_KEY_SCHEMA,
        label,
      );
      // keyColor is a nested closed object — its channels are validated at
      // this same boundary from the SAME declaration the emitted schema
      // derives from (out-of-range is rejected, never clamped).
      if (op.keyColor === undefined) return op;
      const keyColor = validateObject<NonNullable<ClipSetChromaKeyOp["keyColor"]>>(
        op.keyColor,
        CHROMA_KEY_COLOR_SCHEMA,
        `${label}.keyColor`,
      );
      return { ...op, keyColor };
    }
    case "clip.setNoiseReduction": {
      const op = validateObject<ClipSetNoiseReductionOp>(
        raw,
        CLIP_SET_NOISE_REDUCTION_SCHEMA,
        label,
      );
      // profile is a nested closed object whose cross-field rules (equal
      // lengths, fftSize = 2 × magnitudes.length and a power of two) cannot
      // be expressed in the emitted schema — enforce them here with the SAME
      // core predicate the render chain uses for persisted profiles
      // (out-of-shape profiles are rejected, never clamped).
      if (op.profile === undefined) return op;
      const profile = validateObject<NonNullable<ClipSetNoiseReductionOp["profile"]>>(
        op.profile,
        NOISE_REDUCTION_PROFILE_SCHEMA,
        `${label}.profile`,
      );
      if (!isSerializedNoiseProfile(profile)) {
        throw invalidParams(
          `${label}.profile: frequencyBins, magnitudes and standardDeviations must be equal-length finite arrays, sampleRate must be finite and fftSize (when present) must be twice magnitudes.length and a power of two`,
        );
      }
      return { ...op, profile };
    }
    case "clip.setDucking": {
      const op = validateObject<ClipSetDuckingOp>(
        raw,
        CLIP_SET_DUCKING_SCHEMA,
        label,
      );
      // Exactly one keyframe source: pre-computed points (an AudioDucker
      // product) or presence ranges the shared core kernel synthesizes from.
      if (op.points !== undefined && op.presenceRanges !== undefined) {
        throw invalidParams(
          `${label}: pass either points or presenceRanges, not both`,
        );
      }
      if (op.points !== undefined) {
        op.points.forEach((point, pointIndex) =>
          validateObject(
            point,
            DUCKING_POINT_SCHEMA,
            `${label}.points[${pointIndex}]`,
          ),
        );
        return { ...op, points: op.points };
      }
      if (op.presenceRanges !== undefined) {
        op.presenceRanges.forEach((range, rangeIndex) => {
          const parsed = validateObject<{ start: number; end: number }>(
            range,
            DUCKING_PRESENCE_RANGE_SCHEMA,
            `${label}.presenceRanges[${rangeIndex}]`,
          );
          if (parsed.end <= parsed.start) {
            throw invalidParams(
              `${label}.presenceRanges[${rangeIndex}].end must be greater than start`,
            );
          }
        });
        return { ...op, presenceRanges: op.presenceRanges };
      }
      throw invalidParams(
        `${label}: ducking keyframes need a source — pass points (an AudioDucker.generateDuckingKeyframes product) or presenceRanges (speech-active windows on the trigger track, e.g. from a silence analysis complement)`,
      );
    }
    case "clip.setBackgroundRemoval": {
      // No cross-field predicate: `enabled` is required and every tuning
      // field is independently bounded in the declaration above. Omitted
      // tuning fields merge onto the clip's prior settings in
      // opToCoreActions (the same full-settings action the GUI panel emits).
      return validateObject<ClipSetBackgroundRemovalOp>(
        raw,
        CLIP_SET_BACKGROUND_REMOVAL_SCHEMA,
        label,
      );
    }
    case "clip.addVideoEffect": {
      const op = validateObject<ClipAddVideoEffectOp>(
        raw,
        CLIP_ADD_VIDEO_EFFECT_SCHEMA,
        label,
      );
      // params keys/ranges depend on the sibling effectType — a cross-field
      // contract the emitted vocabulary cannot express, enforced here with
      // the SAME per-type bounds the GUI effect sliders enforce (shader
      // effects against the core shader library's own definitions). Unknown
      // keys and out-of-range values are rejected, never clamped.
      if (op.params === undefined) return op;
      return {
        ...op,
        params: validateAddVideoEffectParams(op.effectType, op.params, `${label}.params`),
      };
    }
    case "reference.setComparison": {
      const op = validateObject<ReferenceSetComparisonOp>(
        raw,
        REFERENCE_SET_COMPARISON_SCHEMA,
        label,
      );
      const config = validateObject<ReferenceSetComparisonOp["config"]>(
        op.config,
        REFERENCE_COMPARISON_CONFIG_SCHEMA,
        `${label}.config`,
      );
      return { ...op, config };
    }
    case "reference.clearComparison": {
      return validateObject<ReferenceClearComparisonOp>(
        raw,
        REFERENCE_CLEAR_COMPARISON_SCHEMA,
        label,
      );
    }
    case "media.replace": {
      const op = validateObject<MediaReplaceOp>(raw, MEDIA_REPLACE_SCHEMA, label);
      if (op.scope === "clip" && !op.clipId) {
        throw invalidParams(`${label}: clipId is required when scope is "clip"`);
      }
      return op;
    }
    case "media.relink": {
      return validateObject<MediaRelinkOp>(raw, MEDIA_RELINK_SCHEMA, label);
    }
    case "media.setProduction":
      return validateObject<MediaSetProductionOp>(raw, MEDIA_PRODUCTION_SCHEMA, label);
    case "media.rename":
      return validateObject<MediaRenameOp>(raw, MEDIA_RENAME_SCHEMA, label);
    default:
      // Unreachable: opType was allowlist-checked above. Keeps the function
      // total for the compiler and fail-closed for the runtime.
      throw invalidParams(`${label}: unsupported op ${JSON.stringify(opType)}`);
  }
}

/**
 * Async pre-pass for ops whose translation needs file facts: media.replace
 * needs a fully probed media item for the new version; media.relink needs
 * the file's stat facts. The session calls this BEFORE opToCoreActions and
 * the enriched ops flow through the ordinary atomic/undoable pipeline.
 */
export async function enrichMediaFileOps(
  ops: readonly EditOp[],
  mediaRoots: readonly string[],
  probeFile: (absPath: string) => Promise<{
    durationSec: number; width: number; height: number; frameRate: number;
    codec: string; fileSize: number; mimeType: string; hasVideo: boolean; hasAudio: boolean;
    sampleRate: number; channels: number;
  }>,
  statFile: (absPath: string) => Promise<{ name: string; size: number; lastModified: number }>,
  getProject?: () => Promise<Project | null>,
): Promise<readonly EditOp[]> {
  const out: EditOp[] = [];
  for (const op of ops) {
    if (op.op === "media.replace") {
      const replace = op as MediaReplaceOp;
      const resolution = resolveContainedPathDetailed(replace.filePath, mediaRoots);
      if (resolution.kind !== "ok") {
        throw new FacadeError(
          "INVALID_PARAMS",
          `media.replace: filePath must resolve inside a configured media root: ${replace.filePath}`,
          { filePath: replace.filePath },
        );
      }
      let verifiedDuration: number | undefined;
      if (replace.preserveFrames) {
        const project = await getProject?.();
        const original = project?.mediaLibrary.items.find((item) => item.id === replace.mediaId);
        if (!original?.originalUrl) throw new FacadeError("INVALID_PARAMS", "Strict replacement requires file-backed source media");
        const verified = await verifyReplacementFrames(original.originalUrl, resolution.path, mediaRoots);
        verifiedDuration = verified.durationSec;
      }
      const probed = await probeFile(resolution.path);
      const mediaType = probed.hasVideo ? "video" : "audio";
      out.push({
        ...replace,
        verifiedDuration,
        probedMediaItem: {
          id: `media-${crypto.randomUUID()}`,
          name: basename(resolution.path),
          type: mediaType,
          originalUrl: resolution.path,
          metadata: {
            duration: probed.durationSec,
            width: probed.width,
            height: probed.height,
            frameRate: probed.frameRate,
            codec: probed.codec,
            sampleRate: probed.sampleRate,
            channels: probed.channels,
            fileSize: probed.fileSize,
          },
        },
      } as EditOp);
    } else if (op.op === "media.relink") {
      const relink = op as MediaRelinkOp;
      const resolution = resolveContainedPathDetailed(relink.filePath, mediaRoots);
      if (resolution.kind !== "ok") {
        throw new FacadeError(
          "INVALID_PARAMS",
          `media.relink: filePath must resolve inside a configured media root: ${relink.filePath}`,
          { filePath: relink.filePath },
        );
      }
      const facts = await statFile(resolution.path);
      out.push({
        ...relink,
        probedFileFacts: { name: basename(resolution.path), size: facts.size, lastModified: facts.lastModified },
      } as EditOp);
    } else {
      out.push(op);
    }
  }
  return out;
}

function collectRepointTargets(
  op: MediaReplaceOp,
  draft: Project,
): Clip[] {
  const clips = draft.timeline.tracks.flatMap((track) => track.clips);
  if (op.scope === "clip") {
    const clip = clips.find((candidate) => candidate.id === op.clipId);
    if (!clip) {
      throw new FacadeError(
        "NOT_FOUND",
        `media.replace: clip "${op.clipId}" not found`,
        { clipId: op.clipId },
      );
    }
    if (clip.mediaId !== op.mediaId) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `media.replace: clip "${op.clipId}" does not reference media "${op.mediaId}"`,
        { clipId: op.clipId, mediaId: op.mediaId, clipMediaId: clip.mediaId },
      );
    }
    return [clip];
  }
  return clips.filter((clip) => clip.mediaId === op.mediaId);
}

/** Cross-op constraints that preserve precise per-op created-id attribution. */
export function validateEditBatch(ops: readonly EditOp[]): void {
  if (ops.filter((op) => op.op === "subtitle.importSrt").length > 1) {
    throw invalidParams(
      "edit batch may contain at most one subtitle.importSrt op; combine the SRT cues into one document",
    );
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
  readonly svgClips: ReadonlySet<string>;
  readonly transitions: ReadonlySet<string>;
  readonly subtitles: ReadonlySet<string>;
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
  const svgClips = new Set((project.svgClips ?? []).map((c) => c.id));
  const subtitles = new Set((project.timeline.subtitles ?? []).map((subtitle) => subtitle.id));
  return { tracks, clips, textOverlays, svgClips, transitions, subtitles };
}

/** Created entity ids, partitioned by category (the live seam's shape). */
export interface CreatedIdsByCategory {
  readonly tracks: readonly string[];
  readonly clips: readonly string[];
  readonly textClips: readonly string[];
  readonly svgClips: readonly string[];
  readonly transitions: readonly string[];
  readonly subtitles: readonly string[];
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
    svgClips: [...after.svgClips].filter((id) => !before.svgClips.has(id)),
    transitions: [...after.transitions].filter(
      (id) => !before.transitions.has(id),
    ),
    subtitles: [...after.subtitles].filter((id) => !before.subtitles.has(id)),
  };
}

export function diffCreatedIds(before: EntityIdSets, after: EntityIdSets): string[] {
  const byCategory = diffCreatedIdsByCategory(before, after);
  return [
    ...byCategory.tracks,
    ...byCategory.clips,
    ...byCategory.textClips,
    ...byCategory.svgClips,
    ...byCategory.transitions,
    ...byCategory.subtitles,
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
 * String-level viewBox extraction for svg.create. The facade op translator
 * runs in the Node host (no DOMParser there), so this mirrors core
 * parseSVG's fallback ladder on the raw markup: viewBox attribute first,
 * else width/height attributes, else 100x100 — the same clip the GUI import
 * of the identical markup would produce. Unparseable numbers fall back to
 * the default (core's parseSVG would keep NaN there; the renderer clamps to
 * a drawable box either way, and the content itself is unchanged).
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
      if (
        op.position !== undefined &&
        op.position > draft.timeline.tracks.length
      ) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `track.add: position ${op.position} is beyond the current track count ${draft.timeline.tracks.length} — pass at most ${draft.timeline.tracks.length} (or omit position to append on top)`,
          { position: op.position, trackCount: draft.timeline.tracks.length },
        );
      }
      return [
        makeAction("track/add", {
          trackType: op.trackType,
          ...(op.trackId !== undefined ? { trackId: op.trackId } : {}),
          ...(op.position !== undefined ? { position: op.position } : {}),
        }),
      ];
    }

    case "track.update": {
      const track = draft.timeline.tracks.find(
        (candidate) => candidate.id === op.trackId,
      );
      if (!track) {
        throw new FacadeError(
          "NOT_FOUND",
          `track.update: track "${op.trackId}" not found`,
          { trackId: op.trackId },
        );
      }
      const actions: Action[] = [];
      if (op.name !== undefined) {
        actions.push(makeAction("track/rename", { trackId: op.trackId, name: op.name.trim() }));
      }
      if (op.locked !== undefined) {
        actions.push(makeAction("track/lock", { trackId: op.trackId, locked: op.locked }));
      }
      if (op.hidden !== undefined) {
        actions.push(makeAction("track/hide", { trackId: op.trackId, hidden: op.hidden }));
      }
      if (op.muted !== undefined) {
        actions.push(makeAction("track/mute", { trackId: op.trackId, muted: op.muted }));
      }
      if (op.solo !== undefined) {
        actions.push(makeAction("track/solo", { trackId: op.trackId, solo: op.solo }));
      }
      return actions;
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
      // default source range so degenerate combinations like
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
          // Explicit duration remains authoritative. Otherwise the source
          // range defines the timeline span; sending it explicitly also
          // keeps older/direct Core consumers from re-defaulting to the full
          // media duration.
          duration: op.duration ?? effectiveOut - effectiveIn,
          ...(op.inPoint !== undefined ? { inPoint: op.inPoint } : {}),
          // Always forward the range value validated above. When only
          // inPoint is supplied, Core would otherwise default outPoint from
          // the derived timeline duration (for example 8 instead of 10 for
          // a 10-second source starting at 2 seconds).
          outPoint: effectiveOut,
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

    case "svg.create": {
      let trackId = op.trackId;
      let autoCreatedTrackId: string | undefined;
      if (trackId !== undefined) {
        const track = draft.timeline.tracks.find((t) => t.id === trackId);
        if (!track) {
          throw new FacadeError(
            "NOT_FOUND",
            `svg.create: track "${trackId}" not found`,
            { trackId },
          );
        }
        if (track.type !== "graphics") {
          throw invalidParams(
            `svg.create: track "${trackId}" is a ${track.type} track, expected a graphics track`,
            { trackId, trackType: track.type },
          );
        }
      } else {
        const graphicsTrack = draft.timeline.tracks.find(
          (t) => t.type === "graphics",
        );
        if (graphicsTrack) {
          trackId = graphicsTrack.id;
        } else {
          // Same higher-level-intent pattern as text.create: an SVG overlay
          // implies its graphics lane, so the track is created inside the
          // same action stream — one atomic edit.apply unit for commit and
          // undo in both headless drafts and live stores.
          autoCreatedTrackId = `track-${crypto.randomUUID()}`;
          trackId = autoCreatedTrackId;
        }
      }

      // Mirrors the clip graphicsEngine.importSVG builds for the GUI import
      // (same defaults for preserveAspectRatio/colorStyle/animations), so an
      // Agent-created SVG is indistinguishable from a GUI-imported one.
      const clip: SVGClip = {
        id: `svg-${crypto.randomUUID()}`,
        trackId,
        startTime: op.startTime,
        duration: op.duration,
        type: "svg",
        svgContent: op.svgContent,
        viewBox: extractSvgViewBox(op.svgContent),
        preserveAspectRatio: "xMidYMid",
        transform: {
          ...DEFAULT_GRAPHIC_TRANSFORM,
          ...(op.position !== undefined ? { position: { ...op.position } } : {}),
          ...(op.anchor !== undefined ? { anchor: { ...op.anchor } } : {}),
        },
        keyframes: [],
        colorStyle: { ...DEFAULT_SVG_COLOR_STYLE },
        entryAnimation: { type: "none", duration: 0.5, easing: "ease-out" },
        exitAnimation: { type: "none", duration: 0.5, easing: "ease-in" },
      };
      return [
        ...(autoCreatedTrackId !== undefined
          ? [
              makeAction("track/add", {
                trackType: "graphics",
                trackId: autoCreatedTrackId,
              }),
            ]
          : []),
        makeAction("svg/create", { clip }),
      ];
    }

    case "svg.update": {
      const existing = (draft.svgClips ?? []).find(
        (c) => c.id === op.overlayId,
      );
      if (!existing) {
        throw new FacadeError(
          "NOT_FOUND",
          `svg.update: svg overlay "${op.overlayId}" not found`,
          { overlayId: op.overlayId },
        );
      }
      // Core svg/update SHALLOW-spreads `updates` onto the clip, so a
      // position/anchor change must send the merged transform whole — a
      // partial object would drop the other transform keys. Only keys the
      // caller actually set go out.
      const updates: Partial<SVGClip> = {
        ...(op.svgContent !== undefined ? { svgContent: op.svgContent } : {}),
        ...(op.startTime !== undefined ? { startTime: op.startTime } : {}),
        ...(op.duration !== undefined ? { duration: op.duration } : {}),
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
      return [makeAction("svg/update", { clipId: op.overlayId, updates })];
    }

    case "svg.remove": {
      const exists = (draft.svgClips ?? []).some(
        (c) => c.id === op.overlayId,
      );
      if (!exists) {
        throw new FacadeError(
          "NOT_FOUND",
          `svg.remove: svg overlay "${op.overlayId}" not found`,
          { overlayId: op.overlayId },
        );
      }
      return [makeAction("svg/remove", { clipId: op.overlayId })];
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

    case "reference.setComparison": {
      const media = draft.mediaLibrary.items.find(
        (item) => item.id === op.config.referenceMediaId,
      );
      if (!media) {
        throw new FacadeError(
          "NOT_FOUND",
          `reference.setComparison: reference media "${op.config.referenceMediaId}" is not in the project media library`,
          { referenceMediaId: op.config.referenceMediaId },
        );
      }
      const verdict = validateReferenceComparisonConfig(op.config, {
        referenceMediaExists: true,
        referenceDurationSec: media.metadata.duration ?? 0,
        timelineDurationSec: timelineDurationSec(draft),
      });
      if (!verdict.ok) {
        throw new FacadeError("INVALID_PARAMS", `reference.setComparison: ${verdict.reason}`, {
          config: op.config,
        });
      }
      return [makeAction("reference/setComparison", { config: op.config })];
    }

    case "reference.clearComparison": {
      if (!draft.referenceComparison) {
        throw new FacadeError(
          "NOT_FOUND",
          "reference.clearComparison: no reference comparison is configured",
        );
      }
      return [makeAction("reference/clearComparison", {})];
    }

    case "requirement.update": {
      const displayMatch = /^Q(\d+)$/i.exec(op.requirementId.trim());
      const requirement = (draft.requirements?.items ?? []).find((item) =>
        displayMatch
          ? item.number === Number(displayMatch[1])
          : item.id === op.requirementId,
      );
      if (!requirement) {
        throw new FacadeError(
          "NOT_FOUND",
          `requirement.update: requirement "${op.requirementId}" not found`,
          { requirementId: op.requirementId },
        );
      }
      if (op.resultMediaIds) {
        const known = new Set(draft.mediaLibrary.items.map((item) => item.id));
        const missing = op.resultMediaIds.filter((id) => !known.has(id));
        if (missing.length > 0) {
          throw new FacadeError(
            "NOT_FOUND",
            `requirement.update: result media not found: ${missing.join(", ")}`,
            { missingMediaIds: missing },
          );
        }
      }
      return [makeAction("requirement/update", {
        requirementId: requirement.id,
        patch: {
          ...(op.status === undefined ? {} : { status: op.status === "done" ? "review" : op.status }),
          ...(op.agentNote === undefined ? {} : { agentNote: op.agentNote }),
          ...(op.resultMediaIds === undefined ? {} : { resultMediaIds: [...op.resultMediaIds] }),
        },
      })];
    }

    case "media.replace": {
      const probed = op.probedMediaItem as
        | {
            id: string;
            name: string;
            type: string;
            originalUrl: string;
            metadata: { duration: number; width: number; height: number; frameRate: number; codec: string; sampleRate: number; channels: number; fileSize: number };
          }
        | undefined;
      if (!probed) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "media.replace: missing the async probed media item — this op must go through edit.apply/edit.validate (the session pre-pass probes the new file)",
        );
      }
      const oldItem = draft.mediaLibrary.items.find((item) => item.id === op.mediaId);
      if (!oldItem) {
        throw new FacadeError(
          "NOT_FOUND",
          `media.replace: media "${op.mediaId}" not found`,
          { mediaId: op.mediaId },
        );
      }
      const targets = collectRepointTargets(op, draft);
      if (targets.length === 0) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `media.replace: no clips reference media "${op.mediaId}" under the requested scope`,
          { mediaId: op.mediaId, scope: op.scope },
        );
      }
      if (op.preserveFrames && op.verifiedDuration === undefined) throw new FacadeError("INVALID_PARAMS", "Strict replacement must pass the file verification pre-pass");
      const newDuration = op.verifiedDuration ?? probed.metadata.duration ?? 0;
      if (op.preserveFrames && targets.some((clip) => clip.outPoint > newDuration + 1e-6)) throw new FacadeError("INVALID_PARAMS", "Clip range exceeds the verified source frame count");
      const actions: Action[] = [
        // The new version imports as its OWN item: the old file is never
        // overwritten, both versions coexist and remain distinguishable.
        makeAction("media/import", { file: null as never, mediaItem: {
          ...probed,
          versionSource: {
            supersedesMediaIdInProject: op.mediaId,
            ...(oldItem.materialSource ? { supersedesMaterialId: oldItem.materialSource.materialId } : {}),
            replacedAt: new Date().toISOString(),
            replacedBy: "agent",
          },
        } as never }),
      ];
      for (const clip of targets) {
        if (newDuration > 0 && clip.inPoint >= newDuration - 1e-6) {
          throw new FacadeError(
            "INVALID_PARAMS",
            `media.replace: clip "${clip.id}" starts at inPoint ${clip.inPoint}s which is beyond the new source duration ${newDuration}s — trim the clip first or replace a longer source`,
            { clipId: clip.id, inPoint: clip.inPoint, newDuration },
          );
        }
        // Clamp to the new source; the timeline can only shrink, never extend.
        const outPoint = !op.preserveFrames && newDuration > 0 ? Math.min(clip.outPoint, newDuration) : clip.outPoint;
        const shortened = outPoint < clip.outPoint - 1e-6;
        if (shortened && (clip.speedKeyframes?.length || clip.freezeFrames?.length)) {
          throw new FacadeError("INVALID_PARAMS", "media.replace: shortening a clip with speed ramps or freeze frames requires an explicit trim first", { clipId: clip.id });
        }
        const duration = shortened
          ? Math.min(clip.duration, (outPoint - clip.inPoint) / Math.max(clip.speed ?? 1, 1e-6))
          : clip.duration;
        actions.push(
          makeAction("clip/repointSource", {
            clipId: clip.id,
            mediaId: probed.id,
            inPoint: clip.inPoint,
            outPoint,
            duration,
            supersedesMediaId: op.mediaId,
          }),
        );
      }
      return actions;
    }

    case "media.relink": {
      const facts = op.probedFileFacts;
      if (!facts) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "media.relink: missing the async file facts — this op must go through edit.apply/edit.validate (the session pre-pass stats the file)",
        );
      }
      const item = draft.mediaLibrary.items.find((entry) => entry.id === op.mediaId);
      if (!item) {
        throw new FacadeError(
          "NOT_FOUND",
          `media.relink: media "${op.mediaId}" not found`,
          { mediaId: op.mediaId },
        );
      }
      return [
        makeAction("media/relinkSource", {
          mediaId: op.mediaId,
          originalUrl: op.filePath,
          sourceFile: facts,
        }),
      ];
    }

    case "media.setProduction": {
      return [makeAction("media/setProduction", { mediaId: op.mediaId, production: op.production })];
    }

    case "media.rename": {
      const item = draft.mediaLibrary.items.find((entry) => entry.id === op.mediaId);
      if (!item) {
        throw new FacadeError(
          "NOT_FOUND",
          `media.rename: media "${op.mediaId}" not found`,
          { mediaId: op.mediaId },
        );
      }
      const displayName = op.displayName.trim();
      if (!displayName) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "media.rename: displayName cannot be empty",
          { mediaId: op.mediaId },
        );
      }
      // Same undoable action the GUI rename uses; only the display name
      // changes — the source filename and the file on disk are untouched.
      return [
        makeAction("media/rename", {
          mediaId: op.mediaId,
          name: displayName,
        }),
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

    case "workAsset.capture": {
      // The facade mints the stable id (marker.add convention); the asset
      // itself is created through the same undoable core action the GUI
      // capture entry uses (only the recorded `createdBy` provenance
      // differs).
      const captureOptions = {
        ...(op.name !== undefined ? { name: op.name } : {}),
        ...(op.captureRequestId !== undefined
          ? { captureRequestId: op.captureRequestId }
          : {}),
        assetId: `wa-${crypto.randomUUID()}`,
        createdBy: "agent" as const,
      };
      if (op.clipIds !== undefined) {
        // Multi form: ONE kind:"multi" asset from the whole set — core
        // prechecks every member and any failure rejects the set as a whole
        // (details.perMember names every failing clip; never a partial
        // asset).
        const captured = captureWorkAssetFromClips(draft, op.clipIds, {
          ...captureOptions,
        });
        if (!captured.ok) {
          const code =
            captured.code === "NOT_FOUND" || captured.code === "MEDIA_NOT_FOUND"
              ? "NOT_FOUND"
              : captured.code === "UNSUPPORTED"
                ? "UNSUPPORTED"
                : "INVALID_PARAMS";
          throw new FacadeError(
            code,
            `workAsset.capture: ${captured.message}`,
            {
              clipIds: [...op.clipIds],
              ...(captured.details ?? {}),
            },
          );
        }
        return [makeAction("workAsset/create", { asset: captured.asset })];
      }
      const captured = captureWorkAssetFromClip(
        draft,
        op.clipId as string,
        captureOptions,
      );
      if (!captured.ok) {
        const code =
          captured.code === "NOT_FOUND" || captured.code === "MEDIA_NOT_FOUND"
            ? "NOT_FOUND"
            : captured.code === "UNSUPPORTED"
              ? "UNSUPPORTED"
              : "INVALID_PARAMS";
        throw new FacadeError(
          code,
          `workAsset.capture: ${captured.message}`,
          {
            clipId: op.clipId,
            ...(captured.details ?? {}),
          },
        );
      }
      return [makeAction("workAsset/create", { asset: captured.asset })];
    }

    case "workAsset.rename": {
      const asset = (draft.workAssets ?? []).find(
        (candidate) => candidate.id === op.workAssetId,
      );
      if (!asset) {
        throw new FacadeError(
          "NOT_FOUND",
          `workAsset.rename: work asset "${op.workAssetId}" not found`,
          { workAssetId: op.workAssetId },
        );
      }
      return [
        makeAction("workAsset/rename", {
          workAssetId: op.workAssetId,
          name: op.name.trim(),
        }),
      ];
    }

    case "workAsset.delete": {
      const asset = (draft.workAssets ?? []).find(
        (candidate) => candidate.id === op.workAssetId,
      );
      if (!asset) {
        throw new FacadeError(
          "NOT_FOUND",
          `workAsset.delete: work asset "${op.workAssetId}" not found`,
          { workAssetId: op.workAssetId },
        );
      }
      return [makeAction("workAsset/delete", { workAssetId: op.workAssetId })];
    }

    case "workAsset.instantiate": {
      const batch = buildWorkAssetInstantiateActions(draft, op.workAssetId, {
        ...(op.trackId !== undefined ? { trackId: op.trackId } : {}),
        ...(op.startTime !== undefined ? { startTime: op.startTime } : {}),
      });
      if (!batch.ok) {
        const code =
          batch.code === "NOT_FOUND" || batch.code === "MEDIA_NOT_FOUND"
            ? "NOT_FOUND"
            : batch.code;
        throw new FacadeError(
          code,
          `workAsset.instantiate: ${batch.message}`,
          {
            workAssetId: op.workAssetId,
            ...(batch.details ?? {}),
          },
        );
      }
      return [...batch.actions];
    }

    case "subtitle.importSrt": {
      const parsed = parseSRT(op.srtContent);
      if (!parsed.success || parsed.subtitles.length === 0 || parsed.errors.length > 0) {
        throw invalidParams("subtitle.importSrt: SRT parsing failed", {
          errors: parsed.errors.slice(0, 20),
        });
      }
      return [
        makeAction("subtitle/setAll", {
          subtitles: [
            ...(draft.timeline.subtitles ?? []).map((subtitle) => ({ ...subtitle })),
            ...parsed.subtitles.map((subtitle) => ({ ...subtitle })),
          ],
        }),
      ];
    }

    case "clip.setColorGrade": {
      const clip = draft.timeline.tracks
        .flatMap((track) => track.clips)
        .find((candidate) => candidate.id === op.clipId);
      if (!clip) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.setColorGrade: clip "${op.clipId}" not found`,
          { clipId: op.clipId },
        );
      }
      return [
        makeAction("clip/setColorGrading", {
          clipId: op.clipId,
          colorGrading:
            op.clear === true
              ? undefined
              : {
                  ...(clip.colorGrading ?? {}),
                  ...(op.temperature !== undefined
                    ? { temperature: op.temperature }
                    : {}),
                  ...(op.tint !== undefined ? { tint: op.tint } : {}),
                },
        }),
      ];
    }

    case "clip.setKeyframes": {
      const clip = draft.timeline.tracks
        .flatMap((track) => track.clips)
        .find((candidate) => candidate.id === op.clipId);
      if (!clip) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.setKeyframes: clip "${op.clipId}" not found`,
          { clipId: op.clipId },
        );
      }
      for (const keyframe of op.keyframes) {
        if (keyframe.time > clip.duration) {
          throw invalidParams(
            `clip.setKeyframes: keyframe time ${keyframe.time} exceeds clip duration ${clip.duration}`,
            { clipId: op.clipId, time: keyframe.time, duration: clip.duration },
          );
        }
      }
      return [
        makeAction("keyframe/setAll", {
          clipId: op.clipId,
          keyframes: op.keyframes.map((keyframe) => ({
            id: `keyframe-${crypto.randomUUID()}`,
            property: keyframe.property,
            time: keyframe.time,
            value: keyframe.value,
            easing: keyframe.easing ?? "linear",
          })),
        }),
      ];
    }

    case "clip.applyReframe": {
      const clip = draft.timeline.tracks
        .flatMap((track) => track.clips)
        .find((candidate) => candidate.id === op.clipId);
      if (!clip) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.applyReframe: clip "${op.clipId}" not found`,
          { clipId: op.clipId },
        );
      }
      const mediaItem = draft.mediaLibrary.items.find(
        (candidate) => candidate.id === clip.mediaId,
      );
      if (!mediaItem) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.applyReframe: media "${clip.mediaId}" for clip "${op.clipId}" not found`,
          { clipId: op.clipId, mediaId: clip.mediaId },
        );
      }
      const sourceWidth = mediaItem.metadata?.width ?? 0;
      const sourceHeight = mediaItem.metadata?.height ?? 0;
      if (sourceWidth <= 0 || sourceHeight <= 0) {
        throw invalidParams(
          `clip.applyReframe: source media dimensions are unknown for "${mediaItem.id}"`,
          { clipId: op.clipId, mediaId: mediaItem.id },
        );
      }
      // Analysis times are source seconds from the clip's in-point — the
      // same bound clip.setKeyframes enforces against the clip duration.
      const sourceSpan = clip.outPoint - clip.inPoint;
      for (const keyframe of op.keyframes) {
        if (keyframe.time > sourceSpan + 1e-6) {
          throw invalidParams(
            `clip.applyReframe: keyframe time ${keyframe.time} exceeds the clip source span ${sourceSpan}`,
            { clipId: op.clipId, time: keyframe.time, sourceSpan },
          );
        }
      }
      // The conversion covers the canvas exactly only when every crop keeps
      // the output canvas ratio. The Auto Reframe analysis path guarantees
      // this (up to per-pixel rounding); hand-written plans must respect the
      // same band. Kept at the execution layer, NOT the schema, so the op's
      // analysis-derived internal callers are never schema-rejected.
      const outputRatio = op.outputWidth / op.outputHeight;
      for (const keyframe of op.keyframes) {
        const cropRatio = keyframe.cropWidth / keyframe.cropHeight;
        const drift = Math.abs(cropRatio - outputRatio) / outputRatio;
        if (drift > REFRAME_CROP_RATIO_TOLERANCE) {
          throw invalidParams(
            `clip.applyReframe: crop aspect ratio must match the output canvas aspect ratio ${outputRatio} (keyframe at ${keyframe.time}s has ratio ${cropRatio}, a ${(drift * 100).toFixed(1)}% drift, tolerance ${REFRAME_CROP_RATIO_TOLERANCE * 100}%) — the Auto Reframe analysis path already guarantees this; adjust hand-written plans to match`,
            { clipId: op.clipId, time: keyframe.time, cropRatio, outputRatio, drift },
          );
        }
      }
      // The SAME core conversion the GUI reframe panel uses: crop rects →
      // scale/position transform keyframes, with speed folding handled here
      // (never by the agent).
      const transformKeyframes = reframeKeyframesToTransformKeyframes(
        {
          keyframes: op.keyframes.map((keyframe) => ({ ...keyframe, scale: 1 })),
          outputWidth: op.outputWidth,
          outputHeight: op.outputHeight,
          success: true,
        },
        { width: sourceWidth, height: sourceHeight },
        { duration: clip.duration, speed: clip.speed },
      );
      const actions: Action[] = [];
      if (
        draft.settings.width !== op.outputWidth ||
        draft.settings.height !== op.outputHeight
      ) {
        // Included ONLY when the output size actually differs, keeping the
        // resize and the keyframes one atomic batch either way.
        actions.push(
          makeAction("project/updateSettings", {
            width: op.outputWidth,
            height: op.outputHeight,
          }),
        );
      }
      actions.push(
        makeAction("keyframe/setAll", {
          clipId: op.clipId,
          keyframes: transformKeyframes,
        }),
      );
      return actions;
    }

    case "clip.setChromaKey": {
      const clip = draft.timeline.tracks
        .flatMap((track) => track.clips)
        .find((candidate) => candidate.id === op.clipId);
      if (!clip) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.setChromaKey: clip "${op.clipId}" not found`,
          { clipId: op.clipId },
        );
      }
      // core's clip/setChromaKey REPLACES the whole field, so assemble the
      // complete settings snapshot the GUI green-screen panel also emits:
      // omitted tuning fields keep the clip's prior value, falling back to
      // the shared engine defaults (fixed green key). Disabling keeps the
      // tuning values, matching the GUI toggle.
      const prior = clip.chromaKey;
      const keyColor = op.keyColor ?? prior?.keyColor ?? DEFAULT_CHROMA_KEY_SETTINGS.keyColor;
      return [
        makeAction("clip/setChromaKey", {
          clipId: op.clipId,
          chromaKey: {
            enabled: op.enabled,
            keyColor: { ...keyColor },
            tolerance:
              op.tolerance ?? prior?.tolerance ?? DEFAULT_CHROMA_KEY_SETTINGS.tolerance,
            edgeSoftness:
              op.edgeSoftness ??
              prior?.edgeSoftness ??
              DEFAULT_CHROMA_KEY_SETTINGS.edgeSoftness,
            spillSuppression:
              op.spillSuppression ??
              prior?.spillSuppression ??
              DEFAULT_CHROMA_KEY_SETTINGS.spillSuppression,
          },
        }),
      ];
    }

    case "clip.setBackgroundRemoval": {
      const clip = draft.timeline.tracks
        .flatMap((track) => track.clips)
        .find((candidate) => candidate.id === op.clipId);
      if (!clip) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.setBackgroundRemoval: clip "${op.clipId}" not found`,
          { clipId: op.clipId },
        );
      }
      // core's clip/setBackgroundRemoval REPLACES the whole field, so
      // assemble the complete settings snapshot the GUI panel also emits:
      // omitted tuning fields keep the clip's prior value, falling back to
      // the shared engine defaults. Disabling keeps the tuning values,
      // matching the GUI toggle. NOTE: this op persists the matte only —
      // rendering it needs a MediaPipe-capable GUI/desktop-Chromium runtime
      // (see the backgroundRemoval capability), and headless-rendered frames
      // keep the original background.
      const prior = clip.backgroundRemoval;
      return [
        makeAction("clip/setBackgroundRemoval", {
          clipId: op.clipId,
          backgroundRemoval: {
            enabled: op.enabled,
            mode: op.mode ?? prior?.mode ?? DEFAULT_BACKGROUND_SETTINGS.mode,
            blurAmount:
              op.blurAmount ??
              prior?.blurAmount ??
              DEFAULT_BACKGROUND_SETTINGS.blurAmount,
            backgroundColor:
              op.backgroundColor ??
              prior?.backgroundColor ??
              DEFAULT_BACKGROUND_SETTINGS.backgroundColor,
            ...(op.backgroundImageUrl !== undefined ||
            prior?.backgroundImageUrl !== undefined
              ? {
                  backgroundImageUrl:
                    op.backgroundImageUrl ?? prior?.backgroundImageUrl,
                }
              : {}),
            ...(op.backgroundVideoUrl !== undefined ||
            prior?.backgroundVideoUrl !== undefined
              ? {
                  backgroundVideoUrl:
                    op.backgroundVideoUrl ?? prior?.backgroundVideoUrl,
                }
              : {}),
            edgeBlur:
              op.edgeBlur ?? prior?.edgeBlur ?? DEFAULT_BACKGROUND_SETTINGS.edgeBlur,
            threshold:
              op.threshold ?? prior?.threshold ?? DEFAULT_BACKGROUND_SETTINGS.threshold,
          },
        }),
      ];
    }

    case "clip.addVideoEffect": {
      const clip = draft.timeline.tracks
        .flatMap((track) => track.clips)
        .find((candidate) => candidate.id === op.clipId);
      if (!clip) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.addVideoEffect: clip "${op.clipId}" not found (timeline clips only — text/svg overlays are separate entities)`,
          { clipId: op.clipId },
        );
      }
      // The SAME core effect/add action the GUI inspector's effect panel
      // dispatches (one append at the top of the stack, engine defaults for
      // omitted params, undoable via the action's inverse, persisted with
      // the clip, evaluated by the shared preview/export render chain).
      // Note: core mints a fresh id when effectId is omitted.
      return [
        makeAction("effect/add", {
          clipId: op.clipId,
          effectType: op.effectType,
          ...(op.params !== undefined ? { params: { ...op.params } } : {}),
          ...(op.effectId !== undefined ? { effectId: op.effectId } : {}),
        }),
      ];
    }

    case "clip.setNoiseReduction": {
      const clip = draft.timeline.tracks
        .flatMap((track) => track.clips)
        .find((candidate) => candidate.id === op.clipId);
      if (!clip) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.setNoiseReduction: clip "${op.clipId}" not found`,
          { clipId: op.clipId },
        );
      }
      // The GUI resolves add-vs-update by whether the clip already carries a
      // noiseReduction effect (panel apply and the Inspector quick cleanup
      // both do): an existing effect is updated IN PLACE — never stacked.
      // Assemble the full params snapshot the same way the GUI's full-config
      // update does: shared defaults ← prior params ← preset ← explicit
      // fields, and a learned profile survives preset switches.
      const prior =
        (clip.audioEffects ?? []).find(
          (candidate) => candidate.type === "noiseReduction",
        ) ?? null;
      const priorParams = (prior?.params ?? {}) as Partial<
        typeof DEFAULT_NOISE_REDUCTION_SETTINGS
      >;
      const presetConfig = op.preset
        ? getNoiseReductionPreset(op.preset).config
        : null;
      const params: Record<string, unknown> = {
        threshold:
          op.threshold ??
          presetConfig?.threshold ??
          priorParams.threshold ??
          DEFAULT_NOISE_REDUCTION_SETTINGS.threshold,
        reduction:
          op.reduction ??
          presetConfig?.reduction ??
          priorParams.reduction ??
          DEFAULT_NOISE_REDUCTION_SETTINGS.reduction,
        attack:
          op.attack ??
          presetConfig?.attack ??
          priorParams.attack ??
          DEFAULT_NOISE_REDUCTION_SETTINGS.attack,
        release:
          op.release ??
          presetConfig?.release ??
          priorParams.release ??
          DEFAULT_NOISE_REDUCTION_SETTINGS.release,
        focus:
          op.preset ??
          priorParams.focus ??
          DEFAULT_NOISE_REDUCTION_SETTINGS.focus,
      };
      const resolvedProfile = op.profile ?? priorParams.profile;
      if (resolvedProfile !== undefined) {
        params.profile = resolvedProfile;
      }

      if (!prior) {
        if (!op.enabled) {
          throw new FacadeError(
            "NOT_FOUND",
            `clip.setNoiseReduction: clip "${op.clipId}" has no noiseReduction effect to disable`,
            { clipId: op.clipId },
          );
        }
        return [
          makeAction("audio/addEffect", {
            clipId: op.clipId,
            effect: {
              id: `noiseReduction-${crypto.randomUUID()}`,
              type: "noiseReduction",
              params,
              enabled: true,
            },
          }),
        ];
      }

      // Always refresh the params snapshot (an idempotent no-op write when
      // nothing changed — keeps the emitted action batch non-empty, which
      // the live store requires), then toggle only when the requested
      // enabled state differs from the current one.
      const actions: Action[] = [
        makeAction("audio/updateEffect", {
          clipId: op.clipId,
          effectId: prior.id,
          params,
        }),
      ];
      if (op.enabled !== prior.enabled) {
        actions.push(
          makeAction("audio/toggleEffect", {
            clipId: op.clipId,
            effectId: prior.id,
            enabled: op.enabled,
          }),
        );
      }
      return actions;
    }

    case "clip.setDucking": {
      const clip = draft.timeline.tracks
        .flatMap((track) => track.clips)
        .find((candidate) => candidate.id === op.clipId);
      if (!clip) {
        throw new FacadeError(
          "NOT_FOUND",
          `clip.setDucking: clip "${op.clipId}" not found`,
          { clipId: op.clipId },
        );
      }
      // GUI parity: the ducking panel applies ducking to the clip that will
      // actually be heard (resolveAudibleAudioTarget follows linked audio
      // when the addressed clip is muted), and seeds the synthesis with the
      // target's own volume as the ducked baseline.
      const target = resolveAudibleAudioTarget(clip, draft.timeline);
      const backgroundVolume = target.volume > 0 ? target.volume : 1;
      const config = {
        threshold: op.threshold,
        reduction: op.reduction,
        attack: op.attack,
        release: op.release,
        holdTime: op.holdTime,
      };

      let points;
      if (op.points !== undefined) {
        points = op.points.map((point) => ({ ...point }));
      } else if (op.presenceRanges !== undefined) {
        // Same core kernel AudioDucker.generateDuckingKeyframes delegates to
        // (facade -> core is the established dependency direction); an empty
        // synthesis is rejected, mirroring the GUI panel's explicit error.
        points = generateDuckingKeyframesFromRanges(
          op.presenceRanges,
          config,
          backgroundVolume,
        );
        if (points.length === 0) {
          throw new FacadeError(
            "INVALID_PARAMS",
            `clip.setDucking: no speech crossed the trigger threshold in the supplied presenceRanges for clip "${op.clipId}" — lower the threshold or check the trigger analysis`,
            { clipId: op.clipId },
          );
        }
      } else {
        throw new FacadeError(
          "INVALID_PARAMS",
          "clip.setDucking: pass points or presenceRanges (validated by validateEditOp; this branch is unreachable for translated ops)",
          { clipId: op.clipId },
        );
      }

      return [
        makeAction("audio/setDucking", {
          clipId: target.id,
          settings: {
            enabled: true,
            sourceTrackId: null,
            threshold: op.threshold,
            reduction: op.reduction,
            attack: op.attack,
            release: op.release,
            holdTime: op.holdTime,
          },
          points,
        }),
      ];
    }
  }
}
