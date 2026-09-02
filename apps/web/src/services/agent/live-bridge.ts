import type { Action } from "@openreel/core/types/actions";
import type { TextClip, Transform } from "@openreel/core";
import type { TextStyle } from "@openreel/core/text/types";
import { v4 as uuidv4 } from "uuid";
import { useProjectStore, getProjectRevision } from "../../stores/project-store";
import { getLiveEditorContext } from "../../stores/editor-context-store";
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
    | "applyActions"
    | "requestSave";
  readonly actions?: readonly Action[];
  readonly groupLabel?: string;
  readonly expectedRevision?: number;
  readonly expectedContextRevision?: number;
}

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
 * LiveCreatedIds seam contract: tracks / clips / text overlays). createdIds
 * is computed as the after/before diff per category around the committed
 * batch (LiveApplyActionsResult contract: "the ids that genuinely exist in
 * the canonical project" — core mints entity ids; the store diffs canonical
 * state). The facade assigns one id per creating op from the op's OWN
 * category, so a mixed batch can't cross-assign ids.
 */
interface EntityIdsByCategory {
  readonly tracks: string[];
  readonly clips: string[];
  readonly textClips: string[];
}

function entityIdsByCategory(): EntityIdsByCategory {
  const project = useProjectStore.getState().project;
  return {
    tracks: project.timeline.tracks.map((t) => t.id),
    clips: project.timeline.tracks.flatMap((t) => t.clips.map((c) => c.id)),
    textClips: (project.textClips ?? []).map((c) => c.id),
  };
}

function diffByCategory(
  before: EntityIdsByCategory,
  after: EntityIdsByCategory,
): EntityIdsByCategory {
  const beforeTracks = new Set(before.tracks);
  const beforeClips = new Set(before.clips);
  const beforeText = new Set(before.textClips);
  return {
    tracks: after.tracks.filter((id) => !beforeTracks.has(id)),
    clips: after.clips.filter((id) => !beforeClips.has(id)),
    textClips: after.textClips.filter((id) => !beforeText.has(id)),
  };
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

    const idsBefore = entityIdsByCategory();
    let applied = 0;
    const executor = store.actionExecutor;
    executor.setPushOwner(AGENT_HISTORY_OWNER);
    store.beginHistoryGroup(groupLabel, AGENT_HISTORY_OWNER);
    let applyError: unknown;
    let applyFailed = false;
    try {
      for (const action of actions) {
        await applyOneAction(action);
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

    const createdIds = diffByCategory(idsBefore, entityIdsByCategory());

    return {
      ok: true,
      result: { revision: getProjectRevision(), createdIds },
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
      case "applyActions": {
        return await handleApplyActions(req);
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
