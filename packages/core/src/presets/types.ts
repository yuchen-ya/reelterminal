/**
 * User-level custom preset data model.
 *
 * A preset is a named, user-owned parameter bundle (text style, clip effect
 * stack, transition parameters, or inline SVG graphics) that lives outside
 * any project so it can be reused across projects by both the GUI panels and
 * the agent session. Records are plain JSON (thumbnails are inline data URLs)
 * and persist in the renderer's IndexedDB (legacy store name registered in
 * src/legacy/physical-identifiers.ts).
 *
 * Isolation guarantee (load-bearing): applying a preset copies the payload
 * BY VALUE into project actions. Projects never store a preset id or hold a
 * reference to a record, so renaming, editing, or deleting a preset can never
 * affect clips already created from it. Payloads must never reference
 * external bytes (media ids, asset ids, file paths): validation rejects any
 * key outside the per-kind whitelist, which keeps "removing a preset is the
 * only reclamation point" true by construction.
 *
 * `revision` is a monotonic per-record counter used as a CAS guard so a
 * concurrent editor (GUI panel vs agent session) can never be silently
 * overwritten.
 */

export const PRESET_KINDS = [
  "text",
  "effect",
  "transition",
  "graphics",
] as const;
export type PresetKind = (typeof PRESET_KINDS)[number];

/** Current record format version persisted in IndexedDB. */
export const PRESET_RECORD_VERSION = 1;

/**
 * Semantic version of the payload contract. Bump when a payload kind changes
 * shape incompatibly; payloads stamped with a higher version are rejected
 * with PAYLOAD_VERSION_UNSUPPORTED instead of being silently misread.
 */
export const PRESET_PAYLOAD_SCHEMA_VERSION = 1;

/** One entry of an effect-stack preset: engine effect type plus parameters. */
export interface EffectPresetItem {
  readonly type: string;
  readonly params: Record<string, unknown>;
}

interface PayloadBase {
  readonly schemaVersion: typeof PRESET_PAYLOAD_SCHEMA_VERSION;
}

/** Whitelist-filtered TextStyle fields (never `shader` — presets are parameter-only). */
export interface TextPresetPayload extends PayloadBase {
  readonly kind: "text";
  readonly style: Record<string, unknown>;
  /** Optional placeholder text used when the preset creates a new clip. */
  readonly sampleText?: string;
}

/** 1..8 engine clip effects (video layer effect stack). */
export interface EffectPresetPayload extends PayloadBase {
  readonly kind: "effect";
  readonly effects: readonly EffectPresetItem[];
}

/** Transition type plus optional duration override and parameter overrides. */
export interface TransitionPresetPayload extends PayloadBase {
  readonly kind: "transition";
  readonly type: string;
  readonly durationSec?: number;
  readonly params: Record<string, unknown>;
}

/** Inline SVG source, validated by the shared DOM-free SVG validator. */
export interface GraphicsPresetPayload extends PayloadBase {
  readonly kind: "graphics";
  readonly svg: string;
}

export type PresetPayload =
  | TextPresetPayload
  | EffectPresetPayload
  | TransitionPresetPayload
  | GraphicsPresetPayload;

/**
 * A stored custom preset. Ids are operation identity (`preset_<uuid>`); the
 * name is a search label only and is NOT unique. `builtinBaseId` is a
 * read-only provenance marker ("text:Heading") recorded on the preset side
 * only — it never enters the project when applied.
 */
export interface CustomPresetRecord {
  readonly id: string;
  readonly kind: PresetKind;
  readonly name: string;
  readonly tags: readonly string[];
  readonly builtinBaseId?: string;
  /** Inline PNG data URL; decoded bytes capped and IHDR-checked at validation. */
  readonly thumbnailDataUrl?: string;
  readonly payload: PresetPayload;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
  readonly recordVersion: number;
}
