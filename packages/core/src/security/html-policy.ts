/**
 * Shared, DOM-free HTML/CSS content policy for the constrained HTML → PNG
 * render path (media.render_html).
 *
 * Single source of truth for every path that turns raw HTML into pixels: the
 * runtime-chromium html renderer (which backs the facade verb and the desktop
 * MAIN wiring) validates BOTH inline HTML and file-based HTML through this
 * module before a browser ever sees the markup. The checks are pure string
 * level, so the module runs in Node processes where no DOM exists.
 *
 * Threat model: this is the STRING gate of a two-layer defense for authored
 * content in a local creation tool, not a sandbox. The runtime layer's ROOT
 * gate is the render context's javaScriptEnabled:false switch — markup that
 * evades this scan still cannot execute — and underneath it the renderer's
 * route allowlist ensures only file:// realpaths inside the assets root and
 * non-executable data: URIs are ever fetched; everything else is aborted and
 * reported as a missing asset. Like svg-validation, this module does not
 * claim to stop fully adversarial input; it makes rejection explicit and
 * auditable at ingest.
 *
 * Reference policy per rule:
 * - <script>, <iframe>/<object>/<embed>, <base href>, <meta http-equiv=
 *   refresh> and the srcset attribute are always rejected: the static raster
 *   never needs them, and each provides a navigation/fetch vector the
 *   string gate prefers to refuse outright.
 * - Event handler attributes (on*) are rejected: JavaScript is disabled in
 *   the render context, so they are dead weight at best.
 * - javascript:/vbscript: and non-image data: URIs are rejected with an
 *   explicit error. data:image/* URIs render inline and stay allowed.
 * - http(s), file and protocol-relative references (in URL-bearing
 *   attributes, CSS url(...) tokens and CSS @import) are rejected: the
 *   render is a LOCAL raster with no network surface. Relative paths,
 *   #fragments and data:image URIs stay allowed — relative references
 *   resolve inside the caller-provided assets root at render time and
 *   degrade to a reported missing asset when absent.
 * - Inline <style> blocks stay allowed (common in real-world HTML); their
 *   external references are caught by the same CSS url()/(@import) scan as
 *   everywhere else. @font-face is not special-cased: its src url(...) is
 *   an external reference exactly like an <img src> would be.
 *
 * Error-code style mirrors SvgValidationErrorCode/svg-validation.ts; the
 * numeric-entity decoding and control-character stripping below mirror that
 * module's evasion defenses (kept as local copies so the SVG module's
 * surface stays untouched).
 */

/** Hard byte ceiling for one HTML document (512 KiB). HTML+CSS documents
 * are typically small; the tighter ceiling (vs SVG's 2 MiB) keeps inline
 * payloads with embedded base64 images honest about being assets. */
export const HTML_MAX_CONTENT_BYTES = 512 * 1024;

export type HtmlValidationErrorCode =
  | "empty"
  | "tooLarge"
  | "script"
  | "embeddedContent"
  | "baseHref"
  | "metaRefresh"
  | "srcset"
  | "eventHandler"
  | "unsafeProtocol"
  | "externalResource";

export interface HtmlValidationOptions {
  /** Byte ceiling override (tests, embedders with tighter budgets). */
  readonly maxBytes?: number;
}

export type HtmlValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: HtmlValidationErrorCode;
      /** Developer-facing English detail; UI layers map `code` to copy. */
      readonly message: string;
    };

/** Error thrown by call sites that surface failures through exceptions. */
export class HtmlValidationError extends Error {
  readonly code: HtmlValidationErrorCode;

  constructor(code: HtmlValidationErrorCode, message: string) {
    super(message);
    this.name = "HtmlValidationError";
    this.code = code;
  }
}

