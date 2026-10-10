import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob } from "node:buffer";
import * as core from "@reelterminal/core";
import type { Project } from "@reelterminal/core";
import { WorkspaceManager } from "./workspace-manager";
import * as mediaStorage from "./media-storage";
import { cacheCustomFontBytes, forgetCustomFontBytes } from "./custom-font-storage";
import * as renderDependencies from "./project-render-dependencies";
import { PERF_PROJECT_COUNT, perfMediaBytes, seedPerfLibrary, type PerfLibraryHandle } from "./perf-library-fixtures";

/**
 * Counts full-project clones: structuredClone calls whose argument is a bare
 * Project. Storage-driver record deserialization (fake-indexeddb clones whole
 * node/workspace rows) lands here too, but those arguments carry a nested
 * `project` key instead of a top-level `timeline`, so they are excluded —
 * they cost the same on every read path, including the optimized ones.
 */
function countProjectClones(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(([value]) => {
    if (!value || typeof value !== "object") return false;
    return "timeline" in value && "mediaLibrary" in value && !("project" in value);
  }).length;
}

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
    // Changeset 07: re-reads of an unchanged node are silent — no listener
    // wakes and no snapshot version bumps — while every read still returns
    // a freshly enriched node (asserted above via node?.project.id).
    expect(listener.mock.calls.length).toBe(0);
    expect(manager.getSnapshot().version - versionBefore).toBe(0);
    unsubscribe();
    fontSpy.mockRestore();
  });

  it("wakes subscribers when a node's enriched dependencies change", async () => {
    const { manager, library } = await seedFresh();
    const project = library.projects[0];
    const target = { projectId: project.projectId, workspaceId: project.defaultWorkspaceId };
    // A node whose project references a custom font without embedded bytes:
    // its summary starts with both missing font markers. (The seeded nodes
    // embed their faces, so they never report font dependencies.)
    const context = await manager.getWorkspaceContext(target);
    context.store.setState({
      project: {
        ...context.store.getState().project,
        textClips: [{ style: { fontFamily: "Wake Font" } }] as unknown as Project["textClips"],
      },
    });
    const saved = await manager.saveNode({ target, name: "Perf node wake" });
    expect(saved.node.missingDependencies)
      .toEqual(expect.arrayContaining(["font:Wake Font", "font-render:Wake Font"]));

    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);
    const warm = await manager.getNode(project.projectId, saved.node.id);
    // Silence on the unchanged re-read must not swallow real updates.
    expect(listener).toHaveBeenCalledTimes(0);
    expect(warm?.missingDependencies).toContain("font-render:Wake Font");

    // Registering the font bytes lets enrichment embed the face, so the next
    // enrichment clears both missing markers for the family.
    const fontBytes = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x01, 0x02, 0x03]).buffer;
    cacheCustomFontBytes("Wake Font", fontBytes);
    try {
      const changed = await manager.getNode(project.projectId, saved.node.id);
      expect(changed?.missingDependencies).not.toContain("font-render:Wake Font");
      expect(changed?.missingDependencies).not.toContain("font:Wake Font");
      expect(changed?.missingDependencies.length)
        .toBeLessThan(warm?.missingDependencies.length ?? 0);
      expect(listener).toHaveBeenCalledTimes(1);
      // And the changed summary is cached: a further re-read stays silent.
      await manager.getNode(project.projectId, saved.node.id);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      forgetCustomFontBytes("Wake Font");
    }
    unsubscribe();
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

  it("collects font dependency references without cloning projects", async () => {
    const { manager, library } = await seedFresh();
    // Drain queued workspace writes so no background structuredClone can run
    // inside the measured window.
    await manager.flushOpenWorkspaces();
    const family = library.projects[0].fontFamily;

    // Parity oracle: the changeset-06 snapshot scan the font query replaced.
    const snapshots = await manager.getDependencyProjectSnapshots();
    const expected: Array<{ projectId: string; kind: string; referenceId: string; label?: string }> = [];
    for (const snapshot of snapshots) {
      const families = new Set<string>();
      renderDependencies.collectFontFamilies(snapshot.project, families);
      renderDependencies.collectFontFamilies(snapshot.historyEntries, families);
      if (![...families].some((candidate) => candidate.toLowerCase() === family.toLowerCase())) continue;
      expected.push({
        projectId: snapshot.projectId,
        kind: snapshot.kind,
        referenceId: snapshot.referenceId,
        ...(snapshot.label ? { label: snapshot.label } : {}),
      });
    }

    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    const references = await manager.getFontDependencyReferences(family);
    const projectClones = countProjectClones(cloneSpy);
    const totalClones = cloneSpy.mock.calls.length;
    cloneSpy.mockRestore();
    console.log(
      `[perf-07][font-references] references=${references.length}` +
      ` projectClones=${projectClones} structuredCloneCalls=${totalClones}`,
    );
    // 2 nodes + 2 workspace records + 2 runtime histories reference the
    // family. The query must find all of them without cloning a single
    // project — the remaining structuredClone calls are the storage driver's
    // own record deserialization, identical for any read of these stores.
    expect(references).toHaveLength(6);
    expect(projectClones).toBe(0);
    expect(references.map((reference) => reference.kind))
      .toEqual(["node", "node", "workspace-draft", "workspace-draft", "history", "history"]);
    expect(references).toEqual(expected.map((entry) => ({ family, ...entry })));
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
      `[perf-08][rename] runtimesCreated=${runtimesOf(manager)}` +
      ` loadProjectMedia=${loadSpy.mock.calls.length} hashMediaBlob=${hashSpy.mock.calls.length}` +
      ` elapsedMs=${elapsed.toFixed(1)}`,
    );
    // Changeset 08: renaming a project with zero loaded workspaces must not
    // hydrate a single runtime or read a single media byte — the persisted
    // snapshots are renamed directly through the write queue.
    expect(runtimesOf(manager)).toBe(0);
    expect(loadSpy.mock.calls.length).toBe(0);
    expect(hashSpy.mock.calls.length).toBe(0);
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
    const metadataSpy = vi.spyOn(mediaStorage, "loadProjectMediaMetadata");
    const hashSpy = vi.spyOn(core, "hashMediaBlob");
    const start = performance.now();
    const saved = await manager.saveNode({
      target,
      name: "Perf node C measure",
      idempotencyKey: "perf-node-c-0",
    });
    const elapsed = performance.now() - start;
    // The spies wrap real (never-rejecting) implementations, so every
    // recorded result settles.
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
    const metadataResults = await Promise.all(
      (metadataSpy.mock.results as unknown as { value: Promise<mediaStorage.StoredMediaMetadataEntry[]> }[])
        .map((result) => result.value),
    );
    const metadataBlobBytes = metadataResults.reduce(
      (total, entries) => total + entries.reduce((bytes, entry) => bytes + (entry.blob?.size ?? 0), 0),
      0,
    );
    console.log(
      `[perf-09][archive-check] loadProjectMedia=${loadSpy.mock.calls.length}` +
      ` metadataReads=${metadataSpy.mock.calls.length}` +
      ` mediaRecordsMaterialized=${materializedRecords} blobBytesMaterialized=${materializedBytes}` +
      ` metadataBlobBytes=${metadataBlobBytes}` +
      ` hashMediaBlob=${hashSpy.mock.calls.length}` +
      ` missingDependencies=${JSON.stringify(saved.node.missingDependencies)}` +
      ` elapsedMs=${elapsed.toFixed(1)}`,
    );
    // Changeset 09: trusted stored hashes verify byte-free. The archive
    // check runs through loadProjectMediaMetadata once and never touches
    // loadProjectMedia, a record blob, or hashMediaBlob. Only the
    // placeholder item is missing: stored bytes match every trusted hash and
    // legacy items are not hash-checked today. (Counts must be read before
    // mockRestore resets the spies.)
    expect(saved.node.missingDependencies).toEqual([`perf-media-0-5`]);
    expect(loadSpy.mock.calls.length).toBe(0);
    expect(metadataSpy.mock.calls.length).toBe(1);
    expect(materializedRecords).toBe(0);
    expect(materializedBytes).toBe(0);
    expect(metadataBlobBytes).toBe(0);
    expect(hashSpy.mock.calls.length).toBe(0);
    loadSpy.mockRestore();
    metadataSpy.mockRestore();
    hashSpy.mockRestore();
  });

  it("still reads bytes once for controlled media without an encoded hash", async () => {
    const { manager, library } = await seedFresh();
    const project = library.projects[0];
    const target = { projectId: project.projectId, workspaceId: project.defaultWorkspaceId };
    const context = await manager.getWorkspaceContext(target);

    // A desktop controlled store holding a pre-hash-encoding file: the list
    // result knows the media but not its hash, so only the bytes can verify
    // the item's trusted hash.
    const legacyId = "perf-media-controlled-legacy-0";
    const legacyBytes = perfMediaBytes(0xc0ffee, 24 * 1024);
    const legacyHash = await core.hashMediaBytes(legacyBytes);
    const legacyMetadata = {
      duration: 0,
      width: 1920,
      height: 1080,
      frameRate: 30,
      codec: "",
      sampleRate: 0,
      channels: 0,
      fileSize: legacyBytes.byteLength,
    };
    const bridge = window as unknown as { reelterminal?: unknown };
    bridge.reelterminal = {
      platform: "desktop",
      mediaStore: {
        listAll: async () => [{
          projectId: project.projectId,
          mediaId: legacyId,
          path: `C:/m/${legacyId}.mp4`,
          sizeBytes: legacyBytes.byteLength,
        }],
        readAny: async () => legacyBytes.buffer,
      },
    };
    try {
      context.store.setState({
        project: {
          ...context.store.getState().project,
          name: "Perf Project 0 legacy measure",
          modifiedAt: Date.now(),
          mediaLibrary: {
            items: [
              ...context.store.getState().project.mediaLibrary.items,
              {
                id: legacyId,
                name: legacyId,
                type: "image" as const,
                fileHandle: null,
                blob: null,
                metadata: legacyMetadata,
                thumbnailUrl: "data:image/png;base64,AAAA",
                waveformData: null,
                contentHash: legacyHash,
              },
            ],
          },
        },
      });

      const loadSpy = vi.spyOn(mediaStorage, "loadProjectMedia");
      const metadataSpy = vi.spyOn(mediaStorage, "loadProjectMediaMetadata");
      const hashSpy = vi.spyOn(core, "hashMediaBlob");
      const start = performance.now();
      const saved = await manager.saveNode({
        target,
        name: "Perf node C legacy",
        idempotencyKey: "perf-node-c-legacy",
      });
      const elapsed = performance.now() - start;
      const metadataResults = await Promise.all(
        (metadataSpy.mock.results as unknown as { value: Promise<mediaStorage.StoredMediaMetadataEntry[]> }[])
          .map((result) => result.value),
      );
      const metadataBlobBytes = metadataResults.reduce(
        (total, entries) => total + entries.reduce((bytes, entry) => bytes + (entry.blob?.size ?? 0), 0),
        0,
      );
      console.log(
        `[perf-09][archive-controlled-legacy] loadProjectMedia=${loadSpy.mock.calls.length}` +
        ` metadataReads=${metadataSpy.mock.calls.length}` +
        ` metadataBlobBytes=${metadataBlobBytes}` +
        ` hashMediaBlob=${hashSpy.mock.calls.length}` +
        ` missingDependencies=${JSON.stringify(saved.node.missingDependencies)}` +
        ` elapsedMs=${elapsed.toFixed(1)}`,
      );
      // The controlled bytes hash to the item's trusted hash, so only the
      // placeholder stays missing; exactly the legacy bytes were read and
      // hashed once, and the trusted items still contributed nothing.
      expect(saved.node.missingDependencies).toEqual([`perf-media-0-5`]);
      expect(loadSpy.mock.calls.length).toBe(0);
      expect(metadataSpy.mock.calls.length).toBe(1);
      expect(metadataBlobBytes).toBe(24 * 1024);
      expect(hashSpy.mock.calls.length).toBe(1);
      loadSpy.mockRestore();
      metadataSpy.mockRestore();
      hashSpy.mockRestore();
    } finally {
      delete bridge.reelterminal;
    }
  });
});

