import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "./project-helpers";

const autoSaveMocks = vi.hoisted(() => ({
  initialize: vi.fn<[], Promise<void>>(),
  start: vi.fn(),
  markDirty: vi.fn(),
  forceSave: vi.fn<[], Promise<void>>(),
  checkForRecovery: vi.fn(),
  recover: vi.fn(),
}));

vi.mock("../../services/auto-save", () => ({
  initializeAutoSave: autoSaveMocks.initialize,
  autoSaveManager: {
    start: autoSaveMocks.start,
    markDirty: autoSaveMocks.markDirty,
    forceSave: autoSaveMocks.forceSave,
    checkForRecovery: autoSaveMocks.checkForRecovery,
    recover: autoSaveMocks.recover,
  },
}));

async function createHarness() {
  const { createProjectPersistenceSlice } = await import("./persistence-slice");
  const project = createEmptyProject("Persistence test");
  const subscribeToProject = vi.fn(() => vi.fn());
  const holder: { slice?: ReturnType<typeof createProjectPersistenceSlice> } = {};
  const get = () => ({
    project,
    getFullProject: () => project,
    initializeAutoSave: holder.slice!.initializeAutoSave,
  });
  const slice = createProjectPersistenceSlice(
    vi.fn() as Parameters<typeof createProjectPersistenceSlice>[0],
    get as Parameters<typeof createProjectPersistenceSlice>[1],
    { subscribeToProject },
  );
  holder.slice = slice;
  return { project, slice, subscribeToProject };
}

describe("project persistence initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    autoSaveMocks.initialize.mockResolvedValue(undefined);
    autoSaveMocks.forceSave.mockResolvedValue(undefined);
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
  });
});
