/**
 * Artifact receiving and import for agent media tasks — the renderer
 * orchestrator between the task ledger, the desktop import channel, and the
 * open project.
 *
 * Invariants carried through every path:
 *  - The artifact is imported by the product (facade `media.import` in the
 *    main process), never by the external agent and never from raw renderer
 *    file reads.
 *  - An `awaiting_import` task only imports while the currently open project
 *    is the task's recorded target; anything else keeps the task waiting.
 *    A target project that no longer exists anywhere fails the task for real.
 *  - Every trigger is idempotent: an already-imported task, a duplicate
 *    receipt, and a double-invoked import all collapse to one media item
 *    (requestId-keyed facade ledger plus resultMediaId/terminal-state guards).
 *  - Failures are honest: import problems land on the record as real,
 *    retryable errors instead of fake progress.
 */

import type { AgentMediaTaskService } from "./agent-media-task-service";
import { isTerminalTaskStatus } from "./task-machine";
import type { AgentMediaTaskRecord } from "./types";
import { pickArtifactFromScan } from "./receipts";
import { checkProjectExists } from "./project-existence";
import type { ProjectExistence } from "./project-existence";
import {
  artifactFileExists,
  importTaskArtifact,
  scanTaskOutputDirectory,
} from "./desktop-channel";

export interface AgentTaskRuntimeDeps {
  readonly service: AgentMediaTaskService;
  /** id of the currently open project, or null when none is open. */
  readonly getCurrentProjectId: () => string | null;
  readonly importArtifact?: typeof importTaskArtifact;
  readonly scanOutput?: typeof scanTaskOutputDirectory;
  readonly artifactExists?: typeof artifactFileExists;
  readonly checkProject?: (projectId: string) => Promise<ProjectExistence>;
}

export type AgentTaskActionOutcome =
  | {
      readonly ok: true;
      readonly taskId: string;
      readonly mediaId?: string;
      /** True when a previous run already produced the result (no-op here). */
      readonly skipped?: boolean;
      readonly record: AgentMediaTaskRecord;
    }
  | {
      readonly ok: false;
      readonly taskId: string;
      readonly code: string;
      readonly message: string;
      readonly record?: AgentMediaTaskRecord;
    };

/** One import attempt per task at a time; duplicate triggers collapse. */
const importsInFlight = new Set<string>();

function failure(
  taskId: string,
  code: string,
  message: string,
  record?: AgentMediaTaskRecord,
): AgentTaskActionOutcome {
  return { ok: false, taskId, code, message, ...(record ? { record } : {}) };
}

interface ResolvedRuntimeDeps {
  readonly service: AgentMediaTaskService;
  readonly getCurrentProjectId: () => string | null;
  readonly importArtifact: typeof importTaskArtifact;
  readonly scanOutput: typeof scanTaskOutputDirectory;
  readonly artifactExists: typeof artifactFileExists;
  readonly checkProject: (projectId: string) => Promise<ProjectExistence>;
}

function resolveDeps(deps: AgentTaskRuntimeDeps): ResolvedRuntimeDeps {
  return {
    service: deps.service,
    getCurrentProjectId: deps.getCurrentProjectId,
    importArtifact: deps.importArtifact ?? importTaskArtifact,
    scanOutput: deps.scanOutput ?? scanTaskOutputDirectory,
    artifactExists: deps.artifactExists ?? artifactFileExists,
    checkProject:
      deps.checkProject ??
      ((projectId: string) => checkProjectExists(projectId)),
  };
}

/**
 * Import one `awaiting_import` task's artifact into its target project.
 * Guards run before any state change; the task stays `awaiting_import` when
 * only the project switch is missing.
 */
