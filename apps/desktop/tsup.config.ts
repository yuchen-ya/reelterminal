import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "main/index": "src/main/index.ts",
    "preload/index": "src/preload/index.ts",
    "aurora-host/index": "src/aurora-host/index.ts",
    // Standalone stdio→HTTP MCP connector for the external live endpoint.
    // Tool names are bundled from the facade's canonical registry.
    "live-mcp/index": "src/live-mcp/index.ts",
    "live-mcp/legacy": "src/live-mcp/legacy.ts",
    // CLI for the project currently open in the desktop app.
    "reelctl/index": "src/reelctl/index.ts",
  },
  format: ["cjs"],
  platform: "node",
  target: "node18",
  // Only electron is provided by the runtime. Everything else (electron-updater
  // and its transitive deps like fs-extra) is bundled into the main process so
  // the packaged asar needs no JS node_modules — pnpm's symlinked store is not
  // fully copied into the asar.
  // The live-collaboration workspace packages ship TypeScript source (their
  // package "main" IS the .ts file), so they must be inlined into the bundle —
  // esbuild /
  // playwright-core / mediabunny stay external (esbuild needs its platform
  // binary, playwright-core its browser registry); they are real dependencies
  // of this package so the bundle's require() resolves them from
  // apps/desktop/node_modules at runtime.
  external: ["electron", "esbuild", "playwright-core", "mediabunny"],
  noExternal: [
    "electron-updater",
    "zod",
    "@reelterminal/agent-facade",
    "@reelterminal/runtime-chromium",
    "@reelterminal/core",
  ],
  // runtime-chromium's node/bundle.ts resolves the browser entry relative to
  // import.meta.url; the CJS bundle needs the tsup import.meta.url shim so
  // that resolution lands in dist/ (scripts/link-live-runtime-deps.mjs places
  // the browser sources there).
  shims: true,
  clean: true,
  sourcemap: true,
  // Pre-bundle the runtime-chromium browser entry (src/browser/entry.ts) into
  // dist/browser-entry.mjs, which electron-builder packs into app.asar. In a
  // packaged install the runtime esbuild build (node/bundle.ts) cannot work:
  // the spawned esbuild.exe is an ordinary process and cannot read the TS
  // sources inside app.asar. With the pre-bundle present, bundle.ts serves it
  // via REELTERMINAL_BROWSER_ENTRY_BUNDLE (set by
  // src/main/esbuild-binary-path.ts) and never spawns esbuild at all. The
  // hook runs after clean+emit, so the
  // artifact lands in the freshly-written dist/. A failure here fails the
  // build (process.exitCode + rethrow) — never ship an app without it.
  // NOTE: `pnpm dev` passes --onSuccess on the CLI, which overrides this
  // config hook; dev keeps bundling the entry at runtime from the checkout,
  // where esbuild and the TS sources are available.
  onSuccess: async () => {
    const script = resolve(process.cwd(), "scripts", "build-browser-entry.mjs");
    const result = spawnSync(process.execPath, [script], { stdio: "inherit" });
    if (result.error) {
      process.exitCode = 1;
      throw new Error(
        `browser-entry prebundle could not start: ${String(result.error)}`,
      );
    }
    if (result.status !== 0) {
      process.exitCode = 1;
      throw new Error(
        `browser-entry prebundle failed (exit ${result.status ?? "signal"}) — a packaged build without dist/browser-entry.mjs loses preview/export/visual-inspect`,
      );
    }
  },
});
