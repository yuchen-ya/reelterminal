import { defineConfig, mergeConfig } from "vite";
import path from "node:path";
import webConfig from "./vite.config";

// The production editor UI in a static entry, without DesktopApp bootstrap,
// native bridge, service worker, review workspace or model/export services.
export default mergeConfig(
  webConfig,
  defineConfig({
    root: path.resolve(__dirname, "showcase"),
    base: "./",
    publicDir: path.resolve(__dirname, "showcase/public"),
    css: { postcss: path.resolve(__dirname) },
    build: {
      outDir: path.resolve(__dirname, "dist-showcase"),
      emptyOutDir: true,
    },
  }),
);
