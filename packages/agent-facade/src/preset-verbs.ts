/**
 * The preset.* verb contract (user-level custom presets).
 *
 * Custom presets are USER-level state: named parameter bundles (text style,
 * clip effect stack, transition parameters, inline SVG graphics) that live in
 * the desktop GUI renderer's IndexedDB (`openreel-custom-presets`), shared by
 * the GUI panels and the agent session. In live sessions the facade stays
 * stateless: every verb validates params here and forwards through the narrow
 * `PresetLibraryBridge` to the renderer, which owns the canonical records and
 * persistence. Headless sessions honestly report the verbs UNSUPPORTED (there
 * is no GUI renderer and therefore no preset store).
 *
 * Concurrency rules mirroring the material/font seams:
 *  - Write verbs require the single-writer lease (gate), reads do not.
 *  - Mutating verbs accept an idempotencyKey; retries replay, never
 *    duplicate (facade ledger + renderer commit ledger for apply).
 *  - preset.update accepts expectedRevision (the PRESET record's revision
 *    counter, distinct from the project revision) for CAS protection; a
 *    mismatch fails CONFLICT.
 *  - preset.apply expands the preset into existing reversible core actions
 *    renderer-side and commits them through the live write channel as ONE
 *    undo unit; the placement duration cap is a hard rejection there
 *    (PLACEMENT_INVALID), never a silent clamp.
 */
import type { CustomPresetRecord, PresetKind } from "@reelterminal/core/presets/types";
import { validatePresetPayload } from "@reelterminal/core/presets/validate";

export const PRESET_VERBS = [
  "preset.list",
  "preset.get",
  "preset.create",
  "preset.update",
  "preset.remove",
  "preset.apply",
] as const;

export type PresetVerb = (typeof PRESET_VERBS)[number];

/** Agent-facing facade limits (the renderer re-checks payload rules itself). */
export const PRESET_LIBRARY_LIMITS = {
  maxPageSize: 200,
  maxNameLength: 80,
  maxTags: 20,
  maxQueryLength: 200,
} as const;

/* ------------------------------ params ------------------------------ */

export interface PresetListParams {
  /** Filter by preset kind; omitted lists every kind. */
  readonly kind?: PresetKind;
  /** Free-text filter over name and tags. */
  readonly query?: string;
  /**
   * Metadata-only listing (default): payload contents are omitted. Pass true
   * to embed the full payload in every item.
   */
  readonly includePayload?: boolean;
}

export interface PresetGetParams {
  readonly id: string;
}

export interface PresetCreateParams {
  readonly kind: PresetKind;
  /** Trimmed, 1..80 characters; duplicate names are allowed (ids are identity). */
  readonly name: string;
  /**
   * Kind-specific parameter bundle. Deep validation (closed per-kind
   * whitelists, no shader, no external references) runs in this process and
   * again in the renderer — unknown fields are rejected, never dropped.
   */
  readonly payload: Record<string, unknown>;
  readonly tags?: readonly string[];
  /** Optional provenance marker ("text:Heading") when derived from a built-in. */
  readonly builtinBaseId?: string;
  /** Optional inline PNG data URL (<=64 KiB decoded, <=256x160). */
  readonly thumbnailDataUrl?: string;
  readonly idempotencyKey?: string;
}

export interface PresetUpdateParams {
  readonly id: string;
  readonly name?: string;
  readonly tags?: readonly string[];
  readonly payload?: Record<string, unknown>;
  /**
   * Omit to keep the current thumbnail; a non-empty PNG data URL replaces
   * it. Clearing is not an agent operation — the wire schema accepts only
   * non-empty strings, so null (despite the widened typing here) and ""
   * fail INVALID_PARAMS at runtime.
   */
  readonly thumbnailDataUrl?: string | null;
  /** CAS guard: the preset record's revision the caller last saw. */
  readonly expectedRevision?: number;
  readonly idempotencyKey?: string;
}

export interface PresetRemoveParams {
  readonly id: string;
  /**
   * Removing a preset never touches projects already built from it (they
   * keep parameter copies); no force flag exists by design.
   */
  readonly idempotencyKey?: string;
}

/** Where a preset's parameters land. Tagged by kind; checked against the payload kind. */
export type PresetApplyTarget =
  | {
      readonly kind: "text";
      readonly mode: "updateStyle";
      readonly clipId: string;
    }
  | { readonly kind: "effect"; readonly clipIds: readonly string[] }
  | { readonly kind: "transition"; readonly clipAId: string; readonly clipBId?: string }
  | {
      readonly kind: "graphics";
      /** Graphics track to place the SVG clip on; omitted picks/auto-creates one. */
      readonly trackId?: string;
      /** Timeline seconds; defaults to 0. */
      readonly startTime?: number;
      /** Clip duration in seconds; defaults to the renderer's graphics preset constant (5s). */
      readonly durationSec?: number;
    };

export interface PresetApplyParams {
  readonly presetId: string;
  /** Kind-specific target; required — the GUI selection is never borrowed. */
  readonly target: PresetApplyTarget;
  /** Project revision CAS; an omitted value is guarded with the current revision. */
  readonly expectedRevision?: number;
  readonly idempotencyKey?: string;
}

/* ------------------------------ results ----------------------------- */

/** Metadata projection of one preset (payload/thumbnail bytes omitted). */
export interface PresetListItem {
  readonly id: string;
  readonly kind: PresetKind;
  readonly name: string;
  readonly tags: readonly string[];
  readonly builtinBaseId?: string;
  readonly hasThumbnail: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
  /** Present only when preset.list was called with includePayload: true. */
  readonly payload?: Record<string, unknown>;
}

export interface PresetListResult {
  readonly presets: readonly PresetListItem[];
  readonly total: number;
}

