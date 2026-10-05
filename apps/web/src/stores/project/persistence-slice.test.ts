import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@reelterminal/core";
import { createEmptyProject } from "./project-helpers";

const autoSaveMocks = vi.hoisted(() => ({
  initialize: vi.fn<() => Promise<void>>(),
  start: vi.fn(),
  markDirty: vi.fn(),
  forceSave: vi.fn<(project: Project) => Promise<void>>(),
  checkForRecovery: vi.fn(),
  recover: vi.fn(),
  hasUnsavedChanges: vi.fn(),
}));

const { loadProjectMedia, restoreMediaItem, addToRecent } = vi.hoisted(() => ({
  loadProjectMedia: vi.fn(),
  restoreMediaItem: vi.fn(),
  addToRecent: vi.fn(),
}));

vi.mock("../../services/auto-save", () => ({
  initializeAutoSave: autoSaveMocks.initialize,
  autoSaveManager: {
    start: autoSaveMocks.start,
    markDirty: autoSaveMocks.markDirty,
    forceSave: autoSaveMocks.forceSave,
    checkForRecovery: autoSaveMocks.checkForRecovery,
    recover: autoSaveMocks.recover,
    hasUnsavedChanges: autoSaveMocks.hasUnsavedChanges,
  },
}));

vi.mock("../../services/media-storage", () => ({ loadProjectMedia }));
vi.mock("../../services/project-media-gc", () => ({
  attachProjectMediaGc: vi.fn(),
  flushProjectMediaBytes: vi.fn(),
  sweepOrphanProjectMedia: vi.fn(),
}));
vi.mock("../../services/project-manager", () => ({
  projectManager: { addToRecent, clearCurrentFileHandle: vi.fn() },
}));
vi.mock("../../utils/media-recovery", () => ({ restoreMediaItem }));
vi.mock("../engine-store", () => ({
  useEngineStore: {
    getState: () => ({
      getTitleEngine: () => null,
      getGraphicsEngine: () => null,
    }),
  },
}));

async function createHarness() {
  const { createProjectPersistenceSlice } = await import("./persistence-slice");
  const project = createEmptyProject("Persistence test");
  let currentProject = project;
  let onProjectChange: (() => void) | undefined;
  const subscribeToProject = vi.fn((listener: () => void) => {
    onProjectChange = listener;
    return vi.fn();
  });
  const holder: { slice?: ReturnType<typeof createProjectPersistenceSlice> } = {};
  const get = () => ({
    project: currentProject,
    getFullProject: () => currentProject,
    initializeAutoSave: holder.slice!.initializeAutoSave,
  });
  const slice = createProjectPersistenceSlice(
    vi.fn() as Parameters<typeof createProjectPersistenceSlice>[0],
    get as Parameters<typeof createProjectPersistenceSlice>[1],
    { subscribeToProject },
  );
  holder.slice = slice;
  return {
    project,
    slice,
    subscribeToProject,
    setProject(nextProject: Project) {
      currentProject = nextProject;
      onProjectChange?.();
    },
  };
}

