/**
 * Pure target-project integrity check performed before an `awaiting_import`
 * task jumps into import (or before the UI navigates to the target project).
 *
 * Task records live in a user-level ledger, so nothing notifies them when a
 * project is deleted. Detection is therefore pull-based: the caller passes
 * whatever project ids it knows to exist and this check only decides
 * membership. Production callers consult the authoritative `projects` store
 * first (see project-existence.ts) and, once that oracle has reported the
 * target missing, pass an empty known-set so the task fails honestly here —
 * the artifact is never re-targeted at a different project. The evictable
 * recent-projects list must never be passed as the index: falling out of it
 * says nothing about whether a project still exists.
 */

export type AgentTaskTargetProjectCheck =
  | { readonly ok: true; readonly projectId: string }
  | {
      readonly ok: false;
      readonly code: "TARGET_PROJECT_MISSING";
      readonly message: string;
    };

export function checkTargetProjectAvailability(
  targetProjectId: string,
  knownProjectIds: readonly string[] | ReadonlySet<string>,
): AgentTaskTargetProjectCheck {
  const known =
    knownProjectIds instanceof Set
      ? knownProjectIds
      : new Set(knownProjectIds);
  if (known.has(targetProjectId)) {
    return { ok: true, projectId: targetProjectId };
  }
  return {
    ok: false,
    code: "TARGET_PROJECT_MISSING",
    message: `目标项目（${targetProjectId}）已不存在，无法导入产物；任务已标记失败，产物不会转投其他项目`,
  };
}
