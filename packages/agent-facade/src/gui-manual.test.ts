/**
 * Content integrity and version binding for the shipped GUI manual
 * (gui-manual.ts). The manual is data the help.* verbs serve verbatim, so
 * these checks are the "build validation" for the content: required fields,
 * bilingual completeness, valid shortcut references (id shape — the id
 * EXISTENCE half is validated against the web shortcut registry by
 * apps/web/src/gui-manual/gui-manual.test.ts), the effects screen's closed
 * set coupled to the engine's EFFECT_DEFINITIONS, honest screenshot handling,
 * and the app-version binding.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FacadeError } from "./errors";
import { EFFECT_DEFINITIONS } from "@reelterminal/core/types/effects";
import {
  GUI_MANUAL_APP_VERSION,
  GUI_MANUAL_CONTENT_VERSION,
  GUI_MANUAL_LANGUAGES,
  GUI_MANUAL_SCREENS,
  describeManualScreen,
  listManualScreens,
  searchManualScreens,
} from "./gui-manual";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

describe("GUI manual version binding", () => {
  it("content version is a semantic version string", () => {
    expect(GUI_MANUAL_CONTENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("pins the current content version (bump alongside real content changes)", () => {
    // 1.2.0 = CLI-first access and task-history guidance on top of 1.1.0.
    expect(GUI_MANUAL_CONTENT_VERSION).toBe("1.2.0");
  });

  it("binds to the desktop application version, not the facade version", () => {
    // The desktop package.json is the app-version source the live endpoint
    // already advertises (app.getVersion()); the manual must mirror it.
    const desktopPackage = JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, "apps", "desktop", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(GUI_MANUAL_APP_VERSION).toBe(desktopPackage.version);
  });

  it("declares exactly the zh/en language pair", () => {
    expect([...GUI_MANUAL_LANGUAGES]).toEqual(["zh", "en"]);
  });
});

describe("GUI manual content integrity", () => {
  it("covers the acceptance screens (rename, mute, work assets, presets, voiceover)", () => {
    const ids = GUI_MANUAL_SCREENS.map((screen) => screen.id);
    expect(ids).toContain("media-panel");
    expect(ids).toContain("track-headers");
    expect(ids).toContain("work-assets");
    expect(ids).toContain("text-presets");
    expect(ids).toContain("effects-transitions");
    expect(ids).toContain("voiceover-music-tasks");
  });

  it("has unique, kebab-case screen ids", () => {
    const ids = GUI_MANUAL_SCREENS.map((screen) => screen.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("carries the required fields on every screen, bilingual and non-empty", () => {
    const localizedComplete = (text: unknown): boolean => {
      const pair = text as { zh?: string; en?: string };
      return (
        typeof pair?.zh === "string" &&
        pair.zh.trim().length > 0 &&
        typeof pair.en === "string" &&
        pair.en.trim().length > 0
      );
    };
    for (const screen of GUI_MANUAL_SCREENS) {
      expect(localizedComplete(screen.title), `${screen.id}.title`).toBe(true);
      expect(localizedComplete(screen.summary), `${screen.id}.summary`).toBe(true);
      expect(screen.entry.length, `${screen.id}.entry`).toBeGreaterThan(0);
      for (const step of screen.entry) {
        expect(localizedComplete(step), `${screen.id}.entry`).toBe(true);
      }
      for (const step of screen.steps ?? []) {
        expect(localizedComplete(step), `${screen.id}.steps`).toBe(true);
      }
      for (const limitation of screen.limitations ?? []) {
        expect(localizedComplete(limitation), `${screen.id}.limitations`).toBe(true);
      }
      if (screen.visibility) {
        expect(localizedComplete(screen.visibility), `${screen.id}.visibility`).toBe(true);
      }
    }
  });

  it("keeps shortcut references as non-empty registry-shaped ids (never key bindings)", () => {
    for (const screen of GUI_MANUAL_SCREENS) {
      for (const id of screen.shortcutIds ?? []) {
        // Registry ids are dot-namespaced actions like "timeline.zoomIn".
        expect(id, `${screen.id} shortcut id`).toMatch(/^[a-z]+\.[a-zA-Z0-9]+$/);
        // A copied key binding (e.g. "cmd+z") must never appear as a reference.
        expect(id.toLowerCase()).not.toContain("cmd+");
        expect(id.toLowerCase()).not.toContain("ctrl+");
      }
    }
  });

  it("delivers exactly the captured screens as PNG data URLs, others stay absent", () => {
    // The delivered set is pinned: only screens with a REAL capture (V5 build
    // b7fa4a3 evidence) may claim one — adding an id here without an asset in
    // gui-manual-screenshots.ts (or vice versa) fails this test.
    const deliveredIds = [
      "keyboard-shortcuts",
      "timeline",
      "work-assets",
      "export",
    ];
    const dataUrlPrefix = "data:image/png;base64,";
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let totalBytes = 0;
    for (const screen of GUI_MANUAL_SCREENS) {
      if (deliveredIds.includes(screen.id)) {
        const screenshot = screen.screenshot;
        expect(screenshot, `${screen.id} screenshot`).toBeDefined();
        expect(screenshot!.startsWith(dataUrlPrefix), `${screen.id} is a PNG data URL`).toBe(true);
        const bytes = Buffer.from(screenshot!.slice(dataUrlPrefix.length), "base64");
        expect(bytes.subarray(0, 8).equals(pngMagic), `${screen.id} decodes to a PNG`).toBe(true);
        expect(bytes.length, `${screen.id} payload is a real image`).toBeGreaterThan(10 * 1024);
        totalBytes += screenshot!.length;
      } else {
        expect(screen.screenshot, `${screen.id} stays honestly absent`).toBeUndefined();
      }
    }
    // The delivery must stay within the data-URL budget this form was chosen
    // for (self-contained MCP payloads): 1MB across all screens.
    expect(totalBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(deliveredIds).toHaveLength(4);
  });

  it("documents honest limitations on the screens that need them", () => {
    const byId = new Map(GUI_MANUAL_SCREENS.map((screen) => [screen.id, screen]));
    // The voiceover screen must NOT promise generation capability.
    expect(byId.get("voiceover-music-tasks")?.limitations?.length ?? 0).toBeGreaterThan(0);
    // Effect presets must state the closed engine set, keyed to the REAL
    // EFFECT_DEFINITIONS (core presets/validate.ts validates saved presets
    // against it), so the copy cannot drift from the engine set again.
    const effectsLimitations = JSON.stringify(byId.get("effects-transitions")?.limitations ?? []);
    const effectTypes = EFFECT_DEFINITIONS.map((definition) => definition.type);
    expect(effectTypes.length).toBeGreaterThan(0);
    for (const type of effectTypes) {
      expect(effectsLimitations, `effect type "${type}"`).toContain(type);
    }
    // The en limitation enumerates exactly the engine types, in set order…
    expect(effectsLimitations).toContain(effectTypes.join(", "));
    // …the stated count in both languages equals the live set size…
    expect(effectsLimitations).toContain(`共 ${effectTypes.length} 类`);
    expect(effectsLimitations).toContain(`a closed set of ${effectTypes.length} engine types`);
    // …and the unrelated VIDEO_FILTER_TYPES vocabulary stays out. The
    // chroma-key/shader mentions are NOT stale: the limitation names them
    // explicitly as the two stack features that cannot be saved as presets
    // (chromaKey is clip-level keying, shader params depend on the chosen
    // shader), and sharpen/锐化 are engine types since the contract was
    // extended to the GUI effect stack's serammable 8.
    for (const stale of ["lut", "colorWheels", "color wheel", "hsl", "遮罩", "色彩轮"]) {
      expect(effectsLimitations.toLowerCase()).not.toContain(stale);
    }
    expect(effectsLimitations.toLowerCase()).toContain("chroma key lives in");
    expect(effectsLimitations).toContain("取决于所选 shader");
  });
});

describe("listManualScreens", () => {
  it("returns the full restrained index", () => {
    const result = listManualScreens();
    expect(result.total).toBe(GUI_MANUAL_SCREENS.length);
    expect(result.screens).toHaveLength(GUI_MANUAL_SCREENS.length);
    expect(result.manual.contentVersion).toBe(GUI_MANUAL_CONTENT_VERSION);
    expect(result.manual.appVersion).toBe(GUI_MANUAL_APP_VERSION);
    expect(result.manual.screenshots).toBe("delivered");
    for (const item of result.screens) {
      expect(item.hasScreenshot).toBe(
        ["keyboard-shortcuts", "timeline", "work-assets", "export"].includes(item.id),
      );
      // Index payload stays restrained: identity + one-liners only, never
      // the page body fields.
      expect(Object.keys(item).sort()).toEqual(["hasScreenshot", "id", "summary", "title"]);
    }
  });
});

describe("describeManualScreen", () => {
  it("returns one full page for a known id", () => {
    const result = describeManualScreen("timeline");
    expect(result.screen.id).toBe("timeline");
    expect(result.screen.entry.length).toBeGreaterThan(0);
    expect(result.screen.shortcutIds).toContain("timeline.fitTimeline");
    expect(result.screenshotStatus).toBe("available");
  });

  it("reports a screen without a delivered screenshot as pending", () => {
    // "inspector" was NOT captured (the delivered evidence frame shows the
    // work-assets tab with an empty inspector), so it must stay pending.
    const result = describeManualScreen("inspector");
    expect(result.screen.id).toBe("inspector");
    expect(result.screen.screenshot).toBeUndefined();
    expect(result.screenshotStatus).toBe("pending");
  });

  it("fails INVALID_PARAMS with an index pointer for an unknown id", () => {
    try {
      describeManualScreen("does-not-exist");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FacadeError);
      const facadeError = error as FacadeError;
      expect(facadeError.code).toBe("INVALID_PARAMS");
      expect(facadeError.message).toContain("help.list_screens");
    }
  });
});

describe("searchManualScreens", () => {
  it("matches zh keywords", () => {
    const result = searchManualScreens("静音");
    expect(result.total).toBeGreaterThan(0);
    expect(result.hits.map((hit) => hit.id)).toContain("track-headers");
  });

  it("matches en keywords case-insensitively", () => {
    const result = searchManualScreens("RENAME");
    expect(result.total).toBeGreaterThan(0);
    expect(result.hits.map((hit) => hit.id)).toContain("project-switcher");
    expect(result.hits.map((hit) => hit.id)).toContain("media-panel");
  });

  it("matches shortcut ids and explicit keywords", () => {
    expect(searchManualScreens("timeline.fitTimeline").hits.map((hit) => hit.id)).toContain("timeline");
    expect(searchManualScreens("missingSource").hits.map((hit) => hit.id)).toContain("work-assets");
  });

  it("answers zero hits honestly and never returns page bodies", () => {
    const result = searchManualScreens("xyzzy-no-such-thing");
    expect(result.total).toBe(0);
    expect(result.hits).toEqual([]);
    for (const hit of searchManualScreens("配音").hits) {
      expect(Object.keys(hit).sort()).toEqual(["id", "summary", "title"]);
    }
  });
});
