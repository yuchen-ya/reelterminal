/**
 * Persisted storage keys, cache names, format markers, and embedded asset names.
 * Keep values stable so saved data and asset round trips remain readable.
 * Consumers import these constants; standalone service workers use matching literals.
 * New identifiers use ReelTerminal naming.
 */

/* ------------------------------------------------------------------------- */
/* IndexedDB database names — renaming loses user project/media/preset data. */
/* ------------------------------------------------------------------------- */

/** Project browser DB (`apps/web/src/services/project-manager.ts`, `agent-media-tasks/project-existence.ts`). User projects + recents. */
export const LEGACY_IDB_PROJECTS = "openreel-projects";

/** Agent media task queue DB (`apps/web/src/services/agent-media-tasks/storage.ts`). User-visible task history. */
export const LEGACY_IDB_AGENT_TASKS = "openreel-agent-tasks";

/** Auto-save slots DB (`apps/web/src/services/auto-save.ts`). Autosaved user project data. */
export const LEGACY_IDB_AUTOSAVE = "openreel-autosave";

/** Custom font library DB (`apps/web/src/components/editor/inspector/font-options.ts`). User-uploaded font binaries. */
export const LEGACY_IDB_CUSTOM_FONTS = "openreel-custom-fonts";

/** Material library DB (`apps/web/src/services/material-library/storage.ts`). User materials, journal and blob copies. */
export const LEGACY_IDB_MATERIAL_LIBRARY = "openreel-material-library";

/** Template DB (`packages/core/src/template/template-engine.ts`). User-installed templates. */
export const LEGACY_IDB_TEMPLATES = "openreel-templates";

/** Motion presets DB (`apps/web/src/services/motion-presets.ts`). User motion presets. */
export const LEGACY_IDB_MOTION_PRESETS = "openreel-motion-presets";

/** Custom presets DB (`apps/web/src/services/custom-presets/storage.ts`). User custom presets + thumbnails. */
export const LEGACY_IDB_CUSTOM_PRESETS = "openreel-custom-presets";

/** Core project storage-engine DB (`packages/core/src/storage/types.ts`). Projects, media blobs, cache, waveforms, file handles. */
export const LEGACY_IDB_STORAGE_ENGINE = "openreel-db";

/** Studio drafts DB (`apps/studio/src/hub/drafts.ts`). User effect/filter/template drafts. */
export const LEGACY_IDB_STUDIO_DRAFTS = "openreel-studio";

/* ------------------------------------------------------------------------- */
/* Service Worker cache names — renaming orphans old caches: cleanup logic    */
/* matches them (and the `openreel-` prefix) and cannot delete what it no     */
/* longer recognizes, so renamed caches would linger until quota eviction.    */
/* ------------------------------------------------------------------------- */

/** App shell cache (`apps/web/public/sw.js` — plain JS, kept in sync by comment + drift test). */
export const LEGACY_SW_CACHE_APP = "openreel-v2";

/** Static asset cache (`apps/web/public/sw.js`). */
export const LEGACY_SW_CACHE_STATIC = "openreel-static-v2";

/** Dynamic/runtime cache (`apps/web/public/sw.js`). */
export const LEGACY_SW_CACHE_DYNAMIC = "openreel-dynamic-v2";

/** Cache-cleanup prefix matched by `apps/web/public/sw.js` retention logic. */
export const LEGACY_SW_CACHE_PREFIX = "openreel-";

/** Image app PWA cache (`apps/image/public/sw.js`; apps/image does not depend on @reelterminal/core). */
export const LEGACY_SW_CACHE_IMAGE = "openreel-image-v1";

/* ------------------------------------------------------------------------- */
/* Persisted format / embedded-output identifiers                             */
/* ------------------------------------------------------------------------- */

/**
 * Agent checkpoint (project file) format string
 * (`packages/agent-facade/src/checkpoint.ts`). Persisted schema identifier
 * gating format compatibility — a format-version gate, not a brand slot.
 * Renaming would make every existing checkpoint unreadable.
 */
export const LEGACY_CHECKPOINT_FORMAT = "openreel-project";

/**
 * GLB/GLTF `asset.generator` string written into exported 3D assets
 * (`packages/core/src/creation/geometry/glb.ts`, `gltf.ts`). Embedded in user
 * output artifacts; value kept for provenance/round-trip stability.
 */
export const LEGACY_GEOMETRY_GENERATOR = "openreel-cpu-geometry-kernel";

/**
 * Blender humanoid object name created by the rigging sidecar
 * (`apps/desktop/src/main/sidecar/rigging-backend.ts` `--name` default).
 * Identifies humanoids in .blend assets for rigging round trips.
 */
