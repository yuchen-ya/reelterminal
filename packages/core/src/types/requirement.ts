export const REQUIREMENT_STATUSES = [
  "draft",
  "ready",
  "in_progress",
  "blocked",
  "review",
  "done",
] as const;

export type ProjectRequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const REQUIREMENT_PRIORITIES = ["low", "normal", "high"] as const;
export type ProjectRequirementPriority = (typeof REQUIREMENT_PRIORITIES)[number];

export const CLEANUP_HANDOFF_PHASES = [
  "pending_review",
  "reviewing",
  "awaiting_confirmation",
  "executing",
  "completed",
] as const;
export type CleanupHandoffPhase = (typeof CLEANUP_HANDOFF_PHASES)[number];

/** Durable review-only handoff for cleanup work tied to one exact workspace export. */
export interface ProjectCleanupHandoff {
  readonly projectId: string;
  readonly workspaceId: string;
  /** Absent when cleanup starts before any export exists. */
  readonly exportId?: string;
  /** Revision of the project snapshot used by the export. */
  readonly revision: number;
  readonly nodeIds: readonly string[];
  readonly scope: string;
  readonly retention: string;
  readonly phase: CleanupHandoffPhase;
}

export function validProjectCleanupHandoff(
  value: unknown,
  projectId?: string,
): value is ProjectCleanupHandoff {
  if (!value || typeof value !== "object") return false;
  const handoff = value as Partial<ProjectCleanupHandoff>;
  return typeof handoff.projectId === "string" && handoff.projectId.trim().length > 0 &&
    (projectId === undefined || handoff.projectId === projectId) &&
    typeof handoff.workspaceId === "string" && handoff.workspaceId.trim().length > 0 &&
    (handoff.exportId === undefined || (typeof handoff.exportId === "string" && handoff.exportId.trim().length > 0)) &&
    Number.isSafeInteger(handoff.revision) && (handoff.revision as number) >= 0 &&
    Array.isArray(handoff.nodeIds) &&
    handoff.nodeIds.every((id) => typeof id === "string" && id.trim().length > 0) &&
    new Set(handoff.nodeIds).size === handoff.nodeIds.length &&
    typeof handoff.scope === "string" && handoff.scope.trim().length > 0 &&
    typeof handoff.retention === "string" && handoff.retention.trim().length > 0 &&
    (CLEANUP_HANDOFF_PHASES as readonly unknown[]).includes(handoff.phase);
}

export interface RequirementReference {
  readonly ref: string;
  readonly kind: "video" | "audio" | "text" | "media" | "workAsset";
  readonly entityId: string;
  readonly label: string;
  readonly timing: { readonly startSeconds: number | null; readonly endSeconds: number | null };
}

/** Persisted user requirement. This is project work state, never conversation history. */
export interface ProjectRequirement {
  readonly reviewRange?: import("./review-range").ReviewRange;
  readonly cleanupHandoff?: ProjectCleanupHandoff;
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly instruction?: string;
  readonly priority: ProjectRequirementPriority;
  readonly status: ProjectRequirementStatus;
  readonly references?: readonly RequirementReference[];
  readonly markerIds: readonly string[];
  readonly analysisRecordIds?: readonly string[];
  readonly resultMediaIds?: readonly string[];
  readonly agentNote?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProjectRequirementsState {
  /** Stable Q numbers are monotonic and never reused. */
  readonly nextNumber: number;
  readonly items: readonly ProjectRequirement[];
}

export type ProjectRequirementPatch = Partial<
  Pick<
    ProjectRequirement,
    | "title"
    | "description"
    | "acceptanceCriteria"
    | "instruction"
    | "priority"
    | "status"
    | "references"
    | "cleanupHandoff"
    | "markerIds"
    | "analysisRecordIds"
    | "resultMediaIds"
    | "agentNote"
  >
>;
