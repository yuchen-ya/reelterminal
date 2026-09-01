import type { Action } from "../types/actions";

export interface HistoryEntry {
  readonly action: Action;
  readonly inverseAction: Action | null;
  readonly timestamp: number;
  readonly description: string;
  readonly groupId?: string;
  /**
   * Undo-unit owner (ADR 0004 Decision 12): "agent" for AI batches, undefined
   * for human edits. A push whose owner differs from the open group's owner
   * auto-closes that group first, so a human edit can never join an agent's
   * undo unit (and vice versa).
   */
  readonly owner?: string;
}

export interface ActionGroup {
  id: string;
  description: string;
  actions: HistoryEntry[];
  timestamp: number;
}

export interface HistorySnapshot {
  id: string;
  name: string;
  timestamp: number;
  stackIndex: number;
}

const ACTION_DESCRIPTIONS: Record<
  string,
  (params: Record<string, unknown>) => string
> = {
  "clip/add": () => "Add clip",
  "clip/remove": () => "Delete clip",
  "clip/move": () => "Move clip",
  "clip/trim": () => "Trim clip",
  "clip/split": () => "Split clip",
  "clip/rippleDelete": () => "Ripple delete",
  "clip/duplicate": () => "Duplicate clip",
  "clip/setBlendMode": () => "Change blend mode",
  "clip/setBlendOpacity": () => "Adjust blend opacity",
  "clip/setEmphasisAnimation": () => "Set emphasis animation",
  "clip/setColorGrading": () => "Color grading",
  "track/add": (params) => `Add ${params.trackType} track`,
  "track/duplicate": () => "Duplicate track",
  "track/remove": () => "Remove track",
  "track/rename": () => "Rename track",
  "effect/add": (params) => `Add ${params.effectType} effect`,
  "effect/remove": () => "Remove effect",
  "effect/update": () => "Update effect",
  "effect/toggle": () => "Toggle effect",
  "effect/setStack": () => "Replace effect stack",
  "transform/update": () => "Transform clip",
  "keyframe/add": (params) => `Add ${params.property} keyframe`,
  "keyframe/remove": () => "Remove keyframe",
  "transition/add": (params) => `Add ${params.transitionType} transition`,
  "transition/set": () => "Add transition",
  "transition/update": () => "Update transition",
  "transition/remove": () => "Remove transition",
  "audio/setVolume": () => "Adjust volume",
  "audio/setFade": () => "Adjust fade",
  "audio/addEffect": () => "Add audio effect",
  "audio/removeEffect": () => "Remove audio effect",
  "audio/updateEffect": () => "Update audio effect",
  "audio/toggleEffect": () => "Toggle audio effect",
  "subtitle/add": () => "Add subtitle",
  "subtitle/remove": () => "Remove subtitle",
  "marker/add": () => "Add marker",
  "marker/remove": () => "Remove marker",
  "marker/update": () => "Update marker",
  "project/rename": () => "Rename project",
  "project/updateSettings": () => "Update settings",
  "project/setCanvasBackground": () => "Change canvas background",
  "project/registerGeneratedShader": () => "Add generated shader",
  "project/removeGeneratedShader": () => "Remove generated shader",
  "media/import": () => "Import media",
  "media/delete": () => "Delete media",
  "clip/closeGapBefore": () => "Close gap",
  "track/consolidate": () => "Remove gaps",
  "track/restorePositions": () => "Restore positions",
};

function getActionDescription(action: Action): string {
  const descFn = ACTION_DESCRIPTIONS[action.type];
  if (descFn) {
    return descFn(action.params as Record<string, unknown>);
  }
  const parts = action.type.split("/");
  return `${parts[0]}: ${parts[1] || "action"}`;
}

// Action types whose rapid repetition (slider drags, etc.) should be
// coalesced into a single undo step. Anything not in this set — clip/add,
// clip/remove, track/add, etc. — is always treated as a discrete user
// action even when fired in quick succession.
const AUTO_GROUPABLE_TYPES = new Set<string>([
  "transform/update",
  "effect/update",
  "audio/setVolume",
  "audio/setFade",
  "audio/updateEffect",
  "transition/update",
  "clip/setBlendOpacity",
  "clip/setColorGrading",
  "clip/move",
  "clip/trim",
  "clip/slip",
  "clip/slide",
  "clip/roll",
  "clip/setSpeed",
  "clip/setChromaKey",
  "clip/setStabilization",
  "keyframe/move",
  "keyframe/update",
  "project/updateSettings",
  "project/setCanvasBackground",
]);