export interface PresetGetResult {
  readonly preset: CustomPresetRecord;
}

export interface PresetCreateResult {
  /** True when an idempotency-keyed retry replayed the committed result. */
  readonly replayed?: boolean;
  readonly preset: CustomPresetRecord;
}

export interface PresetUpdateResult {
  /** True when an idempotency-keyed retry replayed the committed result. */
  readonly replayed?: boolean;
  readonly preset: CustomPresetRecord;
}

export interface PresetRemoveResult {
  /** True when an idempotency-keyed retry replayed the committed result. */
  readonly replayed?: boolean;
  readonly id: string;
  /** True when the id was already absent (removal is idempotent). */
  readonly alreadyGone: boolean;
}

export interface PresetApplyResult {
  /** True when an idempotency-keyed retry replayed the committed result. */
  readonly replayed?: boolean;
  readonly presetId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly revision: number;
  readonly applied: {
    readonly kind: PresetKind;
    /** Clips the parameters landed on (the styled clip / every targeted clip / the cut / the created SVG clip). */
    readonly clipIds: readonly string[];
    /** Set for transition targets: the created transition id. */
    readonly transitionId?: string;
    /** Set for graphics targets: the graphics track the SVG clip landed on. */
    readonly trackId?: string;
  };
}

/* --------------------------- the bridge seam ------------------------- */

/** JSON-safe forward request the facade sends to the renderer. */
export type PresetLibraryBridgeVerb =
  | "list"
  | "get"
  | "create"
  | "update"
  | "remove"
  | "apply";

export interface PresetLibraryBridgeRequest {
  readonly verb: PresetLibraryBridgeVerb;
  readonly params: Record<string, unknown>;
}

export interface PresetLibraryBridgeError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export type PresetLibraryBridgeReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: PresetLibraryBridgeError };

/**
 * The renderer seam: implementations (desktop main → IPC → web renderer)
 * execute against the canonical user-level preset store and return detached
 * JSON-safe values. Errors carry stable codes; revision conflicts use
 * "CONFLICT" and placement problems "PLACEMENT_INVALID".
 */
export type PresetLibraryBridge = (
  request: PresetLibraryBridgeRequest,
) => Promise<PresetLibraryBridgeReply>;

/** Capability block reported by capabilities.get. */
export interface CustomPresetCapability {
  readonly available: boolean;
  readonly reason?: string;
  readonly kinds: readonly PresetKind[];
  readonly limits: {
    readonly maxNameLength: number;
    readonly maxTags: number;
    readonly maxEffectsPerPreset: number;
    readonly maxThumbnailBytes: number;
    readonly maxSvgBytes: number;
  };
  readonly persistence: "renderer-indexeddb";
  readonly apply: {
    readonly available: boolean;
    readonly targets: readonly [
      "text:updateStyle",
      "effect:clipIds",
      "transition:clipAId",
      "graphics:trackId",
    ];
    readonly reason?: string;
  };
}

/* --------------------- shared boundary predicates --------------------- */

/**
 * True when the bundle passes the deep per-kind payload validation (the
 * SAME core validator the GUI save path uses). The session body and the
 * transports' runtime mirrors share this predicate so neither can drift.
 */
export function isValidPresetPayload(payload: unknown): boolean {
  return validatePresetPayload(payload).ok;
}

/**
 * Structural apply-target check shared by the session body and the
 * transports' runtime mirrors. Returns a human-readable problem, or null
 * when the target is structurally valid (payload-kind pairing and clip
 * existence stay renderer-side where the project lives).
 */
export function presetApplyTargetProblem(target: unknown): string | null {
  if (typeof target !== "object" || target === null) {
    return "preset.apply requires a target object";
  }
  const record = target as Record<string, unknown>;
  const kind = record.kind;
  if (kind === "text") {
    if (record.mode !== "updateStyle") {
      return 'text targets support {"kind":"text","mode":"updateStyle","clipId":...} — create a text clip first (edit.apply text.create), then style it from the preset';
    }
    if (typeof record.clipId !== "string" || record.clipId.length === 0) {
      return "text target requires clipId";
    }
    return null;
  }
  if (kind === "effect") {
    const clipIds = record.clipIds;
    if (
      !Array.isArray(clipIds) ||
      clipIds.length === 0 ||
      !clipIds.every((id) => typeof id === "string" && id.length > 0)
    ) {
      return "effect target requires a non-empty clipIds array";
    }
    return null;
  }
  if (kind === "transition") {
    if (typeof record.clipAId !== "string" || record.clipAId.length === 0) {
      return "transition target requires clipAId (the clip whose out-point transitions)";
    }
    if (
      record.clipBId !== undefined &&
      (typeof record.clipBId !== "string" || record.clipBId.length === 0)
    ) {
      return "transition clipBId must be a non-empty clip id";
    }
    return null;
  }
  if (kind === "graphics") {
    if (
      record.trackId !== undefined &&
      (typeof record.trackId !== "string" || record.trackId.length === 0)
    ) {
      return "graphics trackId must be a non-empty graphics track id; omit it to target the first graphics track (one is created when none exists)";
    }
    if (
      record.startTime !== undefined &&
      (typeof record.startTime !== "number" ||
        !Number.isFinite(record.startTime) ||
        record.startTime < 0)
    ) {
      return "graphics startTime must be a finite number >= 0 (timeline seconds)";
    }
    if (
      record.durationSec !== undefined &&
      (typeof record.durationSec !== "number" ||
        !Number.isFinite(record.durationSec) ||
        record.durationSec <= 0)
    ) {
      return "graphics durationSec must be a finite number > 0 (seconds); omit it for the default 5s";
    }
    return null;
  }
  return `unknown target kind "${String(kind)}" (expected text | effect | transition | graphics)`;
}
