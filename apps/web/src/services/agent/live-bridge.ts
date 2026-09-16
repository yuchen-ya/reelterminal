import type {
  DesktopLiveBridgeError as LiveBridgeError,
  DesktopLiveBridgeReply as LiveBridgeReply,
  DesktopLiveBridgeRequest as LiveBridgeRequest,
} from "@openreel/agent-facade/desktop-protocol";
import type {
  LiveEditorControlParams,
  LiveEditorControlResult,
  LiveEditorControlTarget,
} from "@openreel/agent-facade/live-store";
import {
  useProjectStore,
  getProjectChanges,
  getProjectRevision,
} from "../../stores/project-store";
import type {
  HistoryEntrySummary,
  HistoryGetResult,
  ProjectChangesParams,
} from "@openreel/agent-facade";
import { getLiveEditorContext } from "../../stores/editor-context-store";
import { useUIStore, type SelectionItem } from "../../stores/ui-store";
import { useTimelineStore } from "../../stores/timeline-store";
import { getPlaybackBridge } from "../../bridges/playback-bridge";
import { runExclusiveLiveWrite } from "./live-write-lock";
import { handleMaterialLibraryRequest } from "./material-bridge";
import { handleFontLibraryRequest } from "./font-bridge";
import { prepareLiveMedia } from "./prepare-live-media";

/**
 * Renderer side of the ADR 0004 Decision 1 seam: the desktop main-process live
 * facade session reaches the canonical project store exclusively through these
 * five requests. Mutations never arrive as state — only as core Actions, which
 * the renderer applies itself, CAS-checked, inside one owned history group.
 */

export const AGENT_HISTORY_OWNER = "agent";

export type { LiveBridgeError, LiveBridgeReply, LiveBridgeRequest };

interface MediaImportLedgerEntry {
  readonly payload: string;
  readonly result: {
    readonly revision: number;
    readonly mediaId: string;
    readonly name: string;
    readonly type: "video" | "audio" | "image";
    readonly metadata: {
      readonly durationSec: number;
      readonly width: number;
      readonly height: number;
      readonly frameRate: number;
      readonly codec: string;
      readonly fileSize: number;
    };
  };
}

/** Renderer-side commit ledger closes the timeout/retry duplicate window. */
const mediaImportLedger = new Map<string, Map<string, MediaImportLedgerEntry>>();

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

interface ApplyActionsLedgerEntry {
  readonly payload: string;
  readonly result: {
    readonly revision: number;
    readonly createdIds: unknown;
  };
}

/** Per-project ledger closing the applyActions timeout/retry window. */
const applyActionsLedger = new Map<
  string,
  Map<string, ApplyActionsLedgerEntry>
>();

const noProject = (): { ok: false; error: LiveBridgeError } => ({
  ok: false,
  error: { code: "NO_PROJECT", message: "No project is open" },
});

