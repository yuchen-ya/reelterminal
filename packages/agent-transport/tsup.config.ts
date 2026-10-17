import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node18",
  // Workspace packages ship TypeScript source (their package "main" IS the
  // .ts file), so they must be inlined into the standalone CLI bundle — the
  // Inlining workspace dependencies keeps the CLI bundle self-contained.
  // Real npm packages stay external; the inlined runtime-chromium code
  // imports esbuild/playwright-core/mediabunny, which the post-build
  // scripts/link-runtime-deps.mjs step links into dist/node_modules so the
  // built binary resolves them exactly where the workspace installs them.
  // onnxruntime-node is the optional Silero VAD runtime: its native binding
  // must load from a real directory, so it is externalized (and linked) too —
  // inlining it makes esbuild emit the .node as a path string and the bundle
  // fails to initialize.
  noExternal: [
    "@reelterminal/agent-facade",
    "@reelterminal/runtime-chromium",
    "@reelterminal/core",
  ],
  external: ["esbuild", "playwright-core", "mediabunny", "onnxruntime-node"],
  clean: true,
  sourcemap: true,
});
