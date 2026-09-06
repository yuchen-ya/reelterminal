import { PLUGIN_TOOLS } from "./plugins";
/**
 * The SINGLE hand-maintained schema declaration per facade verb
 * (ADR 0003 Decision 4). Both consumers derive from these objects:
 *
 *  - the runtime boundary validators (session.ts drives `validateObject`
 *    with exactly these declarations — same checks, same labels, same
 *    error ordering as before the migration); and
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
  TRACK_ADD_SCHEMA,
  TRACK_UPDATE_SCHEMA,
  TRACK_REMOVE_SCHEMA,
  MEDIA_REMOVE_SCHEMA,
  MARKER_ADD_SCHEMA,
  MARKER_REMOVE_SCHEMA,
  TRANSITION_ADD_SCHEMA,
  TRANSITION_REMOVE_SCHEMA,
  TRANSITION_UPDATE_SCHEMA,
  SUBTITLE_IMPORT_SRT_SCHEMA,
  CLIP_SET_COLOR_GRADE_SCHEMA,
  CLIP_SET_KEYFRAMES_SCHEMA,
} from "./ops";
import {
  isFiniteNumber,
  isNonEmptyString,
  isNonNegativeInteger,
  isNonNegativeNumber,
  isPlainObject,
  isPositiveInteger,
  isPositiveNumber,
  oneOf,
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
 * project.open {path, idempotencyKey?} — lifecycle verb (ADR 0003
 * Decision 10.4): no expectedRevision (single-initialization, outside the
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

export const MEDIA_ANALYZE_START_SCHEMA: ObjectSchema = {
  cloudUpload: { check: (v) => typeof v === "boolean", describe: "must be true for videoReview: uploads the selected range to Alibaba", emits: { kind: "leaf", schema: { type: "boolean" } } },
  reviewQuestion: { check: (v) => typeof v === "string" && v.length <= 1000, describe: "optional video review focus, at most 1000 characters", emits: { kind: "leaf", schema: { type: "string", maxLength: 1000 } } },
  startSec: { check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0, describe: "nonnegative source seconds", emits: { kind: "leaf", schema: { type: "number", minimum: 0 } } },
  endSec: { check: (v) => typeof v === "number" && Number.isFinite(v) && v > 0, describe: "positive source seconds; audioSummary range ≤120s; videoReview requires explicit start/end and range ≤20s", emits: { kind: "leaf", schema: { type: "number", exclusiveMinimum: 0 } } },
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
  "subtitle.importSrt": SUBTITLE_IMPORT_SRT_SCHEMA,
  "clip.setColorGrade": CLIP_SET_COLOR_GRADE_SCHEMA,
  "clip.setKeyframes": CLIP_SET_KEYFRAMES_SCHEMA,
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
};

export const EXPORT_START_SCHEMA: ObjectSchema = {
  settings: {
    check: isPlainObject,
    describe: "an object",
    emits: { kind: "object", schema: EXPORT_SETTINGS_SCHEMA },
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
/* The 24-verb declaration map (single source, Decision 4)             */
/* ------------------------------------------------------------------ */

/** Verb param declaration order mirrors FACADE_VERBS (Appendix B.1). */
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
  ...Object.fromEntries(PLUGIN_TOOLS.map((tool) => [tool.name, tool.input])),
  "export.start": EXPORT_START_SCHEMA,
  "job.status": JOB_PARAMS_SCHEMA,
  "job.cancel": JOB_PARAMS_SCHEMA,
  "verify.artifact": VERIFY_ARTIFACT_SCHEMA,
};
