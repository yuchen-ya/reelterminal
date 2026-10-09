import { currentProjectEpoch, projectGuardError, projectLedgerScope } from "./project-guard";
import type { Action } from "@reelterminal/core";
import type {
  DesktopLiveBridgeError as LiveBridgeError,
  DesktopLiveBridgeReply as LiveBridgeReply,
  DesktopLiveBridgeRequest as LiveBridgeRequest,
} from "@reelterminal/agent-facade/desktop-protocol";
import type {
  LiveEditorContext,
  LiveEditorControlParams,
  LiveEditorControlResult,
  LiveEditorControlTarget,
} from "@reelterminal/agent-facade/live-store";
import {
  useProjectStore,
  getActiveProjectRuntimeStore,
  getProjectChangesForStore,
  createProjectStore,
  type ProjectState,
} from "../../stores/project-store";
import type { StoreApi } from "zustand";
import { workspaceManager, type WorkspaceTarget } from "../workspace-manager";
import type {
  HistoryEntrySummary,
  HistoryGetResult,
  ProjectChangesParams,
} from "@reelterminal/agent-facade";
import { getLiveEditorContext } from "../../stores/editor-context-store";
import { useUIStore, type SelectionItem } from "../../stores/ui-store";
import { useTimelineStore } from "../../stores/timeline-store";
import { getPlaybackBridge } from "../../bridges/playback-bridge";
import { runExclusiveLiveWrite } from "./live-write-lock";
import { handleMaterialLibraryRequest } from "./material-bridge";
import { handleFontLibraryRequest } from "./font-bridge";
import { handlePresetLibraryRequest } from "./preset-bridge";
import { prepareLiveMedia } from "./prepare-live-media";
import { handleWorkspaceLibraryRequest } from "./workspace-bridge";
import {
  detachProjectMediaGc,
  releaseUncommittedMediaBlob,
  trackUncommittedMediaBlob,
} from "../project-media-gc";

/**
 * Renderer side of the desktop main-process live facade. The session reaches
 * the canonical project store through these
 * five requests. Mutations never arrive as state — only as core Actions, which
 * the renderer applies itself, CAS-checked, inside one owned history group.
 */

export const AGENT_HISTORY_OWNER = "agent";

export type { LiveBridgeError, LiveBridgeReply, LiveBridgeRequest };

interface HistoryControlLedgerEntry {
  readonly payload: string;
  readonly result: {
    readonly revision: number;
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly replayed: boolean;
  };
}

const historyControlLedger = new Map<
  string,
  Map<string, HistoryControlLedgerEntry>
>();

const noProject = (): { ok: false; error: LiveBridgeError } => ({
  ok: false,
  error: { code: "NO_PROJECT", message: "No project is open" },
});

function isActionBatchConflict(message: string): boolean {
  return message.includes("revision conflict") ||
    message === "Workspace runtime changed before action replay or commit" ||
    message === "Workspace changed while preparing the action batch" ||
    message === "Workspace changed before the action batch was persisted" ||
    message === "Workspace changed while persisting the action batch; the newer edit was preserved" ||
    message === "Editor context revision conflict" ||
    /idempotency key.+different request/i.test(message);
}

interface TargetRuntime {
  readonly store: StoreApi<ProjectState>;
  readonly state: ProjectState;
  readonly projectId: string;
  readonly workspaceId: string | null;
  readonly instanceId: string;
  readonly revision: number;
  readonly foreground: boolean;
}

async function targetRuntime(req: LiveBridgeRequest, checkExpectedInstance = true): Promise<TargetRuntime | null> {
  const projectId = req.projectId;
  const workspaceId = req.workspaceId;
  if (projectId !== undefined || workspaceId !== undefined) {
    if (!projectId || !workspaceId) {
      throw Object.assign(new Error("projectId and workspaceId must be supplied together"), { code: "INVALID_PARAMS" });
    }
    const target: WorkspaceTarget = { projectId, workspaceId };
    const context = await workspaceManager.getWorkspaceContext(target);
    const snapshot = workspaceManager.getSnapshot();
    const state = context.store.getState();
    if (checkExpectedInstance && req.expectedWorkspaceInstanceId !== undefined &&
        req.expectedWorkspaceInstanceId !== context.instanceId) {
      const conflict = new Error("Workspace runtime changed since the targeted read") as Error & { code: string };
      conflict.code = "CONFLICT";
      throw conflict;
    }
    return {
      store: context.store,
      state,
      projectId,
      workspaceId,
      instanceId: context.instanceId,
      // Pair revision with the exact synchronous store snapshot returned in
      // this handle; `context.revision` was captured before this final read.
      revision: state.workspaceRevision,
      foreground: snapshot.activeProjectId === projectId && snapshot.activeWorkspaceId === workspaceId,
    };
  }
  const store = getActiveProjectRuntimeStore();
  const state = store.getState();
  return state.hasOpenProject
    ? { store, state, projectId: state.project.id, workspaceId: state.workspaceId, instanceId: currentProjectEpoch(), revision: state.workspaceRevision, foreground: true }
    : null;
}

