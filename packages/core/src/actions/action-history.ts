import type { Action } from "../types/actions";

export interface HistoryEntry {
  readonly action: Action;
  readonly inverseAction: Action | null;
  readonly timestamp: number;
  readonly description: string;
  readonly groupId?: string;
  /**
   * Undo-unit owner (ADR 0004 Decision 12): "agent" for AI batches, undefined
   * for human edits. Open groups are owner-scoped, so a human edit can never
   * join an Agent undo unit (and vice versa), even when their gestures overlap.
   */
  readonly owner?: string;
}

export interface ActionGroup {
  id: string;
  description: string;
  actions: HistoryEntry[];
  timestamp: number;
}

/**
 * Observes entries that leave the history for good: trimmed overflow, the
 * redo stack dropped by a new push, and clear(). Entries moved between the
 * undo and redo stacks by undo()/redo() are NOT evictions. Listeners are
 * observational, like subscribe() listeners: a throw must not disturb the
 * stack mutation that produced it.
 */
export type HistoryEvictionListener = (evicted: readonly HistoryEntry[]) => void;

export interface HistorySnapshot {
  id: string;
  name: string;
  timestamp: number;
  stackIndex: number;
}

interface OpenActionGroup {
  readonly id: string;
  readonly owner?: string;
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
  "media/rename": () => "Rename media",
  "workAsset/create": (params) => {
    const asset = params.asset as { name?: string } | undefined;
    return asset?.name ? `Save work asset "${asset.name}"` : "Save work asset";
  },
  "workAsset/delete": () => "Delete work asset",
  "workAsset/restore": () => "Restore work asset",
  "workAsset/rename": () => "Rename work asset",
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
  /**
   * Groups may overlap when a live Agent batch lands during a human gesture.
   * Keep them as owner-scoped frames instead of one global slot: replacing a
   * human frame with an Agent frame used to strand the tail of the gesture.
   */
  private openGroups: OpenActionGroup[] = [];
  private activeOwner: string | undefined = undefined;
  private groupCounter = 0;
  private snapshots: HistorySnapshot[] = [];
  private listeners: Set<() => void> = new Set();
  private evictionListener: HistoryEvictionListener | null = null;
  private notificationBatchDepth = 0;
  private notificationPending = false;
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

  /**
   * Registers the single observer for permanently removed entries. Passing
   * null detaches. Fires after the affected stacks are already final, so a
   * listener scanning this history sees a consistent state.
   */
  setEvictionListener(listener: HistoryEvictionListener | null): void {
    this.evictionListener = listener;
  }

  private emitEviction(evicted: readonly HistoryEntry[]): void {
    if (evicted.length === 0 || !this.evictionListener) return;
    try {
      this.evictionListener(evicted);
    } catch {
      // Same contract as notify(): observation cannot roll history back.
    }
  }

