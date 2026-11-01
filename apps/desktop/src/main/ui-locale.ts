import { app } from "electron";

export type UiLocale = "en" | "zh-CN";
let selectedLocale: UiLocale | undefined;

/** The trusted editor sends its resolved preference, including System mode. */
export function setUiLocale(locale: UiLocale): void {
  selectedLocale = locale;
}

export function getUiLocale(): UiLocale {
  return selectedLocale ?? (app.getLocale().toLowerCase().startsWith("zh") ? "zh-CN" : "en");
}
