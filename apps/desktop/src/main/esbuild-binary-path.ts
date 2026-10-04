import { existsSync } from "node:fs";
import path from "node:path";

/**
 * esbuild's JS API locates its platform binary with require.resolve, which
 * inside a packaged install resolves to
 * `<resources>/app.asar/node_modules/@esbuild/<platform>-<arch>/esbuild.exe`.
 * Electron's child_process cannot spawn a file from inside an asar archive, so
 * every real esbuild call (runtime-chromium's buildBrowserEntry → preview /
 * export / visual inspect / media.render_html) dies with ENOENT. The actual
 * binary is present at `<resources>/app.asar.unpacked/node_modules/@esbuild/
 * <platform>-<arch>/` (electron-builder smartUnpack), and esbuild honours the
 * ESBUILD_BINARY_PATH environment variable as an override.
 *
 * In packaged installs the browser entry itself must not be esbuild-built at
 * runtime either (the spawned esbuild.exe cannot read the TS sources inside
 * app.asar). apps/desktop/scripts/build-browser-entry.mjs pre-bundles it at
 * build time into `app.asar/dist/browser-entry.mjs`, and the
 * REELTERMINAL_BROWSER_ENTRY_BUNDLE env var set here tells runtime-chromium's
 * bundle.ts to serve that finished artifact directly. ESBUILD_BINARY_PATH
 * stays as defense in depth for any other esbuild use.
 *
 * Timing matters: esbuild's lib/main.js captures process.env.ESBUILD_BINARY_PATH
 * into a module-scope variable at require time, and the main bundle evaluates
 * `require("esbuild")` (runtime-chromium's static import) as a top-level
 * statement BEFORE any entry-file body code runs. So the env vars cannot be set
 * from index.ts's body — this module must be the main entry's FIRST import,
 * letting its top-level side effect run ahead of that require. It deliberately
 * imports nothing from electron so unit tests run it in plain node.
 */

export interface EsbuildBinaryPathContext {
  /** Electron's process.resourcesPath; unset/undefined short-circuits to a no-op. */
  resourcesPath?: string;
  /** Defaults to process.platform; picks the binary file name (esbuild.exe on win32). */
  platform?: string;
  /** Defaults to process.arch; picks the @esbuild/<platform>-<arch> package dir. */
  arch?: string;
  /** Target env object; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Existence probe; defaults to fs.existsSync (injectable for tests). */
  fileExists?: (candidate: string) => boolean;
}

function defaultFileExists(candidate: string): boolean {
  return existsSync(candidate);
}

/** electron's d.ts types resourcesPath as always-present string; it is not. */
function processResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

function defaultContext(): EsbuildBinaryPathContext & {
  platform: string;
  arch: string;
  env: NodeJS.ProcessEnv;
} {
  return {
    resourcesPath: processResourcesPath(),
    platform: process.platform,
    arch: process.arch,
    env: process.env,
  };
}

/**
 * Resolve the smartUnpacked esbuild binary for a packaged install, or
 * undefined when not packaged / when the binary is not where electron-builder
 * puts it (in which case we leave esbuild's own resolution untouched rather
 * than pointing the env var at a missing file).
 */
export function packagedEsbuildBinaryPath(
  context: EsbuildBinaryPathContext,
): string | undefined {
  const resourcesPath = context.resourcesPath;
  if (!resourcesPath) return undefined;
  const fileExists = context.fileExists ?? defaultFileExists;
  // Packaged discriminator without importing electron: a packaged install
  // keeps the app at <resourcesPath>/app.asar, while a dev run's resources
  // dir (node_modules/electron/dist/resources) only holds default_app.asar —
  // so dev runs and unit tests stay untouched.
  if (!fileExists(path.join(resourcesPath, "app.asar"))) return undefined;
  const platform = context.platform ?? process.platform;
  const arch = context.arch ?? process.arch;
  const binary = platform === "win32" ? "esbuild.exe" : "esbuild";
  const candidate = path.join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@esbuild",
    `${platform}-${arch}`,
    binary,
  );
  return fileExists(candidate) ? candidate : undefined;
}

/**
 * Resolve the build-time pre-bundled browser entry for a packaged install
 * (`<resources>/app.asar/dist/browser-entry.mjs`, produced by
 * scripts/build-browser-entry.mjs), or undefined when not packaged / when the
 * artifact is missing. Reading text from inside app.asar is fine — Electron
 * patches fs for that — it is only spawning that cannot cross the archive.
 */
export function packagedBrowserEntryBundlePath(
  context: EsbuildBinaryPathContext,
): string | undefined {
  const resourcesPath = context.resourcesPath;
  if (!resourcesPath) return undefined;
  const fileExists = context.fileExists ?? defaultFileExists;
  if (!fileExists(path.join(resourcesPath, "app.asar"))) return undefined;
  const candidate = path.join(
    resourcesPath,
    "app.asar",
    "dist",
    "browser-entry.mjs",
  );
  return fileExists(candidate) ? candidate : undefined;
}

/**
 * Set ESBUILD_BINARY_PATH and REELTERMINAL_BROWSER_ENTRY_BUNDLE when running
 * packaged. Returns whether any env var was set. No-op in dev runs and in
 * unit tests.
 */
export function installPackagedEsbuildBinaryPath(
  context: EsbuildBinaryPathContext = defaultContext(),
): boolean {
  const env = context.env ?? process.env;
  let installed = false;
  const binary = packagedEsbuildBinaryPath(context);
  if (binary) {
    env.ESBUILD_BINARY_PATH = binary;
    installed = true;
  }
  const bundle = packagedBrowserEntryBundlePath(context);
  if (bundle) {
    env.REELTERMINAL_BROWSER_ENTRY_BUNDLE = bundle;
    installed = true;
  }
  return installed;
}

// Module-load side effect: see the file comment for why this runs from the
// entry's first import instead of from index.ts's body.
installPackagedEsbuildBinaryPath();
