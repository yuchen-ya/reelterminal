/**
 * Shared, DOM-free SVG content validation.
 *
 * Single source of truth for every path that turns raw SVG text into project
 * content: the engine ingest (GraphicsEngine.parseSVG, which backs both the
 * GUI import and the graphics bridge), the core `svg/create` / `svg/update`
 * action handlers, and future facade ops or preset payloads. The checks are
 * pure string level so the same module also runs in Node processes where no
 * DOMParser exists.
 *
 * Threat model: this is a boundary gate for authored content in a local
 * creation tool, not a sandbox. Defense in depth comes from the render path:
 * SVG clips are rasterized through a blob URL loaded into an <img>, where
 * scripts never execute and external resources are never fetched (SVG secure
 * static mode). Validation makes rejection explicit at ingest instead of
 * relying on that implicit safety net, so this module does not claim to stop
 * fully adversarial input.
 *
 * Reference policy per rule:
 * - <script>, <foreignObject>, event handler attributes and unsafe URL
 *   schemes (javascript:, vbscript:, non-image data: URIs) are always
 *   rejected: the render layer never needs them.
 * - http(s), file and protocol-relative references are rejected with an
 *   explicit error. Relative and data:image references are allowed: the
 *   renderer consumes the markup as a blob URL inside an <img>, where
 *   relative URLs cannot resolve and data:image URIs render inline, so a
 *   relative reference degrades to blank pixels rather than a fetch.
 * - Internal <style> blocks stay allowed (common in real-world SVG files and
 *   they render fine in the img context); CSS @import of an external URL is
 *   rejected. The svg namespace declaration (http://www.w3.org/2000/svg) is
 *   an identifier, never fetched, and is not treated as an external
 *   reference.
 */

/** Hard byte ceiling for a single SVG document (2 MiB). */
export const SVG_MAX_CONTENT_BYTES = 2 * 1024 * 1024;

/** Hard ceiling on the number of markup elements in a single SVG document. */
export const SVG_MAX_ELEMENT_COUNT = 10_000;

export type SvgValidationErrorCode =
  | "empty"
  | "tooLarge"
  | "tooComplex"
  | "noSvgRoot"
  | "script"
  | "foreignObject"
  | "eventHandler"
  | "unsafeProtocol"
  | "externalResource";

export interface SvgValidationOptions {
  /** Byte ceiling override (tests, embedders with tighter budgets). */
  readonly maxBytes?: number;
  /** Element count ceiling override. */
  readonly maxElements?: number;
}

export type SvgValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: SvgValidationErrorCode;
      /** Developer-facing English detail; UI layers map `code` to copy. */
      readonly message: string;
    };

/** Error thrown by the engine ingest path when validation rejects a document. */
export class SvgValidationError extends Error {
  readonly code: SvgValidationErrorCode;

  constructor(code: SvgValidationErrorCode, message: string) {
    super(message);
    this.name = "SvgValidationError";
    this.code = code;
  }
}

