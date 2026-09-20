import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@reelterminal/core": path.resolve(__dirname, "../../packages/core/src"),
      "@reelterminal/fxpkg": path.resolve(__dirname, "../../packages/fxpkg/src"),
      "@reelterminal/ui": path.resolve(__dirname, "../../packages/ui/src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
