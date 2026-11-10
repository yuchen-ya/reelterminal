import { defineConfig } from "vitest/config";

// GUI/harness acceptance has its own e2e config. Local retained artifacts must
// never enter the ordinary package suite through Vitest's default glob.
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
    fileParallelism: false,
    maxWorkers: 2,
  },
});
