import "../../test/install-local-storage-mock";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomPresetRecord } from "@reelterminal/core/presets/types";
import { PRESET_PAYLOAD_SCHEMA_VERSION } from "@reelterminal/core/presets/types";
import type { PresetStorage } from "../../services/custom-presets/storage";
import {
  CustomPresetService,
  setCustomPresetServiceForTests,
} from "../../services/custom-presets/preset-service";
import {
  applyTextPresetToSelectedClip,
  deleteTextPresetWithConfirm,
  dedupePresetName,
  renameTextPreset,
  TextPresetsPanel,
} from "./panels/TextPresetsPanel";
import { useEngineStore } from "../../stores/engine-store";
import { useNotificationStore } from "../../stores/notification-store";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { useProjectStore } from "../../stores/project-store";
import { useTimelineStore } from "../../stores/timeline-store";
import { useUIStore } from "../../stores/ui-store";
import { AssetsPanel } from "./AssetsPanel";

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

function textPayload(style: Record<string, unknown>, sampleText?: string) {
  return {
    schemaVersion: PRESET_PAYLOAD_SCHEMA_VERSION,
    kind: "text" as const,
    style,
    ...(sampleText !== undefined ? { sampleText } : {}),
  };
}

async function seedTextPreset(
  name: string,
  style: Record<string, unknown>,
  sampleText?: string,
): Promise<CustomPresetRecord> {
  const result = await getTestService().create({
    kind: "text",
    name,
    payload: textPayload(style, sampleText),
  });
  if (!result.ok) throw new Error(`seed failed: ${result.message}`);
  return result.value;
}

let testService: CustomPresetService;

function getTestService(): CustomPresetService {
  if (!testService) throw new Error("test service not initialised");
  return testService;
}

async function storedNames(): Promise<string[]> {
  const list = await getTestService().list("text");
  if (!list.ok) throw new Error(list.message);
  return list.value.presets.map((record) => record.name);
}

