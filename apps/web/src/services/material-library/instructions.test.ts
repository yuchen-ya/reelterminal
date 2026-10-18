import { describe, expect, it } from "vitest";
import { buildMaterialRecord, applyMaterialUpdate } from "@reelterminal/core";
import { createProjectStore } from "../../stores/project-store";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { addLibraryInstruction } from "./instructions";

describe("instruction library copies", () => {
  it("copies text without project references, stays independent, and participates in project undo", async () => {
    const store = createProjectStore({ initialProject: createEmptyProject("Instructions"), isForeground: false });
    const preset = buildMaterialRecord({ kind: "instruction", actor: "user", title: "Preview first", prompt: "Show a sample before producing the whole video." });
    await addLibraryInstruction(store, preset);
    const copy = store.getState().project.collaborationInstructions!.items[0]!;
    expect(copy).toMatchObject({ title: preset.title, description: "Show a sample before producing the whole video.", references: [] });
    expect(copy.id).not.toBe(preset.id);
    const changedPreset = applyMaterialUpdate(preset, { prompt: "New instructions" }, "user");
    expect(changedPreset).toHaveProperty("prompt", "New instructions");
    expect(store.getState().project.collaborationInstructions!.items[0]!.description).toBe(copy.description);
    await store.getState().undo();
    expect(store.getState().project.collaborationInstructions?.items ?? []).toEqual([]);
    expect(changedPreset).toHaveProperty("prompt", "New instructions");
  });
});
