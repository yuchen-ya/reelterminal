import type { CleanupHandoffPhase, ProjectCleanupHandoff, ProjectRequirement } from "@reelterminal/core";
import { getActiveProjectRuntimeStore } from "../stores/project-store";
import type { WorkspaceContextHandle } from "./workspace-manager";

export interface CleanupHandoffTarget {
  readonly projectId: string;
  readonly workspaceId: string;
  /** Source workspace revision represented by this cleanup request. */
  readonly revision: number;
  /** Missing only when the user starts cleanup review before exporting. */
  readonly exportId?: string;
  readonly scope: string;
  readonly retention: string;
}

function normalizedInput(
  target: CleanupHandoffTarget,
  nodeIds: readonly string[],
): { target: CleanupHandoffTarget; nodeIds: readonly string[] } {
  if (!target || typeof target.projectId !== "string" || !target.projectId.trim() ||
      typeof target.workspaceId !== "string" || !target.workspaceId.trim()) {
    throw new Error("Cleanup review requires a project and workspace target");
  }
  if (!Number.isSafeInteger(target.revision) || target.revision < 0) {
    throw new Error("Cleanup review requires a valid source revision");
  }
  if (target.exportId !== undefined && (typeof target.exportId !== "string" || !target.exportId.trim())) {
    throw new Error("Cleanup export id cannot be empty");
  }
  if (typeof target.scope !== "string" || typeof target.retention !== "string") {
    throw new Error("Cleanup review requires an explicit scope and retention rule");
  }
  const scope = target.scope.trim();
  const retention = target.retention.trim();
  if (!scope || !retention) {
    throw new Error("Cleanup review requires an explicit scope and retention rule");
  }
  if (!Array.isArray(nodeIds)) throw new Error("Cleanup review node selection must be an array");
  const selectedNodeIds = nodeIds.map((id) => typeof id === "string" ? id.trim() : "");
  if (selectedNodeIds.some((id) => !id)) throw new Error("Cleanup review node ids cannot be empty strings");
  if (new Set(selectedNodeIds).size !== selectedNodeIds.length) {
    throw new Error("Cleanup review node selection contains duplicates");
  }
  return {
    target: {
      ...target,
      ...(target.exportId !== undefined ? { exportId: target.exportId.trim() } : {}),
      scope,
      retention,
    },
    nodeIds: selectedNodeIds,
  };
}

function sameHandoff(
  left: ProjectCleanupHandoff,
  right: ProjectCleanupHandoff,
): boolean {
  return left.projectId === right.projectId &&
    left.workspaceId === right.workspaceId &&
    left.exportId === right.exportId &&
    left.revision === right.revision &&
    left.scope === right.scope &&
    left.retention === right.retention &&
    left.nodeIds.length === right.nodeIds.length &&
    left.nodeIds.every((id, index) => id === right.nodeIds[index]);
}

/** Persist a review-only cleanup handoff as an ordinary project requirement. */
export async function publishCleanupReview(
  targetInput: CleanupHandoffTarget,
  nodeIdsInput: readonly string[],
  options: { readonly store?: WorkspaceContextHandle["store"] } = {},
): Promise<ProjectRequirement> {
  const { target, nodeIds } = normalizedInput(targetInput, nodeIdsInput);
  const store = options.store ?? getActiveProjectRuntimeStore();
  const state = store.getState();
  if (state.project.id !== target.projectId || state.workspaceId !== target.workspaceId) {
    throw new Error("Cleanup review target is not the active project workspace");
  }

  const handoff: ProjectCleanupHandoff = {
    projectId: target.projectId,
    workspaceId: target.workspaceId,
    ...(target.exportId !== undefined ? { exportId: target.exportId } : {}),
    revision: target.revision,
    nodeIds,
    scope: target.scope,
    retention: target.retention,
    phase: "pending_review",
  };
  const existing = state.project.requirements?.items.find((item) =>
    item.cleanupHandoff && sameHandoff(item.cleanupHandoff, handoff),
  );
  if (existing) return structuredClone(existing);

  const result = await state.addProjectRequirement({
    title: target.exportId
      ? `Review cleanup for export ${target.exportId}`
      : nodeIds.length > 0
        ? `Review cleanup for ${nodeIds.length} selected nodes`
        : "Review workspace cleanup (no nodes selected)",
    description: [
      "Review-only cleanup request. No files or project data are authorized for deletion or modification.",
      `Project: ${target.projectId}`,
      `Workspace: ${target.workspaceId}`,
      `Source revision: ${target.revision}`,
      `Export: ${target.exportId ?? "not bound to an export"}`,
      nodeIds.length > 0
        ? `Nodes: ${nodeIds.join(", ")}`
        : "Nodes: none (workspace-level scope; no node selected)",
      `Scope: ${target.scope}`,
      `Retain: ${target.retention}`,
    ].join("\n"),
    instruction: "Review cleanup candidates and report a proposal only. Wait for the user to confirm the exact operation before execution.",
    acceptanceCriteria: [
      "Report the exact project, workspace, export (if any), source revision, and node ids reviewed.",
      "List each proposed cleanup candidate and explain why it is safe to remove.",
      "Confirm the stated retention rules and identify shared or uncertain data that must remain.",
      "Do not delete, move, overwrite, or execute cleanup before the user explicitly confirms the exact proposal.",
    ],
    status: "ready",
    cleanupHandoff: handoff,
  });
  if (!result.success) {
    throw new Error(result.error?.message ?? "Cleanup review could not be published");
  }
  const published = store.getState().project.requirements?.items.find((item) =>
    item.cleanupHandoff && sameHandoff(item.cleanupHandoff, handoff),
  );
  if (!published) throw new Error("Published cleanup review was not persisted");
  return structuredClone(published);
}

