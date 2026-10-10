import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob } from "node:buffer";
import * as core from "@reelterminal/core";
import { DB_NAME, DB_VERSION, STORES, hashMediaBytes } from "@reelterminal/core";
import type { MediaMetadata, Project } from "@reelterminal/core";
import { WorkspaceManager, type WorkspaceTarget } from "./workspace-manager";
import * as mediaStorage from "./media-storage";
import { saveMediaBlob } from "./media-storage";
import { createEmptyProject } from "../stores/project/project-helpers";

/**
 * Integrity contract of the archive-time media check
 * (missingProjectDependencies via saveNode): trusted stored hashes must
 * verify byte-free, while missing, placeholder, and hash-mismatched media
 * must still be found. The perf baselines in workspace-manager.perf.test.ts
 * assert the reduced costs; this suite pins the behavior they must not
 * trade away.
 */

beforeAll(() => {
  // One factory for the whole file: media-storage's module-level engine keeps
  // its connection open across tests, so the database must stay reachable.
  globalThis.indexedDB = new IDBFactory();
});

beforeEach(() => {
  // jsdom's Blob cannot be hashed and is destroyed by fake-indexeddb's
  // structured clones; Node's Blob survives both (same rationale as the perf
  // baselines). The stub stays for the whole file: the forked-process pool
  // keeps it from leaking anywhere else.
  vi.stubGlobal("Blob", NodeBlob);
});

const metadata: MediaMetadata = {
  duration: 2,
  width: 640,
  height: 360,
  frameRate: 30,
  codec: "avc1",
  sampleRate: 0,
  channels: 0,
  fileSize: 8,
};

function mediaItem(
  id: string,
  overrides: Partial<Project["mediaLibrary"]["items"][number]> = {},
): Project["mediaLibrary"]["items"][number] {
  return {
    id,
    name: id,
    type: "video",
    fileHandle: null,
    blob: null,
    metadata,
    // A data: thumbnail keeps runtime hydration away from thumbnail
    // generation (canvas-dependent) in the jsdom test environment.
    thumbnailUrl: "data:image/png;base64,AAAA",
    waveformData: null,
    ...overrides,
  };
}

/** Deterministic fixture bytes backed by a plain ArrayBuffer (Blob-compatible). */
function utf8Bytes(value: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(value);
  const bytes = new Uint8Array(encoded.byteLength);
  bytes.set(encoded);
  return bytes;
}

async function setupProjectWithRuntime(project: Project): Promise<{ manager: WorkspaceManager; target: WorkspaceTarget }> {
  const manager = new WorkspaceManager();
  const created = await manager.createProject(project);
  const target = { projectId: project.id, workspaceId: created.defaultWorkspaceId };
  // Load the runtime and make a substantive edit: an unchanged project dedups
  // to the base node and would skip the archive check entirely.
  const context = await manager.getWorkspaceContext(target);
  context.store.setState({
    project: {
      ...context.store.getState().project,
      name: `${project.name} edited`,
      modifiedAt: Date.now(),
    },
  });
  return { manager, target };
}

