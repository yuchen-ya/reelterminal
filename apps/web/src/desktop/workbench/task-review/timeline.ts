import type { TaskReviewSnapshot, TaskSceneSuggestion, TaskVisit } from "../../../../../desktop/src/shared/task-review";
import { isTaskSceneCurrent } from "../../../../../desktop/src/shared/task-review-selectors";
import {
  currentSourceIds,
  planSteps,
  remainingPlanSteps,
  REVIEW_PURPOSE,
  unitDecisionState,
  planScenes,
  pendingSceneTargets,
  initialSceneTarget,
} from "./queries";

export interface UnitRef {
  unitId: string;
  sourceVersionId: string;
  purpose: string;
}

export type TemporaryScene = "global" | "directory";

export interface TimelineState {
  /** Units actually opened, oldest first. Fresh sessions seed from persisted visits. */
  visited: UnitRef[];
  /** Plan revision at each working anchor; later plans update only the future. */
  planAnchors: (string | null)[];
  /** Derived media stays at the working source's forward-plan anchor. */
  workAnchors: (UnitRef | null)[];
  sceneAnchors: (TaskSceneSuggestion | null)[];
  focus: UnitRef | null;
  sceneSelections: Record<string, string[]>;
  /** Index into `visited` for the open unit scene; null when no unit is open. */
  position: number | null;
  /** Temporary scene layered over the timeline; null shows the unit (or home) scene. */
  overlay: TemporaryScene | null;
  /** Fine editing applies to the unit at `position` and is exclusive with review. */
  editing: boolean;
  /** Temporary visits form their own return stack, including covered editing. */
  returns: { position: number | null; overlay: TemporaryScene | null; editing: boolean; focus: UnitRef | null }[];
}

export type ActiveScene =
  | { kind: "unit"; ref: UnitRef }
  | { kind: "edit"; ref: UnitRef }
  | { kind: "agent"; ref: UnitRef; suggestion: TaskSceneSuggestion }
  | { kind: "global" }
  | { kind: "directory" };

const sameRef = (a: UnitRef, b: UnitRef) =>
  a.unitId === b.unitId &&
  a.sourceVersionId === b.sourceVersionId &&
  a.purpose === b.purpose;

/** Restart recovery: reopen the last visited unit, or the folder home scene. */
export function initialTimeline(history: TaskVisit[]): TimelineState {
  const visited = history.map(({ unitId, sourceVersionId, purpose }) => ({
    unitId,
    sourceVersionId,
    purpose,
  }));
  return {
    visited,
    planAnchors: visited.map(() => null),
    workAnchors: visited.map(() => null),
    sceneAnchors: visited.map(() => null),
    focus: null,
    sceneSelections: {},
    position: visited.length ? visited.length - 1 : null,
    overlay: null,
    editing: false,
    returns: [],
  };
}

export function activeScene(state: TimelineState): ActiveScene {
  if (state.overlay === "global") return { kind: "global" };
  if (state.overlay === "directory") return { kind: "directory" };
  const ref = state.focus ?? workingRef(state);
  const suggestion = state.position !== null ? state.sceneAnchors[state.position] : null;
  if (ref) {
    if (state.editing) return { kind: "edit", ref };
    return suggestion ? { kind: "agent", ref, suggestion } : { kind: "unit", ref };
  }
  // A folder task without unit history starts at real file management.
  return { kind: "directory" };
}

export function currentRef(state: TimelineState): UnitRef | null {
  if (state.overlay) return null;
  return state.focus ?? workingRef(state);
}

export function workingRef(state: TimelineState): UnitRef | null {
  return state.position !== null ? (state.visited[state.position] ?? null) : null;
}

export function canBack(state: TimelineState): boolean {
  if (state.returns.length) return true;
  if (state.editing) return true;
  if (state.overlay) return state.position !== null;
  return state.position !== null && state.position > 0;
}

/**
 * Back restores the previous scene without touching review state: an edit
 * scene returns to its unit review, a temporary scene returns to the unit it
 * covered, and a unit scene returns to the previously visited unit. Back is
 * not undo and never marks anything reviewed.
 */
export function back(state: TimelineState): TimelineState {
  if (!state.overlay && state.editing) return { ...state, editing: false };
  const previous = state.returns.at(-1);
  if (previous) return { ...state, ...previous, returns: state.returns.slice(0, -1) };
  if (state.overlay) return { ...state, overlay: null };
  if (state.position !== null && state.position > 0)
    return { ...state, position: state.position - 1, focus: null };
  return state;
}

/** Open a unit review scene. Re-opening the current unit just drops overlays. */
export function openUnit(state: TimelineState, ref: UnitRef, planRevisionId: string | null = null, workAnchor: UnitRef | null = null): TimelineState {
  const current = state.position !== null ? state.visited[state.position] : undefined;
  if (current && sameRef(current, ref) && !state.sceneAnchors[state.position!]) return { ...state, overlay: null, editing: false, focus: null, returns: [] };
  const visited = state.visited.concat(ref);
  return { ...state, visited, planAnchors: [...state.planAnchors, planRevisionId], workAnchors: [...state.workAnchors, workAnchor], sceneAnchors: [...state.sceneAnchors, null], focus: null, position: visited.length - 1, overlay: null, editing: false,
    returns: state.overlay || state.position !== null ? [...state.returns, { position: state.position, overlay: state.overlay, editing: state.editing, focus: state.focus }] : [] };
}

