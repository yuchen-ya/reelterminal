/**
 * `openreel-project@1` — the one honest checkpoint format behind
 * project.save / project.open (ADR 0003 Decision 10, r2.2).
 *
 * A checkpoint is data the agent can see and the facade re-validates —
 * never session magic. Exactly one thing is durable: this file. The
 * idempotency ledger, the job registry, provider handles and session
 * configuration are NEVER saved (10.2), and `stateSha256` is corruption
 * detection, not tamper-proofing: anyone can recompute it after a
 * deliberate edit, and a hand-edited checkpoint that passes structural
 * validation is operator input, trusted at the operator's level (10.6).
 *
 * Hash recipe (10.2, pinned): lowercase hex SHA-256 over the UTF-8 bytes of
 * the facade's own `stableStringify` (idempotency.ts — lexicographically
 * sorted object keys, arrays in order, `undefined` omitted) applied to
 * `{formatVersion, revision, project, mediaRefs}`. One canonicalizer, so
 * every future binding hashes identically.
 *
 * Atomic publication (10.3, fourth-round refined): temp sibling
 * `<name>.<uuid>.tmp` → flush + fsync → default mode publishes with
 * `link(temp, target)` + `unlink(temp)` (EEXIST ⇒ CONFLICT — a filesystem
 * guarantee, not an advisory check; link-less filesystems fail honestly),
 * `overwrite:true` renames over the target (symlink targets still refused),
 * then a best-effort directory fsync (swallowed — bounded, not guaranteed,
 * impossible on Windows).
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, link, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Project } from "@openreel/core/types/project";

import { FACADE_CONTRACT_VERSION, TRACK_TYPES } from "./types";
import { FacadeError } from "./errors";
import { stableStringify } from "./idempotency";
import { resolveContainedPathDetailed } from "./media/path-roots";
import {
  isBoolean,
  isFiniteNumber,
  isNonNegativeInteger,
  isNonNegativeNumber,
  isNonEmptyString,
  isPlainObject,
  isString,
  oneOf,
  validateObject,
  type ObjectSchema,
} from "./validate";
import { PROJECT_SETTINGS_SCHEMA } from "./verb-schemas";

/* ------------------------------------------------------------------ */
/* Format constants                                                    */
/* ------------------------------------------------------------------ */

export const CHECKPOINT_FORMAT = "openreel-project" as const;
export const CHECKPOINT_FORMAT_VERSION = 1 as const;
/** The only supported document version in this slice (10.4 step 2). */
export const SUPPORTED_CHECKPOINT_FORMAT_VERSIONS: readonly number[] = [
  CHECKPOINT_FORMAT_VERSION,
];

/** Checkpoints larger than this are refused before being read (10.4 step 1). */
export const MAX_CHECKPOINT_BYTES = 256 * 1024 * 1024;

/**
 * One recorded media reference: derived at save time from the live
 * project's mediaLibrary item — never new media state (mediaId, the
 * absolute import path, the recorded source fingerprint, probe metadata).
 */
export interface CheckpointMediaRef {
  readonly mediaId: string;
  /** The absolute path recorded at import; equals the item's originalUrl. */
  readonly path: string;
  readonly sourceFile: { readonly name: string; readonly size: number; readonly lastModified: number };
  readonly metadata: Record<string, unknown>;
}

/** The `openreel-project@1` top-level document (10.2). */
export interface CheckpointDocument {
  readonly format: typeof CHECKPOINT_FORMAT;
  readonly formatVersion: number;
  /** Informational provenance label; the compatibility gate is formatVersion. */
  readonly contract: string;
  /** ms epoch of the save (non-negative integer). */
  readonly savedAt: number;
  /** Project revision at save time, `0 … Number.MAX_SAFE_INTEGER`. */
  readonly revision: number;
  readonly project: Project;
  readonly mediaRefs: readonly CheckpointMediaRef[];
  readonly stateSha256: string;
}

/**
 * The integrity hash (10.2): lowercase hex SHA-256 over the UTF-8 bytes of
 * `stableStringify({formatVersion, revision, project, mediaRefs})`.
 */
