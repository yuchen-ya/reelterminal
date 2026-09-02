/**
 * Remove only the generated runtime-dependency symlinks before tsup cleans
 * dist/. Some recursive cleaners traverse directory symlinks; leaving these
 * links in place can therefore erase the pnpm store targets they point at.
 * Refuse to remove a real directory so this prebuild step stays fail-closed.
 */
import { lstatSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distModules = path.join(packageDir, "dist", "node_modules");
const LINKED_PACKAGES = ["esbuild", "playwright-core", "mediabunny"];

for (const name of LINKED_PACKAGES) {
  const linkPath = path.join(distModules, name);
  try {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `unlink-runtime-deps: refusing to remove non-symlink ${linkPath}`,
      );
    }
    unlinkSync(linkPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      continue;
    }
    throw error;
  }
}
