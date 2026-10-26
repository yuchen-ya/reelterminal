import { indexedDB as testIndexedDB } from "fake-indexeddb";
import { Blob as NodeBlob } from "node:buffer";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { GraphicsEngine, MotionEngine, TitleEngine, type MediaItem, type Project, type Template } from "@reelterminal/core";
import { createEmptyProject } from "../stores/project/project-helpers";
import { getActiveProjectRuntimeStore } from "../stores/project-store";
import { workspaceManager } from "./workspace-manager";
import { saveMediaBlob } from "./media-storage";
import { projectTemplateStorage } from "./project-template-storage";
import { createMediaCleanupPlan, estimateProjectPurge } from "./project-media-gc";
import { createProjectFromTemplate, deleteProjectTemplate, instantiateProjectTemplate, listProjectTemplates, loadProjectTemplate, saveProjectTemplate, updateProjectTemplate } from "./project-templates";

vi.mock("./project-render-dependencies", () => ({
  prepareProjectRenderFonts: async (project: Project) => project,
  getMissingProjectRenderDependencyIds: async () => [],
  installProjectRenderFonts: async () => {},
  releaseProjectRenderFonts: () => {},
  collectFontFamilies: () => [],
}));

beforeAll(() => { window.indexedDB = testIndexedDB; });

afterEach(async () => {
  for (const template of await listProjectTemplates()) await deleteProjectTemplate(template.id);
  vi.restoreAllMocks();
});

const details = { name: "My template", description: "A saved project", tags: ["demo"] };