export function computeStateSha256(parts: {
  readonly formatVersion: number;
  readonly revision: number;
  readonly project: unknown;
  readonly mediaRefs: unknown;
}): string {
  return createHash("sha256")
    .update(
      stableStringify({
        formatVersion: parts.formatVersion,
        revision: parts.revision,
        project: parts.project,
        mediaRefs: parts.mediaRefs,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Derive `mediaRefs` from the live project's mediaLibrary — headless items
 * always carry `originalUrl` + `sourceFile` (media.import records both);
 * anything else would fail our own reader, so the writer refuses it first.
 */
export function buildMediaRefs(project: Project): CheckpointMediaRef[] {
  return project.mediaLibrary.items.map((item) => {
    const originalUrl =
      typeof item.originalUrl === "string" ? item.originalUrl : null;
    if (originalUrl === null || !item.sourceFile) {
      throw new FacadeError(
        "INTERNAL",
        `project.save: media item "${item.id}" has no recorded source path/file — a checkpoint would not re-open, so it was not written`,
        { mediaId: item.id },
      );
    }
    return {
      mediaId: item.id,
      path: originalUrl,
      sourceFile: {
        name: item.sourceFile.name,
        size: item.sourceFile.size,
        lastModified: item.sourceFile.lastModified,
      },
      metadata: { ...item.metadata },
    };
  });
}

/**
 * Build the full document from a project snapshot. `project` is cloned so
 * later mutations can never leak into a document being written.
 */
export function buildCheckpointDocument(
  project: Project,
  revision: number,
): CheckpointDocument {
  const projectCopy = structuredClone(project);
  const mediaRefs = buildMediaRefs(projectCopy);
  const stateSha256 = computeStateSha256({
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    revision,
    project: projectCopy,
    mediaRefs,
  });
  return {
    format: CHECKPOINT_FORMAT,
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    contract: FACADE_CONTRACT_VERSION,
    savedAt: Date.now(),
    revision,
    project: projectCopy,
    mediaRefs,
    stateSha256,
  };
}

/* ------------------------------------------------------------------ */
/* Closed project-document schema (10.2 schema scope)                  */
/* ------------------------------------------------------------------ */

/**
 * Strict closed declaration over exactly the HEADLESS-REACHABLE subset of
 * the canonical Project: what createEmptyProject + media.import + the
 * closed edit.apply op set can produce. Browser/desktop-only fields
 * (adjustmentLayers, masks, multicamGroups, creation, KieAI markers, …)
 * are outside the headless surface and outside this schema — an unknown
 * field fails the STRUCTURE step. Because the schema is closed, ANY change
 * to the document shape — even purely additive — requires a formatVersion
 * bump (10.2 evolution rule).
 *
 * Validation-only predicates beyond the schema: none — cross-field rules
 * are not needed here; everything below is shape and type.
 *
 * Value-pinning is deliberately limited to the model's own closed unions:
 * a hand-edited checkpoint whose recomputed hash passes and whose values
 * stay model-respecting is operator input and must OPEN (10.6).
 */

/** Arrays the closed headless op set can only ever leave empty. */
const isEmptyArray = (v: unknown): boolean => Array.isArray(v) && v.length === 0;

const isNull = (v: unknown): boolean => v === null;

/** "normal", "bold", or a multiple of 100 in 100..900 (the FontWeight union). */
const isFontWeight = (v: unknown): boolean =>
  v === "normal" ||
  v === "bold" ||
  (typeof v === "number" &&
    Number.isInteger(v) &&
    v >= 100 &&
    v <= 900 &&
    v % 100 === 0);

const isSha256Hex = (v: unknown): boolean =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** `0 … Number.MAX_SAFE_INTEGER` (10.4 step 4). */
export const isCheckpointRevision = (v: unknown): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;

const XY_SCHEMA: ObjectSchema = {
  x: { check: isFiniteNumber, describe: "a finite number", required: true },
  y: { check: isFiniteNumber, describe: "a finite number", required: true },
};

/** Canonical media metadata exactly as media.import records it. */
export const MEDIA_METADATA_SCHEMA: ObjectSchema = {
  duration: { check: isNonNegativeNumber, describe: "a non-negative finite number", required: true },
  width: { check: isNonNegativeInteger, describe: "a non-negative integer", required: true },
  height: { check: isNonNegativeInteger, describe: "a non-negative integer", required: true },
  frameRate: { check: isNonNegativeNumber, describe: "a non-negative finite number", required: true },
  codec: { check: isString, describe: "a string", required: true },
  sampleRate: { check: isNonNegativeInteger, describe: "a non-negative integer", required: true },
  channels: { check: isNonNegativeInteger, describe: "a non-negative integer", required: true },
  fileSize: { check: isNonNegativeInteger, describe: "a non-negative integer", required: true },
};

/** The recorded source fingerprint exactly as media.import records it. */
export const SOURCE_FILE_SCHEMA: ObjectSchema = {
  name: { check: isString, describe: "a string", required: true },
  size: { check: isNonNegativeNumber, describe: "a non-negative finite number", required: true },
  lastModified: { check: isNonNegativeNumber, describe: "a non-negative finite number", required: true },
};

/** Headless media items: probe-produced video/audio only, runtime fields null. */
export const MEDIA_ITEM_SCHEMA: ObjectSchema = {
  id: { check: isNonEmptyString, describe: "a non-empty string", required: true },
  name: { check: isString, describe: "a string", required: true },
  type: { check: oneOf(["video", "audio"]), describe: '"video" or "audio"', required: true },
  fileHandle: { check: isNull, describe: "null in headless sessions", required: true },
  blob: { check: isNull, describe: "null in headless sessions", required: true },
  metadata: { check: isPlainObject, describe: "an object", required: true },
  thumbnailUrl: { check: isNull, describe: "null in headless sessions", required: true },
  waveformData: { check: isNull, describe: "null in headless sessions", required: true },
  originalUrl: { check: isNonEmptyString, describe: "a non-empty string", required: true },
  sourceFile: { check: isPlainObject, describe: "an object", required: true },
};

export const MEDIA_LIBRARY_SCHEMA: ObjectSchema = {
  items: { check: (v) => Array.isArray(v), describe: "an array of media items", required: true },
};

/** Clip.transform: the executor's defaultTransform (fitMode "contain"). */
export const CLIP_TRANSFORM_SCHEMA: ObjectSchema = {
  position: { check: isPlainObject, describe: "an {x, y} object", required: true },
  scale: { check: isPlainObject, describe: "an {x, y} object", required: true },
  rotation: { check: isFiniteNumber, describe: "a finite number", required: true },
  anchor: { check: isPlainObject, describe: "an {x, y} object", required: true },
  opacity: { check: isFiniteNumber, describe: "a finite number", required: true },
  fitMode: { check: oneOf(["contain", "cover", "stretch", "none"]), describe: 'one of "contain", "cover", "stretch", "none"', required: true },
};

/** Clips exactly as clip.add creates them and clip.trim mutates them. */
export const CLIP_SCHEMA: ObjectSchema = {
  id: { check: isNonEmptyString, describe: "a non-empty string", required: true },
  mediaId: { check: isNonEmptyString, describe: "a non-empty string", required: true },
  trackId: { check: isNonEmptyString, describe: "a non-empty string", required: true },
  startTime: { check: isFiniteNumber, describe: "a finite number", required: true },
  duration: { check: isFiniteNumber, describe: "a finite number", required: true },
  inPoint: { check: isFiniteNumber, describe: "a finite number", required: true },
  outPoint: { check: isFiniteNumber, describe: "a finite number", required: true },
  effects: { check: isEmptyArray, describe: "an empty array (no headless effects op exists)", required: true },
  audioEffects: { check: isEmptyArray, describe: "an empty array (no headless effects op exists)", required: true },
  transform: { check: isPlainObject, describe: "an object", required: true },
  volume: { check: isFiniteNumber, describe: "a finite number", required: true },
  keyframes: { check: isEmptyArray, describe: "an empty array (no headless keyframe op exists)", required: true },
};

/** Tracks exactly as track.add creates them. */
export const TRACK_SCHEMA: ObjectSchema = {
  id: { check: isNonEmptyString, describe: "a non-empty string", required: true },
  type: { check: oneOf(TRACK_TYPES), describe: `one of ${TRACK_TYPES.join(", ")}`, required: true },
  name: { check: isString, describe: "a string", required: true },
  clips: { check: (v) => Array.isArray(v), describe: "an array of clips", required: true },
  transitions: { check: isEmptyArray, describe: "an empty array (no headless transition op exists)", required: true },
  locked: { check: isBoolean, describe: "a boolean", required: true },
  hidden: { check: isBoolean, describe: "a boolean", required: true },
  muted: { check: isBoolean, describe: "a boolean", required: true },
  solo: { check: isBoolean, describe: "a boolean", required: true },
};

/** TextClips exactly as text.create builds them (opToCoreActions). */
export const TEXT_CLIP_SCHEMA: ObjectSchema = {
  id: { check: isNonEmptyString, describe: "a non-empty string", required: true },
  trackId: { check: isNonEmptyString, describe: "a non-empty string", required: true },
  startTime: { check: isFiniteNumber, describe: "a finite number", required: true },
  duration: { check: isFiniteNumber, describe: "a finite number", required: true },
  text: { check: isString, describe: "a string", required: true },
  style: { check: isPlainObject, describe: "an object", required: true },
  transform: { check: isPlainObject, describe: "an object", required: true },
  keyframes: { check: isEmptyArray, describe: "an empty array (no headless keyframe op exists)", required: true },
};

/** The canonical TextStyle as DEFAULT_TEXT_STYLE + text.create style yields it. */
export const TEXT_STYLE_CANONICAL_SCHEMA: ObjectSchema = {
  fontFamily: { check: isString, describe: "a string", required: true },
  fontSize: { check: isFiniteNumber, describe: "a finite number", required: true },
  fontWeight: { check: isFontWeight, describe: '"normal", "bold", or a multiple of 100 in 100..900', required: true },
  fontStyle: { check: oneOf(["normal", "italic"]), describe: '"normal" or "italic"', required: true },
  color: { check: isString, describe: "a string", required: true },
  strokeColor: { check: isString, describe: "a string", required: true },
  strokeWidth: { check: isFiniteNumber, describe: "a finite number", required: true },
  textAlign: { check: oneOf(["left", "center", "right", "justify"]), describe: "one of left, center, right, justify", required: true },
  verticalAlign: { check: oneOf(["top", "middle", "bottom"]), describe: 'one of "top", "middle", "bottom"', required: true },
  lineHeight: { check: isFiniteNumber, describe: "a finite number", required: true },
  letterSpacing: { check: isFiniteNumber, describe: "a finite number", required: true },
};

/** DEFAULT_TEXT_TRANSFORM carries no fitMode (unlike clip transforms). */
export const TEXT_TRANSFORM_SCHEMA: ObjectSchema = {
  position: { check: isPlainObject, describe: "an {x, y} object", required: true },
  scale: { check: isPlainObject, describe: "an {x, y} object", required: true },
  rotation: { check: isFiniteNumber, describe: "a finite number", required: true },
  anchor: { check: isPlainObject, describe: "an {x, y} object", required: true },
  opacity: { check: isFiniteNumber, describe: "a finite number", required: true },
};

export const TIMELINE_SCHEMA: ObjectSchema = {
  tracks: { check: (v) => Array.isArray(v), describe: "an array of tracks", required: true },
  subtitles: { check: isEmptyArray, describe: "an empty array (no headless subtitle op exists)", required: true },
  duration: { check: isNonNegativeNumber, describe: "a non-negative finite number", required: true },
  markers: { check: isEmptyArray, describe: "an empty array (no headless marker op exists)", required: true },
};

/** Top level of the canonical Project — headless-reachable fields only. */
export const PROJECT_DOCUMENT_SCHEMA: ObjectSchema = {
  id: { check: isNonEmptyString, describe: "a non-empty string", required: true },
  name: { check: isString, describe: "a string", required: true },
  createdAt: { check: isNonNegativeNumber, describe: "a non-negative finite number", required: true },
  modifiedAt: { check: isNonNegativeNumber, describe: "a non-negative finite number", required: true },
  settings: { check: isPlainObject, describe: "an object", required: true },
  mediaLibrary: { check: isPlainObject, describe: "an object", required: true },
  timeline: { check: isPlainObject, describe: "an object", required: true },
  textClips: { check: (v) => Array.isArray(v), describe: "an array of text clips" },
};

/** One mediaRefs entry (checked again against the project at step 5). */
export const MEDIA_REF_SCHEMA: ObjectSchema = {
  mediaId: { check: isNonEmptyString, describe: "a non-empty string", required: true },
  path: { check: isNonEmptyString, describe: "a non-empty string", required: true },
  sourceFile: { check: isPlainObject, describe: "an object", required: true },
  metadata: { check: isPlainObject, describe: "an object", required: true },
};

/** All top-level checkpoint fields are schema-checked (10.4 step 4). */
export const CHECKPOINT_DOCUMENT_SCHEMA: ObjectSchema = {
  format: { check: (v) => v === CHECKPOINT_FORMAT, describe: `"${CHECKPOINT_FORMAT}"`, required: true },
  formatVersion: { check: (v) => v === CHECKPOINT_FORMAT_VERSION, describe: "1 (the only supported version)", required: true },
  contract: { check: isString, describe: "a string (informational provenance)", required: true },
  savedAt: { check: isNonNegativeInteger, describe: "a non-negative integer", required: true },
  revision: { check: isCheckpointRevision, describe: "an integer in 0..Number.MAX_SAFE_INTEGER", required: true },
  project: { check: isPlainObject, describe: "an object", required: true },
  mediaRefs: { check: (v) => Array.isArray(v), describe: "an array of media references", required: true },
  stateSha256: { check: isSha256Hex, describe: "a lowercase hex sha256 string", required: true },
};

/* ------------------------------------------------------------------ */
/* Reader — steps 2–4 of 10.4 (containment is the session's, step 5 too) */
/* ------------------------------------------------------------------ */

/** Label prefix for STRUCTURE-step rejections — always distinct from the
 * integrity step's "corrupted or hand-edited" wording (10.2/10.4). */
const STRUCTURE_LABEL = "checkpoint structure";

interface ParsedCheckpointFields {
  readonly format: unknown;
  readonly formatVersion: unknown;
  readonly stateSha256: unknown;
  readonly revision: unknown;
  readonly project: unknown;
  readonly mediaRefs: unknown;
}

/**
 * Step 2 (Format): JSON parses, `format === "openreel-project"`,
 * `formatVersion ∈ {1}`. Anything else ⇒ UNSUPPORTED naming found vs
 * supported — an honest refusal, never a silent downgrade or a guessed
 * migration. (A truncated/garbage file fails here as not-valid-JSON.)
 */
export function parseCheckpointText(text: string): ParsedCheckpointFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new FacadeError(
      "UNSUPPORTED",
      `project.open: checkpoint is not valid JSON (${
        error instanceof Error ? error.message : String(error)
      }) — supported: format ${JSON.stringify(CHECKPOINT_FORMAT)}, formatVersion {1}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new FacadeError(
      "UNSUPPORTED",
      `project.open: checkpoint root is not a JSON object — supported: format ${JSON.stringify(CHECKPOINT_FORMAT)}, formatVersion {1}`,
    );
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.format !== CHECKPOINT_FORMAT) {
    throw new FacadeError(
      "UNSUPPORTED",
      `project.open: unsupported checkpoint format ${JSON.stringify(doc.format)} — supported: format ${JSON.stringify(CHECKPOINT_FORMAT)}, formatVersion {1}`,
      { found: doc.format === undefined ? null : doc.format },
    );
  }
  if (doc.formatVersion !== CHECKPOINT_FORMAT_VERSION) {
    throw new FacadeError(
      "UNSUPPORTED",
      `project.open: unsupported checkpoint formatVersion ${JSON.stringify(doc.formatVersion)} — supported formatVersions: {1}`,
      { found: doc.formatVersion === undefined ? null : doc.formatVersion, supported: [...SUPPORTED_CHECKPOINT_FORMAT_VERSIONS] },
    );
  }
  return parsed as unknown as ParsedCheckpointFields;
}

/**
 * Step 3 (Integrity): `stateSha256` must recompute to the stored value.
 * Mismatch ⇒ INVALID_PARAMS with the corrupted-or-hand-edited wording —
 * always distinct from the structure step's wording.
 */
export function assertCheckpointIntegrity(parsed: ParsedCheckpointFields): void {
  const recomputed = computeStateSha256({
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    revision: parsed.revision as number,
    project: parsed.project,
    mediaRefs: parsed.mediaRefs,
  });
  if (recomputed !== parsed.stateSha256) {
    throw new FacadeError(
      "INVALID_PARAMS",
      "project.open: checkpoint corrupted or hand-edited — stateSha256 does not match the document payload",
      { expected: parsed.stateSha256, actual: recomputed },
    );
  }
}

export interface ValidatedCheckpoint {
  /** A freshly validated copy — the raw parsed object is never adopted. */
  readonly project: Project;
  readonly revision: number;
  readonly mediaRefs: readonly CheckpointMediaRef[];
}

/**
 * Step 4 (Structure): every top-level field schema-checked, the project
 * validated against the closed headless-reachable declaration, revision
 * bounded to `0 … Number.MAX_SAFE_INTEGER`. Returns sanitized copies
 * rebuilt layer by layer (the raw parsed tree is never adopted).
 */
export function validateCheckpointStructure(parsed: ParsedCheckpointFields): ValidatedCheckpoint {
  const doc = validateObject<{
    format: unknown;
    formatVersion: unknown;
    contract: string;
    savedAt: number;
    revision: number;
    project: unknown;
    mediaRefs: unknown[];
    stateSha256: string;
  }>(
    parsed,
    CHECKPOINT_DOCUMENT_SCHEMA,
    STRUCTURE_LABEL,
  );
  const project = validateProjectDocument(doc.project);
  const mediaRefs = doc.mediaRefs.map((entry: unknown, index: number) => {
    const ref = validateObject<CheckpointMediaRef>(
      entry,
      MEDIA_REF_SCHEMA,
      `${STRUCTURE_LABEL}: mediaRefs[${index}]`,
    );
    validateObject(
      ref.sourceFile,
      SOURCE_FILE_SCHEMA,
      `${STRUCTURE_LABEL}: mediaRefs[${index}].sourceFile`,
    );
    validateObject(
      ref.metadata,
      MEDIA_METADATA_SCHEMA,
      `${STRUCTURE_LABEL}: mediaRefs[${index}].metadata`,
    );
    return ref;
  });
  return { project, revision: doc.revision, mediaRefs };
}

function validateProjectDocument(raw: unknown): Project {
  const label = `${STRUCTURE_LABEL}: project`;
  const top = validateObject<{
    id: string;
    name: string;
    createdAt: number;
    modifiedAt: number;
    settings: unknown;
    mediaLibrary: { items: unknown[] };
    timeline: unknown;
    textClips?: unknown[];
  }>(raw, PROJECT_DOCUMENT_SCHEMA, label);
  const settings = validateObject(top.settings, PROJECT_SETTINGS_SCHEMA, `${label}.settings`);
  const mediaLibrary = validateObject<{ items: unknown[] }>(
    top.mediaLibrary,
    MEDIA_LIBRARY_SCHEMA,
    `${label}.mediaLibrary`,
  );
  const items = mediaLibrary.items.map((item, index) => {
    const it = validateObject<
      Record<string, unknown> & {
        metadata: unknown;
        sourceFile: unknown;
      }
    >(item, MEDIA_ITEM_SCHEMA, `${label}.mediaLibrary.items[${index}]`);
    const metadata = validateObject(
      it.metadata,
      MEDIA_METADATA_SCHEMA,
      `${label}.mediaLibrary.items[${index}].metadata`,
    );
    const sourceFile = validateObject(
      it.sourceFile,
      SOURCE_FILE_SCHEMA,
      `${label}.mediaLibrary.items[${index}].sourceFile`,
    );
    return { ...it, metadata, sourceFile };
  });
  const timelineRaw = validateObject<{ tracks: unknown[] } & Record<string, unknown>>(
    top.timeline,
    TIMELINE_SCHEMA,
    `${label}.timeline`,
  );
  const tracks = timelineRaw.tracks.map((track, index) => {
    const t = validateObject<{ clips: unknown[] } & Record<string, unknown>>(
      track,
      TRACK_SCHEMA,
      `${label}.timeline.tracks[${index}]`,
    );
    const clips = t.clips.map((clip, clipIndex) => {
      const clipLabel = `${label}.timeline.tracks[${index}].clips[${clipIndex}]`;
      const c = validateObject<Record<string, unknown>>(
        clip,
        CLIP_SCHEMA,
        clipLabel,
      );
      const transform = validateObject<Record<string, unknown>>(
        c.transform,
        CLIP_TRANSFORM_SCHEMA,
        `${clipLabel}.transform`,
      );
      validateTransformVectors(transform, clipLabel);
      return { ...c, transform };
    });
    return { ...t, clips };
  });
  const textClips =
    top.textClips !== undefined
      ? top.textClips.map((clip, index) => {
          const tcLabel = `${label}.textClips[${index}]`;
          const tc = validateObject<Record<string, unknown>>(
            clip,
            TEXT_CLIP_SCHEMA,
            tcLabel,
          );
          const style = validateObject<Record<string, unknown>>(
            tc.style,
            TEXT_STYLE_CANONICAL_SCHEMA,
            `${tcLabel}.style`,
          );
          const transform = validateObject<Record<string, unknown>>(
            tc.transform,
            TEXT_TRANSFORM_SCHEMA,
            `${tcLabel}.transform`,
          );
          validateTransformVectors(transform, tcLabel);
          return { ...tc, style, transform };
        })
      : undefined;
  return {
    id: top.id,
    name: top.name,
    createdAt: top.createdAt,
    modifiedAt: top.modifiedAt,
    settings,
    mediaLibrary: { items },
    timeline: { ...timelineRaw, tracks },
    ...(textClips !== undefined ? { textClips } : {}),
  } as unknown as Project;
}

/** position/scale/anchor are {x, y} pairs of finite numbers in the model. */
function validateTransformVectors(
  transform: Record<string, unknown>,
  clipLabel: string,
): void {
  for (const key of ["position", "scale", "anchor"]) {
    validateObject(
      transform[key],
      XY_SCHEMA,
      `${clipLabel}.transform.${key}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Step 5 part 1 — mediaRefs ↔ project binding (pure data)             */
/* ------------------------------------------------------------------ */

/**
 * `mediaRefs` must cover EXACTLY `project.mediaLibrary.items`: mediaIds
 * 1:1 (no missing, extra or duplicate ids), each entry's `path` equal to
 * its item's `originalUrl`, and `sourceFile` deep-equal to the item's
 * recorded sourceFile (10.4 step 5, fourth-round binding fix). Returns
 * EVERY offending mediaId so the open can list them all in details.
 */
export function findMediaBindingOffenders(
  mediaRefs: readonly CheckpointMediaRef[],
  items: ReadonlyArray<{ readonly id: string; readonly originalUrl?: unknown; readonly sourceFile?: unknown }>,
): string[] {
  const offenders: string[] = [];
  const byId = new Map<string, CheckpointMediaRef>();
  for (const ref of mediaRefs) {
    if (byId.has(ref.mediaId)) offenders.push(ref.mediaId);
    byId.set(ref.mediaId, ref);
  }
  const itemIds = new Set(items.map((item) => item.id));
  for (const item of items) {
    const ref = byId.get(item.id);
    if (!ref) {
      offenders.push(item.id);
      continue;
    }
    if (
      ref.path !== item.originalUrl ||
      stableStringify(ref.sourceFile) !== stableStringify(item.sourceFile)
    ) {
      offenders.push(item.id);
    }
  }
  for (const ref of mediaRefs) {
    if (!itemIds.has(ref.mediaId)) offenders.push(ref.mediaId);
  }
  return [...new Set(offenders)];
}

/* ------------------------------------------------------------------ */
/* Writer — atomic publication (10.3) with 10.1 containment            */
/* ------------------------------------------------------------------ */

const PUBLISH_INPUT_ERROR_CODES = new Set([
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
  "EXDEV",
  "ENOSYS",
  "EMLINK",
]);

function comparablePath(p: string): string {
  let out = p.replace(/[\\/]+/g, "/");
  if (out.length > 1 && out.endsWith("/")) out = out.replace(/\/+$/, "");
  return process.platform === "win32" ? out.toLowerCase() : out;
}

export interface PublishCheckpointOptions {
  /** Caller-supplied absolute target path (verbatim in the result). */
  readonly path: string;
  readonly document: CheckpointDocument;
  /** Configured projectRoots, treated as opaque containment roots. */
  readonly roots: readonly string[];
  readonly overwrite: boolean;
}

export interface PublishCheckpointResult {
  readonly bytesWritten: number;
  /** The resolved absolute path that was written. */
  readonly resolvedPath: string;
}

/**
 * Containment + atomic publication of a checkpoint (10.1 scoped + 10.3):
 *
 *  - the parent directory must already exist (never auto-created);
 *  - containment is decided by realpath against the roots; the no-symlink
 *    component walk applies to components AT OR BELOW the root (ancestors
 *    above it are pre-normalized by startup canonicalization — `/tmp` →
 *    `/private/tmp` is fine; a link at or below the root is refused, never
 *    written through);
 *  - a symlink at the target path itself is refused in BOTH modes
 *    (dangling included);
 *  - pre-write and post-write containment checks mirror
 *    `assertSafeArtifactDir` / `assertContainedWrittenFile`;
 *  - temp sibling `<name>.<uuid>.tmp` → flush + fsync → default:
 *    `link(temp, target)` + `unlink(temp)` (EEXIST ⇒ CONFLICT, race-atomic
 *    no-clobber); `overwrite:true`: rename over the target;
 *  - best-effort directory fsync (swallowed).
 */
export async function publishCheckpoint(
  opts: PublishCheckpointOptions,
): Promise<PublishCheckpointResult> {
  const verb = "project.save";
  const targetPath = resolve(opts.path);
  const targetDir = dirname(targetPath);
  const overwrite = opts.overwrite;

  // ---- pre-write containment (mirrors assertSafeArtifactDir) ----------
  const dirStat = await lstat(targetDir).catch(() => null);
  if (!dirStat) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: target directory does not exist (it is never auto-created): ${targetDir}`,
      { path: opts.path },
    );
  }
  // Containment FIRST, so a genuine escape always reports the escape
  // wording regardless of what the lexical components look like.
  const dirContainment = resolveContainedPathDetailed(targetDir, opts.roots);
  if (dirContainment.kind === "unresolvable") {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: target directory cannot be verified: ${targetDir}`,
      { path: opts.path },
    );
  }
  if (dirContainment.kind === "outside") {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: path escapes the configured project roots`,
      { path: opts.path, projectRoots: [...opts.roots] },
    );
  }
  if (dirStat.isSymbolicLink()) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: refusing to write through a symlink/junction in the output path: ${targetDir}`,
      { path: opts.path },
    );
  }
  if (!dirStat.isDirectory()) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `${verb}: target directory cannot be used (not a directory): ${targetDir}`,
      { path: opts.path },
    );
  }
  // Component walk at or below the canonical root (10.1, fourth-round scope):
  // walk the LEXICAL components between the root prefix and the target
  // directory; every one of them must be a real directory, never a link.
  await assertNoSymlinkComponentsBelowRoot(targetPath, targetDir, opts.roots, verb);

  // ---- target pre-check (honest early error; link() is the real gate) --
  const targetStat = await lstat(targetPath).catch(() => null);
  if (targetStat?.isSymbolicLink()) {
    throw new FacadeError(
      "CONFLICT",
      `${verb}: refusing to publish through a symlink/junction at the target path: ${targetPath}`,
      { path: opts.path },
    );
  }
  if (targetStat && !overwrite) {
    throw new FacadeError(
      "CONFLICT",
      `${verb}: target already exists — the default is no-overwrite; pick a fresh versioned path or pass overwrite:true`,
      { path: opts.path },
    );
  }

  // ---- temp sibling → flush + fsync -----------------------------------
  const bytes = Buffer.from(`${JSON.stringify(opts.document, null, 2)}\n`, "utf8");
  const tempPath = join(targetDir, `${basename(targetPath)}.${randomUUID()}.tmp`);
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }

  // ---- atomic publication, per mode -----------------------------------
  try {
    if (overwrite) {
      await rename(tempPath, targetPath);
    } else {
      // Hard-link publication: fails EEXIST atomically if the target has
      // appeared since the existence check — no-clobber is a filesystem
      // guarantee, not an advisory check-then-act.
      await link(tempPath, targetPath);
      await unlink(tempPath).catch(() => undefined);
    }
  } catch (error) {
    // Leave at most an inert .tmp behind — never a half-written target.
    await unlink(tempPath).catch(() => undefined);
    throw mapPublishError(error, targetPath);
  }

  // ---- post-write containment (mirrors assertContainedWrittenFile) -----
  const post = resolveContainedPathDetailed(targetPath, opts.roots);
  if (post.kind !== "ok") {
    await rm(targetPath, { force: true }).catch(() => undefined);
    throw new FacadeError(
      "ACTION_FAILED",
      `${verb}: the checkpoint escaped the configured project roots — the file was rejected and removed`,
      { path: opts.path },
    );
  }

  // ---- best-effort directory fsync (swallowed; impossible on Windows) --
  await openDirectoryFsync(targetDir);

  return { bytesWritten: bytes.length, resolvedPath: post.path };
}

