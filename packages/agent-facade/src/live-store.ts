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
import type {
  HistoryControlResult,
  HistoryGetParams,
  HistoryGetResult,
  ImportedMediaMetadata,
  ProjectChangesParams,
  ProjectChangesResult,
} from "./types";

/**
 * Ephemeral editor context (Decision 4): monotonic in-memory
 * `contextRevision` (bumped for meaningful selection, explicit seek/scrub,
 * canvas/range/reference changes; ordinary playback clock ticks do not
 * invalidate it every frame; never
 * persisted into project files, autosave records, or checkpoints) plus the
 * current playhead, selection split by entity kind, selected time range
 * (null when no gesture has defined one), the normalized 0..1 "agent target
 * point" on the project frame (null until the user sets one), and ephemeral
 * stable-numbered agent references.
 */
export type LiveEditorReferenceKind = "video" | "audio" | "text" | "media";

export interface LiveEditorReference {
  /** Namespaced human/model reference id (A1, A2, ...). */
  readonly ref?: string;
  /** The entity category the editor exposed to the agent. */
  readonly kind: LiveEditorReferenceKind;
  readonly entityId: string;
  readonly label: string;
  /** Null start/end means the reference points at a media-library item. */
  readonly timing: {
    readonly startSeconds: number | null;
    readonly endSeconds: number | null;
  };
  /** Project revision captured when the reference was first assigned. */
  readonly revisionAtMark: number;
  /** True once the original entity no longer exists in this editor session. */
  readonly stale: boolean;
  /** Stable number, also used as the key in LiveEditorContext.references. */
  readonly number: number;
}

export type LiveEditorReferences = Readonly<
  Record<string, LiveEditorReference>
>;

export interface LiveEditorContext {
  readonly contextRevision: number;
  readonly playheadSeconds: number | null;
  readonly selectedClipIds: readonly string[];
  readonly selectedTextIds: readonly string[];
  /** Media-library ids selected in the GUI (distinct from timeline clips). */
  readonly selectedMediaIds: readonly string[];
  readonly timeRange: {
    readonly startSeconds: number;
    readonly endSeconds: number;
  } | null;
  /** Normalized 0..1 against the project frame (same space text.create consumes). */
  readonly canvasPoint: { readonly x: number; readonly y: number } | null;
  /** Ephemeral, session-local number → reference mapping for agent collaboration. */
  readonly references?: LiveEditorReferences;
}

/** A target the live editor can select/reveal without changing the project. */
export type LiveEditorControlTargetKind = "clip" | "text" | "media";

export interface LiveEditorControlTarget {
  readonly kind: LiveEditorControlTargetKind;
  readonly id: string;
}

/**
 * Ephemeral live-editor controls. These intentionally live outside the
 * project/action-history seam: playback, selection and viewport focus are
 * collaborative UI state, not edits to persist or undo.
 */
export interface LiveEditorControlParams {
  readonly action: "play" | "pause" | "seek" | "select";
  readonly timeSeconds?: number;
  readonly targets?: readonly LiveEditorControlTarget[];
  /** replace (default) or add to the current GUI selection. */
  readonly selectionMode?: "replace" | "add";
  /** Optional CAS guard for a target derived from editor.get_context. */
  readonly expectedContextRevision?: number;
}

export interface LiveEditorControlResult {
  readonly action: LiveEditorControlParams["action"];
  readonly playbackState: "stopped" | "playing" | "paused";
  readonly playheadSeconds: number;
  readonly selectedClipIds: readonly string[];
  readonly selectedTextIds: readonly string[];
  readonly selectedMediaIds: readonly string[];
  /** Targets that were selected and asked to be revealed in the GUI. */
  readonly revealedTargets: readonly LiveEditorControlTarget[];
  readonly contextRevision: number;
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
  /**
   * Optional replay key carried across the store seam: the desktop adapter
   * puts it on the bridge request so the renderer's applyActions ledger can
   * replay a committed batch whose reply was lost in transit (facade-level
   * edit.apply replay is decided by EditApplyParams.idempotencyKey).
   */
  readonly idempotencyKey?: string;
}

