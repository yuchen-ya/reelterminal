/**
 * Web-side re-exports of the legacy physical identifier registry (N04).
 *
 * The single source of truth is
 * `packages/core/src/legacy/physical-identifiers.ts` (see its header for why
 * these values are frozen and must never be re-branded). This module only
 * re-exports the identifiers consumed by the web renderer so call sites have
 * a local import path; it defines NO values of its own. Drift is covered by
 * `packages/core/src/legacy/physical-identifiers.test.ts` (constant ===
 * historical literal) and `legacy-identifiers.test.ts` (web runtime names,
 * including source reads of the plain-JS service workers).
 *
 * Rules doc: docs/NAMING-AND-COMPATIBILITY.md §4 "持久化保留为 legacy".
 */
export {
  // IndexedDB database names (user data)
  LEGACY_IDB_PROJECTS as LEGACY_PROJECT_DB_NAME,
  LEGACY_IDB_AGENT_TASKS as LEGACY_AGENT_TASKS_DB_NAME,
  LEGACY_IDB_AUTOSAVE as LEGACY_AUTO_SAVE_DB_NAME,
  LEGACY_IDB_CUSTOM_FONTS as LEGACY_CUSTOM_FONTS_DB_NAME,
  LEGACY_IDB_MATERIAL_LIBRARY as LEGACY_MATERIAL_LIBRARY_DB_NAME,
  LEGACY_IDB_TEMPLATES as LEGACY_TEMPLATE_DB_NAME,
  LEGACY_IDB_MOTION_PRESETS as LEGACY_MOTION_PRESETS_DB_NAME,
  LEGACY_IDB_CUSTOM_PRESETS as LEGACY_CUSTOM_PRESETS_DB_NAME,
  // Service Worker cache names (cleanup ability)
  LEGACY_SW_CACHE_APP,
  LEGACY_SW_CACHE_STATIC,
  LEGACY_SW_CACHE_DYNAMIC,
  LEGACY_SW_CACHE_PREFIX,
  // localStorage keys (user settings)
  LEGACY_LS_SHORTCUTS,
  LEGACY_LS_SHORTCUT_PRESET,
  LEGACY_LS_CUSTOM_EXPORT_PRESETS,
  LEGACY_LS_LOCALE,
  LEGACY_LS_ONBOARDING_COMPLETE,
  LEGACY_LS_MOGRAPH_TOUR_COMPLETE,
  LEGACY_LS_TIMELINE_WORKSPACE,
  LEGACY_LS_MOTION_LEFT_PANEL_WIDTH,
  LEGACY_LS_MOTION_RIGHT_PANEL_WIDTH,
  LEGACY_LS_MOTION_TIMELINE_HEIGHT,
  LEGACY_LS_DESKTOP_MEDIA_WIDTH,
  LEGACY_LS_DESKTOP_INSPECTOR_WIDTH,
  LEGACY_LS_DESKTOP_TIMELINE_HEIGHT,
  LEGACY_LS_SETTINGS,
  LEGACY_LS_THEME,
  LEGACY_LS_UI_PREFERENCES,
} from "@reelterminal/core/legacy/physical-identifiers";
