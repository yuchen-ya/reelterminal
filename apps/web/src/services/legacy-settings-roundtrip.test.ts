/** Verify persisted settings are rehydrated and saved under their registered keys. */
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
    // Seed the supported theme storage key.
    localStorage.setItem(
      LEGACY_LS_THEME,
      JSON.stringify({ state: { mode: "dark", isDark: true }, version: 0 }),
    );

    // The store reads the persisted value during initialization.
    const { useThemeStore } = await import("../stores/theme-store");
    expect(useThemeStore.getState().mode).toBe("dark");

    // Setting changes are saved under the same persisted key.
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
