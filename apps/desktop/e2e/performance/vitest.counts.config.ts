import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "performance-contracts",
    include: ["e2e/harness/performance/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
