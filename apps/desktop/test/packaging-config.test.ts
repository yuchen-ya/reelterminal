/**
 * Exercise the builder's merged payload filters as well as native runtime
 * pruning. A platform include must not undo shared development-file exclusions.
 *
 * electron-builder is a devDependency and owns js-yaml; resolve it through the
 * real (non-symlinked) package location so this test needs no extra dependency.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builderRequire = createRequire(realpathSync(path.join(desktopDir, "node_modules", "electron-builder", "package.json")));

interface ElectronBuilderConfig {
  readonly asarUnpack?: readonly string[];
  readonly afterPack?: string;
  readonly files?: readonly string[];
  readonly extraResources?: readonly { readonly from?: string; readonly to?: string }[];
  readonly win?: { readonly files?: readonly string[]; readonly target?: readonly { readonly arch?: readonly string[] }[] };
  readonly mac?: { readonly files?: readonly string[] };
  readonly linux?: { readonly files?: readonly string[] };
}

function loadConfig(): ElectronBuilderConfig {
  const yaml = builderRequire("js-yaml") as { load(source: string): unknown };
  return yaml.load(readFileSync(path.join(desktopDir, "electron-builder.yml"), "utf8")) as ElectronBuilderConfig;
}

describe("effective app payload filters", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it.each(["mac", "win", "linux"] as const)("keeps shared exclusions after merging %s options", (platform) => {
    const config = loadConfig();
    const root = mkdtempSync(path.join(tmpdir(), "reelterminal-packaging-filter-"));
    roots.push(root);
    const { getMainFileMatchers } = builderRequire("app-builder-lib/out/fileMatcher") as {
      getMainFileMatchers(...args: unknown[]): Array<{ createFilter(): (file: string, stat: Stats) => boolean }>;
    };
    const { doMergeConfigs } = builderRequire("app-builder-lib/out/util/config/config") as {
      doMergeConfigs(configs: unknown[]): Record<string, unknown>;
    };
    // Production normalizes common patterns into FileSets before creating
    // matchers. Raw YAML strings alone miss platform-only fallback includes.
    const normalized = doMergeConfigs([structuredClone(config)]);
    const filters = getMainFileMatchers(root, path.join(root, "app"), (value: string) => value,
      normalized[platform] ?? {}, { info: { projectDir: root, buildResourcesDir: "build", config: normalized, debugLogger: { isEnabled: false } } },
      path.join(root, "release"), false).map(matcher => matcher.createFilter());
    const matches = (relative: string) => {
      const file = path.join(root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "packaging fixture");
      return filters.some(include => include(file, statSync(file)));
    };

    for (const file of ["package.json", "dist/main/index.js", "dist/preload/index.js", "dist/reelctl/index.js", "dist/aurora-host/index.js", "dist/python/align.py"]) {
      expect(matches(file), `${platform} runtime ${file}`).toBe(true);
    }
    for (const file of [
      "src/main/index.ts",
      "dist/main/index.js.map", "dist/preload/index.js.map", "dist/reelctl/index.js.map", "dist/aurora-host/index.js.map",
      "dist/.artifacts/evidence.json", "dist/tests/fixture.txt", "dist/main/example.test.js", "dist/.env.local",
    ]) {
      expect(matches(file), `${platform} development file ${file}`).toBe(false);
    }
  });
});

describe("electron-builder ONNX runtime packaging", () => {
  const config = loadConfig();

  it("does not prune the runtime globally", () => {
    expect(config.files?.some((pattern) => pattern.includes("napi-v6"))).toBe(false);
  });

  it("builds only the supported Windows architecture", () => {
    expect(new Set(config.win?.target?.flatMap((target) => target.arch ?? []))).toEqual(new Set(["x64"]));
  });

  it("unpacks the native runtime and its JS dependency, and prunes per arch after pack", () => {
    expect(config.asarUnpack).toEqual(expect.arrayContaining([
      "dist/python/**",
      "node_modules/onnxruntime-node/**",
      "node_modules/onnxruntime-common/**",
    ]));
    expect(config.afterPack).toBe("scripts/prune-onnx-runtime.mjs");
  });

  it("copies a physical runtime icon independently of installer icons", () => {
    expect(config.extraResources).toContainEqual({ from: "build/icon.png", to: "icon.png" });
  });
});
