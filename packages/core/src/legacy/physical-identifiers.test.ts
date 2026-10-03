/**
 * Persisted identifier value tests.
 *
 * Exported constants are checked against the user-data keys, file suffixes,
 * and cache names used by the applications.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LEGACY_IDB_PROJECTS,
  LEGACY_IDB_AGENT_TASKS,
  LEGACY_IDB_AUTOSAVE,
  LEGACY_IDB_CUSTOM_FONTS,
  LEGACY_IDB_MATERIAL_LIBRARY,
  LEGACY_IDB_TEMPLATES,
  LEGACY_IDB_MOTION_PRESETS,
  LEGACY_IDB_CUSTOM_PRESETS,
  LEGACY_IDB_STORAGE_ENGINE,
  LEGACY_IDB_STUDIO_DRAFTS,
  LEGACY_SW_CACHE_APP,
  LEGACY_SW_CACHE_STATIC,
  LEGACY_SW_CACHE_DYNAMIC,
  LEGACY_SW_CACHE_PREFIX,
  LEGACY_SW_CACHE_IMAGE,
  LEGACY_CHECKPOINT_FORMAT,
  LEGACY_GEOMETRY_GENERATOR,
  LEGACY_RIGGING_HUMANOID_NAME,
  LEGACY_RIGGING_ARMATURE_MODIFIER,
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
  LEGACY_LS_DEVICE_PROFILE,
  LEGACY_LS_IMAGE_AUTOSAVE_PREFIX,
  LEGACY_LS_IMAGE_COLORS,
} from "./physical-identifiers";

describe("legacy physical identifier registry", () => {
  it("IndexedDB database names keep their historical literals", () => {
    expect(LEGACY_IDB_PROJECTS).toBe("openreel-projects");
    expect(LEGACY_IDB_AGENT_TASKS).toBe("openreel-agent-tasks");
    expect(LEGACY_IDB_AUTOSAVE).toBe("openreel-autosave");
    expect(LEGACY_IDB_CUSTOM_FONTS).toBe("openreel-custom-fonts");
    expect(LEGACY_IDB_MATERIAL_LIBRARY).toBe("openreel-material-library");
    expect(LEGACY_IDB_TEMPLATES).toBe("openreel-templates");
    expect(LEGACY_IDB_MOTION_PRESETS).toBe("openreel-motion-presets");
    expect(LEGACY_IDB_CUSTOM_PRESETS).toBe("openreel-custom-presets");
    expect(LEGACY_IDB_STORAGE_ENGINE).toBe("openreel-db");
    expect(LEGACY_IDB_STUDIO_DRAFTS).toBe("openreel-studio");
  });

  it("Service Worker cache names keep their historical literals", () => {
    expect(LEGACY_SW_CACHE_APP).toBe("openreel-v2");
    expect(LEGACY_SW_CACHE_STATIC).toBe("openreel-static-v2");
    expect(LEGACY_SW_CACHE_DYNAMIC).toBe("openreel-dynamic-v2");
    expect(LEGACY_SW_CACHE_PREFIX).toBe("openreel-");
    expect(LEGACY_SW_CACHE_IMAGE).toBe("openreel-image-v1");
  });

  it("persisted format / embedded-output identifiers keep their historical literals", () => {
    expect(LEGACY_CHECKPOINT_FORMAT).toBe("openreel-project");
    expect(LEGACY_GEOMETRY_GENERATOR).toBe("openreel-cpu-geometry-kernel");
    expect(LEGACY_RIGGING_HUMANOID_NAME).toBe("OpenReelHumanoid");
    expect(LEGACY_RIGGING_ARMATURE_MODIFIER).toBe("OpenReel Armature");
  });

  it("localStorage keys keep their historical literals", () => {
    expect(LEGACY_LS_SHORTCUTS).toBe("openreel_shortcuts");
    expect(LEGACY_LS_SHORTCUT_PRESET).toBe("openreel_shortcut_preset");
    expect(LEGACY_LS_CUSTOM_EXPORT_PRESETS).toBe(
      "openreel-custom-export-presets",
    );
    expect(LEGACY_LS_LOCALE).toBe("openreel-locale");
    expect(LEGACY_LS_ONBOARDING_COMPLETE).toBe("openreel-onboarding-complete");
    expect(LEGACY_LS_MOGRAPH_TOUR_COMPLETE).toBe(
      "openreel-mograph-tour-complete",
    );
    expect(LEGACY_LS_TIMELINE_WORKSPACE).toBe("openreel-timeline-workspace");
    expect(LEGACY_LS_MOTION_LEFT_PANEL_WIDTH).toBe(
      "openreel.motionCreator.leftPanelWidth.v2",
    );
    expect(LEGACY_LS_MOTION_RIGHT_PANEL_WIDTH).toBe(
      "openreel.motionCreator.rightPanelWidth.v2",
    );
    expect(LEGACY_LS_MOTION_TIMELINE_HEIGHT).toBe(
      "openreel.motionCreator.timelineHeight.v2",
    );
    expect(LEGACY_LS_DESKTOP_MEDIA_WIDTH).toBe("openreel-desktop-media-w");
    expect(LEGACY_LS_DESKTOP_INSPECTOR_WIDTH).toBe(
      "openreel-desktop-inspector-w",
    );
    expect(LEGACY_LS_DESKTOP_TIMELINE_HEIGHT).toBe(
      "openreel-desktop-timeline-h",
    );
    expect(LEGACY_LS_SETTINGS).toBe("openreel-settings");
    expect(LEGACY_LS_THEME).toBe("openreel-theme");
    expect(LEGACY_LS_UI_PREFERENCES).toBe("openreel-ui-preferences");
    expect(LEGACY_LS_DEVICE_PROFILE).toBe("openreel_device_profile");
    expect(LEGACY_LS_IMAGE_AUTOSAVE_PREFIX).toBe("openreel-image-project-");
    expect(LEGACY_LS_IMAGE_COLORS).toBe("openreel-image-colors");
  });

  it("plain-JS service workers keep the registered cache names in their source", () => {
    // sw.js files are standalone plain JS and cannot import the registry;
    // Pin the literals in the standalone service-worker source.
    const webSw = readFileSync(
      fileURLToPath(
        new URL("../../../../apps/web/public/sw.js", import.meta.url),
      ),
      "utf8",
    );
    expect(webSw).toContain('const CACHE_NAME = "openreel-v2"');
    expect(webSw).toContain('const STATIC_CACHE_NAME = "openreel-static-v2"');
    expect(webSw).toContain(
      'const DYNAMIC_CACHE_NAME = "openreel-dynamic-v2"',
    );
    expect(webSw).toContain('name.startsWith("openreel-")');

    const imageSw = readFileSync(
      fileURLToPath(
        new URL("../../../../apps/image/public/sw.js", import.meta.url),
      ),
      "utf8",
    );
    expect(imageSw).toContain("const CACHE_NAME = 'openreel-image-v1'");
  });
});