const CLEANUP_PHASE_STATUS: Readonly<Record<CleanupHandoffPhase, ProjectRequirement["status"]>> = {
  pending_review: "ready",
  reviewing: "in_progress",
  awaiting_confirmation: "review",
  executing: "in_progress",
  completed: "done",
};

/** Advance the persisted board item through its review lifecycle. */
export async function advanceCleanupReviewPhase(
  targetInput: CleanupHandoffTarget,
  nodeIdsInput: readonly string[],
  nextPhase: CleanupHandoffPhase,
  options: {
    readonly confirmedExecution?: boolean;
    /** A resolver-owned target store permits safe updates when the user has switched workspaces. */
    readonly store?: WorkspaceContextHandle["store"];
  } = {},
): Promise<ProjectRequirement> {
  const { target, nodeIds } = normalizedInput(targetInput, nodeIdsInput);
  const store = options.store ?? getActiveProjectRuntimeStore();
  const state = store.getState();
  if (state.project.id !== target.projectId || state.workspaceId !== target.workspaceId) {
    throw new Error("Cleanup review target is not the active project workspace");
  }
  const requirement = state.project.requirements?.items.find((item) =>
    item.cleanupHandoff && sameHandoff(item.cleanupHandoff, {
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      ...(target.exportId !== undefined ? { exportId: target.exportId } : {}),
      revision: target.revision,
      nodeIds,
      scope: target.scope,
      retention: target.retention,
      phase: "pending_review",
    }),
  );
  if (!requirement?.cleanupHandoff) throw new Error("Cleanup review task was not found for this target");
  const phases: readonly CleanupHandoffPhase[] = [
    "pending_review",
    "reviewing",
    "awaiting_confirmation",
    "executing",
    "completed",
  ];
  const currentIndex = phases.indexOf(requirement.cleanupHandoff.phase);
  const nextIndex = phases.indexOf(nextPhase);
  if (nextIndex === currentIndex) return structuredClone(requirement);
  const retryReview = requirement.cleanupHandoff.phase === "executing" && nextPhase === "awaiting_confirmation";
  if (nextIndex !== currentIndex + 1 && !retryReview) {
    throw new Error("Cleanup review phase must advance one step at a time");
  }
  if (nextPhase === "executing" && options.confirmedExecution !== true) {
    throw new Error("User confirmation of the exact cleanup proposal is required before execution");
  }
  const result = await state.updateProjectRequirement(requirement.id, {
    status: CLEANUP_PHASE_STATUS[nextPhase],
    cleanupHandoff: { ...requirement.cleanupHandoff, phase: nextPhase },
  });
  if (!result.success) throw new Error(result.error?.message ?? "Cleanup review phase could not be saved");
  const updated = store.getState().project.requirements?.items.find((item) => item.id === requirement.id);
  if (!updated) throw new Error("Cleanup review task disappeared while updating its phase");
  return structuredClone(updated);
}

function redactCredentialLikeText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret))\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs])_[A-Za-z0-9_-]{12,}\b/gi, "[redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@");
}

/** Build a credential-free prompt that requests review and explicitly forbids execution. */
export function buildCleanupAgentPrompt(
  targetInput: CleanupHandoffTarget,
  nodeIdsInput: readonly string[],
): string {
  const { target, nodeIds } = normalizedInput(targetInput, nodeIdsInput);
  const exportBinding = target.exportId
    ? `Export ID: ${target.exportId}`
    : "Export ID: not bound to an export";
  return [
    "Review this cleanup request and prepare a proposal only.",
    "",
    `Project ID: ${target.projectId}`,
    `Workspace ID: ${target.workspaceId}`,
    exportBinding,
    `Source revision: ${target.revision}`,
    nodeIds.length > 0
      ? `Node IDs: ${nodeIds.join(", ")}`
      : "Node IDs: none (workspace-level scope; no node selected)",
    `Requested scope: ${redactCredentialLikeText(target.scope)}`,
    `Retention rules: ${redactCredentialLikeText(target.retention)}`,
    "",
    "Resolve the explicit project, workspace, export binding and node IDs above. Source revision identifies the request's origin; rescan the current revision and bind the final plan to that revision. Report intervening edits and stop if the target identity differs.",
    ...(nodeIds.length === 0
      ? ["An empty node selection means the explicit workspace-level scope above only. Never interpret it as permission to scan or clean all projects."]
      : []),
    "Inspect candidates and report exact items, reasons, estimated effects, and any uncertain or shared data that must be retained. Follow the retention rules above.",
    "This request authorizes review only. Do not delete, move, overwrite, or execute cleanup. Wait until the user explicitly confirms the exact proposed operation for this project, workspace, export (if any), revision, and node selection.",
    "Do not print or request credentials, tokens, passwords, or secrets.",
  ].join("\n");
}