function routeGuard(req: LiveBridgeRequest) {
  return {
    expectedProjectId: req.expectedProjectId,
    expectedProjectEpoch: req.expectedProjectEpoch,
    targetProjectId: req.projectId,
    targetWorkspaceId: req.workspaceId,
    targetWorkspaceInstanceId: req.expectedWorkspaceInstanceId,
  };
}

function historySummary(state: ProjectState, revision: number, limit: number): HistoryGetResult {
  const actionEntries = [
    ...state.actionHistory.getHistoryEntries().map((entry) => ({
      direction: "undo" as const,
      description: entry.description,
      actionType: entry.action.type,
      owner: entry.owner === AGENT_HISTORY_OWNER ? "agent" as const : "human" as const,
      timestamp: entry.timestamp,
      groupId: entry.groupId ?? null,
    })),
    ...state.actionHistory.getRedoEntries().map((entry) => ({
      direction: "redo" as const,
      description: entry.description,
      actionType: entry.action.type,
      owner: entry.owner === AGENT_HISTORY_OWNER ? "agent" as const : "human" as const,
      timestamp: entry.timestamp,
      groupId: entry.groupId ?? null,
    })),
  ];
  const auxiliary: HistoryEntrySummary[] = [
    ...state.clipUndoStack.map((entry) => ({
      direction: "undo" as const,
      description: `${entry.op === "update" ? "Update" : "Create"} ${entry.type} overlay`,
      actionType: `overlay/${entry.op}`,
      owner: "human" as const,
      timestamp: entry.timestamp,
      groupId: null,
    })),
    ...state.clipRedoStack.map((entry) => ({
      direction: "redo" as const,
      description: `${entry.op === "update" ? "Update" : "Create"} ${entry.type} overlay`,
      actionType: `overlay/${entry.op}`,
      owner: "human" as const,
      timestamp: entry.timestamp,
      groupId: null,
    })),
    ...state.templateUndoStack.map((entry) => ({
      direction: "undo" as const,
      description: "Apply editing template",
      actionType: "template/apply",
      owner: "human" as const,
      timestamp: entry.timestamp,
      groupId: null,
    })),
    ...state.templateRedoStack.map((entry) => ({
      direction: "redo" as const,
      description: "Apply editing template",
      actionType: "template/apply",
      owner: "human" as const,
      timestamp: entry.timestamp,
      groupId: null,
    })),
  ];
  return {
    revision,
    available: true,
    canUndo: state.canUndo(),
    canRedo: state.canRedo(),
    undoCount:
      state.actionHistory.getUndoStackSize() +
      state.clipUndoStack.length +
      state.templateUndoStack.length,
    redoCount:
      state.actionHistory.getRedoStackSize() +
      state.clipRedoStack.length +
      state.templateRedoStack.length,
    entries: [...actionEntries, ...auxiliary]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit),
  };
}

async function handleHistoryControl(
  req: LiveBridgeRequest,
): Promise<Omit<LiveBridgeReply, "callId">> {
  return runExclusiveLiveWrite(async () => {
    const conflict = projectGuardError(routeGuard(req));
    if (conflict) return conflict;
    const runtime = await targetRuntime(req);
    if (!runtime) return noProject();
    if (req.historyAction !== "undo" && req.historyAction !== "redo") {
      return {
        ok: false,
        error: { code: "INVALID_PARAMS", message: "historyControl requires undo or redo" },
      };
    }
    const expectedRevision = req.expectedRevision;
    const key = req.idempotencyKey;
    const payload = JSON.stringify({ action: req.historyAction });
    const scope = projectLedgerScope({ projectId: runtime.projectId, workspaceId: runtime.workspaceId ?? undefined });
    const projectLedger = key ? historyControlLedger.get(scope) : undefined;
    const prior = key ? projectLedger?.get(key) : undefined;
    if (prior) {
      if (prior.payload !== payload) {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `idempotency key "${key}" was already committed with a different payload`,
          },
        };
      }
      return { ok: true, result: { ...prior.result, replayed: true } };
    }
    if (expectedRevision === undefined || expectedRevision !== runtime.revision) {
      return {
        ok: false,
        error: {
          code: "CONFLICT",
          message: `Workspace revision mismatch: expected ${String(expectedRevision)}, current ${runtime.revision}`,
          details: { currentRevision: runtime.revision },
        },
      };
    }
    let result: Awaited<ReturnType<ProjectState["undo"]>>;
    try {
      result = await workspaceManager.withWorkspaceWrite(
        { projectId: runtime.projectId, workspaceId: runtime.workspaceId! },
        expectedRevision,
        async (context) => {
          if (context.instanceId !== runtime.instanceId) throw new Error("Workspace runtime changed before history commit");
          return context.store.getState()[req.historyAction!]({ alreadySerialized: true });
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("revision conflict") || message.includes("runtime changed")) {
        return { ok: false, error: { code: "CONFLICT", message: `Workspace history conflict: ${message}` } };
      }
      throw error;
    }
    if (!result.success) {
      return {
        ok: false,
        error: {
          code: result.error?.code === "INVALID_PARAMS" ? "NOT_FOUND" : "ACTION_FAILED",
          message: result.error?.message ?? `${req.historyAction} failed`,
        },
      };
    }
    const value = {
      revision: runtime.store.getState().workspaceRevision,
      canUndo: runtime.store.getState().canUndo(),
      canRedo: runtime.store.getState().canRedo(),
      replayed: false,
    };
    if (key) {
      const ledger = projectLedger ?? new Map<string, HistoryControlLedgerEntry>();
      ledger.set(key, { payload, result: value });
      historyControlLedger.set(scope, ledger);
    }
    return { ok: true, result: value };
  }, req);
}

