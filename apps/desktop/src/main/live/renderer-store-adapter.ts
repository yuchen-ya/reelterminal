/**
 * RendererStoreAdapter — the main-process half of the ADR 0004 Decision 1
 * seam. Implements the facade's `LiveProjectStore` over a callId-correlated
 * IPC bridge to the canonical renderer store. Its channel namespace is
 * "openreel:live:request" / "openreel:live:response".
 *
 * Hardening (DESK-06 lesson): a response only resolves its pending call when
 * it arrives from the CURRENT target window's webContents — foreign or stale
 * senders are dropped silently, and the call falls back to its timeout.
 *
 * Error mapping: a renderer `{ ok:false, error:{ code:"CONFLICT" } }` reply
 * becomes a `LiveStoreConflictError` (the live facade maps it to a CONFLICT
 * FacadeResult); any other error code becomes a generic Error. Timeouts
 * reject honestly and clean the pending map; teardown (renderer gone /
 * collab disabled) rejects every pending call.
 */
import { ipcMain, type IpcMainEvent, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import {
  LiveStoreConflictError,
  type LiveApplyActionsResult,
  type LiveEditorContext,
  type LiveEditorControlParams,
  type LiveEditorControlResult,
  type LiveProjectIdentity,
  type LiveProjectStore,
} from "@openreel/agent-facade";
import type { Action } from "@openreel/core/types/actions";
import type { Project } from "@openreel/core/types/project";
import { CHANNELS } from "../../shared/channels";
import type {
  LiveBridgeReply,
  LiveBridgeRequest,
  LiveMediaImportRequest,
  LiveMediaImportResult,
} from "../../shared/live";
import { getEditorWebContents } from "../editor-window";

/** Reads + requestSave are quick store operations. */
const READ_TIMEOUT_MS = 10_000;
/** applyActions runs a whole action batch inside one history group. */
const APPLY_TIMEOUT_MS = 30_000;

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Preserve renderer error codes across the typed LiveProjectStore seam. */
class LiveStoreBridgeError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "LiveStoreBridgeError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export interface LiveStoreBridgeDeps {
  readonly send: (request: LiveBridgeRequest) => void;
  /** DESK-06: only the current target window's webContents may resolve calls. */
  readonly isValidSender: (sender: unknown) => boolean;
  readonly genId?: () => string;
}

export interface LiveStoreBridge {
  readonly store: LiveProjectStore;
  /** Feed one "openreel:live:response" message; unknown/foreign replies drop. */
  handleResponse(sender: unknown, response: LiveBridgeReply): void;
  /** Reject every pending call (bridge teardown / renderer gone). */
  teardown(reason: string): void;
  readonly pendingCount: number;
}

/**
 * The pure correlation core, decoupled from Electron so the mechanics are
 * unit-testable; the Electron wiring below injects send/sender validation.
 */
