/**
 * JSON-safe desktop collaboration protocol shared by Electron main/preload
 * and the web renderer.
 *
 * This module is the single source of truth for the contextBridge surface.
 * It intentionally contains types and cadence constants only: validation and
 * privileged behavior stay in the desktop main process.
 */
import type { Action } from "@openreel/core/types/actions";
import type {
  ExternalAgentApprovalDecision,
  ExternalConversationDisplayState,
} from "./conversation-protocol";
import type {
  LiveEditorControlParams,
  LiveEditorControlTarget,
  LiveMediaImportRequest,
} from "./live-store";
import type { AgentAccessMode, AgentWorkMode } from "./work-mode";

export type { AgentAccessMode, AgentWorkMode } from "./work-mode";

/** Shipped connector cadence; comfortably below the host activity lease. */
export const LIVE_HEARTBEAT_INTERVAL_MS = 10_000;
/** No authenticated activity for this long releases the external writer. */
export const LIVE_ACTIVITY_TIMEOUT_MS = 45_000;

/** collabControl.getStatus / the `{type:"status"}` live event payload. */
export interface DesktopCollabStatus {
  /** Monotonic within one desktop main process. */
  readonly sequence: number;
  readonly enabled: boolean;
  readonly externalConnected: boolean;
  readonly writer: "external" | null;
  readonly workMode: AgentWorkMode;
  /** Authorization is independent from work mode. */
  readonly access: AgentAccessMode;
  readonly currentAction: string | null;
}

export interface DesktopCollabSetWorkModeArgs {
  readonly mode: AgentWorkMode;
}

export interface DesktopCollabSetAccessArgs {
  readonly access: AgentAccessMode;
}

export type DesktopLiveBridgeKind =
  | "getIdentity"
  | "getState"
  | "getContext"
  | "getProjectChanges"
  | "getHistory"
  | "historyControl"
  | "editorControl"
  | "applyActions"
  | "importMedia"
  | "materialLibrary"
  | "requestSave";

/** Main-to-renderer request on `openreel:live:request`. */
export interface DesktopLiveBridgeRequest {
  readonly callId: string;
  readonly kind: DesktopLiveBridgeKind;
  readonly actions?: readonly Action[];
  readonly groupLabel?: string;
  readonly expectedRevision?: number;
  readonly expectedContextRevision?: number;
  readonly sinceRevision?: number;
  readonly limit?: number;
  readonly cursor?: string;
  readonly historyAction?: "undo" | "redo";
  readonly action?: LiveEditorControlParams["action"];
  readonly timeSeconds?: number;
  readonly targets?: readonly LiveEditorControlTarget[];
  readonly selectionMode?: LiveEditorControlParams["selectionMode"];
  readonly path?: LiveMediaImportRequest["path"];
  readonly name?: LiveMediaImportRequest["name"];
  readonly type?: LiveMediaImportRequest["type"];
  readonly metadata?: LiveMediaImportRequest["metadata"];
  readonly sourceFile?: LiveMediaImportRequest["sourceFile"];
  readonly idempotencyKey?: LiveMediaImportRequest["idempotencyKey"];
  /** materialLibrary: the material-library verb to execute in the renderer. */
  readonly materialVerb?: string;
  /** materialLibrary: JSON-safe parameters for that verb. */
  readonly materialParams?: Record<string, unknown>;
}

export interface DesktopLiveBridgeError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/** Renderer-to-main reply on `openreel:live:response`. */
export interface DesktopLiveBridgeReply {
  readonly callId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: DesktopLiveBridgeError;
}

export interface DesktopInspection {
  readonly kind?: "frames" | "cloud-opinion";
  readonly text?: string;
  readonly title: string;
  readonly range: string | null;
  readonly images: readonly string[];
  readonly limitations: readonly string[];
}

export type DesktopLiveEvent =
  | ({ readonly type: "inspection" } & DesktopInspection)
  | ({ readonly type: "status" } & DesktopCollabStatus)
  | { readonly type: "action"; readonly phase: "start"; readonly verb: string }
  | {
      readonly type: "action";
      readonly phase: "end";
      readonly verb: string;
      readonly ok: boolean;
      /** One safe human-readable line; never raw params or JSON. */
      readonly summary: string;
    };

export type ConversationAdapterAvailability =
  | "missing"
  | "available"
  | "invalid";

export type ConversationCapabilityLevel =
  | "basic"
  | "streaming"
  | "observable";

export interface DesktopConversationAdapterSummary {
  readonly availability: ConversationAdapterAvailability;
  readonly agentLabel: string | null;
  readonly adapterName: string | null;
  readonly sessionId: string | null;
  readonly capabilityLevel: ConversationCapabilityLevel | null;
  /** Bounded diagnostic; never an endpoint, token, or response body. */
  readonly message: string | null;
}

export interface DesktopConversationState {
  readonly sequence: number;
  readonly adapter: DesktopConversationAdapterSummary;
  readonly conversation: ExternalConversationDisplayState;
}

export type DesktopConversationEvent = {
  readonly type: "state";
  readonly state: DesktopConversationState;
};

/** Typed renderer-facing contextBridge collaboration surfaces. */
export interface DesktopLiveBridgeApi {
  onRequest(
    handler: (request: DesktopLiveBridgeRequest) => Promise<void> | void,
  ): () => void;
  respond(reply: DesktopLiveBridgeReply): void;
}

export interface DesktopLiveEventsApi {
  onEvent(handler: (event: DesktopLiveEvent) => void): () => void;
}

export interface DesktopCollabControlApi {
  enable(): Promise<DesktopCollabStatus>;
  disable(): Promise<DesktopCollabStatus>;
  getStatus(): Promise<DesktopCollabStatus>;
  setWorkMode(mode: AgentWorkMode): Promise<DesktopCollabStatus>;
  /** Explicitly change the authorization boundary; never implied by work mode. */
  setAccess(access: AgentAccessMode): Promise<DesktopCollabStatus>;
  openWorkspace(): Promise<string>;
}

export interface DesktopConversationApi {
  getState(): Promise<DesktopConversationState>;
  attach(): Promise<DesktopConversationState>;
  prompt(text: string): Promise<DesktopConversationState>;
  resolveApproval(
    requestId: string,
    decision: ExternalAgentApprovalDecision,
  ): Promise<DesktopConversationState>;
  cancel(): Promise<DesktopConversationState>;
  detach(): Promise<DesktopConversationState>;
  onEvent(handler: (event: DesktopConversationEvent) => void): () => void;
}
