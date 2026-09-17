/**
 * DOM-free validation for custom preset payloads, names, and thumbnails.
 *
 * This module is the single validation contract shared by every writer and
 * reader of presets: GUI save paths, the agent facade, and the apply-time
 * re-check before a payload is expanded into project actions (the core
 * `effect/add` and `transition/set` executors write parameters verbatim, so
 * this layer is the only place that can reject unknown or out-of-range
 * values). Pure string/number checks — safe to run in Node processes.
 *
 * Error shape mirrors the material library bridge: a stable `code` for
 * programmatic mapping plus a human-readable `message` and structured
 * `details` ({ field, expected, actual }).
 */
import type { TextStyle } from "../text/types";
import {
  AUDIO_EFFECT_TYPES,
  EFFECT_DEFINITIONS,
  TRANSITION_TYPES,
} from "../types/effects";
import type { EffectParamDefinition } from "../types/effects";
import type { TransitionType } from "../types/effects";
import { TransitionEngine } from "../video/transition-engine";
import { validateSvgContent } from "../graphics/svg-validation";
import {
  PRESET_PAYLOAD_SCHEMA_VERSION,
  PRESET_KINDS,
  PRESET_RECORD_VERSION,
  type EffectPresetItem,
  type EffectPresetPayload,
  type GraphicsPresetPayload,
  type PresetKind,
  type PresetPayload,
  type TextPresetPayload,
  type TransitionPresetPayload,
} from "./types";

/* ------------------------------ limits ------------------------------ */

export const MAX_PRESET_NAME_LENGTH = 80;
export const MAX_SAMPLE_TEXT_LENGTH = 200;
export const MAX_EFFECTS_PER_PRESET = 8;
/** Decoded byte ceiling for the inline PNG thumbnail. */
export const MAX_THUMBNAIL_BYTES = 64 * 1024;
export const MAX_THUMBNAIL_WIDTH = 256;
export const MAX_THUMBNAIL_HEIGHT = 160;
/** Source byte ceiling for inline SVG graphics payloads. */
export const MAX_GRAPHICS_SVG_BYTES = 256 * 1024;
export const MIN_TRANSITION_DURATION_SEC = 0.1;
export const MAX_TRANSITION_DURATION_SEC = 10;

/* --------------------------- error contract -------------------------- */

export type PresetValidationCode =
  | "INVALID_PAYLOAD"
  | "PAYLOAD_VERSION_UNSUPPORTED"
  | "UNKNOWN_PAYLOAD_FIELD"
  | "UNSUPPORTED_PAYLOAD_FIELD"
  | "UNSUPPORTED_PARAM_TYPE"
  | "INVALID_PARAM_VALUE"
  | "UNKNOWN_EFFECT_TYPE"
  | "UNSUPPORTED_EFFECT_TYPE"
  | "UNKNOWN_TRANSITION_TYPE"
  | "INVALID_SVG"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_NAME"
  | "INVALID_THUMBNAIL";

export interface PresetValidationErrorDetails {
  readonly field?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export type PresetValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: PresetValidationCode;
      readonly message: string;
      readonly details?: PresetValidationErrorDetails;
    };

function fail<T>(
  code: PresetValidationCode,
  message: string,
  details?: PresetValidationErrorDetails,
): PresetValidationResult<T> {
  return details ? { ok: false, code, message, details } : { ok: false, code, message };
}

function ok<T>(value: T): PresetValidationResult<T> {
  return { ok: true, value };
}

/* ------------------------------- text -------------------------------- */

/**
 * Every non-shader TextStyle display field, whitelisted for presets. The two
 * exported assertion types below lock this list to the TextStyle shape: if a
 * field is added to or removed from TextStyle, `TextStyleWhitelistGaps`
 * stops being `never` and typechecking fails until the whitelist is updated.
 * `shader` is intentionally excluded — it references the runtime shader
 * registry, and presets carry parameters only.
 */
export const TEXT_STYLE_FIELDS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "color",
  "backgroundColor",
  "strokeColor",
  "strokeWidth",
  "shadowColor",
  "shadowBlur",
  "shadowOffsetX",
  "shadowOffsetY",
  "textAlign",
  "verticalAlign",
  "lineHeight",
  "letterSpacing",
  "textDecoration",
] as const satisfies readonly Exclude<keyof TextStyle, "shader">[];

