import type { Project } from "@reelterminal/core";
import type { MediaReference } from "./project-media-gc";
import { projectMediaIds } from "./workspace-record-transforms";
import { collectArtifactPaths } from "./artifact-paths";
import type { ArtifactPathReference } from "./workspace-manager";

// Exports can outlive their React view. Keep their lifetime and media roots here.
const exports = new Map<symbol, Project>();
const deletingProjects = new Set<string>();

export function beginProjectExport(owner: symbol, project: Project): void {
  if (deletingProjects.has(project.id))
    throw new Error("Project deletion is in progress");
  exports.set(owner, structuredClone(project));
}

export function blockProjectExports(ids: readonly string[]): void {
  ids.forEach((id) => deletingProjects.add(id));
}

export function unblockProjectExports(ids: readonly string[]): void {
  ids.forEach((id) => deletingProjects.delete(id));
}

export function endProjectExport(owner: symbol): void {
  exports.delete(owner);
}

export function getExportingProjectIds(): Set<string> {
  return new Set([...exports.values()].map((project) => project.id));
}

export function getExportArtifactPathReferences(): ArtifactPathReference[] {
  return [...exports.values()].flatMap((project) => [...collectArtifactPaths(project)].map((pathKey) => ({
    pathKey, projectId: project.id, kind: "task" as const, referenceId: "active-export",
  })));
}

export function getExportMediaReferences(): MediaReference[] {
  return [...exports.values()].flatMap((project) =>
    projectMediaIds(project).map((mediaId) => ({
      mediaId,
      projectId: project.id,
      kind: "task" as const,
      referenceId: "active-export",
      label: "Running export",
      purpose: "task-input" as const,
    })),
  );
}
