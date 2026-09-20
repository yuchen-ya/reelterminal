import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  installPackagedEsbuildBinaryPath,
  packagedBrowserEntryBundlePath,
  packagedEsbuildBinaryPath,
} from "./esbuild-binary-path";

// The module under test self-installs at import time; in a unit-test (plain
// node) process there is no resourcesPath, so that side effect must be a
// no-op and must not have leaked into the real environment.
describe("esbuild binary path install (module side effect)", () => {
  it("leaves process.env untouched when running under plain node", () => {
    expect(process.env.ESBUILD_BINARY_PATH).toBeUndefined();
    expect(process.env.REELTERMINAL_BROWSER_ENTRY_BUNDLE).toBeUndefined();
  });
});

describe("packagedEsbuildBinaryPath", () => {
  const resourcesPath = path.join("C:", "apps", "ReelTerminal", "resources");

  function packagedContext(overrides: Record<string, unknown> = {}) {
    return {
      resourcesPath,
      platform: "win32",
      arch: "x64",
      env: {} as NodeJS.ProcessEnv,
      fileExists: (candidate: string) =>
        candidate === path.join(resourcesPath, "app.asar") ||
        candidate === path.join(
          resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "@esbuild",
          "win32-x64",
          "esbuild.exe",
        ),
      ...overrides,
    } as Parameters<typeof packagedEsbuildBinaryPath>[0];
  }

  it("points at the smartUnpacked binary in a packaged win32 install", () => {
    expect(packagedEsbuildBinaryPath(packagedContext())).toBe(
      path.join(
        resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "@esbuild",
        "win32-x64",
        "esbuild.exe",
      ),
    );
  });

  it("names the platform-specific binary on non-windows platforms", () => {
    const context = packagedContext({
      platform: "linux",
      arch: "x64",
      fileExists: (candidate: string) =>
        candidate === path.join(resourcesPath, "app.asar") ||
        candidate === path.join(
          resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "@esbuild",
          "linux-x64",
          "esbuild",
        ),
    });
    expect(packagedEsbuildBinaryPath(context)).toBe(
      path.join(
        resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "@esbuild",
        "linux-x64",
        "esbuild",
      ),
    );
  });

  it("stays undefined when the unpacked binary is missing", () => {
    // Only app.asar exists: packaged, but electron-builder never unpacked the
    // binary (or it was stripped). Leaving the env var unset keeps esbuild's
    // own resolution in charge instead of pointing at a nonexistent file.
    expect(
      packagedEsbuildBinaryPath(
        packagedContext({ fileExists: (candidate: string) => candidate === path.join(resourcesPath, "app.asar") }),
      ),
    ).toBeUndefined();
  });

  it("treats a dev run (no app.asar under resourcesPath) as unpackaged", () => {
    const devResources = path.join(
      "E:",
      "repo",
      "node_modules",
      "electron",
      "dist",
      "resources",
    );
    const devAppAsar = path.join(devResources, "app.asar");
    expect(
      packagedEsbuildBinaryPath(
        packagedContext({
          resourcesPath: devResources,
          // Permissive probe: every file "exists" except the packaged
          // app.asar marker — modelling dev electron's resources dir, which
          // only holds default_app.asar.
          fileExists: (candidate: string) => candidate !== devAppAsar,
        }),
      ),
    ).toBeUndefined();
  });

  it("short-circuits when resourcesPath is unavailable (plain node)", () => {
    expect(
      packagedEsbuildBinaryPath(packagedContext({ resourcesPath: undefined })),
    ).toBeUndefined();
  });
});

