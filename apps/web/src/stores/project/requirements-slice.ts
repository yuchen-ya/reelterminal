import { v4 as uuidv4 } from "uuid";
import type { StoreApi } from "zustand";
import type {
  Action,
  ActionResult,
  ProjectRequirement,
  ProjectRequirementPatch,
} from "@reelterminal/core";
import type { ProjectState } from "../project-store";

type Get = StoreApi<ProjectState>["getState"];
type Set = StoreApi<ProjectState>["setState"];

export interface CreateProjectRequirementInput {
  readonly title: string;
  readonly description?: string;
  readonly instruction?: string;
  readonly priority?: ProjectRequirement["priority"];
  readonly status?: ProjectRequirement["status"];
  readonly markerIds?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
}

export type ProjectRequirementsSlice = Pick<
  ProjectState,
  "addProjectRequirement" | "updateProjectRequirement" | "removeProjectRequirement"
>;

export function createProjectRequirementsSlice(
  set: Set,
  get: Get,
): ProjectRequirementsSlice {
  const execute = async (action: Action): Promise<ActionResult> => {
    const { project, actionExecutor } = get();
    const result = await actionExecutor.execute(action, project);
    if (result.success) set({ project: { ...project, modifiedAt: Date.now() } });
    return result;
  };
  return {
    addProjectRequirement: async (input) => {
      const { project } = get();
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
        markerIds: [...(input.markerIds ?? [])],
        ...(input.acceptanceCriteria?.length
          ? { acceptanceCriteria: input.acceptanceCriteria.map((item) => item.trim()).filter(Boolean) }
          : {}),
        createdAt: now,
        updatedAt: now,
      };
      return execute({
        type: "requirement/add",
        id: uuidv4(),
        timestamp: now,
        params: { requirement },
      });
    },
    updateProjectRequirement: (requirementId, patch: ProjectRequirementPatch) =>
      execute({
        type: "requirement/update",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { requirementId, patch },
      }),
    removeProjectRequirement: (requirementId) =>
      execute({
        type: "requirement/remove",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { requirementId },
      }),
  };
}
