/**
 * Builds the real packaged binary once per test run: the protocol, signal,
 * stdout-purity and workflow suites spawn `dist/cli.js` — the actual
 * artifact `pnpm --filter @reelterminal/agent-transport build` produces — so
 * they exercise the shipped packaging, not in-process source. After the
 * tsup build, the external runtime deps (esbuild / playwright-core /
 * mediabunny, dependencies of @reelterminal/runtime-chromium) are linked into
 * dist/node_modules exactly as the real build step does.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default async function globalSetup(): Promise<void> {
  // The .bin shim is a POSIX shell script and cannot be spawned directly on
  // Windows; run tsup's real JS entry through Node instead.
  const tsupEntry = path.join(packageDir, "node_modules", "tsup", "dist", "cli-default.js");
  if (!existsSync(tsupEntry)) {
    throw new Error(`global-setup: tsup entry not found at ${tsupEntry} — run pnpm install`);
  }
  // Unlink generated dependency links before ANY recursive dist cleanup.
  // Some cleaners traverse directory symlinks and can otherwise erase the
  // pnpm-store targets rather than just the links.
  const unlink = spawnSync(
    process.execPath,
    [path.join(packageDir, "scripts", "unlink-runtime-deps.mjs")],
    { cwd: packageDir, stdio: "inherit" },
  );
  if (unlink.status !== 0) {
    throw new Error(
      `global-setup: unlink-runtime-deps failed with status ${unlink.status}`,
    );
  }
  rmSync(path.join(packageDir, "dist"), { recursive: true, force: true });
  const build = spawnSync(process.execPath, [tsupEntry, "--config", "tsup.config.ts"], {
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
