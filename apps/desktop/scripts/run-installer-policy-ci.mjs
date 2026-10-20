// CI-only toolchain preparation; local offline runs can set the compiler explicitly.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("The required native installer CI job must run on Windows.");
}
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
// Use the same pinned resolver/cache/checksums as packaging; no separate dependency.
const { getMakeNsisPath } = builderRequire("app-builder-lib/out/toolsets/windows");
const compiler = await getMakeNsisPath();
const result = spawnSync(process.execPath, [
  "--test", fileURLToPath(new URL("./installer-data-policy.node-test.mjs", import.meta.url)),
  fileURLToPath(new URL("./legacy-upgrade-rehearsal.node-test.mjs", import.meta.url)),
], {
  env: { ...process.env, ...compiler.env, REELTERMINAL_NSIS_MAKENSIS: compiler.path },
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