  private notify(): void {
    if (this.notificationBatchDepth > 0) {
      this.notificationPending = true;
      return;
    }
    // History is already committed when observers run. A faulty view
    // subscriber must not turn that commit into an apparent action failure.
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        // Subscribers are observational; they cannot roll history back.
      }
    });
  }

  private batchNotifications(operation: () => void): void {
    this.notificationBatchDepth += 1;
    try {
      operation();
    } finally {
      this.notificationBatchDepth -= 1;
      if (this.notificationBatchDepth === 0 && this.notificationPending) {
        this.notificationPending = false;
        this.notify();
      }
    }
  }

  /** Drops overflow from the oldest end and returns the removed entries. */
  private trimToHistoryLimit(): HistoryEntry[] {
    const evicted: HistoryEntry[] = [];
    while (this.undoStack.length > this.maxHistorySize) {
      const firstGroupId = this.undoStack[0]?.groupId;
      let removeCount = 1;
      if (firstGroupId) {
        while (
          removeCount < this.undoStack.length &&
          this.undoStack[removeCount]?.groupId === firstGroupId
        ) {
          removeCount += 1;
        }
      }
      // Preserve one complete undo unit even if a caller deliberately made a
      // group larger than the nominal entry limit. Atomic undo is more
      // important than enforcing the cap by retaining an unusable tail.
      if (removeCount === this.undoStack.length) break;
      evicted.push(...this.undoStack.splice(0, removeCount));
      this.snapshots = this.snapshots
        .map((snapshot) => ({
          ...snapshot,
          stackIndex: snapshot.stackIndex - removeCount,
        }))
        .filter((snapshot) => snapshot.stackIndex >= 0);
    }
    return evicted;
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
    // Pick the newest open group owned by this push. A human gesture and an
    // Agent transaction can therefore overlap without either stealing or
    // closing the other's grouping context.
    let groupId = [...this.openGroups]
      .reverse()
      .find((group) => group.owner === effectiveOwner)?.id ?? null;
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
    const evictedRedo = this.redoStack;
    this.redoStack = [];

    this.snapshots = this.snapshots.filter(
      (s) => s.stackIndex <= this.undoStack.length,
    );

    const evicted = [...evictedRedo, ...this.trimToHistoryLimit()];
    this.emitEviction(evicted);

    this.notify();
  }

  /** Append one complete undo unit and publish a single observer event. */
  pushGroup(
    entries: readonly Pick<HistoryEntry, "action" | "inverseAction">[],
    description?: string,
    owner?: string,
  ): string | null {
    if (entries.length === 0) return null;
    const effectiveOwner = owner ?? this.activeOwner;
    // A single rapid-update action (a slider drag arriving through the
    // batched commit path) falls back to push()'s proximity coalescing,
    // keeping undo granularity identical to the legacy bare-execute drags.
    // Multi-action batches — the reason pushGroup exists — keep strict
    // one-batch-one-unit semantics, as does anything pushed while a group
    // is open for this owner.
    if (
      entries.length === 1 &&
      AUTO_GROUPABLE_TYPES.has(entries[0]!.action.type) &&
      !this.openGroups.some((group) => group.owner === effectiveOwner)
    ) {
      this.push(entries[0]!.action, entries[0]!.inverseAction, owner);
      return this.undoStack[this.undoStack.length - 1]?.groupId ?? null;
    }
    let groupId: string | null = null;
    this.batchNotifications(() => {
      const openedGroupId = this.beginGroup(description, owner);
      groupId = openedGroupId;
      try {
        for (const entry of entries) {
          this.push(entry.action, entry.inverseAction, owner);
        }
      } finally {
        this.endGroup(openedGroupId);
      }
    });
    return groupId;
  }

  beginGroup(_description?: string, owner?: string): string {
    // The counter suffix keeps group ids unique even for two groups begun in
    // the same millisecond (e.g. back-to-back agent batches).
    const group = {
      id: `group-${Date.now()}-${++this.groupCounter}`,
      owner: owner ?? this.activeOwner,
    };
    this.openGroups.push(group);
    return group.id;
  }

  /**
   * Close one group. A caller that crosses an async boundary should pass the
   * handle returned by beginGroup; legacy synchronous GUI callers may omit it,
   * in which case only their current owner's newest group is closed.
   */
  endGroup(groupId?: string): void {
    let index = -1;
    if (groupId === undefined) {
      for (let i = this.openGroups.length - 1; i >= 0; i -= 1) {
        if (this.openGroups[i]?.owner === this.activeOwner) {
          index = i;
          break;
        }
      }
    } else {
      index = this.openGroups.findIndex((group) => group.id === groupId);
    }
    if (index >= 0) this.openGroups.splice(index, 1);
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
    let newerGroupId: string | undefined;

    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      const entry = this.undoStack[i];
      if (entry.groupId) {
        // One display row must match one contiguous undo unit. Overlapping
        // owner groups can legitimately reuse their id on both sides of a
        // foreign entry; collapsing those fragments would hide undo steps.
        if (entry.groupId !== newerGroupId) {
          result.push({ entry, isCurrent: i === this.undoStack.length - 1 });
        }
        newerGroupId = entry.groupId;
      } else {
        result.push({ entry, isCurrent: i === this.undoStack.length - 1 });
        newerGroupId = undefined;
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
    const evicted = [...this.undoStack, ...this.redoStack];
    this.undoStack = [];
    this.redoStack = [];
    this.snapshots = [];
    this.openGroups = [];
    this.emitEviction(evicted);
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
    // Trim if necessary. This inline shift is a fourth eviction point that
    // deliberately does NOT emit evictions: it has no callers today, and any
    // future caller that can lose restorable entries should route through
    // trimToHistoryLimit so observers stay informed.
    while (this.undoStack.length > this.maxHistorySize) {
      this.undoStack.shift();
    }
  }
}
