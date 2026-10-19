/**
 * Pure workspace record transforms and IndexedDB request/transaction promise
 * helpers, extracted from workspace-manager: project substantiveness checks,
 * snapshot cloning, stable edit keys, node summaries, media-id collection and
 * transaction/request wrappers. No store, i18n or media I/O dependencies.
 */
import type { Project } from "@reelterminal/core";
import {
  beginPerfOperation,
  endPerfOperation,
  failPerfOperation,
} from "@reelterminal/core";
import type { PerfOperation } from "@reelterminal/core";
import type { ProjectNodeRecord, ProjectNodeSummary } from "./workspace-manager";

/** A real edit exists: empty skeleton projects never become retention candidates. */
export function isSubstantiveProject(project: Project): boolean {
  return project.timeline.tracks.some((track) => track.clips.length > 0) ||
    project.timeline.subtitles.length > 0 ||
    [project.textClips, project.shapeClips, project.svgClips, project.stickerClips,
      project.motionCompositions, project.motionInstances, project.nestedInstances]
      .some((clips) => (clips?.length ?? 0) > 0) ||
    project.mediaLibrary.items.length > 0 ||
    (project.markers?.items.length ?? 0) > 0;
}

export function cloneProject(project: Project, parent?: PerfOperation): Project {
  const operation = beginPerfOperation("workspace.project-clone", parent);
  try {
    // Omit immutable, possibly huge embedded font strings from the structured
    // clone itself; replacing the cloned property afterwards would still copy
    // the full data URLs.
    const copy = structuredClone({ ...project, renderFonts: undefined });
    const result = {
      ...copy,
      // ProjectRenderFont entries are immutable snapshots and their data URLs
      // can be tens of megabytes. Keep the resource collection shared across
      // workspace clones instead of copying those strings with the project.
      ...(project.renderFonts !== undefined ? { renderFonts: project.renderFonts } : {}),
      mediaLibrary: {
        ...copy.mediaLibrary,
        items: copy.mediaLibrary.items.map((item) => ({ ...item, blob: null })),
      },
    };
    endPerfOperation(operation, "ok", operation ? {
      cloneCount: 1,
      mediaItems: result.mediaLibrary.items.length,
      renderFonts: result.renderFonts?.length ?? 0,
    } : undefined);
    return result;
  } catch (error) {
    failPerfOperation(operation, error);
    throw error;
  }
}

function stableStringifyValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringifyValue).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringifyValue(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableStringify(value: unknown, parent?: PerfOperation): string {
  const operation = beginPerfOperation("workspace.stable-serialize", parent);
  try {
    const serialized = stableStringifyValue(value);
    endPerfOperation(operation, "ok", operation ? {
      serializationCount: 1,
      serializedChars: serialized.length,
    } : undefined);
    return serialized;
  } catch (error) {
    failPerfOperation(operation, error);
    throw error;
  }
}

export function editableProjectKey(project: Project, parent?: PerfOperation): string {
  const operation = beginPerfOperation("workspace.editable-project-key", parent);
  const ignoredFields = new Set([
    "blob",
    "modifiedAt",
    "originalUrl",
    "previewCache",
    "previewUrl",
    "selected",
    "sourceFile",
    "thumbnailUrl",
    "renderFonts",
    "renderFontMissingFaces",
  ]);
  const normalize = (value: unknown, key?: string): unknown => {
    if (key && ignoredFields.has(key)) return undefined;
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [entryKey, child] of Object.entries(value)) {
        const normalized = normalize(child, entryKey);
        if (normalized !== undefined) result[entryKey] = normalized;
      }
      return result;
    }
    if (typeof value === "string" && value.startsWith("blob:") && key?.toLowerCase().endsWith("url")) {
      return undefined;
    }
    return value;
  };
  try {
    const key = stableStringify(normalize(cloneProject(project, operation)), operation);
    endPerfOperation(operation, "ok", operation ? { serializedChars: key.length } : undefined);
    return key;
  } catch (error) {
    failPerfOperation(operation, error);
    throw error;
  }
}

export function projectMediaIds(project: Project): string[] {
  const ids = new Set<string>(project.mediaLibrary.items.map((item) => item.id));
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "mediaId" && typeof child === "string") ids.add(child);
      else visit(child);
    }
  };
  visit(project);
  return [...ids].sort();
}

export function nodeSummary(node: ProjectNodeRecord): ProjectNodeSummary {
  return {
    id: node.id,
    projectId: node.projectId,
    parentNodeId: node.parentNodeId,
    name: node.name,
    summary: node.summary,
    createdAt: node.createdAt,
    formatVersion: node.formatVersion,
    mediaIds: [...node.mediaIds],
    missingDependencies: [...node.missingDependencies],
    ...(node.sourceWorkspaceKind ? { sourceWorkspaceKind: node.sourceWorkspaceKind } : {}),
    ...(node.recycledAt !== undefined ? { recycledAt: node.recycledAt } : {}),
  };
}

/** Stable equality for node summaries so unchanged re-reads skip publishing. */
export function nodeSummariesEqual(
  left: ProjectNodeSummary | undefined,
  right: ProjectNodeSummary,
): boolean {
  if (!left) return false;
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.parentNodeId === right.parentNodeId &&
    left.name === right.name &&
    left.summary === right.summary &&
    left.createdAt === right.createdAt &&
    left.formatVersion === right.formatVersion &&
    left.sourceWorkspaceKind === right.sourceWorkspaceKind &&
    left.recycledAt === right.recycledAt &&
    arraysEqual(left.mediaIds, right.mediaIds) &&
    arraysEqual(left.missingDependencies, right.missingDependencies)
  );
}

export function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function collectMediaIdsFromHistory(value: unknown, ids: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectMediaIdsFromHistory(item, ids));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key === "mediaId" || key === "sourceMediaId") && typeof child === "string") {
      ids.add(child);
      continue;
    }
    if (
      (key === "media" || key === "item" || key === "mediaItem") &&
      child && typeof child === "object" &&
      typeof (child as { id?: unknown }).id === "string"
    ) {
      ids.add((child as { id: string }).id);
    }
    collectMediaIdsFromHistory(child, ids);
  }
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}