async function handleApplyActions(
  req: LiveBridgeRequest,
): Promise<Omit<LiveBridgeReply, "callId">> {
  const actions = Array.isArray(req.actions) ? req.actions : null;
  if (!actions || actions.length === 0) {
    return {
      ok: false,
      error: {
        code: "INVALID_PARAMS",
        message: "applyActions requires a non-empty actions array",
      },
    };
  }
  const groupLabel =
    typeof req.groupLabel === "string" && req.groupLabel.trim()
      ? req.groupLabel
      : "Agent edit";

  return runExclusiveLiveWrite(async () => {
    const conflict = projectGuardError(routeGuard(req));
    if (conflict) return conflict;
    const runtime = await targetRuntime(req);
    if (!runtime) return noProject();
    const store = runtime.state;

    // Commit-ledger replay first (same shape as handleHistoryControl): once
    // this project has committed the batch under this idempotencyKey, a
    // retry whose reply was lost replays the recorded result instead of
    // re-applying the ops — and it wins over the now-stale CAS below.
    const idempotencyKey =
      typeof req.idempotencyKey === "string" && req.idempotencyKey.length > 0
        ? req.idempotencyKey
        : undefined;
    const idempotency = idempotencyKey
      ? {
          operation: "edit.apply",
          key: idempotencyKey,
          request: req.idempotencyPayload !== undefined
            ? { semantic: req.idempotencyPayload, groupLabel }
            : { actions: req.actions, groupLabel },
          ...(req.idempotencyMetadata !== undefined
            ? { metadata: req.idempotencyMetadata }
            : {}),
        }
      : undefined;
    const target = { projectId: runtime.projectId, workspaceId: runtime.workspaceId! };
    if (idempotency) {
      try {
        const prior = await workspaceManager.getActionBatchReplay(target, idempotency, runtime.instanceId);
        if (prior) {
          return {
            ok: true,
            result: {
              revision: prior.revision,
              createdIds: prior.batch.createdIds,
              ...(prior.idempotencyMetadata !== undefined
                ? { idempotencyMetadata: prior.idempotencyMetadata }
                : {}),
              replayed: true,
            },
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isActionBatchConflict(message)) {
          return { ok: false, error: { code: "CONFLICT", message, details: { idempotencyKey } } };
        }
        throw error;
      }
    }

    // Check the revision before applying anything; a stale expectation rejects the
    // whole batch before anything is applied.
    if (req.expectedRevision === undefined || req.expectedRevision !== runtime.revision) {
      const currentRevision = runtime.revision;
      if (currentRevision !== req.expectedRevision) {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Workspace revision mismatch: expected ${String(req.expectedRevision)}, current ${currentRevision}. Re-read state and retry.`,
            details: { currentRevision },
          },
        };
      }
    }
    if (req.expectedContextRevision !== undefined) {
      const currentContextRevision = runtime.foreground ? getLiveEditorContext().contextRevision : 0;
      if (currentContextRevision !== req.expectedContextRevision) {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Editor context revision mismatch: expected ${req.expectedContextRevision}, current ${currentContextRevision}. Re-read context and retry.`,
            details: { currentContextRevision },
          },
        };
      }
    }

    const prepared = await prepareLiveMedia(actions, store.project, {
      projectId: runtime.projectId,
      workspaceId: runtime.workspaceId ?? "",
      expectedRevision: req.expectedRevision!,
    });
    // Reading/persisting replacement bytes is asynchronous. Re-check the
    // canonical context before committing the entire prepared batch once.
    const currentContext = await targetRuntime(req, false);
    if (projectGuardError(routeGuard(req)) || !currentContext ||
        currentContext.instanceId !== runtime.instanceId || currentContext.projectId !== runtime.projectId ||
        currentContext.workspaceId !== runtime.workspaceId ||
        (req.expectedContextRevision !== undefined && currentContext.foreground && getLiveEditorContext().contextRevision !== req.expectedContextRevision)) {
      await prepared.discard();
      return { ok: false, error: { code: "CONFLICT", message: "Workspace or editor context changed while preparing media" } };
    }
    let committed: Awaited<ReturnType<typeof workspaceManager.commitActionBatch>>;
    try {
      committed = await workspaceManager.commitActionBatch({
        target,
        expectedRevision: req.expectedRevision!,
        expectedInstanceId: runtime.instanceId,
        actions: prepared.actions,
        options: { groupLabel, historyOwner: AGENT_HISTORY_OWNER },
        ...(idempotency ? { idempotency } : {}),
        beforePersist: () => {
          if (req.expectedContextRevision !== undefined && runtime.store.getState().isForeground &&
              getLiveEditorContext().contextRevision !== req.expectedContextRevision) {
            throw new Error("Editor context revision conflict");
          }
          prepared.commit();
        },
      });
    } catch (error) {
      await prepared.discard();
      const message = error instanceof Error ? error.message : String(error);
      if (isActionBatchConflict(message)) {
        return { ok: false, error: { code: "CONFLICT", message: `Workspace commit conflict: ${message}` } };
      }
      throw error;
    }
    if (committed.replayed) {
      await prepared.discard();
      return {
        ok: true,
        result: {
          revision: committed.revision,
          createdIds: committed.batch.createdIds,
          ...(committed.idempotencyMetadata !== undefined
            ? { idempotencyMetadata: committed.idempotencyMetadata }
            : {}),
          replayed: true,
        },
      };
    }
    const batch = committed.batch;
    if (!batch.result.success) {
      await prepared.discard();
      return {
        ok: false,
        error: {
          code: "APPLY_FAILED",
          message: batch.result.error?.message ?? "applyActions failed",
          details: { appliedBeforeError: batch.applied },
        },
      };
    }

    await prepared.commit();

    // Agent edits land outside the GUI gesture paths, so nudge the preview
    // explicitly: clears processed-audio caches and forces a paused re-render
    // with the new project state.
    if (runtime.foreground) window.dispatchEvent(new CustomEvent("reelterminal:preview-invalidate"));

    return {
      ok: true,
      result: {
        revision: committed.revision,
        createdIds: batch.createdIds,
        ...(committed.idempotencyMetadata !== undefined
          ? { idempotencyMetadata: committed.idempotencyMetadata }
          : {}),
        replayed: committed.replayed,
      },
    };
  }, req);
}

