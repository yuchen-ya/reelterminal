/**
 * Post-build fixup: the bundled CLI keeps esbuild / playwright-core /
 * mediabunny / onnxruntime-node external (they must run from their real
 * installed locations — esbuild needs its platform binary, playwright-core
 * its browser registry, onnxruntime-node its native binding). They are
 * dependencies of @reelterminal/runtime-chromium / @reelterminal/agent-facade,
 * not of this package, so the bundle resolves them by linking each package
 * into dist/node_modules — the directory Node consults first for code inside
 * dist/.
 *
 * Every link points at the exact store location pnpm resolved for the owning
 * workspace package, so the binary runs the same versions as the workspace.
 * Idempotent: re-running replaces stale links. onnxruntime-node is optional:
 * when the platform/install did not provide it, the CLI reports the analysis
 * type unavailable instead of failing the build.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(packageDir, "dist");
const distModules = path.join(distDir, "node_modules");

// Resolve through the workspace package that actually depends on these
// packages, so the linked copy is exactly the one the workspace uses.
const runtimeChromiumRequire = createRequire(
  path.join(packageDir, "..", "runtime-chromium", "package.json"),
);
const facadeRequire = createRequire(
  path.join(packageDir, "..", "agent-facade", "package.json"),
);

/** Also linked: everything dist/cli.js itself imports externally. */
const LINKED_PACKAGES = [
  { name: "esbuild", resolve: runtimeChromiumRequire, optional: false },
  { name: "playwright-core", resolve: runtimeChromiumRequire, optional: false },
  { name: "mediabunny", resolve: runtimeChromiumRequire, optional: false },
  { name: "onnxruntime-node", resolve: facadeRequire, optional: true },
];

mkdirSync(distModules, { recursive: true });
for (const { name, resolve, optional } of LINKED_PACKAGES) {
  let entryPath;
  try {
    entryPath = resolve.resolve(name);
  } catch (error) {
    if (optional) {
      process.stderr.write(
        `[link-runtime-deps] optional ${name} is not installed — speech-activity analysis will report unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      continue;
    }
    throw error;
  }
  // Some packages (e.g. mediabunny) do not export "./package.json", so
  // resolve the module ENTRY and walk up to the directory owning the
  // package.json — that directory is the real store location.
  let realDir = path.dirname(entryPath);
  for (;;) {
    const candidate = path.join(realDir, "package.json");
    if (existsSync(candidate)) break;
    const parent = path.dirname(realDir);
    if (parent === realDir) {
      throw new Error(`link-runtime-deps: no package.json above ${entryPath}`);
    }
    realDir = parent;
  }
  const linkPath = path.join(distModules, name);
  rmSync(linkPath, { force: true, recursive: true });
  const target = path.relative(path.dirname(linkPath), realDir);
  // Directory junctions on Windows need no admin/Developer Mode privileges.
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  process.stderr.write(`[link-runtime-deps] dist/node_modules/${name} -> ${target}\n`);
}

// Fail the build if esbuild ever inlines a native .node file again: those
// hashed files are file-loader paths, not loadable modules.
const inlinedBindings = readdirSync(distDir).filter((name) =>
  /^onnxruntime_binding-.*\.node$/.test(name),
);
if (inlinedBindings.length > 0) {
  throw new Error(
    `link-runtime-deps: the bundle inlined native onnxruntime bindings (${inlinedBindings.join(", ")}); keep onnxruntime-node in tsup external`,
  );
}
