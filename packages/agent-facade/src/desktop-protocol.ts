/**
 * JSON-safe desktop collaboration protocol shared by Electron main/preload
 * and the web renderer.
 *
 * This module is the single source of truth for the contextBridge surface.
 * It intentionally contains types and cadence constants only: validation and
 * privileged behavior stay in the desktop main process.
 */
import type { Action } from "@reelterminal/core/types/actions";
import type {
  LiveEditorControlParams,
  LiveEditorControlTarget,
  LiveMediaImportRequest,
} from "./live-store";
import type { AgentAccessMode } from "./access";

export type { AgentAccessMode } from "./access";

/** Shipped connector cadence; comfortably below the host activity lease. */
export const LIVE_HEARTBEAT_INTERVAL_MS = 10_000;
/** No authenticated activity for this long releases the external writer. */
export const LIVE_ACTIVITY_TIMEOUT_MS = 45_000;
/**
 * window.postMessage marker the preload uses to hand the native-export
 * MessagePort to the renderer (a live port cannot cross contextBridge).
 * Single source of truth: the sender (apps/desktop/src/preload) and the
 * receiver (apps/web native-ffmpeg-backend) must reference THIS constant —
 * Both the preload bridge and renderer use the same message marker.
 */
export const DESKTOP_EXPORT_PORT_MARKER = '__reelterminalExportPort';

/** collabControl.getStatus / the `{type:"status"}` live event payload. */
export interface DesktopCollabStatus {
  /** Monotonic within one desktop main process. */
  readonly sequence: number;
  readonly enabled: boolean;
  readonly externalConnected: boolean;
  readonly writer: "external" | null;
  /** Explicit authorization for external commands. */
  readonly access: AgentAccessMode;
  readonly currentAction: string | null;
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
  | "fontLibrary"
  | "presetLibrary"
  | "requestSave";

/** Main-to-renderer request on `reelterminal:live:request`. */
export interface DesktopLiveBridgeRequest {
  readonly callId: string;
  readonly expectedProjectId?: string;
  readonly expectedProjectEpoch?: string;
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
  /** fontLibrary: the font-library verb to execute in the renderer. */
  readonly fontVerb?: string;
  /** fontLibrary: JSON-safe parameters for that verb. */
  readonly fontParams?: Record<string, unknown>;
  /** presetLibrary: the preset-library verb to execute in the renderer. */
  readonly presetVerb?: string;
  /** presetLibrary: JSON-safe parameters for that verb. */
  readonly presetParams?: Record<string, unknown>;
}

export interface DesktopLiveBridgeError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/** Renderer-to-main reply on `reelterminal:live:response`. */
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
  /** Explicitly change the authorization boundary; independent of client behavior. */
  setAccess(access: AgentAccessMode): Promise<DesktopCollabStatus>;
  openWorkspace(): Promise<string>;
  getStartupInfo(): Promise<{ cliCommand: string; shell: string; workspaceRoot: string }>;
}
