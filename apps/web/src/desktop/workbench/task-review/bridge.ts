import type { TaskReviewBridge, TaskReviewContextBridge } from "../../../../../desktop/src/shared/task-review-bridge";
import type { TaskAgentBridge } from "../../../../../desktop/src/shared/task-review-runtime-types";
import type { TaskReviewExportBridge } from "../../../../../desktop/src/shared/task-review-export";
import type { TaskReviewMediaBridge } from "../../../../../desktop/src/shared/task-review-media";

export function taskMediaBridge(): TaskReviewMediaBridge | null {
  return window.reelterminal?.taskReviewMedia ?? null;
}

export function taskExportBridge(): TaskReviewExportBridge | null {
  return window.reelterminal?.taskReviewExport ?? null;
}

/**
 * UI seam to the desktop task-review services. The shared contracts and the
 * window typing in global.d.ts remain the single authority; this module only
 * narrows nullability so scenes can require a connected bridge.
 */
export function taskReviewBridge(): TaskReviewBridge | null {
  return window.reelterminal?.taskReview ?? null;
}

/**
 * Task understanding and explicit criteria adoption. Optional because older
 * shells preload without this channel; absence is reported, never faked.
 */
export function taskContextBridge(): TaskReviewContextBridge | null {
  return window.reelterminal?.taskReviewContext ?? null;
}

export function taskAgentBridge(): TaskAgentBridge | null {
  return window.reelterminal?.taskAgent ?? null;
}

export function folderReviewBridge(): import("../../../../../desktop/src/shared/folder-review-bridge").FolderReviewBridge | null {
  return window.reelterminal?.folderReview ?? null;
}

export const errorMessage = (problem: unknown): string =>
  problem instanceof Error ? problem.message : String(problem);

/** Desktop main rejects concurrent writers with this prefix. */
export const isRevisionConflict = (problem: unknown): boolean =>
  errorMessage(problem).includes("Revision conflict");
