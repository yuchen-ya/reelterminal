// Import-closure scanner for the OpenReel audit probes.
// Walks static + dynamic imports from one or more entry files, following only
// repo-internal specifiers (@openreel/* workspace sources and relative paths).
// Third-party bare imports are collected (with the imported names) so the
// loader can stub them. Asset-like imports are recorded but not followed.
//
// Pure Node, no dependencies. Paths are computed relative to this file so the
// probe is reproducible on any checkout of the audit branch.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

const ASSET_EXT = new Set([
  ".wasm", ".css", ".scss", ".png", ".jpg", ".jpeg", ".svg", ".glsl",
  ".wgsl", ".mp3", ".mp4", ".wav", ".woff", ".woff2", ".ttf", ".json",
]);

const WORKSPACE_PKG = /^@openreel\/([a-z-]+)(?:\/(.*))?$/;

/** Strip // and block comments while respecting string/template literals. */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let state = "code"; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : "";
    if (state === "code") {
      if (c === "/" && c2 === "/") { state = "line"; i += 2; continue; }
      if (c === "/" && c2 === "*") { state = "block"; i += 2; continue; }
      if (c === "'") { state = "sq"; out += c; i++; continue; }
      if (c === '"') { state = "dq"; out += c; i++; continue; }
      if (c === "`") { state = "tpl"; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; }
      i++; continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") { state = "code"; i += 2; continue; }
      if (c === "\n") out += "\n"; // keep line numbers stable
      i++; continue;
    }
    // string/template states: copy verbatim, honoring escapes
    out += c;
    if (c === "\\" && i + 1 < n) { out += src[i + 1]; i += 2; continue; }
    if (state === "sq" && c === "'") state = "code";
    else if (state === "dq" && c === '"') state = "code";
    else if (state === "tpl" && c === "`") state = "code";
    i++;
  }
  return out;
}

/** Parse the binding clause of an import statement (text before `from`). */
export function parseImportClause(clause) {
  const result = { default: false, namespace: false, named: [] };
  let s = clause.trim();
  if (!s) return result;
  if (s.startsWith("type ")) s = s.slice(5); // `import type` already filtered, defensive
  const braceIdx = s.indexOf("{");
  const starIdx = s.indexOf("*");
  if (braceIdx === -1 && starIdx === -1) {
    if (s) result.default = true;
    return result;
  }
  const head = braceIdx !== -1 ? s.slice(0, braceIdx) : s.slice(0, starIdx);
  if (head.replace(/,/g, "").trim()) result.default = true;
  if (starIdx !== -1 && (braceIdx === -1 || starIdx < braceIdx)) result.namespace = true;
  if (braceIdx !== -1) {
    const end = s.indexOf("}", braceIdx);
    const inner = s.slice(braceIdx + 1, end === -1 ? undefined : end);
    for (const part of inner.split(",")) {
      let name = part.trim();
      if (!name) continue;
      if (name.startsWith("type ")) name = name.slice(5).trim();
      const asIdx = name.indexOf(" as ");
      const exported = (asIdx === -1 ? name : name.slice(0, asIdx)).trim();
      if (exported) result.named.push(exported);
    }
  }
  return result;
}