async function handleReplayActions(
  req: LiveBridgeRequest,
): Promise<Omit<LiveBridgeReply, "callId">> {
  const conflict = projectGuardError(routeGuard(req));
  if (conflict) return conflict;
  const runtime = await targetRuntime(req);
  if (!runtime) return noProject();
  if (typeof req.idempotencyKey !== "string" || req.idempotencyKey.length === 0 ||
      req.idempotencyPayload === undefined) {
    return { ok: false, error: { code: "INVALID_PARAMS", message: "replayActions requires idempotencyKey and idempotencyPayload" } };
  }
  const idempotency = {
    operation: "edit.apply",
    key: req.idempotencyKey,
    request: {
      semantic: req.idempotencyPayload,
      groupLabel: typeof req.groupLabel === "string" && req.groupLabel.trim()
        ? req.groupLabel
        : "Agent edit",
    },
  };
  try {
    const prior = await workspaceManager.getActionBatchReplay(
      { projectId: runtime.projectId, workspaceId: runtime.workspaceId! },
      idempotency,
      runtime.instanceId,
    );
    if (!prior) return { ok: true, result: null };
    return {
      ok: true,
      result: {
        revision: prior.revision,
        createdIds: prior.batch.createdIds,
        ...(prior.idempotencyMetadata !== undefined
          ? { idempotencyMetadata: prior.idempotencyMetadata }
          : {}),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isActionBatchConflict(message)) {
      return { ok: false, error: { code: "CONFLICT", message, details: { idempotencyKey: req.idempotencyKey } } };
    }
    throw error;
  }
}

async function handleReplayMediaImport(
  req: LiveBridgeRequest,
): Promise<Omit<LiveBridgeReply, "callId">> {
  const conflict = projectGuardError(routeGuard(req));
  if (conflict) return conflict;
  const runtime = await targetRuntime(req);
  if (!runtime) return noProject();
  if (typeof req.idempotencyKey !== "string" || req.idempotencyKey.length === 0 ||
      req.idempotencyPayload === undefined) {
    return { ok: false, error: { code: "INVALID_PARAMS", message: "replayMediaImport requires idempotencyKey and idempotencyPayload" } };
  }
  try {
    const prior = await workspaceManager.getActionBatchReplay(
      { projectId: runtime.projectId, workspaceId: runtime.workspaceId! },
      {
        operation: "media.import",
        key: req.idempotencyKey,
        request: req.idempotencyPayload,
      },
      runtime.instanceId,
    );
    if (!prior) return { ok: true, result: null };
    const metadata = prior.idempotencyMetadata as {
      mediaId: string;
      name: string;
      type: "video" | "audio" | "image";
      metadata: NonNullable<LiveBridgeRequest["metadata"]>;
    } | undefined;
    if (!metadata) {
      return { ok: false, error: { code: "BRIDGE_ERROR", message: "Media import receipt is incomplete" } };
    }
    return {
      ok: true,
      result: { ...metadata, revision: prior.revision, replayed: true },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isActionBatchConflict(message)) {
      return { ok: false, error: { code: "CONFLICT", message, details: { idempotencyKey: req.idempotencyKey } } };
    }
    throw error;
  }
}

/**
 * Decode and persist a path through the same project-store importer used by
 * picker/drop imports, but stage it in a private runtime. The workspace gets
 * one canonical media/import action only after decoding succeeds, so failures
 * cannot partially mutate the visible or durable project.
 */
async function handleImportMedia(
  req: LiveBridgeRequest,
): Promise<Omit<LiveBridgeReply, "callId">> {
  return runExclusiveLiveWrite(async () => {
    const conflict = projectGuardError(routeGuard(req));
    if (conflict) return conflict;
    const runtime = await targetRuntime(req);
    if (!runtime) return noProject();
    if (typeof req.path !== "string" || req.path.trim().length === 0) {
      return {
        ok: false,
        error: { code: "INVALID_PARAMS", message: "importMedia requires a path" },
      };
    }

    const idempotencyKey =
      typeof req.idempotencyKey === "string" && req.idempotencyKey.length > 0
        ? req.idempotencyKey
        : undefined;
    const name = typeof req.name === "string" && req.name.trim()
      ? req.name.trim()
      : req.sourceFile?.name ?? req.path.split(/[\\/]/).pop() ?? "media";
    const payload = req.idempotencyPayload !== undefined
      ? req.idempotencyPayload
      : { path: req.path, name: req.name ?? null };
    const target = { projectId: runtime.projectId, workspaceId: runtime.workspaceId! };
    const idempotency = idempotencyKey
      ? { operation: "media.import", key: idempotencyKey, request: payload }
      : undefined;

    if (idempotency) {
      try {
        const prior = await workspaceManager.getActionBatchReplay(
          target,
          idempotency,
          runtime.instanceId,
        );
        if (prior) {
          const metadata = prior.idempotencyMetadata as {
            mediaId: string;
            name: string;
            type: "video" | "audio" | "image";
            metadata: NonNullable<LiveBridgeRequest["metadata"]>;
          } | undefined;
          if (!metadata) {
            return { ok: false, error: { code: "BRIDGE_ERROR", message: "Media import receipt is incomplete" } };
          }
          return { ok: true, result: { ...metadata, revision: prior.revision, replayed: true } };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isActionBatchConflict(message)) {
          return { ok: false, error: { code: "CONFLICT", message, details: { idempotencyKey } } };
        }
        throw error;
      }
    }

    if (req.expectedRevision === undefined || req.expectedRevision !== runtime.revision) {
      return {
        ok: false,
        error: {
          code: "CONFLICT",
          message: `Workspace revision mismatch: expected ${String(req.expectedRevision)}, current ${runtime.revision}`,
          details: { currentRevision: runtime.revision },
        },
      };
    }
    const importedType = req.type;
    const metadata = req.metadata;
    if (
      (importedType !== "video" && importedType !== "audio" && importedType !== "image") ||
      !metadata ||
      !Number.isSafeInteger(metadata.fileSize) || metadata.fileSize < 0 ||
      !Number.isFinite(metadata.durationSec) ||
      !Number.isFinite(metadata.width) ||
      !Number.isFinite(metadata.height) ||
      !Number.isFinite(metadata.frameRate) ||
      typeof metadata.codec !== "string"
    ) {
      return { ok: false, error: { code: "INVALID_PARAMS", message: "Media import metadata is invalid" } };
    }

    const sourceFile = req.sourceFile ?? {
      name,
      size: metadata.fileSize,
      lastModified: 0,
    };
    if (sourceFile.size !== metadata.fileSize) {
      return { ok: false, error: { code: "INVALID_PARAMS", message: "Media import file facts do not match the probed size" } };
    }

    const stagingStore = createProjectStore({
      initialProject: structuredClone(runtime.state.getFullProject()),
      workspaceId: runtime.workspaceId,
      workspaceRevision: runtime.revision,
      isForeground: false,
      isStaging: true,
    });
    let stagedMediaId: string | undefined;
    let stagedAction: Action | undefined;
    try {
      const staged = await stagingStore.getState().importMediaFromPath(req.path, name, {
        projectId: runtime.projectId,
        workspaceId: runtime.workspaceId ?? undefined,
        expectedRevision: runtime.revision,
        type: importedType,
        metadata,
        sourceFile,
        historyOwner: AGENT_HISTORY_OWNER,
        historyGroupLabel: req.groupLabel || "agent: media.import",
      });
      if (!staged.success || !staged.actionId) {
        return {
          ok: false,
          error: {
            code: staged.error?.code === "INVALID_PARAMS" ? "INVALID_PARAMS" : "DECODE_ERROR",
            message: staged.error?.message ?? "Media import failed",
          },
        };
      }
      stagedMediaId = staged.actionId;
      const mediaItem = stagingStore.getState().getMediaItem(stagedMediaId);
      const historyEntry = stagingStore.getState().actionHistory.getHistoryEntries().at(-1);
      if (!mediaItem?.blob || !historyEntry || historyEntry.action.type !== "media/import") {
        return { ok: false, error: { code: "DECODE_ERROR", message: "Media importer did not produce a complete import action" } };
      }
      stagedAction = historyEntry.action;
      // Keep imported bytes live for an explicitly requested cleanup while the
      // durable workspace transaction is being prepared.
      trackUncommittedMediaBlob(mediaItem.id, runtime.projectId);
    } finally {
      detachProjectMediaGc(stagingStore.getState().actionHistory);
    }

    try {
      const currentContext = await targetRuntime(req, false);
      if (
        projectGuardError(routeGuard(req)) ||
        !currentContext ||
        currentContext.instanceId !== runtime.instanceId ||
        currentContext.projectId !== runtime.projectId ||
        currentContext.workspaceId !== runtime.workspaceId ||
        currentContext.revision !== req.expectedRevision
      ) {
        return { ok: false, error: { code: "CONFLICT", message: "Workspace changed while preparing media import" } };
      }

      const mediaItem = stagedMediaId
        ? stagingStore.getState().getMediaItem(stagedMediaId)
        : undefined;
      if (!mediaItem || !stagedAction) {
        return { ok: false, error: { code: "DECODE_ERROR", message: "Staged media import is incomplete" } };
      }
      const resultMetadata = {
        mediaId: mediaItem.id,
        name: mediaItem.name,
        type: mediaItem.type,
        metadata: {
          durationSec: mediaItem.metadata.duration,
          width: mediaItem.metadata.width,
          height: mediaItem.metadata.height,
          frameRate: mediaItem.metadata.frameRate,
          codec: mediaItem.metadata.codec,
          fileSize: mediaItem.metadata.fileSize,
        },
      };
      let committed: Awaited<ReturnType<typeof workspaceManager.commitActionBatch>>;
      try {
        committed = await workspaceManager.commitActionBatch({
          target,
          expectedRevision: req.expectedRevision,
          expectedInstanceId: runtime.instanceId,
          actions: [stagedAction],
          options: { groupLabel: req.groupLabel || "agent: media.import", historyOwner: AGENT_HISTORY_OWNER },
          ...(idempotency
            ? { idempotency: { ...idempotency, metadata: resultMetadata } }
            : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isActionBatchConflict(message)) {
          return { ok: false, error: { code: "CONFLICT", message: `Workspace import conflict: ${message}` } };
        }
        throw error;
      }
      if (committed.replayed) {
        const prior = committed.idempotencyMetadata as typeof resultMetadata | undefined;
        if (!prior) return { ok: false, error: { code: "BRIDGE_ERROR", message: "Media import receipt is incomplete" } };
        return { ok: true, result: { ...prior, revision: committed.revision, replayed: true } };
      }
      if (!committed.batch.result.success) {
        return {
          ok: false,
          error: {
            code: "APPLY_FAILED",
            message: committed.batch.result.error?.message ?? "Media import failed",
          },
        };
      }
      if (runtime.foreground) window.dispatchEvent(new CustomEvent("reelterminal:preview-invalidate"));
      return { ok: true, result: { ...resultMetadata, revision: committed.revision, replayed: false } };
    } finally {
      if (stagedMediaId) releaseUncommittedMediaBlob(stagedMediaId);
    }
  }, req);
}

/**
 * The live-store contract requires fresh, detached values — never live store
 * references. The IPC structured clone already detaches cross-process, but
 * in-process callers (tests) get a real clone too. Falls back to the raw
 * value if a field proves un-cloneable (IPC still detaches on the wire).
 */
function detach<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

const LIVE_REVEAL_MEDIA_EVENT = "reelterminal:live-reveal-media";

/** Locate a rendered target without trusting ids as CSS selectors. */
function renderedEditorTarget(
  target: LiveEditorControlTarget,
): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const selector =
    target.kind === "media"
      ? "[data-live-media-id]"
      : "[data-live-editor-target-id]";
  return (
    Array.from(document.querySelectorAll<HTMLElement>(selector)).find((el) =>
      target.kind === "media"
        ? el.dataset.liveMediaId === target.id
        : el.dataset.liveEditorTargetId === target.id &&
          el.dataset.liveEditorTargetKind === target.kind,
    ) ?? null
  );
}

/** Ask the relevant editor surface to reveal and focus a target. */
async function revealEditorTargets(
  targets: readonly LiveEditorControlTarget[],
): Promise<LiveEditorControlTarget[]> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return [];
  }

  // AssetsPanel owns its tab state; this event keeps that internal detail out
  // of the project store while still making a media target visible to a human.
  for (const target of targets) {
    if (target.kind === "media") {
      useUIStore.getState().setPanelVisible("mediaLibrary", true);
      window.dispatchEvent(
        new CustomEvent(LIVE_REVEAL_MEDIA_EVENT, { detail: { id: target.id } }),
      );
    }
  }

  // Let a panel/tab state update commit before querying its target node.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const revealed: LiveEditorControlTarget[] = [];
  for (const target of targets) {
    const element = renderedEditorTarget(target);
    if (!element) continue;
    try {
      element.scrollIntoView({ block: "nearest", inline: "center" });
    } catch {
      // Some test DOMs do not implement scrollIntoView; focus remains useful.
    }
    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus();
    }
    revealed.push(target);
  }
  return revealed;
}

