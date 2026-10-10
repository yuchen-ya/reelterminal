import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob } from "node:buffer";
import * as core from "@reelterminal/core";
import { WorkspaceManager } from "./workspace-manager";
import * as mediaStorage from "./media-storage";
import * as renderDependencies from "./project-render-dependencies";
import { PERF_PROJECT_COUNT, seedPerfLibrary, type PerfLibraryHandle } from "./perf-library-fixtures";

/**
 * Phase-4 performance baselines. These tests run against the fixed dataset
 * from perf-library-fixtures and only assert behavior invariants that hold
 * before AND after changesets 07–09, so the suite stays green throughout
 * the work. Each scenario logs the expensive-operation counts (listener
 * wakes, full-library clones, media blob materialization, runtime
 * creation); the changesets' own regression tests hard-assert the reduced
 * counts, and the numbers logged here are the recorded baseline.
 */
describe("WorkspaceManager perf baselines", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    // jsdom's Blob cannot be hashed (no arrayBuffer) and is destroyed by the
    // structured-clone fake-indexeddb applies on every put/get. Node's Blob
    // survives both, and stubbing it as the global keeps every `instanceof
    // Blob` check in product code self-consistent.
    vi.stubGlobal("Blob", NodeBlob);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function seedFresh(): Promise<{ manager: WorkspaceManager; library: PerfLibraryHandle }> {
    const manager = new WorkspaceManager();
    await manager.initialize();
    return { manager, library: await seedPerfLibrary(manager) };
  }

  it("seeds the fixed library deterministically", async () => {
    const { manager, library } = await seedFresh();
    expect(library.projects).toHaveLength(PERF_PROJECT_COUNT);
    const projects = await manager.listProjects();
    expect(projects.map((project) => project.id)).toEqual(
      library.projects.map((entry) => entry.projectId),
    );
    for (const entry of library.projects) {
      expect(entry.nodeIds).toHaveLength(2);
      expect(entry.mediaIds).toHaveLength(5);
      const nodes = await manager.listNodes(entry.projectId);
      expect(nodes.map((node) => node.id)).toEqual([...entry.nodeIds]);
    }
  });

  it("measures repeated getNode reads of an unchanged node", async () => {
    const { manager, library } = await seedFresh();
    const project = library.projects[0];
    const warm = await manager.getNode(project.projectId, project.nodeIds[0]);
    expect(warm?.id).toBe(project.nodeIds[0]);

    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);
    const fontSpy = vi.spyOn(renderDependencies, "prepareProjectRenderFonts");
    const versionBefore = manager.getSnapshot().version;
    const reads = 5;
    const start = performance.now();
    for (let i = 0; i < reads; i++) {
      const node = await manager.getNode(project.projectId, project.nodeIds[0]);
      expect(node?.id).toBe(project.nodeIds[0]);
      expect(node?.project.id).toBe(project.projectId);
    }
    const elapsed = performance.now() - start;
    console.log(
      `[perf-baseline][getNode] reads=${reads} listenerWakes=${listener.mock.calls.length}` +
      ` versionDelta=${manager.getSnapshot().version - versionBefore}` +
      ` prepareProjectRenderFonts=${fontSpy.mock.calls.length} elapsedMs=${elapsed.toFixed(1)}`,
    );
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(0);
    unsubscribe();
    fontSpy.mockRestore();
  });

  it("measures the font dependency snapshot query over the whole library", async () => {
    const { manager } = await seedFresh();
    const cloneSpy = "structuredClone" in globalThis
      ? vi.spyOn(globalThis, "structuredClone")
      : null;
    const start = performance.now();
    const snapshots = await manager.getDependencyProjectSnapshots();
    const elapsed = performance.now() - start;
    const byKind = snapshots.reduce<Record<string, number>>((counts, snapshot) => {
      counts[snapshot.kind] = (counts[snapshot.kind] ?? 0) + 1;
      return counts;
    }, {});
    console.log(
      `[perf-baseline][font-snapshots] snapshots=${snapshots.length} kinds=${JSON.stringify(byKind)}` +
      ` structuredCloneCalls=${cloneSpy ? cloneSpy.mock.calls.length : "unavailable"}` +
      ` elapsedMs=${elapsed.toFixed(1)}`,
    );
    // 2 immutable nodes + 2 workspace records + 2 live runtime histories per
    // project (both seeded workspaces hold a runtime); no drafts or task
    // inputs exist in this seeded state.
    expect(snapshots).toHaveLength(PERF_PROJECT_COUNT * 6);
    cloneSpy?.mockRestore();
  });

  it("measures renaming a project whose workspaces are all unloaded", async () => {
    const seeded = await seedFresh();
    const project = seeded.library.projects[0];
    const manager = new WorkspaceManager();
    await manager.initialize();
    const runtimesOf = (instance: WorkspaceManager): number =>
      (instance as unknown as { runtimes: Map<string, unknown> }).runtimes.size;
    expect(runtimesOf(manager)).toBe(0);

    const loadSpy = vi.spyOn(mediaStorage, "loadProjectMedia");
    const hashSpy = vi.spyOn(core, "hashMediaBlob");
    const start = performance.now();
    await manager.renameLibraryProject(project.projectId, "Perf Project 0 renamed");
    const elapsed = performance.now() - start;
    console.log(
      `[perf-baseline][rename] runtimesCreated=${runtimesOf(manager)}` +
      ` loadProjectMedia=${loadSpy.mock.calls.length} hashMediaBlob=${hashSpy.mock.calls.length}` +
      ` elapsedMs=${elapsed.toFixed(1)}`,
    );
    loadSpy.mockRestore();
    hashSpy.mockRestore();

    const visible = (await manager.listProjects()).find((entry) => entry.id === project.projectId);
    expect(visible?.name).toBe("Perf Project 0 renamed");
    const reopened = new WorkspaceManager();
    await reopened.initialize();
    const persisted = (await reopened.listProjects()).find((entry) => entry.id === project.projectId);
    expect(persisted?.name).toBe("Perf Project 0 renamed");
    const context = await reopened.getWorkspaceContext({
      projectId: project.projectId,
      workspaceId: project.defaultWorkspaceId,
    });
    expect(context.store.getState().project.name).toBe("Perf Project 0 renamed");
    const extraContext = await reopened.getWorkspaceContext({
      projectId: project.projectId,
      workspaceId: project.extraWorkspaceId,
    });
    expect(extraContext.store.getState().project.name).toBe("Perf Project 0 renamed");
  });

  it("measures the archive-time media check on a second saveNode", async () => {
    const { manager, library } = await seedFresh();
    const project = library.projects[0];
    const target = { projectId: project.projectId, workspaceId: project.defaultWorkspaceId };
    // Load the runtime and make a substantive edit before measuring: an
    // unchanged project dedups to the base node (skipping the archive
    // check), and pre-loading isolates the numbers from first-time
    // hydration.
    const context = await manager.getWorkspaceContext(target);
    context.store.setState({
      project: {
        ...context.store.getState().project,
        name: "Perf Project 0 measure",
        modifiedAt: Date.now(),
      },
    });

    const loadSpy = vi.spyOn(mediaStorage, "loadProjectMedia");
    const hashSpy = vi.spyOn(core, "hashMediaBlob");
    const start = performance.now();
    const saved = await manager.saveNode({
      target,
      name: "Perf node C measure",
      idempotencyKey: "perf-node-c-0",
    });
    const elapsed = performance.now() - start;
    // The spy wraps the real (never-rejecting) implementation, so every
    // recorded result settles to a MediaRecord[].
    const loadResults = await Promise.all(
      (loadSpy.mock.results as unknown as { value: Promise<core.MediaRecord[]> }[])
        .map((result) => result.value),
    );
    const materializedRecords = loadResults.reduce((total, records) => total + records.length, 0);
    const materializedBytes = loadResults.reduce(
      (total, records) => total + records.reduce(
        (bytes: number, record) => bytes + (record.blob?.size ?? 0),
        0,
      ),
      0,
    );
    console.log(
      `[perf-baseline][archive-check] loadProjectMedia=${loadSpy.mock.calls.length}` +
      ` mediaRecordsMaterialized=${materializedRecords} blobBytesMaterialized=${materializedBytes}` +
      ` hashMediaBlob=${hashSpy.mock.calls.length}` +
      ` missingDependencies=${JSON.stringify(saved.node.missingDependencies)}` +
      ` elapsedMs=${elapsed.toFixed(1)}`,
    );
    loadSpy.mockRestore();
    hashSpy.mockRestore();
    // Only the placeholder item is missing: stored bytes match every
    // trusted hash and legacy items are not hash-checked today.
    expect(saved.node.missingDependencies).toEqual([`perf-media-0-5`]);
  });
});
