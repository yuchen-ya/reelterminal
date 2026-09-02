import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n, {
  changeAppLanguage,
  detectSystemLocale,
  getInitialLanguagePreference,
  normalizeLocale,
  resolveLocale,
  SYSTEM_LANGUAGE,
} from ".";
import en from "./locales/en/translation.json";
import zhCN from "./locales/zh-CN/translation.json";
import upstreamZh from "./locales/zh-CN/upstream-translation.json";

function leafKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

const shippedEnglishKeys = leafKeys(en).sort();
const shippedChineseKeys = leafKeys(zhCN).sort();

describe("ReelTerminal locale foundation", () => {
  beforeEach(async () => {
    localStorage.clear();
    await changeAppLanguage(SYSTEM_LANGUAGE);
  });

  afterEach(async () => {
    await changeAppLanguage(SYSTEM_LANGUAGE);
  });

  it("normalizes browser language tags to the shipped locales", () => {
    expect(normalizeLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("fr-FR")).toBe("en");
  });

  it("uses the browser/OS locale when no explicit override exists", () => {
    expect(getInitialLanguagePreference()).toBe(SYSTEM_LANGUAGE);
    expect(resolveLocale(SYSTEM_LANGUAGE)).toBe(detectSystemLocale());
  });

  it("persists an explicit choice and allows returning to system default", async () => {
    await changeAppLanguage("zh-CN");
    expect(localStorage.getItem("openreel-locale")).toBe("zh-CN");
    expect(i18n.language).toBe("zh-CN");

    await changeAppLanguage(SYSTEM_LANGUAGE);
    expect(localStorage.getItem("openreel-locale")).toBeNull();
  });

  it("falls back to English for a missing Simplified Chinese key", async () => {
    i18n.addResource("en", "translation", "test.englishFallback", "English fallback");
    await i18n.changeLanguage("zh-CN");
    expect(i18n.t("test.englishFallback")).toBe("English fallback");
  });

  it("ships every retained English UI key in Simplified Chinese", () => {
    expect(shippedChineseKeys).toEqual(shippedEnglishKeys);
  });

  it("uses the complete upstream Chinese copy for literal retained-surface keys", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(i18n.t("Copy Clip")).toBe("复制片段");
  });

  it("keeps the imported upstream literal catalog complete and non-empty", () => {
    const entries = Object.entries(upstreamZh);
    expect(entries.length).toBeGreaterThan(2000);
    expect(entries.every(([key, value]) => key.trim() && value.trim())).toBe(true);
  });
});
