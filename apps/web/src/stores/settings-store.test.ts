import { afterEach, describe, expect, it } from "vitest";
import { autoSaveManager } from "../services/auto-save";
import { useSettingsStore } from "./settings-store";

describe("auto-save settings", () => {
  const initial = useSettingsStore.getState();

  afterEach(() => {
    initial.setAutoSave(initial.autoSave);
    initial.setAutoSaveInterval(initial.autoSaveInterval);
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
