import { create } from "zustand";
// Subpath import (not the package index) so the web bundle never pulls in the
// facade's node-only session module.
import type { LiveEditorContext } from "@reelterminal/agent-facade/live-store";
import type { Project } from "@reelterminal/core";
import { getProjectRevision, useProjectStore } from "./project-store";
import { useTimelineStore } from "./timeline-store";
import { useUIStore } from "./ui-store";
import {
  getAgentReferenceTargetForClip,
  getAgentReferenceTargetForGraphic,
  getAgentReferenceTargetForMedia,
  getAgentReferenceTargetForText,
  getAgentReferenceTargetsForProject,
  getAgentReferenceTargetsForSelection,
} from "./agent-reference-targets";
import {
  useAgentReferencesStore,
  type AgentReferenceTarget,
  type MarkedAgentReference,
} from "./agent-references-store";

/**
 * ADR 0004 Decision 4: ephemeral editor context shared with live agent
 * sessions. Playhead and selection are NOT duplicated here — they are read
 * from the source stores on demand; this store only owns the two pieces of
 * context that have no other home (canvas target point, selected time range)
 * plus the monotonic contextRevision. Agent references are kept in a sibling
 * in-memory store and projected here. Nothing is persisted.
 */

export type { LiveEditorContext } from "@reelterminal/agent-facade/live-store";

export interface CanvasPoint {
  readonly x: number; // normalized 0..1 against the project frame
  readonly y: number;
}

export interface EditorTimeRange {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export type { AgentReferenceTarget, MarkedAgentReference } from "./agent-references-store";

interface EditorContextState {
  readonly contextRevision: number;
  readonly canvasPoint: CanvasPoint | null;
  readonly timeRange: EditorTimeRange | null;
  readonly references: Readonly<Record<string, MarkedAgentReference>>;
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
    references: {},

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

// Keep the public context store synchronized with the dedicated reference
// store. This is intentionally not persisted and never participates in the
// project's ActionHistory.
useAgentReferencesStore.subscribe((state) => {
  useEditorContextStore.setState((current) => ({
    references: state.references,
    contextRevision:
      current.references === state.references
        ? current.contextRevision
        : current.contextRevision + 1,
  }));
});

/** Add one or more references using the current project revision. */
export function markAgentReferences(
  targets: readonly AgentReferenceTarget[],
): MarkedAgentReference[] {
  const before = useAgentReferencesStore.getState().references;
  const marked = useAgentReferencesStore
    .getState()
    .mark(targets, getProjectRevision());
  // Zustand subscriptions fire synchronously, but keep this fallback for
  // stores that are replaced in tests or during hot reload.
  if (before === useAgentReferencesStore.getState().references) {
    useEditorContextStore.setState({
      references: useAgentReferencesStore.getState().references,
    });
  }
  return marked;
}

export function markAgentReferenceForClip(
  clip: Parameters<typeof getAgentReferenceTargetForClip>[1],
  track: Parameters<typeof getAgentReferenceTargetForClip>[2],
): MarkedAgentReference[] {
  const project = useProjectStore.getState().project;
  const target = getAgentReferenceTargetForClip(project, clip, track);
  return target ? markAgentReferences([target]) : [];
}

export function markAgentReferenceForText(
  clip: Parameters<typeof getAgentReferenceTargetForText>[1],
): MarkedAgentReference[] {
  return markAgentReferences([
    getAgentReferenceTargetForText(useProjectStore.getState().project, clip),
  ]);
}

export function markAgentReferenceForGraphic(
  clip: Parameters<typeof getAgentReferenceTargetForGraphic>[1],
): MarkedAgentReference[] {
  return markAgentReferences([
    getAgentReferenceTargetForGraphic(useProjectStore.getState().project, clip),
  ]);
}

export function markAgentReferenceForMedia(
  item: Parameters<typeof getAgentReferenceTargetForMedia>[1],
): MarkedAgentReference[] {
  return markAgentReferences([
    getAgentReferenceTargetForMedia(useProjectStore.getState().project, item),
  ]);
}

/** Resolve and mark the clicked item plus any selected siblings. */
export function markAgentReferenceForSelection(
  clicked: AgentReferenceTarget,
  selectedItems = useUIStore.getState().selectedItems,
  project: Project = useProjectStore.getState().project,
): MarkedAgentReference[] {
  return markAgentReferences(
    getAgentReferenceTargetsForSelection(project, selectedItems, clicked),
  );
}

export function resetAgentReferences(): void {
  useAgentReferencesStore.getState().reset();
  // The subscription above propagates the reset and bumps contextRevision.
}

function syncAgentReferenceStaleness(project: Project): void {
  useAgentReferencesStore
    .getState()
    .syncStale(getAgentReferenceTargetsForProject(project));
}

// A project switch starts a fresh editor session. Ordinary edits only mark
// removed entities stale; their numbers remain reserved for the session.
useProjectStore.subscribe((state, previousState) => {
  if (
    state.hasOpenProject !== previousState.hasOpenProject ||
    state.project.id !== previousState.project.id
  ) {
    resetAgentReferences();
    return;
  }
  if (state.project !== previousState.project) {
    syncAgentReferenceStaleness(state.project);
  }
});

// contextRevision tracks meaningful derived context changes: the two owned
// here (via the setters above), selection changes, and explicit seek/scrub
// intent. Ordinary playback clock ticks update playheadPosition for rendering
// but deliberately do not invalidate an editor-context CAS guard every frame.
useTimelineStore.subscribe((state, prevState) => {
  if (state.playheadInteractionRevision !== prevState.playheadInteractionRevision) {
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
  syncAgentReferenceStaleness(useProjectStore.getState().project);
  const { contextRevision, canvasPoint, timeRange, references } =
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
    selectedMediaIds: selectedItems
      .filter((item) => item.type === "media")
      .map((item) => item.id),
    timeRange,
    canvasPoint,
    references,
  };
}
