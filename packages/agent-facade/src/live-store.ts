/**
 * The live state seam (ADR 0004 Decision 1).
 *
 * In live sessions the renderer's zustand store remains the single canonical
 * holder of the open `Project`; the facade session (running in the desktop
 * main process) holds NO project copy and reaches the canonical store
 * exclusively through this narrow interface. Reads are on-demand snapshots
 * (no polling, no pushed state); mutations only ever originate as core
 * actions applied by the store side itself — the facade translates ops to
 * actions, the store applies them.
 *
 * Implementation contract (load-bearing, not advisory):
 *
 *  - `applyActions` MUST CAS `expectedRevision` against the current project
 *    revision and `expectedContextRevision` against the current context
 *    revision BEFORE applying anything, inside the same mutation entry that
 *    applies the batch. A stale expectation rejects the whole batch with a
 *    `LiveStoreConflictError` (or any Error with `code: "CONFLICT"`) and
 *    NOTHING is applied. Because human edits bump the same revision counter
 *    (Decision 3), this is what makes a silent agent-over-human overwrite
 *    impossible.
 *  - `applyActions` MUST execute the batch as ONE history group (one undo
 *    unit, Decision 2) so the human can undo/redo the whole agent batch with
 *    the normal Cmd+Z path; text/* actions route through the engine-aware
 *    store methods, everything else through the same `executeAction` path as
 *    manual GUI edits.
 *  - `getState`/`getContext` return fresh, detached values the caller may
 *    hold and clone — never live references into the store.
 */
import type { Action } from "@openreel/core/types/actions";
import type { Project } from "@openreel/core/types/project";

/**
 * Ephemeral editor context (Decision 4): monotonic in-memory
 * `contextRevision` (bumped whenever any derived value changes; never
 * persisted into project files, autosave records, or checkpoints) plus the
 * current playhead, selection split by entity kind, selected time range
 * (null when no gesture has defined one), and the normalized 0..1 "agent
 * target point" on the project frame (null until the user sets one).
 */
export interface LiveEditorContext {
  readonly contextRevision: number;
  readonly playheadSeconds: number | null;
  readonly selectedClipIds: readonly string[];
  readonly selectedTextIds: readonly string[];
  readonly timeRange: {
    readonly startSeconds: number;
    readonly endSeconds: number;
  } | null;
  /** Normalized 0..1 against the project frame (same space text.create consumes). */
  readonly canvasPoint: { readonly x: number; readonly y: number } | null;
}

export interface LiveProjectIdentity {
  readonly projectId: string;
  readonly projectName: string;
  readonly windowId: string;
}

export interface LiveApplyActionsOptions {
  /** History-group label (e.g. "agent: edit.apply") — one batch, one undo unit. */
  readonly groupLabel: string;
  /** CAS precondition on the project revision; omit for an unguarded apply. */
  readonly expectedRevision?: number;
  /** CAS precondition on the editor-context revision (Decision 4). */
  readonly expectedContextRevision?: number;
}

export interface LiveApplyActionsResult {
  /** The store's revision AFTER the committed batch (one bump per batch). */
  readonly revision: number;
  /**
   * Ids of every entity the batch created (tracks, clips, text overlays), in
   * creation order — diffed by the store around its own apply, so they are
   * the ids that genuinely exist in the canonical project (core mints random
   * ids; the facade never guesses them).
   */
  readonly createdIds: string[];
}

export interface LiveProjectStore {
  getIdentity(): Promise<LiveProjectIdentity>;
  /** On-demand snapshot read: a detached project clone plus its revision. */
  getState(): Promise<{ project: Project; revision: number }>;
  getContext(): Promise<LiveEditorContext>;
  /**
   * CAS-checked batch apply — see the implementation contract above. Stale
   * expectations reject with `LiveStoreConflictError`; nothing is applied.
   */
  applyActions(
    actions: readonly Action[],
    opts: LiveApplyActionsOptions,
  ): Promise<LiveApplyActionsResult>;
  /** Route to the GUI's own save path (the GUI owns where/how files land). */
  requestSave(): Promise<{ revision: number }>;
}

/**
 * The store-side CONFLICT signal: a stale expectedRevision or
 * expectedContextRevision. The live facade maps it to a facade CONFLICT
 * FacadeResult (never a thrown domain error). Details carry the current
 * values so the caller can re-read and retry.
 */
export class LiveStoreConflictError extends Error {
  readonly code = "CONFLICT" as const;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "LiveStoreConflictError";
    if (details !== undefined) this.details = details;
  }
}

/** True for LiveStoreConflictError and duck-typed `{code:"CONFLICT"}` errors. */
export function isLiveStoreConflict(error: unknown): boolean {
  return (
    error instanceof LiveStoreConflictError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "CONFLICT")
  );
}
