import { v4 as uuidv4 } from "uuid";
import type { StoreApi } from "zustand";
import type { Action, ProjectMarker } from "@reelterminal/core";
import { DEFAULT_PROJECT_MARKER_COLOR } from "@reelterminal/core";
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
export function createProjectMarkersSlice(_set: Set, get: Get): ProjectMarkersSlice {
  return {
    addProjectMarker: async (target, label) => {
      const add = () => {
      const project = get().project;
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
      return get().executeActionBatch([action], {
        groupLabel: "Add project marker",
        historyOwner: "human",
      }).result;
      };
      const submit = get().submitWorkspaceMutation;
      return submit ? submit(add) : add();
    },

    removeProjectMarker: async (number) => {
      const remove = () => {
      const project = get().project;
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
      return get().executeActionBatch([action], {
        groupLabel: "Remove project marker",
        historyOwner: "human",
      }).result;
      };
      const submit = get().submitWorkspaceMutation;
      return submit ? submit(remove) : remove();
    },
  };
}
