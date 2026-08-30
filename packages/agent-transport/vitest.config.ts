import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Protocol/signal/purity tests spawn the real built binary; the setup
    // builds it once per run (and links the external runtime deps).
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    // Child processes + real Chromium must not contend: one file at a time.
    fileParallelism: false,
    pool: "forks",
  },
  resolve: {
    alias: {
      "@openreel/core": path.resolve(__dirname, "../core/src"),
      "@openreel/agent-facade": path.resolve(__dirname, "../agent-facade/src"),
      "@openreel/runtime-chromium": path.resolve(__dirname, "../runtime-chromium/src"),
      "@openreel/agent-transport": path.resolve(__dirname, "./src"),
    },
  },
});