function renderTextTab() {
  const view = render(<AssetsPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Text" }));
  return view;
}

async function addTitleViaUi(): Promise<string> {
  fireEvent.click(screen.getByRole("button", { name: "Add Title" }));
  await waitFor(() => {
    const ids = useUIStore.getState().getSelectedClipIds();
    expect(ids).toHaveLength(1);
  });
  return useUIStore.getState().getSelectedClipIds()[0];
}

function textClips() {
  return useProjectStore.getState().project.textClips ?? [];
}

describe("AssetsPanel text presets (built-in + custom merge)", () => {
  beforeEach(() => {
    const titleEngine = useEngineStore.getState().getTitleEngine();
    titleEngine?.getAllTextClips().forEach((clip) => {
      titleEngine.deleteTextClip(clip.id);
    });
    testService = new CustomPresetService(makeMemoryStorage());
    setCustomPresetServiceForTests(testService);
    useProjectStore.setState({
      hasOpenProject: true,
      project: createEmptyProject("Text presets"),
    });
    useTimelineStore.setState({ playheadPosition: 1.5 });
    useUIStore.getState().clearSelection();
    useNotificationStore.getState().clearAll();
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    useUIStore.getState().clearSelection();
    useNotificationStore.getState().clearAll();
    setCustomPresetServiceForTests(null);
    testService = undefined as unknown as CustomPresetService;
    useProjectStore.setState({
      hasOpenProject: false,
      project: createEmptyProject("Reset"),
    });
  });

  it("shows built-in presets read-only and merges custom presets into the same panel", async () => {
    await seedTextPreset("My Intro", { fontSize: 77, color: "#ff8800" }, "Intro text");
    const { container } = renderTextTab();

    // Built-ins render with their group header.
    expect(screen.getByText("Built-in")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Heading" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Badge" })).toBeInTheDocument();

    // The custom preset renders in the custom group with its card.
    await waitFor(() => {
      expect(
        container.querySelector('[data-text-preset-id]'),
      ).not.toBeNull();
    });
    expect(screen.getByText("Custom")).toBeInTheDocument();
    expect(screen.getByText("Intro text")).toBeInTheDocument();
  });

  it("creates a new text clip from a custom preset click with the payload style", async () => {
    await seedTextPreset("Punch Line", { fontSize: 64, fontWeight: 900 }, "BOOM");
    renderTextTab();

    fireEvent.click(await screen.findByRole("button", { name: "Punch Line" }));

    await waitFor(() => {
      expect(textClips()).toHaveLength(1);
    });
    expect(textClips()[0]).toMatchObject({
      text: "BOOM",
      style: expect.objectContaining({ fontSize: 64, fontWeight: 900 }),
    });
    expect(useUIStore.getState().getSelectedClipIds()).toEqual([textClips()[0].id]);
  });

  it("applies a custom preset to the selected clip as one undoable text/update batch", async () => {
    renderTextTab();
    const clipId = await addTitleViaUi();
    const preset = await seedTextPreset(
      "Accent",
      { fontSize: 77, color: "#ff0000", fontFamily: "Inter" },
    );

    const applied = await applyTextPresetToSelectedClip(preset);
    expect(applied).toBe(true);

    await waitFor(() => {
      const style = textClips().find((clip) => clip.id === clipId)?.style;
      expect(style?.fontSize).toBe(77);
      expect(style?.color).toBe("#ff0000");
    });
    // Merge, not replace: fields untouched by the preset keep their values.
    const style = textClips().find((clip) => clip.id === clipId)?.style;
    expect(style?.textAlign).toBe("center");

    // One undo unit: a single undo step restores the prior style.
    expect(useProjectStore.getState().canUndo()).toBe(true);
    await useProjectStore.getState().undo();
    const restored = textClips().find((clip) => clip.id === clipId)?.style;
    expect(restored?.fontSize).not.toBe(77);
  });

  it("saves the selected style as a preset and reports whitelist-external fields explicitly", async () => {
    renderTextTab();
    const clipId = await addTitleViaUi();
    useProjectStore.getState().updateTextStyle(clipId, {
      shader: { shaderId: "glow", params: {} },
    });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Save Selected Style as Preset" }),
    );

    // The unsupported field is called out, never silently dropped.
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy.mock.calls[0][0]).toContain("shader");

    const nameInput = await screen.findByLabelText("Preset name");
    fireEvent.change(nameInput, { target: { value: "Shader Look" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Preset" }));

    await waitFor(async () => {
      expect(await storedNames()).toEqual(["Shader Look"]);
    });
    const list = await getTestService().list("text");
    if (!list.ok) throw new Error(list.message);
    const payload = list.value.presets[0].payload as {
      kind: string;
      style: Record<string, unknown>;
      sampleText?: string;
    };
    expect(payload.kind).toBe("text");
    expect(payload.style).not.toHaveProperty("shader");
    expect(payload.style).toMatchObject({ fontSize: 96, fontWeight: 800 });
    expect(payload.sampleText).toBe("New Title");
  });

  it("does not save when the unsupported-field confirmation is declined", async () => {
    renderTextTab();
    const clipId = await addTitleViaUi();
    useProjectStore.getState().updateTextStyle(clipId, {
      shader: { shaderId: "glow", params: {} },
    });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Save Selected Style as Preset" }),
    );
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));

    expect(screen.queryByLabelText("Preset name")).not.toBeInTheDocument();
    expect(await storedNames()).toEqual([]);
  });

  it("deletes a custom preset only after a confirmation that states the isolation promise", async () => {
    const preset = await seedTextPreset("Doomed", { fontSize: 40 });
    renderTextTab();
    await screen.findByRole("button", { name: "Doomed" });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(await deleteTextPresetWithConfirm(preset)).toBe(false);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const confirmText = confirmSpy.mock.calls[0][0];
    expect(confirmText).toContain("Doomed");
    expect(confirmText).toContain("NOT affected");
    expect(await storedNames()).toEqual(["Doomed"]);

    confirmSpy.mockReturnValue(true);
    expect(await deleteTextPresetWithConfirm(preset)).toBe(true);
    await waitFor(async () => {
      expect(await storedNames()).toEqual([]);
    });
  });

  it("renames a custom preset through the service with validation", async () => {
    const preset = await seedTextPreset("Old Name", { fontSize: 40 });
    renderTextTab();
    await screen.findByRole("button", { name: "Old Name" });

    expect(await renameTextPreset(preset, "   ")).toBe(false);
    expect(await renameTextPreset(preset, "New Name")).toBe(true);
    await waitFor(async () => {
      expect(await storedNames()).toEqual(["New Name"]);
    });

    // Rejecting keeps the stored name intact.
    const list = await getTestService().list("text");
    if (!list.ok) throw new Error(list.message);
    expect(list.value.presets[0].name).toBe("New Name");
  });

  it("suffixes duplicate preset names following the custom-font convention", () => {
    expect(dedupePresetName("My Preset", [])).toBe("My Preset");
    expect(dedupePresetName("My Preset", ["My Preset"])).toBe("My Preset 2");
    expect(dedupePresetName("My Preset", ["my preset", "My Preset 2"])).toBe(
      "My Preset 3",
    );
    expect(dedupePresetName("  spaced  ", [])).toBe("spaced");
  });

  it("renders the standalone panel section without a project selection crash", async () => {
    render(<TextPresetsPanel />);
    expect(screen.getByText("Built-in")).toBeInTheDocument();
    expect(screen.getByText("Custom")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Heading" })).toBeInTheDocument();
    });
  });
});