function targetSelectionItem(
  target: LiveEditorControlTarget,
  project: ReturnType<typeof useProjectStore.getState>["project"],
): SelectionItem | null {
  if (target.kind === "media") {
    return project.mediaLibrary.items.some((item) => item.id === target.id)
      ? { type: "media", id: target.id }
      : null;
  }

  if (target.kind === "text") {
    const text = (project.textClips ?? []).find((clip) => clip.id === target.id);
    return text ? { type: "text-clip", id: target.id, trackId: text.trackId } : null;
  }

  const track = project.timeline.tracks.find((candidate) =>
    candidate.clips.some((clip) => clip.id === target.id),
  );
  if (track) return { type: "clip", id: target.id, trackId: track.id };
  const shape = (project.shapeClips ?? []).find((clip) => clip.id === target.id);
  if (shape) return { type: "shape-clip", id: target.id, trackId: shape.trackId };
  const svg = (project.svgClips ?? []).find((clip) => clip.id === target.id);
  if (svg) return { type: "shape-clip", id: target.id, trackId: svg.trackId };
  const sticker = (project.stickerClips ?? []).find((clip) => clip.id === target.id);
  return sticker ? { type: "shape-clip", id: target.id, trackId: sticker.trackId } : null;
}

function controlResult(
  action: LiveEditorControlParams["action"],
  revealedTargets: readonly LiveEditorControlTarget[] = [],
): LiveEditorControlResult {
  const context = getLiveEditorContext();
  const timeline = useTimelineStore.getState();
  return {
    action,
    playbackState: timeline.playbackState,
    playheadSeconds: context.playheadSeconds ?? timeline.playheadPosition,
    selectedClipIds: [...context.selectedClipIds],
    selectedTextIds: [...context.selectedTextIds],
    selectedMediaIds: [...context.selectedMediaIds],
    revealedTargets: [...revealedTargets],
    contextRevision: context.contextRevision,
  };
}

