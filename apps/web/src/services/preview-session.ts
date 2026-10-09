import i18next from "i18next";
import {
  activateProjectStore,
  useProjectStore,
} from "../stores/project-store";
import { useUIStore, type SelectionItem } from "../stores/ui-store";
import { useTimelineStore } from "../stores/timeline-store";
import { useEngineStore } from "../stores/engine-store";
import {
  toast,
  useNotificationStore,
  type Notification,
} from "../stores/notification-store";
import {
  applyViewState,
  captureCurrentViewState,
  workspaceManager,
  type PreviewHandle,
  type ProjectNodeSummary,
  type WorkspaceTarget,
  type WorkspaceViewState,
} from "./workspace-manager";
import { getTimelineSelectionItem } from "../utils/timeline-item-actions";

/**
 * Read-only preview of a historical version node (or an Agent trial
 * workspace). The editing workspace store stays fully intact in the
 * background — preview never loads content over the active editing store.
 *
 * UI contract (docs/VERSION-NODES-UX.md):
 * - enter/exit preserve the editing workspace's selection, undo chain,
 *   playhead, zoom and scroll position.
 * - While active, editing actions are rejected (read-only) and Ctrl+S
 *   only reports "this version is already saved".
 * - Multiple enters replace the previewed content without creating
 *   workspaces or nodes.
 */

export type PreviewSource =
  | { kind: "node"; nodeId: string }
  | { kind: "workspace"; workspaceId: string };

export interface VersionPreviewInfo {
  projectId: string;
  nodeId: string | null;
  workspaceId: string | null;
  nodeName: string;
  summary: string;
  createdAt: number | null;
  missingDependencies: string[];
  /** True when previewing an Agent trial workspace rather than a saved node. */
  agentTrial: boolean;
}

export interface PreviewSessionState {
  active: boolean;
  busy: boolean;
  info: VersionPreviewInfo | null;
}

export interface PreviewSessionApi {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PreviewSessionState;
  /** Begin (or switch) the read-only preview. Pauses playback first. */
  enter(source: PreviewSource): Promise<void>;
  /** Return to current editing, restoring the saved view state. */
  exit(): Promise<void>;
  /** Copy selected historical clips and insert them at the editing view's original playhead. */
  copyToCurrent(clipIds: string[]): Promise<void>;
  /**
   * "Continue editing from here": protect the current dirty edit as a
   * recovery draft, adopt the previewed content into the editing
   * workspace, start a fresh undo chain, then exit preview. On a
   * concurrent-edit conflict nothing is overwritten and an error is
   * thrown (both results remain preserved).
   */
  adopt(): Promise<void>;
  /** Node summary lookup helper for tooltips (lightweight, no snapshot load). */
  getNodeSummary(projectId: string, nodeId: string): Promise<ProjectNodeSummary | null>;
}

let snapshot: PreviewSessionState = Object.freeze({ active: false, busy: false, info: null });
const listeners = new Set<() => void>();

function publish(partial: Partial<PreviewSessionState>): void {
  snapshot = Object.freeze({ ...snapshot, ...partial });
  listeners.forEach((listener) => listener());
}

/** Detached preview handle while a session is active (null when inactive). */
let handle: PreviewHandle | null = null;
/** View state of the EDITING workspace, captured once when preview begins. */
let savedViewState: WorkspaceViewState | null = null;
/** Active workspace when preview began; a change means the user left the context. */
let editingWorkspaceIdAtEnter: string | null = null;
let managerUnsubscribe: (() => void) | null = null;
/** One "preview is read-only" hint per session, fired on the first blocked edit. */
let readOnlyToastShown = false;

/** Pause playback through the same two choke points as workspace switchView. */
function pausePlayback(): void {
  useEngineStore.getState().getPlaybackController()?.pause();
  useTimelineStore.getState().pause();
}

function startManagerWatch(): void {
  if (managerUnsubscribe) return;
  managerUnsubscribe = workspaceManager.subscribe(() => {
    if (!handle || !snapshot.info) return;
    const manager = workspaceManager.getSnapshot();
    const sameProject = manager.activeProjectId === snapshot.info.projectId;
    const sameWorkspace = manager.activeWorkspaceId === editingWorkspaceIdAtEnter;
    if (sameProject && sameWorkspace) return;
    // Project or workspace switched while previewing: drop the preview
    // without applying the stale view state — the switch already installed
    // the new context's own view state.
    void teardown({ restoreView: false });
  });
}

/**
 * Timeline selections that point at timeline content must still exist in the
 * restored project; otherwise clear the whole selection (never substitute
 * another clip as a stand-in restore).
 */
