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

interface FieldRule {
  readonly check: FieldCheck;
  readonly describe: string;
  readonly required?: boolean;
}

export type ObjectSchema = Record<string, FieldRule>;

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
      throw invalidParams(`${label}: unknown field "${key}"`, {
        field: key,
        allowedFields: [...allowed],
      });
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
