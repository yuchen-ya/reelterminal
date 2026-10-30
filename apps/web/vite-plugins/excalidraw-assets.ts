import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/** Excalidraw resolves its fonts at runtime; keep every font in the installation. */
export function excalidrawAssetsPlugin(): Plugin {
  const require = createRequire(import.meta.url);
  const root = path.join(path.dirname(require.resolve("@excalidraw/excalidraw")), "fonts");
  const files: string[] = [];
  function visit(directory: string, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) visit(path.join(directory, entry.name), name + "/");
      else files.push(name);
    }
  }
  visit(root);
  return {
    name: "reelterminal-excalidraw-fonts",
    generateBundle() {
      for (const file of files) this.emitFile({ type: "asset", fileName: `excalidraw-assets/fonts/${file}`, source: readFileSync(path.join(root, file)) });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const prefix = "/excalidraw-assets/fonts/";
        const url = request.url?.split("?")[0];
        if (!url?.startsWith(prefix)) return next();
        const file = decodeURIComponent(url.slice(prefix.length));
        if (!files.includes(file)) { response.statusCode = 404; response.end(); return; }
        response.setHeader("Content-Type", "font/woff2");
        response.end(readFileSync(path.join(root, file)));
      });
    },
  };
}
