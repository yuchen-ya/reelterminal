import { COLLABORATION_INSTRUCTION_LIMITS, type MaterialRecord } from "@reelterminal/core";
import type { StoreApi } from "zustand";
import type { ProjectState } from "../../stores/project-store";

/** A library entry is copied; subsequent library edits never change the project. */
export async function addLibraryInstruction(store: StoreApi<ProjectState>, record: MaterialRecord) {
  if (record.kind !== "instruction") throw new Error("Expected an instruction");
  const projectId = store.getState().project.id;
  const submit = () => {
    const state = store.getState();
    if (state.project.id !== projectId) throw new Error("Project changed");
    const items = state.project.collaborationInstructions?.items ?? [];
    if (items.length >= COLLABORATION_INSTRUCTION_LIMITS.items) throw new Error("Instruction limit reached");
    const now = Date.now();
    return state.executeActionBatch([{
      type: "project/setCollaborationInstructions", id: crypto.randomUUID(), timestamp: now,
      params: { instructions: { items: [...items, {
        id: crypto.randomUUID(), title: record.title, description: record.prompt,
        enabled: true, references: [], createdAt: now, updatedAt: now,
      }] } },
    }], { groupLabel: "Add collaboration instruction", historyOwner: "human" }).result;
  };
  const result = await (store.getState().submitWorkspaceMutation?.(submit) ?? submit());
  if (!result.success) throw new Error(result.error?.message ?? "Unable to add instruction");
}