// Param keys that identify the target entity. Two actions of the same
// type are only grouped if they refer to the same target.
const TARGET_PARAM_KEYS = [
  "clipId",
  "effectId",
  "trackId",
  "keyframeId",
  "transitionId",
  "subtitleId",
];

function getActionTargetId(action: Action): string | null {
  const params = action.params as Record<string, unknown>;
  for (const key of TARGET_PARAM_KEYS) {
    const value = params[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

export class ActionHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private maxHistorySize: number;
  private currentGroupId: string | null = null;
  private currentGroupOwner: string | undefined = undefined;
  private activeOwner: string | undefined = undefined;
  private groupCounter = 0;
  private snapshots: HistorySnapshot[] = [];
  private listeners: Set<() => void> = new Set();
  private lastActionTime: number = 0;
  private autoGroupWindow: number = 100;

  constructor(maxHistorySize: number = 1000) {
    this.maxHistorySize = maxHistorySize;
  }

  /**
   * Attributes every push (and every group begun) to `owner` until cleared.
   * Agent entry points (LiveEditorHost transactions, the live bridge) set this
   * to "agent" around a batch; GUI paths leave it undefined (the human owner).
   */
  setActiveOwner(owner: string | undefined): void {
    this.activeOwner = owner;
  }

  getActiveOwner(): string | undefined {
    return this.activeOwner;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  push(
    action: Action,
    inverseAction: Action | null = null,
    owner?: string,
  ): void {
    const effectiveOwner = owner ?? this.activeOwner;
    const now = Date.now();
    const timeSinceLastAction = now - this.lastActionTime;
    this.lastActionTime = now;

    // Ownership rule: a push from a different owner auto-closes the open group
    // before pushing, so an interleaved foreign edit keeps its own undo unit
    // instead of silently joining the open one.
    if (
      this.currentGroupId !== null &&
      this.currentGroupOwner !== effectiveOwner
    ) {
      this.currentGroupId = null;
      this.currentGroupOwner = undefined;
    }

    const lastEntry =
      this.undoStack.length > 0
        ? this.undoStack[this.undoStack.length - 1]
        : null;

    // Only auto-group when:
    // - The action type is one of the "rapid update" types (slider drag,
    //   trim handle, etc.) — not creation/deletion actions.
    // - The previous entry has the same type AND targets the same entity
    //   (same clipId, effectId, etc.), so two distinct operations don't
    //   collapse just because they happened back-to-back.
    // - The previous entry belongs to the same owner, so an agent batch and a
    //   human drag on the same entity don't coalesce across owners.
    let groupId = this.currentGroupId;
    if (
      !groupId &&
      lastEntry &&
      lastEntry.owner === effectiveOwner &&
      timeSinceLastAction < this.autoGroupWindow &&
      lastEntry.action.type === action.type &&
      AUTO_GROUPABLE_TYPES.has(action.type)
    ) {
      const lastTarget = getActionTargetId(lastEntry.action);
      const currentTarget = getActionTargetId(action);
      if (lastTarget !== null && lastTarget === currentTarget) {
        groupId = lastEntry.groupId ?? `auto-${now}`;
        if (!lastEntry.groupId) {
          this.undoStack[this.undoStack.length - 1] = { ...lastEntry, groupId };
        }
      }
    }

    const entry: HistoryEntry = {
      action,
      inverseAction,
      timestamp: now,
      description: getActionDescription(action),
      groupId: groupId || undefined,
      owner: effectiveOwner,
    };

    this.undoStack.push(entry);
    this.redoStack = [];

    this.snapshots = this.snapshots.filter(
      (s) => s.stackIndex <= this.undoStack.length,
    );

    if (this.undoStack.length > this.maxHistorySize) {
      this.undoStack.shift();
      this.snapshots = this.snapshots
        .map((s) => ({ ...s, stackIndex: s.stackIndex - 1 }))
        .filter((s) => s.stackIndex >= 0);
    }

    this.notify();
  }

  beginGroup(_description?: string, owner?: string): string {
    // The counter suffix keeps group ids unique even for two groups begun in
    // the same millisecond (e.g. back-to-back agent batches).
    this.currentGroupId = `group-${Date.now()}-${++this.groupCounter}`;
    this.currentGroupOwner = owner ?? this.activeOwner;
    return this.currentGroupId;
  }

  endGroup(): void {
    this.currentGroupId = null;
    this.currentGroupOwner = undefined;
    this.notify();
  }

  setAutoGroupWindow(ms: number): void {
    this.autoGroupWindow = ms;
  }

  undo(): Action | null {
    const entry = this.undoStack.pop();
    if (entry) {
      this.redoStack.push(entry);
      this.notify();
      return entry.inverseAction;
    }
    return null;
  }

  undoGroup(): Action[] {
    if (this.undoStack.length === 0) return [];

    const lastEntry = this.undoStack[this.undoStack.length - 1];
    const groupId = lastEntry.groupId;

    if (!groupId) {
      const action = this.undo();
      return action ? [action] : [];
    }

    const inverseActions: Action[] = [];
    while (
      this.undoStack.length > 0 &&
      this.undoStack[this.undoStack.length - 1].groupId === groupId
    ) {
      const action = this.undo();
      if (action) inverseActions.push(action);
    }
    return inverseActions;
  }

  redo(): Action | null {
    const entry = this.redoStack.pop();
    if (entry) {
      this.undoStack.push(entry);
      this.notify();
      return entry.action;
    }
    return null;
  }

  redoGroup(): Action[] {
    if (this.redoStack.length === 0) return [];

    const nextEntry = this.redoStack[this.redoStack.length - 1];
    const groupId = nextEntry.groupId;

    if (!groupId) {
      const action = this.redo();
      return action ? [action] : [];
    }

    const actions: Action[] = [];
    while (
      this.redoStack.length > 0 &&
      this.redoStack[this.redoStack.length - 1].groupId === groupId
    ) {
      const action = this.redo();
      if (action) actions.push(action);
    }
    return actions;
  }

  createSnapshot(name: string): HistorySnapshot {
    const snapshot: HistorySnapshot = {
      id: `snapshot-${Date.now()}`,
      name,
      timestamp: Date.now(),
      stackIndex: this.undoStack.length,
    };
    this.snapshots.push(snapshot);
    this.notify();
    return snapshot;
  }

  getSnapshots(): HistorySnapshot[] {
    return [...this.snapshots];
  }

  deleteSnapshot(id: string): boolean {
    const index = this.snapshots.findIndex((s) => s.id === id);
    if (index !== -1) {
      this.snapshots.splice(index, 1);
      this.notify();
      return true;
    }
    return false;
  }

  getDisplayHistory(): Array<{ entry: HistoryEntry; isCurrent: boolean }> {
    const result: Array<{ entry: HistoryEntry; isCurrent: boolean }> = [];
    const seen = new Set<string>();

    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      const entry = this.undoStack[i];
      if (entry.groupId) {
        if (!seen.has(entry.groupId)) {
          seen.add(entry.groupId);
          result.push({ entry, isCurrent: i === this.undoStack.length - 1 });
        }
      } else {
        result.push({ entry, isCurrent: i === this.undoStack.length - 1 });
      }
    }
    return result.reverse();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  getHistory(): Action[] {
    return this.undoStack.map((entry) => entry.action);
  }

  getHistoryEntries(): HistoryEntry[] {
    return [...this.undoStack];
  }

  getRedoEntries(): HistoryEntry[] {
    return [...this.redoStack];
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.snapshots = [];
    this.currentGroupId = null;
    this.currentGroupOwner = undefined;
    this.notify();
  }

  getUndoStackSize(): number {
    return this.undoStack.length;
  }

  getRedoStackSize(): number {
    return this.redoStack.length;
  }

  peekUndo(): HistoryEntry | null {
    return this.undoStack.length > 0
      ? this.undoStack[this.undoStack.length - 1]
      : null;
  }

  /**
   * Owner of the top undo entry (ADR 0004 Decision 12), without popping it.
   * Agent rollback loops check this before each undo step so a human's
   * interleaved undo unit is never eaten; undefined = human/default owner or
   * an empty stack.
   */
  peekUndoOwner(): string | undefined {
    return this.undoStack.length > 0
      ? this.undoStack[this.undoStack.length - 1].owner
      : undefined;
  }

  peekRedo(): HistoryEntry | null {
    return this.redoStack.length > 0
      ? this.redoStack[this.redoStack.length - 1]
      : null;
  }

  getMaxHistorySize(): number {
    return this.maxHistorySize;
  }

  setMaxHistorySize(size: number): void {
    this.maxHistorySize = size;
    // Trim if necessary
    while (this.undoStack.length > this.maxHistorySize) {
      this.undoStack.shift();
    }
  }
}
