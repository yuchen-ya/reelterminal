import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@openreel/core";
import { AutoSaveManager } from "./auto-save";
import { createEmptyProject } from "../stores/project/project-helpers";

const project = (name: string): Project => ({
  ...createEmptyProject(name),
  id: "project-1",
});

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

type TestableManager = {
  save(value: Project, snapshot?: string): Promise<void>;
  saveRecord(record: unknown): Promise<void>;
  openDatabase(): Promise<IDBDatabase>;
  db: IDBDatabase | null;
};

const internals = (manager: AutoSaveManager): TestableManager =>
  manager as unknown as TestableManager;

describe("AutoSaveManager", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("saves the snapshot supplied with the dirty notification", async () => {
    vi.useFakeTimers();
    const manager = new AutoSaveManager({ debounceTime: 10, interval: 30_000 });
    const save = vi.fn().mockResolvedValue(undefined);
    internals(manager).save = save;

    manager.start(() => project("Initial"));
    manager.markDirty(project("Latest text edit"));
    await vi.advanceTimersByTimeAsync(10);

    expect(save.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ name: "Latest text edit" }),
    );
    manager.stop();
  });

  it("caps continuous editing at the configured maximum wait", async () => {
    vi.useFakeTimers();
    const manager = new AutoSaveManager({ debounceTime: 20, interval: 100 });
    const save = vi.fn().mockResolvedValue(undefined);
    internals(manager).save = save;
    let current = project("0");
    manager.start(() => current);

    manager.markDirty(current);
    for (let elapsed = 10; elapsed < 100; elapsed += 10) {
      await vi.advanceTimersByTimeAsync(10);
      current = project(String(elapsed));
      manager.markDirty(current);
    }
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ name: "90" }));
    manager.stop();
  });

  it("applies enablement changes immediately while retaining dirty state", async () => {
    vi.useFakeTimers();
    const manager = new AutoSaveManager({
      debounceTime: 10,
      interval: 100,
      enabled: false,
    });
    const save = vi.fn().mockResolvedValue(undefined);
    internals(manager).save = save;
    const edited = project("Edited while disabled");
    manager.start(() => edited);
    manager.markDirty(edited);

    await vi.advanceTimersByTimeAsync(200);
    expect(save).not.toHaveBeenCalled();
    expect(manager.hasUnsavedChanges(edited)).toBe(true);

    manager.updateConfig({ enabled: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(save).toHaveBeenCalledOnce();
    expect(manager.hasUnsavedChanges(edited)).toBe(false);
    manager.stop();
  });

  it("propagates a forced-save failure and keeps the project dirty", async () => {
    const manager = new AutoSaveManager();
    const failure = new Error("disk unavailable");
    internals(manager).save = vi.fn().mockRejectedValue(failure);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const errorListener = vi.fn();
    manager.on("error", errorListener);
    const edited = project("Unsaved");

    await expect(manager.forceSave(edited)).rejects.toBe(failure);

    expect(manager.hasUnsavedChanges(edited)).toBe(true);
    expect(errorListener).toHaveBeenCalledWith(
      expect.objectContaining({ error: failure, message: "Save failed" }),
    );
    manager.stop();
  });

  it("does not clear edits made while an older snapshot is saving", async () => {
    const manager = new AutoSaveManager();
    const firstWrite = deferred<void>();
    const secondWrite = deferred<void>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    internals(manager).save = save;
    const savedListener = vi.fn();
    manager.on("saved", savedListener);
    const first = project("First edit");
    const second = project("Second edit");

    const flush = manager.forceSave(first);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    manager.markDirty(second);
    firstWrite.resolve();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));

    expect(manager.hasUnsavedChanges(second)).toBe(true);
    expect(manager.getStatus()).toBe("saving");
    expect(savedListener).not.toHaveBeenCalled();
    secondWrite.resolve();
    await expect(flush).resolves.toBeUndefined();
    expect(save.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ name: "Second edit" }),
    );
    expect(manager.hasUnsavedChanges(second)).toBe(false);
    expect(manager.getStatus()).toBe("saved");
    expect(savedListener).toHaveBeenCalledOnce();
  });

  it("persists each explicit project when force saves are queued together", async () => {
    const manager = new AutoSaveManager();
    const save = vi.fn().mockResolvedValue(undefined);
    internals(manager).save = save;
    const first = project("Project A");
    const second = { ...project("Project B"), id: "project-2" };

    const firstFlush = manager.forceSave(first);
    const secondFlush = manager.forceSave(second);
    await Promise.all([firstFlush, secondFlush]);

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls.map(([saved]) => [saved.id, saved.name])).toEqual([
      ["project-1", "Project A"],
      ["project-2", "Project B"],
    ]);
  });

  it("does not let an older queued force save overwrite a newer drained edit", async () => {
    const manager = new AutoSaveManager();
    const persisted: string[] = [];
    internals(manager).save = vi.fn(async (_project, snapshot) => {
      persisted.push(JSON.parse(snapshot ?? "{}").name);
    });
    const version = (value: number): Project => ({
      ...project(String(value)),
      id: "same-project",
      modifiedAt: value,
    });

    const first = manager.forceSave(version(1));
    const second = manager.forceSave(version(2));
    manager.markDirty(version(3));
    await Promise.all([first, second]);

    expect(persisted).toEqual(["1", "3"]);
    expect(manager.hasUnsavedChanges(version(3))).toBe(false);
  });

  it("keeps revision supersession scoped to each project", async () => {
    const manager = new AutoSaveManager();
    const persisted: Array<[string, string]> = [];
    internals(manager).save = vi.fn(async (savedProject, snapshot) => {
      persisted.push([
        savedProject.id,
        JSON.parse(snapshot ?? "{}").name,
      ]);
    });
    const a1 = { ...project("A1"), id: "project-a", modifiedAt: 1 };
    const b2 = { ...project("B2"), id: "project-b", modifiedAt: 2 };
    const a3 = { ...project("A3"), id: "project-a", modifiedAt: 3 };

    const firstProject = manager.forceSave(a1);
    const secondProject = manager.forceSave(b2);
    manager.markDirty(a3);
    await Promise.all([firstProject, secondProject]);

    expect(persisted).toEqual([
      ["project-a", "A1"],
      ["project-a", "A3"],
      ["project-b", "B2"],
    ]);
    expect(manager.hasUnsavedChanges(a3)).toBe(false);
    expect(manager.hasUnsavedChanges(b2)).toBe(false);
  });

  it("captures forced-save data before the caller can mutate its object", async () => {
    const manager = new AutoSaveManager();
    const save = vi.fn().mockResolvedValue(undefined);
    internals(manager).save = save;
    const mutable = project("Captured name");

    const flush = manager.forceSave(mutable);
    Reflect.set(mutable, "name", "Mutated later");
    await flush;

    expect(save.mock.calls[0]?.[0].name).toBe("Captured name");
    expect(JSON.parse(save.mock.calls[0]?.[1] ?? "{}").name).toBe(
      "Captured name",
    );
  });

  it("does not restart automatic scheduling after stop during a write", async () => {
    vi.useFakeTimers();
    const manager = new AutoSaveManager({ debounceTime: 5, interval: 20 });
    const write = deferred<void>();
    const save = vi.fn(() => write.promise);
    internals(manager).save = save;
    const first = project("First");
    const second = project("Second");
    manager.start(() => second);
    manager.markDirty(first);
    await vi.advanceTimersByTimeAsync(5);
    expect(save).toHaveBeenCalledOnce();

    manager.markDirty(second);
    manager.stop();
    write.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);

    expect(save).toHaveBeenCalledOnce();
    expect(manager.hasUnsavedChanges(second)).toBe(true);
  });

  it("waits for the IndexedDB transaction commit, not request success", async () => {
    const manager = new AutoSaveManager();
    const request: Partial<IDBRequest> = { error: null };
    const tx: Partial<IDBTransaction> = {
      error: null,
      objectStore: vi.fn(() => ({ put: vi.fn(() => request) }) as never),
    };
    internals(manager).db = {
      transaction: vi.fn(() => tx),
    } as unknown as IDBDatabase;

    let committed = false;
    const write = internals(manager)
      .saveRecord({})
      .then(() => {
        committed = true;
      });
    const onRequestSuccess = request.onsuccess as
      | ((event: Event) => unknown)
      | null
      | undefined;
    onRequestSuccess?.({} as Event);
    await Promise.resolve();
    expect(committed).toBe(false);

    const onTransactionComplete = tx.oncomplete as
      | ((event: Event) => unknown)
      | null
      | undefined;
    onTransactionComplete?.({} as Event);
    await write;
    expect(committed).toBe(true);
  });

  it("rejects when IndexedDB aborts after accepting the put request", async () => {
    const manager = new AutoSaveManager();
    const request: Partial<IDBRequest> = { error: null };
    const tx: Partial<IDBTransaction> = {
      error: null,
      objectStore: vi.fn(() => ({ put: vi.fn(() => request) }) as never),
    };
    internals(manager).db = {
      transaction: vi.fn(() => tx),
    } as unknown as IDBDatabase;

    const write = internals(manager).saveRecord({});
    const onRequestSuccess = request.onsuccess as
      | ((event: Event) => unknown)
      | null
      | undefined;
    const onTransactionAbort = tx.onabort as
      | ((event: Event) => unknown)
      | null
      | undefined;
    onRequestSuccess?.({} as Event);
    onTransactionAbort?.({} as Event);
    await expect(write).rejects.toThrow("transaction aborted");
  });

  it("allows initialization to retry after an open failure", async () => {
    const manager = new AutoSaveManager();
    const failure = new Error("open failed");
    const db = { close: vi.fn(), onversionchange: null } as unknown as IDBDatabase;
    internals(manager).openDatabase = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(db);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(manager.initialize()).rejects.toBe(failure);
    await expect(manager.initialize()).resolves.toBeUndefined();
    expect(internals(manager).openDatabase).toHaveBeenCalledTimes(2);
  });
});