/** Rewrites the durable record into a pre-versioning row: same bytes, no hash. */
async function downgradeToLegacyRecord(
  projectId: string,
  mediaId: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORES.MEDIA, "readwrite");
      tx.objectStore(STORES.MEDIA).put({
        id: mediaId,
        projectId,
        projectIds: [projectId],
        blob: new Blob([bytes]),
        metadata,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Awaited spy results: what the metadata read actually returned. */
async function metadataResults(
  spy: { mock: { results: unknown[] } },
): Promise<mediaStorage.StoredMediaMetadataEntry[][]> {
  return Promise.all(
    (spy.mock.results as unknown as { value: Promise<mediaStorage.StoredMediaMetadataEntry[]> }[])
      .map((result) => result.value),
  );
}

function materializedBlobBytes(entries: mediaStorage.StoredMediaMetadataEntry[][]): number {
  return entries.reduce(
    (total, group) => total + group.reduce((sum, entry) => sum + (entry.blob?.size ?? 0), 0),
    0,
  );
}

describe("archive-time media check", () => {
  it("verifies trusted stored hashes without materializing a single media byte", async () => {
    const projectId = `archive-trusted-${crypto.randomUUID()}`;
    const bytes = utf8Bytes("trusted-archive-bytes");
    await saveMediaBlob(projectId, "m-trusted", new Blob([bytes]), metadata);
    const { manager, target } = await setupProjectWithRuntime({
      ...createEmptyProject("Archive trusted"),
      id: projectId,
      mediaLibrary: {
        items: [
          mediaItem("m-trusted", { contentHash: await hashMediaBytes(bytes) }),
          mediaItem("m-placeholder", { isPlaceholder: true }),
        ],
      },
    });

    const loadSpy = vi.spyOn(mediaStorage, "loadProjectMedia");
    const metadataSpy = vi.spyOn(mediaStorage, "loadProjectMediaMetadata");
    const hashSpy = vi.spyOn(core, "hashMediaBlob");
    const saved = await manager.saveNode({ target, name: "Archive node" });

    expect(saved.node.missingDependencies).toEqual(["m-placeholder"]);
    expect(loadSpy).not.toHaveBeenCalled();
    expect(hashSpy).not.toHaveBeenCalled();
    expect(metadataSpy).toHaveBeenCalledTimes(1);
    // Every entry came back hash-only: zero blob bytes were materialized.
    expect(materializedBlobBytes(await metadataResults(metadataSpy))).toBe(0);
    loadSpy.mockRestore();
    metadataSpy.mockRestore();
    hashSpy.mockRestore();
  });

  it("still reports media missing when a trusted item hash mismatches the stored bytes", async () => {
    const projectId = `archive-mismatch-${crypto.randomUUID()}`;
    const bytes = utf8Bytes("mismatch-archive-bytes");
    const storedHash = await hashMediaBytes(bytes);
    await saveMediaBlob(projectId, "m-wrong", new Blob([bytes]), metadata);
    const { manager, target } = await setupProjectWithRuntime({
      ...createEmptyProject("Archive mismatch"),
      id: projectId,
      mediaLibrary: {
        items: [
          // The item trusts a different version than the one durably stored.
          mediaItem("m-wrong", { contentHash: "0".repeat(64) }),
        ],
      },
    });

    const metadataSpy = vi.spyOn(mediaStorage, "loadProjectMediaMetadata");
    const hashSpy = vi.spyOn(core, "hashMediaBlob");
    const saved = await manager.saveNode({ target, name: "Archive node" });

    expect(saved.node.missingDependencies).toEqual(["m-wrong"]);
    // The mismatch is decided on stored metadata; bytes stay untouched and
    // the stored hash is what the item failed to match.
    expect(hashSpy).not.toHaveBeenCalled();
    const results = await metadataResults(metadataSpy);
    expect(results[0]?.[0]?.contentHash).toBe(storedHash);
    expect(materializedBlobBytes(results)).toBe(0);
    metadataSpy.mockRestore();
    hashSpy.mockRestore();
  });

  it("verifies a legacy record without a stored hash by reading its bytes once", async () => {
    const projectId = `archive-legacy-${crypto.randomUUID()}`;
    const bytes = utf8Bytes("legacy-archive-bytes");
    const trueHash = await hashMediaBytes(bytes);
    await saveMediaBlob(projectId, "m-legacy", new Blob([bytes]), metadata);
    await downgradeToLegacyRecord(projectId, "m-legacy", bytes);
    const { manager, target } = await setupProjectWithRuntime({
      ...createEmptyProject("Archive legacy"),
      id: projectId,
      mediaLibrary: {
        items: [
          mediaItem("m-legacy", { contentHash: trueHash }),
          mediaItem("m-placeholder", { isPlaceholder: true }),
        ],
      },
    });

    const metadataSpy = vi.spyOn(mediaStorage, "loadProjectMediaMetadata");
    const hashSpy = vi.spyOn(core, "hashMediaBlob");
    const saved = await manager.saveNode({ target, name: "Archive node" });

    // The legacy bytes hash to the trusted item hash, so nothing is missing.
    expect(saved.node.missingDependencies).toEqual(["m-placeholder"]);
    expect(hashSpy).toHaveBeenCalledTimes(1);
    expect(materializedBlobBytes(await metadataResults(metadataSpy))).toBeGreaterThan(0);
    metadataSpy.mockRestore();
    hashSpy.mockRestore();
  });
});
