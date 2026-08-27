// ESM loader hooks for the audit probes. Registered via module.register() with
// data = { repoRoot: string, stubs: Record<pkgRoot, stubSource> }.
//
// Resolution policy:
//  - @openreel/<pkg>[/sub]  -> <repoRoot>/packages/<pkg>/src/<sub|index>[.ts|/index.ts]
//  - relative specifiers    -> resolved against the importing file, trying
//                              .ts/.tsx/.d.ts and /index.ts fallbacks
//  - asset-like extensions  -> inert stub module (export default "")
//  - third-party bare specs -> generated stub module from data.stubs
// Everything else falls through to Node's default resolution.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ASSET_EXT = new Set([
  ".wasm", ".css", ".scss", ".png", ".jpg", ".jpeg", ".svg", ".glsl",
  ".wgsl", ".mp3", ".mp4", ".wav", ".woff", ".woff2", ".ttf",
]);

let repoRoot;
let stubs;

export async function initialize(data) {
  repoRoot = data.repoRoot;
  stubs = data.stubs ?? {};
}

function tryVariants(base) {
  const candidates = [];
  const ext = path.extname(base);
  if (ext === ".js" || ext === ".mjs") candidates.push(base.replace(/\.m?js$/, ".ts"));
  candidates.push(base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`,
    path.join(base, "index.ts"), path.join(base, "index.tsx"));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch { /* ignore */ }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier in stubs) {
    return { url: `openreel-stub:${specifier}`, shortCircuit: true };
  }
  const ws = specifier.match(/^@openreel\/([a-z-]+)(?:\/(.*))?$/);
  if (ws) {
    const [, pkg, sub] = ws;
    const base = path.join(repoRoot, "packages", pkg, "src", sub || "index");
    const found = tryVariants(base);
    if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
    throw new Error(`[audit-probe] cannot resolve workspace specifier ${specifier}`);
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const parentPath = context.parentURL?.startsWith("file:")
      ? fileURLToPath(context.parentURL)
      : repoRoot;
    const base = path.resolve(path.dirname(parentPath), specifier);
    if (ASSET_EXT.has(path.extname(base))) {
      return { url: `openreel-stub-asset:${specifier}`, shortCircuit: true };
    }
    const found = tryVariants(base);
    if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
    // .json imports fall through to default resolution (import attributes).
    return nextResolve(specifier, context);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("openreel-stub:")) {
    const pkg = url.slice("openreel-stub:".length);
    return { format: "module", shortCircuit: true, source: stubs[pkg] ?? "export default {};\n" };
  }
  if (url.startsWith("openreel-stub-asset:")) {
    return { format: "module", shortCircuit: true, source: "export default '';\n" };
  }
  return nextLoad(url, context);
}
