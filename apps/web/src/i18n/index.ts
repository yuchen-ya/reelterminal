import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en/translation.json";
import zhCN from "./locales/zh-CN/translation.json";
import upstreamZh from "./locales/zh-CN/upstream-translation.json";
import { LEGACY_LS_LOCALE } from "../services/legacy-storage-keys";

// Persisted localStorage key for the user's language
// preference). See packages/core/src/legacy/physical-identifiers.ts.
export const LOCALE_STORAGE_KEY = LEGACY_LS_LOCALE;
export const SYSTEM_LANGUAGE = "system" as const;
export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];
export type LanguagePreference = Locale | typeof SYSTEM_LANGUAGE;

function flattenResource(value: unknown, prefix = ""): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? { [prefix]: String(value ?? "") } : {};
  }

  return Object.entries(value).reduce<Record<string, string>>((flat, [key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return Object.assign(flat, flattenResource(child, path));
  }, {});
}

// Keep the hand-authored namespaced keys ergonomic while also accepting the
// literal English keys used by the retained editor surfaces. The upstream
// resource is intentionally merged only into Chinese; English falls back to
// the original literal key when a surface has not been wrapped yet.
const englishResource = { ...en, ...flattenResource(en) };
const chineseResource = {
  ...zhCN,
  ...flattenResource(zhCN),
  ...upstreamZh,
};

function readStoredOverride(): Locale | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return value && isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Map OS/browser language tags to the locales the app ships. */
export function normalizeLocale(language?: string | null): Locale {
  const normalized = language?.trim().toLowerCase();
  return normalized?.startsWith("zh") ? "zh-CN" : "en";
}

export function detectSystemLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  const candidates = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ];
  return normalizeLocale(candidates.find(Boolean));
}

export function getInitialLanguagePreference(): LanguagePreference {
  return readStoredOverride() ?? SYSTEM_LANGUAGE;
}

export function resolveLocale(preference: LanguagePreference): Locale {
  return preference === SYSTEM_LANGUAGE ? detectSystemLocale() : preference;
}

function persistOverride(preference: LanguagePreference): void {
  if (typeof window === "undefined") return;
  try {
    if (preference === SYSTEM_LANGUAGE) {
      window.localStorage.removeItem(LOCALE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, preference);
    }
  } catch {
    // Storage is optional (private browsing and server rendering can deny it).
  }
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: englishResource },
    "zh-CN": { translation: chineseResource },
  },
  lng: resolveLocale(getInitialLanguagePreference()),
  fallbackLng: "en",
  supportedLngs: [...SUPPORTED_LOCALES],
  nonExplicitSupportedLngs: false,
  interpolation: { escapeValue: false },
  keySeparator: false,
  returnEmptyString: false,
  react: { useSuspense: false },
});

export async function changeAppLanguage(preference: LanguagePreference): Promise<void> {
  persistOverride(preference);
  await i18n.changeLanguage(resolveLocale(preference));
  if (typeof document !== "undefined") {
    document.documentElement.lang = i18n.language;
  }
}

if (typeof document !== "undefined") {
  document.documentElement.lang = resolveLocale(getInitialLanguagePreference());
}

export default i18n;

/** Translate catalog strings from non-React modules (bridges, stores, and services). */
export function t(key: string): string {
  return i18n.t(key);
}
