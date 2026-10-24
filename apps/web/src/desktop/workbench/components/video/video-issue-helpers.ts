import type {
  WorkbenchSpatialAnnotation,
  WorkbenchVideoMarker,
} from "@reelterminal/core";
import type { WorkbenchIssueEntry } from "../WorkbenchIssuePanel";
import type { MarkerAnchorView } from "./video-helpers";

export function buildVideoAnchors(
  markers: readonly WorkbenchVideoMarker[],
): MarkerAnchorView[] {
  const list: MarkerAnchorView[] = [];
  let counter = 1;
  for (const m of markers) {
    const frameLabel =
      m.startFrameIndex !== undefined ? ` · 帧 #${m.startFrameIndex}` : "";
    const markerLabel =
      m.type === "frame"
        ? `帧标记 @ ${m.startPtsSec.toFixed(3)}s${frameLabel}`
        : `区间 [${m.startPtsSec.toFixed(3)}s, ${(m.endPtsSec ?? m.startPtsSec).toFixed(3)}s)`;
    list.push({
      anchorId: m.id,
      markerId: m.id,
      kind: "marker",
      indexNumber: counter++,
      coordinateLabel: markerLabel,
    });
    for (const ann of m.annotations) {
      list.push({
        anchorId: ann.id,
        markerId: m.id,
        kind: "annotation",
        indexNumber: counter++,
        coordinateLabel: `${markerLabel} · 圈注 #${counter - 1}`,
      });
    }
  }
  return list;
}

export function buildVideoIssueEntries(
  anchors: readonly MarkerAnchorView[],
  markers: readonly WorkbenchVideoMarker[],
  currentVersion: number,
): readonly WorkbenchIssueEntry[] {
  const list: WorkbenchIssueEntry[] = [];
  for (const anchor of anchors) {
    const marker = markers.find((candidate) => candidate.id === anchor.markerId);
    if (!marker) continue;
    const staleVersion = marker.version !== currentVersion;
    if (anchor.kind === "marker") {
      list.push({
        id: anchor.anchorId,
        kind: "marker",
        indexNumber: anchor.indexNumber,
        coordinateLabel: anchor.coordinateLabel,
        note: marker.note,
        version: marker.version,
        staleVersion,
        annotationCount: marker.annotations.length,
        ptsLabel: `${marker.startPtsSec.toFixed(3)}s`,
      });
      continue;
    }
    const annotation = marker.annotations.find(
      (candidate) => candidate.id === anchor.anchorId,
    );
    if (!annotation) continue;
    list.push({
      id: anchor.anchorId,
      kind: "annotation",
      indexNumber: anchor.indexNumber,
      coordinateLabel: anchor.coordinateLabel,
      note: annotation.label ?? "",
      version: marker.version,
      staleVersion,
      color: annotation.color,
      tool: annotation.tool,
      ptsLabel: `${marker.startPtsSec.toFixed(3)}s`,
    });
  }
  return list;
}

export function buildVideoFeedbackTarget(
  anchor: MarkerAnchorView,
  sourceMarker?: WorkbenchVideoMarker,
  sourceAnnotation?: WorkbenchSpatialAnnotation,
  videoSize?: { w: number; h: number } | null,
): import("@reelterminal/core").WorkbenchFeedbackTarget | undefined {
  if (anchor.kind === "marker" && sourceMarker) {
    return {
      kind: "video-marker",
      markerId: sourceMarker.id,
      startPtsSec: sourceMarker.startPtsSec,
      ...(sourceMarker.endPtsSec !== undefined
        ? { endPtsSec: sourceMarker.endPtsSec }
        : {}),
      hasFrameMapping: sourceMarker.startFrameIndex !== undefined,
    };
  }
  if (sourceAnnotation) {
    return {
      kind: "pixel-region",
      annotationId: sourceAnnotation.id,
      x: sourceAnnotation.x,
      y: sourceAnnotation.y,
      ...(sourceAnnotation.w !== undefined ? { w: sourceAnnotation.w } : {}),
      ...(sourceAnnotation.h !== undefined ? { h: sourceAnnotation.h } : {}),
      ...(videoSize
        ? { naturalWidth: videoSize.w, naturalHeight: videoSize.h }
        : {}),
    };
  }
  return undefined;
}
