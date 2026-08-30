/**
 * Builds the real packaged binary once per test run: the protocol, signal,
 * stdout-purity and workflow suites spawn `dist/cli.js` — the actual
 * artifact `pnpm --filter @openreel/agent-transport build` produces — so
 * they exercise the shipped packaging, not in-process source. After the
 * tsup build, the external runtime deps (esbuild / playwright-core /
 * mediabunny, dependencies of @openreel/runtime-chromium) are linked into
 * dist/node_modules exactly as the real build step does.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default async function globalSetup(): Promise<void> {
  const tsupBin = path.join(packageDir, "node_modules", ".bin", "tsup");
  if (!existsSync(tsupBin)) {
    throw new Error(`global-setup: tsup binary not found at ${tsupBin} — run pnpm install`);
  }
  // Remove dist BEFORE the build: tsup's `clean: true` would otherwise
  // recurse into dist/node_modules (symlinks to the runtime deps) and try
  // to unlink their content.
  rmSync(path.join(packageDir, "dist"), { recursive: true, force: true });
  const build = spawnSync(tsupBin, ["--config", "tsup.config.ts"], {
    cwd: packageDir,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    throw new Error(`global-setup: tsup build failed with status ${build.status}`);
  }
  const link = spawnSync(process.execPath, [path.join(packageDir, "scripts", "link-runtime-deps.mjs")], {
    cwd: packageDir,
    stdio: "inherit",
  });
  if (link.status !== 0) {
    throw new Error(`global-setup: link-runtime-deps failed with status ${link.status}`);
  }
}
