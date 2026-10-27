import { workbenchContentResourceId } from "@reelterminal/core/types/workbench";
import { diffLines } from "diff";
import type { ReviewContext, ReviewStepReference } from "@reelterminal/core/review/types";
import type { WorkbenchDataContent } from "@reelterminal/core/types/workbench";
import type { ReviewIdMapping } from "@reelterminal/core/review/archive";
import { reviewError, reviewService } from "./service";
import { decodeReviewText } from "./table-import";
import { exportValue } from "./export";
import { v5 as uuidv5 } from "uuid";

export type ReviewComparable =
  | { kind: "text"; text: string }
  | { kind: "data"; data: WorkbenchDataContent }
  | { kind: "image"; url: string; width: number; height: number; durationSec: number }
  | { kind: "video"; url: string; width: number; height: number; durationSec: number }
  | { kind: "model3d"; resourceId: string }
  | { kind: "file"; name: string; mime: string; size: number };

export async function readReviewComparable(target: ReviewContext["target"], reference: ReviewStepReference): Promise<ReviewComparable> {
  let resourceId: string;
  if ("resourceId" in reference) resourceId = reference.resourceId;
  else {
    if (reference.nodeId !== target.nodeId) throw reviewError("INVALID_PARAMS", "Comparison reference belongs to another node");
    const version = await reviewService.getVersion(target, reference.itemId, reference.version);
    if (version.content.type === "text") {
      const entry = version.content.versions.find(entry => entry.version === reference.version);
      if (!entry) throw reviewError("NOT_FOUND", "Comparison text version is missing");
      return { kind: "text", text: entry.text };
    }
    if (version.content.type === "data") return { kind: "data", data: version.content };
    resourceId = version.revision?.mediaId ?? workbenchContentResourceId(version.content)!;
  }
  const resource = (await reviewService.getResources([resourceId]))[0];
  if (resource.storage.kind === "unavailable") throw reviewError("NOT_FOUND", resource.storage.reason);
  const native = exportValue(await window.reelterminal!.reviewFiles!.resolve(resourceId));
  if (resource.mime === "model/gltf-binary") return { kind: "model3d", resourceId };
  if (resource.metadata?.type === "image" || resource.metadata?.type === "video") return {
    kind: resource.metadata.type, url: `app://reelterminal/review-media/${resourceId}`,
    width: resource.metadata.width, height: resource.metadata.height, durationSec: resource.metadata.durationSec,
  };
  if ((resource.mime.startsWith("text/") || resource.mime === "application/json") && resource.size <= 2 * 1024 * 1024) {
    return { kind: "text", text: decodeReviewText(await window.reelterminal!.fs.readFileBytes(native.path, 2 * 1024 * 1024)) };
  }
  return { kind: "file", name: resource.originalFileName, mime: resource.mime, size: resource.size };
}

export function compareReviewText(before: string, after: string) {
  // jsdiff's bound prevents a large, unrelated pair from blocking the UI indefinitely.
  return diffLines(before, after, { timeout: 100, maxEditLength: 2000 });
}

export interface ReviewCellDifference {
  rowId: string; columnId: string; columnTitle: string;
  kind: "added" | "removed" | "changed";
  before: string | null | undefined; after: string | null | undefined;
}
/** Branch tables use private identities; compare their known rows/columns against the source. */
export function sourceComparisonData(data: WorkbenchDataContent, idMap: readonly ReviewIdMapping[], taskId?: string): WorkbenchDataContent {
  const sourceId = (kind: string, id: string) => idMap.find(entry => entry.kind === kind && entry.newId === id)?.oldId
    ?? (taskId ? uuidv5(`adopt:${kind}:${id}`, taskId) : id);
  return { ...data, columns: data.columns.map(column => ({ ...column, columnId: sourceId("column", column.columnId) })),
    rows: data.rows.map(row => ({ rowId: sourceId("row", row.rowId), cells: Object.fromEntries(Object.entries(row.cells).map(([id, value]) => [sourceId("column", id), value])) })) };
}
/** Stable IDs, never displayed row positions or duplicate column titles, join the two tables. */
export function compareReviewData(before: WorkbenchDataContent, after: WorkbenchDataContent): ReviewCellDifference[] {
  const oldRows = new Map(before.rows.map(row => [row.rowId, row]));
  const newRows = new Map(after.rows.map(row => [row.rowId, row]));
  const oldColumns = new Map(before.columns.map(column => [column.columnId, column]));
  const newColumns = new Map(after.columns.map(column => [column.columnId, column]));
  const differences: ReviewCellDifference[] = [];
  for (const rowId of new Set([...oldRows.keys(), ...newRows.keys()])) for (const columnId of new Set([...oldColumns.keys(), ...newColumns.keys()])) {
    const previous = oldRows.has(rowId) && oldColumns.has(columnId) ? oldRows.get(rowId)!.cells[columnId] : undefined;
    const next = newRows.has(rowId) && newColumns.has(columnId) ? newRows.get(rowId)!.cells[columnId] : undefined;
    if (previous !== next) differences.push({ rowId, columnId, columnTitle: newColumns.get(columnId)?.title ?? oldColumns.get(columnId)!.title,
      kind: previous === undefined ? "added" : next === undefined ? "removed" : "changed", before: previous, after: next });
  }
  return differences;
}
