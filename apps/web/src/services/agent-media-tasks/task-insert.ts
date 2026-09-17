/**
 * Timeline insertion for a done agent media task ("插入时间线").
 *
 * The insert is user-triggered from the task panel and goes through the
 * exact store path a manual import uses (`addClipToNewTrack` → `clip/add`
 * action), so undo, history and preview behave like any other clip. It only
 * ever runs while the currently open project is the task's recorded target —
 * a result must never land in a different project's timeline — and the
 * recorded `insertedClipId` makes the action single-shot.
 */

import type { AgentMediaTaskService } from "./agent-media-task-service";
import type { AgentMediaTaskRecord } from "./types";

export interface AgentTaskInsertDeps {
  readonly service: AgentMediaTaskService;
  /** id of the currently open project, or null when none is open. */
  readonly getCurrentProjectId: () => string | null;
  /** Project media lookup (the store's getMediaItem). */
  readonly getMediaItem: (
    mediaId: string,
  ) => { readonly id: string; readonly type?: string } | undefined;
  /** The store's addClipToNewTrack (clip/add on a fresh track). */
  readonly addClipToNewTrack: (
    mediaId: string,
    startTime?: number,
  ) => Promise<{
    readonly success: boolean;
    readonly error?: { readonly code?: string; readonly message?: string };
  }>;
  /** All clip ids currently on the timeline (insert-diff baseline). */
  readonly collectClipIds: () => readonly string[];
}

export type AgentTaskInsertOutcome =
  | {
      readonly ok: true;
      readonly taskId: string;
      readonly clipId?: string;
      /** True when the task already recorded an insert (no-op here). */
      readonly skipped?: boolean;
      readonly record: AgentMediaTaskRecord;
    }
  | {
      readonly ok: false;
      readonly taskId: string;
      readonly code: string;
      readonly message: string;
    };

function insertFailure(
  taskId: string,
  code: string,
  message: string,
): AgentTaskInsertOutcome {
  return { ok: false, taskId, code, message };
}

/**
 * Insert the done task's media at the end of a fresh matching track (the
 * store default, i.e. the timeline end). Idempotent: an already-inserted
 * task returns the recorded clip instead of adding another one.
 */
export async function insertDoneTaskTimeline(
  taskId: string,
  deps: AgentTaskInsertDeps,
): Promise<AgentTaskInsertOutcome> {
  const { service, getCurrentProjectId, getMediaItem, addClipToNewTrack, collectClipIds } =
    deps;

  const loaded = await service.get(taskId);
  if (!loaded.ok) return insertFailure(taskId, loaded.code, loaded.message);
  const record = loaded.value;
  if (record.insertedClipId) {
    return {
      ok: true,
      taskId,
      clipId: record.insertedClipId,
      skipped: true,
      record,
    };
  }
  if (record.status !== "done" || !record.resultMediaId) {
    return insertFailure(
      taskId,
      "INVALID_STATUS",
      "只有已完成导入的任务才能插入时间线",
    );
  }
  const currentProjectId = getCurrentProjectId();
  if (!currentProjectId || currentProjectId !== record.targetProjectId) {
    return insertFailure(
      taskId,
      "PROJECT_MISMATCH",
      "当前打开的项目不是该任务的目标项目；插入已取消",
    );
  }
  if (!getMediaItem(record.resultMediaId)) {
    return insertFailure(
      taskId,
      "MEDIA_NOT_FOUND",
      "产物媒体不在当前项目中（可能已被删除）",
    );
  }

  const before = new Set(collectClipIds());
  const result = await addClipToNewTrack(record.resultMediaId);
  if (!result.success) {
    return insertFailure(
      taskId,
      result.error?.code ?? "INSERT_FAILED",
      result.error?.message ?? "插入时间线失败",
    );
  }
  const createdClipId = collectClipIds().find((clipId) => !before.has(clipId));
  if (!createdClipId) {
    // The clip landed but its id could not be pinned; without it the
    // single-shot guard cannot be recorded, so surface it instead of
    // allowing a silent second insert.
    return insertFailure(
      taskId,
      "CLIP_ID_UNRESOLVED",
      "插入已完成，但未能记录片段标识；请手动检查时间线，勿重复点击插入",
    );
  }
  const recorded = await service.setInsertedClip(taskId, createdClipId);
  if (!recorded.ok) return insertFailure(taskId, recorded.code, recorded.message);
  return { ok: true, taskId, clipId: createdClipId, record: recorded.value };
}