/** Fields missing from the whitelist; `never` while the list is complete. */
export type TextStyleWhitelistGaps = Exclude<
  keyof TextStyle,
  "shader" | (typeof TEXT_STYLE_FIELDS)[number]
>;
/** Compile-time assertion: `true` only when the whitelist covers TextStyle. */
export type AssertTextStyleWhitelistComplete = [
  TextStyleWhitelistGaps,
] extends [never]
  ? true
  : false;

/**
 * Runtime mirror of the compile-time assertion above; assigning `true` here
 * fails typechecking whenever the whitelist drifts from TextStyle.
 */
export const ASSERT_TEXT_STYLE_WHITELIST_COMPLETE: AssertTextStyleWhitelistComplete =
  true;

const TEXT_STYLE_FIELD_SET: ReadonlySet<string> = new Set(TEXT_STYLE_FIELDS);

const FONT_WEIGHT_NUMBERS: ReadonlySet<number> = new Set([
  100, 200, 300, 400, 500, 600, 700, 800, 900,
]);
const FONT_WEIGHT_STRINGS: ReadonlySet<string> = new Set(["normal", "bold"]);
const FONT_STYLE_VALUES: ReadonlySet<string> = new Set(["normal", "italic"]);
const TEXT_ALIGN_VALUES: ReadonlySet<string> = new Set([
  "left",
  "center",
  "right",
  "justify",
]);
const VERTICAL_ALIGN_VALUES: ReadonlySet<string> = new Set([
  "top",
  "middle",
  "bottom",
]);
const TEXT_DECORATION_VALUES: ReadonlySet<string> = new Set([
  "none",
  "underline",
  "line-through",
  "overline",
]);

const ENUM_STYLE_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  fontWeight: FONT_WEIGHT_STRINGS,
  fontStyle: FONT_STYLE_VALUES,
  textAlign: TEXT_ALIGN_VALUES,
  verticalAlign: VERTICAL_ALIGN_VALUES,
  textDecoration: TEXT_DECORATION_VALUES,
};

const COLOR_STYLE_FIELDS: ReadonlySet<string> = new Set([
  "color",
  "backgroundColor",
  "strokeColor",
  "shadowColor",
]);

/** Free-form string fields (fontFamily is a name reference, never bytes). */
const STRING_STYLE_FIELDS: ReadonlySet<string> = new Set(["fontFamily"]);

const NON_NEGATIVE_STYLE_FIELDS: ReadonlySet<string> = new Set([
  "fontSize",
  "lineHeight",
  "strokeWidth",
  "shadowBlur",
]);

function validateTextStyleValue(
  key: string,
  value: unknown,
): PresetValidationResult<unknown> {
  if (key === "fontWeight") {
    if (typeof value === "number" && FONT_WEIGHT_NUMBERS.has(value)) {
      return ok(value);
    }
    if (typeof value === "string" && FONT_WEIGHT_STRINGS.has(value)) {
      return ok(value);
    }
    return fail(
      "INVALID_PARAM_VALUE",
      `style.fontWeight must be one of 100..900, "normal" or "bold"`,
      { field: "style.fontWeight", expected: "100..900|normal|bold", actual: describe(value) },
    );
  }

  const enumSet = ENUM_STYLE_FIELDS[key];
  if (enumSet) {
    if (typeof value === "string" && enumSet.has(value)) return ok(value);
    return fail("INVALID_PARAM_VALUE", `style.${key} has an unsupported value`, {
      field: `style.${key}`,
      expected: [...enumSet].join("|"),
      actual: describe(value),
    });
  }

  if (COLOR_STYLE_FIELDS.has(key)) {
    // Core layer checks string format only; no CSS parser runs on this
    // Node-safe path, so an invalid color string is not a validation
    // error — canvas assignments (fillStyle/shadowColor) silently ignore
    // invalid values at render time.
    if (typeof value === "string" && value.trim().length > 0) return ok(value);
    return fail("INVALID_PARAM_VALUE", `style.${key} must be a CSS color string`, {
      field: `style.${key}`,
      expected: "CSS color string",
      actual: describe(value),
    });
  }

  if (STRING_STYLE_FIELDS.has(key)) {
    if (typeof value === "string" && value.trim().length > 0) return ok(value);
    return fail("INVALID_PARAM_VALUE", `style.${key} must be a non-empty font family name`, {
      field: `style.${key}`,
      expected: "font family name",
      actual: describe(value),
    });
  }

  // Remaining whitelisted fields are numeric.
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail("INVALID_PARAM_VALUE", `style.${key} must be a finite number`, {
      field: `style.${key}`,
      expected: "finite number",
      actual: describe(value),
    });
  }
  if (NON_NEGATIVE_STYLE_FIELDS.has(key) && value < 0) {
    return fail("INVALID_PARAM_VALUE", `style.${key} must be >= 0`, {
      field: `style.${key}`,
      expected: ">= 0",
      actual: describe(value),
    });
  }
  return ok(value);
}

