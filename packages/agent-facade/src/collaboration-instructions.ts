import type { Project } from "@reelterminal/core/types/project";
import type { CollaborationInstruction } from "@reelterminal/core/types/collaboration-instruction";

export interface CollaborationInstructionsResult {
  readonly revision: number;
  readonly projectId: string;
  readonly workspaceId?: string;
  readonly instructions: readonly CollaborationInstruction[];
}

export function collaborationInstructionsView(project: Project, revision: number, workspaceId?: string): CollaborationInstructionsResult {
  return {
    revision,
    projectId: project.id,
    ...(workspaceId ? { workspaceId } : {}),
    instructions: structuredClone(project.collaborationInstructions?.items.filter(item => item.enabled) ?? []),
  };
}

export function collaborationInstructionsSummary(project?: Project | null) {
  const items = (project?.collaborationInstructions?.items ?? [])
    .filter(item => item.enabled)
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  return { enabledCount: items.length, items };
}
