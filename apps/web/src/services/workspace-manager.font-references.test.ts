import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { Project } from "@reelterminal/core";
import { createEmptyProject } from "../stores/project/project-helpers";
import { collectFontFamilies } from "./project-render-dependencies";
import { WorkspaceManager, type FontDependencyReference } from "./workspace-manager";

const BASE_TIMESTAMP = 1_700_000_000_000;
const PROJECT_ID = "font-parity-project";

/**
 * Changeset-07 regression: `getFontDependencyReferences` must collect exactly
 * what the getDependencyProjectSnapshots scan collected — across saved nodes,
 * workspace drafts, recovery drafts, retained task inputs and live runtime
 * state including undo/redo history — without structuredClone-ing any project.
 * The oracle below is the snapshot-scan seam, kept verbatim.
 */
describe("WorkspaceManager font dependency references", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fontParityProject(): Project {
    const base = createEmptyProject("Font Parity");
    return {
      ...base,
      id: PROJECT_ID,
      name: "Font Parity",
      createdAt: BASE_TIMESTAMP,
      modifiedAt: BASE_TIMESTAMP,
      textClips: [{ style: { fontFamily: "Shared Font" } }] as unknown as Project["textClips"],
    };
  }

  /** Old seam: full-library snapshot scan + family collection. */
  async function snapshotScanReferences(
    manager: WorkspaceManager,
    family: string,
  ): Promise<FontDependencyReference[]> {
    const wanted = family.trim().toLowerCase();
    if (!wanted) return [];
    const snapshots = await manager.getDependencyProjectSnapshots();
    const references: FontDependencyReference[] = [];
    for (const snapshot of snapshots) {
      const families = new Set<string>();
      collectFontFamilies(snapshot.project, families);
      collectFontFamilies(snapshot.historyEntries, families);
      if (![...families].some((candidate) => candidate.toLowerCase() === wanted)) continue;
      references.push({
        family,
        projectId: snapshot.projectId,
        kind: snapshot.kind,
        referenceId: snapshot.referenceId,
        ...(snapshot.label ? { label: snapshot.label } : {}),
      });
    }
    return references;
  }

  /** Seed a node, workspace draft, recovery draft, task input and a runtime
   * whose live project moved to another family while undo/redo history keeps
   * the original families alive only inside action-history entries. */
  async function seedReferenceKinds(): Promise<WorkspaceManager> {
    const manager = new WorkspaceManager();
    await manager.initialize();
    const created = await manager.createProject(fontParityProject());
    const target = { projectId: PROJECT_ID, workspaceId: created.defaultWorkspaceId };
    await manager.saveNode({ target, name: "Font parity node" });
    await manager.saveDraft(target);
    const context = await manager.getWorkspaceContext(target);
    await manager.retainTaskInputs({
      jobId: "font-parity-job",
      projectId: PROJECT_ID,
      workspaceId: created.defaultWorkspaceId,
      sourceRevision: context.revision,
      inputProject: context.store.getState().getFullProject(),
    });
    context.store.setState({
      project: {
        ...context.store.getState().project,
        textClips: [{ style: { fontFamily: "Current Font" } }] as unknown as Project["textClips"],
        modifiedAt: BASE_TIMESTAMP + 1,
      },
    });
    // Runtime-only history seeding: an undone-style entry on the undo stack
    // referencing "Shared Font", and one moved to the redo stack referencing
    // "Redo Font" — the same families the removed clip stacks used to hold.
    const history = context.store.getState().actionExecutor.getHistory();
    history.push(
      {
        type: "text/update",
        id: "font-parity-undo-action",
        timestamp: 1,
        params: {
          clipId: "font-parity-undo-clip",
          updates: { style: { fontFamily: "Shared Font" } },
        },
      },
      {
        type: "text/update",
        id: "font-parity-undo-action-inverse",
        timestamp: 1,
        params: { clipId: "font-parity-undo-clip", updates: {} },
      },
    );
    history.push(
      {
        type: "text/update",
        id: "font-parity-redo-action",
        timestamp: 2,
        params: {
          clipId: "font-parity-redo-clip",
          updates: { style: { fontFamily: "Redo Font" } },
        },
      },
      {
        type: "text/update",
        id: "font-parity-redo-action-inverse",
        timestamp: 2,
        params: { clipId: "font-parity-redo-clip", updates: {} },
      },
    );
    history.undo();
    await manager.flushOpenWorkspaces();
    return manager;
  }

  it("matches the snapshot scan across every reference kind", async () => {
    const manager = await seedReferenceKinds();

    for (const family of ["Shared Font", "Current Font", "Redo Font", "Missing Font"]) {
      expect(await manager.getFontDependencyReferences(family))
        .toEqual(await snapshotScanReferences(manager, family));
    }

    // Kind coverage: the node/draft/task still hold "Shared Font", while the
    // runtime reaches it only through the undo history ("history" kind).
    expect((await manager.getFontDependencyReferences("Shared Font")).map((r) => r.kind))
      .toEqual(["node", "recovery-draft", "task", "history"]);
    // "Current Font" lives in the live runtime project (scanned both as the
    // workspace record and as the "history" snapshot's embedded project).
    expect((await manager.getFontDependencyReferences("Current Font")).map((r) => r.kind))
      .toEqual(["workspace-draft", "history"]);
    // "Redo Font" exists only inside a redo history entry.
    expect((await manager.getFontDependencyReferences("Redo Font")).map((r) => r.kind))
      .toEqual(["history"]);
    expect(await manager.getFontDependencyReferences("Missing Font")).toEqual([]);
  });

  it("matches case- and whitespace-insensitive matching, echoing the query as family", async () => {
    const manager = await seedReferenceKinds();
    const relaxed = await manager.getFontDependencyReferences("  shared font  ");
    expect(relaxed).toEqual(await snapshotScanReferences(manager, "  shared font  "));
    expect(relaxed.every((reference) => reference.family === "  shared font  ")).toBe(true);
    expect(await manager.getFontDependencyReferences("   ")).toEqual([]);
  });

  it("collects references without a single full-project structuredClone", async () => {
    const manager = await seedReferenceKinds();
    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    const references = await manager.getFontDependencyReferences("Shared Font");
    // fake-indexeddb clones whole stored rows during getAll; count only bare
    // Project arguments (top-level `timeline`, no nested `project` row key),
    // which is what the replaced snapshot scan produced 4+ times here.
    const projectClones = cloneSpy.mock.calls.filter(([value]) => {
      if (!value || typeof value !== "object") return false;
      return "timeline" in value && "mediaLibrary" in value && !("project" in value);
    }).length;
    cloneSpy.mockRestore();
    expect(references).toHaveLength(4);
    expect(projectClones).toBe(0);
  });
});