// Attribute values that carry URLs in SVG markup (covers <image>, <use>,
// <link>, and any other element using href/xlink:href/src).
const URL_ATTR_RE = /\b(?:xlink:href|href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

// Event handler attributes: whitespace-preceded on* names. The whitespace
// anchor keeps innocuous names like `data-online` out of the match.
const EVENT_HANDLER_ATTR_RE = /\s(on[a-zA-Z]+)\s*=/;

// Namespace-prefixed element forms (e.g. <svg:script>, <any:script>) are the
// same element to an XML parser and get identical treatment. The lookahead
// stops at the first character that cannot be part of an XML name, so
// lookalikes like <script-button> are not flagged. Event handler attributes
// are intentionally only matched unprefixed: namespaced on* attributes
// (e.g. svg:onload) are never executed by browsers.
const SCRIPT_ELEMENT_RE = /<(?:[a-zA-Z][\w.-]*:)?script(?![\w.:-])/i;
const FOREIGN_OBJECT_RE = /<(?:[a-zA-Z][\w.-]*:)?foreignobject(?![\w.:-])/i;
// Same prefix tolerance as the element checks above, so documents like
// <svg:svg xmlns:svg="http://www.w3.org/2000/svg"> (which the DOM-level
// querySelector("svg") accepts) are not falsely rejected by the root check.
const SVG_ROOT_RE = /<(?:[a-zA-Z][\w.-]*:)?svg(?![\w.:-])/;
const ELEMENT_COUNT_RE = /<[a-zA-Z]/g;

// XML processing instruction that pulls an external stylesheet.
const XML_STYLESHEET_PI_RE = /<\?xml-stylesheet[^>]*?>/gi;
const XML_STYLESHEET_HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

// CSS @import with a target URL (both url(...) and bare string forms).
const CSS_IMPORT_RE = /@import\s+(?:url\s*\(\s*)?["']?\s*([^"'()\s;}]+)/gi;

function truncateForMessage(value: string, max = 64): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function fail(
  code: SvgValidationErrorCode,
  message: string,
): SvgValidationResult {
  return { ok: false, code, message };
}

/**
 * Decodes numeric XML character references so entity-encoded schemes
 * (`&#106;avascript:`) cannot slip past the protocol checks.
 */
function decodeNumericEntityRefs(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (raw, hex: string) =>
      codePointToString(parseInt(hex, 16), raw),
    )
    .replace(/&#(\d+);/g, (raw, dec: string) =>
      codePointToString(parseInt(dec, 10), raw),
    );
}

function codePointToString(codePoint: number, raw: string): string {
  return codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : raw;
}

interface ReferenceFinding {
  code: SvgValidationErrorCode;
  value: string;
}

/** Keeps the most severe finding (unsafeProtocol outranks externalResource). */
function mergeReferenceFinding(
  current: ReferenceFinding | null,
  next: ReferenceFinding | null,
): ReferenceFinding | null {
  if (!next) return current;
  if (!current) return next;
  if (current.code === "externalResource" && next.code === "unsafeProtocol") {
    return next;
  }
  return current;
}

/**
 * Classifies one URL value. Returns null when the reference is allowed.
 *
 * Whitespace and control characters are stripped before the scheme test
 * because URL parsers ignore them (`java\tscript:` style evasion).
 */
function classifyReferenceUrl(rawValue: string): ReferenceFinding | null {
  const decoded = decodeNumericEntityRefs(rawValue);
  const value = decoded.replace(/[\s\x00-\x1f\x7f]+/g, "");
  if (!value) return null;

  if (
    /^(?:javascript|vbscript)\s*:/i.test(decoded) ||
    /^(?:javascript|vbscript):/i.test(value)
  ) {
    return { code: "unsafeProtocol", value };
  }
  if (/^data:/i.test(value)) {
    return /^data:image\//i.test(value)
      ? null
      : { code: "unsafeProtocol", value };
  }
  if (/^(?:https?:)?\/\//i.test(value) || /^file:/i.test(value)) {
    return { code: "externalResource", value };
  }
  // Relative paths, fragments (#id) and data:image URIs are allowed.
  return null;
}

/**
 * Validates raw SVG markup. Pure string checks, safe to call from browsers
 * and Node alike. See the module doc block for the per-rule policy.
 */
export function validateSvgContent(
  content: string,
  options?: SvgValidationOptions,
): SvgValidationResult {
  const maxBytes = options?.maxBytes ?? SVG_MAX_CONTENT_BYTES;
  const maxElements = options?.maxElements ?? SVG_MAX_ELEMENT_COUNT;

  if (!content || content.trim().length === 0) {
    return fail("empty", "SVG content is empty");
  }

  const byteLength = new TextEncoder().encode(content).length;
  if (byteLength > maxBytes) {
    return fail(
      "tooLarge",
      `SVG content exceeds the maximum of ${maxBytes} bytes (got ${byteLength} bytes)`,
    );
  }

  const elementCount = content.match(ELEMENT_COUNT_RE)?.length ?? 0;
  if (elementCount > maxElements) {
    return fail(
      "tooComplex",
      `SVG exceeds the maximum of ${maxElements} elements (got ${elementCount})`,
    );
  }

  if (!SVG_ROOT_RE.test(content)) {
    return fail("noSvgRoot", "Invalid SVG content: no svg element found");
  }

  if (SCRIPT_ELEMENT_RE.test(content)) {
    return fail(
      "script",
      "SVG contains a <script> element, which is not allowed",
    );
  }

  if (FOREIGN_OBJECT_RE.test(content)) {
    return fail(
      "foreignObject",
      "SVG contains a <foreignObject> element, which is not allowed",
    );
  }

  const eventHandler = EVENT_HANDLER_ATTR_RE.exec(content);
  if (eventHandler) {
    return fail(
      "eventHandler",
      `SVG contains an event handler attribute "${truncateForMessage(
        eventHandler[1],
      )}", which is not allowed`,
    );
  }

  let external: ReferenceFinding | null = null;

  for (const match of content.matchAll(URL_ATTR_RE)) {
    external = mergeReferenceFinding(
      external,
      classifyReferenceUrl(match[1] ?? match[2] ?? ""),
    );
  }

  for (const pi of content.matchAll(XML_STYLESHEET_PI_RE)) {
    const href = XML_STYLESHEET_HREF_RE.exec(pi[0]);
    if (href) {
      external = mergeReferenceFinding(
        external,
        classifyReferenceUrl(href[1] ?? href[2] ?? ""),
      );
    }
  }

  for (const cssImport of content.matchAll(CSS_IMPORT_RE)) {
    external = mergeReferenceFinding(
      external,
      classifyReferenceUrl(cssImport[1] ?? ""),
    );
  }

  if (external) {
    const found: ReferenceFinding = external;
    if (found.code === "unsafeProtocol") {
      return fail(
        "unsafeProtocol",
        `SVG references an unsafe protocol in "${truncateForMessage(
          found.value,
        )}" (javascript:, vbscript: and non-image data: URIs are not allowed)`,
      );
    }
    return fail(
      "externalResource",
      `SVG references an external resource "${truncateForMessage(
        found.value,
      )}" (http(s), file and protocol-relative URLs are not allowed; embed images as data:image URIs or use relative paths)`,
    );
  }

  return { ok: true };
}

/**
 * Validates and throws a coded {@link SvgValidationError} on rejection, for
 * call sites that surface failures through exceptions (engine ingest).
 */
export function assertValidSvgContent(
  content: string,
  options?: SvgValidationOptions,
): void {
  const result = validateSvgContent(content, options);
  if (!result.ok) {
    throw new SvgValidationError(result.code, result.message);
  }
}