/**
 * Ids of every entity the batch created, partitioned by entity category
 * (tracks / timeline clips / text overlays / transitions), in creation order within each
 * category — diffed by the store around its own apply, so they are the ids
 * that genuinely exist in the canonical project (core mints random ids; the
 * facade never guesses them). Category partitioning is load-bearing: a mixed
 * batch (e.g. [text.create, clip.add]) must hand each op the id of ITS
 * entity, which a single project-ordered flat list cannot express.
 */
export interface LiveCreatedIds {
  readonly tracks: readonly string[];
  readonly clips: readonly string[];
  readonly textClips: readonly string[];
  readonly transitions: readonly string[];
  readonly subtitles: readonly string[];
}

export interface LiveApplyActionsResult {
  /** The store's revision AFTER the committed batch (one bump per batch). */
  readonly revision: number;
  /** Created entity ids by category — see LiveCreatedIds. */
  readonly createdIds: LiveCreatedIds;
}

/**
 * JSON-safe media description sent across the live main↔renderer bridge.
 *
 * The facade probes the file in the Node host and sends the canonical,
 * realpathed path plus the metadata/fingerprint it observed. The renderer
 * side turns this description into its own media-library entry; a browser
 * `File`/`Blob` is deliberately not part of this seam.
 */
export interface LiveMediaImportRequest {
  /** Absolute, realpathed file inside one of the configured media roots. */
  readonly path: string;
  readonly name: string;
  readonly type: "video" | "audio";
  readonly metadata: ImportedMediaMetadata;
  readonly sourceFile: {
    readonly name: string;
    readonly size: number;
    readonly lastModified: number;
  };
  /** Optional retry key forwarded so the renderer can commit at most once. */
  readonly idempotencyKey?: string;
}

/** Result of the renderer's committed media-library insertion. */
export interface LiveMediaImportResult {
  /** Revision after the one media-import history group commits. */
  readonly revision: number;
  /** Id minted by the canonical GUI project store. */
  readonly mediaId: string;
}

export interface LiveProjectStore {
  getIdentity(): Promise<LiveProjectIdentity>;
  /** On-demand snapshot read: a detached project clone plus its revision. */
  getState(): Promise<{ project: Project; revision: number }>;
  getContext(): Promise<LiveEditorContext>;
  /** Bounded renderer-owned journal covering every canonical project replacement. */
  getProjectChanges(params: ProjectChangesParams): Promise<ProjectChangesResult>;
  /** Bounded summary of the canonical GUI/Core undo and redo stacks. */
  getHistory(params: HistoryGetParams): Promise<HistoryGetResult>;
  /** Execute the canonical GUI/Core undo or redo path with revision CAS. */
  historyControl(
    action: "undo" | "redo",
    opts: {
      readonly expectedRevision: number;
      readonly idempotencyKey?: string;
    },
  ): Promise<Omit<HistoryControlResult, "action">>;
  /** Apply one ephemeral playback/selection control to the live editor. */
  editorControl(
    params: LiveEditorControlParams,
  ): Promise<LiveEditorControlResult>;
  /**
   * CAS-checked batch apply — see the implementation contract above. Stale
   * expectations reject with `LiveStoreConflictError`; nothing is applied.
   */
  applyActions(
    actions: readonly Action[],
    opts: LiveApplyActionsOptions,
  ): Promise<LiveApplyActionsResult>;
  /**
   * Import one host-validated local file into the canonical GUI project.
   * Implementations MUST CAS `expectedRevision` before committing and MUST
   * make this one undoable history group, just like applyActions.
   */
  importMedia(
    request: LiveMediaImportRequest,
    opts: LiveApplyActionsOptions,
  ): Promise<LiveMediaImportResult>;
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