export async function importAwaitingTask(
  taskId: string,
  deps: AgentTaskRuntimeDeps,
): Promise<AgentTaskActionOutcome> {
  const { service, getCurrentProjectId, importArtifact, artifactExists, checkProject } =
    resolveDeps(deps);

  const loaded = await service.get(taskId);
  if (!loaded.ok) return failure(taskId, loaded.code, loaded.message);
  const record = loaded.value;
  if (record.resultMediaId) {
    // Duplicate trigger after a completed import: nothing left to do.
    return { ok: true, taskId, record, skipped: true, mediaId: record.resultMediaId };
  }
  if (record.status !== "awaiting_import") {
    return failure(taskId, "INVALID_STATUS", `task is ${record.status}`, record);
  }
  const currentProjectId = getCurrentProjectId();
  if (!currentProjectId || currentProjectId !== record.targetProjectId) {
    return failure(
      taskId,
      "PROJECT_MISMATCH",
      "当前打开的项目不是该任务的目标项目；请切换回目标项目后再导入",
      record,
    );
  }
  // Real existence oracle (the projects store, never the recent list): a
  // deleted target project fails the task for good, cleared of references.
  const existence = await checkProject(record.targetProjectId);
  if (existence.status === "missing") {
    const verified = await service.verifyTargetProjectBeforeImport(record.id, []);
    if (!verified.ok) {
      return failure(taskId, verified.code, verified.message);
    }
    const updated = await service.get(taskId);
    return failure(
      taskId,
      "TARGET_PROJECT_MISSING",
      "目标项目已不存在，任务已标记失败；产物不会转投其他项目",
      updated.ok ? updated.value : undefined,
    );
  }
  if (!record.resultPath) {
    return failure(taskId, "NO_ARTIFACT_FILE", "任务没有已确认的产物路径", record);
  }
  const filePresent = await artifactExists(record.resultPath);
  if (filePresent === false) {
    const marked = await service.markError(taskId, {
      code: "ARTIFACT_MISSING",
      message: "产物文件已不存在，无法导入；可重试重新生成",
    });
    return marked.ok
      ? failure(taskId, "ARTIFACT_MISSING", "产物文件已不存在，无法导入；可重试重新生成", marked.value)
      : failure(taskId, marked.code, marked.message);
  }
  if (importsInFlight.has(taskId)) {
    return failure(taskId, "IMPORT_IN_PROGRESS", "该任务的导入正在进行中", record);
  }
  importsInFlight.add(taskId);
  try {
    const reply = await importArtifact({
      path: record.resultPath,
      idempotencyKey: record.requestId,
    });
    if (reply.ok) {
      const done = await service.markDone(taskId, {
        resultMediaId: reply.mediaId,
      });
      if (!done.ok) return failure(taskId, done.code, done.message);
      return {
        ok: true,
        taskId,
        record: done.value,
        mediaId: reply.mediaId,
        skipped: reply.replayed,
      };
    }
    const marked = await service.markError(taskId, {
      code: reply.code,
      message: reply.message,
    });
    return marked.ok
      ? failure(taskId, reply.code, reply.message, marked.value)
      : failure(taskId, marked.code, marked.message);
  } finally {
    importsInFlight.delete(taskId);
  }
}

/**
 * Manual result confirmation for manual-only tasks (the receipt channel is
 * unavailable, so a human confirms): resolve the artifact from the precast
 * output directory, park the task as awaiting_import, then run the guarded
 * import. No state changes when nothing importable is found.
 */
export async function confirmTaskArtifactManually(
  taskId: string,
  deps: AgentTaskRuntimeDeps,
): Promise<AgentTaskActionOutcome> {
  const { service, scanOutput } = resolveDeps(deps);
  const loaded = await service.get(taskId);
  if (!loaded.ok) return failure(taskId, loaded.code, loaded.message);
  const record = loaded.value;
  if (isTerminalTaskStatus(record.status)) {
    return failure(taskId, "INVALID_STATUS", `task is ${record.status}`, record);
  }
  if (record.status === "awaiting_import") {
    return importAwaitingTask(taskId, deps);
  }
  if (!record.outputDirectory) {
    return failure(
      taskId,
      "NO_ARTIFACT_FILE",
      "该任务没有预铸产物目录，无法扫描产物",
      record,
    );
  }
  const scanned = await scanOutput(record.outputDirectory);
  const picked = pickArtifactFromScan(scanned);
  if (!picked.ok) {
    return failure(taskId, picked.code, picked.message, record);
  }
  const parked = await service.markAwaitingImport(taskId, {
    resultPath: picked.path,
  });
  if (!parked.ok) return failure(taskId, parked.code, parked.message);
  return importAwaitingTask(taskId, deps);
}

