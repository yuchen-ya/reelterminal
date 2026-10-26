import { TitleEngine, type Project, type Template, type TemplateReplacements } from "@reelterminal/core";
import { getActiveProjectRuntimeStore } from "../stores/project-store";
import i18n from "../i18n";
import { withMediaReferenceWrite } from "./media-storage";
import { projectTemplateStorage } from "./project-template-storage";
import { cloneProject } from "./workspace-record-transforms";
import { prepareProjectRenderFonts } from "./project-render-dependencies";
import { missingProjectDependencies } from "./workspace-dependency-audit";
import { workspaceManager } from "./workspace-manager";
import { switchProjectView } from "./project-switch-notify";

export interface TemplateDetails {
  name: string;
  description: string;
  tags: string[];
  thumbnailUrl?: string | null;
}

function normalizeDetails(details: TemplateDetails): TemplateDetails {
  const name = details.name.trim();
  if (!name) throw new Error(i18n.t("personalTemplates.nameRequired"));
  if (details.thumbnailUrl && (!/^data:image\/(png|jpeg|webp);base64,/.test(details.thumbnailUrl) || details.thumbnailUrl.length > 3 * 1024 * 1024)) {
    throw new Error(i18n.t("personalTemplates.invalidCover"));
  }
  return {
    name,
    description: details.description.trim(),
    tags: [...new Set(details.tags.map((tag) => tag.trim()).filter(Boolean))],
    ...(details.thumbnailUrl !== undefined ? { thumbnailUrl: details.thumbnailUrl } : {}),
  };
}

/**
 * Listing still reads full rows out of IndexedDB (each snapshot shares the
 * template row), so the getAll cost is unchanged; mapping to summaries keeps
 * the heavy `projectSnapshot` (with embedded renderFonts data URLs) from
 * being retained in UI state — details load on demand via loadProjectTemplate.
 */
export interface ProjectTemplateSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: string[];
  readonly thumbnailUrl: string | null;
  readonly createdAt: number;
  readonly modifiedAt: number;
  readonly version: string;
  readonly hasSnapshot: boolean;
  readonly duration: number;
}

function toSummary(template: Template): ProjectTemplateSummary {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    tags: template.tags,
    thumbnailUrl: template.thumbnailUrl,
    createdAt: template.createdAt,
    modifiedAt: template.modifiedAt,
    version: template.version,
    hasSnapshot: Boolean(template.projectSnapshot),
    duration: template.timeline.duration,
  };
}

export async function listProjectTemplates(): Promise<ProjectTemplateSummary[]> {
  const rows = await projectTemplateStorage.listStoredTemplates();
  return rows.map(toSummary).sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export const loadProjectTemplate = (id: string) => projectTemplateStorage.loadTemplate(id);

export async function saveProjectTemplate(project: Project, details: TemplateDetails): Promise<Template> {
  const metadata = normalizeDetails(details);
  return withMediaReferenceWrite(async () => {
    const snapshot = cloneProject(await prepareProjectRenderFonts(project));
    const missing = await missingProjectDependencies(snapshot);
    if (missing.length) throw new Error(i18n.t("personalTemplates.missingDependencies", { items: missing.join(", ") }));
    const template = projectTemplateStorage.createFromProject(snapshot, {
      ...metadata, category: "custom", placeholders: [],
    });
    const saved = { ...template, version: "2.0.0", projectSnapshot: snapshot, thumbnailUrl: metadata.thumbnailUrl ?? null };
    await projectTemplateStorage.saveTemplate(saved);
    return saved;
  });
}

export async function updateProjectTemplate(id: string, details: TemplateDetails): Promise<void> {
  const metadata = normalizeDetails(details);
  await withMediaReferenceWrite(async () => {
    const template = await projectTemplateStorage.loadTemplate(id);
    if (!template) throw new Error(i18n.t("personalTemplates.notFound"));
    await projectTemplateStorage.saveTemplate({ ...template, ...metadata, modifiedAt: Date.now() });
  });
}

export async function deleteProjectTemplate(id: string): Promise<void> {
  await withMediaReferenceWrite(() => projectTemplateStorage.deleteTemplate(id));
}

/** Legacy templates have parameters, but lack a complete project snapshot. */
export function instantiateProjectTemplate(
  template: Template,
  replacements: TemplateReplacements,
  source: Project,
): Project {
  const result = projectTemplateStorage.applyTemplate(template, replacements);
  if (result.missingPlaceholders.length) {
    throw new Error(i18n.t("personalTemplates.missingParameters", { items: result.missingPlaceholders.join(", ") }));
  }
  if (template.projectSnapshot) return result.project;

  const mediaMap = new Map<string, string>();
  const media = template.placeholders.filter((item) => item.type === "media").flatMap((placeholder) => {
    const id = replacements[placeholder.id]?.value ?? placeholder.defaultValue;
    const item = source.mediaLibrary.items.find((candidate) => candidate.id === id);
    if (!item) return [];
    mediaMap.set(placeholder.id, item.id);
    return [item];
  });
  const titles = new TitleEngine();
  for (const text of result.textClips) {
    const track = result.project.timeline.tracks.find((candidate) => candidate.clips.some((clip) => clip.id === text.id))!;
    const clip = track.clips.find((candidate) => candidate.id === text.id)!;
    titles.createTextClip({ id: text.id, trackId: track.id, text: text.text,
      startTime: clip.startTime, duration: clip.duration, transform: clip.transform });
  }
  const textIds = new Set(result.textClips.map((item) => item.id));
  return {
    ...result.project,
    mediaLibrary: { items: [...new Map(media.map((item) => [item.id, item])).values()] },
    textClips: titles.getAllTextClips(),
    timeline: {
      ...result.project.timeline,
      tracks: result.project.timeline.tracks.map((track) => ({
        ...track,
        clips: track.clips.filter((clip) => !textIds.has(clip.id)).map((clip) => ({
          ...clip, mediaId: mediaMap.get(clip.mediaId) ?? clip.mediaId,
        })),
      })),
    },
  };
}

export async function inspectProjectTemplate(template: Template, replacements: TemplateReplacements, source: Project): Promise<string[]> {
  return missingProjectDependencies(instantiateProjectTemplate(template, replacements, source));
}

export async function createProjectFromTemplate(id: string, name: string, replacements: TemplateReplacements = {}): Promise<void> {
  if (!name.trim()) throw new Error(i18n.t("personalTemplates.nameRequired"));
  const originalStore = getActiveProjectRuntimeStore();
  const originalProjectId = originalStore.getState().project.id;
  const source = originalStore.getState().getFullProject();
  const template = await projectTemplateStorage.loadTemplate(id);
  if (!template) throw new Error(i18n.t("personalTemplates.notFound"));
  const project = instantiateProjectTemplate(template, replacements, source);
  const created = await workspaceManager.createProject({ ...project, name: name.trim() }, {
    requireAvailableDependencies: true,
  });
  // Preparing fonts/media can take time. A user switch must not be undone.
  if (getActiveProjectRuntimeStore() !== originalStore || originalStore.getState().project.id !== originalProjectId) {
    throw new Error(i18n.t("personalTemplates.createdWithoutSwitch", { name: created.project.name }));
  }
  await switchProjectView({ projectId: created.project.id, workspaceId: created.defaultWorkspaceId });
}
