/**
 * The closed edit.apply op set: strict schema validation and translation
 * into core actions. Facade-level semantic checks that core either skips
 * or gets wrong (MEDIA-04 trim stale base, duplicate track ids, text
 * overlay existence) live here so every core action the executor sees is
 * already sane.
 */
import type { Action } from "@openreel/core/types/actions";
import type { Project } from "@openreel/core/types/project";
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
  isPositiveNumber,
  oneOf,
  validateObject,
  type ObjectSchema,
} from "./validate";
import {
  EDIT_OP_TYPES,
  TRACK_TYPES,
  type ClipAddOp,
  type ClipMoveOp,
  type ClipRemoveOp,
  type ClipSetFadeOp,
  type ClipSetSpeedOp,
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
}

export function collectEntityIds(project: Project): EntityIdSets {
  const tracks = new Set<string>();
  const clips = new Set<string>();
  for (const track of project.timeline.tracks) {
    tracks.add(track.id);
    for (const clip of track.clips) clips.add(clip.id);
  }
  const textOverlays = new Set((project.textClips ?? []).map((c) => c.id));
  return { tracks, clips, textOverlays };
}

/** Created entity ids, partitioned by category (the live seam's shape). */
export interface CreatedIdsByCategory {
  readonly tracks: readonly string[];
  readonly clips: readonly string[];
  readonly textClips: readonly string[];
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
  };
}

export function diffCreatedIds(before: EntityIdSets, after: EntityIdSets): string[] {
  const byCategory = diffCreatedIdsByCategory(before, after);
  return [
    ...byCategory.tracks,
    ...byCategory.clips,
    ...byCategory.textClips,
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

    case "text.create": {
      let trackId = op.trackId;
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
        if (!textTrack) {
          throw new FacadeError(
            "NOT_FOUND",
            "text.create: no text track exists — add one first via track.add {trackType:\"text\"}",
          );
        }
        trackId = textTrack.id;
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
      return [makeAction("text/create", { clip })];
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
  }
}
