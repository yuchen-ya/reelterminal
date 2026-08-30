/**
 * Absolute-path boundary (ADR 0003 Decision 6).
 *
 * Every path INPUT is absolute-only. At EXECUTION time (run workflows) each
 * path param is checked AFTER `$ref` substitution — a reference can legally
 * carry a relative string from an earlier result, and that is exactly the
 * injection this check pins. A relative value fails the step with clear
 * wording; nothing is ever resolved against the process cwd and `~` is
 * never expanded.
 *
 * Note the division of labor with the facade: the facade itself enforces
 * absoluteness only for project.open/project.save (Decision 10.1) — for
 * media.import and verify.artifact a relative value would otherwise fall
 * through to the facade's cwd-relative containment resolution
 * (path-roots.ts resolves against process.cwd()), so the transport
 * boundary here is the guard.
 */
import { isAbsolute } from "node:path";

/**
 * The explicit per-verb path-field map (dotted paths into the params
 * object). Every field listed here must be an absolute path string at
 * execution time.
 */
export const PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "media.import": ["path"],
  "verify.artifact": ["path", "compare.referencePath"],
  "project.open": ["path"],
  "project.save": ["path"],
};

export interface PathViolation {
  readonly field: string;
  readonly value: unknown;
}

function readAt(
  params: unknown,
  dotted: string,
): { present: boolean; value: unknown } {
  const segments = dotted.split(".");
  let cursor: unknown = params;
  for (const segment of segments) {
    if (typeof cursor !== "object" || cursor === null) {
      return { present: false, value: undefined };
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor === undefined
    ? { present: false, value: undefined }
    : { present: true, value: cursor };
}

/**
 * Check every declared path field of `verb` (present ones only) for
 * absoluteness on the RUNNING platform. Returns the violations; an empty
 * array means the params may proceed to the facade untouched.
 */
export function findRelativePathViolations(
  verb: string,
  params: unknown,
): readonly PathViolation[] {
  const fields = PATH_FIELDS[verb];
  if (fields === undefined || typeof params !== "object" || params === null) {
    return [];
  }
  const violations: PathViolation[] = [];
  for (const field of fields) {
    const { present, value } = readAt(params, field);
    if (!present) continue;
    if (
      typeof value !== "string" ||
      value === "~" ||
      value.startsWith("~/") ||
      !isAbsolute(value)
    ) {
      violations.push({ field, value });
    }
  }
  return violations;
}

/** Boundary wording for a rejected relative path (pinned by tests). */
export function relativePathMessage(
  verb: string,
  violation: PathViolation,
): string {
  const display =
    typeof violation.value === "string"
      ? `"${violation.value}"`
      : JSON.stringify(violation.value);
  return (
    `${verb}: params.${violation.field} must be an absolute path (got ${display}) — ` +
    `relative paths are rejected at the transport boundary and are never ` +
    `resolved against the process cwd; '~' is never expanded`
  );
}
