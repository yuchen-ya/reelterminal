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

export interface RequirementReference {
  readonly ref: string;
  readonly kind: "video" | "audio" | "text" | "media" | "workAsset";
  readonly entityId: string;
  readonly label: string;
  readonly timing: { readonly startSeconds: number | null; readonly endSeconds: number | null };
}

/** Persisted user requirement. This is project work state, never conversation history. */
export interface ProjectRequirement {
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
    | "markerIds"
    | "analysisRecordIds"
    | "resultMediaIds"
    | "agentNote"
  >
>;
