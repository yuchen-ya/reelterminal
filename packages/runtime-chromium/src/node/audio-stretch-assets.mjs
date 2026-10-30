import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build } from "esbuild";

// Runtime Chromium is served as one script, without a filesystem asset server.
// Bundle the dependency's existing worker and WASM into that script. Vite's
// renderer build handles these same new URL() assets natively.
export function audioStretchAssets() {
  let workerBundle;
  return {
    name: "reelterminal-audio-stretch-assets",
    setup(builder) {
      builder.onResolve({ filter: /^node:module$/ }, (args) => {
        if (args.importer.includes("signalsmith-stretch-js")) return { path: args.path, external: true };
      });
      builder.onLoad({ filter: /signalsmith-stretch-js[\\/]dist[\\/]core[\\/]engine\.js$/ }, async ({ path }) => {
        const source = await readFile(path, "utf8");
        const wasm = await readFile(join(dirname(path), "../wasm/signalsmith-stretch-wasm.wasm"));
        return { contents: source.replace(
          'new URL("../wasm/signalsmith-stretch-wasm.wasm", import.meta.url).href',
          JSON.stringify(`data:application/wasm;base64,${wasm.toString("base64")}`),
        ), resolveDir: dirname(path), loader: "js" };
      });
      builder.onLoad({ filter: /signalsmith-stretch-js[\\/]dist[\\/]worker[\\/]index\.js$/ }, async ({ path }) => {
        workerBundle ??= build({ entryPoints: [join(dirname(path), "signalsmith-stretch.worker.js")],
          bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", minify: true,
          plugins: [audioStretchAssets()] }).then((result) => result.outputFiles[0].text);
        const source = await readFile(path, "utf8");
        return { contents: source.replace(
          'new URL("./signalsmith-stretch.worker.js", import.meta.url)',
          `URL.createObjectURL(new Blob([${JSON.stringify(await workerBundle)}], { type: "text/javascript" }))`,
        ), resolveDir: dirname(path), loader: "js" };
      });
    },
  };
}
