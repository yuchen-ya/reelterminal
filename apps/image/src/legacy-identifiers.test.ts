/**
 * Drift protection for apps/image legacy persisted identifiers (N04).
 *
 * apps/image does not depend on @reelterminal/core, so it cannot import the
 * central legacy registry; its identifiers are pinned here by reading the
 * owning source files (same pattern as the plain-JS service-worker pinning
 * in packages/core/src/legacy/physical-identifiers.test.ts). These values
 * are persisted user data (autosave blobs, color palettes, PWA cache) —
 * docs/NAMING-AND-COMPATIBILITY.md §4 "持久化保留为 legacy". If this test
 * fails, a value was renamed instead of kept frozen: restore it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readSrc(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("apps/image legacy identifier drift protection (N04)", () => {
  it("autosave localStorage prefix keeps its historical literal", () => {
    const src = readSrc("src/hooks/useAutoSave.ts");
    expect(src).toContain("const STORAGE_KEY_PREFIX = 'openreel-image-project-'");
  });

  it("color palette persist name keeps its historical literal", () => {
    const src = readSrc("src/stores/color-store.ts");
    expect(src).toContain("const LEGACY_LS_IMAGE_COLORS = 'openreel-image-colors'");
    expect(src).toContain("name: LEGACY_LS_IMAGE_COLORS");
  });

  it("service worker cache name keeps its historical literal", () => {
    const sw = readSrc("public/sw.js");
    expect(sw).toContain("const CACHE_NAME = 'openreel-image-v1'");
  });
});
