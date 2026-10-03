/**
 * Copy runtime browser sources beside the desktop main-process bundle.
 *
 * The main-process bundle inlines @reelterminal/runtime-chromium, whose
 * node/bundle.ts builds the Chromium browser entry at RUNTIME with esbuild
 * from the TypeScript sources src/browser/{entry,extract-audio-shim}.ts. In
 * the CJS bundle, import.meta.url resolves inside dist/, so the runtime
 * looks for <dist>/browser/<name> (the package's own first candidate). This
 * script copies those two sources there.
 *
 * esbuild then resolves the entry's "@reelterminal/core/*" imports through
 * apps/desktop/node_modules/@reelterminal/core (a workspace symlink into
 * packages/core, whose own node_modules carry three/gsap/mediabunny/etc.) —
 * the same store locations the workspace uses, no version drift.
 *
 * Idempotent: re-running replaces stale copies.
 */
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserSourceDir = path.join(
  packageDir,
  "..",
  "..",
  "packages",
  "runtime-chromium",
  "src",
  "browser",
);
const outDir = path.join(packageDir, "dist", "browser");

const SOURCES = ["entry.ts", "extract-audio-shim.ts"];

mkdirSync(outDir, { recursive: true });
for (const name of SOURCES) {
  copyFileSync(path.join(browserSourceDir, name), path.join(outDir, name));
  process.stderr.write(`[link-live-runtime-deps] dist/browser/${name}\n`);
}

// The agent-facade's OpenCV worker scripts (image.align / motion.track) are
// located relative to the module: in the CJS bundle that is inside dist/, so
// they must exist at <dist>/python/. Same idempotent-copy discipline as the
// browser sources.
const pythonSourceDir = path.join(packageDir, "..", "..", "packages", "agent-facade", "python");
const pythonOutDir = path.join(packageDir, "dist", "python");
mkdirSync(pythonOutDir, { recursive: true });
for (const name of readdirSync(pythonSourceDir)) {
  if (!name.endsWith(".py")) continue;
  copyFileSync(path.join(pythonSourceDir, name), path.join(pythonOutDir, name));
  process.stderr.write(`[link-live-runtime-deps] dist/python/${name}\n`);
}
