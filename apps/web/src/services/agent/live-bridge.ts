import type { Action } from "@openreel/core/types/actions";
import type { TextClip, Transform, Transition } from "@openreel/core";
import type {
  LiveEditorControlParams,
  LiveEditorControlResult,
  LiveEditorControlTarget,
} from "@openreel/agent-facade/live-store";
import type { TextStyle } from "@openreel/core/text/types";
import { v4 as uuidv4 } from "uuid";
import { useProjectStore, getProjectRevision } from "../../stores/project-store";
import { getLiveEditorContext } from "../../stores/editor-context-store";
import { useUIStore, type SelectionItem } from "../../stores/ui-store";
import { useTimelineStore } from "../../stores/timeline-store";
import { getPlaybackBridge } from "../../bridges/playback-bridge";
import { runExclusiveLiveWrite } from "./live-write-lock";

/**
 * Renderer side of the ADR 0004 Decision 1 seam: the desktop main-process live
 * facade session reaches the canonical project store exclusively through these
 * five requests. Mutations never arrive as state — only as core Actions, which
 * the renderer applies itself, CAS-checked, inside one owned history group.
 */

export const AGENT_HISTORY_OWNER = "agent";

export interface LiveBridgeRequest {
  readonly callId: string;
  readonly kind:
    | "getIdentity"
    | "getState"
    | "getContext"
    | "editorControl"
    | "applyActions"
    | "importMedia"
    | "requestSave";
  readonly actions?: readonly Action[];
  readonly groupLabel?: string;
  readonly expectedRevision?: number;
  readonly expectedContextRevision?: number;
  readonly action?: LiveEditorControlParams["action"];
  readonly timeSeconds?: number;
  readonly targets?: readonly LiveEditorControlTarget[];
  readonly selectionMode?: LiveEditorControlParams["selectionMode"];
  /** `importMedia` payload; path must be absolute and local. */
  readonly path?: string;
  readonly name?: string;
  readonly type?: "video" | "audio";
  readonly metadata?: {
    readonly durationSec: number;
    readonly width: number;
    readonly height: number;
    readonly frameRate: number;
    readonly codec: string;
    readonly fileSize: number;
  };
  readonly sourceFile?: {
    readonly name: string;
    readonly size: number;
    readonly lastModified: number;
  };
  readonly idempotencyKey?: string;
}