export function validateTextPresetStyle(
  style: unknown,
): PresetValidationResult<Partial<TextStyle>> {
  if (typeof style !== "object" || style === null || Array.isArray(style)) {
    return fail("INVALID_PAYLOAD", "text preset style must be an object", {
      field: "style",
      expected: "object",
      actual: describe(style),
    });
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style)) {
    if (key === "shader") {
      return fail(
        "UNSUPPORTED_PAYLOAD_FIELD",
        "shader presets are not supported; presets are parameter-only",
        { field: `style.${key}` },
      );
    }
    if (!TEXT_STYLE_FIELD_SET.has(key)) {
      return fail(
        "UNKNOWN_PAYLOAD_FIELD",
        `unknown text style field "${key}"`,
        { field: `style.${key}` },
      );
    }
    const checked = validateTextStyleValue(key, value);
    if (!checked.ok) return checked;
    out[key] = checked.value;
  }
  return ok(out as Partial<TextStyle>);
}

/* ------------------------------ effects ------------------------------ */

function isAudioEffectType(type: string): boolean {
  return (AUDIO_EFFECT_TYPES as readonly string[]).includes(type);
}

function validateEffectPresetItem(
  item: unknown,
  index: number,
): PresetValidationResult<EffectPresetItem> {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return fail("INVALID_PAYLOAD", `effects[${index}] must be an object`, {
      field: `effects[${index}]`,
      expected: "object",
      actual: describe(item),
    });
  }
  const record = item as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "type" && key !== "params") {
      return fail("UNKNOWN_PAYLOAD_FIELD", `unknown field "${key}" in effects[${index}]`, {
        field: `effects[${index}].${key}`,
      });
    }
  }
  const type = record.type;
  if (typeof type !== "string" || type.length === 0) {
    return fail("INVALID_PAYLOAD", `effects[${index}].type must be a non-empty string`, {
      field: `effects[${index}].type`,
      expected: "string",
      actual: describe(type),
    });
  }
  const definition = EFFECT_DEFINITIONS.find((def) => def.type === type);
  if (!definition) {
    if (isAudioEffectType(type)) {
      return fail(
        "UNSUPPORTED_EFFECT_TYPE",
        `effect "${type}" is an audio effect; effect presets cover the clip video effect stack only`,
        { field: `effects[${index}].type`, actual: type },
      );
    }
    return fail(
      "UNKNOWN_EFFECT_TYPE",
      `engine does not provide this effect: "${type}"`,
      { field: `effects[${index}].type`, actual: type },
    );
  }

  const rawParams = record.params ?? {};
  if (typeof rawParams !== "object" || rawParams === null || Array.isArray(rawParams)) {
    return fail("INVALID_PAYLOAD", `effects[${index}].params must be an object`, {
      field: `effects[${index}].params`,
      expected: "object",
      actual: describe(rawParams),
    });
  }
  const params: Record<string, unknown> = {};
  const byKey = new Map<string, EffectParamDefinition>(
    definition.params.map((param) => [param.key, param]),
  );
  for (const [key, value] of Object.entries(rawParams)) {
    const paramDef = byKey.get(key);
    if (!paramDef) {
      return fail(
        "UNKNOWN_PAYLOAD_FIELD",
        `unknown parameter "${key}" for effect "${type}"`,
        { field: `effects[${index}].params.${key}` },
      );
    }
    const checked = validateEffectParamValue(paramDef, value);
    if (!checked.ok) {
      return checked.code === "INVALID_PARAM_VALUE" || checked.code === "UNSUPPORTED_PARAM_TYPE"
        ? { ...checked, details: prefixField(checked.details, `effects[${index}].params`) }
        : checked;
    }
    params[key] = value;
  }
  return ok({ type, params });
}

