/**
 * Live human–agent collaboration IPC contract (ADR 0004, Slice 3).
 *
 * Canonical main-side mirror of the renderer-facing types in
 * apps/web/src/types/global.d.ts (the `liveBridge` / `liveEvents` /
 * `collabControl` members of window.openreel). Keep the two in sync.
 */

export type LiveCollabMode = "observe" | "assist" | "autonomous";

/** collabControl.getStatus / the `{type:"status"}` live event payload. */
export interface LiveCollabStatus {
  readonly enabled: boolean;
  readonly externalConnected: boolean;
  /** The external agent session currently holding the writer lease. */
  readonly writer: "external" | null;
  readonly mode: LiveCollabMode;
  /** Verb currently in flight, or null when the agent is idle. */
  readonly currentAction: string | null;
}

/** collabControl.setMode args (renderer → main). */
export interface LiveCollabSetModeArgs {
  readonly mode: LiveCollabMode;
}

/* ---- liveBridge: main → renderer store seam (ADR 0004 Decision 1) ------- */

export type LiveBridgeKind =
  | "getIdentity"
  | "getState"
  | "getContext"
  | "applyActions"
  | "requestSave";

/**
 * The request payload on "openreel:live:request". applyActions carries the
 * core action batch plus its history-group label and CAS preconditions; the
 * reads carry no payload. Matches apps/web live-bridge.ts LiveBridgeRequest.
 */
export interface LiveBridgeRequest {
  readonly callId: string;
  readonly kind: LiveBridgeKind;
  readonly actions?: readonly unknown[];
  readonly groupLabel?: string;
  readonly expectedRevision?: number;
  readonly expectedContextRevision?: number;
}

export interface LiveBridgeError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/** The reply payload on "openreel:live:response". */
export interface LiveBridgeReply {
  readonly callId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: LiveBridgeError;
}

/* ---- liveEvents: main → renderer pushes ---------------------------------- */

/**
 * Status pushes spread the CollabStatus fields at the top level (the
 * renderer's collab-store merges everything except `type` into its state).
 */
export type LiveEvent =
  | ({ readonly type: "status" } & LiveCollabStatus)
  | { readonly type: "action"; readonly phase: "start"; readonly verb: string }
  | {
      readonly type: "action";
      readonly phase: "end";
      readonly verb: string;
      readonly ok: boolean;
      /** One human-readable line — never raw JSON, never params. */
      readonly summary: string;
    };