/** Manual failure mark for manual-only tasks (or a stuck submission). */
export async function markTaskFailedManually(
  taskId: string,
  deps: AgentTaskRuntimeDeps,
  reason?: string,
): Promise<AgentTaskActionOutcome> {
  const { service } = deps;
  const marked = await service.markError(taskId, {
    code: "MANUAL_MARKED_FAILED",
    message:
      reason?.trim() ||
      "用户在任务面板手动标记失败；外部会话可能仍在运行，如需停止请在 Agent 面板操作",
  });
  if (!marked.ok) return failure(taskId, marked.code, marked.message);
  return { ok: true, taskId, record: marked.value };
}

export interface AwaitReconciliationResult {
  readonly failedAsMissing: readonly string[];
  readonly checked: number;
}

/**
 * Background pass over `awaiting_import` tasks: a target project that the
 * existence oracle reports as deleted fails the task (references cleared);
 * anything else keeps waiting for the user to switch back. Safe to run on
 * every task-list change, but not free: the oracle opens the projects
 * database once per awaiting_import task (it does not cache), so a pass is
 * linear in the awaiting-import count.
 */
export async function reconcileAwaitingImportTargets(
  deps: AgentTaskRuntimeDeps,
): Promise<AwaitReconciliationResult> {
  const { service, checkProject } = resolveDeps(deps);
  const listed = await service.list();
  const failedAsMissing: string[] = [];
  if (!listed.ok) return { failedAsMissing, checked: 0 };
  let checked = 0;
  for (const record of listed.value.tasks) {
    if (record.status !== "awaiting_import") continue;
    checked += 1;
    const existence = await checkProject(record.targetProjectId);
    if (existence.status !== "missing") continue;
    const verified = await service.verifyTargetProjectBeforeImport(record.id, []);
    if (verified.ok && verified.value.failedAsMissing) {
      failedAsMissing.push(record.id);
    }
  }
  return { failedAsMissing: [...failedAsMissing], checked };
}

export interface RecoveryResult {
  readonly interrupted: readonly string[];
  readonly artifactMissing: readonly string[];
}

/**
 * Renderer-session recovery, run once per renderer start (an app restart or
 * a plain renderer reload — the stored error code is named APP_RESTART, but
 * any fresh renderer invalidates the previous session's in-flight state)
 * before the user can act: tasks that were mid-flight when the previous
 * session ended cannot trust their in-progress state, and an
 * `awaiting_import` artifact that vanished from disk fails with an
 * explanation. Artifacts that still exist keep waiting and remain
 * importable. Records created after `createdBefore` belong to the running
 * session and are never touched.
 */
export async function recoverInterruptedTasks(
  deps: AgentTaskRuntimeDeps,
  createdBefore?: string,
): Promise<RecoveryResult> {
  const { service, artifactExists } = resolveDeps(deps);
  const listed = await service.list();
  const interrupted: string[] = [];
  const artifactMissing: string[] = [];
  if (!listed.ok) return { interrupted, artifactMissing };
  for (const record of listed.value.tasks) {
    if (createdBefore && record.createdAt > createdBefore) continue;
    if (
      record.status === "queued" ||
      record.status === "submitted" ||
      record.status === "running"
    ) {
      const marked = await service.markError(record.id, {
        code: "APP_RESTART",
        message: "应用重启中断了该任务；可重试重新提交",
      });
      if (marked.ok) interrupted.push(record.id);
      continue;
    }
    if (record.status === "awaiting_import" && record.resultPath) {
      const present = await artifactExists(record.resultPath);
      if (present === false) {
        const marked = await service.markError(record.id, {
          code: "ARTIFACT_MISSING",
          message: "应用重开后产物文件已不存在，无法导入；可重试重新生成",
        });
        if (marked.ok) artifactMissing.push(record.id);
      }
    }
  }
  return { interrupted: [...interrupted], artifactMissing: [...artifactMissing] };
}