function validateEffectParamValue(
  param: EffectParamDefinition,
  value: unknown,
): PresetValidationResult<unknown> {
  const where = param.key;
  if (param.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fail("INVALID_PARAM_VALUE", `parameter "${where}" must be a finite number`, {
        field: where,
        expected: "finite number",
        actual: describe(value),
      });
    }
    if (
      (param.min !== undefined && value < param.min) ||
      (param.max !== undefined && value > param.max)
    ) {
      return fail(
        "INVALID_PARAM_VALUE",
        `parameter "${where}" is out of range (rejected, not clamped)`,
        {
          field: where,
          expected: `[${param.min ?? "-inf"}, ${param.max ?? "+inf"}]`,
          actual: describe(value),
        },
      );
    }
    return ok(value);
  }
  if (param.type === "color") {
    if (typeof value === "string" && value.trim().length > 0) return ok(value);
    return fail("INVALID_PARAM_VALUE", `parameter "${where}" must be a color string`, {
      field: where,
      expected: "color string",
      actual: describe(value),
    });
  }
  // vector2d / curve parameter kinds have no engine consumers yet; reject
  // them explicitly so a future definition cannot smuggle structured values
  // past this validator unnoticed.
  return fail(
    "UNSUPPORTED_PARAM_TYPE",
    `parameter "${where}" uses unsupported kind "${param.type}"`,
    { field: where, expected: "number|color", actual: param.type },
  );
}

function prefixField(
  details: PresetValidationErrorDetails | undefined,
  prefix: string,
): PresetValidationErrorDetails | undefined {
  if (!details?.field) return details;
  return { ...details, field: `${prefix}.${details.field}` };
}

export function validateEffectPresetEffects(
  effects: unknown,
): PresetValidationResult<readonly EffectPresetItem[]> {
  if (!Array.isArray(effects)) {
    return fail("INVALID_PAYLOAD", "effect preset effects must be an array", {
      field: "effects",
      expected: "array",
      actual: describe(effects),
    });
  }
  if (effects.length < 1 || effects.length > MAX_EFFECTS_PER_PRESET) {
    return fail(
      "INVALID_PAYLOAD",
      `effect preset must contain 1..${MAX_EFFECTS_PER_PRESET} effects`,
      { field: "effects", expected: `1..${MAX_EFFECTS_PER_PRESET} items`, actual: String(effects.length) },
    );
  }
  const out: EffectPresetItem[] = [];
  for (let index = 0; index < effects.length; index += 1) {
    const checked = validateEffectPresetItem(effects[index], index);
    if (!checked.ok) return checked;
    out.push(checked.value);
  }
  return ok(out);
}

/* ----------------------------- transitions ---------------------------- */

let transitionEngineInstance: TransitionEngine | null = null;

/**
 * Defaults are read from the engine's live table (never copied) so newly
 * added transition parameters keep validating instead of being falsely
 * rejected by a stale key list.
 */
export function getTransitionDefaultParams(
  type: TransitionType,
): Record<string, unknown> {
  if (!transitionEngineInstance) {
    // Constructor is Node-safe: canvas setup is lazily guarded.
    transitionEngineInstance = new TransitionEngine({ width: 2, height: 2 });
  }
  return transitionEngineInstance.getDefaultParams(type);
}

function validateTransitionParamValue(
  key: string,
  value: unknown,
  defaultValue: unknown,
): PresetValidationResult<unknown> {
  if (typeof defaultValue === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fail("INVALID_PARAM_VALUE", `transition parameter "${key}" must be a finite number`, {
        field: `params.${key}`,
        expected: "finite number",
        actual: describe(value),
      });
    }
    return ok(value);
  }
  if (typeof defaultValue === "string") {
    if (typeof value !== "string") {
      return fail("INVALID_PARAM_VALUE", `transition parameter "${key}" must be a string`, {
        field: `params.${key}`,
        expected: "string",
        actual: describe(value),
      });
    }
    return ok(value);
  }
  if (typeof defaultValue === "boolean") {
    if (typeof value !== "boolean") {
      return fail("INVALID_PARAM_VALUE", `transition parameter "${key}" must be a boolean`, {
        field: `params.${key}`,
        expected: "boolean",
        actual: describe(value),
      });
    }
    return ok(value);
  }
  if (
    typeof defaultValue === "object" &&
    defaultValue !== null &&
    !Array.isArray(defaultValue)
  ) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail("INVALID_PARAM_VALUE", `transition parameter "${key}" must be an object`, {
        field: `params.${key}`,
        expected: "object",
        actual: describe(value),
      });
    }
    const record = value as Record<string, unknown>;
    const defaultRecord = defaultValue as Record<string, unknown>;
    // Nested objects are whitelisted recursively: a key the engine default
    // does not define is rejected, never passed through, so no extra field
    // can be smuggled into the transition object (e.g. zoom/circleReveal's
    // center:{x,y}). Own-key checks use Object.hasOwn so inherited names
    // ("toString", "constructor", ...) cannot slip past either.
    for (const childKey of Object.keys(record)) {
      if (!Object.hasOwn(defaultRecord, childKey)) {
        return fail(
          "UNKNOWN_PAYLOAD_FIELD",
          `unknown parameter "${key}.${childKey}" for transition`,
          { field: `params.${key}.${childKey}` },
        );
      }
    }
    const cleaned: Record<string, unknown> = {};
    for (const [childKey, childDefault] of Object.entries(defaultRecord)) {
      const checked = validateTransitionParamValue(
        `${key}.${childKey}`,
        record[childKey],
        childDefault,
      );
      if (!checked.ok) return checked;
      cleaned[childKey] = checked.value;
    }
    return ok(cleaned);
  }
  // Unknown default shape: accept verbatim; the engine owns this parameter.
  return ok(value);
}

