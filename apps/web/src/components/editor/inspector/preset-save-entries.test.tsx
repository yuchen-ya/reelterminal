import "../../../test/install-local-storage-mock";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip, Project, Transition } from "@reelterminal/core";
import type { CustomPresetRecord } from "@reelterminal/core/presets/types";
import { getTransitionBridge } from "../../../bridges/transition-bridge";
import type { PresetStorage } from "../../../services/custom-presets/storage";
import {
  CustomPresetService,
  setCustomPresetServiceForTests,
} from "../../../services/custom-presets/preset-service";
import { useNotificationStore } from "../../../stores/notification-store";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { VideoEffectsSection } from "./VideoEffectsSection";
import { TransitionInspector } from "./TransitionInspector";

const { testEffectsBridge } = vi.hoisted(() => ({
  testEffectsBridge: { isInitialized: () => false },
}));

// Persistence/catalog behavior does not need a GPU renderer. Keeping the
// bridge unavailable also verifies the project-backed fallback used in jsdom.
vi.mock("../../../bridges/effects-bridge", () => ({
  getEffectsBridge: () => testEffectsBridge,
}));

vi.mock("../../shaders/ShaderPreviewBrowser", () => ({
  ShaderPreviewBrowser: () => <div />,
}));

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

async function storedPresets(
  kind: "effect" | "transition",
): Promise<readonly CustomPresetRecord[]> {
  const list = await getTestService().list(kind);
  if (!list.ok) throw new Error(list.message);
  return list.value.presets;
}

function errorToastTexts(): string[] {
  return useNotificationStore
    .getState()
    .notifications.filter((notification) => notification.type === "error")
    .map((notification) => `${notification.title} ${notification.message ?? ""}`);
}

function timelineClip(id: string, effects: unknown[] = []): Clip {
  return {
    id,
    mediaId: `media-${id}`,
    trackId: "track-video",
    startTime: 0,
    duration: 5,
    inPoint: 0,
    outPoint: 5,
    effects,
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
  } as Clip;
}

