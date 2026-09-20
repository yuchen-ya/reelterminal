/**
 * Graphics preset controller tests: the GUI save entry (SVGSection's
 * "save as preset") and the shared apply path. Covers the save → list →
 * apply → delete roundtrip with by-value payload semantics, and the
 * dedicated rejection copy for the two engine-managed effect types
 * (chromaKey / shader) that must never enter a preset.
 */
import "../../../test/install-local-storage-mock";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomPresetRecord } from "@reelterminal/core/presets/types";
import { PRESET_PAYLOAD_SCHEMA_VERSION } from "@reelterminal/core/presets/types";
import type { PresetStorage } from "../../../services/custom-presets/storage";
import {
  CustomPresetService,
  setCustomPresetServiceForTests,
} from "../../../services/custom-presets/preset-service";
import { useNotificationStore } from "../../../stores/notification-store";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import {
  captureEffectPresetItem,
  captureGraphicsPresetSvg,
  saveGraphicsPreset,
  applyGraphicsPresetToPlayhead,
} from "./effect-transition-preset-controllers";

const VALID_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>`;

/** In-memory single-transaction storage standing in for IndexedDB. */
function makeMemoryStorage(): PresetStorage {
  const rows = new Map<string, CustomPresetRecord>();
  return {
    async loadAll() {
      return [...rows.values()];
    },
    async commit(upserts, deletes) {
      for (const record of upserts) rows.set(record.id, record);
      for (const id of deletes) rows.delete(id);
    },
  };
}

let testService: CustomPresetService;

function getTestService(): CustomPresetService {
  if (!testService) throw new Error("test service not initialised");
  return testService;
}

function loadVideoOnlyProject(): void {
  const project = createEmptyProject("Graphics presets");
  useProjectStore.setState({
    hasOpenProject: true,
    project: {
      ...project,
      timeline: {
        ...project.timeline,
        duration: 60,
        tracks: [
          {
            id: "v1",
            type: "video",
            name: "Video",
            clips: [],
            transitions: [],
            locked: false,
            hidden: false,
            muted: false,
            solo: false,
          },
        ],
      },
    },
  });
}

describe("graphics preset controllers", () => {
  beforeEach(() => {
    testService = new CustomPresetService(makeMemoryStorage());
    setCustomPresetServiceForTests(testService);
    useNotificationStore.getState().clearAll();
    useUIStore.getState().clearSelection();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setCustomPresetServiceForTests(null);
    testService = undefined as unknown as CustomPresetService;
    useNotificationStore.getState().clearAll();
    useUIStore.getState().clearSelection();
    useProjectStore.setState({
      hasOpenProject: false,
      project: createEmptyProject("Reset"),
    });
  });

  describe("capture (same validator as agent preset.create)", () => {
    it("accepts safe SVG sources and reports unsafe ones", () => {
      expect(captureGraphicsPresetSvg(VALID_SVG)).toEqual({ ok: true, svg: VALID_SVG });
      expect(captureGraphicsPresetSvg(undefined).ok).toBe(false);

      const unsafe = captureGraphicsPresetSvg(
        `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
      );
      expect(unsafe.ok).toBe(false);
    });
  });

  describe("engine-managed effect types keep dedicated rejection copy", () => {
    it("rejects chromaKey with the clip-keying explanation, not the generic unknown-type line", () => {
      const capture = captureEffectPresetItem("chromaKey", {
        keyColor: { r: 0, g: 1, b: 0 },
        tolerance: 0.3,
      });
      expect(capture.ok).toBe(false);
      if (capture.ok) return;
      expect(capture.reason).toBe("engine-managed");
      expect(capture.messageKey).toBe("assets.effectPresets.chromaKeyNotPreset");
      expect(capture.message).toContain("clip.setChromaKey");
    });

    it("rejects shader with the shader-dependent-params explanation", () => {
      const capture = captureEffectPresetItem("shader", {
        shaderId: "warp",
        intensity: 0.5,
      });
      expect(capture.ok).toBe(false);
      if (capture.ok) return;
      expect(capture.reason).toBe("engine-managed");
      expect(capture.messageKey).toBe("assets.effectPresets.shaderNotPreset");
      expect(capture.message).toContain("shader");
    });

    it("accepts the effect types whose contracts this round added", () => {
      for (const [type, params] of [
        ["grayscale", { amount: 0.8 }],
        ["sepia", { amount: 1 }],
        ["invert", { amount: 0.25 }],
        ["sharpen", { amount: 90 }],
        ["grain", { amount: 30, size: 2 }],
        ["temperature", { value: -30 }],
        ["tint", { value: 20 }],
        ["tonal", { shadows: -10, midtones: 0, highlights: 10 }],
      ] as const) {
        const capture = captureEffectPresetItem(type, params as Record<string, unknown>);
        expect(capture.ok, type).toBe(true);
      }
    });

    it("reports engine-unknown keys (sharpen radius) as dropped, not stored", () => {
      const capture = captureEffectPresetItem("sharpen", { amount: 40, radius: 2 });
      expect(capture.ok).toBe(true);
      if (!capture.ok) return;
      expect(capture.droppedParams).toEqual(["radius"]);
      expect(capture.effects[0]).toEqual({ type: "sharpen", params: { amount: 40 } });
    });
  });

  describe("save → apply → delete roundtrip", () => {
    it("saves through the service, applies at the playhead as one batch, and deletes without touching the applied clip", async () => {
      loadVideoOnlyProject();

      // 1. GUI save entry.
      const saved = await saveGraphicsPreset({
        name: "Badge",
        svg: VALID_SVG,
        existingNames: [],
      });
      expect(saved).not.toBeNull();
      const list = await getTestService().list("graphics");
      expect(list.ok && list.value.presets.map((p) => p.name)).toEqual(["Badge"]);

      // 2. Apply at the playhead: auto-creates the graphics track + SVG clip.
      const applied = await applyGraphicsPresetToPlayhead({
        name: "Badge",
        payload: {
          schemaVersion: PRESET_PAYLOAD_SCHEMA_VERSION,
          kind: "graphics",
          svg: VALID_SVG,
        },
      });
      expect(applied).toBe(true);
      const project = useProjectStore.getState().project;
      const graphicsTrack = project.timeline.tracks.find(
        (track) => track.type === "graphics",
      );
      expect(graphicsTrack).toBeDefined();
      // SVG overlays live in project.svgClips (keyed to the graphics track).
      const svgClip = (project.svgClips ?? []).find(
        (clip) => clip.trackId === graphicsTrack?.id,
      );
      expect(svgClip?.svgContent).toBe(VALID_SVG);
      expect(svgClip?.startTime).toBe(0);
      expect(svgClip?.duration).toBe(5);

      // 3. Deleting the preset never touches clips already created from it
      //    (application copies the payload by value).
      expect(saved).not.toBeNull();
      if (!saved) return;
      const removed = await getTestService().remove(saved.id);
      expect(removed.ok).toBe(true);
      const afterDelete = useProjectStore.getState().project;
      const stillThere = (afterDelete.svgClips ?? []).find(
        (clip) => clip.id === svgClip?.id,
      );
      expect(stillThere).toBeDefined();
      await waitFor(async () => {
        const emptied = await getTestService().list("graphics");
        expect(emptied.ok && emptied.value.presets).toHaveLength(0);
      });
    });
  });
});