export const LEGACY_RIGGING_HUMANOID_NAME = "OpenReelHumanoid";

/**
 * Blender Armature modifier name created by the rigging sidecar
 * (`apps/desktop/src/main/sidecar/rigging-backend.ts`). Embedded in user
 * .blend assets alongside the humanoid object name.
 */
export const LEGACY_RIGGING_ARMATURE_MODIFIER = "OpenReel Armature";

/* ------------------------------------------------------------------------- */
/* localStorage keys — renaming loses user settings, layouts and tour state.  */
/* ------------------------------------------------------------------------- */

/** Customized keyboard shortcut bindings (`apps/web/src/services/keyboard-shortcuts.ts`). */
export const LEGACY_LS_SHORTCUTS = "openreel_shortcuts";

/** Selected keyboard shortcut preset (`apps/web/src/services/keyboard-shortcuts.ts`). Stored value references the built-in preset id `"openreel"`, which is itself persisted data and equally frozen. */
export const LEGACY_LS_SHORTCUT_PRESET = "openreel_shortcut_preset";

/** Custom export presets (`apps/web/src/services/export-presets.ts`). */
export const LEGACY_LS_CUSTOM_EXPORT_PRESETS = "openreel-custom-export-presets";

/** UI language preference (`apps/web/src/i18n/index.ts`). */
export const LEGACY_LS_LOCALE = "openreel-locale";

/** Onboarding tour completion flag (`apps/web/src/components/editor/tour/tour-steps.ts`). */
export const LEGACY_LS_ONBOARDING_COMPLETE = "openreel-onboarding-complete";

/** MoGraph tour completion flag (`apps/web/src/components/editor/tour/mograph-tour-steps.ts`). */
export const LEGACY_LS_MOGRAPH_TOUR_COMPLETE = "openreel-mograph-tour-complete";

/** Timeline workspace layout (`apps/web/src/stores/timeline-store.ts`). */
export const LEGACY_LS_TIMELINE_WORKSPACE = "openreel-timeline-workspace";

/** Motion Creator left panel width (`apps/web/src/motion/MotionCreatorShell.tsx`). */
export const LEGACY_LS_MOTION_LEFT_PANEL_WIDTH = "openreel.motionCreator.leftPanelWidth.v2";

/** Motion Creator right panel width (`apps/web/src/motion/MotionCreatorShell.tsx`). */
export const LEGACY_LS_MOTION_RIGHT_PANEL_WIDTH = "openreel.motionCreator.rightPanelWidth.v2";

/** Motion Creator timeline height (`apps/web/src/motion/MotionCreatorShell.tsx`). */
export const LEGACY_LS_MOTION_TIMELINE_HEIGHT = "openreel.motionCreator.timelineHeight.v2";

/** Desktop layout: media panel width (`apps/web/src/desktop/pages/EditPage.tsx`). */
export const LEGACY_LS_DESKTOP_MEDIA_WIDTH = "openreel-desktop-media-w";

/** Desktop layout: inspector panel width (`apps/web/src/desktop/pages/EditPage.tsx`). */
export const LEGACY_LS_DESKTOP_INSPECTOR_WIDTH = "openreel-desktop-inspector-w";

/** Desktop layout: timeline height (`apps/web/src/desktop/pages/EditPage.tsx`). */
export const LEGACY_LS_DESKTOP_TIMELINE_HEIGHT = "openreel-desktop-timeline-h";

/** Settings store (zustand persist name, `apps/web/src/stores/settings-store.ts`). */
export const LEGACY_LS_SETTINGS = "openreel-settings";

/** Theme store (zustand persist name, `apps/web/src/stores/theme-store.ts`). */
export const LEGACY_LS_THEME = "openreel-theme";

/** UI preferences store (zustand persist name, `apps/web/src/stores/ui-store.ts`). */
export const LEGACY_LS_UI_PREFERENCES = "openreel-ui-preferences";

/** Device capability profile cache (`packages/core/src/device/device-capabilities.ts`). Not user-entered data, but key kept: it avoids re-running the detection probe and renaming would silently drop it for every user. */
export const LEGACY_LS_DEVICE_PROFILE = "openreel_device_profile";

/** Image app autosave localStorage prefix (`apps/image/src/hooks/useAutoSave.ts`; apps/image does not depend on @reelterminal/core). */
export const LEGACY_LS_IMAGE_AUTOSAVE_PREFIX = "openreel-image-project-";

/** Image app color palette persist name (`apps/image/src/stores/color-store.ts`). */
export const LEGACY_LS_IMAGE_COLORS = "openreel-image-colors";
