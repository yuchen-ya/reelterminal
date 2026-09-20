import "../../../test/install-local-storage-mock";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip } from "@reelterminal/core";
import type { CustomPresetRecord } from "@reelterminal/core/presets/types";
import { PRESET_PAYLOAD_SCHEMA_VERSION } from "@reelterminal/core/presets/types";
import { disposeTransitionBridge } from "../../../bridges/transition-bridge";
import type { PresetStorage } from "../../../services/custom-presets/storage";
import {
  CustomPresetService,
  setCustomPresetServiceForTests,
} from "../../../services/custom-presets/preset-service";
import {
  applyTransitionPresetToSelectedCut,
  deleteCustomPresetWithConfirm,
  renameCustomPreset,
} from "./effect-transition-preset-controllers";
import { useNotificationStore } from "../../../stores/notification-store";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import {
  CustomEffectPresetCard,
  EffectsPanel,
  TransitionsPanel,
} from "./EffectsTransitionsPanel";

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

async function seedPreset(
  kind: "effect" | "transition",
  name: string,
  payload: Record<string, unknown>,
): Promise<CustomPresetRecord> {
  const result = await getTestService().create({
    kind,
    name,
    payload: { schemaVersion: PRESET_PAYLOAD_SCHEMA_VERSION, ...payload },
  });
  if (!result.ok) throw new Error(`seed failed: ${result.message}`);
  return result.value;
}

async function storedNames(kind: "effect" | "transition"): Promise<string[]> {
  const list = await getTestService().list(kind);
  if (!list.ok) throw new Error(list.message);
  return list.value.presets.map((record) => record.name);
}

function clip(id: string, startTime: number, duration = 3): Clip {
  return {
    id,
    mediaId: `media-${id}`,
    trackId: "preset-track",
    startTime,
    duration,
    inPoint: 0,
    outPoint: duration,
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
  };
}

