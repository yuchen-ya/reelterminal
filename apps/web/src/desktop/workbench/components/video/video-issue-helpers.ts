import { t as translate } from "../../../../i18n";
import type {
  WorkbenchSpatialAnnotation,
  WorkbenchVideoMarker,
} from "@reelterminal/core";
import type { WorkbenchIssueEntry } from "../WorkbenchIssuePanel";
import { formatTimecode, type MarkerAnchorView } from "./video-helpers";

export function isAnnotationContainer(marker: WorkbenchVideoMarker): boolean {
  return marker.type === "frame" && marker.annotationContainer === true && !marker.note.trim();
}

export function removeVideoIssue(markers: readonly WorkbenchVideoMarker[], anchor: MarkerAnchorView): WorkbenchVideoMarker[] {
  return markers.flatMap(marker => {
    if (marker.id !== anchor.markerId) return [marker];
    if (anchor.kind === "marker") return [];
    const annotations = marker.annotations.filter(annotation => annotation.id !== anchor.anchorId);
    return annotations.length === 0 && isAnnotationContainer(marker) ? [] : [{ ...marker, annotations }];
  });
}

/** i18n-data: persisted legacy sentinel; compare exact historical bytes in every UI language. */
function legacyMarkerNote(seconds: number): string {
  return `源帧 ${formatTimecode(seconds)} 待诊断问题`;
}

export function buildVideoAnchors(
  markers: readonly WorkbenchVideoMarker[],
): MarkerAnchorView[] {
  const list: MarkerAnchorView[] = [];
  let counter = 1;
  for (const m of markers) {
    const frameLabel =
      m.startFrameIndex !== undefined ? translate(" · Frame #{{v0}}", { v0: m.startFrameIndex }) : "";
    const markerLabel =
      m.type === "frame"
        ? translate("Frame marker @ {{v0}}s{{v1}}", { v0: m.startPtsSec.toFixed(3), v1: frameLabel })
        : translate("Range [{{v0}}s, {{v1}}s)", { v0: m.startPtsSec.toFixed(3), v1: (m.endPtsSec ?? m.startPtsSec).toFixed(3) });
    // Older automatic containers share their note with old manual markers.
    // Hide the redundant row while it has children, but never delete it by guessing.
    const legacyContainer = m.annotationContainer === undefined && m.type === "frame"
      && m.annotations.length > 0 && m.note === legacyMarkerNote(m.startPtsSec);
    if (!isAnnotationContainer(m) && !legacyContainer) list.push({
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
        coordinateLabel: translate("{{v0}} · Annotation #{{v1}}", { v0: markerLabel, v1: counter - 1 }),
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
