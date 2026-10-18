import { describe, expect, it } from "vitest";
import { ActionExecutor } from "./action-executor";
import { ActionHistory } from "./action-history";
import { ProjectSerializer, normalizeProjectStoredFields } from "../storage/project-serializer";
import type { IStorageEngine } from "../storage/types";
import type { Project, CollaborationInstruction, Action } from "../types";

const instruction: CollaborationInstruction = {
  id: "instruction-1", title: "Guide visually", description: "Offer a short prototype first.",
  enabled: true, createdAt: 1, updatedAt: 1,
  references: [{ kind: "media", entityId: "source-1", ref: "R44", label: "Reference", timing: { startSeconds: 94, endSeconds: 106 } }],
};
const project = (): Project => ({
  id: "p1", name: "Instructions", createdAt: 1, modifiedAt: 1,
  settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
  mediaLibrary: { items: [] }, timeline: { duration: 0, tracks: [], subtitles: [], markers: [] },
});
const set = (items: readonly CollaborationInstruction[]): Action => ({
  type: "project/setCollaborationInstructions", id: crypto.randomUUID(), timestamp: Date.now(), params: { instructions: { items } },
});

describe("collaboration instruction persistence and history", () => {
  it("keeps legacy projects empty and round-trips user text and stable references", () => {
    const serializer = new ProjectSerializer({} as IStorageEngine);
    expect(serializer.importFromJson(serializer.exportToJson(project())).collaborationInstructions).toBeUndefined();
    const value = { ...project(), collaborationInstructions: { items: [instruction] } };
    expect(serializer.importFromJson(serializer.exportToJson(value)).collaborationInstructions).toEqual(value.collaborationInstructions);
  });

  it("undoes and redoes add, disable and delete without creating tasks", async () => {
    const value = project();
    const executor = new ActionExecutor(new ActionHistory());
    expect((await executor.execute(set([instruction]), value)).success).toBe(true);
    expect((await executor.undo(value)).success).toBe(true);
    expect(value.collaborationInstructions).toBeUndefined();
    expect((await executor.redo(value)).success).toBe(true);
    expect(value.collaborationInstructions?.items).toEqual([instruction]);
    expect((await executor.execute(set([{ ...instruction, enabled: false, updatedAt: 2 }]), value)).success).toBe(true);
    expect(value.collaborationInstructions?.items[0].enabled).toBe(false);
    await executor.undo(value);
    expect(value.collaborationInstructions?.items[0].enabled).toBe(true);
    await executor.execute(set([]), value);
    expect(value.collaborationInstructions?.items).toEqual([]);
    await executor.undo(value);
    expect(value.collaborationInstructions?.items).toEqual([instruction]);
    expect(value.requirements).toBeUndefined();
  });

  it.each([
    [{ ...instruction, description: "" }],
    [{ ...instruction, title: "x".repeat(81) }],
    [{ ...instruction, description: "x".repeat(2001) }],
    [instruction, instruction],
    Array.from({ length: 21 }, (_, i) => ({ ...instruction, id: String(i) })),
    [{ ...instruction, references: [{ ...instruction.references![0], timing: { startSeconds: 10, endSeconds: 5 } }] }],
  ])("rejects invalid instructions at action and import boundaries: %j", async (...items) => {
    const value = project();
    expect((await new ActionExecutor().execute(set(items), value)).success).toBe(false);
    expect(value.collaborationInstructions).toBeUndefined();
    expect(() => normalizeProjectStoredFields({ ...value, collaborationInstructions: { items } })).toThrow("Invalid project collaboration instructions");
  });
});
