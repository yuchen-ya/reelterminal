import { randomUUID } from "node:crypto";
import type { Project, ProjectSettings } from "@reelterminal/core/types/project";

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  width: 1920,
  height: 1080,
  frameRate: 30,
  sampleRate: 48000,
  channels: 2,
};

/**
 * Canonical empty project. Mirrors the audited headless factory
 * (packages/agent-runner/src/project-io.ts createEmptyProject) so facade and
 * runner agree on the same baseline shape.
 */
export function createEmptyProject(
  name?: string,
  settings?: Partial<ProjectSettings>,
): Project {
  const now = Date.now();
  return {
    id: randomUUID(),
    name: name && name.length > 0 ? name : "Untitled",
    createdAt: now,
    modifiedAt: now,
    settings: { ...DEFAULT_PROJECT_SETTINGS, ...settings },
    mediaLibrary: { items: [] },
    timeline: { tracks: [], subtitles: [], duration: 0, markers: [] },
    markers: { nextNumber: 1, items: [] },
  } as unknown as Project;
}
