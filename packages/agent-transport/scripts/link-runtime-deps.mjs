/**
 * Post-build fixup: the bundled CLI keeps esbuild / playwright-core /
 * mediabunny external (they must run from their real installed locations —
 * esbuild needs its platform binary, playwright-core its browser registry).
 * They are dependencies of @openreel/runtime-chromium, not of this package
 * (ADR 0003: the transport adds no runtime dependencies of its own), so the
 * bundle resolves them by linking each package into dist/node_modules —
 * the directory Node consults first for code inside dist/.
 *
 * Every link points at the exact store location pnpm resolved for
 * @openreel/runtime-chromium, so the binary runs the same versions as the
 * workspace. Idempotent: re-running replaces stale links.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distModules = path.join(packageDir, "dist", "node_modules");

// Resolve through the workspace package that actually depends on these
// packages, so the linked copy is exactly the one the workspace uses.
const runtimeChromiumRequire = createRequire(
  path.join(packageDir, "..", "runtime-chromium", "package.json"),
);

/** Also linked: everything dist/cli.js itself imports externally. */
const LINKED_PACKAGES = ["esbuild", "playwright-core", "mediabunny"];

mkdirSync(distModules, { recursive: true });
for (const name of LINKED_PACKAGES) {
  // Some packages (e.g. mediabunny) do not export "./package.json", so
  // resolve the module ENTRY and walk up to the directory owning the
  // package.json — that directory is the real store location.
  const entryPath = runtimeChromiumRequire.resolve(name);
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
  symlinkSync(target, linkPath, "dir");
  process.stderr.write(`[link-runtime-deps] dist/node_modules/${name} -> ${target}\n`);
}
