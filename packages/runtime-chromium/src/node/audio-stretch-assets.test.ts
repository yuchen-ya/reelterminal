import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { audioStretchAssets } from "./audio-stretch-assets.mjs";

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true }); });

async function fixture() {
  root = await mkdtemp(join(tmpdir(), "stretch-assets-"));
  const dist = join(root, "signalsmith-stretch-js", "dist");
  for (const folder of ["worker", "core", "wasm"]) await mkdir(join(dist, folder), { recursive: true });
  await writeFile(join(dist, "wasm", "signalsmith-stretch-wasm.wasm"), "wasm fixture");
  return dist;
}

it("retries a worker bundle after a failed build instead of caching its rejection", async () => {
  const dist = await fixture();
  const entry = join(dist, "worker", "index.js");
  await writeFile(entry, 'export const worker = new URL("./signalsmith-stretch.worker.js", import.meta.url);');
  const plugin = audioStretchAssets();
  const bundle = () => build({ entryPoints: [entry], bundle: true, write: false, format: "esm", logLevel: "silent", plugins: [plugin] });
  await expect(bundle()).rejects.toThrow(/signalsmith-stretch\.worker/);
  await writeFile(join(dist, "worker", "signalsmith-stretch.worker.js"), 'self.postMessage("worker-ready");');
  const recovered = await bundle();
  expect(recovered.outputFiles[0].text).toContain("worker-ready");
  expect(recovered.outputFiles[0].text).toContain("URL.createObjectURL");
});

it.each(["core/engine.js", "worker/index.js"])("reports a changed dependency asset URL in %s", async (relative) => {
  const dist = await fixture();
  const entry = join(dist, relative);
  await writeFile(entry, "export const changed = true;");
  await writeFile(join(dist, "worker", "signalsmith-stretch.worker.js"), "self.postMessage(1);");
  await expect(build({ entryPoints: [entry], bundle: true, write: false, format: "esm", logLevel: "silent",
    plugins: [audioStretchAssets()] })).rejects.toThrow(/Signalsmith asset URL was not found/);
});