describe("project persistence initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    autoSaveMocks.initialize.mockResolvedValue(undefined);
    autoSaveMocks.forceSave.mockResolvedValue(undefined);
    autoSaveMocks.hasUnsavedChanges.mockReturnValue(false);
    loadProjectMedia.mockResolvedValue([]);
    restoreMediaItem.mockImplementation(async (item: unknown) => item);
    addToRecent.mockResolvedValue(undefined);
  });

  it("can retry after the first initialization rejects", async () => {
    autoSaveMocks.initialize
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(undefined);
    const { slice, subscribeToProject } = await createHarness();

    await expect(slice.initializeAutoSave()).rejects.toThrow("database unavailable");
    await expect(slice.initializeAutoSave()).resolves.toBeUndefined();

    expect(autoSaveMocks.initialize).toHaveBeenCalledTimes(2);
    expect(autoSaveMocks.start).toHaveBeenCalledTimes(1);
    expect(subscribeToProject).toHaveBeenCalledTimes(1);
  });

  it("shares concurrent initialization and installs one scheduler subscription", async () => {
    let resolveInitialization: (() => void) | undefined;
    autoSaveMocks.initialize.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveInitialization = resolve;
        }),
    );
    const { slice, subscribeToProject } = await createHarness();

    const first = slice.initializeAutoSave();
    const second = slice.initializeAutoSave();
    expect(autoSaveMocks.initialize).toHaveBeenCalledTimes(1);
    resolveInitialization?.();
    await Promise.all([first, second]);

    expect(autoSaveMocks.start).toHaveBeenCalledTimes(1);
    expect(subscribeToProject).toHaveBeenCalledTimes(1);
  });

  it("initializes before force-save and propagates initialization failure", async () => {
    const failure = new Error("cannot open database");
    autoSaveMocks.initialize.mockRejectedValueOnce(failure);
    const failed = await createHarness();
    await expect(failed.slice.forceSave()).rejects.toBe(failure);
    expect(autoSaveMocks.forceSave).not.toHaveBeenCalled();

    vi.resetModules();
    autoSaveMocks.initialize.mockResolvedValueOnce(undefined);
    const successful = await createHarness();
    await successful.slice.forceSave();
    expect(autoSaveMocks.initialize.mock.invocationCallOrder.at(-1)).toBeLessThan(
      autoSaveMocks.forceSave.mock.invocationCallOrder.at(-1)!,
    );
    expect(autoSaveMocks.forceSave).toHaveBeenLastCalledWith(successful.project);
    expect(addToRecent).toHaveBeenLastCalledWith(successful.project);
    expect(autoSaveMocks.forceSave.mock.invocationCallOrder.at(-1)).toBeLessThan(addToRecent.mock.invocationCallOrder.at(-1)!);
  });

  it("does not advertise a saved recent project when persistence failed", async () => {
    const { slice } = await createHarness();
    autoSaveMocks.forceSave.mockRejectedValueOnce(new Error("storage full"));
    await expect(slice.forceSave()).rejects.toThrow("storage full");
    expect(addToRecent).not.toHaveBeenCalled();
  });

  it("queues an unsaved project snapshot when switching projects", async () => {
    const { project, slice, setProject } = await createHarness();
    const editedProject = { ...project, name: "Edited before switch" };
    const nextProject = createEmptyProject("Next project");
    autoSaveMocks.hasUnsavedChanges.mockImplementation(
      (candidate: Project) => candidate.id === project.id,
    );
    await slice.initializeAutoSave();

    setProject(editedProject);
    setProject(nextProject);

    expect(autoSaveMocks.markDirty).toHaveBeenCalledWith(editedProject);
    expect(autoSaveMocks.forceSave).toHaveBeenCalledWith(editedProject);
    expect(autoSaveMocks.markDirty).not.toHaveBeenCalledWith(nextProject);
  });

  it("does not replace the active project when recovery finishes after a project switch", async () => {
    const startingProject = createEmptyProject("Starting project");
    const recoveredProject = createEmptyProject("Recovered project");
    const nextProject = createEmptyProject("Project opened during recovery");
    const mediaItem = {
      id: "recovered-media",
      name: "recovered.png",
      type: "image" as const,
      fileHandle: null,
      blob: null,
      metadata: {
        duration: 0,
        width: 10,
        height: 10,
        frameRate: 0,
        codec: "",
        sampleRate: 0,
        channels: 0,
        fileSize: 1,
      },
      thumbnailUrl: "blob:existing",
      waveformData: null,
    };
    const projectToRecover: Project = {
      ...recoveredProject,
      mediaLibrary: { items: [mediaItem] },
    };
    let finishRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => {
      finishRestore = resolve;
    });
    const revokeObjectUrl = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    autoSaveMocks.recover.mockResolvedValueOnce(projectToRecover);
    restoreMediaItem.mockImplementationOnce(async (item: typeof mediaItem) => {
      await restoreGate;
      return { ...item, thumbnailUrl: "blob:restored" };
    });

    const { createProjectPersistenceSlice } = await import("./persistence-slice");
    let project = startingProject;
    let projectRevision = 0;
    const set = vi.fn((update: Partial<{ project: Project }>) => {
      if (update.project) project = update.project;
    });
    const holder: { slice?: ReturnType<typeof createProjectPersistenceSlice> } = {};
    const get = () => ({
      get project() {
        return project;
      },
      get projectRevision() {
        return projectRevision;
      },
      getFullProject: () => project,
      initializeAutoSave: holder.slice!.initializeAutoSave,
    });
    const slice = createProjectPersistenceSlice(
      set as Parameters<typeof createProjectPersistenceSlice>[0],
      get as Parameters<typeof createProjectPersistenceSlice>[1],
      { subscribeToProject: vi.fn(() => vi.fn()) },
    );
    holder.slice = slice;

    const pending = slice.recoverFromAutoSave("save-id");
    await vi.waitFor(() => expect(restoreMediaItem).toHaveBeenCalledTimes(1));
    project = nextProject;
    projectRevision += 1;
    finishRestore();

    expect(await pending).toBe(false);
    expect(project).toBe(nextProject);
    expect(set).not.toHaveBeenCalled();
    expect(addToRecent).not.toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:restored");
    revokeObjectUrl.mockRestore();
  });
});
