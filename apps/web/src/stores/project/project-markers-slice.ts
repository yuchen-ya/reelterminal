import { v4 as uuidv4 } from "uuid";
import type { StoreApi } from "zustand";
import type { Action, ProjectMarker } from "@openreel/core";
import { DEFAULT_PROJECT_MARKER_COLOR } from "@openreel/core";
import type { ProjectState } from "../project-store";

type Get = StoreApi<ProjectState>["getState"];
type Set = StoreApi<ProjectState>["setState"];

export type ProjectMarkersSlice = Pick<
  ProjectState,
  "addProjectMarker" | "removeProjectMarker"
>;

/**
 * Persisted project review markers (`project.markers`) — distinct from the
 * ruler point markers in marker-slice (`project.timeline.markers`). The slice
 * mints the complete marker (stable number from `markers.nextNumber`) and
 * dispatches the core `projectMarker/*` actions so add/remove are undoable
 * through the standard history path.
 */
export function createProjectMarkersSlice(set: Set, get: Get): ProjectMarkersSlice {
  return {
    addProjectMarker: async (target, label) => {
      const { project, actionExecutor } = get();
      const marker: ProjectMarker = {
        id: `marker-${crypto.randomUUID()}`,
        number: project.markers?.nextNumber ?? 1,
        target,
        ...(label !== undefined ? { label } : {}),
        color: DEFAULT_PROJECT_MARKER_COLOR,
        createdAt: Date.now(),
      };
      const action: Action = {
        type: "projectMarker/add",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { marker },
      };
      const result = await actionExecutor.execute(action, project);
      if (result.success) {
        set({ project: { ...project, modifiedAt: Date.now() } });
      }
      return result;
    },

    removeProjectMarker: async (number) => {
      const { project, actionExecutor } = get();
      const items = project.markers?.items ?? [];
      const marker = items.find((candidate) => candidate.number === number);
      if (!marker) {
        const assigned = items
          .map((candidate) => candidate.number)
          .sort((a, b) => a - b);
        return {
          success: false,
          error: {
            code: "INVALID_PARAMS" as const,
            message: `projectMarker/remove: no marker with number ${number} — assigned marker numbers: ${
              assigned.length > 0 ? assigned.join(", ") : "(none)"
            }`,
            details: { number, assignedNumbers: assigned },
          },
        };
      }
      const action: Action = {
        type: "projectMarker/remove",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { markerId: marker.id },
      };
      const result = await actionExecutor.execute(action, project);
      if (result.success) {
        set({ project: { ...project, modifiedAt: Date.now() } });
      }
      return result;
    },
  };
}
