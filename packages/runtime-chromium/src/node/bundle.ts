/**
 * Bundles the browser entry (src/browser/entry.ts) into a single ESM script
 * with esbuild. The bundle inlines the existing core render/export engines
 * (VideoEngine, TitleEngine, ExportEngine, WebCodecsBackend, mediabunny) so
 * the Playwright page runs the SAME code paths as the product — no
 * re-implemented compositor.
 *
 * Cached per process: esbuild builds this graph in ~1–3 s, and a test file
 * bundles at most once.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

let cached: Promise<string> | null = null;

export function buildBrowserEntry(): Promise<string> {
  cached ??= doBuild();
  return cached;
}

/**
 * Locate src/browser/entry.ts across consumption modes: the source tree
 * (tests), one level below src (bundled output dirs), or the installed
 * package (external consumers via node_modules resolution).
 */
function resolveBrowserSource(name: "entry.ts" | "extract-audio-shim.ts"): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, "..", "browser", name),
    join(moduleDir, "..", "src", "browser", name),
  ];
  try {
    const require_ = createRequire(import.meta.url);
    const pkgJson = require_.resolve("@openreel/runtime-chromium/package.json");
    candidates.push(join(dirname(pkgJson), "src", "browser", name));
  } catch {
    // package self-resolution unavailable (source tree is enough)
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `cannot locate the browser entry source ${name} (tried: ${candidates.join(", ")})`,
  );
}

async function doBuild(): Promise<string> {
  const entry = resolveBrowserSource("entry.ts");
  const extractAudioShim = resolveBrowserSource("extract-audio-shim.ts");
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
        name: "openreel-harness-shims",
        setup(pluginBuild) {
          // core/audio/audio-engine dynamically imports "../media/extract-audio",
          // whose ffmpeg.wasm fallback cannot load inside the harness page
          // (and must never ship as a binary). Swap in the mediabunny-based
          // contract-compatible shim. The $ anchor keeps the shim file
          // itself (extract-audio-shim.ts) out of the rewrite.
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
  return file.text;
}