export function validateTransitionPresetPayload(
  type: unknown,
  params: unknown,
  durationSec: unknown,
): PresetValidationResult<{
  readonly type: string;
  readonly durationSec?: number;
  readonly params: Record<string, unknown>;
}> {
  if (typeof type !== "string" || !(TRANSITION_TYPES as readonly string[]).includes(type)) {
    return fail(
      "UNKNOWN_TRANSITION_TYPE",
      `engine does not provide this transition: ${describe(type)}`,
      { field: "type", actual: describe(type) },
    );
  }
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return fail("INVALID_PAYLOAD", "transition preset params must be an object", {
      field: "params",
      expected: "object",
      actual: describe(params),
    });
  }
  const defaults = getTransitionDefaultParams(type as TransitionType);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    // Own-key check: `key in defaults` would also match inherited names
    // ("toString", "constructor") and let them pass as "known" parameters.
    if (!Object.hasOwn(defaults, key)) {
      return fail(
        "UNKNOWN_PAYLOAD_FIELD",
        `unknown parameter "${key}" for transition "${type}"`,
        { field: `params.${key}` },
      );
    }
    const checked = validateTransitionParamValue(key, value, defaults[key]);
    if (!checked.ok) return checked;
    // Store the NORMALIZED value: for nested object parameters the check
    // returns a cleaned copy rebuilt from the engine default keys — writing
    // the raw input instead would smuggle unknown child keys back in.
    out[key] = checked.value;
  }
  if (durationSec !== undefined) {
    if (typeof durationSec !== "number" || !Number.isFinite(durationSec)) {
      return fail("INVALID_PARAM_VALUE", "durationSec must be a finite number", {
        field: "durationSec",
        expected: "finite number",
        actual: describe(durationSec),
      });
    }
    if (
      durationSec < MIN_TRANSITION_DURATION_SEC ||
      durationSec > MAX_TRANSITION_DURATION_SEC
    ) {
      return fail(
        "INVALID_PARAM_VALUE",
        `durationSec must be within ${MIN_TRANSITION_DURATION_SEC}..${MAX_TRANSITION_DURATION_SEC} seconds at the preset level; per-placement caps are enforced when applying`,
        {
          field: "durationSec",
          expected: `[${MIN_TRANSITION_DURATION_SEC}, ${MAX_TRANSITION_DURATION_SEC}]`,
          actual: describe(durationSec),
        },
      );
    }
  }
  return ok({
    type,
    ...(durationSec !== undefined ? { durationSec } : {}),
    params: out,
  });
}

/* ------------------------------ graphics ------------------------------ */

export function validateGraphicsPresetSvg(
  svg: unknown,
): PresetValidationResult<string> {
  if (typeof svg !== "string" || svg.trim().length === 0) {
    return fail("INVALID_PAYLOAD", "graphics preset svg must be a non-empty string", {
      field: "svg",
      expected: "string",
      actual: describe(svg),
    });
  }
  const byteLength = new TextEncoder().encode(svg).length;
  if (byteLength > MAX_GRAPHICS_SVG_BYTES) {
    return fail(
      "PAYLOAD_TOO_LARGE",
      `SVG source exceeds the maximum of ${MAX_GRAPHICS_SVG_BYTES} bytes (got ${byteLength})`,
      { field: "svg", expected: `<= ${MAX_GRAPHICS_SVG_BYTES} bytes`, actual: `${byteLength} bytes` },
    );
  }
  const result = validateSvgContent(svg);
  if (!result.ok) {
    return fail("INVALID_SVG", result.message, {
      field: "svg",
      expected: "safe inline SVG",
      actual: result.code,
    });
  }
  return ok(svg);
}

