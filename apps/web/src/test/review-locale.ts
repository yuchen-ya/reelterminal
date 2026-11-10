import { afterEach, beforeEach } from "vitest";
import i18n from "../i18n";

/** Existing review assertions exercise Chinese copy explicitly, independent of OS locale. */
export function useChineseReviewLocale() {
  let previousLanguage: string;
  beforeEach(async () => {
    previousLanguage = i18n.language;
    await i18n.changeLanguage("zh-CN");
  });
  afterEach(async () => {
    await i18n.changeLanguage(previousLanguage);
  });
}