function selectedItemsExistInRestoredProject(items: SelectionItem[]): boolean {
  if (items.length === 0) return true;
  const project = useProjectStore.getState().project;
  const ids = new Set<string>();
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) ids.add(clip.id);
    for (const transition of track.transitions ?? []) ids.add(transition.id);
  }
  for (const clip of project.textClips ?? []) ids.add(clip.id);
  for (const clip of project.shapeClips ?? []) ids.add(clip.id);
  for (const clip of project.svgClips ?? []) ids.add(clip.id);
  for (const clip of project.stickerClips ?? []) ids.add(clip.id);
  return items.every((item) => {
    switch (item.type) {
      case "clip":
      case "text-clip":
      case "shape-clip":
      case "transition":
        return ids.has(item.id);
      default:
        return true;
    }
  });
}

function pruneSelectionAfterRestore(): void {
  const ui = useUIStore.getState();
  if (selectedItemsExistInRestoredProject(ui.selectedItems)) return;
  ui.clearSelection();
  useUIStore.setState({
    effectApplicationClipId: null,
    effectApplicationLabel: null,
  });
}

interface TeardownOptions {
  /** Re-activate the editing workspace and re-apply its captured view state. */
  restoreView: boolean;
  /** Clear timeline selections whose clips no longer exist after a restore. */
  validateSelection?: boolean;
}

async function teardown(options: TeardownOptions): Promise<void> {
  const currentHandle = handle;
  handle = null;
  const view = savedViewState;
  savedViewState = null;
  editingWorkspaceIdAtEnter = null;
  readOnlyToastShown = false;
  if (managerUnsubscribe) {
    managerUnsubscribe();
    managerUnsubscribe = null;
  }
  if (!currentHandle) {
    publish({ active: false, busy: false, info: null });
    return;
  }
  pausePlayback();
  try {
    if (options.restoreView) {
      // The active workspace never changed during preview; re-activate it
      // defensively so the global store points at the editing runtime again.
      const target = workspaceManager.getActiveTarget();
      if (target) await workspaceManager.activateWorkspace(target);
      applyViewState(view);
      if (options.validateSelection) pruneSelectionAfterRestore();
    }
  } finally {
    try {
      await currentHandle.dispose();
    } catch {
      // Font release failures must not leave the session stuck active.
    }
    publish({ active: false, busy: false, info: null });
  }
}

/** True when a concurrent edit was detected (both results kept, nothing overwritten). */
function isConcurrentEditError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("conflict") || message.includes("changed while");
}

