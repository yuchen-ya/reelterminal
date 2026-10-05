/**
 * Path containment for local-media import.
 *
 * Only plain local paths are accepted: every candidate path must resolve to
 * a real location inside at least one caller-configured media root. All checks
 * run against realpath results so symlink escapes fail containment, separators
 * are normalized, and Windows comparisons are case-insensitive.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { isForbiddenLocalPath } from "@reelterminal/core/security/local-path-policy";

/**
 * Matches a leading RFC 3986-ish scheme such as `http:`, `https:`, `file:`,
 * `data:`, `blob:`, `ftp:`. Group length matters: see {@link hasUrlScheme}.
 */
const URL_SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * True when the string looks like a URL scheme we do not accept — this
 * accepts plain local paths only (`http:`, `https:`, `file:`, `data:`,
 * `blob:`, `ftp:`, ...).
 *
 * A single-letter "scheme" is NOT treated as a URL scheme: on Windows,
 * `C:\media\a.mp4` and `C:/media/a.mp4` are drive-letter paths, not schemes.
 * No registered URL scheme has a single-character name.
 */
export function hasUrlScheme(p: string): boolean {
  const match = URL_SCHEME_RE.exec(p);
  if (!match) return false;
  // 2 == exactly one letter + ':' -> a Windows drive, not a URL scheme.
  // All registered schemes (http, file, data, ...) are at least 2 chars.
  return match[1].length >= 2;
}

/**
 * Builds a comparison form of an absolute Windows/POSIX path:
 * forward-slash separators (collapsed), no trailing slash (unless "/"), and
 * lowercased when running on Windows.
 */
function comparablePath(p: string): string {
  let out = p.replace(/[\\/]+/g, "/");
  if (out.length > 1 && out.endsWith("/")) {
    out = out.replace(/\/+$/, "");
  }
  return process.platform === "win32" ? out.toLowerCase() : out;
}

/**
 * Detailed verdict of a containment check, so callers can report WHY a path
 * was refused instead of conflating "not found" with "escapes the roots".
 */
export type ContainmentResult =
  | { readonly kind: "ok"; readonly path: string }
  | { readonly kind: "outside" }
  | { readonly kind: "unresolvable" };

/**
 * Resolves `candidate` (absolute, or relative to `process.cwd()`) and checks
 * it is inside at least one root. Both sides are passed through
 * `fs.realpathSync`, so symlink escapes fail containment and nonexistent
 * candidates fail outright (they cannot be verified as contained).
 *
 * A root that merely shares a string prefix with the candidate is rejected by
 * comparing on normalized separator boundaries ("C:\media-evil\x.mp4" does not
 * pass root "C:\media").
 */
export function resolveContainedPathDetailed(
  candidate: string,
  roots: readonly string[],
  resolveRealPath: (path: string) => string = realpathSync,
): ContainmentResult {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return { kind: "unresolvable" };
  }
  if (hasUrlScheme(candidate) || isForbiddenLocalPath(candidate)) return { kind: "outside" };

  // Realpath the candidate: collapses '..' segments *and* follows symlinks,
  // so both traversal and link escapes are eliminated before comparison.
  // Throws for nonexistent/unreadable targets -> unresolvable (fail closed).
  let resolvedReal: string;
  try {
    const absolute = path.isAbsolute(candidate)
      ? path.normalize(candidate)
      : path.resolve(process.cwd(), candidate);
    if (isForbiddenLocalPath(absolute)) return { kind: "outside" };
    const real = resolveRealPath(absolute);
    if (isForbiddenLocalPath(real)) return { kind: "outside" };
    resolvedReal = path.normalize(real);
  } catch {
    return { kind: "unresolvable" };
  }

  const comparableCandidate = comparablePath(resolvedReal);

  for (const root of roots) {
    if (typeof root !== "string" || root.length === 0 ||
        hasUrlScheme(root) || isForbiddenLocalPath(root)) continue;
    let resolvedRoot: string;
    try {
      // Roots are realpath-resolved too: containers behind symlinks/junctions
      // still compare correctly against realpathed candidates.
      const real = resolveRealPath(root);
      if (isForbiddenLocalPath(real)) continue;
      resolvedRoot = path.normalize(real);
    } catch {
      continue; // Root itself unresolvable -> never grants containment.
    }
    const comparableRoot = comparablePath(resolvedRoot);
    if (
      comparableCandidate === comparableRoot ||
      comparableCandidate.startsWith(`${comparableRoot}/`)
    ) {
      return { kind: "ok", path: resolvedReal };
    }
  }
  return { kind: "outside" };
}

/**
 * Back-compatible boolean wrapper: the resolved absolute path when
 * contained, otherwise null (any failure kind).
 */
export function resolveContainedPath(
  candidate: string,
  roots: readonly string[],
): string | null {
  const result = resolveContainedPathDetailed(candidate, roots);
  return result.kind === "ok" ? result.path : null;
}