function loadTwoClipProject(firstDuration = 3): void {
  const first = clip("cut-a", 0, firstDuration);
  const second = clip("cut-b", firstDuration, firstDuration);
  const project = createEmptyProject("Custom presets");
  useProjectStore.setState({
    hasOpenProject: true,
    project: {
      ...project,
      timeline: {
        ...project.timeline,
        duration: firstDuration * 2,
        tracks: [
          {
            id: "preset-track",
            type: "video",
            name: "Video",
            clips: [first, second],
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

describe("EffectsTransitionsPanel custom preset merge", () => {
  beforeEach(() => {
    testService = new CustomPresetService(makeMemoryStorage());
    setCustomPresetServiceForTests(testService);
    useNotificationStore.getState().clearAll();
    useUIStore.getState().clearSelection();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    disposeTransitionBridge();
    setCustomPresetServiceForTests(null);
    testService = undefined as unknown as CustomPresetService;
    useNotificationStore.getState().clearAll();
    useUIStore.getState().clearSelection();
    useProjectStore.setState({
      hasOpenProject: false,
      project: createEmptyProject("Reset"),
    });
  });

  it("merges custom effect presets beside the read-only built-ins", async () => {
    await seedPreset("effect", "Cool Look", {
      kind: "effect",
      effects: [{ type: "blur", params: { radius: 18 } }],
    });
    render(<EffectsPanel />);

    expect(screen.getByText("Brightness")).toBeInTheDocument();
    expect(screen.getByText("Custom")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Cool Look" }),
    ).toBeInTheDocument();
  });

  it("merges custom transition presets with their type preview and duration", async () => {
    await seedPreset("transition", "Soft Cut", {
      kind: "transition",
      type: "wipe",
      durationSec: 1.5,
      params: { direction: "right", softness: 0.2 },
    });
    render(<TransitionsPanel />);

    expect(screen.getByText("Crossfade")).toBeInTheDocument();
    expect(screen.getByText("Custom")).toBeInTheDocument();
    const card = await screen.findByRole("button", { name: "Soft Cut" });
    expect(card).toHaveAttribute("data-transition-preset-id");
    expect(card.textContent).toContain("1.5s");
  });

  it("applies a custom effect preset to the selected clips as one undoable batch", async () => {
    loadTwoClipProject();
    const first = useProjectStore.getState().project.timeline.tracks[0]!.clips[0]!;
    useUIStore
      .getState()
      .select({ type: "clip", id: first.id, trackId: "preset-track" });
    await seedPreset("effect", "Cool Look", {
      kind: "effect",
      effects: [{ type: "blur", params: { radius: 18 } }],
    });
    render(<EffectsPanel />);

    fireEvent.doubleClick(
      await screen.findByRole("button", { name: "Cool Look" }),
    );

    await waitFor(() => {
      expect(
        useProjectStore.getState().project.timeline.tracks[0]!.clips[0]!
          .effects,
      ).toHaveLength(1);
    });
    expect(
      useProjectStore.getState().project.timeline.tracks[0]!.clips[0]!
        .effects[0],
    ).toMatchObject({ type: "blur", params: { radius: 18 } });
    expect(
      useNotificationStore
        .getState()
        .notifications.some(
          (notification) =>
            notification.type === "success" &&
            notification.title.includes("Cool Look"),
        ),
    ).toBe(true);

    // One undo unit: a single undo removes the whole applied stack.
    expect(useProjectStore.getState().canUndo()).toBe(true);
    await useProjectStore.getState().undo();
    expect(
      useProjectStore.getState().project.timeline.tracks[0]!.clips[0]!.effects,
    ).toHaveLength(0);
  });

  it("opens the context menu for custom cards (slot props reach the card root)", async () => {
    await seedPreset("effect", "Cool Look", {
      kind: "effect",
      effects: [{ type: "blur", params: { radius: 18 } }],
    });
    render(<EffectsPanel />);
    const card = await screen.findByRole("button", { name: "Cool Look" });
    fireEvent.contextMenu(card, { clientX: 20, clientY: 20 });
    const names = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(names).toEqual(["Apply to selected clips", "Rename", "Delete"]);
  });

  it("keeps rename-input keys and double-clicks from applying the preset", async () => {
    const preset = await seedPreset("effect", "Cool Look", {
      kind: "effect",
      effects: [{ type: "blur", params: { radius: 18 } }],
    });
    const onApply = vi.fn();
    let renaming = true;
    let draft = "Cool Look 2";
    const view = render(
      <CustomEffectPresetCard
        preset={preset}
        isRenaming={renaming}
        renameDraft={draft}
        onRenameDraftChange={(value) => (draft = value)}
        onRenameSubmit={() => undefined}
        onRenameCancel={() => undefined}
        onApply={onApply}
      />,
    );

    // While renaming, keys and double-clicks inside the rename input bubble
    // to the card and must never trigger the double-click apply.
    const input = screen.getByLabelText("Preset name");
    fireEvent.doubleClick(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onApply).not.toHaveBeenCalled();

    // Outside renaming, double-click applies (the documented card gesture).
    renaming = false;
    view.rerender(
      <CustomEffectPresetCard
        preset={preset}
        isRenaming={false}
        renameDraft={draft}
        onRenameDraftChange={(value) => (draft = value)}
        onRenameSubmit={() => undefined}
        onRenameCancel={() => undefined}
        onApply={onApply}
      />,
    );
    fireEvent.doubleClick(screen.getByRole("button", { name: "Cool Look" }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("pre-clamps an over-cap transition duration with a visible hint", async () => {
    // Two 1s clips: the placement cap is min(1, 1) * 2 = 2s.
    loadTwoClipProject(1);
    const first = useProjectStore.getState().project.timeline.tracks[0]!.clips[0]!;
    const second = useProjectStore.getState().project.timeline.tracks[0]!.clips[1]!;
    useUIStore.getState().selectMultiple([
      { type: "clip", id: first.id, trackId: "preset-track" },
      { type: "clip", id: second.id, trackId: "preset-track" },
    ]);
    const preset = await seedPreset("transition", "Long Wipe", {
      kind: "transition",
      type: "wipe",
      durationSec: 5,
      params: { direction: "right", softness: 0.2 },
    });

    const result = await applyTransitionPresetToSelectedCut(preset);

    expect(result.ok).toBe(true);
    expect(result.clamped).toEqual({
      requested: 5,
      applied: 2,
      maxDuration: 2,
    });
    const transition =
      useProjectStore.getState().project.timeline.tracks[0]!.transitions[0];
    expect(transition).toMatchObject({
      clipAId: "cut-a",
      clipBId: "cut-b",
      type: "wipe",
      duration: 2,
    });
    expect(transition?.params).toMatchObject({
      direction: "right",
      softness: 0.2,
    });
    expect(
      useNotificationStore
        .getState()
        .notifications.some(
          (notification) =>
            notification.type === "warning" &&
            notification.message?.includes("2s"),
        ),
    ).toBe(true);
  });

  it("deletes a custom preset only after a confirmation that states the isolation promise", async () => {
    const effectPreset = await seedPreset("effect", "Doomed Look", {
      kind: "effect",
      effects: [{ type: "blur", params: {} }],
    });
    const transitionPreset = await seedPreset("transition", "Doomed Cut", {
      kind: "transition",
      type: "crossfade",
      durationSec: 1,
      params: {},
    });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(
      await deleteCustomPresetWithConfirm(effectPreset, "assets.effectPresets"),
    ).toBe(false);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const confirmText = String(confirmSpy.mock.calls[0][0]);
    expect(confirmText).toContain("Doomed Look");
    expect(confirmText).toContain("NOT affected");
    expect(await storedNames("effect")).toEqual(["Doomed Look"]);

    confirmSpy.mockReturnValue(true);
    expect(
      await deleteCustomPresetWithConfirm(
        transitionPreset,
        "assets.transitionPresets",
      ),
    ).toBe(true);
    await waitFor(async () => {
      expect(await storedNames("transition")).toEqual([]);
    });
  });

  it("renames custom presets through the service with validation", async () => {
    const preset = await seedPreset("transition", "Old Cut", {
      kind: "transition",
      type: "crossfade",
      durationSec: 1,
      params: {},
    });

    expect(
      await renameCustomPreset(preset, "   ", "assets.transitionPresets"),
    ).toBe(false);
    expect(
      await renameCustomPreset(preset, "New Cut", "assets.transitionPresets"),
    ).toBe(true);
    await waitFor(async () => {
      expect(await storedNames("transition")).toEqual(["New Cut"]);
    });
  });
});