function loadProjectWithEffects(effects: unknown[]): Project {
  const project = createEmptyProject("Preset save entries");
  return {
    ...project,
    timeline: {
      ...project.timeline,
      duration: 5,
      tracks: [
        {
          id: "track-video",
          type: "video",
          name: "V1",
          clips: [timelineClip("clip-save", effects)],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
    },
  } as unknown as Project;
}

const inspectorClip = (id: string, startTime: number): Clip => ({
  id,
  mediaId: `media-${id}`,
  trackId: "track-1",
  startTime,
  duration: 4,
  inPoint: 0,
  outPoint: 4,
  effects: [],
  audioEffects: [],
  transform: {
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    anchor: { x: 0.5, y: 0.5 },
    opacity: 1,
  },
  volume: 1,
  keyframes: [],
});

describe("VideoEffectsSection save-as-preset entry", () => {
  beforeEach(() => {
    testService = new CustomPresetService(makeMemoryStorage());
    setCustomPresetServiceForTests(testService);
    useNotificationStore.getState().clearAll();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setCustomPresetServiceForTests(null);
    testService = undefined as unknown as CustomPresetService;
    useNotificationStore.getState().clearAll();
    useProjectStore.setState({
      hasOpenProject: false,
      project: createEmptyProject("Reset"),
    });
  });

  it("rejects an effect outside the closed engine set with an explicit message", async () => {
    useProjectStore
      .getState()
      .loadProject(loadProjectWithEffects([{ id: "e1", type: "dream-glow", enabled: true, params: { amount: 1 } }]));
    render(<VideoEffectsSection clipId="clip-save" />);

    fireEvent.click(screen.getByRole("button", { name: "Save effect as preset" }));

    const errors = errorToastTexts();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not in the engine's presetable effect set");
    expect(screen.queryByLabelText("Preset name")).not.toBeInTheDocument();
    expect(await storedPresets("effect")).toEqual([]);
  });

  it("rejects chromaKey with the dedicated clip-keying copy instead of the generic line", async () => {
    useProjectStore
      .getState()
      .loadProject(loadProjectWithEffects([{ id: "e1", type: "chromaKey", enabled: true, params: { tolerance: 0.3 } }]));
    render(<VideoEffectsSection clipId="clip-save" />);

    fireEvent.click(screen.getByRole("button", { name: "Save effect as preset" }));

    const errors = errorToastTexts();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("clip.setChromaKey");
    expect(screen.queryByLabelText("Preset name")).not.toBeInTheDocument();
    expect(await storedPresets("effect")).toEqual([]);
  });

  it("rejects shader with the dedicated shader-dependent copy", async () => {
    useProjectStore
      .getState()
      .loadProject(loadProjectWithEffects([{ id: "e1", type: "shader", enabled: true, params: { shaderId: "warp" } }]));
    render(<VideoEffectsSection clipId="clip-save" />);

    fireEvent.click(screen.getByRole("button", { name: "Save effect as preset" }));

    const errors = errorToastTexts();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("depend on the selected shader");
    expect(await storedPresets("effect")).toEqual([]);
  });

  it("saves a GUI-stack effect whose contract this round added (grayscale) without a dropped-params confirm", async () => {
    useProjectStore
      .getState()
      .loadProject(loadProjectWithEffects([{ id: "e1", type: "grayscale", enabled: true, params: { amount: 0.75 } }]));
    render(<VideoEffectsSection clipId="clip-save" />);

    fireEvent.click(screen.getByRole("button", { name: "Save effect as preset" }));
    fireEvent.change(screen.getByLabelText("Preset name"), { target: { value: "Half Gray" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Preset" }));

    await waitFor(async () => {
      expect((await storedPresets("effect")).map((preset) => preset.name)).toEqual(["Half Gray"]);
    });
    const saved = (await storedPresets("effect"))[0];
    expect(saved?.payload).toMatchObject({
      kind: "effect",
      effects: [{ type: "grayscale", params: { amount: 0.75 } }],
    });
  });

  it("saves an engine effect with its parameters after confirming dropped keys", async () => {
    useProjectStore.getState().loadProject(
      loadProjectWithEffects([
        {
          id: "e1",
          type: "blur",
          enabled: true,
          params: { radius: 24, type: "gaussian" },
        },
      ]),
    );
    render(<VideoEffectsSection clipId="clip-save" />);

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Save effect as preset" }));

    // The engine-unknown parameter key is called out, never silently dropped.
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy.mock.calls[0][0]).toContain("type");

    fireEvent.change(await screen.findByLabelText("Preset name"), {
      target: { value: "My Blur" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Preset" }));

    await waitFor(async () => {
      expect(await storedPresets("effect")).toHaveLength(1);
    });
    const payload = (await storedPresets("effect"))[0]!.payload as unknown as {
      kind: string;
      effects: { type: string; params: Record<string, unknown> }[];
    };
    expect(payload.kind).toBe("effect");
    expect(payload.effects).toEqual([
      { type: "blur", params: { radius: 24 } },
    ]);
  });
});

describe("TransitionInspector save-as-preset entry", () => {
  beforeEach(() => {
    testService = new CustomPresetService(makeMemoryStorage());
    setCustomPresetServiceForTests(testService);
    useNotificationStore.getState().clearAll();
    const bridge = getTransitionBridge();
    if (!bridge.isInitialized()) bridge.initialize(320, 180);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setCustomPresetServiceForTests(null);
    testService = undefined as unknown as CustomPresetService;
    useNotificationStore.getState().clearAll();
  });

  function renderInspector(transition: Transition | undefined) {
    return render(
      <TransitionInspector
        clipA={inspectorClip("clip-a", 0)}
        clipB={inspectorClip("clip-b", 4)}
        transition={transition}
      />,
    );
  }

  it("saves the current transition configuration, confirming dropped non-preset settings", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderInspector({
      id: "t1",
      clipAId: "clip-a",
      clipBId: "clip-b",
      type: "crossfade",
      duration: 1,
      params: { curve: "ease", audioFade: true },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save as Preset" }));

    // audioFade is a playback behavior, not an engine transition parameter.
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy.mock.calls[0][0]).toContain("audioFade");

    fireEvent.change(await screen.findByLabelText("Preset name"), {
      target: { value: "Gentle Cut" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Preset" }));

    await waitFor(async () => {
      expect(await storedPresets("transition")).toHaveLength(1);
    });
    const payload = (await storedPresets("transition"))[0]!.payload as {
      kind: string;
      type: string;
      durationSec?: number;
      params: Record<string, unknown>;
    };
    expect(payload).toMatchObject({
      kind: "transition",
      type: "crossfade",
      durationSec: 1,
      params: { curve: "ease" },
    });
    expect(payload.params).not.toHaveProperty("audioFade");
  });

  it("rejects an out-of-range preset duration without opening the dialog", async () => {
    renderInspector({
      id: "t2",
      clipAId: "clip-a",
      clipBId: "clip-b",
      type: "crossfade",
      duration: 20,
      params: { curve: "ease" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save as Preset" }));

    const errors = errorToastTexts();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("durationSec");
    expect(screen.queryByLabelText("Preset name")).not.toBeInTheDocument();
    expect(await storedPresets("transition")).toEqual([]);
  });
});
