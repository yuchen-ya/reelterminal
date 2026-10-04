/**
 * Build-time pre-bundle of the runtime-chromium browser entry — the Playwright
 * harness page bundle (VideoEngine / TitleEngine / ExportEngine /
 * WebCodecsBackend / mediabunny, i.e. the SAME engine code the product runs).
 *
 * WHY THIS EXISTS: packages/runtime-chromium/src/node/bundle.ts bundles
 * src/browser/entry.ts from TypeScript at RUNTIME. That design only works in a
 * dev checkout. In a packaged install the .ts sources are not readable by the
 * spawned esbuild.exe (an ordinary process cannot read inside app.asar), so
 * the runtime build always fails there. This script performs the identical
 * esbuild build ON THE BUILD MACHINE (where esbuild and the TS sources exist)
 * and writes the finished bundle to apps/desktop/dist/browser-entry.mjs, which
 * electron-builder packs into app.asar (files: dist/**). At runtime bundle.ts
 * serves this artifact directly when REELTERMINAL_BROWSER_ENTRY_BUNDLE points
 * at it (set by src/main/esbuild-binary-path.ts in packaged installs only).
 *
 * KEEP IN SYNC with packages/runtime-chromium/src/node/bundle.ts doBuild():
 * the esbuild options below mirror that runtime dev-path build (same entry,
 * same extract-audio shim swap, same format/target/define/minify) so the dev
 * and packaged harness pages run the same code. The duplication is deliberate:
 * importing the runtime-chromium TS module from this plain-JS build step would
 * require a TypeScript loader the build pipeline does not have.
 *
 * INVOKED FROM tsup.config.ts onSuccess (build:main). A non-zero exit here
 * FAILS the desktop build on purpose: a packaged app without the pre-bundle
 * loses preview / export / visual inspect / media render entirely.
 */
import { build } from "esbuild";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Locate a browser source in the single dev checkout (AGENTS.md rule). */
function locateBrowserSource(name) {
  // apps/desktop -> .. -> apps -> .. -> repo root.
  const candidate = join(
    desktopDir,
    "..",
    "..",
    "packages",
    "runtime-chromium",
    "src",
    "browser",
    name,
  );
  if (!existsSync(candidate)) {
    throw new Error(
      `browser entry source not found at ${candidate} — run this script from the reelterminal checkout (apps/desktop/scripts)`,
    );
  }
  return candidate;
}

const entry = locateBrowserSource("entry.ts");
const extractAudioShim = locateBrowserSource("extract-audio-shim.ts");

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  minify: true,
  sourcemap: false,
  logLevel: "warning",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  plugins: [
    {
      name: "reelterminal-harness-shims",
      setup(pluginBuild) {
        // Same swap as the runtime dev path (bundle.ts): core/audio/
        // audio-engine dynamically imports "../media/extract-audio", whose
        // ffmpeg.wasm fallback cannot load inside the harness page (and must
        // never ship as a binary). Swap in the mediabunny-based
        // contract-compatible shim. The $ anchor keeps the shim file itself
        // (extract-audio-shim.ts) out of the rewrite.
        pluginBuild.onResolve({ filter: /(^|\/)extract-audio$/ }, () => ({
          path: extractAudioShim,
        }));
      },
    },
  ],
});

const file = result.outputFiles?.[0];
if (!file) {
  throw new Error("esbuild produced no output for the browser entry");
}

const outfile = join(desktopDir, "dist", "browser-entry.mjs");
mkdirSync(dirname(outfile), { recursive: true });
writeFileSync(outfile, file.text);
console.log(
  `browser-entry prebundled -> ${outfile} (${file.text.length} bytes)`,
);
