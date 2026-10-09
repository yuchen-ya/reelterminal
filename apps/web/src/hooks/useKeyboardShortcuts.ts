import { useEffect, useCallback, useState } from "react";
import {
  keyboardShortcuts,
  type ShortcutHandler,
} from "../services/keyboard-shortcuts";
import { useProjectStore } from "../stores/project-store";
import { toast } from "../stores/notification-store";
import { t } from "../i18n";
import { useUIStore } from "../stores/ui-store";
import { useTimelineStore } from "../stores/timeline-store";
import { getPlaybackBridge } from "../bridges/playback-bridge";
import { workspaceManager } from "../services/workspace-manager";
import { isPreviewActive, blockPreviewEditInteraction, previewSession } from "../services/preview-session";
import {
  deleteTimelineItem,
  duplicateTimelineItem,
  getTimelineItemKind,
  getTimelineItemRanges,
  getSplittableTimelineItemIds,
  getTimelineSelectionItem,
  getTimelineSelectionItems,
  splitTimelineItem,
  trimTimelineItemToPlayhead,
} from "../utils/timeline-item-actions";

export function useKeyboardShortcuts() {
  const [showShortcutsOverlay, setShowShortcutsOverlay] = useState(false);

  const {
    undo,
    redo,
    rippleDeleteClip,
    copyClips,
    project,
    addMarker,
  } = useProjectStore();

  const { getSelectedClipIds, clearSelection, toggleSnap, selectMultiple } =
    useUIStore();
  const {
    togglePlayback,
    playheadPosition,
    zoomIn,
    zoomOut,
    zoomToFit,
  } = useTimelineStore();

  const handlePlayPause = useCallback(() => {
    togglePlayback();
  }, [togglePlayback]);

  // Keyboard seeks go through the unified seek command (master clock + audio
  // + store together) — store-only seekTo leaves the playback clock free to
  // pull the playhead back on the next tick.
  const handleFrameBack = useCallback(() => {
    void getPlaybackBridge().requestSeekRelative(-1 / 30);
  }, []);

  const handleFrameForward = useCallback(() => {
    void getPlaybackBridge().requestSeekRelative(1 / 30);
  }, []);

  const handleSecondBack = useCallback(() => {
    void getPlaybackBridge().requestSeekRelative(-1);
  }, []);

  const handleSecondForward = useCallback(() => {
    void getPlaybackBridge().requestSeekRelative(1);
  }, []);

  const handleJump5Back = useCallback(() => {
    void getPlaybackBridge().requestSeekRelative(-5);
  }, []);

  const handleJump5Forward = useCallback(() => {
    void getPlaybackBridge().requestSeekRelative(5);
  }, []);

  const handleGoToStart = useCallback(() => {
    void getPlaybackBridge().requestSeek(0);
  }, []);

  const handleGoToEnd = useCallback(() => {
    const maxEnd = getTimelineItemRanges(project).reduce(
      (latest, item) => Math.max(latest, item.startTime + item.duration),
      0,
    );
    void getPlaybackBridge().requestSeek(maxEnd);
  }, [project]);

  const handlePrevClip = useCallback(() => {
    const currentTime = playheadPosition;
    let prevEdge = 0;

    for (const clip of getTimelineItemRanges(project)) {
      const endTime = clip.startTime + clip.duration;
      if (clip.startTime < currentTime - 0.001 && clip.startTime > prevEdge) {
        prevEdge = clip.startTime;
      }
      if (endTime < currentTime - 0.001 && endTime > prevEdge) {
        prevEdge = endTime;
      }
    }

    void getPlaybackBridge().requestSeek(prevEdge);
  }, [project, playheadPosition]);

  const handleNextClip = useCallback(() => {
    const currentTime = playheadPosition;
    let nextEdge = Infinity;

    for (const clip of getTimelineItemRanges(project)) {
      const endTime = clip.startTime + clip.duration;
      if (clip.startTime > currentTime + 0.001 && clip.startTime < nextEdge) {
        nextEdge = clip.startTime;
      }
      if (endTime > currentTime + 0.001 && endTime < nextEdge) {
        nextEdge = endTime;
      }
    }

    if (nextEdge !== Infinity) {
      void getPlaybackBridge().requestSeek(nextEdge);
    }
  }, [project, playheadPosition]);

  // Editing shortcuts below are gated on the read-only version preview
  // (docs/VERSION-NODES-UX.md 预览不会打断编辑): the timeline gates its own
  // pointer/toolbar interactions, but these global handlers would otherwise
  // mutate the previewed historical store. The first blocked attempt per
  // session shows the "read-only" hint.
  const handleUndo = useCallback(() => {
    if (blockPreviewEditInteraction()) return;
    undo();
  }, [undo]);

  const handleRedo = useCallback(() => {
    if (blockPreviewEditInteraction()) return;
    redo();
  }, [redo]);

  const handleCopy = useCallback(() => {
    const selectedIds = getSelectedClipIds();
    if (selectedIds.length > 0) {
      useProjectStore.getState().copyClips(selectedIds);
    }
  }, [getSelectedClipIds, copyClips]);

  const handleCut = useCallback(() => {
    if (blockPreviewEditInteraction()) return;
    const selectedIds = getSelectedClipIds();
    if (selectedIds.length > 0) {
      copyClips(selectedIds);
      const store = useProjectStore.getState();
      void Promise.all(
        selectedIds.map((id) => deleteTimelineItem(store, id)),
      ).then(() => clearSelection());
    }
  }, [getSelectedClipIds, copyClips, clearSelection]);

  const handlePaste = useCallback(() => {
    if (blockPreviewEditInteraction()) return;
    const target = useProjectStore.getState();
    const currentTime = useTimelineStore.getState().playheadPosition;
    const firstTrack = target.project.timeline.tracks[0];
    if (firstTrack) {
      void target.pasteClips(firstTrack.id, currentTime, { expectedRevision: target.projectRevision }).then((results) => {
        const failure = results.find(result => !result.success);
        if (failure) {
          toast.error(t("previewClipboard.failed"), failure.error?.message);
          return;
        }
        const store = useProjectStore.getState();
        if (store.project.id !== target.project.id || store.workspaceId !== target.workspaceId) return;
        const pastedSelection = store.lastPastedClipIds
          .map((id) => getTimelineSelectionItem(store, id))
          .filter((item): item is NonNullable<typeof item> => item !== null);
        if (pastedSelection.length > 0) selectMultiple(pastedSelection);
      });
    }
  }, [selectMultiple]);

  const handleDuplicate = useCallback(() => {
    if (blockPreviewEditInteraction()) return;
    const selectedIds = getSelectedClipIds();
    const store = useProjectStore.getState();
    selectedIds.forEach((id) => void duplicateTimelineItem(store, id));
  }, [getSelectedClipIds]);

  const handleDelete = useCallback(() => {
    if (blockPreviewEditInteraction()) return;
    const transitionItems = useUIStore
      .getState()
      .selectedItems.filter((item) => item.type === "transition");
    if (transitionItems.length > 0) {
      const { removeClipTransition } = useProjectStore.getState();
      transitionItems.forEach((item) => {
        void removeClipTransition(item.id);
      });
    }
    const selectedIds = getSelectedClipIds();
    const store = useProjectStore.getState();
    selectedIds.forEach((id) => void deleteTimelineItem(store, id));
    clearSelection();
  }, [getSelectedClipIds, clearSelection]);

  const handleRippleDelete = useCallback(() => {
    if (blockPreviewEditInteraction()) return;
    const selectedIds = getSelectedClipIds();
    const store = useProjectStore.getState();
    selectedIds
      .filter((id) => getTimelineItemKind(store, id) === "media")
      .forEach((id) => rippleDeleteClip(id));
    clearSelection();
  }, [getSelectedClipIds, rippleDeleteClip, clearSelection]);

  const handleSplit = useCallback(() => {
    if (blockPreviewEditInteraction()) return;
    const selectedIds = getSelectedClipIds();
    const splittableIds = getSplittableTimelineItemIds(
      project,
      selectedIds,
      playheadPosition,
    );
    const store = useProjectStore.getState();
    void Promise.all(
      splittableIds.map((id) => splitTimelineItem(store, id, playheadPosition)),
    );
  }, [getSelectedClipIds, playheadPosition, project]);

  const handleTrimStart = useCallback(() => {
    if (blockPreviewEditInteraction()) return;
    const selectedIds = getSelectedClipIds();
    const trimmableIds = getSplittableTimelineItemIds(
      project,
      selectedIds,
      playheadPosition,
    );
    const store = useProjectStore.getState();
    void Promise.all(
      trimmableIds.map((id) =>
        trimTimelineItemToPlayhead(store, id, playheadPosition, true),
      ),
    );
  }, [getSelectedClipIds, playheadPosition, project]);

  const handleTrimEnd = useCallback(() => {
    if (blockPreviewEditInteraction()) return;
    const selectedIds = getSelectedClipIds();
    const trimmableIds = getSplittableTimelineItemIds(
      project,
      selectedIds,
      playheadPosition,
    );
    const store = useProjectStore.getState();
    void Promise.all(
      trimmableIds.map((id) =>
        trimTimelineItemToPlayhead(store, id, playheadPosition, false),
      ),
    );
  }, [getSelectedClipIds, playheadPosition, project]);

  const handleSelectAll = useCallback(() => {
    selectMultiple(getTimelineSelectionItems(project));
  }, [selectMultiple, project]);

  const handleDeselect = useCallback(() => {
    clearSelection();
  }, [clearSelection]);

  const handleToggleSnap = useCallback(() => {
    toggleSnap();
  }, [toggleSnap]);

  const handleZoomIn = useCallback(() => {
    zoomIn();
  }, [zoomIn]);

  const handleZoomOut = useCallback(() => {
    zoomOut();
  }, [zoomOut]);

  const handleFitTimeline = useCallback(() => {
    const maxEnd = getTimelineItemRanges(project).reduce(
      (latest, item) => Math.max(latest, item.startTime + item.duration),
      0,
    );
    zoomToFit(maxEnd || 60);
  }, [zoomToFit, project]);

  const handleShowShortcuts = useCallback(() => {
    setShowShortcutsOverlay(true);
  }, []);

  // Esc while a read-only version preview is active returns to current
  // editing (docs/VERSION-NODES-UX.md 节点操作约定: Esc 先关闭菜单，正在
  // 预览时返回当前编辑). Menus close themselves first via their own capture
  // listeners, so this window-level listener only sees unmatched Esc presses.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;
      if (!previewSession.getSnapshot().active) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      void previewSession.exit();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Ctrl+S only completes pending workspace writes (same persistence as
  // auto-save). It never creates version nodes; versions are retained from
  // the project menu or on close (docs/VERSION-NODES-UX.md 保存保持顺手).
  // While a read-only preview is active, saving would risk committing preview
  // content into the editing workspace, so it only acknowledges — the
  // previewed version is already immutable.
  const handleSave = useCallback(() => {
    if (isPreviewActive()) {
      toast.info(t("versioning.previewSavedToast"));
      return;
    }
    void (async () => {
      await workspaceManager.initialize();
      const state = useProjectStore.getState();
      const target = state.workspaceId
        ? { projectId: state.project.id, workspaceId: state.workspaceId }
        : workspaceManager.getActiveTarget();
      if (!target || target.projectId !== state.project.id) throw new Error("The save target is no longer open");
      await workspaceManager.flushWorkspace(target);
    })()
      .then(() => {
        toast.success(t("settings.autoSaveSaved"));
      })
      .catch((error: unknown) => {
        toast.error(
          t("settings.autoSaveFailed"),
          error instanceof Error ? error.message : undefined,
        );
      });
  }, []);

  const handleExport = useCallback(() => {}, []);

  const handleAddText = useCallback(() => {}, []);

  const handleAddMarker = useCallback(() => {
    const currentTime = playheadPosition;
    const markerCount = project.timeline.markers.length;
    addMarker(currentTime, `Marker ${markerCount + 1}`, "#3b82f6");
  }, [playheadPosition, project.timeline.markers.length, addMarker]);

  useEffect(() => {
    const handlers: Array<[string, ShortcutHandler]> = [
      ["playback.playPause", handlePlayPause],
      ["playback.frameBack", handleFrameBack],
      ["playback.frameForward", handleFrameForward],
      ["playback.secondBack", handleSecondBack],
      ["playback.secondForward", handleSecondForward],
      ["playback.jump5Back", handleJump5Back],
      ["playback.jump5Forward", handleJump5Forward],
      ["playback.goToStart", handleGoToStart],
      ["playback.goToEnd", handleGoToEnd],
      ["playback.prevClip", handlePrevClip],
      ["playback.nextClip", handleNextClip],
      ["editing.undo", handleUndo],
      ["editing.redo", handleRedo],
      ["editing.cut", handleCut],
      ["editing.copy", handleCopy],
      ["editing.paste", handlePaste],
      ["editing.duplicate", handleDuplicate],
      ["editing.delete", handleDelete],
      ["editing.rippleDelete", handleRippleDelete],
      ["editing.split", handleSplit],
      ["editing.trimStart", handleTrimStart],
      ["editing.trimEnd", handleTrimEnd],
      ["selection.selectAll", handleSelectAll],
      ["selection.deselect", handleDeselect],
      ["timeline.toggleSnap", handleToggleSnap],
      ["timeline.zoomIn", handleZoomIn],
      ["timeline.zoomOut", handleZoomOut],
      ["timeline.fitTimeline", handleFitTimeline],
      ["view.showShortcuts", handleShowShortcuts],
      ["file.save", handleSave],
      ["file.export", handleExport],
      ["tools.addText", handleAddText],
      ["tools.addMarker", handleAddMarker],
    ];

    const unsubscribes = handlers.map(([action, handler]) =>
      keyboardShortcuts.registerHandler(action, handler),
    );

    keyboardShortcuts.startListening();

    return () => {
      unsubscribes.forEach((unsub) => unsub());
      keyboardShortcuts.stopListening();
    };
  }, [
    handlePlayPause,
    handleFrameBack,
    handleFrameForward,
    handleSecondBack,
    handleSecondForward,
    handleJump5Back,
    handleJump5Forward,
    handleGoToStart,
    handleGoToEnd,
    handlePrevClip,
    handleNextClip,
    handleUndo,
    handleRedo,
    handleCut,
    handleCopy,
    handlePaste,
    handleDuplicate,
    handleDelete,
    handleRippleDelete,
    handleSplit,
    handleTrimStart,
    handleTrimEnd,
    handleSelectAll,
    handleDeselect,
    handleToggleSnap,
    handleZoomIn,
    handleZoomOut,
    handleFitTimeline,
    handleShowShortcuts,
    handleSave,
    handleExport,
    handleAddText,
    handleAddMarker,
  ]);

  return {
    showShortcutsOverlay,
    setShowShortcutsOverlay,
  };
}
