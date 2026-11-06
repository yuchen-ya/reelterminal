import { useLayoutEffect, useRef } from "react";
import type { TimelineState, UnitRef } from "./timeline";
import { taskSceneSuggestionSchema } from "../../../../../desktop/src/shared/task-review-schema";

export const viewKey = (root: string, taskId: string) => `task-review-view:${JSON.stringify([root, taskId])}`;

const isRef = (value: unknown): value is UnitRef => {
  if (!value || typeof value !== "object") return false;
  const ref = value as Partial<UnitRef>;
  return typeof ref.unitId === "string" && typeof ref.sourceVersionId === "string" && typeof ref.purpose === "string";
};

/** Renderer-only navigation preference; drafts and decisions remain in main. */
export function readTimeline(key: string): TimelineState | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (problem) { if (problem instanceof SyntaxError) return null; throw problem; }
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<TimelineState>;
  if (!Array.isArray(state.visited) || !state.visited.every(isRef)) return null;
  if (!Array.isArray(state.planAnchors) || state.planAnchors.length !== state.visited.length || !state.planAnchors.every((id) => id === null || typeof id === "string")) return null;
  // Additive recovery for the pre-scene GUI baseline stored in this profile.
  state.sceneAnchors ??= state.visited.map(() => null);
  state.workAnchors ??= state.visited.map(() => null);
  state.focus ??= null;
  state.sceneSelections ??= {};
  if (!Array.isArray(state.sceneAnchors) || state.sceneAnchors.length !== state.visited.length ||
      !state.sceneAnchors.every((scene) => scene === null || taskSceneSuggestionSchema.safeParse(scene).success)) return null;
  if (!Array.isArray(state.workAnchors) || state.workAnchors.length !== state.visited.length || !state.workAnchors.every((ref) => ref === null || isRef(ref))) return null;
  if (state.focus !== null && !isRef(state.focus)) return null;
  if (typeof state.sceneSelections !== "object" || !Object.values(state.sceneSelections).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"))) return null;
  const isFrame = (frame: Partial<TimelineState>) =>
    (frame.position === null || (Number.isInteger(frame.position) && frame.position! >= 0 && frame.position! < state.visited!.length)) &&
    (frame.overlay === null || frame.overlay === "directory" || frame.overlay === "global") && typeof frame.editing === "boolean";
  if (!isFrame(state) || !Array.isArray(state.returns) || !state.returns.every((frame) => {
    frame.focus ??= null;
    return isFrame(frame) && (frame.focus === null || isRef(frame.focus));
  })) return null;
  return state as TimelineState;
}

export function useSceneScroll<T extends HTMLElement>(key: string, ready = true) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    if (!ready) return;
    const value = Number(localStorage.getItem(key));
    if (ref.current && Number.isFinite(value) && value >= 0) ref.current.scrollTop = value;
  }, [key, ready]);
  return { ref, onScroll: () => { if (ref.current) localStorage.setItem(key, String(ref.current.scrollTop)); } };
}
