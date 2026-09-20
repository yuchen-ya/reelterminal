/**
 * Unit tests for the browser-entry resolution policy in bundle.ts:
 *   - packaged installs serve the build-time pre-bundle advertised via
 *     REELTERMINAL_BROWSER_ENTRY_BUNDLE (the runtime esbuild build cannot work
 *     there — the spawned esbuild.exe cannot read TS sources inside asar),
 *   - dev checkouts fall through to the TS source candidates unchanged,
 *   - a missing pre-bundle / missing env keeps the original resolution error.
 * The fs-touching pieces are injected so no esbuild/browser machinery runs
 * here; one end-to-end test exercises the real fs path + cache via
 * buildBrowserEntry().
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildBrowserEntry,
  loadPrebundledBrowserEntry,
  resolveBrowserEntry,
} from "./bundle";

describe("loadPrebundledBrowserEntry", () => {
  it("reads the artifact text when the env var points at an existing file", () => {
    expect(
      loadPrebundledBrowserEntry({
        env: { REELTERMINAL_BROWSER_ENTRY_BUNDLE: "D:/app/app.asar/dist/browser-entry.mjs" },
        fileExists: () => true,
        readText: (p) => `TEXT-OF:${p}`,
      }),
    ).toBe("TEXT-OF:D:/app/app.asar/dist/browser-entry.mjs");
  });

  it("still honors the legacy OPENREEL_BROWSER_ENTRY_BUNDLE name as a fallback", () => {
    expect(
      loadPrebundledBrowserEntry({
        env: { OPENREEL_BROWSER_ENTRY_BUNDLE: "D:/app/app.asar/dist/browser-entry.mjs" },
        fileExists: () => true,
        readText: (p) => `TEXT-OF:${p}`,
      }),
    ).toBe("TEXT-OF:D:/app/app.asar/dist/browser-entry.mjs");
  });

  it("prefers the new name when both env names are set", () => {
    expect(
      loadPrebundledBrowserEntry({
        env: {
          REELTERMINAL_BROWSER_ENTRY_BUNDLE: "D:/new/browser-entry.mjs",
          OPENREEL_BROWSER_ENTRY_BUNDLE: "D:/legacy/browser-entry.mjs",
        },
        fileExists: () => true,
        readText: (p) => `TEXT-OF:${p}`,
      }),
    ).toBe("TEXT-OF:D:/new/browser-entry.mjs");
  });

  it("returns undefined when the env var is unset (dev checkout)", () => {
    expect(loadPrebundledBrowserEntry({ env: {} })).toBeUndefined();
  });

  it("returns undefined when the env var points at a missing file", () => {
    expect(
      loadPrebundledBrowserEntry({
        env: { REELTERMINAL_BROWSER_ENTRY_BUNDLE: "D:/app/app.asar/dist/browser-entry.mjs" },
        fileExists: () => false,
        readText: () => {
          throw new Error("must not be read");
        },
      }),
    ).toBeUndefined();
  });
});

describe("resolveBrowserEntry", () => {
  it("serves the pre-bundle even when no TS source candidate exists (packaged)", () => {
    // The packaged discriminator: source candidates all fail, yet the
    // advertised pre-bundle wins — resolution never reaches the candidates.
    const resolved = resolveBrowserEntry({
      env: { REELTERMINAL_BROWSER_ENTRY_BUNDLE: "<resources>/app.asar/dist/browser-entry.mjs" },
      fileExists: () => true,
      readText: () => "PREBUNDLED-MARKER",
      sourceExists: () => false,
    });
    expect(resolved).toEqual({ kind: "prebundled", text: "PREBUNDLED-MARKER" });
  });

  it("falls through to the source candidates when the env var is unset", () => {
    const resolved = resolveBrowserEntry({
      env: {},
      sourceExists: (candidate) =>
        candidate.endsWith(path.join("browser", "entry.ts")) ||
        candidate.endsWith(path.join("browser", "extract-audio-shim.ts")),
    });
    expect(resolved.kind).toBe("source");
    if (resolved.kind === "source") {
      expect(resolved.entry.endsWith(path.join("browser", "entry.ts"))).toBe(true);
      expect(
        resolved.extractAudioShim.endsWith(path.join("browser", "extract-audio-shim.ts")),
      ).toBe(true);
    }
  });

  it("falls through to the source candidates when the advertised file is missing", () => {
    const resolved = resolveBrowserEntry({
      env: { REELTERMINAL_BROWSER_ENTRY_BUNDLE: "<resources>/app.asar/dist/browser-entry.mjs" },
      fileExists: () => false,
      sourceExists: (candidate) =>
        candidate.endsWith(path.join("browser", "entry.ts")) ||
        candidate.endsWith(path.join("browser", "extract-audio-shim.ts")),
    });
    expect(resolved.kind).toBe("source");
  });

  it("keeps the original error when there is no pre-bundle and no source candidates", () => {
    expect(() =>
      resolveBrowserEntry({
        env: {},
        sourceExists: () => false,
      }),
    ).toThrowError(/cannot locate the browser entry source entry\.ts/);
  });
});

describe("buildBrowserEntry (real fs, cache semantics)", () => {
  it("serves the advertised pre-bundle file as-is instead of invoking esbuild", async () => {
    // A real temp file proves the whole chain — default existsSync +
    // readFileSync utf8 — and, because this checkout HAS the TS sources, that
    // the pre-bundle takes priority over a successful source resolution.
    const dir = mkdtempSync(path.join(tmpdir(), "reelterminal-prebundle-"));
    const artifact = path.join(dir, "browser-entry.mjs");
    writeFileSync(artifact, "OPENREEL-F02-R3-PREBUNDLE-MARKER");
    const previous = process.env.REELTERMINAL_BROWSER_ENTRY_BUNDLE;
    process.env.REELTERMINAL_BROWSER_ENTRY_BUNDLE = artifact;
    try {
      await expect(buildBrowserEntry()).resolves.toBe(
        "OPENREEL-F02-R3-PREBUNDLE-MARKER",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.REELTERMINAL_BROWSER_ENTRY_BUNDLE;
      } else {
        process.env.REELTERMINAL_BROWSER_ENTRY_BUNDLE = previous;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
