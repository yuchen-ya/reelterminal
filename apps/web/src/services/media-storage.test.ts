/**
 * @vitest-environment node
 */
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DB_NAME,
  DB_VERSION,
  STORES,
  getPerfSink,
  hashMediaBlob,
  hashMediaBytes,
  setPerfSink,
  type Outcome,
  type PerfSink,
} from "@reelterminal/core";
import {
  saveMediaBlob,
  loadProjectMedia,
  loadMediaRecord,
  getMediaIdsByProject,
  deleteMediaBlob,
  loadProjectMediaMetadata,
} from "./media-storage";

beforeAll(() => {
  // One factory for the whole file: the module-level StorageEngine keeps its
  // connection open across tests, so every database must stay reachable.
  vi.stubGlobal("indexedDB", new IDBFactory());
});

const previousWindow = typeof window === "undefined" ? undefined : window;

afterEach(() => {
  vi.stubGlobal("window", previousWindow);
});

const metadata = {
  duration: 1,
  width: 640,
  height: 360,
  frameRate: 30,
  codec: "h264",
  sampleRate: 0,
  channels: 0,
  fileSize: 12,
};

describe("immutable media storage", () => {
  it("records project media reads without exposing media identifiers", async () => {
    const mediaId = `read-${crypto.randomUUID()}`;
    const projectId = `project-${crypto.randomUUID()}`;
    const blob = new Blob(["readable media"]);
    await saveMediaBlob(projectId, mediaId, blob, metadata);

    const events: Array<{
      phase: string;
      outcome?: Outcome;
      dims?: Readonly<Record<string, number | boolean>>;
    }> = [];
    const phaseBySpan = new Map<number, string>();
    let nextSpanId = 0;
    const previousSink = getPerfSink();
    setPerfSink({
      enabled: true,
      mode: "trace",
      runId: "media-storage-test",
      begin: (phase) => {
        const id = ++nextSpanId;
        phaseBySpan.set(id, phase);
        events.push({ phase });
        return { id, startedUs: id };
      },
      end: (span, outcome, dims) => {
        events.push({ phase: phaseBySpan.get(span.id) ?? "", outcome, dims });
      },
      mark: (phase, _context, dims) => events.push({ phase, dims }),
      count: () => undefined,
    } satisfies PerfSink);

    try {
      const records = await loadProjectMedia(projectId, [mediaId]);
      expect(records).toHaveLength(1);
      expect(records[0]?.blob?.size).toBe(blob.size);
    } finally {
      setPerfSink(previousSink);
    }

    expect(events.some((event) => event.phase === "media_storage.restore_read")).toBe(true);
    expect(events.some((event) => event.dims?.media_bytes === blob.size)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(mediaId);
    expect(events.every((event) =>
      Object.values(event.dims ?? {}).every((value) =>
        typeof value === "number" || typeof value === "boolean",
      ),
    )).toBe(true);
  });

  it("reuses one content id across projects without overwriting or losing either owner", async () => {
    const mediaId = `shared-${crypto.randomUUID()}`;
    const projectA = `project-a-${crypto.randomUUID()}`;
    const projectB = `project-b-${crypto.randomUUID()}`;
    const original = new Blob(["same-content"], { type: "video/mp4" });

    const first = await saveMediaBlob(projectA, mediaId, original, metadata, "clip.mp4");
    const second = await saveMediaBlob(projectB, mediaId, original, metadata, "clip.mp4");

    expect(first.contentHash).toBe(second.contentHash);
    expect(second.created).toBe(false);
    expect(await getMediaIdsByProject(projectA)).toContain(mediaId);
    expect(await getMediaIdsByProject(projectB)).toContain(mediaId);
    expect(await loadMediaRecord(mediaId)).toMatchObject({
      id: mediaId,
      projectId: projectA,
      projectIds: expect.arrayContaining([projectA, projectB]),
      contentHash: first.contentHash,
    });
  });

  it("rejects changed bytes for an existing content id", async () => {
    const mediaId = `immutable-${crypto.randomUUID()}`;
    const projectId = `project-${crypto.randomUUID()}`;
    await saveMediaBlob(projectId, mediaId, new Blob(["version-one"]), metadata);

    await expect(saveMediaBlob(
      projectId,
      mediaId,
      new Blob(["version-two"]),
      metadata,
    )).rejects.toThrow(/immutable/i);
    expect(await getMediaIdsByProject(projectId)).toContain(mediaId);
  });

  it("stores generic image bytes with a browser-decodable controlled-file extension", async () => {
    let expectedHash = "";
    const beginWrite = vi.fn(async (input: { extension: string; expectedHash: string }) => {
      expectedHash = input.expectedHash;
      return "session";
    });
    const mediaStore = {
      getVersion: vi.fn(async () => null),
      beginWrite,
      writeChunk: vi.fn(async () => undefined),
      commitWrite: vi.fn(async () => ({
        path: "C:/app/controlled-media/project/media.png",
        contentHash: expectedHash,
        created: true,
      })),
      abortWrite: vi.fn(async () => undefined),
    };
    vi.stubGlobal("window", {
      reelterminal: { platform: "desktop", mediaStore },
    } as unknown as Window);

    const projectId = `project-${crypto.randomUUID()}`;
    const mediaId = `image-${crypto.randomUUID()}`;
    const pngHeader = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const result = await saveMediaBlob(
      projectId,
      mediaId,
      new Blob([pngHeader], { type: "application/octet-stream" }),
      metadata,
      "image.bin",
    );

    expect(beginWrite).toHaveBeenCalledWith(expect.objectContaining({ extension: "png" }));
    expect(result.contentUrl).toBe("C:/app/controlled-media/project/media.png");
  });

  it("keeps other projects' controlled files when deleting a shared media id for one project", async () => {
    const mediaId = `shared-${crypto.randomUUID()}`;
    const projectA = `project-a-${crypto.randomUUID()}`;
    const projectB = `project-b-${crypto.randomUUID()}`;
    // Controlled-store copies under both projects; the IDB record is absent.
    const controlledPaths = new Set([
      `${projectA}/${mediaId}.mp4`,
      `${projectB}/${mediaId}.mp4`,
    ]);
    const mediaStore = {
      listAll: vi.fn(async () =>
        [...controlledPaths].map((path) => ({
          projectId: path.split("/")[0],
          mediaId,
          path,
          sizeBytes: 12,
        })),
      ),
      // Mirrors the desktop store: unlink the media id under EVERY project.
      delete: vi.fn(async (id: string) => {
        for (const path of [...controlledPaths]) {
          if (path.split("/")[1]?.startsWith(`${id}.`)) controlledPaths.delete(path);
        }
      }),
    };
    vi.stubGlobal("window", {
      reelterminal: { platform: "desktop", mediaStore },
    } as unknown as Window);

    await deleteMediaBlob(mediaId, projectA);

    expect(controlledPaths.has(`${projectB}/${mediaId}.mp4`)).toBe(true);
  });
});

/** Raw record write for simulating pre-versioned (hashless) media rows. */
async function putRawMediaRecord(record: Record<string, unknown>): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const upgraded = request.result;
      if (upgraded.objectStoreNames.contains(STORES.MEDIA)) return;
      const mediaStore = upgraded.createObjectStore(STORES.MEDIA, { keyPath: "id" });
      mediaStore.createIndex("projectId", "projectId", { unique: false });
      mediaStore.createIndex("projectIds", "projectIds", { unique: false, multiEntry: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORES.MEDIA, "readwrite");
      tx.objectStore(STORES.MEDIA).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

describe("media metadata reads", () => {
  afterEach(() => {
    vi.stubGlobal("window", previousWindow);
  });

  function stubDesktopMediaStore(mediaStore: Record<string, unknown>): void {
    vi.stubGlobal("window", {
      reelterminal: { platform: "desktop", mediaStore },
    } as unknown as Window);
  }

  it("reports trusted stored hashes without materializing blob bytes", async () => {
    const mediaId = `meta-${crypto.randomUUID()}`;
    const projectId = `project-${crypto.randomUUID()}`;
    const saved = await saveMediaBlob(projectId, mediaId, new Blob(["meta-bytes"]), metadata);

    const entries = await loadProjectMediaMetadata(projectId, [mediaId]);

    // Exact shape: a trusted hash must arrive without a blob payload.
    expect(entries).toEqual([{
      id: mediaId,
      projectId,
      projectIds: [projectId],
      contentHash: saved.contentHash,
    }]);
  });

  it("surfaces bytes exactly once for a record created before versioned media", async () => {
    const mediaId = `legacy-${crypto.randomUUID()}`;
    const projectId = `project-${crypto.randomUUID()}`;
    const saved = await saveMediaBlob(projectId, mediaId, new Blob(["legacy-bytes"]), metadata);
    // Downgrade the durable record to a pre-versioning row: same bytes, no hash.
    await putRawMediaRecord({
      id: mediaId,
      projectId,
      projectIds: [projectId],
      blob: new Blob(["legacy-bytes"]),
      metadata,
    });

    const entries = await loadProjectMediaMetadata(projectId, [mediaId]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.contentHash).toBeUndefined();
    expect(await hashMediaBlob(entries[0]?.blob ?? new Blob())).toBe(saved.contentHash);
  });

  it("reads controlled-only hashes from hash-encoding filenames without byte reads", async () => {
    const mediaId = `controlled-${crypto.randomUUID()}`;
    const contentHash = await hashMediaBytes(new TextEncoder().encode("controlled-bytes"));
    const mediaStore = {
      listAll: vi.fn(async () => [{
        projectId: "project-c",
        mediaId,
        path: `C:/m/${mediaId}.${contentHash}.mp4`,
        sizeBytes: 16,
        contentHash,
      }]),
      readAny: vi.fn(async () => {
        throw new Error("metadata reads must not touch controlled bytes");
      }),
    };
    stubDesktopMediaStore(mediaStore);

    const entries = await loadProjectMediaMetadata("project-c", [mediaId]);

    expect(entries).toEqual([{ id: mediaId, projectId: "project-c", contentHash }]);
    expect(mediaStore.readAny).not.toHaveBeenCalled();
  });

  it("does not let a controlled entry shadow a stored record", async () => {
    const mediaId = `both-${crypto.randomUUID()}`;
    const projectId = `project-${crypto.randomUUID()}`;
    const saved = await saveMediaBlob(projectId, mediaId, new Blob(["stored-bytes"]), metadata);
    const mediaStore = {
      listAll: vi.fn(async () => [{
        projectId,
        mediaId,
        path: `C:/m/${mediaId}.mp4`,
        sizeBytes: 12,
      }]),
      readAny: vi.fn(async () => new ArrayBuffer(0)),
    };
    stubDesktopMediaStore(mediaStore);

    const entries = await loadProjectMediaMetadata(projectId, [mediaId]);

    expect(entries).toEqual([{
      id: mediaId,
      projectId,
      projectIds: [projectId],
      contentHash: saved.contentHash,
    }]);
    expect(mediaStore.readAny).not.toHaveBeenCalled();
  });

  it("falls back to bytes for controlled-only files without an encoded hash", async () => {
    const mediaId = `legacy-controlled-${crypto.randomUUID()}`;
    const bytes = new TextEncoder().encode("legacy-controlled");
    const mediaStore = {
      listAll: vi.fn(async () => [{
        projectId: "project-c",
        mediaId,
        path: `C:/m/${mediaId}.mp4`,
        sizeBytes: bytes.byteLength,
      }]),
      readAny: vi.fn(async () => bytes.buffer),
    };
    stubDesktopMediaStore(mediaStore);

    const entries = await loadProjectMediaMetadata("project-c", [mediaId]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.contentHash).toBeUndefined();
    expect(await hashMediaBlob(entries[0]?.blob ?? new Blob())).toBe(
      await hashMediaBytes(bytes),
    );
    expect(mediaStore.readAny).toHaveBeenCalledTimes(1);
  });

  it("omits unreadable controlled-only media so checks report it missing", async () => {
    const mediaId = `gone-controlled-${crypto.randomUUID()}`;
    const mediaStore = {
      listAll: vi.fn(async () => [{
        projectId: "project-c",
        mediaId,
        path: `C:/m/${mediaId}.mp4`,
        sizeBytes: 3,
      }]),
      readAny: vi.fn(async () => null),
    };
    stubDesktopMediaStore(mediaStore);

    expect(await loadProjectMediaMetadata("project-c", [mediaId])).toEqual([]);
  });
});
