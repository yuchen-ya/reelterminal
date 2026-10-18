import type { RequirementReference } from "./requirement";

export const COLLABORATION_INSTRUCTION_LIMITS = { items: 20, title: 80, description: 2000 } as const;

/** User-authored project guidance, independent of executable board tasks. */
export interface CollaborationInstruction {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly references?: readonly RequirementReference[];
  readonly presetId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProjectCollaborationInstructions {
  readonly items: readonly CollaborationInstruction[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const time = (value: unknown): boolean =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);

/** Shared validation for action input and imported project data. Missing = empty legacy project. */
export function validCollaborationInstructions(value: unknown): value is ProjectCollaborationInstructions | undefined {
  if (value === undefined) return true;
  if (!record(value) || !Array.isArray(value.items) || value.items.length > COLLABORATION_INSTRUCTION_LIMITS.items) return false;
  const ids = new Set<string>();
  return value.items.every((item: unknown) => {
    if (!record(item) || !text(item.id, 200) || ids.has(item.id) ||
      !text(item.title, COLLABORATION_INSTRUCTION_LIMITS.title) ||
      !text(item.description, COLLABORATION_INSTRUCTION_LIMITS.description) ||
      typeof item.enabled !== "boolean" ||
      typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt) || item.createdAt < 0 ||
      typeof item.updatedAt !== "number" || !Number.isFinite(item.updatedAt) || item.updatedAt < 0 ||
      (item.presetId !== undefined && !text(item.presetId, 100))) return false;
    ids.add(item.id);
    return item.references === undefined || (Array.isArray(item.references) && item.references.length <= 100 && item.references.every((ref: unknown) =>
      record(ref) && text(ref.entityId, 200) && typeof ref.ref === "string" && typeof ref.label === "string" &&
      ["video", "audio", "text", "media", "workAsset"].includes(ref.kind as string) && record(ref.timing) &&
      time(ref.timing.startSeconds) && time(ref.timing.endSeconds) &&
      (ref.timing.startSeconds === null || ref.timing.endSeconds === null ||
        (ref.timing.endSeconds as number) >= (ref.timing.startSeconds as number))));
  });
}
