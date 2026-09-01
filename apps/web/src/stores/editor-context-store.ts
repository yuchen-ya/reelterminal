import { create } from "zustand";
// Subpath import (not the package index) so the web bundle never pulls in the
// facade's node-only session module.
import type { LiveEditorContext } from "@openreel/agent-facade/live-store";
import { useTimelineStore } from "./timeline-store";
import { useUIStore } from "./ui-store";

/**
 * ADR 0004 Decision 4: ephemeral editor context shared with live agent
 * sessions. Playhead and selection are NOT duplicated here — they are read
 * from the source stores on demand; this store only owns the two pieces of
 * context that have no other home (canvas target point, selected time range)
 * plus the monotonic contextRevision. Nothing here is persisted.
 */

export type { LiveEditorContext } from "@openreel/agent-facade/live-store";

export interface CanvasPoint {
  readonly x: number; // normalized 0..1 against the project frame
  readonly y: number;
}

export interface EditorTimeRange {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

interface EditorContextState {
  readonly contextRevision: number;
  readonly canvasPoint: CanvasPoint | null;
  readonly timeRange: EditorTimeRange | null;
  setCanvasPoint: (point: CanvasPoint) => void;
  clearCanvasPoint: () => void;
  setTimeRange: (range: EditorTimeRange) => void;
  clearTimeRange: () => void;
}

const samePoint = (a: CanvasPoint | null, b: CanvasPoint | null): boolean =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y);

const sameRange = (
  a: EditorTimeRange | null,
  b: EditorTimeRange | null,
): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.startSeconds === b.startSeconds &&
    a.endSeconds === b.endSeconds);

export const useEditorContextStore = create<EditorContextState>()((set, get) => {
  const bump = (): void => {
    set({ contextRevision: get().contextRevision + 1 });
  };

  return {
    contextRevision: 0,
    canvasPoint: null,
    timeRange: null,

    setCanvasPoint: (point) => {
      if (samePoint(get().canvasPoint, point)) return;
      set({ canvasPoint: { x: point.x, y: point.y } });
      bump();
    },

    clearCanvasPoint: () => {
      if (get().canvasPoint === null) return;
      set({ canvasPoint: null });
      bump();
    },

    setTimeRange: (range) => {
      if (sameRange(get().timeRange, range)) return;
      set({
        timeRange: {
          startSeconds: range.startSeconds,
          endSeconds: range.endSeconds,
        },
      });
      bump();
    },

    clearTimeRange: () => {
      if (get().timeRange === null) return;
      set({ timeRange: null });
      bump();
    },
  };
});

// contextRevision tracks every derived value: the two owned here (via the
// setters above) and the two read from source stores (via subscriptions).
useTimelineStore.subscribe((state, prevState) => {
  if (state.playheadPosition !== prevState.playheadPosition) {
    useEditorContextStore.setState((s) => ({
      contextRevision: s.contextRevision + 1,
    }));
  }
});

useUIStore.subscribe((state, prevState) => {
  if (state.selectedItems !== prevState.selectedItems) {
    useEditorContextStore.setState((s) => ({
      contextRevision: s.contextRevision + 1,
    }));
  }
});

/**
 * Snapshot of the live editor context for the live bridge / facade
 * `editor.get_context` verb. Selection types map onto the facade's two buckets:
 * "text-clip" → selectedTextIds; timeline/canvas clip-likes ("clip",
 * "shape-clip") → selectedClipIds; non-item selections (track, effect,
 * keyframe, marker, …) are not item selections and are omitted.
 */
export function getLiveEditorContext(): LiveEditorContext {
  const { contextRevision, canvasPoint, timeRange } =
    useEditorContextStore.getState();
  const selectedItems = useUIStore.getState().selectedItems;

  return {
    contextRevision,
    playheadSeconds: useTimelineStore.getState().playheadPosition,
    selectedClipIds: selectedItems
      .filter((item) => item.type === "clip" || item.type === "shape-clip")
      .map((item) => item.id),
    selectedTextIds: selectedItems
      .filter((item) => item.type === "text-clip")
      .map((item) => item.id),
    timeRange,
    canvasPoint,
  };
}
