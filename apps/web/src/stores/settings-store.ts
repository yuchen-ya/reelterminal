import { create } from "zustand";
import { subscribeWithSelector, persist } from "zustand/middleware";
import {
  changeAppLanguage,
  getInitialLanguagePreference,
  type LanguagePreference,
} from "../i18n";

export type SettingsTab = "general";

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
          set({ autoSaveInterval: Math.max(1, Math.min(30, minutes)) }),

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
        name: "openreel-settings",
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
