import { v4 as uuidv4 } from "uuid";
import type { StoreApi } from "zustand";
import type {
  Action,
  ProjectRequirement,
  ProjectRequirementPatch,
} from "@reelterminal/core";
import type { ProjectState } from "../project-store";

type Get = StoreApi<ProjectState>["getState"];
type Set = StoreApi<ProjectState>["setState"];

export interface CreateProjectRequirementInput {
  readonly reviewRange?: ProjectRequirement["reviewRange"];
  readonly title: string;
  readonly description?: string;
  readonly instruction?: string;
  readonly priority?: ProjectRequirement["priority"];
  readonly status?: ProjectRequirement["status"];
  readonly references?: ProjectRequirement["references"];
  readonly markerIds?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
}

export type ProjectRequirementsSlice = Pick<
  ProjectState,
  "addProjectRequirement" | "updateProjectRequirement" | "removeProjectRequirement"
>;

export function createProjectRequirementsSlice(
  _set: Set,
  get: Get,
): ProjectRequirementsSlice {
  return {
    addProjectRequirement: async (input) => {
      const add = () => {
      const project = get().project;
      const number = project.requirements?.nextNumber ?? 1;
      const now = Date.now();
      const requirement: ProjectRequirement = {
        id: `requirement-${crypto.randomUUID()}`,
        number,
        title: input.title.trim(),
        description: input.description?.trim() ?? "",
        ...(input.instruction?.trim() ? { instruction: input.instruction.trim() } : {}),
        priority: input.priority ?? "normal",
        status: input.status ?? "ready",
        references: structuredClone(input.references ?? []),
        ...(input.reviewRange ? { reviewRange: structuredClone(input.reviewRange) } : {}),
        markerIds: [...(input.markerIds ?? [])],
        ...(input.acceptanceCriteria?.length
          ? { acceptanceCriteria: input.acceptanceCriteria.map((item) => item.trim()).filter(Boolean) }
          : {}),
        createdAt: now,
        updatedAt: now,
      };
      const action: Action = {
        type: "requirement/add",
        id: uuidv4(),
        timestamp: now,
        params: { requirement },
      };
      return get().executeActionBatch([action], {
        groupLabel: "Add project requirement",
        historyOwner: "human",
      }).result;
      };
      const submit = get().submitWorkspaceMutation;
      return submit ? submit(add) : add();
    },
    updateProjectRequirement: (requirementId, patch: ProjectRequirementPatch) =>
      get().executeAction({
        type: "requirement/update",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { requirementId, patch },
      }),
    removeProjectRequirement: (requirementId) =>
      get().executeAction({
        type: "requirement/remove",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { requirementId },
      }),
  };
}
