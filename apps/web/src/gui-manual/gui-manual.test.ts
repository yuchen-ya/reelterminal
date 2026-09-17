/**
 * Web-side manual bridge tests: the join between the shipped manual's
 * shortcut REFERENCES and the live shortcut registry. The registry is the
 * single source of key bindings (user-remappable), so every id the manual
 * references must exist there — a stale reference is a content bug this
 * test catches. The facade-side content checks live in
 * packages/agent-facade/src/gui-manual.test.ts.
 */
import { describe, expect, it } from "vitest";
import { keyboardShortcuts } from "../services/keyboard-shortcuts";
import {
  GUI_MANUAL_SCREENS,
  UnknownManualScreenError,
  describeManualScreenWithShortcuts,
  manualCapability,
  resolveManualShortcuts,
  searchManualScreens,
} from "./index";

describe("manual shortcut references resolve against the live registry", () => {
  it("every referenced id exists in the shortcut registry", () => {
    const registryIds = new Set(
      keyboardShortcuts.getAllShortcuts().map((definition) => definition.id),
    );
    for (const screen of GUI_MANUAL_SCREENS) {
      for (const id of screen.shortcutIds ?? []) {
        expect(registryIds.has(id), `${screen.id} references "${id}"`).toBe(true);
      }
    }
  });

  it("resolves name and platform-formatted key for a known screen", () => {
    const shortcuts = resolveManualShortcuts("timeline");
    const fit = shortcuts.find((shortcut) => shortcut.id === "timeline.fitTimeline");
    expect(fit).toBeDefined();
    expect(fit?.name).toBe("Fit Timeline");
    expect(fit?.key.length).toBeGreaterThan(0);
    expect(fit?.category).toBe("timeline");
  });

  it("throws for a screen id that is not in the manual", () => {
    expect(() => resolveManualShortcuts("not-a-screen")).toThrow(
      UnknownManualScreenError,
    );
  });
});

describe("describeManualScreenWithShortcuts", () => {
  it("joins the page body with resolved bindings", () => {
    const { screen, shortcuts } = describeManualScreenWithShortcuts("action-history");
    expect(screen.id).toBe("action-history");
    expect(screen.shortcutIds).toContain("editing.undo");
    expect(shortcuts.map((shortcut) => shortcut.id)).toContain("editing.undo");
    const undo = shortcuts.find((shortcut) => shortcut.id === "editing.undo");
    expect(undo?.name).toBe("Undo");
  });
});

describe("web bridge surface", () => {
  it("reports the manual capability with the shipped screens", () => {
    const capability = manualCapability();
    expect(capability.available).toBe(true);
    expect(capability.screenCount).toBe(GUI_MANUAL_SCREENS.length);
    expect(capability.screenshots).toBe("reserved-not-delivered");
    expect(capability.languages).toEqual(["zh", "en"]);
  });

  it("serves the acceptance queries (rename/mute/work assets/presets/voiceover)", () => {
    const query = (keyword: string) =>
      searchManualScreens(keyword).hits.map((hit) => hit.id);
    expect(query("改名")).toContain("media-panel");
    expect(query("rename")).toContain("media-panel");
    expect(query("静音")).toContain("track-headers");
    expect(query("捕捉")).toContain("work-assets");
    expect(query("preset")).toContain("text-presets");
    expect(query("配音")).toContain("voiceover-music-tasks");
  });
});
