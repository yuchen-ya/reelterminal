import { hashMediaBlob, type Project } from "@reelterminal/core";
import { loadProjectMediaMetadata } from "./media-storage";
import {
  getMissingProjectRenderDependencyIds,
  prepareProjectRenderFonts,
} from "./project-render-dependencies";
import { cloneProject, projectMediaIds } from "./workspace-record-transforms";
import type { ProjectNodeRecord } from "./workspace-manager";

export async function missingProjectDependencies(project: Project): Promise<string[]> {
  const available = new Set(project.mediaLibrary.items.map((item) => item.id));
  const missing = new Set<string>();
  // The archive check compares hashes only; byte reads happen solely for
  // records that predate versioned media (no trusted stored hash).
  const storedMedia = new Map((await loadProjectMediaMetadata(
    project.id,
    project.mediaLibrary.items.map((item) => item.id),
  )).map((item) => [item.id, item]));
  for (const item of project.mediaLibrary.items) {
    const stored = storedMedia.get(item.id);
    if (item.isPlaceholder || !stored) {
      missing.add(item.id);
    } else if (item.contentHash) {
      // A hash computed from legacy bytes is deliberately not persisted back:
      // the only write path re-puts the whole inline-blob record, re-reading
      // the bytes this check just avoided, and runs outside the media
      // reference-write lock on the preview caller path.
      const storedHash = stored.contentHash
        ?? (stored.blob ? await hashMediaBlob(stored.blob) : undefined);
      if (storedHash !== item.contentHash) missing.add(item.id);
    }
  }
  for (const mediaId of projectMediaIds(project)) {
    if (!available.has(mediaId)) missing.add(mediaId);
  }
  for (const dependencyId of await getMissingProjectRenderDependencyIds(project)) {
    missing.add(dependencyId);
  }
  return [...missing].sort();
}

export async function enrichNodeRenderDependencies(node: ProjectNodeRecord): Promise<ProjectNodeRecord> {
  const project = cloneProject(await prepareProjectRenderFonts(node.project));
  const renderDependencies = await getMissingProjectRenderDependencyIds(project);
  const nonRenderDependencies = node.missingDependencies.filter((dependency) =>
    !dependency.startsWith("font:") &&
    !dependency.startsWith("font-render:") &&
    !dependency.startsWith("image:"),
  );
  // `node` is a fresh private record from readOne; the fields kept from it are
  // never mutated below, so a deep clone of the whole record (including the
  // heavy `project` that is replaced wholesale) would be pure waste.
  return {
    ...node,
    project,
    missingDependencies: [...new Set([...nonRenderDependencies, ...renderDependencies])].sort(),
  };
}