/* --------------------------- payload dispatch -------------------------- */

const PAYLOAD_KINDS: readonly string[] = ["text", "effect", "transition", "graphics"];

function allowedPayloadKeys(kind: string): ReadonlySet<string> {
  switch (kind) {
    case "text":
      return new Set(["schemaVersion", "kind", "style", "sampleText"]);
    case "effect":
      return new Set(["schemaVersion", "kind", "effects"]);
    case "transition":
      return new Set(["schemaVersion", "kind", "type", "durationSec", "params"]);
    default:
      return new Set(["schemaVersion", "kind", "svg"]);
  }
}

/**
 * Validates one payload of any kind and returns the normalized payload
 * (unknown keys are rejected, never silently dropped). Runs on every create
 * and again immediately before apply.
 */
export function validatePresetPayload(
  payload: unknown,
): PresetValidationResult<PresetPayload> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return fail("INVALID_PAYLOAD", "preset payload must be an object", {
      field: "payload",
      expected: "object",
      actual: describe(payload),
    });
  }
  const record = payload as Record<string, unknown>;

  const schemaVersion = record.schemaVersion;
  if (
    typeof schemaVersion !== "number" ||
    schemaVersion !== PRESET_PAYLOAD_SCHEMA_VERSION
  ) {
    return fail(
      "PAYLOAD_VERSION_UNSUPPORTED",
      `payload schemaVersion ${describe(schemaVersion)} is not supported (expected ${PRESET_PAYLOAD_SCHEMA_VERSION})`,
      {
        field: "schemaVersion",
        expected: String(PRESET_PAYLOAD_SCHEMA_VERSION),
        actual: describe(schemaVersion),
      },
    );
  }

  const kind = record.kind;
  if (typeof kind !== "string" || !PAYLOAD_KINDS.includes(kind)) {
    return fail("INVALID_PAYLOAD", `unknown preset payload kind: ${describe(kind)}`, {
      field: "kind",
      expected: PAYLOAD_KINDS.join("|"),
      actual: describe(kind),
    });
  }

  const allowed = allowedPayloadKeys(kind);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      return fail(
        "UNKNOWN_PAYLOAD_FIELD",
        `unknown field "${key}" in ${kind} preset payload`,
        { field: key },
      );
    }
  }

  switch (kind) {
    case "text": {
      const style = validateTextPresetStyle(record.style);
      if (!style.ok) return style;
      const sampleText = record.sampleText;
      if (sampleText !== undefined) {
        if (typeof sampleText !== "string") {
          return fail("INVALID_PARAM_VALUE", "sampleText must be a string", {
            field: "sampleText",
            expected: "string",
            actual: describe(sampleText),
          });
        }
        if (sampleText.length > MAX_SAMPLE_TEXT_LENGTH) {
          return fail("INVALID_PARAM_VALUE", `sampleText exceeds ${MAX_SAMPLE_TEXT_LENGTH} characters`, {
            field: "sampleText",
            expected: `<= ${MAX_SAMPLE_TEXT_LENGTH} chars`,
            actual: `${sampleText.length} chars`,
          });
        }
      }
      const normalized: TextPresetPayload = {
        schemaVersion: PRESET_PAYLOAD_SCHEMA_VERSION,
        kind: "text",
        style: style.value as Record<string, unknown>,
        ...(sampleText !== undefined ? { sampleText } : {}),
      };
      return ok(normalized);
    }
    case "effect": {
      const effects = validateEffectPresetEffects(record.effects);
      if (!effects.ok) return effects;
      const normalized: EffectPresetPayload = {
        schemaVersion: PRESET_PAYLOAD_SCHEMA_VERSION,
        kind: "effect",
        effects: effects.value,
      };
      return ok(normalized);
    }
    case "transition": {
      const transition = validateTransitionPresetPayload(
        record.type,
        record.params ?? {},
        record.durationSec,
      );
      if (!transition.ok) return transition;
      const normalized: TransitionPresetPayload = {
        schemaVersion: PRESET_PAYLOAD_SCHEMA_VERSION,
        kind: "transition",
        ...transition.value,
      };
      return ok(normalized);
    }
    default: {
      const svg = validateGraphicsPresetSvg(record.svg);
      if (!svg.ok) return svg;
      const normalized: GraphicsPresetPayload = {
        schemaVersion: PRESET_PAYLOAD_SCHEMA_VERSION,
        kind: "graphics",
        svg: svg.value,
      };
      return ok(normalized);
    }
  }
}

