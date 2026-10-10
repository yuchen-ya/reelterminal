import type { ProjectRequirement, ProjectRequirementStatus } from "@reelterminal/core/types/requirement";
import { REQUIREMENT_STATUSES } from "@reelterminal/core/types/requirement";
import { FacadeError } from "./errors";
import { oneOf, type ObjectSchema } from "./validate";

export interface RequirementsListParams {
  readonly status?: ProjectRequirementStatus;
}

export interface RequirementsGetParams {
  readonly requirementId: string;
}

export interface RequirementSummary {
  readonly ref: string;
  readonly title: string;
  readonly status: ProjectRequirementStatus;
  readonly priority: ProjectRequirement["priority"];
  readonly markerIds: readonly string[];
  readonly updatedAt: number;
}

export interface RequirementsListResult {
  readonly revision: number;
  readonly requirements: readonly RequirementSummary[];
}

export interface RequirementsGetResult {
  readonly revision: number;
  readonly requirement: ProjectRequirement & { readonly ref: string };
}

export const REQUIREMENTS_LIST_SCHEMA: ObjectSchema = {
  status: {
    check: oneOf(REQUIREMENT_STATUSES),
    emits: { kind: "leaf", schema: { enum: REQUIREMENT_STATUSES } },
    describe: "optional requirement status filter",
  },
};

export const REQUIREMENTS_GET_SCHEMA: ObjectSchema = {
  requirementId: {
    required: true,
    check: (value) => typeof value === "string" && value.trim().length > 0,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
    describe: "requirement Q reference or internal id",
  },
};

export function requirementsListView(
  items: readonly ProjectRequirement[],
  revision: number,
  params: RequirementsListParams,
): RequirementsListResult {
  return {
    revision,
    requirements: items
      .filter((item) => params.status === undefined || item.status === params.status)
      .map((item) => ({
        ref: `Q${item.number}`,
        title: item.title,
        status: item.status,
        priority: item.priority,
        markerIds: [...item.markerIds],
        updatedAt: item.updatedAt,
      })),
  };
}

export function requirementsGetView(
  items: readonly ProjectRequirement[],
  revision: number,
  params: RequirementsGetParams,
): RequirementsGetResult {
  const item = items.find((candidate) =>
    `Q${candidate.number}`.toLowerCase() === params.requirementId.toLowerCase() ||
    candidate.id === params.requirementId,
  );
  if (!item) throw new FacadeError("NOT_FOUND", `Requirement ${params.requirementId} was not found`);
  return { revision, requirement: { ...structuredClone(item), ref: `Q${item.number}` } };
}
