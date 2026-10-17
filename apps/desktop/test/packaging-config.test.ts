/**
 * Packaging config guard: the ONNX runtime is ~64 MB per platform/arch tree.
 * A regression that removes the platform/arch pruning silently adds dozens of
 * megabytes to every installer (and ships binaries that are never loaded).
 *
 * electron-builder is a devDependency and owns js-yaml; resolve it through the
 * real (non-symlinked) package location so this test needs no extra dependency.
 */
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface ElectronBuilderConfig {
  readonly asarUnpack?: readonly string[];
  readonly afterPack?: string;
  readonly files?: readonly string[];
  readonly win?: { readonly files?: readonly string[]; readonly target?: readonly { readonly arch?: readonly string[] }[] };
  readonly mac?: { readonly files?: readonly string[] };
  readonly linux?: { readonly files?: readonly string[] };
}

function loadConfig(): ElectronBuilderConfig {
  const builderPackage = realpathSync(path.join(desktopDir, "node_modules", "electron-builder", "package.json"));
  const yaml = createRequire(builderPackage)("js-yaml") as { load(source: string): unknown };
  return yaml.load(readFileSync(path.join(desktopDir, "electron-builder.yml"), "utf8")) as ElectronBuilderConfig;
}

describe("electron-builder ONNX runtime packaging", () => {
  const config = loadConfig();

  it("does not prune the runtime globally", () => {
    expect(config.files?.some((pattern) => pattern.includes("napi-v6"))).toBe(false);
  });

  it("keeps only the target platform/arch per platform", () => {
    expect(config.win?.files).toEqual(expect.arrayContaining([
      expect.stringContaining("darwin"),
      expect.stringContaining("linux"),
      expect.stringContaining("win32/arm64"),
    ]));
    expect(config.mac?.files).toEqual(expect.arrayContaining([
      expect.stringContaining("win32"),
      expect.stringContaining("linux"),
    ]));
    expect(config.linux?.files).toEqual(expect.arrayContaining([
      expect.stringContaining("win32"),
      expect.stringContaining("darwin"),
      expect.stringContaining("linux/arm64"),
    ]));
    expect(new Set(config.win?.target?.flatMap((target) => target.arch ?? []))).toEqual(new Set(["x64"]));
  });

  it("unpacks the native runtime and its JS dependency, and prunes per arch after pack", () => {
    expect(config.asarUnpack).toEqual(expect.arrayContaining([
      "node_modules/onnxruntime-node/**",
      "node_modules/onnxruntime-common/**",
    ]));
    expect(config.afterPack).toBe("scripts/prune-onnx-runtime.mjs");
  });
});