/* --------------------------- name / thumbnail -------------------------- */

export function validatePresetName(name: unknown): PresetValidationResult<string> {
  if (typeof name !== "string") {
    return fail("INVALID_NAME", "preset name must be a string", {
      field: "name",
      expected: "string",
      actual: describe(name),
    });
  }
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_PRESET_NAME_LENGTH) {
    return fail(
      "INVALID_NAME",
      `preset name must be 1..${MAX_PRESET_NAME_LENGTH} characters after trimming`,
      {
        field: "name",
        expected: `1..${MAX_PRESET_NAME_LENGTH} chars`,
        actual: `${trimmed.length} chars`,
      },
    );
  }
  return ok(trimmed);
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64ValueOf(char: string): number {
  const index = BASE64_ALPHABET.indexOf(char);
  return index;
}

/** Decoded byte length of a canonical (padded) base64 string, or -1. */
function base64DecodedLength(encoded: string): number {
  if (encoded.length % 4 !== 0) return -1;
  let padding = 0;
  if (encoded.endsWith("==")) padding = 2;
  else if (encoded.endsWith("=")) padding = 1;
  return (encoded.length / 4) * 3 - padding;
}

/** Decodes at most `maxBytes` bytes from the start of a base64 string. */
function decodeBase64Prefix(encoded: string, maxBytes: number): Uint8Array {
  const out = new Uint8Array(Math.min(maxBytes, base64DecodedLengthSafe(encoded)));
  let written = 0;
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < encoded.length && written < out.length; index += 1) {
    const value = base64ValueOf(encoded[index]);
    if (value < 0) break;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written] = (buffer >> bits) & 0xff;
      written += 1;
    }
  }
  return out;
}

function base64DecodedLengthSafe(encoded: string): number {
  const length = base64DecodedLength(encoded);
  return length < 0 ? 0 : length;
}

const THUMBNAIL_DATA_URL_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Inline PNG thumbnail check: exact data-URL prefix, decoded size cap, PNG
 * signature, and IHDR pixel dimensions. All pure byte/number checks so the
 * same function runs in the renderer and in Node.
 */
export function validatePresetThumbnail(
  value: unknown,
): PresetValidationResult<string> {
  if (typeof value !== "string" || !value.startsWith(THUMBNAIL_DATA_URL_PREFIX)) {
    return fail("INVALID_THUMBNAIL", "thumbnail must be a data:image/png;base64 URL", {
      field: "thumbnailDataUrl",
      expected: `${THUMBNAIL_DATA_URL_PREFIX}...`,
      actual: typeof value === "string" ? `${value.slice(0, 32)}...` : describe(value),
    });
  }
  const encoded = value.slice(THUMBNAIL_DATA_URL_PREFIX.length);
  const decodedLength = base64DecodedLength(encoded);
  if (decodedLength < 0) {
    return fail("INVALID_THUMBNAIL", "thumbnail base64 payload is malformed", {
      field: "thumbnailDataUrl",
      expected: "canonical base64",
    });
  }
  if (decodedLength > MAX_THUMBNAIL_BYTES) {
    return fail(
      "INVALID_THUMBNAIL",
      `thumbnail exceeds the maximum of ${MAX_THUMBNAIL_BYTES} decoded bytes (got ${decodedLength})`,
      {
        field: "thumbnailDataUrl",
        expected: `<= ${MAX_THUMBNAIL_BYTES} bytes`,
        actual: `${decodedLength} bytes`,
      },
    );
  }
  const header = decodeBase64Prefix(encoded, 24);
  if (
    header.length < 24 ||
    PNG_SIGNATURE.some((byte, index) => header[index] !== byte) ||
    header[8] !== 0x00 ||
    header[9] !== 0x00 ||
    header[10] !== 0x00 ||
    header[11] !== 0x0d ||
    header[12] !== 0x49 || // I
    header[13] !== 0x48 || // H
    header[14] !== 0x44 || // D
    header[15] !== 0x52 // R
  ) {
    return fail("INVALID_THUMBNAIL", "thumbnail is not a PNG image", {
      field: "thumbnailDataUrl",
      expected: "PNG image",
    });
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_THUMBNAIL_WIDTH ||
    height > MAX_THUMBNAIL_HEIGHT
  ) {
    return fail(
      "INVALID_THUMBNAIL",
      `thumbnail dimensions must be within ${MAX_THUMBNAIL_WIDTH}x${MAX_THUMBNAIL_HEIGHT} (got ${width}x${height})`,
      {
        field: "thumbnailDataUrl",
        expected: `<= ${MAX_THUMBNAIL_WIDTH}x${MAX_THUMBNAIL_HEIGHT}`,
        actual: `${width}x${height}`,
      },
    );
  }
  return ok(value);
}