function historySummary(limit: number): HistoryGetResult {
  const store = useProjectStore.getState();
  const actionEntries = [
    ...store.actionHistory.getHistoryEntries().map((entry) => ({
      direction: "undo" as const,
      description: entry.description,
      actionType: entry.action.type,
      owner: entry.owner === AGENT_HISTORY_OWNER ? "agent" as const : "human" as const,
      timestamp: entry.timestamp,
      groupId: entry.groupId ?? null,
    })),
    ...store.actionHistory.getRedoEntries().map((entry) => ({
      direction: "redo" as const,
      description: entry.description,
      actionType: entry.action.type,
      owner: entry.owner === AGENT_HISTORY_OWNER ? "agent" as const : "human" as const,
      timestamp: entry.timestamp,
      groupId: entry.groupId ?? null,
    })),
  ];
  const auxiliary: HistoryEntrySummary[] = [
    ...store.clipUndoStack.map((entry) => ({
      direction: "undo" as const,
      description: `${entry.op === "update" ? "Update" : "Create"} ${entry.type} overlay`,
      actionType: `overlay/${entry.op}`,
      owner: "human" as const,
      timestamp: entry.timestamp,
      groupId: null,
    })),
    ...store.clipRedoStack.map((entry) => ({
      direction: "redo" as const,
      description: `${entry.op === "update" ? "Update" : "Create"} ${entry.type} overlay`,
      actionType: `overlay/${entry.op}`,
      owner: "human" as const,
      timestamp: entry.timestamp,
      groupId: null,
    })),
    ...store.templateUndoStack.map((entry) => ({
      direction: "undo" as const,
      description: "Apply editing template",
      actionType: "template/apply",
      owner: "human" as const,
      timestamp: entry.timestamp,
      groupId: null,
    })),
    ...store.templateRedoStack.map((entry) => ({
      direction: "redo" as const,
      description: "Apply editing template",
      actionType: "template/apply",
      owner: "human" as const,
      timestamp: entry.timestamp,
      groupId: null,
    })),
  ];
  return {
    revision: getProjectRevision(),
    available: true,
    canUndo: store.canUndo(),
    canRedo: store.canRedo(),
    undoCount:
      store.actionHistory.getUndoStackSize() +
      store.clipUndoStack.length +
      store.templateUndoStack.length,
    redoCount:
      store.actionHistory.getRedoStackSize() +
      store.clipRedoStack.length +
      store.templateRedoStack.length,
    entries: [...actionEntries, ...auxiliary]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit),
  };
}

