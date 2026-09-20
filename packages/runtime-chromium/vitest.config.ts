import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    // Real Chromium launches + real encodes: these tests are minutes-scale,
    // not milliseconds-scale. One file at a time keeps browser processes
    // from contending on small CI runners.
    testTimeout: 600_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    pool: "forks",
  },
  resolve: {
    alias: {
      "@reelterminal/core": path.resolve(__dirname, "../core/src"),
      "@reelterminal/agent-facade": path.resolve(__dirname, "../agent-facade/src"),
      "@reelterminal/runtime-chromium": path.resolve(__dirname, "./src"),
    },
  },
});
