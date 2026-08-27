/**
 * The closed Slice-1 op set for edit.apply: strict schema validation and
 * translation into core actions. Facade-level semantic checks that core
 * either skips or gets wrong (MEDIA-04 trim stale base, duplicate track ids)
 * live here so every core action the executor sees is already sane.
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
  type ClipTrimOp,
  type EditOp,
  type TextCreateOp,
  type TextStyleInput,
  type TrackAddOp,
} from "./types";

/* ------------------------------------------------------------------ */
/* Strict op validation                                                */
/* ------------------------------------------------------------------ */

const TRACK_ADD_SCHEMA: ObjectSchema = {
  op: { check: (v) => v === "track.add", describe: '"track.add"', required: true },
  trackType: {
    check: oneOf(TRACK_TYPES),
    describe: `one of ${TRACK_TYPES.join(", ")}`,
    required: true,
  },
  trackId: { check: isNonEmptyString, describe: "a non-empty string" },
};

const CLIP_ADD_SCHEMA: ObjectSchema = {
  op: { check: (v) => v === "clip.add", describe: '"clip.add"', required: true },
  trackId: { check: isNonEmptyString, describe: "a non-empty string", required: true },
  mediaId: { check: isNonEmptyString, describe: "a non-empty string", required: true },
  startTime: { check: isNonNegativeNumber, describe: "a finite number >= 0", required: true },
  duration: { check: isPositiveNumber, describe: "a finite number > 0" },
  inPoint: { check: isNonNegativeNumber, describe: "a finite number >= 0" },
  outPoint: { check: isPositiveNumber, describe: "a finite number > 0" },
  clipId: { check: isNonEmptyString, describe: "a non-empty string" },
};

const CLIP_TRIM_SCHEMA: ObjectSchema = {
  op: { check: (v) => v === "clip.trim", describe: '"clip.trim"', required: true },
  clipId: { check: isNonEmptyString, describe: "a non-empty string", required: true },
  inPoint: { check: isNonNegativeNumber, describe: "a finite number >= 0" },
  outPoint: { check: isNonNegativeNumber, describe: "a finite number >= 0" },
};

const TEXT_STYLE_SCHEMA: ObjectSchema = {
  fontFamily: { check: isNonEmptyString, describe: "a non-empty string" },
  fontSize: { check: isPositiveNumber, describe: "a finite number > 0" },
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
  },
  color: { check: isNonEmptyString, describe: "a non-empty string" },
  textAlign: {
    check: oneOf(["left", "center", "right", "justify"]),
    describe: "one of left, center, right, justify",
  },
};

const TEXT_CREATE_SCHEMA: ObjectSchema = {
  op: { check: (v) => v === "text.create", describe: '"text.create"', required: true },
  text: {
    check: (v) => typeof v === "string" && v.trim().length > 0,
    describe: "a non-empty string",
    required: true,
  },
  startTime: { check: isNonNegativeNumber, describe: "a finite number >= 0", required: true },
  duration: { check: isPositiveNumber, describe: "a finite number > 0", required: true },
  trackId: { check: isNonEmptyString, describe: "a non-empty string" },
  style: {
    check: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
    describe: "an object",
  },
};

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
    case "text.create": {
      const op = validateObject<TextCreateOp>(raw, TEXT_CREATE_SCHEMA, label);
      if (op.style !== undefined) {
        // Rebind to the SANITIZED copy: opToCoreActions spreads op.style into
        // the canonical TextClip, so what flows downstream must be the fresh
        // validated object — never the raw nested caller object (whose
        // getters could yield different values post-validation).
        const style = validateObject<TextStyleInput>(
          op.style,
          TEXT_STYLE_SCHEMA,
          `${label}.style`,
        );
        return { ...op, style };
      }
      return op;
    }
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

export function diffCreatedIds(before: EntityIdSets, after: EntityIdSets): string[] {
  const created: string[] = [];
  for (const id of after.tracks) if (!before.tracks.has(id)) created.push(id);
  for (const id of after.clips) if (!before.clips.has(id)) created.push(id);
  for (const id of after.textOverlays)
    if (!before.textOverlays.has(id)) created.push(id);
  return created;
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
      // MEDIA-04: core clip/trim computes duration from the STALE in/out point
      // when both move in one action. Send them as two sequential actions so
      // the second sees the first's result; final duration = newOut - newIn.
      const actions: Action[] = [];
      if (op.inPoint !== undefined) {
        actions.push(makeAction("clip/trim", { clipId: op.clipId, inPoint: op.inPoint }));
      }
      if (op.outPoint !== undefined) {
        actions.push(makeAction("clip/trim", { clipId: op.clipId, outPoint: op.outPoint }));
      }
      return actions;
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
        transform: { ...DEFAULT_TEXT_TRANSFORM },
        keyframes: [],
      };
      return [makeAction("text/create", { clip })];
    }
  }
}