/** Extract every import/export-from specifier from comment-stripped source. */
export function extractSpecifiers(src) {
  const out = [];
  const seen = new Set();
  const push = (kind, spec, clause) => {
    const key = `${kind}:${spec}:${clause ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, spec, clause });
  };
  // import ... from "x" | import "x"
  const importRe = /\bimport\s+(?!type[\s{*])([^'";]*?\s+from\s+)?(["'])([^'"]+)\2/g;
  let m;
  while ((m = importRe.exec(src)) !== null) {
    push("import", m[3], m[1] ? m[1].replace(/\s+from\s*$/, "") : null);
  }
  // export ... from "x"
  const exportRe = /\bexport\s+(?!type[\s{*])((?:\*|\{[^}]*\}|\*\s+as\s+\w+)\s+from\s+)(["'])([^'"]+)\2/g;
  while ((m = exportRe.exec(src)) !== null) {
    push("reexport", m[3], m[1].replace(/\s+from\s*$/, ""));
  }
  // dynamic import("x")
  const dynRe = /\bimport\s*\(\s*(["'])([^'"]+)\1\s*\)/g;
  while ((m = dynRe.exec(src)) !== null) {
    push("dynamic", m[2], null);
  }
  return out;
}

/** Resolve an @openreel/* or relative specifier to an absolute file path. */
export function resolveSpecifier(spec, fromFile) {
  let base;
  const ws = spec.match(WORKSPACE_PKG);
  if (ws) {
    const [, pkg, sub] = ws;
    base = path.join(REPO_ROOT, "packages", pkg, "src", sub || "index");
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else {
    return null; // bare third-party
  }
  const candidates = [];
  const ext = path.extname(base);
  if (ext === ".js" || ext === ".mjs") {
    candidates.push(base.replace(/\.m?js$/, ".ts"));
  }
  candidates.push(base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`,
    path.join(base, "index.ts"), path.join(base, "index.tsx"));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch { /* ignore */ }
  }
  if (ASSET_EXT.has(ext)) return { asset: base };
  return undefined; // unresolved
}

export function packageRootOf(spec) {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return `${parts[0]}/${parts[1]}`;
  }
  return spec.split("/")[0];
}

/**
 * Walk the import closure from `entries` (absolute paths).
 * Returns { files: string[], thirdParty: Map<pkgRoot, {named:Set, default:bool}>,
 *           assets: string[], unresolved: string[] }.
 */
export function scanClosure(entries) {
  const files = new Set();
  const thirdParty = new Map();
  const assets = new Set();
  const unresolved = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    let src;
    try { src = fs.readFileSync(file, "utf8"); } catch { unresolved.add(file); continue; }
    files.add(file);
    const stripped = stripComments(src);
    for (const imp of extractSpecifiers(stripped)) {
      const resolved = resolveSpecifier(imp.spec, file);
      if (resolved === null) {
        const root = packageRootOf(imp.spec);
        if (root.startsWith("node:")) continue;
        let rec = thirdParty.get(root);
        if (!rec) { rec = { named: new Set(), default: false }; thirdParty.set(root, rec); }
        if (imp.clause) {
          const clause = parseImportClause(imp.clause);
          if (clause.default) rec.default = true;
          for (const nm of clause.named) rec.named.add(nm);
        }
        continue;
      }
      if (resolved.asset) { assets.add(resolved.asset); continue; }
      if (resolved === undefined) { unresolved.add(`${imp.spec} (from ${path.relative(REPO_ROOT, file)})`); continue; }
      if (!files.has(resolved)) queue.push(resolved);
    }
  }
  return {
    files: [...files].sort(),
    thirdParty,
    assets: [...assets].sort(),
    unresolved: [...unresolved].sort(),
  };
}

/** Generate a self-sufficient ESM stub module for a third-party package. */
export function stubSourceFor(pkg, rec) {
  const names = [...rec.named].filter((n) => /^[A-Za-z_$][\w$]*$/.test(n)).sort();
  const lines = [
    `// Auto-generated stub for "${pkg}" (audit probe only, never executed for real work).`,
    "const __stub = new Proxy(function () {}, {",
    "  get(_t, k) {",
    "    if (k === Symbol.toPrimitive) return () => 0;",
    "    if (k === 'then') return undefined;",
    "    return __stub;",
    "  },",
    "  apply() { return __stub; },",
    "  construct() { return __stub; },",
    "});",
    ...names.map((n) => `export const ${n} = __stub;`),
  ];
  if (rec.default || true) lines.push("export default __stub;");
  return lines.join("\n") + "\n";
}

export function toFileUrl(p) {
  return pathToFileURL(p).href;
}
