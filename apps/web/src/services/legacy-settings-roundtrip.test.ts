/**
 * Legacy-identifier regression fixtures (N04) — localStorage part.
 *
 * WHAT THIS IS: proof that settings written under the LEGACY localStorage
 * keys (see packages/core/src/legacy/physical-identifiers.ts) are still
 * rehydrated by the current code and keep being written back under the SAME
 * legacy keys — settings survive the branding migration because the physical
 * keys were kept, not migrated.
 *
 * WHAT THIS IS NOT: NOT a data-migration test. No migration exists in this
 * round (docs/NAMING-AND-COMPATIBILITY.md §4).
 *
 * jsdom environment: provides localStorage and `document` for the zustand
 * persist stores. Modules are re-imported with a reset registry so each test
 * observes a fresh "app start" (persist rehydration reads localStorage then).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_LS_LOCALE,
  LEGACY_LS_SHORTCUT_PRESET,
  LEGACY_LS_SHORTCUTS,
  LEGACY_LS_SETTINGS,
  LEGACY_LS_THEME,
} from "./legacy-storage-keys";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe("legacy localStorage keys survive a settings round trip", () => {
  it("theme store rehydrates a legacy payload and writes back under the same key", async () => {
    // Legacy install wrote its settings under the legacy persist name.
    localStorage.setItem(
      LEGACY_LS_THEME,
      JSON.stringify({ state: { mode: "dark", isDark: true }, version: 0 }),
    );

    // Current app reopens: zustand persist must rehydrate from the legacy key.
    const { useThemeStore } = await import("../stores/theme-store");
    expect(useThemeStore.getState().mode).toBe("dark");

    // User changes a setting; the store saves back under the SAME legacy key
    // (no migration, no rebranding of the physical key).
    useThemeStore.getState().setMode("light");
    const saved = localStorage.getItem(LEGACY_LS_THEME);
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!).state.mode).toBe("light");
  });

  it("keyboard shortcut customizations and preset selection round-trip", async () => {
    localStorage.setItem(
      LEGACY_LS_SHORTCUTS,
      JSON.stringify({ "editing.split": "ctrl+shift+s" }),
    );
    localStorage.setItem(LEGACY_LS_SHORTCUT_PRESET, "davinci");

    const { keyboardShortcuts } = await import("./keyboard-shortcuts");
    expect(keyboardShortcuts.getShortcut("editing.split")?.currentKey).toBe(
      "ctrl+shift+s",
    );
    expect(keyboardShortcuts.getActivePreset()).toBe("davinci");
  });

  it("locale preference seeded under the legacy key is picked up", async () => {
    localStorage.setItem(LEGACY_LS_LOCALE, "zh-CN");
    const { getInitialLanguagePreference } = await import("../i18n/index");
    expect(getInitialLanguagePreference()).toBe("zh-CN");
  });

  it("settings round trip introduces no new (reelterminal-named) localStorage keys", async () => {
    const legacyKeys = [
      LEGACY_LS_SETTINGS,
      LEGACY_LS_THEME,
      LEGACY_LS_LOCALE,
      LEGACY_LS_SHORTCUTS,
      LEGACY_LS_SHORTCUT_PRESET,
    ];
    legacyKeys.forEach((key, i) => localStorage.setItem(key, `legacy-value-${i}`));

    const { useThemeStore } = await import("../stores/theme-store");
    useThemeStore.getState().setMode("dark");

    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      keys.push(localStorage.key(i)!);
    }
    expect(keys).toEqual(expect.arrayContaining(legacyKeys));
    for (const key of keys) {
      expect(key.startsWith("openreel")).toBe(true);
      expect(key.startsWith("reelterminal")).toBe(false);
    }
  });
});