export function createLiveStoreBridge(deps: LiveStoreBridgeDeps): LiveStoreBridge {
  const pending = new Map<string, PendingCall>();
  const genId = deps.genId ?? (() => randomUUID());

  const request = (
    kind: LiveBridgeRequest["kind"],
    payload: Omit<LiveBridgeRequest, "callId" | "kind">,
    timeoutMs: number,
  ): Promise<unknown> => {
    const callId = genId();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(callId);
        reject(
          new Error(`Live store '${kind}' timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      pending.set(callId, { resolve, reject, timer });
      try {
        deps.send({ callId, kind, ...payload });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(callId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const handleResponse = (sender: unknown, response: LiveBridgeReply): void => {
    // DESK-06: a response from anything but the current target window is not
    // ours — drop it (the pending call times out honestly instead of being
    // resolved by a foreign/stale renderer).
    if (!deps.isValidSender(sender)) return;
    if (!response || typeof response.callId !== "string") return;
    const call = pending.get(response.callId);
    if (!call) return;
    pending.delete(response.callId);
    clearTimeout(call.timer);
    if (response.ok) {
      call.resolve(response.result);
      return;
    }
    const error = response.error;
    if (error?.code === "CONFLICT") {
      // The facade maps LiveStoreConflictError to a CONFLICT FacadeResult.
      call.reject(
        new LiveStoreConflictError(
          error.message ?? "Renderer reported a revision conflict",
          error.details,
        ),
      );
      return;
    }
    call.reject(
      new LiveStoreBridgeError(
        error?.code ?? "BRIDGE_ERROR",
        error?.message ?? "Renderer returned an error",
        error?.details,
      ),
    );
  };

  const teardown = (reason: string): void => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(reason));
    }
    pending.clear();
  };

  // The renderer contract (apps/web live-bridge.ts) owns the result shapes;
  // the facade's LiveProjectStore signatures are the compile-time target.
  const store: LiveProjectStore = {
    getIdentity: () =>
      request("getIdentity", {}, READ_TIMEOUT_MS) as Promise<LiveProjectIdentity>,
    getState: () =>
      request("getState", {}, READ_TIMEOUT_MS) as Promise<{
        project: Project;
        revision: number;
      }>,
    getContext: () =>
      request("getContext", {}, READ_TIMEOUT_MS) as Promise<LiveEditorContext>,
    editorControl: (params: LiveEditorControlParams) =>
      request(
        "editorControl",
        {
          action: params.action,
          ...(params.timeSeconds !== undefined
            ? { timeSeconds: params.timeSeconds }
            : {}),
          ...(params.targets !== undefined ? { targets: [...params.targets] } : {}),
          ...(params.selectionMode !== undefined
            ? { selectionMode: params.selectionMode }
            : {}),
          ...(params.expectedContextRevision !== undefined
            ? { expectedContextRevision: params.expectedContextRevision }
            : {}),
        },
        READ_TIMEOUT_MS,
      ) as Promise<LiveEditorControlResult>,
    applyActions: (actions: readonly Action[], opts) =>
      request(
        "applyActions",
        {
          actions: [...actions],
          groupLabel: opts.groupLabel,
          ...(opts.expectedRevision !== undefined
            ? { expectedRevision: opts.expectedRevision }
            : {}),
          ...(opts.expectedContextRevision !== undefined
            ? { expectedContextRevision: opts.expectedContextRevision }
            : {}),
        },
        APPLY_TIMEOUT_MS,
      ) as Promise<LiveApplyActionsResult>,
    requestSave: () =>
      request("requestSave", {}, READ_TIMEOUT_MS) as Promise<{ revision: number }>,
    importMedia: (params: LiveMediaImportRequest, opts) =>
      request(
        "importMedia",
        {
          ...params,
          groupLabel: opts.groupLabel,
          ...(opts.expectedRevision !== undefined
            ? { expectedRevision: opts.expectedRevision }
            : {}),
          ...(opts.expectedContextRevision !== undefined
            ? { expectedContextRevision: opts.expectedContextRevision }
            : {}),
        },
        APPLY_TIMEOUT_MS,
      ) as Promise<LiveMediaImportResult>,
  };

  return {
    store,
    handleResponse,
    teardown,
    get pendingCount() {
      return pending.size;
    },
  };
}

/** The webContents entitled to resolve live-bridge calls right now. */
export function liveTargetWebContents(): WebContents | null {
  return getEditorWebContents();
}

/**
 * Wires the bridge to the live editor window over IPC. The response listener
 * is process-level, so it survives renderer reloads; in-flight calls during a
 * reload reject on timeout, and teardown rejects them immediately.
 */
export function installLiveStoreBridge(): LiveStoreBridge {
  const bridge = createLiveStoreBridge({
    send: (request) => {
      const contents = getEditorWebContents();
      if (!contents) throw new Error("No editor window is open");
      contents.send(CHANNELS.liveRequest, request);
    },
    isValidSender: (sender) => {
      const contents = liveTargetWebContents();
      return contents !== null && sender === contents;
    },
  });
  const listener = (event: IpcMainEvent, response: LiveBridgeReply): void => {
    bridge.handleResponse(event.sender, response);
  };
  ipcMain.on(CHANNELS.liveResponse, listener);
  return {
    store: bridge.store,
    handleResponse: bridge.handleResponse,
    get pendingCount() {
      return bridge.pendingCount;
    },
    teardown(reason: string) {
      ipcMain.removeListener(CHANNELS.liveResponse, listener);
      bridge.teardown(reason);
    },
  };
}
