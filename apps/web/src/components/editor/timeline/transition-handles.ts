import type { Clip, Track, Transition, TransitionEdge } from "@reelterminal/core";

export const TRANSITION_ADJACENCY_TOLERANCE = 0.05;

export interface ResolvedTransitionHandle {
  clipA: Clip;
  clipB?: Clip;
  edge?: TransitionEdge;
  centerX: number;
  transition?: Transition;
  /**
   * A saved pair transition whose clips drifted apart (beyond the adjacency
   * tolerance). It still blends in the engine but sits on a gap, so the
   * handle is emitted (dimmed in the UI) to keep it selectable/removable.
   */
  stale?: boolean;
}

export function resolveTransitionHandles(
  track: Track,
  pixelsPerSecond: number,
): ResolvedTransitionHandle[] {
  const sorted = [...track.clips].sort(
    (a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id),
  );
  const handles: ResolvedTransitionHandle[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const clipA = sorted[i];
    const clipB = sorted[i + 1];
    const gap = Math.abs(clipB.startTime - (clipA.startTime + clipA.duration));
    const transition = track.transitions.find(
      (t) => t.clipAId === clipA.id && t.clipBId === clipB.id,
    );
    if (gap > TRANSITION_ADJACENCY_TOLERANCE) {
      // A saved transition on a drifted pair must stay reachable so the user
      // can select or remove it. Pairs without a transition get no handle.
      if (!transition) continue;
      handles.push({
        clipA,
        clipB,
        transition,
        stale: true,
        centerX:
          ((clipA.startTime + clipA.duration + clipB.startTime) / 2) *
          pixelsPerSecond,
      });
      continue;
    }

    handles.push({
      clipA,
      clipB,
      transition,
      centerX: clipB.startTime * pixelsPerSecond,
    });
  }

  for (const transition of track.transitions) {
    if (transition.clipBId) continue;
    const clip = sorted.find((candidate) => candidate.id === transition.clipAId);
    if (!clip) continue;
    const edge = transition.edge ?? "out";
    handles.push({
      clipA: clip,
      edge,
      transition,
      centerX:
        (edge === "in" ? clip.startTime : clip.startTime + clip.duration) *
        pixelsPerSecond,
    });
  }

  return handles.sort((a, b) => a.centerX - b.centerX);
}