/* ---------------------------- whole records ---------------------------- */

function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Validates a full preset record as it must be persisted (also the gate for
 * JSON import). `recordVersion` newer than the supported version is reported
 * as PAYLOAD_VERSION_UNSUPPORTED; the storage layer treats that as
 * "unreadable" instead of a hard error so newer records never poison lists.
 */
export function validatePresetRecord(
  record: unknown,
): PresetValidationResult<import("./types").CustomPresetRecord> {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return fail("INVALID_PAYLOAD", "preset record must be an object", {
      field: "record",
      expected: "object",
      actual: describe(record),
    });
  }
  const raw = record as Record<string, unknown>;

  if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
    return fail("INVALID_PAYLOAD", "preset record requires a non-empty id", {
      field: "id",
      expected: "non-empty string",
      actual: describe(raw.id),
    });
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !(PRESET_KINDS as readonly string[]).includes(kind)) {
    return fail("INVALID_PAYLOAD", `unknown preset kind: ${describe(kind)}`, {
      field: "kind",
      expected: PRESET_KINDS.join("|"),
      actual: describe(kind),
    });
  }
  const recordVersion = raw.recordVersion ?? PRESET_RECORD_VERSION;
  if (typeof recordVersion !== "number" || !Number.isInteger(recordVersion)) {
    return fail("INVALID_PAYLOAD", "recordVersion must be an integer", {
      field: "recordVersion",
      expected: "integer",
      actual: describe(recordVersion),
    });
  }
  if (recordVersion > PRESET_RECORD_VERSION) {
    return fail(
      "PAYLOAD_VERSION_UNSUPPORTED",
      `record version ${recordVersion} is newer than supported version ${PRESET_RECORD_VERSION}`,
      { field: "recordVersion", expected: `<= ${PRESET_RECORD_VERSION}`, actual: String(recordVersion) },
    );
  }

  const name = validatePresetName(raw.name);
  if (!name.ok) return name;

  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || raw.tags.some((tag) => typeof tag !== "string")) {
      return fail("INVALID_PAYLOAD", "tags must be an array of strings", {
        field: "tags",
        expected: "string[]",
        actual: describe(raw.tags),
      });
    }
  }

  if (raw.thumbnailDataUrl !== undefined) {
    const thumbnail = validatePresetThumbnail(raw.thumbnailDataUrl);
    if (!thumbnail.ok) return thumbnail;
  }

  const payload = validatePresetPayload(raw.payload);
  if (!payload.ok) return payload;

  if (!isValidTimestamp(raw.createdAt) || !isValidTimestamp(raw.updatedAt)) {
    return fail("INVALID_PAYLOAD", "createdAt/updatedAt must be finite timestamps", {
      field: "createdAt/updatedAt",
      expected: "finite number >= 0",
    });
  }
  if (
    typeof raw.revision !== "number" ||
    !Number.isInteger(raw.revision) ||
    raw.revision < 0
  ) {
    return fail("INVALID_PAYLOAD", "revision must be a non-negative integer", {
      field: "revision",
      expected: "integer >= 0",
      actual: describe(raw.revision),
    });
  }

  return ok({
    id: raw.id,
    kind: kind as PresetKind,
    name: name.value,
    tags: (raw.tags as readonly string[] | undefined) ?? [],
    ...(raw.builtinBaseId !== undefined ? { builtinBaseId: raw.builtinBaseId as string } : {}),
    ...(raw.thumbnailDataUrl !== undefined
      ? { thumbnailDataUrl: raw.thumbnailDataUrl as string }
      : {}),
    payload: payload.value,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    revision: raw.revision,
    recordVersion,
  });
}

/* ------------------------------- helpers ------------------------------- */

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}...` : value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return String(value);
}
