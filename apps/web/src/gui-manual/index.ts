/**
 * Web-side bridge for the shipped GUI manual.
 *
 * The manual's structured content (screens, versions, search) lives in the
 * agent facade package (`@openreel/agent-facade/gui-manual`) so the help.*
 * verbs answer from the SAME static data in live and headless sessions.
 * This module re-exports that content for renderer use and adds the one
 * thing only the web app can do: resolve a screen's shortcut REFERENCES
 * against the live shortcut registry (apps/web/src/services/
 * keyboard-shortcuts.ts). Key bindings are user-remappable editor state, so
 * the facade intentionally ships ids only — the binding strings joined here
 * are read from the registry at call time and never duplicated into the
 * manual content.
 */
import { keyboardShortcuts } from "../services/keyboard-shortcuts";
import {
  GUI_MANUAL_APP_VERSION,
  GUI_MANUAL_CONTENT_VERSION,
  GUI_MANUAL_LANGUAGES,
  GUI_MANUAL_SCREENS,
  describeManualScreen,
  listManualScreens,
  searchManualScreens,
} from "@openreel/agent-facade/gui-manual";
import type {
  ManualCapability,
  ManualDescribeParams,
  ManualDescribeResult,
  ManualListScreensResult,
  ManualLocalizedText,
  ManualScreen,
  ManualSearchResult,
} from "@openreel/agent-facade/gui-manual";

export {
  GUI_MANUAL_APP_VERSION,
  GUI_MANUAL_CONTENT_VERSION,
  GUI_MANUAL_LANGUAGES,
  GUI_MANUAL_SCREENS,
  describeManualScreen,
  listManualScreens,
  searchManualScreens,
};
export type {
  ManualCapability,
  ManualDescribeParams,
  ManualDescribeResult,
  ManualListScreensResult,
  ManualLocalizedText,
  ManualScreen,
  ManualSearchResult,
};

/** One manual shortcut reference resolved against the live registry. */
export interface ResolvedManualShortcut {
  /** The stable registry id referenced by the manual screen. */
  readonly id: string;
  /** Display name from the registry (e.g. "Split"); empty when the id is stale. */
  readonly name: string;
  /** The CURRENT binding for this user, platform-formatted (may be remapped). */
  readonly key: string;
  readonly category: string;
}

export class UnknownManualScreenError extends Error {
  constructor(screenId: string) {
    super(`Unknown manual screen id: ${screenId}`);
    this.name = "UnknownManualScreenError";
  }
}

/**
 * Resolve one screen's shortcutIds into live {name, key} rows. Throws for a
 * screen id that is not in the manual. A reference that is missing from the
 * registry yields empty name/key fields — tests treat that as a content bug,
 * the UI can decide how to render it.
 */
export function resolveManualShortcuts(
  screenId: string,
): readonly ResolvedManualShortcut[] {
  const screen = GUI_MANUAL_SCREENS.find((candidate) => candidate.id === screenId);
  if (!screen) throw new UnknownManualScreenError(screenId);
  return (screen.shortcutIds ?? []).map((id) => {
    const definition = keyboardShortcuts.getShortcut(id);
    return {
      id,
      name: definition?.name ?? "",
      key: definition ? keyboardShortcuts.formatShortcut(id) : "",
      category: definition?.category ?? "",
    };
  });
}

/** Convenience: the screen page plus its resolved shortcut bindings. */
export function describeManualScreenWithShortcuts(screenId: string): {
  screen: ManualScreen;
  shortcuts: readonly ResolvedManualShortcut[];
} {
  const described: ManualDescribeResult = describeManualScreen(screenId);
  return {
    screen: described.screen,
    shortcuts: resolveManualShortcuts(screenId),
  };
}

/** The manual metadata block, mirroring the help verbs' `manual` field. */
export function manualCapability(): ManualCapability {
  return {
    available: true,
    contentVersion: GUI_MANUAL_CONTENT_VERSION,
    appVersion: GUI_MANUAL_APP_VERSION,
    languages: [...GUI_MANUAL_LANGUAGES],
    screenCount: GUI_MANUAL_SCREENS.length,
    screenshots: GUI_MANUAL_SCREENS.some((screen) => screen.screenshot !== undefined)
      ? "delivered"
      : "reserved-not-delivered",
  };
}
