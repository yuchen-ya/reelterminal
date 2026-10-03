/**
 * Persisted identifier tests for apps/image.
 *
 * apps/image does not depend on @reelterminal/core, so it cannot import the
 * central legacy registry; its identifiers are pinned here by reading the
 * owning source files (same pattern as the plain-JS service-worker pinning
 * in packages/core/src/legacy/physical-identifiers.test.ts). These values
 * are persisted user data (autosave blobs, color palettes, and the PWA cache).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readSrc(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("apps/image persisted identifiers", () => {
  it("uses the registered autosave localStorage prefix", () => {
    const src = readSrc("src/hooks/useAutoSave.ts");
    expect(src).toContain("const STORAGE_KEY_PREFIX = 'openreel-image-project-'");
  });

  it("uses the registered color palette storage name", () => {
    const src = readSrc("src/stores/color-store.ts");
    expect(src).toContain("const LEGACY_LS_IMAGE_COLORS = 'openreel-image-colors'");
    expect(src).toContain("name: LEGACY_LS_IMAGE_COLORS");
  });

  it("uses the registered service worker cache name", () => {
    const sw = readSrc("public/sw.js");
    expect(sw).toContain("const CACHE_NAME = 'openreel-image-v1'");
  });
});