describe("local project templates", () => {
  it("starts with no builtin templates", async () => {
    expect(await listProjectTemplates()).toEqual([]);
  });

  it("round-trips editable data and creates an independent project without consuming the source history", async () => {
    const project = createEmptyProject("Source");
    const titles = new TitleEngine();
    const text = titles.createTextClip({ id: "title", trackId: "text-track", text: "Original title", startTime: 0, duration: 3 });
    const composition = new MotionEngine().createComposition({ name: "Original motion", width: 720, height: 1280 });
    const full = { ...project, textClips: [text], motionCompositions: [composition],
      timeline: { ...project.timeline, duration: 3, subtitles: [{ id: "subtitle", text: "Caption", startTime: 0, endTime: 2 }] },
    } as Project;
    const original = await workspaceManager.createProject(full);
    const target = { projectId: original.project.id, workspaceId: original.defaultWorkspaceId };
    await workspaceManager.switchView(target);
    const sourceStore = getActiveProjectRuntimeStore();
    await sourceStore.getState().addTrack("audio");
    await sourceStore.getState().undo();
    const before = sourceStore.getState().getFullProject();
    const history = sourceStore.getState().actionHistory;
    const redo = history.getRedoEntries();
    const template = await saveProjectTemplate(before, details);
    expect(template.projectSnapshot?.textClips).toEqual(before.textClips);
    expect(template.projectSnapshot?.motionCompositions).toEqual(before.motionCompositions);
    expect(template.projectSnapshot?.timeline.subtitles).toEqual(before.timeline.subtitles);
    // Metadata edits keep the stored content intact; the list only exposes
    // summaries, so content assertions read the full row on demand.
    await updateProjectTemplate(template.id, { ...details, name: "Renamed", tags: [" demo ", "demo"] });
    const stored = await loadProjectTemplate(template.id);
    expect(stored?.name).toBe("Renamed");
    expect(stored?.tags).toEqual(["demo"]);
    expect(stored?.projectSnapshot).toEqual(template.projectSnapshot);
    const [listed] = await listProjectTemplates();
    expect(listed.name).toBe("Renamed");
    expect(listed.version).toBe("2.0.0");
    expect(listed.hasSnapshot).toBe(true);
    await createProjectFromTemplate(template.id, "New from template");
    const next = getActiveProjectRuntimeStore().getState();
    expect(next.project.id).not.toBe(before.id);
    expect(next.project.name).toBe("New from template");
    expect(next.project.textClips).toEqual(before.textClips);
    expect(next.project.motionCompositions).toEqual(before.motionCompositions);
    expect(next.canUndo()).toBe(false);
    expect(next.canRedo()).toBe(false);
    expect(next.redoJournal).toEqual([]);
    expect(sourceStore.getState().getFullProject()).toEqual(before);
    expect(sourceStore.getState().actionHistory).toBe(history);
    expect(history.getRedoEntries()).toEqual(redo);
    await workspaceManager.switchView(target);
    expect((await sourceStore.getState().redo()).success).toBe(true);
    expect(sourceStore.getState().project.timeline.tracks.some((track) => track.type === "audio")).toBe(true);
  });

  it("retains managed media after source-project purge, then releases the template reference on deletion", async () => {
    const source = createEmptyProject("Media source");
    const blob = new NodeBlob(["local media bytes"], { type: "video/mp4" }) as unknown as Blob;
    const item: MediaItem = { id: crypto.randomUUID(), name: "local.mp4", type: "video", blob: null, fileHandle: null,
      thumbnailUrl: null, waveformData: null,
      metadata: { duration: 1, width: 320, height: 180, frameRate: 30, codec: "h264", sampleRate: 0, channels: 0, fileSize: blob.size },
    };
    await saveMediaBlob(source.id, item.id, blob, item.metadata);
    const full = { ...source, mediaLibrary: { items: [item] } };
    const original = await workspaceManager.createProject(full, { loadRuntime: false });
    const template = await saveProjectTemplate(full, details);
    const purge = await estimateProjectPurge([original.project.id]);
    expect(purge.bytes).toBe(0);
    await workspaceManager.recycleProjects([original.project.id]);
    await workspaceManager.purgeProjects([original.project.id]);
    const retained = await createMediaCleanupPlan();
    expect(retained.referenceScanReady).toBe(true);
    expect(retained.retained.find((entry) => entry.mediaId === item.id)?.reasons).toContain(`template: ${template.name} (${template.id})`);
    expect(retained.candidates.some((entry) => entry.mediaId === item.id)).toBe(false);
    await deleteProjectTemplate(template.id);
    const released = await createMediaCleanupPlan();
    expect(released.candidates.some((entry) => entry.mediaId === item.id)).toBe(true);
  });

  it("keeps legacy rows readable and blocks missing content before creating or switching projects", async () => {
    const project = createEmptyProject("Legacy source");
    const legacy = projectTemplateStorage.createFromProject(project, { ...details, category: "custom", placeholders: [] });
    expect(legacy.projectSnapshot).toBeUndefined();
    await projectTemplateStorage.saveTemplate(legacy);
    expect((await listProjectTemplates())[0].version).toBe("1.0.0");
    const shape = new GraphicsEngine().createRectangle("shape-track", 0, 3, 80, 40);
    const legacyGraphics = { ...legacy, timeline: { ...legacy.timeline, graphics: { shapes: [shape], svgs: [], stickers: [] } } };
    expect(instantiateProjectTemplate(legacyGraphics, {}, project).shapeClips).toEqual([shape]);
    const broken: Template = { ...legacy, id: "missing-template", projectSnapshot: { ...project,
      mediaLibrary: { items: [{ id: "missing-file", name: "missing.mp4", type: "video", isPlaceholder: true }] as MediaItem[] },
    } };
    await projectTemplateStorage.saveTemplate(broken);
    const originalStore = getActiveProjectRuntimeStore();
    const before = originalStore.getState().project;
    const projects = await workspaceManager.listProjects();
    await expect(createProjectFromTemplate(broken.id, "Must not exist")).rejects.toThrow(/Missing dependencies/);
    expect(getActiveProjectRuntimeStore()).toBe(originalStore);
    expect(originalStore.getState().project).toBe(before);
    expect(await workspaceManager.listProjects()).toEqual(projects);
  });
});
