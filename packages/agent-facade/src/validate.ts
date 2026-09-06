/**
 * Strict boundary validation (audit/facade-v0.md contract #1, ADV-03/NF-3).
 *
 * Every verb argument object is checked against a CLOSED key set: unknown
 * keys, wrong types and missing required fields all fail with INVALID_PARAMS
 * before any state is touched. Nothing here may ever produce an `ok: true`
 * silent no-op.
 */
import { FacadeError } from "./errors";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

export function invalidParams(
  message: string,
  details?: Record<string, unknown>,
): FacadeError {
  return new FacadeError("INVALID_PARAMS", message, details);
}

type FieldCheck = (value: unknown) => boolean;

export type ObjectSchema = Record<string, FieldRule>;

/* ------------------------------------------------------------------ */
/* Draft-2020-12 emission metadata (ADR 0003 Decision 4)               */
/* ------------------------------------------------------------------ */

/**
 * The emitted JSON-Schema node shapes the facade produces. The emitter is
 * dependency-free and inlines everything (no `$ref` — at least one major
 * MCP client does not dereference them), keeps objects closed
 * (`additionalProperties: false`) and never places a combinator at a root.
 */
export type JsonSchemaNode =
  | { readonly type: "string"; readonly minLength?: number; readonly maxLength?: number }
  | {
      readonly type: "number";
      readonly minimum?: number;
      readonly exclusiveMinimum?: number;
      readonly maximum?: number;
    }
  | {
      readonly type: "integer";
      readonly minimum?: number;
      readonly exclusiveMinimum?: number;
      readonly maximum?: number;
    }
  | { readonly type: "boolean" }
  /** Mixed-type enums are expressed as a single `enum` (e.g. fontWeight). */
  | { readonly enum: readonly (string | number)[] }
  | { readonly const: string }
  | JsonSchemaObjectNode
  /** `maxItems: 0` pins an array the closed verb set can only ever leave empty. */
  | { readonly type: "array"; readonly maxItems: 0 }
  | {
      readonly type: "array";
      readonly items: JsonSchemaNode;
      readonly minItems?: number;
      readonly maxItems?: number;
    }
  /**
   * The one nested `anyOf` the client constraints allow: the discriminated
   * op union inside `edit.apply`'s `items` (never at a document root).
   */
  | { readonly anyOf: readonly JsonSchemaObjectNode[] };

export interface JsonSchemaObjectNode {
  readonly type: "object";
  readonly additionalProperties: false;
  readonly properties: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
}

/**
 * How a field renders into the emitted draft-2020-12 schema. Structural
 * kinds reference OTHER declarations, so a nested object is declared once
 * and both consumers (runtime validator, emitter) derive from the same
 * declaration — there is no second hand-written definition anywhere.
 *
 * A rule without `emits` is a validation-only predicate: it still validates
 * at the boundary, but the emitter refuses to emit the verb until every
 * field carries emission metadata (fail-closed against silent schema holes).
 */
export type FieldEmits =
  | { readonly kind: "leaf"; readonly schema: JsonSchemaNode }
  /** Nested closed object: derived wholesale from the referenced ObjectSchema. */
  | { readonly kind: "object"; readonly schema: ObjectSchema }
  | {
      readonly kind: "array";
      readonly items: FieldEmits;
      readonly minItems?: number;
      readonly maxItems?: number;
    }
  /** Discriminated union of closed objects (edit.apply's op set). */
  | { readonly kind: "anyOfObjects"; readonly variants: readonly ObjectSchema[] };

interface FieldRule {
  readonly check: FieldCheck;
  readonly describe: string;
  readonly required?: boolean;
  /** Emission metadata (Decision 4): the single declaration's JSON-Schema face. */
  readonly emits?: FieldEmits;
}

export const isString: FieldCheck = (v) => typeof v === "string";
export const isNonEmptyString: FieldCheck = (v) =>
  typeof v === "string" && v.length > 0;
export const isFiniteNumber: FieldCheck = (v) =>
  typeof v === "number" && Number.isFinite(v);
export const isNonNegativeNumber: FieldCheck = (v) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
export const isPositiveNumber: FieldCheck = (v) =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
export const isNonNegativeInteger: FieldCheck = (v) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;
export const isPositiveInteger: FieldCheck = (v) =>
  typeof v === "number" && Number.isInteger(v) && v > 0;
export const isBoolean: FieldCheck = (v) => typeof v === "boolean";

export function oneOf<T extends string>(values: readonly T[]): FieldCheck {
  return (v): v is T => typeof v === "string" && (values as readonly string[]).includes(v);
}

/**
 * Validate `value` against a closed schema. Returns a FRESH plain object
 * holding exactly the schema's fields (each read exactly once, so stateful
 * getters cannot show different values post-validation). Throws FacadeError
 * INVALID_PARAMS on unknown fields, missing required fields or wrong types.
 */
export function validateObject<T>(
  value: unknown,
  schema: ObjectSchema,
  label: string,
): T {
  if (!isPlainObject(value)) {
    throw invalidParams(`${label} must be an object`, {
      received: value === null ? "null" : typeof value,
    });
  }
  const allowed = new Set(Object.keys(schema));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      // The allowed list goes IN the message: agents typically read the
      // message string first and details only second.
      throw invalidParams(
        `${label}: unknown field "${key}" (allowed fields: ${[...allowed].join(", ")})`,
        {
          field: key,
          allowedFields: [...allowed],
        },
      );
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(schema)) {
    const fieldValue = value[key];
    if (fieldValue === undefined) {
      if (rule.required) {
        throw invalidParams(`${label}: missing required field "${key}"`, {
          field: key,
        });
      }
      continue;
    }
    if (!rule.check(fieldValue)) {
      throw invalidParams(
        `${label}: field "${key}" must be ${rule.describe}`,
        { field: key, received: fieldValue },
      );
    }
    out[key] = fieldValue;
  }
  return out as unknown as T;
}
