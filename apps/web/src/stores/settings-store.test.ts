import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoSaveManager } from "../services/auto-save";
import { LEGACY_LS_SETTINGS } from "../services/legacy-storage-keys";
import { useSettingsStore } from "./settings-store";

describe("auto-save settings", () => {
  const initial = useSettingsStore.getState();

  afterEach(() => {
    initial.setAutoSave(initial.autoSave);
    initial.setAutoSaveInterval(initial.autoSaveInterval);
    initial.setCloseRetention(initial.closeRetention);
  });

  it("updates runtime enablement immediately", () => {
    useSettingsStore.getState().setAutoSave(false);
    expect(autoSaveManager.getConfig().enabled).toBe(false);

    useSettingsStore.getState().setAutoSave(true);
    expect(autoSaveManager.getConfig().enabled).toBe(true);
  });

  it("converts the selected minute interval into scheduler milliseconds", () => {
    useSettingsStore.getState().setAutoSaveInterval(10);
    expect(autoSaveManager.getConfig().interval).toBe(10 * 60_000);
  });
});

describe("close-retention preference", () => {
  const initial = useSettingsStore.getState();

  afterEach(() => {
    initial.setCloseRetention(initial.closeRetention);
  });

  it("defaults to asking on every close", () => {
    expect(useSettingsStore.getState().closeRetention).toBe("ask");
  });

  it("persists the chosen preference to localStorage", () => {
    useSettingsStore.getState().setCloseRetention("skip");
    expect(useSettingsStore.getState().closeRetention).toBe("skip");

    const persisted = JSON.parse(
      window.localStorage.getItem(LEGACY_LS_SETTINGS) ?? "{}",
    );
    expect(persisted.state.closeRetention).toBe("skip");
    expect(persisted.version).toBe(4);
  });
});

describe("settings persistence migration", () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  async function importFreshStore(): Promise<
    typeof import("./settings-store")
  > {
    return await import("./settings-store");
  }

  it("migrates a v3 payload to the default ask preference (v3 → v4)", async () => {
    window.localStorage.setItem(
      LEGACY_LS_SETTINGS,
      JSON.stringify({
        state: { autoSave: false, autoSaveInterval: 2, language: "zh-CN" },
        version: 3,
      }),
    );

    const { useSettingsStore: freshStore } = await importFreshStore();

    expect(freshStore.getState().closeRetention).toBe("ask");
    expect(freshStore.getState().autoSave).toBe(false);
    expect(freshStore.getState().language).toBe("zh-CN");
  });

  it("keeps a persisted v4 preference instead of resetting it", async () => {
    window.localStorage.setItem(
      LEGACY_LS_SETTINGS,
      JSON.stringify({
        state: {
          autoSave: true,
          autoSaveInterval: 5,
          language: "en",
          closeRetention: "retain",
        },
        version: 4,
      }),
    );

    const { useSettingsStore: freshStore } = await importFreshStore();

    expect(freshStore.getState().closeRetention).toBe("retain");
  });
});
