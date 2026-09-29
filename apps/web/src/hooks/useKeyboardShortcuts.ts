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
    pasteClips,
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

  const handleUndo = useCallback(() => {
    undo();
  }, [undo]);

  const handleRedo = useCallback(() => {
    redo();
  }, [redo]);

  const handleCopy = useCallback(() => {
    const selectedIds = getSelectedClipIds();
    if (selectedIds.length > 0) {
      copyClips(selectedIds);
    }
  }, [getSelectedClipIds, copyClips]);

  const handleCut = useCallback(() => {
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
    const currentTime = playheadPosition;
    const firstTrack = project.timeline.tracks[0];
    if (firstTrack) {
      void pasteClips(firstTrack.id, currentTime).then(() => {
        const store = useProjectStore.getState();
        const pastedSelection = store.lastPastedClipIds
          .map((id) => getTimelineSelectionItem(store, id))
          .filter((item): item is NonNullable<typeof item> => item !== null);
        if (pastedSelection.length > 0) selectMultiple(pastedSelection);
      });
    }
  }, [pasteClips, playheadPosition, project.timeline.tracks, selectMultiple]);

  const handleDuplicate = useCallback(() => {
    const selectedIds = getSelectedClipIds();
    const store = useProjectStore.getState();
    selectedIds.forEach((id) => void duplicateTimelineItem(store, id));
  }, [getSelectedClipIds]);

  const handleDelete = useCallback(() => {
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
    const selectedIds = getSelectedClipIds();
    const store = useProjectStore.getState();
    selectedIds
      .filter((id) => getTimelineItemKind(store, id) === "media")
      .forEach((id) => rippleDeleteClip(id));
    clearSelection();
  }, [getSelectedClipIds, rippleDeleteClip, clearSelection]);

  const handleSplit = useCallback(() => {
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

  // The shortcut panel promises "Save project", so the handler must
  // actually persist. This is the same durable store path the desktop
  // lifecycle flush and the agent requestSave verb use (auto-save manager
  // force flush, incl. recovery from a failed first-time init).
  const handleSave = useCallback(() => {
    void useProjectStore
      .getState()
      .forceSave()
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