function mapPublishError(error: unknown, targetPath: string): FacadeError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EEXIST") {
    return new FacadeError(
      "CONFLICT",
      `project.save: target already exists — the default is no-overwrite; pick a fresh versioned path or pass overwrite:true`,
      { path: targetPath },
    );
  }
  if (code !== undefined && PUBLISH_INPUT_ERROR_CODES.has(code)) {
    return new FacadeError(
      "ACTION_FAILED",
      `project.save: this filesystem cannot publish the checkpoint atomically (hard-link publication unsupported: ${code}) — nothing was saved`,
      { path: targetPath, errno: code },
    );
  }
  return new FacadeError(
    "ACTION_FAILED",
    `project.save: the checkpoint could not be published atomically: ${
      error instanceof Error ? error.message : String(error)
    }`,
    { path: targetPath, ...(code !== undefined ? { errno: code } : {}) },
  );
}

/**
 * The no-symlink walk of 10.1, scoped to components at or below the root:
 * find the root prefix (as configured, or its realpath) that lexically
 * contains the target, then lstat every component between that prefix and
 * the target directory. A symlink found there is refused — never written
 * through — while a link ABOVE the root (e.g. /tmp itself on macOS) is
 * accepted because startup canonicalization has already normalized it.
 */
async function assertNoSymlinkComponentsBelowRoot(
  targetPath: string,
  targetDir: string,
  roots: readonly string[],
  verb: string,
): Promise<void> {
  const comparableTarget = comparablePath(targetDir);
  const prefixes: string[] = [];
  for (const root of roots) {
    prefixes.push(root);
    const real = await realpath(root).catch(() => null);
    if (real) prefixes.push(real);
  }
  let walkRoot: string | null = null;
  for (const prefix of prefixes) {
    const comparablePrefix = comparablePath(prefix);
    if (
      comparableTarget === comparablePrefix ||
      comparableTarget.startsWith(`${comparablePrefix}/`)
    ) {
      if (walkRoot === null || comparablePrefix.length > comparablePath(walkRoot).length) {
        walkRoot = prefix;
      }
    }
  }
  if (walkRoot === null) return; // containment already decided above
  const rel = relative(resolve(walkRoot), targetDir);
  if (rel === "" || rel === ".") return;
  const segments = rel.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
  let acc = resolve(walkRoot);
  for (const segment of segments) {
    acc = join(acc, segment);
    const st = await lstat(acc).catch(() => null);
    if (!st) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: target directory cannot be verified: ${acc}`,
        { path: targetPath },
      );
    }
    if (st.isSymbolicLink()) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: refusing to write through a symlink/junction in the output path: ${acc}`,
        { path: targetPath },
      );
    }
    if (!st.isDirectory()) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: target directory cannot be used (not a directory): ${acc}`,
        { path: targetPath },
      );
    }
  }
}

async function openDirectoryFsync(dir: string): Promise<void> {
  let handle: import("node:fs/promises").FileHandle | null = null;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // Best-effort by contract (10.3): platforms that cannot fsync a
    // directory (Windows) simply skip it.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
