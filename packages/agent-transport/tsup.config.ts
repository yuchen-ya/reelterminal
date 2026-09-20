import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node18",
  // Workspace packages ship TypeScript source (their package "main" IS the
  // .ts file), so they must be inlined into the standalone CLI bundle — the
  // agent-runner packaging pattern (ADR 0003 Appendix A rows 9/13/16).
  // Real npm packages stay external; the inlined runtime-chromium code
  // imports esbuild/playwright-core/mediabunny, which the post-build
  // scripts/link-runtime-deps.mjs step links into dist/node_modules so the
  // built binary resolves them exactly where the workspace installs them.
  noExternal: [
    "@reelterminal/agent-facade",
    "@reelterminal/runtime-chromium",
    "@reelterminal/core",
  ],
  external: ["esbuild", "playwright-core", "mediabunny"],
  clean: true,
  sourcemap: true,
});
