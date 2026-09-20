import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

function rawCssUrlForTests() {
  return {
    name: "reelterminal-raw-css-url-for-tests",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!id.endsWith(".test.ts") && !id.endsWith(".test.tsx")) return null;
      if (!code.includes('new URL("./') || !code.includes("import.meta.url")) return null;
      const replaced = code.replace(
        /new URL\(("(?:\.\.?\/)[^"]+"),\s*import\.meta\.url\)/g,
        (_match, spec) =>
          `new URL(${spec}, "file://" + ${JSON.stringify(id)})`,
      );
      if (replaced === code) return null;
      return { code: replaced, map: null };
    },
  };
}

export default defineConfig({
  plugins: [rawCssUrlForTests(), react()],
  test: {
    globals: true,
    environment: "jsdom",
    // Several browser/media modules keep worker-local handles after cleanup.
    // Process isolation lets Vitest reclaim them deterministically; the thread
    // pool can otherwise pass every assertion and never terminate.
    pool: "forks",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "src/**/*.spec.ts",
      "src/**/*.spec.tsx",
      "vite-plugins/**/*.test.ts",
    ],
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      react: path.resolve(__dirname, "./node_modules/react"),
      "react-dom": path.resolve(__dirname, "./node_modules/react-dom"),
      "@": path.resolve(__dirname, "./src"),
      "@reelterminal/core": path.resolve(__dirname, "../../packages/core/src"),
      "@reelterminal/agent-facade": path.resolve(__dirname, "../../packages/agent-facade/src"),
    },
  },
});
