import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "main/index": "src/main/index.ts",
    "preload/index": "src/preload/index.ts",
    "aurora-host/index": "src/aurora-host/index.ts",
    // Standalone stdio→HTTP MCP connector for the external 15-tool live
    // endpoint. It has no provider/model/registry dependencies.
    "live-mcp/index": "src/live-mcp/index.ts",
  },
  format: ["cjs"],
  platform: "node",
  target: "node18",
  // Only electron is provided by the runtime. Everything else (electron-updater
  // and its transitive deps like fs-extra) is bundled into the main process so
  // the packaged asar needs no JS node_modules — pnpm's symlinked store is not
  // fully copied into the asar, which dropped electron-updater's deps and
  // crashed the app on launch ("Cannot find module 'fs-extra'").
  // The live-collaboration workspace packages ship TypeScript source (their
  // package "main" IS the .ts file), so they must be inlined into the bundle —
  // same pattern as agent-transport (ADR 0003 Appendix A). esbuild /
  // playwright-core / mediabunny stay external (esbuild needs its platform
  // binary, playwright-core its browser registry); they are real dependencies
  // of this package so the bundle's require() resolves them from
  // apps/desktop/node_modules at runtime.
  external: ["electron", "esbuild", "playwright-core", "mediabunny"],
  noExternal: [
    "electron-updater",
    "zod",
    "@openreel/agent-facade",
    "@openreel/runtime-chromium",
    "@openreel/core",
  ],
  // runtime-chromium's node/bundle.ts resolves the browser entry relative to
  // import.meta.url; the CJS bundle needs the tsup import.meta.url shim so
  // that resolution lands in dist/ (scripts/link-live-runtime-deps.mjs places
  // the browser sources there).
  shims: true,
  clean: true,
  sourcemap: true,
});
