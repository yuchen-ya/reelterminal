/**
 * SVGSection graphics-preset surface: the "save as preset" entry (same
 * validator source as agent preset.create) and the custom graphics preset
 * area under the built-in animation selectors (agent-created presets are
 * immediately visible and applicable here).
 */
import "../../../test/install-local-storage-mock";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SVGClip } from "@openreel/core";
import type { CustomPresetRecord } from "@openreel/core/presets/types";
import {
  DEFAULT_GRAPHIC_TRANSFORM,
  DEFAULT_SVG_COLOR_STYLE,
} from "@openreel/core/graphics/types";
import type { PresetStorage } from "../../../services/custom-presets/storage";
import {
  CustomPresetService,
  setCustomPresetServiceForTests,
} from "../../../services/custom-presets/preset-service";
import { useNotificationStore } from "../../../stores/notification-store";
import { useEngineStore } from "../../../stores/engine-store";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { SVGSection } from "./SVGSection";

const SVG_SOURCE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="teal"/></svg>`;

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

function svgClip(): SVGClip {
  return {
    id: "svg-1",
    trackId: "gfx-1",
    startTime: 0,
    duration: 4,
    type: "svg",
    svgContent: SVG_SOURCE,
    viewBox: { minX: 0, minY: 0, width: 20, height: 20 },
    preserveAspectRatio: "xMidYMid",
    transform: { ...DEFAULT_GRAPHIC_TRANSFORM },
    keyframes: [],
    colorStyle: { ...DEFAULT_SVG_COLOR_STYLE },
    entryAnimation: { type: "none", duration: 0.5, easing: "ease-out" },
    exitAnimation: { type: "none", duration: 0.5, easing: "ease-in" },
  };
}

function loadProject(): void {
  const project = createEmptyProject("SVG presets") as Project;
  useProjectStore.setState({
    hasOpenProject: true,
    project: {
      ...project,
      svgClips: [svgClip()],
      timeline: {
        ...project.timeline,
        tracks: [
          {
            id: "gfx-1",
            type: "graphics",
            name: "Graphics",
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
  // The section reads the clip through the core GraphicsEngine singleton
  // (the same source the canvas renders from), so seed it directly.
  useEngineStore.getState().graphicsEngine?.loadSVGClips([svgClip()]);
}

describe("SVGSection graphics preset surface", () => {
  beforeEach(() => {
    testService = new CustomPresetService(makeMemoryStorage());
    setCustomPresetServiceForTests(testService);
    useNotificationStore.getState().clearAll();
    loadProject();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setCustomPresetServiceForTests(null);
    testService = undefined as unknown as CustomPresetService;
    useNotificationStore.getState().clearAll();
    useEngineStore.getState().graphicsEngine?.loadSVGClips([]);
    useProjectStore.setState({
      hasOpenProject: false,
      project: createEmptyProject("Reset"),
    });
  });

  it("shows the custom graphics preset area with an empty hint below the built-in animation selectors", () => {
    render(<SVGSection clipId="svg-1" />);
    expect(screen.getByText("Custom Graphics Presets")).toBeInTheDocument();
    expect(
      screen.getByText(/No custom graphics presets yet/),
    ).toBeInTheDocument();
  });

  it("saves the clip's SVG source as a preset through the name dialog", async () => {
    render(<SVGSection clipId="svg-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Save as Preset" }));
    fireEvent.change(screen.getByLabelText("Preset name"), {
      target: { value: "Teal Box" },
    });
    // The dialog's confirm button shares the header action's label; the
    // dialog renders later in the DOM, so pick that instance.
    const confirmButtons = screen.getAllByRole("button", { name: "Save as Preset" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);

    await waitFor(() => {
      expect(
        useNotificationStore
          .getState()
          .notifications.some(
            (notification) =>
              notification.type === "success" &&
              `${notification.title} ${notification.message ?? ""}`.includes("Teal Box"),
          ),
      ).toBe(true);
    });
    const list = await testService.list("graphics");
    expect(list.ok && list.value.presets.map((preset) => preset.name)).toEqual([
      "Teal Box",
    ]);
    if (list.ok) {
      expect(list.value.presets[0]?.payload).toMatchObject({
        kind: "graphics",
        svg: SVG_SOURCE,
      });
    }
  });

  it("surfaces agent-created graphics presets and applies one as a new SVG clip", async () => {
    await testService.create({
      kind: "graphics",
      name: "Agent Badge",
      payload: {
        schemaVersion: 1,
        kind: "graphics",
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
      },
    });
    render(<SVGSection clipId="svg-1" />);

    const row = await screen.findByRole("button", { name: "Agent Badge" });
    expect(row).toHaveAttribute("data-graphics-preset-id");
    fireEvent.doubleClick(row);

    await waitFor(() => {
      const project = useProjectStore.getState().project;
      const created = (project.svgClips ?? []).filter(
        (clip) => clip.id !== "svg-1",
      );
      expect(created).toHaveLength(1);
      expect(created[0]?.svgContent).toContain("circle");
      expect(
        project.timeline.tracks.some((track) => track.type === "graphics"),
      ).toBe(true);
    });
  });
});
