/**
 * Bundles the browser entry (src/browser/entry.ts) into a single ESM script
 * with esbuild. The bundle inlines the existing core render/export engines
 * (VideoEngine, TitleEngine, ExportEngine, WebCodecsBackend, mediabunny) so
 * the Playwright page runs the SAME code paths as the product — no
 * re-implemented compositor.
 *
 * Two consumption paths:
 * - Packaged installs: the entry was PRE-BUNDLED at build time by
 *   apps/desktop/scripts/build-browser-entry.mjs into
 *   <resources>/app.asar/dist/browser-entry.mjs, and the desktop main process
 *   points OPENREEL_BROWSER_ENTRY_BUNDLE at it (esbuild-binary-path.ts). The
 *   finished artifact is served as-is. The runtime esbuild build below can
 *   never work there: the spawned esbuild.exe is an ordinary process and
 *   cannot read the TS sources inside app.asar.
 * - Dev checkout: the TS sources sit in the source tree (and dist/browser via
 *   link-live-runtime-deps.mjs), so esbuild builds them here — unchanged.
 *
 * Cached per process: esbuild builds this graph in ~1–3 s, and a test file
 * bundles at most once.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

let cached: Promise<string> | null = null;

export function buildBrowserEntry(): Promise<string> {
  cached ??= doBuild();
  return cached;
}

/** Injectable context for the resolution below (tests); all optional. */
export interface BrowserEntryContext {
  /** Env consulted for OPENREEL_BROWSER_ENTRY_BUNDLE; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Existence probe for the pre-bundle path; defaults to fs.existsSync. */
  fileExists?: (candidate: string) => boolean;
  /** Text reader for the pre-bundle; defaults to fs.readFileSync(p, "utf8"). */
  readText?: (path: string) => string;
  /** Existence probe for the TS source candidates; defaults to fs.existsSync. */
  sourceExists?: (candidate: string) => boolean;
}

export type ResolvedBrowserEntry =
  | { kind: "prebundled"; text: string }
  | { kind: "source"; entry: string; extractAudioShim: string };

/**
 * Read the build-time pre-bundle when the desktop process advertises one.
 * Electron reads text files inside app.asar natively, so the packaged
 * artifact needs no esbuild at all — the extract-audio shim plugin was
 * already applied when apps/desktop/scripts/build-browser-entry.mjs built it.
 * Returns undefined when the env var is unset (dev) or does not point at an
 * existing file, letting the caller fall through to the source build.
 */
export function loadPrebundledBrowserEntry(
  context: BrowserEntryContext = {},
): string | undefined {
  const env = context.env ?? process.env;
  const fileExists = context.fileExists ?? existsSync;
  const readText =
    context.readText ?? ((path: string) => readFileSync(path, "utf8"));
  const fromEnv = env.OPENREEL_BROWSER_ENTRY_BUNDLE;
  if (!fromEnv) return undefined;
  if (!fileExists(fromEnv)) return undefined;
  return readText(fromEnv);
}

/**
 * Locate src/browser/entry.ts across consumption modes: the source tree
 * (tests), one level below src (bundled output dirs), or the installed
 * package (external consumers via node_modules resolution).
 */
function resolveBrowserSource(
  name: "entry.ts" | "extract-audio-shim.ts",
  sourceExists: (candidate: string) => boolean = existsSync,
): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, "..", "browser", name),
    join(moduleDir, "..", "src", "browser", name),
  ];
  try {
    // import.meta.resolve honors the ESM ("import") export condition; a
    // createRequire lookup would fail on these import-only exports maps.
    // The main entry is <root>/src/index.ts; walk to the browser sources.
    const mainEntry = fileURLToPath(
      import.meta.resolve("@openreel/runtime-chromium"),
    );
    candidates.push(join(dirname(mainEntry), "browser", name));
    candidates.push(join(dirname(mainEntry), "..", "src", "browser", name));
  } catch {
    // package self-resolution unavailable (source tree is enough)
  }
  for (const candidate of candidates) {
    if (sourceExists(candidate)) return candidate;
  }
  throw new Error(
    `cannot locate the browser entry source ${name} (tried: ${candidates.join(", ")})`,
  );
}

/**
 * Full resolution: the pre-bundle wins when advertised (packaged), otherwise
 * the TS source candidates (dev). Split from doBuild so the resolution
 * policy is unit-testable without invoking esbuild.
 */
export function resolveBrowserEntry(
  context: BrowserEntryContext = {},
): ResolvedBrowserEntry {
  const prebundled = loadPrebundledBrowserEntry(context);
  if (prebundled !== undefined) return { kind: "prebundled", text: prebundled };
  const sourceExists = context.sourceExists ?? existsSync;
  return {
    kind: "source",
    entry: resolveBrowserSource("entry.ts", sourceExists),
    extractAudioShim: resolveBrowserSource("extract-audio-shim.ts", sourceExists),
  };
}

async function doBuild(): Promise<string> {
  const resolved = resolveBrowserEntry();
  if (resolved.kind === "prebundled") return resolved.text;
  const result = await build({
    entryPoints: [resolved.entry],
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
          // Dev path only: the pre-bundled artifact already contains the shim.
          pluginBuild.onResolve({ filter: /(^|\/)extract-audio$/ }, () => ({
            path: resolved.extractAudioShim,
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