export const previewSession: PreviewSessionApi = {
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot() {
    return snapshot;
  },

  async enter(source) {
    // Guard busy reentrancy: rapid double-clicks must not interleave sessions.
    if (snapshot.busy) return;
    publish({ busy: true });
    try {
      // Entering a preview pauses current playback first; exiting restores
      // the original (paused) position without auto-playing.
      pausePlayback();
      // Capture the editing view state only when no preview is active yet:
      // repeated enters swap preview content and must not stack captures.
      if (!handle) {
        savedViewState = captureCurrentViewState();
        editingWorkspaceIdAtEnter =
          workspaceManager.getActiveTarget()?.workspaceId ?? null;
      }
      const newHandle = await workspaceManager.createPreviewHandle(source);
      const previousHandle = handle;
      handle = newHandle;
      readOnlyToastShown = false;
      if (previousHandle) {
        try {
          await previousHandle.dispose();
        } catch {
          // Keep swapping content even if releasing the old fonts fails.
        }
      }
      activateProjectStore(newHandle.store);
      // The preview starts at the node's beginning, paused (no autoplay).
      useTimelineStore.setState({
        playheadPosition: 0,
        playheadInteractionRevision:
          useTimelineStore.getState().playheadInteractionRevision + 1,
        playbackState: "paused",
      });
      startManagerWatch();
      publish({
        active: true,
        busy: false,
        info: {
          projectId: newHandle.projectId,
          nodeId: source.kind === "node" ? source.nodeId : null,
          workspaceId: source.kind === "workspace" ? source.workspaceId : null,
          nodeName: newHandle.label.name,
          summary: newHandle.label.summary,
          createdAt: newHandle.label.createdAt,
          missingDependencies: [...newHandle.missingDependencies],
          agentTrial: newHandle.label.agentTrial,
        },
      });
    } catch (error) {
      publish({ busy: false });
      throw error;
    }
  },

  async exit() {
    if (!snapshot.active && !handle) return;
    if (snapshot.busy) return;
    publish({ busy: true });
    try {
      await teardown({ restoreView: true });
    } finally {
      // teardown already published the inactive state (busy: false included).
    }
  },

  async copyToCurrent(clipIds) {
    if (!handle || !savedViewState || !editingWorkspaceIdAtEnter || clipIds.length === 0) return;
    const source = handle;
    const target = { projectId: source.projectId, workspaceId: editingWorkspaceIdAtEnter };
    const view = savedViewState;
    const expectedRevision = workspaceManager.getSnapshot().workspaces.find(workspace => workspace.id === target.workspaceId)!.revision;
    source.store.getState().copyClips(clipIds);
    const context = await workspaceManager.getWorkspaceContext(target);
    if (handle !== source) throw new Error(i18next.t("previewClipboard.targetChanged"));
    await previewSession.exit();
    const active = workspaceManager.getActiveTarget();
    if (active?.projectId !== target.projectId || active.workspaceId !== target.workspaceId) throw new Error(i18next.t("previewClipboard.targetChanged"));
    const track = context.store.getState().project.timeline.tracks[0];
    if (!track) throw new Error(i18next.t("previewClipboard.noTrack"));
    const results = await context.store.getState().pasteClips(track.id, view.playheadPosition, { expectedRevision });
    const failure = results.find(result => !result.success);
    if (failure) throw new Error(failure.error?.message ?? i18next.t("previewClipboard.failed"));
    const current = workspaceManager.getActiveTarget();
    if (current?.projectId !== target.projectId || current.workspaceId !== target.workspaceId) return;
    const state = context.store.getState();
    const selection = state.lastPastedClipIds
      .map(id => getTimelineSelectionItem(state, id))
      .filter((item): item is SelectionItem => item !== null);
    useUIStore.getState().selectMultiple(selection);
    toast.success(i18next.t("previewClipboard.inserted", { time: view.playheadPosition.toFixed(2) }));
  },

  async adopt() {
    if (!handle || !snapshot.active || !snapshot.info) {
      throw new Error("No version preview is active");
    }
    if (snapshot.busy) return;
    publish({ busy: true });
    const info = snapshot.info;
    const target: WorkspaceTarget | null = workspaceManager.getActiveTarget();
    try {
      if (!target) throw new Error("No active editing workspace to adopt into");
      const context = await workspaceManager.getWorkspaceContext(target);
      const expectedRevision = context.store.getState().workspaceRevision;

      let protectionDraftId: string | undefined;
      try {
        if (info.nodeId) {
          const result = await workspaceManager.restoreNode({
            target,
            nodeId: info.nodeId,
            expectedRevision,
          });
          protectionDraftId = result.protectionDraftId;
        } else if (info.workspaceId) {
          const result = await workspaceManager.restoreWorkspaceContent({
            target,
            sourceWorkspaceId: info.workspaceId,
            expectedRevision,
          });
          protectionDraftId = result.protectionDraftId;
        } else {
          throw new Error("The previewed content has no adoptable source");
        }
      } catch (error) {
        // Nothing was overwritten: the current edit was preserved (and
        // updated if a concurrent edit landed). Keep the preview open so the
        // user can retry the adoption from the latest state.
        if (isConcurrentEditError(error)) {
          toast.error(i18next.t("versioning.adoptConflict"));
        } else {
          toast.error(i18next.t("versioning.failed"));
        }
        return;
      }

      // Success: leave the preview, restoring the editing view state and
      // validating the selection against the restored content.
      await teardown({ restoreView: true, validateSelection: true });

      const notification: Omit<Notification, "id"> = {
        type: "success",
        title: i18next.t("versioning.adopted", { name: info.nodeName }),
      };
      if (protectionDraftId) {
        const draftId: string = protectionDraftId;
        notification.onClickLabel = i18next.t("versioning.adoptUndo");
        notification.onClick = () => {
          void workspaceManager
            .recoverDraft(target, draftId, undefined)
            .then(() => {
              toast.info(i18next.t("versioning.previewExitRestored"));
            })
            .catch(() => {
              toast.error(i18next.t("versioning.failed"));
            });
        };
      }
      useNotificationStore.getState().addNotification(notification);
    } finally {
      publish({ busy: false });
    }
  },

  async getNodeSummary(projectId, nodeId) {
    const node = await workspaceManager.getNode(projectId, nodeId);
    if (!node) return null;
    const { project: _project, ...summary } = node;
    return summary;
  },
};

export function isPreviewActive(): boolean {
  return snapshot.active;
}

/**
 * Timeline/Timeline-adjacent edit gate. Returns true when a read-only preview
 * is active and the interaction must not run; the first blocked attempt per
 * session shows one "preview is read-only" hint.
 */
export function blockPreviewEditInteraction(): boolean {
  if (!isPreviewActive()) return false;
  if (!readOnlyToastShown) {
    readOnlyToastShown = true;
    toast.info(i18next.t("versioning.previewReadOnly"));
  }
  return true;
}
