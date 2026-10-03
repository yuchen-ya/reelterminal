import { create } from "zustand";
import { subscribeWithSelector, persist } from "zustand/middleware";
import { LEGACY_LS_SETTINGS } from "../services/legacy-storage-keys";
import {
  changeAppLanguage,
  getInitialLanguagePreference,
  type LanguagePreference,
} from "../i18n";
import { autoSaveManager } from "../services/auto-save";

export type SettingsTab = "general" | "storage";

export interface SettingsState {
  // General preferences
  autoSave: boolean;
  autoSaveInterval: number;
  language: LanguagePreference;

  // Settings dialog state
  settingsOpen: boolean;
  settingsTab: SettingsTab;

  // Actions
  setAutoSave: (enabled: boolean) => void;
  setAutoSaveInterval: (minutes: number) => void;
  setLanguage: (lang: LanguagePreference) => void;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        autoSave: true,
        autoSaveInterval: 5,
        language: getInitialLanguagePreference(),

        settingsOpen: false,
        settingsTab: "general" as SettingsTab,

        setAutoSave: (enabled: boolean) => set({ autoSave: enabled }),

        setAutoSaveInterval: (minutes: number) =>
          set({
            autoSaveInterval: Number.isFinite(minutes)
              ? Math.max(1, Math.min(30, minutes))
              : get().autoSaveInterval,
          }),

        setLanguage: (language: LanguagePreference) => {
          set({ language });
          void changeAppLanguage(language);
        },

        openSettings: (tab?: SettingsTab) =>
          set({
            settingsOpen: true,
            settingsTab: tab ?? get().settingsTab,
          }),

        closeSettings: () => set({ settingsOpen: false }),
      }),
      {
        // Persisted storage identifier for user settings.
        name: LEGACY_LS_SETTINGS,
        version: 3,
        migrate: (persisted, version) => {
          const next = (persisted ?? {}) as Record<string, unknown>;
          // The old language field was never connected to a selector. Treat
          // it as the system default so existing users get OS/browser locale
          // detection until they explicitly choose a language.
          if (version < 3) next.language = "system";
          return next as unknown as SettingsState;
        },
        partialize: (state) => ({
          autoSave: state.autoSave,
          autoSaveInterval: state.autoSaveInterval,
          language: state.language,
        }),
      },
    ),
  ),
);

const applyAutoSaveSettings = (): void => {
  const { autoSave, autoSaveInterval } = useSettingsStore.getState();
  autoSaveManager.updateConfig({
    enabled: autoSave,
    interval: autoSaveInterval * 60_000,
  });
};

// Keep persisted preferences and runtime scheduling on the same source of
// truth. updateConfig reschedules pending dirty work, so toggles and interval
// changes take effect without reopening the editor.
applyAutoSaveSettings();
useSettingsStore.subscribe((state) => state.autoSave, applyAutoSaveSettings);
useSettingsStore.subscribe(
  (state) => state.autoSaveInterval,
  applyAutoSaveSettings,
);
