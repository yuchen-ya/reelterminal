import { v4 as uuidv4 } from "uuid";
import type { StoreApi } from "zustand";
import type { Action } from "@reelterminal/core";
import type { ProjectState } from "../project-store";

type Get = StoreApi<ProjectState>["getState"];
type Set = StoreApi<ProjectState>["setState"];

export type MarkerSlice = Pick<
  ProjectState,
  "addMarker" | "removeMarker" | "updateMarker" | "getMarker" | "getMarkers"
>;

export function createMarkerSlice(_set: Set, get: Get): MarkerSlice {
  return {
    addMarker: async (time, label = "Marker", color = "#3b82f6") => {
      const action: Action = {
        type: "marker/add",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { time, label, color },
      };
      return get().executeAction(action);
    },

    removeMarker: async (markerId) => {
      const action: Action = {
        type: "marker/remove",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { markerId },
      };
      return get().executeAction(action);
    },

    updateMarker: async (markerId, updates) => {
      const action: Action = {
        type: "marker/update",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { markerId, updates },
      };
      return get().executeAction(action);
    },

    getMarker: (markerId) =>
      get().project.timeline.markers.find((m) => m.id === markerId),

    getMarkers: () => get().project.timeline.markers,
  };
}
