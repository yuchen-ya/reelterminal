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
import { mkdir, rm, symlink } from "node:fs/promises";
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

await mkdir(distModules, { recursive: true });
for (const name of LINKED_PACKAGES) {
  const pkgJsonPath = runtimeChromiumRequire.resolve(`${name}/package.json`);
  const realDir = path.dirname(pkgJsonPath);
  const linkPath = path.join(distModules, name);
  await rm(linkPath, { force: true, recursive: true });
  const target = path.relative(path.dirname(linkPath), realDir);
  await symlink(target, linkPath, "dir");
  process.stderr.write(`[link-runtime-deps] dist/node_modules/${name} -> ${target}\n`);
}
