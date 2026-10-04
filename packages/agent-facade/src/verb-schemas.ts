import { PLUGIN_TOOLS } from "./plugins";
/**
 * The SINGLE hand-maintained schema declaration per facade verb
 * Both consumers derive from these objects:
 *
 *  - the runtime boundary validators (session.ts drives `validateObject`
 *    with exactly these declarations — same checks, same labels, same
 *    stable error ordering); and
 *  - the emitted draft-2020-12 JSON Schemas (jsonschema.ts renders them
 *    for the transport's `tools/list`, which assigns them verbatim).
 *
 * Cross-field rules that JSON Schema cannot express (clip.trim's
 * at-least-one-of in/out, verify.compare.region's x+width ≤ 1) stay
 * validation-only predicates next to their verb: the emitted schema is a
 * boundary superset filter, and the runtime validators remain the only
 * authority — a payload can be schema-valid and still fail INVALID_PARAMS.
 */
import { EDIT_OP_TYPES, MEDIA_ANALYSIS_TYPES } from "./types";
import { MATERIAL_LIBRARY_LIMITS } from "./material-library";
import { FONT_LIBRARY_LIMITS } from "./font-library";
import { PRESET_LIBRARY_LIMITS } from "./preset-verbs";
import {
  HELP_DESCRIBE_SCHEMA,
  HELP_LIST_SCREENS_SCHEMA,
  HELP_SEARCH_SCHEMA,
} from "./gui-manual";
// The help.* param declarations live in gui-manual.ts next to the content
// they validate; re-exported here so VERB_PARAM_SCHEMAS stays the single
// verb-declaration map for importers.
export {
  HELP_DESCRIBE_SCHEMA,
  HELP_LIST_SCREENS_SCHEMA,
  HELP_SEARCH_SCHEMA,
};
import { MATERIAL_KINDS, MATERIAL_MEDIA_TYPES } from "@reelterminal/core/material/types";
import { PRESET_KINDS } from "@reelterminal/core/presets/types";
import {
  MAX_MATERIAL_METHOD_STEPS,
  MAX_MATERIAL_TAGS,
  MAX_MATERIAL_TEXT_LENGTH,
} from "@reelterminal/core/material/logic";
import {
  MAX_PROJECT_CHANGES_LIMIT,
} from "./project-changes";
import {
  MAX_TIMELINE_QUERY_LIMIT,
  MAX_TIMELINE_QUERY_NEIGHBORS,
  TIMELINE_QUERY_ENTITY_TYPES,
  TIMELINE_QUERY_FIELDS,
} from "./timeline-query";
import { FRAME_BUDGET_EMITS, isFrameBudget } from "./frame-budget";
import {
  CLIP_ADD_SCHEMA,
  CLIP_DUPLICATE_SCHEMA,
  CLIP_MOVE_SCHEMA,
  CLIP_REMOVE_SCHEMA,
  CLIP_RIPPLE_DELETE_SCHEMA,
  CLIP_SET_FADE_SCHEMA,
  CLIP_SET_REVERSE_SCHEMA,
  CLIP_SET_SPEED_SCHEMA,
  CLIP_SET_TRANSFORM_SCHEMA,
  CLIP_SET_VOLUME_SCHEMA,
  CLIP_SPLIT_SCHEMA,
  CLIP_TRIM_SCHEMA,
  TEXT_CREATE_SCHEMA,
  TEXT_DELETE_SCHEMA,
  TEXT_UPDATE_SCHEMA,
  SVG_CREATE_SCHEMA,
  SVG_UPDATE_SCHEMA,
  SVG_REMOVE_SCHEMA,
  TRACK_ADD_SCHEMA,
  TRACK_UPDATE_SCHEMA,
  TRACK_REMOVE_SCHEMA,
  MEDIA_REMOVE_SCHEMA,
  MARKER_ADD_SCHEMA,
  MARKER_REMOVE_SCHEMA,
  REQUIREMENT_UPDATE_SCHEMA,
  TRANSITION_ADD_SCHEMA,
  TRANSITION_REMOVE_SCHEMA,
  TRANSITION_UPDATE_SCHEMA,
  SUBTITLE_IMPORT_SRT_SCHEMA,
  CLIP_SET_COLOR_GRADE_SCHEMA,
  REFERENCE_SET_COMPARISON_SCHEMA,
  REFERENCE_CLEAR_COMPARISON_SCHEMA,
  MEDIA_REPLACE_SCHEMA,
  MEDIA_RELINK_SCHEMA,
  MEDIA_RENAME_SCHEMA,
  MEDIA_PRODUCTION_SCHEMA,
  CLIP_SET_KEYFRAMES_SCHEMA,
  CLIP_APPLY_REFRAME_SCHEMA,
  CLIP_SET_CHROMA_KEY_SCHEMA,
  CLIP_SET_NOISE_REDUCTION_SCHEMA,
  CLIP_SET_DUCKING_SCHEMA,
  CLIP_SET_BACKGROUND_REMOVAL_SCHEMA,
  CLIP_ADD_VIDEO_EFFECT_SCHEMA,
  WORK_ASSET_CAPTURE_SCHEMA,
  WORK_ASSET_RENAME_SCHEMA,
  WORK_ASSET_DELETE_SCHEMA,
  WORK_ASSET_INSTANTIATE_SCHEMA,
} from "./ops";
import {
  isBoolean,
  isFiniteNumber,
  isNonEmptyString,
  isNonNegativeInteger,
  isNonNegativeNumber,
  isPlainObject,
  isPositiveInteger,
  isPositiveNumber,
  oneOf,
  validateObject,
  type ObjectSchema,
} from "./validate";

/* ------------------------------------------------------------------ */
/* project.create / project.open / project.save                        */
/* ------------------------------------------------------------------ */

/** Param-less verbs validate against a closed empty schema. */
export const EMPTY_PARAMS_SCHEMA: ObjectSchema = {};