// Element checks. Namespace-prefixed forms (e.g. <svg:script>) are the same
// element to an HTML-in-XML parser and get identical treatment; the lookahead
// stops at the first character that cannot be part of a name, so lookalikes
// like <script-button> or <embossed> are not flagged.
const SCRIPT_ELEMENT_RE = /<(?:[a-zA-Z][\w.-]*:)?script(?![\w.:-])/i;
const EMBEDDED_CONTENT_ELEMENT_RE =
  /<(?:[a-zA-Z][\w.-]*:)?(?:iframe|object|embed)(?![\w.:-])/i;
// <base href> rewrites every relative reference on the page and could point
// the whole document outside the assets root; the render path never needs it.
const BASE_HREF_RE = /<base\b[^>]*?\bhref\s*=/i;
const META_REFRESH_RE = /<meta\b[^>]*?\bhttp-equiv\s*=\s*(?:"[^"]*refresh[^"]*"|'[^']*refresh[^']*'|refresh)/i;
const SRCSET_ATTR_RE = /\bsrcset\s*=/i;

// Event handler attributes: whitespace-preceded on* names, matched
// case-insensitively (HTML attribute names are case-insensitive, so
// ONLOAD === onload — unlike the XML-flavored SVG gate). The whitespace
// anchor keeps innocuous names like `data-online` out of the match.
const EVENT_HANDLER_ATTR_RE = /\s(on[a-zA-Z]+)\s*=/i;

// URL-bearing attributes (quoted AND unquoted HTML forms). `href`/`src` are
// the workhorses; poster/cite/background/longdesc carry URLs on img/q/body;
// action/formaction/ping are the navigation attributes left once <form>
// submission targets; xlink:href covers inline SVG. data: on <object> is
// moot (the element itself is rejected).
const URL_ATTR_RE =
  /\b(?:xlink:href|href|src|poster|background|cite|longdesc|formaction|action|ping)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

// CSS url(...) token: quoted or bare, terminated by the closing paren.
const CSS_URL_RE = /url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;

