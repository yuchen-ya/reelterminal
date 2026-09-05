import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { stripFfmpegPlugin } from "./vite-plugins/strip-ffmpeg";
import { pruneFontsPlugin } from "./vite-plugins/prune-fonts";

const isDesktop = process.env.OPENREEL_DESKTOP === "1";

const normalizedModuleId = (id: string): string => id.replaceAll("\\", "/");
const isNodePackage = (id: string, packageName: string): boolean =>
  normalizedModuleId(id).includes(`/node_modules/${packageName}/`);

function desktopHtmlPlugin() {
  return {
    name: "openreel-desktop-html",
    transformIndexHtml(html: string) {
      if (!isDesktop) return html;
      let out = html
        .replace(/href="\/favicon\.svg"/g, 'href="./favicon.svg"')
        .replace(/href="\/manifest\.json"/g, 'href="./manifest.json"')
        .replace(/href="\/icons\/icon-192\.png"/g, 'href="./icons/icon-192.png"');
      out = out.replace(
        /<link rel="preconnect"[^>]*>\s*/g,
        "",
      );
      out = out.replace(
        /<link href="https:\/\/fonts\.googleapis\.com[^>]*>\s*/g,
        '<link href="./fonts/google-fonts.css" rel="stylesheet" />',
      );
      return out;
    },
  };
}

export default defineConfig({
  base: isDesktop ? "./" : "/",
  plugins: [react(), desktopHtmlPlugin(), stripFfmpegPlugin(isDesktop), pruneFontsPlugin(isDesktop)],
  assetsInclude: ["**/*.wasm"],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      react: path.resolve(__dirname, "./node_modules/react"),
      "react-dom": path.resolve(__dirname, "./node_modules/react-dom"),
      "@": path.resolve(__dirname, "./src"),
      "@openreel/core": path.resolve(__dirname, "../../packages/core/src"),
      "@openreel/agent-facade": path.resolve(__dirname, "../../packages/agent-facade/src"),
      "@openreel/ui": path.resolve(__dirname, "../../packages/ui/src"),
    },
  },
  worker: { format: "es" },
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util", "@ffmpeg/core", "@ffmpeg/core-mt"],
  },
  build: {
    target: "esnext",
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          // Match the package segment itself. pnpm peer suffixes contain
          // strings such as `_react@...`; broad substring matching pulled
          // unrelated i18n and syntax-highlighting modules into `react`.
          if (
            isNodePackage(id, "react") ||
            isNodePackage(id, "react-dom") ||
            isNodePackage(id, "scheduler")
          ) return "react";
          if (isNodePackage(id, "zustand")) return "zustand";
          if (isNodePackage(id, "three")) return "three";
          if (isNodePackage(id, "@radix-ui")) return "radix";
          if (
            isNodePackage(id, "gsap") ||
            isNodePackage(id, "framer-motion") ||
            isNodePackage(id, "motion-dom") ||
            isNodePackage(id, "motion-utils")
          ) return "animation-vendor";
          if (isNodePackage(id, "mediabunny")) return "media-vendor";
          if (isNodePackage(id, "@paper-design/shaders")) return "shader-vendor";
          if (
            isNodePackage(id, "react-syntax-highlighter") ||
            isNodePackage(id, "highlight.js") ||
            isNodePackage(id, "lowlight")
          ) return "syntax-highlighting";
        },
      },
    },
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