interface MediaImportLedgerEntry {
  readonly payload: string;
  readonly result: {
    readonly revision: number;
    readonly mediaId: string;
    readonly name: string;
    readonly type: "video" | "audio";
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

export interface LiveBridgeError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface LiveBridgeReply {
  readonly callId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: LiveBridgeError;
}

const noProject = (): { ok: false; error: LiveBridgeError } => ({
  ok: false,
  error: { code: "NO_PROJECT", message: "No project is open" },
});

/**
 * Entity ids the live facade cares about, partitioned by category (the
 * LiveCreatedIds seam contract: tracks / clips / text overlays / transitions).
 * `createdIds` is computed as the after/before diff per category around the committed
 * batch (LiveApplyActionsResult contract: "the ids that genuinely exist in
 * the canonical project" — core mints entity ids; the store diffs canonical
 * state). The facade assigns one id per creating op from the op's OWN
 * category, so a mixed batch can't cross-assign ids.
 */
interface EntityIdsByCategory {
  readonly tracks: string[];
  readonly clips: string[];
  readonly textClips: string[];
  readonly transitions: string[];
}

function entityIdsByCategory(): EntityIdsByCategory {
  const project = useProjectStore.getState().project;
  return {
    tracks: project.timeline.tracks.map((t) => t.id),
    clips: project.timeline.tracks.flatMap((t) => t.clips.map((c) => c.id)),
    textClips: (project.textClips ?? []).map((c) => c.id),
    transitions: project.timeline.tracks.flatMap((track) =>
      (track.transitions ?? []).map((transition) => transition.id),
    ),
  };
}

function diffByCategory(
  before: EntityIdsByCategory,
  after: EntityIdsByCategory,
): EntityIdsByCategory {
  const beforeTracks = new Set(before.tracks);
  const beforeClips = new Set(before.clips);
  const beforeText = new Set(before.textClips);
  const beforeTransitions = new Set(before.transitions);
  return {
    tracks: after.tracks.filter((id) => !beforeTracks.has(id)),
    clips: after.clips.filter((id) => !beforeClips.has(id)),
    textClips: after.textClips.filter((id) => !beforeText.has(id)),
    transitions: after.transitions.filter(
      (id) => !beforeTransitions.has(id),
    ),
  };
}

function appendCreatedIds(
  target: EntityIdsByCategory,
  created: EntityIdsByCategory,
): void {
  target.tracks.push(...created.tracks);
  target.clips.push(...created.clips);
  target.textClips.push(...created.textClips);
  target.transitions.push(...created.transitions);
}

/**
 * Engine-aware text routing (ADR 0004 Decision 2): overlay actions must go
 * through the TitleEngine-backed store methods — raw executor application
 * writes only the project mirror and renders nothing. Everything else goes
 * through the same executeAction path as manual GUI edits.
 */
async function applyOneAction(
  action: Action,
): Promise<void> {
  const store = useProjectStore.getState();

  if (action.type === "text/create") {
    const clip = (action.params as { clip: TextClip }).clip;
    const tracks = store.project.timeline.tracks;
    let trackId =
      clip.trackId && tracks.some((t) => t.id === clip.trackId)
        ? clip.trackId
        : undefined;
    if (!trackId) {
      // Mirror the editor's text-overlay track resolution.
      const existing = tracks.find((t) => t.type === "text");
      if (existing) {
        trackId = existing.id;
      } else {
        await store.executeAction({
          type: "track/add",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { trackType: "text" },
        } as Action);
        const created = useProjectStore
          .getState()
          .project.timeline.tracks.find((t) => t.type === "text");
        if (!created) throw new Error("Failed to create a text track");
        trackId = created.id;
      }
    }
    const created = useProjectStore
      .getState()
      .createTextClip(
        trackId,
        clip.startTime,
        clip.text,
        clip.duration,
        clip.style as Partial<TextStyle> | undefined,
        clip.metadata,
        {
          // The facade translator minted this id; keep it so createdIds and
          // follow-up verbs (text.update et al.) address the same clip.
          id: clip.id,
          ...(clip.transform !== undefined
            ? { transform: clip.transform as Partial<Transform> }
            : {}),
        },
      );
    if (!created) throw new Error("Failed to create text overlay");
    return;
  }

  if (action.type === "text/update") {
    const { clipId, updates } = action.params as {
      clipId: string;
      updates: Partial<TextClip>;
    };
    if (!store.getTextClip(clipId)) {
      throw new Error(`Text overlay "${clipId}" not found`);
    }
    if (updates.text !== undefined) {
      if (!store.updateTextContent(clipId, updates.text)) {
        throw new Error(`Failed to update text overlay "${clipId}" content`);
      }
    }
    if (updates.style !== undefined) {
      if (!store.updateTextStyle(clipId, updates.style)) {
        throw new Error(`Failed to update text overlay "${clipId}" style`);
      }
    }
    if (updates.transform !== undefined) {
      if (!store.updateTextTransform(clipId, updates.transform)) {
        throw new Error(`Failed to update text overlay "${clipId}" transform`);
      }
    }
    if (
      updates.startTime !== undefined ||
      updates.duration !== undefined ||
      updates.keyframes !== undefined
    ) {
      const timing: {
        startTime?: number;
        duration?: number;
        keyframes?: TextClip["keyframes"];
      } = {};
      if (updates.startTime !== undefined) timing.startTime = updates.startTime;
      if (updates.duration !== undefined) timing.duration = updates.duration;
      if (updates.keyframes !== undefined) timing.keyframes = updates.keyframes;
      if (!store.updateOverlayClipTiming(clipId, timing)) {
        throw new Error(`Failed to update text overlay "${clipId}" timing`);
      }
    }
    return;
  }

  if (action.type === "text/remove") {
    const { clipId } = action.params as { clipId: string };
    if (!store.deleteTextClip(clipId)) {
      throw new Error(`Failed to delete text overlay "${clipId}"`);
    }
    return;
  }

  // Transition actions use the editor's transition-aware store methods so
  // the project model and TransitionBridge stay synchronized for preview,
  // inspection, undo/redo, and export. A raw executor call would update the
  // project array but leave the renderer bridge stale until a later reload.
  if (action.type === "transition/set") {
    const { transition } = action.params as { transition: Transition };
    const created = await store.addClipTransition(transition);
    if (!created) {
      throw new Error(`Failed to add transition "${transition.id}"`);
    }
    return;
  }

  if (action.type === "transition/update") {
    const { transitionId, ...updates } = action.params as {
      transitionId: string;
      type?: Transition["type"];
      duration?: number;
      params?: Record<string, unknown>;
    };
    const updated = await store.updateClipTransition(transitionId, updates);
    if (!updated) {
      throw new Error(`Failed to update transition "${transitionId}"`);
    }
    return;
  }

  if (action.type === "transition/remove") {
    const { transitionId } = action.params as { transitionId: string };
    if (!(await store.removeClipTransition(transitionId))) {
      throw new Error(`Failed to remove transition "${transitionId}"`);
    }
    return;
  }

  const result = await store.executeAction(action);
  if (!result.success) {
    throw new Error(result.error?.message ?? `Action ${action.type} failed`);
  }
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

    // Accumulate per action rather than diffing once after the whole batch.
    // Project traversal order is not creation order when, for example, a
    // later action adds a clip to an earlier track. The live facade consumes
    // each category bucket in op order, so this ordering is part of the seam.
    const createdIds: EntityIdsByCategory = {
      tracks: [],
      clips: [],
      textClips: [],
      transitions: [],
    };
    let applied = 0;
    const executor = store.actionExecutor;
    executor.setPushOwner(AGENT_HISTORY_OWNER);
    store.beginHistoryGroup(groupLabel, AGENT_HISTORY_OWNER);
    let applyError: unknown;
    let applyFailed = false;
    try {
      for (const action of actions) {
        const idsBeforeAction = entityIdsByCategory();
        await applyOneAction(action);
        appendCreatedIds(
          createdIds,
          diffByCategory(idsBeforeAction, entityIdsByCategory()),
        );
        applied += 1;
      }
    } catch (error) {
      applyFailed = true;
      applyError = error;
    } finally {
      // ALWAYS reset the push owner and close the group — even when the
      // rollback below throws — otherwise a stranded "agent" owner would
      // misattribute later human edits to the agent (Decision 12).
      useProjectStore.getState().endHistoryGroup();
      executor.setPushOwner(undefined);
    }
    if (applyFailed) {
      // A group undo reverts
      // everything this batch applied — but only when something was
      // actually applied, otherwise the undo would eat a pre-existing user
      // edit. If this undo itself throws, the bridge reports BRIDGE_ERROR
      // (the push owner is already reset above).
      if (applied > 0) {
        await useProjectStore.getState().undo();
      }
      return {
        ok: false,
        error: {
          code: "APPLY_FAILED",
          message:
            applyError instanceof Error
              ? applyError.message
              : "applyActions failed",
          details: { appliedBeforeError: applied },
        },
      };
    }

    // Agent edits land outside the GUI gesture paths, so nudge the preview
    // explicitly: clears processed-audio caches and forces a paused re-render
    // with the new project state.
    window.dispatchEvent(new CustomEvent("openreel:preview-invalidate"));

    return {
      ok: true,
      result: { revision: getProjectRevision(), createdIds },
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
    if (item.type !== "video" && item.type !== "audio") {
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
      case "editorControl": {
        return await handleEditorControl(req);
      }
      case "applyActions": {
        return await handleApplyActions(req);
      }
      case "importMedia": {
        return await handleImportMedia(req);
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
  bridge.onRequest(async (req) => {
    const reply = await handleLiveBridgeRequest(req);
    window.openreel?.liveBridge?.respond({ callId: req.callId, ...reply });
  });
  return () => {};
}
