import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import afterPack, { pruneOnnxRuntime } from "./prune-onnx-runtime.mjs";

const roots = [];

function fixture(platforms) {
  const root = mkdtempSync(path.join(os.tmpdir(), "rt-onnx-prune-"));
  roots.push(root);
  for (const [platform, arches] of Object.entries(platforms)) {
    for (const arch of arches) {
      const dir = path.join(root, platform, arch);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "onnxruntime_binding.node"), "x");
    }
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pruneOnnxRuntime", () => {
  it("keeps only the target platform and arch", () => {
    const root = fixture({
      darwin: ["arm64", "x64"],
      linux: ["x64"],
      win32: ["x64", "arm64"],
    });
    const removed = pruneOnnxRuntime(root, "win32", "x64");
    assert.deepEqual(readdirSync(root), ["win32"]);
    assert.deepEqual(readdirSync(path.join(root, "win32")), ["x64"]);
    assert.ok(removed.includes("darwin"));
    assert.ok(removed.includes("linux"));
    assert.ok(removed.includes("win32/arm64"));
  });

  it("keeps every arch for universal builds", () => {
    const root = fixture({ darwin: ["arm64", "x64"] });
    pruneOnnxRuntime(root, "darwin", "universal");
    assert.deepEqual(readdirSync(path.join(root, "darwin")).sort(), ["arm64", "x64"]);
  });

  it("is a no-op when the runtime is absent", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "rt-onnx-prune-"));
    roots.push(root);
    assert.deepEqual(pruneOnnxRuntime(path.join(root, "missing"), "win32", "x64"), []);
  });

  it("afterPack resolves the resources dir and prunes the packaged tree", async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), "rt-onnx-pack-"));
    roots.push(outDir);
    const resources = path.join(outDir, "resources", "app.asar.unpacked", "node_modules", "onnxruntime-node", "bin", "napi-v6");
    for (const [platform, arch] of [["win32", "x64"], ["win32", "arm64"], ["darwin", "x64"]]) {
      const dir = path.join(resources, platform, arch);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "onnxruntime_binding.node"), "x");
    }
    await afterPack({
      arch: 1, // Arch.x64
      electronPlatformName: "win32",
      appOutDir: outDir,
      packager: { getResourcesDir: () => path.join(outDir, "resources") },
    });
    assert.deepEqual(readdirSync(resources), ["win32"]);
    assert.deepEqual(readdirSync(path.join(resources, "win32")), ["x64"]);
  });
});