describe("installPackagedEsbuildBinaryPath", () => {
  const resourcesPath = path.join("C:", "apps", "ReelTerminal", "resources");
  const unpackedBinary = path.join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@esbuild",
    "win32-x64",
    "esbuild.exe",
  );
  const prebundledEntry = path.join(
    resourcesPath,
    "app.asar",
    "dist",
    "browser-entry.mjs",
  );

  function context(overrides: Record<string, unknown> = {}) {
    return {
      resourcesPath,
      platform: "win32",
      arch: "x64",
      env: {} as NodeJS.ProcessEnv,
      fileExists: (candidate: string) =>
        candidate === path.join(resourcesPath, "app.asar") ||
        candidate === unpackedBinary ||
        candidate === prebundledEntry,
      ...overrides,
    } as Parameters<typeof installPackagedEsbuildBinaryPath>[0];
  }

  it("sets ESBUILD_BINARY_PATH and REELTERMINAL_BROWSER_ENTRY_BUNDLE on the given env when packaged", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(installPackagedEsbuildBinaryPath(context({ env }))).toBe(true);
    expect(env.ESBUILD_BINARY_PATH).toBe(unpackedBinary);
    expect(env.REELTERMINAL_BROWSER_ENTRY_BUNDLE).toBe(prebundledEntry);
  });

  it("does not set the env vars when unpackaged or binary missing", () => {
    const devEnv = {} as NodeJS.ProcessEnv;
    expect(
      installPackagedEsbuildBinaryPath(
        context({ env: devEnv, resourcesPath: undefined }),
      ),
    ).toBe(false);
    expect(devEnv.ESBUILD_BINARY_PATH).toBeUndefined();
    expect(devEnv.REELTERMINAL_BROWSER_ENTRY_BUNDLE).toBeUndefined();

    const missingEnv = {} as NodeJS.ProcessEnv;
    expect(
      installPackagedEsbuildBinaryPath(
        context({
          env: missingEnv,
          fileExists: (candidate: string) => candidate === path.join(resourcesPath, "app.asar"),
        }),
      ),
    ).toBe(false);
    expect(missingEnv.ESBUILD_BINARY_PATH).toBeUndefined();
    expect(missingEnv.REELTERMINAL_BROWSER_ENTRY_BUNDLE).toBeUndefined();
  });
});

describe("packagedBrowserEntryBundlePath", () => {
  const resourcesPath = path.join("C:", "apps", "ReelTerminal", "resources");
  const prebundledEntry = path.join(
    resourcesPath,
    "app.asar",
    "dist",
    "browser-entry.mjs",
  );

  function context(overrides: Record<string, unknown> = {}) {
    return {
      resourcesPath,
      env: {} as NodeJS.ProcessEnv,
      fileExists: (candidate: string) =>
        candidate === path.join(resourcesPath, "app.asar") ||
        candidate === prebundledEntry,
      ...overrides,
    } as Parameters<typeof packagedBrowserEntryBundlePath>[0];
  }

  it("points at dist/browser-entry.mjs inside app.asar when packaged", () => {
    expect(packagedBrowserEntryBundlePath(context())).toBe(prebundledEntry);
  });

  it("stays undefined when the pre-bundle is missing from the asar", () => {
    // Packaged, but built by an older build without the pre-bundle step:
    // leaving the env var unset keeps bundle.ts's own source resolution in
    // charge (which will fail with its own clear error) instead of pointing
    // at a nonexistent file.
    expect(
      packagedBrowserEntryBundlePath(
        context({
          fileExists: (candidate: string) => candidate === path.join(resourcesPath, "app.asar"),
        }),
      ),
    ).toBeUndefined();
  });

  it("treats a dev run (no app.asar under resourcesPath) as unpackaged", () => {
    const devResources = path.join(
      "E:",
      "repo",
      "node_modules",
      "electron",
      "dist",
      "resources",
    );
    const devAppAsar = path.join(devResources, "app.asar");
    expect(
      packagedBrowserEntryBundlePath(
        context({
          resourcesPath: devResources,
          // Permissive probe EXCEPT the packaged marker: dev electron's
          // resources dir only holds default_app.asar.
          fileExists: (candidate: string) => candidate !== devAppAsar,
        }),
      ),
    ).toBeUndefined();
  });

  it("short-circuits when resourcesPath is unavailable (plain node)", () => {
    expect(
      packagedBrowserEntryBundlePath(context({ resourcesPath: undefined })),
    ).toBeUndefined();
  });
});