export function openAgentScene(state: TimelineState, suggestion: TaskSceneSuggestion, ref: UnitRef, planRevisionId: string | null): TimelineState {
  // Opening a scene is an explicit human navigation; its immutable description
  // remains the working scene even if main publishes a replacement plan.
  return {
    ...state,
    visited: [...state.visited, ref],
    planAnchors: [...state.planAnchors, planRevisionId],
    workAnchors: [...state.workAnchors, null],
    sceneAnchors: [...state.sceneAnchors, suggestion],
    position: state.visited.length,
    focus: ref,
    editing: false,
    overlay: null,
    returns: [...state.returns, { position: state.position, overlay: state.overlay, editing: state.editing, focus: state.focus }],
  };
}

export function focusSceneTarget(state: TimelineState, ref: UnitRef): TimelineState {
  return { ...state, focus: ref, editing: false };
}

export function forwardScenes(snapshot: TaskReviewSnapshot, state: TimelineState) {
  const scenes = planScenes(snapshot);
  const current = state.position === null ? null : state.sceneAnchors[state.position];
  const focus = state.focus ?? workingRef(state);
  const anchor = state.position === null ? focus : state.workAnchors[state.position] ?? focus;
  const capturedPlan = snapshot.planRevisions.find((plan) => state.position !== null && plan.id === state.planAnchors[state.position]);
  const currentEffective = current && isTaskSceneCurrent(snapshot, current, capturedPlan?.policyRevision ?? current.criteriaBasis[0]?.policyRevision ?? snapshot.policyRevision);
  const samePlan = state.position !== null && state.planAnchors[state.position] === snapshot.planRevisions.at(-1)?.id;
  const index = current ? currentEffective ? scenes.findIndex((scene) => scene.id === current.id) : -1
    : samePlan && anchor ? scenes.findIndex((scene) => scene.targets.some((target) => sameRef({ ...target, purpose: scene.purpose }, anchor))) : -1;
  const future = index >= 0 ? scenes.slice(index + 1) : scenes;
  const currentTargets = current ? currentEffective ? current.targets.map((target) => ({ ...target, purpose: current.purpose })) : [] : anchor ? [anchor, ...(focus ? [focus] : [])] : [];
  const pending = future.flatMap((suggestion) => {
    const candidates = pendingSceneTargets(snapshot, suggestion).filter((candidate) =>
      !currentTargets.some((covered) => sameRef(covered, { ...candidate, purpose: suggestion.purpose })));
    const target = candidates.length ? initialSceneTarget(snapshot, suggestion, candidates) : null;
    return target ? [{ suggestion, ref: { ...target, purpose: suggestion.purpose } }] : [];
  });
  return { pending, hasPlan: index >= 0 || scenes.length > 0 };
}

export function continueScene(snapshot: TaskReviewSnapshot, state: TimelineState): { suggestion: TaskSceneSuggestion | null; ref: UnitRef } | null {
  const future = forwardScenes(snapshot, state);
  if (future.pending.length) return future.pending[0];
  if (future.hasPlan) return null;
  const focus = state.focus ?? workingRef(state);
  const anchor = state.position === null ? focus : state.workAnchors[state.position] ?? focus;
  const planId = state.position === null ? null : state.planAnchors[state.position];
  let ref = continueTarget(snapshot, anchor, planId);
  if (ref && focus && sameRef(ref, focus)) ref = continueTarget(snapshot, ref, planId);
  return ref ? { suggestion: null, ref } : null;
}

/** Enter a temporary scene; the covered unit keeps its position and drafts. */
export function openTemporary(
  state: TimelineState,
  scene: TemporaryScene,
): TimelineState {
  if (state.overlay === scene || (state.position === null && !state.overlay && scene === "directory")) return state;
  return { ...state, overlay: scene, returns: [...state.returns, { position: state.position, overlay: state.overlay, editing: state.editing, focus: state.focus }] };
}

export function setEditing(state: TimelineState, editing: boolean): TimelineState {
  if (state.position === null) return state;
  return { ...state, editing, overlay: null };
}

/**
 * The agent's next planned unit: the highest-priority step without a matching
 * human decision. Without a plan, undecided units are offered in ordinal
 * order as a manual skim path. A manually completed step is skipped only
 * under the same task, source version and purpose.
 */
export function continueTarget(
  snapshot: TaskReviewSnapshot,
  anchor: UnitRef | null = null,
  anchorPlanId: string | null = snapshot.planRevisions.at(-1)?.id ?? null,
): UnitRef | null {
  const remaining = remainingPlanSteps(snapshot);
  const planned = planSteps(snapshot);
  const samePlan = anchorPlanId === (snapshot.planRevisions.at(-1)?.id ?? null);
  const anchorIndex = anchor && samePlan ? planned.findIndex((step) => sameRef(step, anchor)) : -1;
  const next = anchorIndex >= 0
    ? planned.slice(anchorIndex + 1).find((step) => remaining.some((candidate) => sameRef(candidate, step)))
    : remaining.find((step) => !anchor || !sameRef(step, anchor));
  if (next)
    return {
      unitId: next.unitId,
      sourceVersionId: next.sourceVersionId,
      purpose: next.purpose,
    };
  if (anchorIndex >= 0) return null;
  // The no-plan skim path only walks units of current source versions;
  // superseded or unreadable versions stay history and are not re-offered.
  const current = currentSourceIds(snapshot);
  const anchorUnitIndex = anchor ? snapshot.units.findIndex((unit) => unit.id === anchor.unitId && unit.sourceVersionId === anchor.sourceVersionId) : -1;
  const unit = snapshot.units.slice(anchorUnitIndex + 1).find(
    (candidate) =>
      current.has(candidate.sourceVersionId) &&
      unitDecisionState(snapshot, candidate.id, REVIEW_PURPOSE).status === null,
  );
  return unit
    ? { unitId: unit.id, sourceVersionId: unit.sourceVersionId, purpose: REVIEW_PURPOSE }
    : null;
}