// CSS @import with a target URL (both url(...) and bare string forms).
const CSS_IMPORT_RE = /@import\s+(?:url\s*\(\s*)?["']?\s*([^"'()\s;}]+)/gi;

function truncateForMessage(value: string, max = 64): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function fail(
  code: HtmlValidationErrorCode,
  message: string,
): HtmlValidationResult {
  return { ok: false, code, message };
}

/**
 * Decodes numeric XML/HTML character references so entity-encoded schemes
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

export type HtmlReferenceFinding =
  | { readonly kind: "unsafeProtocol"; readonly value: string }
  | { readonly kind: "externalResource"; readonly value: string }
  | { readonly kind: "allowed"; readonly value: string };

/**
 * Classifies one URL value. Whitespace and control characters are stripped
 * before the scheme test because URL parsers ignore them
 * (`java\tscript:` style evasion); numeric entities are decoded first.
 */
export function classifyHtmlReferenceUrl(
  rawValue: string,
): HtmlReferenceFinding {
  const decoded = decodeNumericEntityRefs(rawValue);
  const value = decoded.replace(/[\s\x00-\x1f\x7f]+/g, "");
  if (!value) return { kind: "allowed", value: "" };

  if (
    /^(?:javascript|vbscript)\s*:/i.test(decoded) ||
    /^(?:javascript|vbscript):/i.test(value)
  ) {
    return { kind: "unsafeProtocol", value };
  }
  if (/^data:/i.test(value)) {
    // data:image/* renders inline; every other data MIME (html, svg+xml with
    // its script surface, fonts, ...) stays out of the render path.
    return /^data:image\/(?!svg)/i.test(value)
      ? { kind: "allowed", value }
      : { kind: "unsafeProtocol", value };
  }
  if (/^(?:https?:)?\/\//i.test(value) || /^file:/i.test(value)) {
    return { kind: "externalResource", value };
  }
  // Relative paths and fragments (#id) are allowed.
  return { kind: "allowed", value };
}

interface ReferenceFinding {
  code: "unsafeProtocol" | "externalResource";
  value: string;
}

/** Keeps the most severe finding (unsafeProtocol outranks externalResource). */
function mergeReferenceFinding(
  current: ReferenceFinding | null,
  next: HtmlReferenceFinding,
): ReferenceFinding | null {
  if (next.kind === "allowed") return current;
  if (!current) return { code: next.kind, value: next.value };
  if (current.code === "externalResource" && next.kind === "unsafeProtocol") {
    return { code: next.kind, value: next.value };
  }
  return current;
}

/**
 * Validates raw HTML/CSS markup. Pure string checks, safe to call from
 * browsers and Node alike. See the module doc block for the per-rule policy.
 */
export function validateHtmlContent(
  content: string,
  options?: HtmlValidationOptions,
): HtmlValidationResult {
  const maxBytes = options?.maxBytes ?? HTML_MAX_CONTENT_BYTES;

  if (!content || content.trim().length === 0) {
    return fail("empty", "HTML content is empty");
  }

  const byteLength = new TextEncoder().encode(content).length;
  if (byteLength > maxBytes) {
    return fail(
      "tooLarge",
      `HTML content exceeds the maximum of ${maxBytes} bytes (got ${byteLength} bytes)`,
    );
  }

  if (SCRIPT_ELEMENT_RE.test(content)) {
    return fail(
      "script",
      "HTML contains a <script> element, which is not allowed",
    );
  }

  if (EMBEDDED_CONTENT_ELEMENT_RE.test(content)) {
    return fail(
      "embeddedContent",
      "HTML contains an <iframe>, <object> or <embed> element, which is not allowed",
    );
  }

  if (BASE_HREF_RE.test(content)) {
    return fail(
      "baseHref",
      "HTML contains a <base href> element, which is not allowed (relative references resolve inside the assets root)",
    );
  }

  if (META_REFRESH_RE.test(content)) {
    return fail(
      "metaRefresh",
      "HTML contains a <meta http-equiv=refresh> directive, which is not allowed",
    );
  }

  if (SRCSET_ATTR_RE.test(content)) {
    return fail(
      "srcset",
      "HTML contains a srcset attribute, which is not allowed (use a single src per image)",
    );
  }

  const eventHandler = EVENT_HANDLER_ATTR_RE.exec(content);
  if (eventHandler) {
    return fail(
      "eventHandler",
      `HTML contains an event handler attribute "${truncateForMessage(
        eventHandler[1],
      )}", which is not allowed`,
    );
  }

  let external: ReferenceFinding | null = null;

  for (const match of content.matchAll(URL_ATTR_RE)) {
    external = mergeReferenceFinding(
      external,
      classifyHtmlReferenceUrl(match[1] ?? match[2] ?? match[3] ?? ""),
    );
  }

  for (const cssUrl of content.matchAll(CSS_URL_RE)) {
    external = mergeReferenceFinding(
      external,
      classifyHtmlReferenceUrl(cssUrl[1] ?? cssUrl[2] ?? cssUrl[3] ?? ""),
    );
  }

  for (const cssImport of content.matchAll(CSS_IMPORT_RE)) {
    external = mergeReferenceFinding(
      external,
      classifyHtmlReferenceUrl(cssImport[1] ?? ""),
    );
  }

  if (external) {
    const found: ReferenceFinding = external;
    if (found.code === "unsafeProtocol") {
      return fail(
        "unsafeProtocol",
        `HTML references an unsafe protocol in "${truncateForMessage(
          found.value,
        )}" (javascript:, vbscript: and non-image data: URIs are not allowed)`,
      );
    }
    return fail(
      "externalResource",
      `HTML references an external resource "${truncateForMessage(
        found.value,
      )}" (http(s), file and protocol-relative URLs are not allowed; embed images as data:image URIs or use relative paths inside the assets root)`,
    );
  }

  return { ok: true };
}

/**
 * Validates and throws a coded {@link HtmlValidationError} on rejection, for
 * call sites that surface failures through exceptions (the HTML renderer).
 */
export function assertValidHtmlContent(
  content: string,
  options?: HtmlValidationOptions,
): void {
  const result = validateHtmlContent(content, options);
  if (!result.ok) {
    throw new HtmlValidationError(result.code, result.message);
  }
}