async function handleEditorControl(
  req: LiveBridgeRequest,
): Promise<Omit<LiveBridgeReply, "callId">> {
  const runtime = await targetRuntime(req);
  if (!runtime) return noProject();
  if (!runtime.foreground) {
    return { ok: false, error: { code: "CONFLICT", message: "editor.control can only act on the workspace currently shown in the GUI" } };
  }
  const store = runtime.state;
  const context = getLiveEditorContext();
  if (
    req.expectedContextRevision !== undefined &&
    req.expectedContextRevision !== context.contextRevision
  ) {
    return {
      ok: false,
      error: {
        code: "CONFLICT",
        message: `Editor context revision mismatch: expected ${req.expectedContextRevision}, current ${context.contextRevision}. Re-read context and retry.`,
        details: { currentContextRevision: context.contextRevision },
      },
    };
  }
  const action = req.action;
  if (!action) {
    return {
      ok: false,
      error: { code: "INVALID_PARAMS", message: "editorControl requires action" },
    };
  }

  switch (action) {
    case "play":
      await getPlaybackBridge().play();
      break;
    case "pause":
      getPlaybackBridge().pause();
      break;
    case "seek":
      if (typeof req.timeSeconds !== "number" || !Number.isFinite(req.timeSeconds)) {
        return {
          ok: false,
          error: { code: "INVALID_PARAMS", message: "editorControl seek requires a finite timeSeconds" },
        };
      }
      await getPlaybackBridge().seek(req.timeSeconds);
      break;
    case "select": {
      const rawTargets = req.targets ?? [];
      const selectionItems: SelectionItem[] = [];
      for (const target of rawTargets) {
        const item = targetSelectionItem(target, store.project);
        if (!item) {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: `editorControl: ${target.kind} target "${target.id}" was not found in the open project`,
              details: { target },
            },
          };
        }
        selectionItems.push(item);
      }
      if (selectionItems.length === 0) {
        return {
          ok: false,
          error: { code: "INVALID_PARAMS", message: "editorControl select requires at least one target" },
        };
      }
      const ui = useUIStore.getState();
      if (req.selectionMode === "add") {
        const merged = [...ui.selectedItems];
        for (const item of selectionItems) {
          if (!merged.some((selected) => selected.type === item.type && selected.id === item.id)) {
            merged.push(item);
          }
        }
        ui.selectMultiple(merged);
      } else {
        ui.selectMultiple(selectionItems);
      }
      const revealed = await revealEditorTargets(rawTargets);
      return { ok: true, result: controlResult(action, revealed) };
    }
  }
  return { ok: true, result: controlResult(action) };
}

