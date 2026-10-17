/**
 * Regression guard for the standalone CLI bundle: onnxruntime-node is a native
 * package and must stay external. Inlining it makes esbuild emit the .node
 * bindings as file-loader path strings (and breaks the CJS builtin requires),
 * so `speechActivity` silently reported unavailable in the shipped CLI.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import config from "../tsup.config";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("standalone CLI bundling of the optional ONNX runtime", () => {
  it("keeps onnxruntime-node external", () => {
    const external = (config as { external?: string[] }).external ?? [];
    expect(external).toContain("onnxruntime-node");
  });

  it("links the external runtime into dist/node_modules", () => {
    const link = readFileSync(path.join(packageDir, "scripts", "link-runtime-deps.mjs"), "utf8");
    const unlink = readFileSync(path.join(packageDir, "scripts", "unlink-runtime-deps.mjs"), "utf8");
    expect(link).toContain('"onnxruntime-node"');
    expect(unlink).toContain('"onnxruntime-node"');
  });

  it("fails the build when a native binding was inlined again", () => {
    const link = readFileSync(path.join(packageDir, "scripts", "link-runtime-deps.mjs"), "utf8");
    expect(link).toContain("onnxruntime_binding-");
    expect(link).toContain("keep onnxruntime-node in tsup external");
  });
});