async function handleHistoryControl(
  req: LiveBridgeRequest,
): Promise<Omit<LiveBridgeReply, "callId">> {
  return runExclusiveLiveWrite(async () => {
    const store = useProjectStore.getState();
    if (!store.hasOpenProject) return noProject();
    if (req.historyAction !== "undo" && req.historyAction !== "redo") {
      return {
        ok: false,
        error: { code: "INVALID_PARAMS", message: "historyControl requires undo or redo" },
      };
    }
    const expectedRevision = req.expectedRevision;
    const key = req.idempotencyKey;
    const payload = JSON.stringify({ action: req.historyAction });
    const projectLedger = key ? historyControlLedger.get(store.project.id) : undefined;
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
    if (expectedRevision === undefined || expectedRevision !== getProjectRevision()) {
      return {
        ok: false,
        error: {
          code: "CONFLICT",
          message: `Project revision mismatch: expected ${String(expectedRevision)}, current ${getProjectRevision()}`,
          details: { currentRevision: getProjectRevision() },
        },
      };
    }
    const result = await store[req.historyAction]();
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
      revision: getProjectRevision(),
      canUndo: useProjectStore.getState().canUndo(),
      canRedo: useProjectStore.getState().canRedo(),
      replayed: false,
    };
    if (key) {
      const ledger = projectLedger ?? new Map<string, HistoryControlLedgerEntry>();
      ledger.set(key, { payload, result: value });
      historyControlLedger.set(store.project.id, ledger);
    }
    return { ok: true, result: value };
  });
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
    const store = useProjectStore.getState();
    if (!store.hasOpenProject) return noProject();

    // Commit-ledger replay first (same shape as handleHistoryControl): once
    // this project has committed the batch under this idempotencyKey, a
    // retry whose reply was lost replays the recorded result instead of
    // re-applying the ops — and it wins over the now-stale CAS below.
    const idempotencyKey =
      typeof req.idempotencyKey === "string" && req.idempotencyKey.length > 0
        ? req.idempotencyKey
        : undefined;
    const payload = JSON.stringify({ actions: req.actions ?? null, groupLabel });
    const projectLedger = idempotencyKey
      ? applyActionsLedger.get(store.project.id)
      : undefined;
    const prior = idempotencyKey ? projectLedger?.get(idempotencyKey) : undefined;
    if (prior) {
      if (prior.payload !== payload) {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `idempotency key "${idempotencyKey}" was already committed with a different payload`,
            details: { idempotencyKey },
          },
        };
      }
      return { ok: true, result: { ...prior.result, replayed: true } };
    }

    // CAS first (ADR 0004 Decisions 3 + 4): a stale expectation rejects the
    // whole batch before anything is applied.
    if (req.expectedRevision !== undefined) {
      const currentRevision = getProjectRevision();
      if (currentRevision !== req.expectedRevision) {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Project revision mismatch: expected ${req.expectedRevision}, current ${currentRevision}. Re-read state and retry.`,
            details: { currentRevision },
          },
        };
      }
    }
    if (req.expectedContextRevision !== undefined) {
      const currentContextRevision = getLiveEditorContext().contextRevision;
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

    const prepared = await prepareLiveMedia(actions, store.project);
    // Reading/persisting replacement bytes is asynchronous. Re-check the
    // canonical context before committing the entire prepared batch once.
    if (useProjectStore.getState().project.id !== store.project.id ||
        (req.expectedRevision !== undefined && getProjectRevision() !== req.expectedRevision) ||
        (req.expectedContextRevision !== undefined && getLiveEditorContext().contextRevision !== req.expectedContextRevision)) {
      await prepared.discard();
      return { ok: false, error: { code: "CONFLICT", message: "Project or editor context changed while preparing media" } };
    }
    const batch = store.executeActionBatch(prepared.actions, {
      groupLabel,
      historyOwner: AGENT_HISTORY_OWNER,
    });
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

    // Agent edits land outside the GUI gesture paths, so nudge the preview
    // explicitly: clears processed-audio caches and forces a paused re-render
    // with the new project state.
    window.dispatchEvent(new CustomEvent("openreel:preview-invalidate"));

    // Record only after the commit landed (a failed batch retries freely).
    if (idempotencyKey) {
      let ledger = applyActionsLedger.get(store.project.id);
      if (!ledger) {
        ledger = new Map();
        applyActionsLedger.set(store.project.id, ledger);
      }
      ledger.set(idempotencyKey, {
        payload,
        result: { revision: getProjectRevision(), createdIds: batch.createdIds },
      });
    }

    return {
      ok: true,
      result: {
        revision: getProjectRevision(),
        createdIds: batch.createdIds,
        replayed: false,
      },
    };
  });
}

/**
 * Import a path that was validated/probed by the main-process facade. The
 * renderer reads the bytes through the existing fs preload and then delegates
 * to the exact same project-store import path as a picker/drop import. This is
 * intentionally one store call: media metadata, persistence, and the project
 * revision stay together and the GUI observes the new library item normally.
 */
async function handleImportMedia(
  req: LiveBridgeRequest,
): Promise<Omit<LiveBridgeReply, "callId">> {
  return runExclusiveLiveWrite(async () => {
    const store = useProjectStore.getState();
    if (!store.hasOpenProject) return noProject();
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
    const payload = JSON.stringify({ path: req.path, name: req.name ?? null });
    const projectLedger = idempotencyKey
      ? mediaImportLedger.get(store.project.id)
      : undefined;
    const prior = idempotencyKey ? projectLedger?.get(idempotencyKey) : undefined;
    if (prior) {
      if (prior.payload !== payload) {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `idempotency key "${idempotencyKey}" was already committed with a different payload`,
            details: { idempotencyKey },
          },
        };
      }
      return { ok: true, result: { ...prior.result, replayed: true } };
    }

    const result = await store.importMediaFromPath(req.path, req.name, {
      expectedRevision: req.expectedRevision,
      type: req.type,
      metadata: req.metadata,
      sourceFile: req.sourceFile,
      historyOwner: "agent",
      historyGroupLabel: req.groupLabel || "agent: media.import",
    });
    if (!result.success) {
      const reason = result.error?.details?.reason;
      return {
        ok: false,
        error: {
          code: reason === "CONFLICT" ? "CONFLICT" : result.error?.code ?? "DECODE_ERROR",
          message: result.error?.message ?? "Failed to import media",
          ...(result.error?.details ? { details: result.error.details } : {}),
        },
      };
    }

    const mediaId = result.actionId;
    const item = mediaId ? useProjectStore.getState().getMediaItem(mediaId) : undefined;
    if (!mediaId || !item) {
      return {
        ok: false,
        error: {
          code: "BRIDGE_ERROR",
          message: "Media import completed without a canonical media item",
        },
      };
    }
    if (item.type !== "video" && item.type !== "audio" && item.type !== "image") {
      return {
        ok: false,
        error: {
          code: "BRIDGE_ERROR",
          message: `Live media import produced unsupported type "${item.type}"`,
        },
      };
    }

    const committed = {
      revision: getProjectRevision(),
      mediaId,
      name: item.name,
      type: item.type,
      metadata: {
        durationSec: item.metadata.duration,
        width: item.metadata.width,
        height: item.metadata.height,
        frameRate: item.metadata.frameRate,
        codec: item.metadata.codec,
        fileSize: item.metadata.fileSize,
      },
    } as const;
    if (idempotencyKey) {
      let ledger = mediaImportLedger.get(store.project.id);
      if (!ledger) {
        ledger = new Map();
        mediaImportLedger.set(store.project.id, ledger);
      }
      ledger.set(idempotencyKey, { payload, result: committed });
    }

    return {
      ok: true,
      result: {
        ...committed,
        replayed: false,
      },
    };
  });
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

const LIVE_REVEAL_MEDIA_EVENT = "openreel:live-reveal-media";

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
  const store = useProjectStore.getState();
  if (!store.hasOpenProject) return noProject();
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
    switch (req.kind) {
      case "getIdentity": {
        const store = useProjectStore.getState();
        if (!store.hasOpenProject) return noProject();
        return {
          ok: true,
          result: {
            projectId: store.project.id,
            projectName: store.project.name,
            windowId: "main",
          },
        };
      }
      case "getState": {
        const store = useProjectStore.getState();
        if (!store.hasOpenProject) return noProject();
        return {
          ok: true,
          result: {
            project: detach(store.getFullProject()),
            revision: getProjectRevision(),
          },
        };
      }
      case "getContext": {
        return { ok: true, result: detach(getLiveEditorContext()) };
      }
      case "getProjectChanges": {
        const store = useProjectStore.getState();
        if (!store.hasOpenProject) return noProject();
        return {
          ok: true,
          result: detach(
            getProjectChanges({
              sinceRevision: req.sinceRevision as number,
              ...(req.limit !== undefined ? { limit: req.limit } : {}),
              ...(req.cursor !== undefined ? { cursor: req.cursor } : {}),
            } satisfies ProjectChangesParams),
          ),
        };
      }
      case "getHistory": {
        const store = useProjectStore.getState();
        if (!store.hasOpenProject) return noProject();
        return { ok: true, result: detach(historySummary(req.limit ?? 20)) };
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
      case "importMedia": {
        return await handleImportMedia(req);
      }
      case "materialLibrary": {
        // The canonical user-level material library lives renderer-side;
        // the facade only validated/guarded the verb before forwarding.
        const reply = await handleMaterialLibraryRequest({
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
      case "requestSave": {
        const store = useProjectStore.getState();
        if (!store.hasOpenProject) return noProject();
        // The same save path the GUI's lifecycle flush uses.
        await store.forceSave();
        return { ok: true, result: { revision: getProjectRevision() } };
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
    return {
      ok: false,
      error: {
        code: "BRIDGE_ERROR",
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
  const bridge = window.openreel?.liveBridge;
  if (!bridge) return () => {};
  return bridge.onRequest(async (req) => {
    const reply = await handleLiveBridgeRequest(req);
    window.openreel?.liveBridge?.respond({ callId: req.callId, ...reply });
  });
}
