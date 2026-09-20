import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
  },
  resolve: {
    alias: {
      "@reelterminal/core": path.resolve(__dirname, "../core/src"),
      "@reelterminal/agent-facade": path.resolve(__dirname, "./src"),
    },
  },
});
