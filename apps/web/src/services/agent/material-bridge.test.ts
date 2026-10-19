/**
 * Renderer-side material bridge contract: verb routing, param coercion,
 * error envelopes, and the attach idempotency ledger. Uses the in-memory
 * MaterialStorage fake; the canonical service logic itself is covered by
 * library-service.test.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { planMaterialStorageCommit, type MaterialStorage, type MaterialStorageCommit, type MaterialStorageSnapshot } from "../material-library/storage";
import {
  MaterialLibraryService,
  setMaterialLibraryServiceForTests,
} from "../material-library/library-service";
import { handleMaterialLibraryRequest } from "./material-bridge";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { workspaceManager, WorkspaceManagerError, type WorkspaceTarget } from "../workspace-manager";
import { currentProjectEpoch, type ProjectGuard } from "./project-guard";

const { mockSaveMediaBlob, mockImportFile, mockWithMediaReferenceWrite } = vi.hoisted(() => ({
  mockSaveMediaBlob: vi.fn(async () => ({ contentHash: "test-content-hash" })),
  mockImportFile: vi.fn(),
  mockWithMediaReferenceWrite: vi.fn(async (operation: () => unknown) => operation()),
}));

vi.mock("../../services/media-storage", () => ({
  saveMediaBlob: mockSaveMediaBlob,
  deleteMediaBlob: vi.fn(async () => undefined),
  loadProjectMedia: vi.fn(async () => []),
  loadFileHandle: vi.fn(async () => null),
  loadDirectoryHandle: vi.fn(async () => null),
  withMediaReferenceWrite: mockWithMediaReferenceWrite,
}));

vi.mock("../../bridges/media-bridge", () => ({
  getMediaBridge: vi.fn(() => ({
    isInitialized: vi.fn(() => true),
    importFile: mockImportFile,
  })),
  initializeMediaBridge: vi.fn(async () => undefined),
}));

class MemoryStorage implements MaterialStorage {
  readonly materials = new Map<string, unknown>();
  readonly journal = new Map<string, unknown>();
  readonly blobs = new Map<string, Blob>();

  async loadSnapshot(): Promise<MaterialStorageSnapshot> {
    return { materials: await this.loadAllMaterials(), journal: await this.loadJournal() };
  }

  async loadAllMaterials(): Promise<unknown[]> {
    return [...this.materials.values()];
  }
  async loadJournal(): Promise<unknown[]> {
    return [...this.journal.values()];
  }
  async loadBlob(id: string): Promise<Blob | null> {
    return this.blobs.get(id) ?? null;
  }
  async commit(request: MaterialStorageCommit): Promise<MaterialStorageSnapshot> {
    const change = planMaterialStorageCommit(await this.loadSnapshot(), request).change;
    for (const record of change.materialUpserts ?? []) {
      this.materials.set(record.id, JSON.parse(JSON.stringify(record)));
    }
    for (const id of change.materialDeletes ?? []) this.materials.delete(id);
    for (const put of change.blobPuts ?? []) this.blobs.set(put.id, put.blob);
    for (const id of change.blobDeletes ?? []) this.blobs.delete(id);
    for (const entry of change.journalUpserts ?? []) {
      this.journal.set(entry.id, JSON.parse(JSON.stringify(entry)));
    }
    for (const id of change.journalDeletes ?? []) this.journal.delete(id);
    return this.loadSnapshot();
  }
}

const NOW = "2026-09-08T10:00:00.000Z";

let activeTarget: WorkspaceTarget;

async function openManagedProject(name: string): Promise<WorkspaceTarget> {
  const created = await workspaceManager.createProject(createEmptyProject(name));
  const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
  await workspaceManager.switchView(target);
  activeTarget = target;
  return target;
}

async function targetRequest(target = activeTarget, expectForeground = false): Promise<{
  guard: ProjectGuard;
  expectedRevision: number;
}> {
  const context = await workspaceManager.getWorkspaceContext(target);
  return {
    guard: {
      targetProjectId: target.projectId,
      targetWorkspaceId: target.workspaceId,
      targetWorkspaceInstanceId: context.instanceId,
      ...(expectForeground ? {
        expectedProjectId: target.projectId,
        expectedProjectEpoch: currentProjectEpoch(),
      } : {}),
    },
    expectedRevision: context.revision,
  };
}

beforeAll(() => {
  globalThis.indexedDB = new IDBFactory();
});

beforeEach(async () => {
  await openManagedProject("Material bridge test");
});

afterEach(() => {
  // Manager spies must never leak a queued once-implementation into the
  // next test's real write path.
  vi.restoreAllMocks();
});

describe("handleMaterialLibraryRequest", () => {
  let service: MaterialLibraryService;

  beforeEach(() => {
    service = new MaterialLibraryService(new MemoryStorage());
    setMaterialLibraryServiceForTests(service);
  });

  it("routes list with defaults and filters", async () => {
    await service.create(
      { kind: "link", url: "https://example.com/a", nowIso: NOW },
      "user",
    );
    const reply = await handleMaterialLibraryRequest({
      verb: "list",
      params: { kind: "link", query: "example" },
    });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      const value = reply.result as { total: number; items: unknown[] };
      expect(value.total).toBe(1);
    }
  });

  it("creates agent entries and returns the journal entry id", async () => {
    const reply = await handleMaterialLibraryRequest({
      verb: "create",
      params: {
        kind: "method",
        prompt: "Assemble highlights",
        skillName: "highlight-reel",
        tags: ["workflow"],
      },
    });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      const value = reply.result as {
        material: { updatedBy: string; source: { addedBy: string } };
        journalEntryId: string;
      };
      expect(value.material.updatedBy).toBe("agent");
      expect(value.material.source.addedBy).toBe("agent");
      expect(value.journalEntryId).toBeTruthy();
    }
  });

  it("rejects invalid verbs and missing ids with structured errors", async () => {
    const unknown = await handleMaterialLibraryRequest({ verb: "explode" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("INVALID_PARAMS");

    const missingId = await handleMaterialLibraryRequest({
      verb: "get",
      params: {},
    });
    expect(missingId.ok).toBe(false);
    if (!missingId.ok) expect(missingId.error.code).toBe("INVALID_PARAMS");

    const notFound = await handleMaterialLibraryRequest({
      verb: "get",
      params: { id: "mat_none" },
    });
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.error.code).toBe("NOT_FOUND");
  });

  it("batchUpdate maps item fields into patches and is all-or-nothing", async () => {
    const created = await service.create(
      { kind: "link", url: "https://example.com/x", nowIso: NOW },
      "user",
    );
    if (!created.ok) throw new Error(created.message);
    const reply = await handleMaterialLibraryRequest({
      verb: "batchUpdate",
      params: {
        updates: [
          {
            id: created.value.material.id,
            aiSummary: "agent summary",
            tags: ["tagged"],
            organizeStatus: "organized",
          },
          { id: "mat_missing", tags: ["x"] },
        ],
      },
    });
    expect(reply.ok).toBe(false); // second item missing ⇒ whole batch rejected
    if (!reply.ok) {
      expect(reply.error.code).toBe("INVALID_PARAMS");
      const details = reply.error.details as { items: Array<{ id: string; code: string }> };
      expect(details.items[0].code).toBe("NOT_FOUND");
    }
    const record = await service.get(created.value.material.id);
    if (record.ok) {
      expect(record.value.aiSummary).toBe("");
    }

    const okReply = await handleMaterialLibraryRequest({
      verb: "batchUpdate",
      params: {
        updates: [
          {
            id: created.value.material.id,
            aiSummary: "agent summary",
            tags: ["tagged"],
            organizeStatus: "organized",
          },
        ],
      },
    });
    expect(okReply.ok).toBe(true);
  });

  it("undo routes to the library journal", async () => {
    const created = await service.create(
      { kind: "link", url: "https://example.com/y", nowIso: NOW },
      "user",
    );
    if (!created.ok) throw new Error(created.message);
    await service.update(
      created.value.material.id,
      { aiSummary: "changed" },
      "agent",
    );
    const reply = await handleMaterialLibraryRequest({
      verb: "undo",
      params: {},
    });
    expect(reply).toMatchObject({ ok: true });
    const record = await service.get(created.value.material.id);
    if (record.ok) expect(record.value.aiSummary).toBe("");
  });

  it("attach requires a materialId and reports typed failures", async () => {
    const reply = await handleMaterialLibraryRequest({
      verb: "attach",
      params: {},
    });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("INVALID_PARAMS");

    const target = await targetRequest();
    const notFound = await handleMaterialLibraryRequest({
      guard: target.guard,
      verb: "attach",
      params: { materialId: "mat_none", expectedRevision: target.expectedRevision },
    });
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.error.code).toBe("NOT_FOUND");
  });

  it("dispatches a library-changed window event after mutations", async () => {
    const listener = vi.fn();
    window.addEventListener("reelterminal:material-library-changed", listener);
    await handleMaterialLibraryRequest({
      verb: "create",
      params: { kind: "link", url: "https://example.com/evt" },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    // Reads never fire it.
    await handleMaterialLibraryRequest({ verb: "list", params: {} });
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("reelterminal:material-library-changed", listener);
  });

  it("buckets the attach ledger per project so a key replays only in its own project", async () => {
    mockImportFile.mockImplementation(async (file: File) => ({
      success: true,
      media: {
        blob: file,
        thumbnails: [],
        waveformData: null,
        metadata: {
          duration: 5,
          width: 320,
          height: 180,
          frameRate: 30,
          codec: "h264",
          sampleRate: 0,
          channels: 0,
          hasVideo: true,
          hasAudio: false,
        },
      },
    }));
    const created = await service.create(
      {
        kind: "media",
        mediaType: "video",
        fileRef: { type: "blob", fileName: "attach.mp4" },
        blob: new Blob(["attach-bytes"], { type: "video/mp4" }),
        metadata: { durationSec: 5 },
        nowIso: NOW,
      },
      "user",
    );
    if (!created.ok) throw new Error(created.message);
    const materialId = created.value.material.id;

    // Project A: the first attach commits, and an in-project retry replays.
    const projectA = await openManagedProject("Ledger A");
    const projectAId = projectA.projectId;
    const projectARequest = await targetRequest(projectA);
    const first = await handleMaterialLibraryRequest({
      guard: projectARequest.guard,
      verb: "attach",
      params: { materialId, idempotencyKey: "attach-k1", expectedRevision: projectARequest.expectedRevision },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    expect(
      (first.result as { projectId: string }).projectId,
    ).toBe(projectAId);

    const replay = await handleMaterialLibraryRequest({
      guard: projectARequest.guard,
      verb: "attach",
      params: { materialId, idempotencyKey: "attach-k1", expectedRevision: projectARequest.expectedRevision },
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error.message);
    expect((replay.result as { replayed?: boolean }).replayed).toBe(true);

    // Switch to project B: the same key must NOT replay project A's commit —
    // the agent would otherwise read a successful answer about the wrong
    // project.
    const projectB = await openManagedProject("Ledger B");
    const projectBId = projectB.projectId;
    const projectBRequest = await targetRequest(projectB);
    const other = await handleMaterialLibraryRequest({
      guard: projectBRequest.guard,
      verb: "attach",
      params: { materialId, idempotencyKey: "attach-k1", expectedRevision: projectBRequest.expectedRevision },
    });
    expect(other.ok).toBe(true);
    if (!other.ok) throw new Error(other.error.message);
    const value = other.result as {
      projectId: string;
      projectName: string;
      replayed?: boolean;
    };
    expect(value.replayed).toBeUndefined();
    expect(value.projectId).toBe(projectBId);
    expect(value.projectName).toBe("Ledger B");
    expect(mockImportFile).toHaveBeenCalledTimes(2); // once per project, no replay
  });

  it("classifies attach conflicts by code even when the message text is mutated", async () => {
    const target = await targetRequest();
    vi.spyOn(workspaceManager, "withWorkspaceWrite").mockRejectedValueOnce(
      new WorkspaceManagerError(
        "CONFLICT",
        "the attach ledge collapsed for an unrelated reason",
        { expected: 3, current: 4 },
      ),
    );
    const conflict = await handleMaterialLibraryRequest({
      guard: target.guard,
      verb: "attach",
      params: {
        materialId: "mat_any",
        expectedRevision: target.expectedRevision,
        idempotencyKey: "attach-coded-1",
      },
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: {
        code: "CONFLICT",
        message: "Workspace material attach conflict: the attach ledge collapsed for an unrelated reason",
      },
    });
    // This reply never carried a details field; none is forced on it.
    if (!conflict.ok) expect(conflict.error.details).toBeUndefined();
  });

  it("maps its own runtime-changed attach guard to CONFLICT without message matching", async () => {
    const target = await targetRequest();
    vi.spyOn(workspaceManager, "withWorkspaceWrite").mockImplementationOnce(
      async (_target, _revision, operation) =>
        operation({ instanceId: "changed" } as Parameters<typeof operation>[0]),
    );
    const reply = await handleMaterialLibraryRequest({
      guard: target.guard,
      verb: "attach",
      params: { materialId: "mat_any", expectedRevision: target.expectedRevision },
    });
    expect(reply).toMatchObject({
      ok: false,
      error: {
        code: "CONFLICT",
        message: "Workspace material attach conflict: Workspace runtime changed before material attach",
      },
    });
  });

  it("reports a stale attach revision as CONFLICT and ordinary failures as INTERNAL", async () => {
    const target = await targetRequest();
    const stale = await handleMaterialLibraryRequest({
      guard: target.guard,
      verb: "attach",
      params: { materialId: "mat_any", expectedRevision: target.expectedRevision + 99 },
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "CONFLICT" } });

    vi.spyOn(workspaceManager, "withWorkspaceWrite").mockRejectedValueOnce(
      new Error("disk write failed"),
    );
    const ordinary = await handleMaterialLibraryRequest({
      guard: target.guard,
      verb: "attach",
      params: { materialId: "mat_any", expectedRevision: target.expectedRevision },
    });
    expect(ordinary).toMatchObject({
      ok: false,
      error: { code: "INTERNAL", message: "disk write failed" },
    });
  });
});