// Hardened settings subset: dimensions and audio layout must be positive
// INTEGERS; frameRate is the one field that legitimately carries a fraction
// (29.97 etc.), so it is a positive finite number. Shared verbatim by
// project.create params.settings and the checkpoint project-document
// declaration (checkpoint.ts) — one definition of the canonical settings.
export const PROJECT_SETTINGS_SCHEMA: ObjectSchema = {
  width: {
    check: isPositiveInteger,
    describe: "a positive integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
  height: {
    check: isPositiveInteger,
    describe: "a positive integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
  frameRate: {
    check: isPositiveNumber,
    describe: "a positive finite number",
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
  sampleRate: {
    check: isPositiveInteger,
    describe: "a positive integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
  channels: {
    check: isPositiveInteger,
    describe: "a positive integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
};

export const PROJECT_CREATE_SCHEMA: ObjectSchema = {
  name: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  settings: {
    check: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
    describe: "an object",
    emits: { kind: "object", schema: PROJECT_SETTINGS_SCHEMA },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/**
 * project.open {path, idempotencyKey?} — persistence verb: no expectedRevision
 * (single-initialization, outside the
 * revision machinery), create-style idempotent replay only.
 */
export const PROJECT_OPEN_SCHEMA: ObjectSchema = {
  path: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/**
 * project.save {path, expectedRevision?, overwrite?} — a snapshot, NOT a
 * mutation (Decision 10.3): no idempotencyKey, no ledger entry, no revision
 * bump; the optional expectedRevision is a pure guard.
 */
export const PROJECT_SAVE_SCHEMA: ObjectSchema = {
  path: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  expectedRevision: {
    check: isNonNegativeInteger,
    describe: "a non-negative integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  overwrite: {
    check: (v) => typeof v === "boolean",
    describe: "a boolean",
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
};

export const MAX_PROJECT_NAME_LENGTH = 120;

export function normalizeProjectName(value: string): string {
  return value.trim().normalize("NFC");
}

export const PROJECT_RENAME_SCHEMA: ObjectSchema = {
  name: {
    check: (value) =>
      isNonEmptyString(value) &&
      normalizeProjectName(value as string).length > 0 &&
      normalizeProjectName(value as string).length <= MAX_PROJECT_NAME_LENGTH &&
      !/[\u0000-\u001f\u007f]/.test(value as string),
    describe: `a non-empty project name without control characters (at most ${MAX_PROJECT_NAME_LENGTH} characters)`,
    required: true,
    emits: {
      kind: "leaf",
      schema: { type: "string", minLength: 1 },
    },
  },
  expectedRevision: {
    check: isNonNegativeInteger,
    describe: "a non-negative integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/* ------------------------------------------------------------------ */
/* media.import / timeline.get (no params) / edit.apply                */
/* ------------------------------------------------------------------ */

export const MEDIA_IMPORT_SCHEMA: ObjectSchema = {
  path: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  name: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  expectedRevision: {
    check: isNonNegativeInteger,
    describe: "a non-negative integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const MEDIA_SILENCE_PARAMS_SCHEMA: ObjectSchema = {
  thresholdDb: { check: (v) => typeof v === "number" && Number.isFinite(v) && v >= -120 && v <= 0, describe: "a finite number in [-120, 0] (dBFS); default −40 matches the GUI silence-cut panel", emits: { kind: "leaf", schema: { type: "number", minimum: -120, maximum: 0 } } },
  minDurationSec: { check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10, describe: "a finite number in [0, 10] seconds; default 0.5 matches the GUI silence-cut panel", emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 10 } } },
  paddingSec: { check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10, describe: "a finite number in [0, 10] seconds; default 0.1 matches the GUI silence-cut panel", emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 10 } } },
};

export const MEDIA_ANALYZE_START_SCHEMA: ObjectSchema = {
  cloudUpload: { check: (v) => typeof v === "boolean", describe: "must be true for videoReview: uploads the selected range to Alibaba", emits: { kind: "leaf", schema: { type: "boolean" } } },
  reviewQuestion: { check: (v) => typeof v === "string" && v.length <= 1000, describe: "optional video review focus, at most 1000 characters", emits: { kind: "leaf", schema: { type: "string", maxLength: 1000 } } },
  startSec: { check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0, describe: "nonnegative source seconds", emits: { kind: "leaf", schema: { type: "number", minimum: 0 } } },
  endSec: { check: (v) => typeof v === "number" && Number.isFinite(v) && v > 0, describe: "positive source seconds; audioSummary/silence/beatGrid range ≤120s; videoReview requires explicit start/end and range ≤20s", emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } } },
  mediaId: {
    check: isNonEmptyString,
    describe: "a non-empty media-library id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  analysisTypes: {
    check: (value) =>
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= MEDIA_ANALYSIS_TYPES.length &&
      new Set(value).size === value.length &&
      value.every((item) =>
        (MEDIA_ANALYSIS_TYPES as readonly unknown[]).includes(item),
      ),
    describe: "a non-empty unique array of supported analysis type names",
    required: true,
    emits: {
      kind: "array",
      minItems: 1,
      maxItems: MEDIA_ANALYSIS_TYPES.length,
      items: { kind: "leaf", schema: { enum: MEDIA_ANALYSIS_TYPES } },
    },
  },
  recheckOfRecordId: {
    check: isNonEmptyString,
    describe: "optional id of a previous analysis record this run re-checks (links via recheckOf)",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  silenceParams: {
    check: (value) =>
      value !== null && typeof value === "object" && !Array.isArray(value) &&
      Object.entries(value).every(([key, val]) =>
        key in MEDIA_SILENCE_PARAMS_SCHEMA && MEDIA_SILENCE_PARAMS_SCHEMA[key]!.check(val),
      ),
    describe: "optional silence tuning {thresholdDb, minDurationSec, paddingSec}; valid only when analysisTypes includes \"silence\"; defaults match the GUI silence-cut panel (−40 dB, 0.5 s, 0.1 s)",
    emits: { kind: "object", schema: MEDIA_SILENCE_PARAMS_SCHEMA },
  },
  expectedRevision: {
    check: isNonNegativeInteger,
    describe: "a non-negative integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const PROJECT_CHANGES_SCHEMA: ObjectSchema = {
  sinceRevision: {
    check: isNonNegativeInteger,
    describe: "a non-negative integer",
    required: true,
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  limit: {
    check: (value) =>
      isPositiveInteger(value) && (value as number) <= MAX_PROJECT_CHANGES_LIMIT,
    describe: `an integer in [1, ${MAX_PROJECT_CHANGES_LIMIT}]`,
    emits: {
      kind: "leaf",
      schema: { type: "integer", minimum: 1, maximum: MAX_PROJECT_CHANGES_LIMIT },
    },
  },
  cursor: {
    check: isNonEmptyString,
    describe: "a non-empty opaque cursor",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const TIMELINE_QUERY_RANGE_SCHEMA: ObjectSchema = {
  startSec: {
    check: isNonNegativeNumber,
    describe: "a non-negative finite number",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  endSec: {
    check: isNonNegativeNumber,
    describe: "a non-negative finite number",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
};

const boundedStrings = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 100 &&
  value.every((item) => typeof item === "string" && item.length > 0);

export const TIMELINE_QUERY_SCHEMA: ObjectSchema = {
  refs: {
    check: (value) =>
      boundedStrings(value) &&
      value.every((ref) => /^@A[1-9]\d*$|^R[1-9]\d*$/.test(ref)),
    describe: "an array of at most 100 namespaced refs (@A<n> or R<n>; bare #N is forbidden)",
    emits: {
      kind: "array",
      maxItems: 100,
      items: { kind: "leaf", schema: { type: "string", minLength: 2 } },
    },
  },
  entityIds: {
    check: boundedStrings,
    describe: "an array of at most 100 non-empty entity ids",
    emits: {
      kind: "array",
      maxItems: 100,
      items: { kind: "leaf", schema: { type: "string", minLength: 1 } },
    },
  },
  timeRange: {
    check: isPlainObject,
    describe: "a timeline range object",
    emits: { kind: "object", schema: TIMELINE_QUERY_RANGE_SCHEMA },
  },
  trackIds: {
    check: boundedStrings,
    describe: "an array of at most 100 non-empty track ids",
    emits: {
      kind: "array",
      maxItems: 100,
      items: { kind: "leaf", schema: { type: "string", minLength: 1 } },
    },
  },
  trackTypes: {
    check: (value) =>
      Array.isArray(value) &&
      value.length <= 5 &&
      value.every((item) =>
        ["video", "audio", "image", "text", "graphics"].includes(item),
      ),
    describe: "an array of supported track types",
    emits: {
      kind: "array",
      maxItems: 5,
      items: {
        kind: "leaf",
        schema: { enum: ["video", "audio", "image", "text", "graphics"] },
      },
    },
  },
  entityTypes: {
    check: (value) =>
      Array.isArray(value) &&
      value.length <= TIMELINE_QUERY_ENTITY_TYPES.length &&
      value.every((item) =>
        (TIMELINE_QUERY_ENTITY_TYPES as readonly unknown[]).includes(item),
      ),
    describe: "an array of supported timeline entity types",
    emits: {
      kind: "array",
      maxItems: TIMELINE_QUERY_ENTITY_TYPES.length,
      items: { kind: "leaf", schema: { enum: TIMELINE_QUERY_ENTITY_TYPES } },
    },
  },
  fields: {
    check: (value) =>
      Array.isArray(value) &&
      value.length <= TIMELINE_QUERY_FIELDS.length &&
      value.every((item) =>
        (TIMELINE_QUERY_FIELDS as readonly unknown[]).includes(item),
      ),
    describe: "an allowlisted field projection",
    emits: {
      kind: "array",
      maxItems: TIMELINE_QUERY_FIELDS.length,
      items: { kind: "leaf", schema: { enum: TIMELINE_QUERY_FIELDS } },
    },
  },
  limit: {
    check: (value) =>
      isPositiveInteger(value) && (value as number) <= MAX_TIMELINE_QUERY_LIMIT,
    describe: `an integer in [1, ${MAX_TIMELINE_QUERY_LIMIT}]`,
    emits: {
      kind: "leaf",
      schema: { type: "integer", minimum: 1, maximum: MAX_TIMELINE_QUERY_LIMIT },
    },
  },
  cursor: {
    check: isNonEmptyString,
    describe: "a non-empty opaque cursor",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  includeNeighbors: {
    check: (value) =>
      isNonNegativeInteger(value) &&
      (value as number) <= MAX_TIMELINE_QUERY_NEIGHBORS,
    describe: `an integer in [0, ${MAX_TIMELINE_QUERY_NEIGHBORS}]`,
    emits: {
      kind: "leaf",
      schema: {
        type: "integer",
        minimum: 0,
        maximum: MAX_TIMELINE_QUERY_NEIGHBORS,
      },
    },
  },
};

/* ------------------------------------------------------------------ */
/* editor.control (ephemeral live-editor context)                     */

export const EDITOR_CONTROL_TARGET_SCHEMA: ObjectSchema = {
  kind: {
    check: oneOf(["clip", "text", "media"] as const),
    describe: '"clip", "text" or "media"',
    required: true,
    emits: {
      kind: "leaf",
      schema: { enum: ["clip", "text", "media"] },
    },
  },
  id: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/**
 * A single closed control entry point keeps transport discovery compact while
 * retaining clear verbs in the action discriminator. Cross-field rules (for
 * example, seek requiring timeSeconds) remain runtime validation below.
 */
export const EDITOR_CONTROL_SCHEMA: ObjectSchema = {
  action: {
    check: oneOf(["play", "pause", "seek", "select"] as const),
    describe: '"play", "pause", "seek" or "select"',
    required: true,
    emits: {
      kind: "leaf",
      schema: { enum: ["play", "pause", "seek", "select"] },
    },
  },
  timeSeconds: {
    check: isNonNegativeNumber,
    describe: "a finite number >= 0",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  targets: {
    check: (value) => Array.isArray(value),
    describe: "an array of target objects",
    emits: {
      kind: "array",
      minItems: 1,
      items: { kind: "anyOfObjects", variants: [EDITOR_CONTROL_TARGET_SCHEMA] },
    },
  },
  selectionMode: {
    check: oneOf(["replace", "add"] as const),
    describe: '"replace" or "add"',
    emits: { kind: "leaf", schema: { enum: ["replace", "add"] } },
  },
  expectedContextRevision: {
    check: isNonNegativeInteger,
    describe: "a non-negative integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
};

/** Closed op declarations referenced by the edit.apply union, re-exported. */
export const EDIT_OP_SCHEMAS: Readonly<
  Record<(typeof EDIT_OP_TYPES)[number], ObjectSchema>
> = {
  "track.add": TRACK_ADD_SCHEMA,
  "track.update": TRACK_UPDATE_SCHEMA,
  "clip.add": CLIP_ADD_SCHEMA,
  "clip.move": CLIP_MOVE_SCHEMA,
  "clip.trim": CLIP_TRIM_SCHEMA,
  "clip.split": CLIP_SPLIT_SCHEMA,
  "clip.duplicate": CLIP_DUPLICATE_SCHEMA,
  "clip.rippleDelete": CLIP_RIPPLE_DELETE_SCHEMA,
  "text.create": TEXT_CREATE_SCHEMA,
  "text.update": TEXT_UPDATE_SCHEMA,
  "text.delete": TEXT_DELETE_SCHEMA,
  "svg.create": SVG_CREATE_SCHEMA,
  "svg.update": SVG_UPDATE_SCHEMA,
  "svg.remove": SVG_REMOVE_SCHEMA,
  "clip.setSpeed": CLIP_SET_SPEED_SCHEMA,
  "clip.setReverse": CLIP_SET_REVERSE_SCHEMA,
  "clip.setTransform": CLIP_SET_TRANSFORM_SCHEMA,
  "clip.setVolume": CLIP_SET_VOLUME_SCHEMA,
  "clip.setFade": CLIP_SET_FADE_SCHEMA,
  "clip.remove": CLIP_REMOVE_SCHEMA,
  "transition.add": TRANSITION_ADD_SCHEMA,
  "transition.update": TRANSITION_UPDATE_SCHEMA,
  "transition.remove": TRANSITION_REMOVE_SCHEMA,
  "track.remove": TRACK_REMOVE_SCHEMA,
  "media.remove": MEDIA_REMOVE_SCHEMA,
  "marker.add": MARKER_ADD_SCHEMA,
  "marker.remove": MARKER_REMOVE_SCHEMA,
  "requirement.update": REQUIREMENT_UPDATE_SCHEMA,
  "subtitle.importSrt": SUBTITLE_IMPORT_SRT_SCHEMA,
  "clip.setColorGrade": CLIP_SET_COLOR_GRADE_SCHEMA,
  "clip.setKeyframes": CLIP_SET_KEYFRAMES_SCHEMA,
  "clip.applyReframe": CLIP_APPLY_REFRAME_SCHEMA,
  "reference.setComparison": REFERENCE_SET_COMPARISON_SCHEMA,
  "reference.clearComparison": REFERENCE_CLEAR_COMPARISON_SCHEMA,
  "media.replace": MEDIA_REPLACE_SCHEMA,
  "media.relink": MEDIA_RELINK_SCHEMA,
  "media.rename": MEDIA_RENAME_SCHEMA,
  "media.setProduction": MEDIA_PRODUCTION_SCHEMA,
  "clip.setChromaKey": CLIP_SET_CHROMA_KEY_SCHEMA,
  "clip.setNoiseReduction": CLIP_SET_NOISE_REDUCTION_SCHEMA,
  "clip.setDucking": CLIP_SET_DUCKING_SCHEMA,
  "clip.setBackgroundRemoval": CLIP_SET_BACKGROUND_REMOVAL_SCHEMA,
  "clip.addVideoEffect": CLIP_ADD_VIDEO_EFFECT_SCHEMA,
  "workAsset.capture": WORK_ASSET_CAPTURE_SCHEMA,
  "workAsset.rename": WORK_ASSET_RENAME_SCHEMA,
  "workAsset.delete": WORK_ASSET_DELETE_SCHEMA,
  "workAsset.instantiate": WORK_ASSET_INSTANTIATE_SCHEMA,
};

/**
 * Keeps one edit transaction comfortably below ActionHistory's 1000-entry
 * retention window, even when one facade op expands to multiple core actions.
 */
export const MAX_EDIT_OPS_PER_BATCH = 100;

export const EDIT_APPLY_SCHEMA: ObjectSchema = {
  ops: {
    check: (v) => Array.isArray(v) && v.length <= MAX_EDIT_OPS_PER_BATCH,
    describe: `an array of at most ${MAX_EDIT_OPS_PER_BATCH} ops`,
    required: true,
    emits: {
      kind: "array",
      minItems: 1,
      maxItems: MAX_EDIT_OPS_PER_BATCH,
      items: {
        kind: "anyOfObjects",
        variants: EDIT_OP_TYPES.map((opType) => EDIT_OP_SCHEMAS[opType]),
      },
    },
  },
  expectedRevision: {
    check: isNonNegativeInteger,
    describe: "a non-negative integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  expectedContextRevision: {
    check: isNonNegativeInteger,
    describe: "a non-negative integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/** Same closed ops declaration as edit.apply, without mutation-only idempotency. */
export const EDIT_VALIDATE_SCHEMA: ObjectSchema = {
  ops: EDIT_APPLY_SCHEMA.ops,
  expectedRevision: EDIT_APPLY_SCHEMA.expectedRevision,
  expectedContextRevision: EDIT_APPLY_SCHEMA.expectedContextRevision,
};

export const MAX_HISTORY_SUMMARY_ENTRIES = 100;

export const HISTORY_GET_SCHEMA: ObjectSchema = {
  limit: {
    check: (value) =>
      isPositiveInteger(value) &&
      (value as number) <= MAX_HISTORY_SUMMARY_ENTRIES,
    describe: `an integer in [1, ${MAX_HISTORY_SUMMARY_ENTRIES}]`,
    emits: {
      kind: "leaf",
      schema: {
        type: "integer",
        minimum: 1,
        maximum: MAX_HISTORY_SUMMARY_ENTRIES,
      },
    },
  },
};

export const HISTORY_CONTROL_SCHEMA: ObjectSchema = {
  action: {
    check: oneOf(["undo", "redo"] as const),
    describe: '"undo" or "redo"',
    required: true,
    emits: { kind: "leaf", schema: { enum: ["undo", "redo"] } },
  },
  expectedRevision: {
    check: isNonNegativeInteger,
    describe: "a non-negative integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/* ------------------------------------------------------------------ */
/* preview.render_frame / export.start                                 */
/* ------------------------------------------------------------------ */

/** Rasters/encoders need even dimensions; 8192 caps browser-tab memory. */
export const isEvenDimension = (v: unknown): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= 2 && v <= 8192 && v % 2 === 0;

export const isUnitInterval = (v: unknown): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

// Evenness is NOT expressible in the emitted schema (no multipleOf: 2 on
// integers without floating-point traps) — the emitted bound is a superset
// and the validator remains the only authority for it.
const EVEN_DIMENSION_EMITS = {
  kind: "leaf",
  schema: { type: "integer", minimum: 2, maximum: 8192 },
} as const;

export const PREVIEW_RENDER_FRAME_SCHEMA: ObjectSchema = {
  timeSec: {
    check: isNonNegativeNumber,
    describe: "a non-negative finite number",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  width: {
    check: isEvenDimension,
    describe: "an even integer in [2, 8192]",
    emits: EVEN_DIMENSION_EMITS,
  },
  height: {
    check: isEvenDimension,
    describe: "an even integer in [2, 8192]",
    emits: EVEN_DIMENSION_EMITS,
  },
  expectedRevision: {
    check: isNonNegativeInteger,
    describe: "a non-negative integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/** Explicit range for visual.inspect; start < end is a runtime cross-field check. */
export const VISUAL_INSPECT_RANGE_SCHEMA: ObjectSchema = {
  startSec: {
    check: isNonNegativeNumber,
    describe: "a non-negative finite number",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  endSec: {
    check: isNonNegativeNumber,
    describe: "a non-negative finite number",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
};

/** Visual inspection intentionally uses a much smaller raster ceiling than preview. */
export const isVisualDimension = (v: unknown): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= 2 && v <= 1024 && v % 2 === 0;

const VISUAL_DIMENSION_EMITS = {
  kind: "leaf",
  schema: { type: "integer", minimum: 2, maximum: 1024 },
} as const;

/**
 * Read-only visual context: exactly one clip id or explicit time range is
 * required at runtime. A runtime-native contact sheet is optional; the
 * fallback is a set of individually verified PNG frame artifacts.
 */
export const VISUAL_INSPECT_SCHEMA: ObjectSchema = {
  clipId: {
    check: isNonEmptyString,
    describe: "a non-empty timeline clip id",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  timeRange: {
    check: isPlainObject,
    describe:
      'an object {"startSec": <number ≥ 0>, "endSec": <number > startSec>} in timeline seconds',
    emits: { kind: "object", schema: VISUAL_INSPECT_RANGE_SCHEMA },
  },
  sampleCount: {
    check: (v) => isPositiveInteger(v) && (v as number) <= 12,
    describe: "an integer in [1, 12]",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1, maximum: 12 } },
  },
  width: {
    check: isVisualDimension,
    describe: "an even integer in [2, 1024]",
    emits: VISUAL_DIMENSION_EMITS,
  },
  height: {
    check: isVisualDimension,
    describe: "an even integer in [2, 1024]",
    emits: VISUAL_DIMENSION_EMITS,
  },
  maxFrameBytes: {
    check: isFrameBudget,
    describe: "an integer in [32768, 8388608] — per-frame byte budget (default 1572864)",
    emits: FRAME_BUDGET_EMITS,
  },
  expectedRevision: {
    check: isNonNegativeInteger,
    describe: "a non-negative integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const ANALYSIS_LIST_SCHEMA: ObjectSchema = {
  mediaId: {
    check: isNonEmptyString,
    describe: "only records whose subject is this media id",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  limit: {
    check: isPositiveInteger,
    describe: "an integer ≥1 bounding the listing (newest first)",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
};

export const ANALYSIS_GET_SCHEMA: ObjectSchema = {
  recordId: {
    check: isNonEmptyString,
    describe: 'an analysis record id ("analysis-<uuid>") from analysis.list',
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const PREVIEW_RENDER_COMPARISON_SCHEMA: ObjectSchema = {
  timeSec: {
    check: isNonNegativeNumber,
    describe: "timeline time (seconds) to compare at",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  width: {
    check: isEvenDimension,
    describe: "an even raster width; defaults to the project width",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 2 } },
  },
  height: {
    check: isEvenDimension,
    describe: "an even raster height; defaults to the project height",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 2 } },
  },
  layout: {
    check: oneOf(["side-by-side", "overlay"]),
    describe: "render-time layout override; defaults to the shared config's layout",
    emits: { kind: "leaf", schema: { enum: ["side-by-side", "overlay"] } },
  },
  maxFrameBytes: {
    check: isFrameBudget,
    describe: "an integer in [32768, 8388608] — per-frame byte budget (default 1572864)",
    emits: FRAME_BUDGET_EMITS,
  },
  expectedRevision: {
    check: isNonNegativeInteger,
    describe: "a non-negative integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const EXPORT_COMPARISON_SCHEMA: ObjectSchema = {
  startSec: {
    check: isNonNegativeNumber,
    describe: "comparison range start (timeline seconds)",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  endSec: {
    check: isNonNegativeNumber,
    describe: "comparison range end (timeline seconds); must exceed startSec",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
};

/** The GUI ExportDialog's upscale tiers, closed (engine UpscaleQuality). */
export const EXPORT_UPSCALING_SCHEMA: ObjectSchema = {
  enabled: {
    check: isBoolean,
    describe: "a boolean",
    required: true,
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
  quality: {
    check: oneOf(["fast", "balanced", "quality"] as const),
    describe: 'one of "fast", "balanced", "quality" (defaults to "balanced")',
    emits: { kind: "leaf", schema: { enum: ["fast", "balanced", "quality"] } },
  },
};

/**
 * Nested-object recursion for the upscaling bundle (validateObject does not
 * descend into `emits` declarations by itself): the same closed declaration
 * drives both the emitted schema and this runtime check.
 */
export const isExportUpscalingSettings = (v: unknown): boolean => {
  if (!isPlainObject(v)) return false;
  try {
    validateObject(v, EXPORT_UPSCALING_SCHEMA, "settings.upscaling");
    return true;
  } catch {
    return false;
  }
};

export const EXPORT_SETTINGS_SCHEMA: ObjectSchema = {
  format: {
    check: oneOf(["mp4"]),
    describe: '"mp4" (the only container in this slice)',
    emits: { kind: "leaf", schema: { const: "mp4" } },
  },
  codec: {
    check: oneOf(["h264"]),
    describe: '"h264" (the only codec in this slice)',
    emits: { kind: "leaf", schema: { const: "h264" } },
  },
  width: {
    check: isEvenDimension,
    describe: "an even integer in [2, 8192]",
    emits: EVEN_DIMENSION_EMITS,
  },
  height: {
    check: isEvenDimension,
    describe: "an even integer in [2, 8192]",
    emits: EVEN_DIMENSION_EMITS,
  },
  frameRate: {
    check: isPositiveNumber,
    describe: "a positive finite number",
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
  videoBitrateKbps: {
    check: isPositiveInteger,
    describe: "a positive integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
  upscaling: {
    check: isExportUpscalingSettings,
    describe:
      "upscale pass on the export render ({enabled required, quality fast|balanced|quality}); needs WebGPU and an export size larger than the project canvas — inactive attempts are disclosed on job.status, never silent",
    emits: { kind: "object", schema: EXPORT_UPSCALING_SCHEMA },
  },
};

export const EXPORT_START_SCHEMA: ObjectSchema = {
  settings: {
    check: isPlainObject,
    describe: "an object",
    emits: { kind: "object", schema: EXPORT_SETTINGS_SCHEMA },
  },
  comparison: {
    check: isPlainObject,
    describe: "reference-comparison export for an explicit timeline range (requires the shared referenceComparison config)",
    emits: { kind: "object", schema: EXPORT_COMPARISON_SCHEMA },
  },
  destinationPath: {
    check: isNonEmptyString,
    describe:
      'an absolute .mp4 path inside a job deliverables directory ("<deliveryRoot>/jobs/<slug>/output/<name>.mp4")',
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  expectedRevision: {
    check: isNonNegativeInteger,
    describe: "a non-negative integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/* ------------------------------------------------------------------ */
/* job.status / job.cancel                                             */
/* ------------------------------------------------------------------ */

export const JOB_PARAMS_SCHEMA: ObjectSchema = {
  jobId: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/* ------------------------------------------------------------------ */
/* verify.artifact                                                     */
/* ------------------------------------------------------------------ */

export const VERIFY_EXPECT_SCHEMA: ObjectSchema = {
  container: {
    check: oneOf(["mp4"]),
    describe: '"mp4"',
    emits: { kind: "leaf", schema: { const: "mp4" } },
  },
  videoCodec: {
    check: oneOf(["h264"]),
    describe: '"h264"',
    emits: { kind: "leaf", schema: { const: "h264" } },
  },
  width: {
    check: isPositiveInteger,
    describe: "a positive integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
  height: {
    check: isPositiveInteger,
    describe: "a positive integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
  durationSec: {
    check: isPositiveNumber,
    describe: "a positive finite number",
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
  durationToleranceSec: {
    check: isPositiveNumber,
    describe: "a positive finite number",
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
};

export const VERIFY_REGION_SCHEMA: ObjectSchema = {
  x: {
    check: isUnitInterval,
    describe: "a number in [0, 1]",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
  y: {
    check: isUnitInterval,
    describe: "a number in [0, 1]",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
  // x+width ≤ 1 / y+height ≤ 1 are cross-field predicates enforced in
  // verifyArtifact — deliberately NOT expressible in the emitted schema.
  width: {
    check: isUnitInterval,
    describe: "a number in [0, 1]",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
  height: {
    check: isUnitInterval,
    describe: "a number in [0, 1]",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
};

export const VERIFY_COMPARE_SCHEMA: ObjectSchema = {
  referencePath: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  timeSec: {
    check: isNonNegativeNumber,
    describe: "a non-negative finite number",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  referenceTimeSec: {
    check: isNonNegativeNumber,
    describe: "a non-negative finite number",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  region: {
    check: isPlainObject,
    describe: "an object",
    emits: { kind: "object", schema: VERIFY_REGION_SCHEMA },
  },
  mode: {
    check: oneOf(["similar", "different"]),
    describe: '"similar" or "different"',
    required: true,
    emits: { kind: "leaf", schema: { enum: ["similar", "different"] } },
  },
  maxMeanAbsDiff: {
    check: isFiniteNumber,
    describe: "a finite number",
    emits: { kind: "leaf", schema: { type: "number" } },
  },
  minMeanAbsDiff: {
    check: isFiniteNumber,
    describe: "a finite number",
    emits: { kind: "leaf", schema: { type: "number" } },
  },
  minChangedPixelsRatio: {
    check: isUnitInterval,
    describe: "a number in [0, 1]",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } },
  },
  colorMatrix: {
    check: oneOf(["bt601", "bt709"]),
    describe: '"bt601" or "bt709" — explicit YUV→RGB matrix applied to BOTH sides of the comparison (docs/COLOR.md)',
    emits: { kind: "leaf", schema: { enum: ["bt601", "bt709"] } },
  },
  targetColorMatrix: {
    check: oneOf(["bt601", "bt709"]),
    describe: '"bt601" or "bt709" — per-side override for the artifact under verification (use for mixed-matrix comparisons; overrides colorMatrix)',
    emits: { kind: "leaf", schema: { enum: ["bt601", "bt709"] } },
  },
  referenceColorMatrix: {
    check: oneOf(["bt601", "bt709"]),
    describe: '"bt601" or "bt709" — per-side override for the reference (use for mixed-matrix comparisons; overrides colorMatrix)',
    emits: { kind: "leaf", schema: { enum: ["bt601", "bt709"] } },
  },
};

export const VERIFY_ARTIFACT_SCHEMA: ObjectSchema = {
  path: {
    check: isNonEmptyString,
    describe: "a non-empty string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  expect: {
    check: isPlainObject,
    describe: "an object",
    emits: { kind: "object", schema: VERIFY_EXPECT_SCHEMA },
  },
  compare: {
    check: isPlainObject,
    describe: "an object",
    emits: { kind: "object", schema: VERIFY_COMPARE_SCHEMA },
  },
};

/* ------------------------------------------------------------------ */
/* material.* — user-level material library (live-only)                */
/*                                                                     */
/* Kind-specific requirements (media needs filePath+mediaType, segment  */
/* needs parent+range, link needs url, method needs prompt) stay in the */
/* renderer's canonical validation; the emitted schema is a boundary    */
/* superset filter, same policy as the rest of the facade.              */
/* ------------------------------------------------------------------ */

const materialTagsField = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_MATERIAL_TAGS &&
  value.every((item) => typeof item === "string" && item.length > 0);

const materialStepsField = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_MATERIAL_METHOD_STEPS &&
  value.every((item) => typeof item === "string" && item.length > 0);

export const MATERIAL_LIST_SCHEMA: ObjectSchema = {
  kind: {
    check: (v) => (MATERIAL_KINDS as readonly unknown[]).includes(v),
    describe: '"media" | "segment" | "link" | "method"',
    emits: { kind: "leaf", schema: { enum: MATERIAL_KINDS } },
  },
  status: {
    check: (v) => v === "inbox" || v === "organized",
    describe: '"inbox" | "organized"',
    emits: { kind: "leaf", schema: { enum: ["inbox", "organized"] } },
  },
  tag: {
    check: isNonEmptyString,
    describe: "a non-empty tag string",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  query: {
    check: (v) => typeof v === "string" && v.length <= 200,
    describe: "a search string of at most 200 characters (matched over title, notes, summary, tags, url and method text)",
    emits: { kind: "leaf", schema: { type: "string", maxLength: 200 } },
  },
  page: {
    check: isPositiveInteger,
    describe: "a positive 1-based page number",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
  pageSize: {
    check: (v) => isPositiveInteger(v) && (v as number) <= MATERIAL_LIBRARY_LIMITS.maxPageSize,
    describe: `a positive page size of at most ${MATERIAL_LIBRARY_LIMITS.maxPageSize}`,
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1, maximum: MATERIAL_LIBRARY_LIMITS.maxPageSize } },
  },
  sort: {
    check: (v) => v === "updated" || v === "created" || v === "title",
    describe: '"updated" (default) | "created" | "title"',
    emits: { kind: "leaf", schema: { enum: ["updated", "created", "title"] } },
  },
};

export const MATERIAL_GET_SCHEMA: ObjectSchema = {
  id: {
    check: isNonEmptyString,
    describe: "a non-empty material id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const MATERIAL_CREATE_SCHEMA: ObjectSchema = {
  kind: {
    check: (v) => (MATERIAL_KINDS as readonly unknown[]).includes(v),
    describe: '"media" | "segment" | "link" | "method"',
    required: true,
    emits: { kind: "leaf", schema: { enum: MATERIAL_KINDS } },
  },
  title: {
    check: isNonEmptyString,
    describe: "a non-empty title (defaults per kind: file name, url host, skill name)",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: 300 } },
  },
  tags: {
    check: materialTagsField,
    describe: `an array of at most ${MAX_MATERIAL_TAGS} non-empty tag strings`,
    emits: {
      kind: "array",
      maxItems: MAX_MATERIAL_TAGS,
      items: { kind: "leaf", schema: { type: "string", minLength: 1 } },
    },
  },
  organizeStatus: {
    check: (v) => v === "inbox" || v === "organized",
    describe: '"inbox" (default) | "organized"',
    emits: { kind: "leaf", schema: { enum: ["inbox", "organized"] } },
  },
  aiSummary: {
    check: (v) => typeof v === "string" && v.length <= MAX_MATERIAL_TEXT_LENGTH,
    describe: `an agent-written summary of at most ${MAX_MATERIAL_TEXT_LENGTH} characters (user notes are never writable here)`,
    emits: { kind: "leaf", schema: { type: "string", maxLength: MAX_MATERIAL_TEXT_LENGTH } },
  },
  origin: {
    check: (v) => typeof v === "string" && v.length <= 500,
    describe: "a free-form origin note of at most 500 characters",
    emits: { kind: "leaf", schema: { type: "string", maxLength: 500 } },
  },
  filePath: {
    check: isNonEmptyString,
    describe: "media: an absolute local path inside one of the configured media roots",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  mediaType: {
    check: (v) => (MATERIAL_MEDIA_TYPES as readonly unknown[]).includes(v),
    describe: 'media: "video" | "audio" | "image"',
    emits: { kind: "leaf", schema: { enum: MATERIAL_MEDIA_TYPES } },
  },
  parentMaterialId: {
    check: isNonEmptyString,
    describe: "segment: the parent media material id",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  startSec: {
    check: isNonNegativeNumber,
    describe: "segment: non-negative start seconds",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  endSec: {
    check: isPositiveNumber,
    describe: "segment: positive end seconds (0 <= startSec < endSec within the parent duration)",
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
  url: {
    check: isNonEmptyString,
    describe: "link: an http(s) URL",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  description: {
    check: (v) => typeof v === "string" && v.length <= MAX_MATERIAL_TEXT_LENGTH,
    describe: "link: a note about the URL's content",
    emits: { kind: "leaf", schema: { type: "string", maxLength: MAX_MATERIAL_TEXT_LENGTH } },
  },
  skillName: {
    check: isNonEmptyString,
    describe: "method: an optional skill/tool identifier",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: 200 } },
  },
  prompt: {
    check: (v) => typeof v === "string" && v.length <= MAX_MATERIAL_TEXT_LENGTH,
    describe: "method: the reusable prompt (non-empty)",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: MAX_MATERIAL_TEXT_LENGTH } },
  },
  steps: {
    check: materialStepsField,
    describe: `method: an array of at most ${MAX_MATERIAL_METHOD_STEPS} step descriptions`,
    emits: {
      kind: "array",
      maxItems: MAX_MATERIAL_METHOD_STEPS,
      items: { kind: "leaf", schema: { type: "string", minLength: 1 } },
    },
  },
  inputs: {
    check: materialStepsField,
    describe: `method: an array of at most ${MAX_MATERIAL_METHOD_STEPS} input requirement descriptions`,
    emits: {
      kind: "array",
      maxItems: MAX_MATERIAL_METHOD_STEPS,
      items: { kind: "leaf", schema: { type: "string", minLength: 1 } },
    },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty retry key; retries replay the committed result instead of duplicating",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const MATERIAL_BATCH_UPDATE_ITEM_SCHEMA: ObjectSchema = {
  id: {
    check: isNonEmptyString,
    describe: "a non-empty material id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  title: {
    check: isNonEmptyString,
    describe: "a non-empty title",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: 300 } },
  },
  aiSummary: {
    check: (v) => typeof v === "string" && v.length <= MAX_MATERIAL_TEXT_LENGTH,
    describe: `an agent-written summary of at most ${MAX_MATERIAL_TEXT_LENGTH} characters`,
    emits: { kind: "leaf", schema: { type: "string", maxLength: MAX_MATERIAL_TEXT_LENGTH } },
  },
  tags: {
    check: materialTagsField,
    describe: `an array of at most ${MAX_MATERIAL_TAGS} non-empty tag strings (replaces existing tags)`,
    emits: {
      kind: "array",
      maxItems: MAX_MATERIAL_TAGS,
      items: { kind: "leaf", schema: { type: "string", minLength: 1 } },
    },
  },
  organizeStatus: {
    check: (v) => v === "inbox" || v === "organized",
    describe: '"inbox" | "organized"',
    emits: { kind: "leaf", schema: { enum: ["inbox", "organized"] } },
  },
  description: {
    check: (v) => typeof v === "string" && v.length <= MAX_MATERIAL_TEXT_LENGTH,
    describe: "link materials only: a note about the URL's content",
    emits: { kind: "leaf", schema: { type: "string", maxLength: MAX_MATERIAL_TEXT_LENGTH } },
  },
  expectedRevision: {
    check: isNonNegativeInteger,
    describe: "optional CAS guard: the material record's revision observed by the caller",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
};

export const MATERIAL_UPDATE_SCHEMA: ObjectSchema = {
  ...MATERIAL_BATCH_UPDATE_ITEM_SCHEMA,
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty retry key",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const MATERIAL_BATCH_UPDATE_SCHEMA: ObjectSchema = {
  updates: {
    check: (value) =>
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= MATERIAL_LIBRARY_LIMITS.maxBatchItems &&
      value.every((item) => {
        if (!isPlainObject(item)) return false;
        for (const [key, rule] of Object.entries(MATERIAL_BATCH_UPDATE_ITEM_SCHEMA)) {
          if (rule.required && !(key in item)) return false;
          if (key in item && !rule.check((item as Record<string, unknown>)[key])) return false;
        }
        return true;
      }),
    describe: `a non-empty array of at most ${MATERIAL_LIBRARY_LIMITS.maxBatchItems} per-material updates`,
    required: true,
    emits: {
      kind: "array",
      minItems: 1,
      maxItems: MATERIAL_LIBRARY_LIMITS.maxBatchItems,
      items: { kind: "object", schema: MATERIAL_BATCH_UPDATE_ITEM_SCHEMA },
    },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty retry key; retries replay the committed result instead of re-applying",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const MATERIAL_REMOVE_SCHEMA: ObjectSchema = {
  id: {
    check: isNonEmptyString,
    describe: "a non-empty material id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  force: {
    check: (v) => typeof v === "boolean",
    describe: "required to remove a material that still has project references (project copies are unaffected)",
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty retry key",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const MATERIAL_ATTACH_SCHEMA: ObjectSchema = {
  materialId: {
    check: isNonEmptyString,
    describe: "a non-empty material id (media or segment)",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  startSec: {
    check: isNonNegativeNumber,
    describe: "media materials only: optional range start seconds",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  endSec: {
    check: isPositiveNumber,
    describe: "media materials only: optional range end seconds (segments always use their stored range)",
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
  addClip: {
    check: (v) => typeof v === "boolean",
    describe: "add a timeline clip (default: true for segments/ranges, false for whole-media imports)",
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
  expectedRevision: {
    check: isNonNegativeInteger,
    describe: "PROJECT revision CAS; an omitted value is guarded with the current revision",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty retry key; retries replay instead of double-importing",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const MATERIAL_UNDO_SCHEMA: ObjectSchema = {
  entryId: {
    check: isNonEmptyString,
    describe: "a journal entry id; default: the latest undoable library change",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty retry key; strongly recommended — a retried undo without one would undo the NEXT entry",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/* ------------------------------------------------------------------ */
/* font.* (user-level custom fonts)                                    */
/* ------------------------------------------------------------------ */

export const FONT_UPLOAD_SCHEMA: ObjectSchema = {
  name: {
    check: (v) => isNonEmptyString(v) && (v as string).length <= FONT_LIBRARY_LIMITS.maxNameLength,
    describe: `optional desired font family of at most ${FONT_LIBRARY_LIMITS.maxNameLength} characters; the response reports the ACTUAL family (a duplicate base name gets a numeric suffix, matching the GUI)`,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: FONT_LIBRARY_LIMITS.maxNameLength } },
  },
  filePath: {
    check: isNonEmptyString,
    describe: "an absolute local path inside one of the configured media roots (exactly one of filePath/dataBase64)",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  dataBase64: {
    check: isNonEmptyString,
    describe: `font bytes base64-encoded; decoded size at most ${FONT_LIBRARY_LIMITS.maxFontBytes} bytes (exactly one of filePath/dataBase64)`,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/* ------------------------------------------------------------------ */
/* preset.* (user-level custom presets)                                */
/*                                                                     */
/* The payload bundle gets only a plain-object shape check here; the   */
/* emitted schema leaf stays open (no additionalProperties key), so    */
/* schema-validating clients can send any bundle. Deep per-kind        */
/* validation (whitelists, ranges, no shader, no                       */
/* external references) runs in the session body against the same      */
/* core validator the GUI uses, and again renderer-side at persist.    */
/* ------------------------------------------------------------------ */

const presetTagsField = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= PRESET_LIBRARY_LIMITS.maxTags &&
  value.every((item) => typeof item === "string" && item.trim().length > 0);

export const PRESET_LIST_SCHEMA: ObjectSchema = {
  kind: {
    check: (v) => (PRESET_KINDS as readonly unknown[]).includes(v),
    describe: '"text" | "effect" | "transition" | "graphics"',
    emits: { kind: "leaf", schema: { enum: PRESET_KINDS } },
  },
  query: {
    check: (v) => typeof v === "string" && v.length <= PRESET_LIBRARY_LIMITS.maxQueryLength,
    describe: `a search string of at most ${PRESET_LIBRARY_LIMITS.maxQueryLength} characters (matched over name and tags)`,
    emits: { kind: "leaf", schema: { type: "string", maxLength: PRESET_LIBRARY_LIMITS.maxQueryLength } },
  },
  includePayload: {
    check: isBoolean,
    describe: "embed each preset's full payload in the list items (default: metadata only)",
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
};

export const PRESET_GET_SCHEMA: ObjectSchema = {
  id: {
    check: isNonEmptyString,
    describe: "a non-empty preset id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const PRESET_CREATE_SCHEMA: ObjectSchema = {
  kind: {
    check: (v) => (PRESET_KINDS as readonly unknown[]).includes(v),
    describe: '"text" | "effect" | "transition" | "graphics"',
    required: true,
    emits: { kind: "leaf", schema: { enum: PRESET_KINDS } },
  },
  name: {
    check: (v) => isNonEmptyString(v) && (v as string).trim().length <= PRESET_LIBRARY_LIMITS.maxNameLength,
    describe: `a display name of 1..${PRESET_LIBRARY_LIMITS.maxNameLength} characters (duplicate names are allowed; ids are identity)`,
    required: true,
    emits: {
      kind: "leaf",
      schema: { type: "string", minLength: 1, maxLength: PRESET_LIBRARY_LIMITS.maxNameLength },
    },
  },
  payload: {
    check: isPlainObject,
    describe: "the kind-specific parameter bundle (deep per-kind validation applies)",
    required: true,
    emits: { kind: "leaf", schema: { type: "object" } },
  },
  tags: {
    check: presetTagsField,
    describe: `an array of at most ${PRESET_LIBRARY_LIMITS.maxTags} non-empty tag strings`,
    emits: {
      kind: "array",
      maxItems: PRESET_LIBRARY_LIMITS.maxTags,
      items: { kind: "leaf", schema: { type: "string", minLength: 1 } },
    },
  },
  builtinBaseId: {
    check: (v) => isNonEmptyString(v) && (v as string).length <= 160,
    describe: "optional provenance marker when derived from a built-in (e.g. \"text:Heading\")",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: 160 } },
  },
  thumbnailDataUrl: {
    check: isNonEmptyString,
    describe: "optional inline thumbnail as a data:image/png;base64 URL (<=64 KiB decoded, <=256x160)",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty retry key; retries replay the committed result instead of duplicating",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const PRESET_UPDATE_SCHEMA: ObjectSchema = {
  id: {
    check: isNonEmptyString,
    describe: "a non-empty preset id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  name: {
    check: (v) => isNonEmptyString(v) && (v as string).trim().length <= PRESET_LIBRARY_LIMITS.maxNameLength,
    describe: `a new display name of 1..${PRESET_LIBRARY_LIMITS.maxNameLength} characters`,
    emits: {
      kind: "leaf",
      schema: { type: "string", minLength: 1, maxLength: PRESET_LIBRARY_LIMITS.maxNameLength },
    },
  },
  tags: {
    check: presetTagsField,
    describe: `an array of at most ${PRESET_LIBRARY_LIMITS.maxTags} non-empty tag strings (replaces existing tags)`,
    emits: {
      kind: "array",
      maxItems: PRESET_LIBRARY_LIMITS.maxTags,
      items: { kind: "leaf", schema: { type: "string", minLength: 1 } },
    },
  },
  payload: {
    check: isPlainObject,
    describe: "a replacement parameter bundle (deep per-kind validation applies)",
    emits: { kind: "leaf", schema: { type: "object" } },
  },
  thumbnailDataUrl: {
    check: isNonEmptyString,
    describe: "a replacement inline PNG thumbnail data URL (clearing the thumbnail is not an agent operation)",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  expectedRevision: {
    check: isNonNegativeInteger,
    describe: "optional CAS guard: the preset record's revision observed by the caller; a mismatch fails CONFLICT",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty retry key",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const PRESET_REMOVE_SCHEMA: ObjectSchema = {
  id: {
    check: isNonEmptyString,
    describe: "a non-empty preset id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty retry key",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/**
 * Closed apply-target variants (the one nested anyOf below preset.apply,
 * discriminated by `kind` like edit.apply's op target union). The runtime
 * structural check stays a superset: the session body validates the shape
 * and the renderer pairs the target kind with the payload kind.
 */
export const PRESET_TARGET_TEXT_SCHEMA: ObjectSchema = {
  kind: {
    check: (v) => v === "text",
    describe: '"text"',
    required: true,
    emits: { kind: "leaf", schema: { const: "text" } },
  },
  mode: {
    check: (v) => v === "updateStyle",
    describe: '"updateStyle" — create a text clip first (edit.apply text.create), then restyle it',
    required: true,
    emits: { kind: "leaf", schema: { const: "updateStyle" } },
  },
  clipId: {
    check: isNonEmptyString,
    describe: "the text clip to restyle",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const PRESET_TARGET_EFFECT_SCHEMA: ObjectSchema = {
  kind: {
    check: (v) => v === "effect",
    describe: '"effect"',
    required: true,
    emits: { kind: "leaf", schema: { const: "effect" } },
  },
  clipIds: {
    check: (v) =>
      Array.isArray(v) && v.length > 0 && v.every((id) => typeof id === "string" && id.length > 0),
    describe: "every timeline clip the effect stack applies to",
    required: true,
    emits: {
      kind: "array",
      minItems: 1,
      items: { kind: "leaf", schema: { type: "string", minLength: 1 } },
    },
  },
};

export const PRESET_TARGET_TRANSITION_SCHEMA: ObjectSchema = {
  kind: {
    check: (v) => v === "transition",
    describe: '"transition"',
    required: true,
    emits: { kind: "leaf", schema: { const: "transition" } },
  },
  clipAId: {
    check: isNonEmptyString,
    describe: "the clip whose out-point the transition sits on",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  clipBId: {
    check: isNonEmptyString,
    describe: "the following clip for a two-sided cut; omitted targets the out-point edge",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const PRESET_TARGET_GRAPHICS_SCHEMA: ObjectSchema = {
  kind: {
    check: (v) => v === "graphics",
    describe: '"graphics" — creates a NEW SVG clip from the preset',
    required: true,
    emits: { kind: "leaf", schema: { const: "graphics" } },
  },
  trackId: {
    check: isNonEmptyString,
    describe:
      "graphics track to place the clip on; omitted picks the first graphics track (one is created when none exists)",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  startTime: {
    check: isNonNegativeNumber,
    describe: "timeline seconds for the new clip (default 0)",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  durationSec: {
    check: isPositiveNumber,
    describe: "clip duration in seconds (default 5)",
    emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } },
  },
};

export const PRESET_APPLY_SCHEMA: ObjectSchema = {
  presetId: {
    check: isNonEmptyString,
    describe: "a non-empty preset id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  target: {
    check: isPlainObject,
    describe:
      'where the parameters land: {"kind":"text","mode":"updateStyle","clipId":...} | {"kind":"effect","clipIds":[...]} | {"kind":"transition","clipAId":...,"clipBId":"..."} | {"kind":"graphics","trackId":"...","startTime":0,"durationSec":5}',
    required: true,
    emits: {
      kind: "anyOfObjects",
      variants: [
        PRESET_TARGET_TEXT_SCHEMA,
        PRESET_TARGET_EFFECT_SCHEMA,
        PRESET_TARGET_TRANSITION_SCHEMA,
        PRESET_TARGET_GRAPHICS_SCHEMA,
      ],
    },
  },
  expectedRevision: {
    check: isNonNegativeInteger,
    describe: "PROJECT revision CAS; an omitted value is guarded with the current revision",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty retry key; retries replay instead of double-applying",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/* ------------------------------------------------------------------ */
/* media.render_html                                                   */
/* ------------------------------------------------------------------ */

/** Mirrors the core HTML policy's byte ceiling (html-policy.ts). */
export const MEDIA_RENDER_HTML_MAX_INLINE_BYTES = 512 * 1024;

const isHtmlRenderDimension = (v: unknown): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= 2 && v <= 4096 && v % 2 === 0;

const HTML_RENDER_DIMENSION_EMITS = {
  kind: "leaf",
  schema: { type: "integer", minimum: 2, maximum: 4096 },
} as const;

const MEDIA_RENDER_HTML_SOURCE_SCHEMA_PATH: ObjectSchema = {
  kind: {
    check: (v) => v === "path",
    describe: '"path"',
    required: true,
    emits: { kind: "leaf", schema: { const: "path" } },
  },
  path: {
    check: isNonEmptyString,
    describe: "an absolute .html file path inside a configured media root",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

const MEDIA_RENDER_HTML_SOURCE_SCHEMA_INLINE: ObjectSchema = {
  kind: {
    check: (v) => v === "inline",
    describe: '"inline"',
    required: true,
    emits: { kind: "leaf", schema: { const: "inline" } },
  },
  html: {
    check: (v) =>
      typeof v === "string" &&
      v.length > 0 &&
      Buffer.byteLength(v, "utf8") <= MEDIA_RENDER_HTML_MAX_INLINE_BYTES,
    describe: `non-empty HTML markup of at most ${MEDIA_RENDER_HTML_MAX_INLINE_BYTES} bytes (UTF-8)`,
    required: true,
    emits: {
      kind: "leaf",
      schema: { type: "string", minLength: 1, maxLength: MEDIA_RENDER_HTML_MAX_INLINE_BYTES },
    },
  },
};

const isMediaRenderHtmlSource = (v: unknown): boolean => {
  if (!isPlainObject(v)) return false;
  if (v.kind === "path") return MEDIA_RENDER_HTML_SOURCE_SCHEMA_PATH.path.check(v.path);
  if (v.kind === "inline") return MEDIA_RENDER_HTML_SOURCE_SCHEMA_INLINE.html.check(v.html);
  return false;
};

/**
 * Constrained HTML→PNG render params. Cross-field rules that stay
 * validation-only: inline sources without assetsRoot may only use
 * data:image URIs (no local base to resolve against).
 */
export const MEDIA_RENDER_HTML_SCHEMA: ObjectSchema = {
  source: {
    check: isMediaRenderHtmlSource,
    describe:
      '{"kind":"path","path":"<absolute .html path inside a media root>"} or {"kind":"inline","html":"<markup ≤512 KiB>"}',
    required: true,
    emits: {
      kind: "anyOfObjects",
      variants: [MEDIA_RENDER_HTML_SOURCE_SCHEMA_PATH, MEDIA_RENDER_HTML_SOURCE_SCHEMA_INLINE],
    },
  },
  assetsRoot: {
    check: isNonEmptyString,
    describe: "an absolute directory inside a media root that local subresources may resolve into",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  width: {
    check: isHtmlRenderDimension,
    describe: "an even integer in [2, 4096]",
    required: true,
    emits: HTML_RENDER_DIMENSION_EMITS,
  },
  height: {
    check: isHtmlRenderDimension,
    describe: "an even integer in [2, 4096]",
    required: true,
    emits: HTML_RENDER_DIMENSION_EMITS,
  },
  transparent: {
    check: isBoolean,
    describe: "a boolean (default true — transparent page background)",
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
  timeoutMs: {
    check: (v) =>
      typeof v === "number" && Number.isInteger(v) && v >= 1000 && v <= 120_000,
    describe: "an integer in [1000, 120000] milliseconds (default 30000)",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1000, maximum: 120000 } },
  },
  outputDir: {
    check: isNonEmptyString,
    describe:
      "an absolute output directory inside a media root; default <mediaRoots[0]>/jobs/html-render/<requestKey>/",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  expectedRevision: {
    check: isNonNegativeInteger,
    describe: "a non-negative integer",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty retry key; retries replay the same published artifact",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/* ------------------------------------------------------------------ */
/* The verb declaration map                                          */
/* ------------------------------------------------------------------ */

/** Verb parameter declaration order mirrors FACADE_VERBS. */
export const VERB_PARAM_SCHEMAS: {
  readonly [verb: string]: ObjectSchema;
} = {
  "session.describe": EMPTY_PARAMS_SCHEMA,
  "capabilities.get": EMPTY_PARAMS_SCHEMA,
  "project.create": PROJECT_CREATE_SCHEMA,
  "project.open": PROJECT_OPEN_SCHEMA,
  "project.save": PROJECT_SAVE_SCHEMA,
  "project.rename": PROJECT_RENAME_SCHEMA,
  "project.get_state": EMPTY_PARAMS_SCHEMA,
  "project.changes": PROJECT_CHANGES_SCHEMA,
  "media.import": MEDIA_IMPORT_SCHEMA,
  "media.render_html": MEDIA_RENDER_HTML_SCHEMA,
  "media.analyze_start": MEDIA_ANALYZE_START_SCHEMA,
  "timeline.get": EMPTY_PARAMS_SCHEMA,
  "timeline.query": TIMELINE_QUERY_SCHEMA,
  "editor.get_context": EMPTY_PARAMS_SCHEMA,
  "editor.control": EDITOR_CONTROL_SCHEMA,
  "edit.validate": EDIT_VALIDATE_SCHEMA,
  "edit.apply": EDIT_APPLY_SCHEMA,
  "history.get": HISTORY_GET_SCHEMA,
  "history.control": HISTORY_CONTROL_SCHEMA,
  "preview.render_frame": PREVIEW_RENDER_FRAME_SCHEMA,
  "visual.inspect": VISUAL_INSPECT_SCHEMA,
  "preview.render_comparison": PREVIEW_RENDER_COMPARISON_SCHEMA,
  "analysis.list": ANALYSIS_LIST_SCHEMA,
  "analysis.get": ANALYSIS_GET_SCHEMA,
  ...Object.fromEntries(PLUGIN_TOOLS.map((tool) => [tool.name, tool.input])),
  "export.start": EXPORT_START_SCHEMA,
  "job.status": JOB_PARAMS_SCHEMA,
  "job.cancel": JOB_PARAMS_SCHEMA,
  "verify.artifact": VERIFY_ARTIFACT_SCHEMA,
  "material.list": MATERIAL_LIST_SCHEMA,
  "material.get": MATERIAL_GET_SCHEMA,
  "material.create": MATERIAL_CREATE_SCHEMA,
  "material.update": MATERIAL_UPDATE_SCHEMA,
  "material.batch_update": MATERIAL_BATCH_UPDATE_SCHEMA,
  "material.remove": MATERIAL_REMOVE_SCHEMA,
  "material.attach": MATERIAL_ATTACH_SCHEMA,
  "material.undo": MATERIAL_UNDO_SCHEMA,
  "font.upload": FONT_UPLOAD_SCHEMA,
  "font.list": EMPTY_PARAMS_SCHEMA,
  "preset.list": PRESET_LIST_SCHEMA,
  "preset.get": PRESET_GET_SCHEMA,
  "preset.create": PRESET_CREATE_SCHEMA,
  "preset.update": PRESET_UPDATE_SCHEMA,
  "preset.remove": PRESET_REMOVE_SCHEMA,
  "preset.apply": PRESET_APPLY_SCHEMA,
  "help.list_screens": HELP_LIST_SCREENS_SCHEMA,
  "help.describe": HELP_DESCRIBE_SCHEMA,
  "help.search": HELP_SEARCH_SCHEMA,
};