/** Handles one main→renderer live-store request (exported for tests). */
export async function handleLiveBridgeRequest(
  req: LiveBridgeRequest,
): Promise<Omit<LiveBridgeReply, "callId">> {
  try {
    const conflict = projectGuardError(routeGuard(req));
    if (conflict) return conflict;
    switch (req.kind) {
      case "getIdentity": {
        const runtime = await targetRuntime(req);
        if (!runtime) return noProject();
        return {
          ok: true,
          result: {
            projectId: runtime.projectId,
            projectName: runtime.state.project.name,
            workspaceId: runtime.workspaceId ?? undefined,
            workspaceInstanceId: runtime.instanceId,
            windowId: "main",
            projectEpoch: currentProjectEpoch(),
          },
        };
      }
      case "getState": {
        const runtime = await targetRuntime(req);
        if (!runtime) return noProject();
        const snapshot = runtime.store.getState();
        return {
          ok: true,
          result: {
            project: detach(snapshot.getFullProject()),
            revision: snapshot.workspaceRevision,
            instanceId: runtime.instanceId,
          },
        };
      }
      case "getContext": {
        const runtime = await targetRuntime(req);
        if (!runtime) return noProject();
        const empty: LiveEditorContext = {
          contextRevision: 0,
          playheadSeconds: null,
          selectedClipIds: [],
          selectedTextIds: [],
          selectedMediaIds: [],
          timeRange: null,
          canvasPoint: null,
          references: {},
        };
        return { ok: true, result: detach(runtime.foreground ? getLiveEditorContext() : empty) };
      }
      case "getProjectChanges": {
        const runtime = await targetRuntime(req);
        if (!runtime) return noProject();
        return {
          ok: true,
          result: detach(
            getProjectChangesForStore(runtime.store, {
              sinceRevision: req.sinceRevision as number,
              ...(req.limit !== undefined ? { limit: req.limit } : {}),
              ...(req.cursor !== undefined ? { cursor: req.cursor } : {}),
            } satisfies ProjectChangesParams),
          ),
        };
      }
      case "getHistory": {
        const runtime = await targetRuntime(req);
        if (!runtime) return noProject();
        return { ok: true, result: detach(historySummary(runtime.state, runtime.revision, req.limit ?? 20)) };
      }
      case "historyControl": {
        return await handleHistoryControl(req);
      }
      case "editorControl": {
        return await handleEditorControl(req);
      }
      case "applyActions": {
        return await handleApplyActions(req);
      }
      case "replayActions": {
        return await handleReplayActions(req);
      }
      case "replayMediaImport": {
        return await handleReplayMediaImport(req);
      }
      case "importMedia": {
        return await handleImportMedia(req);
      }
      case "materialLibrary": {
        // The canonical user-level material library lives renderer-side;
        // the facade only validated/guarded the verb before forwarding.
        const reply = await handleMaterialLibraryRequest({
          guard: routeGuard(req),
          verb: req.materialVerb,
          params: req.materialParams,
        });
        return reply as Omit<LiveBridgeReply, "callId">;
      }
      case "fontLibrary": {
        // The canonical custom-font store lives renderer-side (IndexedDB +
        // FontFace); the facade only validated/guarded the verb.
        const reply = await handleFontLibraryRequest({
          verb: req.fontVerb,
          params: req.fontParams,
        });
        return reply as Omit<LiveBridgeReply, "callId">;
      }
      case "presetLibrary": {
        // The canonical custom-preset store lives renderer-side (IndexedDB,
        // shared with the preset panels); apply expands into core actions
        // against the canonical project store right here.
        const reply = await handlePresetLibraryRequest({
          guard: routeGuard(req),
          verb: req.presetVerb,
          params: req.presetParams,
        });
        return reply as Omit<LiveBridgeReply, "callId">;
      }
      case "workspaceLibrary": {
        if (req.projectId && req.workspaceId) {
          // Verify the request-local runtime generation before the manager's
          // own workspace-queued persistent operation begins.
          const runtime = await targetRuntime(req);
          if (!runtime) return noProject();
        }
        return await handleWorkspaceLibraryRequest(
          req.workspaceVerb as Parameters<typeof handleWorkspaceLibraryRequest>[0],
          req.workspaceParams,
        ) as Omit<LiveBridgeReply, "callId">;
      }
      case "requestSave": {
        const store = useProjectStore.getState();
        if (!store.hasOpenProject) return noProject();
        // The same save path the GUI's lifecycle flush uses.
        await store.forceSave();
        return { ok: true, result: { revision: store.workspaceRevision } };
      }
      default: {
        return {
          ok: false,
          error: {
            code: "INVALID_PARAMS",
            message: `Unknown live bridge kind: ${String((req as { kind?: unknown }).kind)}`,
          },
        };
      }
    }
  } catch (error) {
    const code = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "BRIDGE_ERROR";
    return {
      ok: false,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Installs the main→renderer live-store listener. No-op off desktop or when
 * the preload doesn't expose the bridge (web app must never break).
 */
export function installLiveBridge(): () => void {
  if (typeof window === "undefined") return () => {};
  const bridge = window.reelterminal?.liveBridge;
  if (!bridge) return () => {};
  return bridge.onRequest(async (req) => {
    const reply = await handleLiveBridgeRequest(req);
    window.reelterminal?.liveBridge?.respond({ callId: req.callId, ...reply });
  });
}
