import { StorageEngine, hashMediaBlob } from "@reelterminal/core";
import type { MediaRecord, MediaMetadata } from "@reelterminal/core";
import {
  LEGACY_AUTO_SAVE_DB_NAME,
  LEGACY_PROJECT_DB_NAME,
  LEGACY_TEMPLATE_DB_NAME,
} from "./legacy-storage-keys";

const storage = new StorageEngine();

export interface SavedMediaVersion {
  readonly contentHash: string;
  readonly contentUrl?: string;
  /** True only when no identical version existed in either durable store. */
  readonly created: boolean;
}

export interface StoredMediaEntry {
  readonly id: string;
  readonly projectId: string;
  readonly projectIds?: readonly string[];
  readonly blob?: Blob;
  readonly metadata: MediaMetadata;
  readonly contentHash?: string;
  readonly contentUrl?: string;
  readonly sizeBytes: number;
  readonly controlledFiles?: readonly { readonly path: string; readonly sizeBytes: number }[];
}

let mutationQueue: Promise<void> = Promise.resolve();

/** Serialize reference commits with media cleanup's final scan and deletion. */
export async function withMediaReferenceWrite<T>(
  operation: () => Promise<T> | T,
): Promise<T> {
  const previous = mutationQueue;
  let release!: () => void;
  mutationQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function desktopMediaStore(): NonNullable<
  NonNullable<Window["reelterminal"]>["mediaStore"]
> | undefined {
  return typeof window === "undefined" ? undefined : window.reelterminal?.mediaStore;
}

async function writeControlledMediaVersion(
  projectId: string,
  mediaId: string,
  blob: Blob,
  contentHash: string,
  nameHint?: string,
): Promise<{ path: string; created: boolean } | undefined> {
  const mediaStore = desktopMediaStore();
  if (!mediaStore) {
    if (typeof window !== "undefined" && window.reelterminal?.platform === "desktop") {
      throw new Error("Controlled media storage is unavailable in this desktop session");
    }
    return undefined;
  }

  const extension = await mediaExtension(nameHint, blob.type, blob);
  const sessionId = await mediaStore.beginWrite({ projectId, mediaId, expectedHash: contentHash, extension });
  try {
    const reader = blob.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Keep each structured-clone IPC payload bounded even when a Blob
        // implementation yields a large stream chunk.
        for (let offset = 0; offset < value.byteLength; offset += 4 * 1024 * 1024) {
          const chunk = value.subarray(offset, Math.min(offset + 4 * 1024 * 1024, value.byteLength));
          await mediaStore.writeChunk(sessionId, chunk);
        }
      }
    } finally {
      reader.releaseLock();
    }
    const result = await mediaStore.commitWrite(sessionId);
    if (result.contentHash !== contentHash) {
      throw new Error("Controlled media storage returned a different content hash");
    }
    return { path: result.path, created: result.created };
  } catch (error) {
    await mediaStore.abortWrite(sessionId).catch(() => undefined);
    throw error;
  }
}

async function mediaExtension(
  nameHint: string | undefined,
  mimeType: string,
  blob: Blob,
): Promise<string> {
  const filename = nameHint?.replaceAll("\\", "/").split("/").pop();
  const dot = filename?.lastIndexOf(".") ?? -1;
  const hinted = dot > 0 ? filename?.slice(dot + 1).toLowerCase() : undefined;
  if (
    hinted && hinted !== "bin" && /^[a-z0-9]{1,10}$/.test(hinted)
  ) return hinted;
  const byMime: Record<string, string> = {
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/x-matroska": "mkv",
    "video/x-msvideo": "avi",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/flac": "flac",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  if (byMime[mimeType]) return byMime[mimeType];

  // Generic `.bin` files often arrive from Agent imports or from browsers
  // that do not assign a MIME type. Preserve a browser-decodable suffix for
  // the supported raster formats by inspecting only the small file header.
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (
    header.length >= 8 && header[0] === 0x89 && header[1] === 0x50 &&
    header[2] === 0x4e && header[3] === 0x47 && header[4] === 0x0d &&
    header[5] === 0x0a && header[6] === 0x1a && header[7] === 0x0a
  ) return "png";
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "jpg";
  }
  if (header.length >= 6) {
    const signature = String.fromCharCode(...header.subarray(0, 6));
    if (signature === "GIF87a" || signature === "GIF89a") return "gif";
  }
  if (
    header.length >= 12 && String.fromCharCode(...header.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...header.subarray(8, 12)) === "WEBP"
  ) return "webp";
  return hinted && /^[a-z0-9]{1,10}$/.test(hinted) ? hinted : "bin";
}

export async function saveMediaBlob(
  projectId: string,
  mediaId: string,
  blob: Blob,
  metadata: MediaMetadata,
  nameHint?: string,
): Promise<SavedMediaVersion> {
  const contentHash = await hashMediaBlob(blob);
  return withMediaReferenceWrite(async () => {
    const existing = await storage.loadMedia(mediaId);
    if (existing) {
      const existingHash = existing.contentHash ?? await hashMediaBlob(existing.blob);
      if (existingHash !== contentHash) {
        throw new Error(`Media version ${mediaId} is immutable and already contains different bytes`);
      }
    }

    let controlled: { path: string; created: boolean } | undefined;
    const existingControlled = await desktopMediaStore()?.getVersion(mediaId);
    if (existingControlled) {
      if (existingControlled.contentHash !== contentHash) {
        throw new Error(`Media version ${mediaId} is immutable and already contains different controlled bytes`);
      }
      controlled = { path: existingControlled.path, created: false };
    } else {
      controlled = await writeControlledMediaVersion(projectId, mediaId, blob, contentHash, nameHint);
    }
    const record: MediaRecord = {
      id: mediaId,
      projectId,
      projectIds: [...new Set([...(existing?.projectIds ?? (existing ? [existing.projectId] : [])), projectId])],
      blob,
      metadata,
      contentHash,
      ...(controlled ? { contentUrl: controlled.path } : {}),
    };
    await storage.saveMedia(record);
    return {
      contentHash,
      ...(controlled ? { contentUrl: controlled.path } : {}),
      created: existing === null && (controlled?.created ?? true),
    };
  });
}

export async function loadMediaBlob(mediaId: string, projectId?: string): Promise<Blob | null> {
  const record = await storage.loadMedia(mediaId);
  if (record?.blob) return record.blob;
  const mediaStore = desktopMediaStore();
  if (!mediaStore) return null;
  if (projectId) {
    const scoped = await mediaStore.read({ projectId, mediaId });
    if (scoped) return new Blob([scoped]);
  }
  const bytes = await mediaStore.readAny(mediaId);
  return bytes ? new Blob([bytes]) : null;
}

export async function loadMediaRecord(mediaId: string): Promise<MediaRecord | null> {
  return storage.loadMedia(mediaId);
}

export async function loadProjectMedia(
  projectId: string,
  mediaIds?: readonly string[],
): Promise<MediaRecord[]> {
  const records = mediaIds
    ? (await Promise.all(mediaIds.map((mediaId) => storage.loadMedia(mediaId))))
      .filter((record): record is MediaRecord => record !== null)
    : await storage.getMediaByProject(projectId);
  const present = new Set(records.map((record) => record.id));
  const mediaStore = desktopMediaStore();
  if (!mediaStore) return records;
  const controlled = mediaIds
    ? (await mediaStore.listAll()).filter((entry) => mediaIds.includes(entry.mediaId))
    : await mediaStore.listProject(projectId);
  for (const entry of controlled) {
    if (present.has(entry.mediaId)) continue;
    const bytes = await mediaStore.readAny(entry.mediaId);
    if (!bytes) continue;
    records.push({
      id: entry.mediaId,
      projectId,
      blob: new Blob([bytes]),
      // The project description remains authoritative for metadata; restore
      // uses the item metadata and only consumes this record's bytes.
      metadata: {
        duration: 0,
        width: 0,
        height: 0,
        frameRate: 0,
        codec: "",
        sampleRate: 0,
        channels: 0,
        fileSize: entry.sizeBytes,
      },
    });
  }
  return records;
}

export interface StoredMediaMetadataEntry {
  readonly id: string;
  readonly projectId: string;
  readonly projectIds?: readonly string[];
  /** Trusted hash recorded durably at ingest; verifies without any bytes. */
  readonly contentHash?: string;
  /**
   * Bytes, present only when no trusted stored hash exists (records created
   * before versioned media, or controlled files predating hash-encoding
   * names). Callers that must verify such media hash these already-read bytes
   * once; no other bytes are materialized by this read.
   */
  readonly blob?: Blob;
}

/**
 * Read only what an archive integrity check compares: media ids and content
 * hashes. Mirrors loadProjectMedia's merge order (IDB records first, then
 * controlled-store-only entries) but never attaches bytes to entries that
 * carry a trusted stored hash. Computed hashes are intentionally NOT written
 * back here: the only write path re-puts the whole inline-blob record, which
 * would re-materialize the bytes this API exists to avoid.
 */
export async function loadProjectMediaMetadata(
  projectId: string,
  mediaIds?: readonly string[],
): Promise<StoredMediaMetadataEntry[]> {
  const entries: StoredMediaMetadataEntry[] = [];
  const present = new Set<string>();
  const toEntry = (record: MediaRecord): StoredMediaMetadataEntry => ({
    id: record.id,
    projectId: record.projectId,
    ...(record.projectIds ? { projectIds: record.projectIds } : {}),
    ...(record.contentHash
      ? { contentHash: record.contentHash }
      // Hashless (pre-versioned) records surface their bytes so the caller
      // can hash them exactly once.
      : { blob: record.blob }),
  });
  const records = mediaIds
    ? (await Promise.all(mediaIds.map((mediaId) => storage.loadMedia(mediaId))))
      .filter((record): record is MediaRecord => record !== null)
    : await storage.getMediaByProject(projectId);
  for (const record of records) {
    present.add(record.id);
    entries.push(toEntry(record));
  }
  const mediaStore = desktopMediaStore();
  if (!mediaStore) return entries;
  const controlled = mediaIds
    ? (await mediaStore.listAll()).filter((entry) => mediaIds.includes(entry.mediaId))
    : await mediaStore.listProject(projectId);
  for (const entry of controlled) {
    if (present.has(entry.mediaId)) continue;
    if (entry.contentHash) {
      // Hash-encoding filenames expose the commit-time hash with zero reads.
      present.add(entry.mediaId);
      entries.push({
        id: entry.mediaId,
        projectId: entry.projectId,
        contentHash: entry.contentHash,
      });
      continue;
    }
    // Legacy controlled files know their hash nowhere but the bytes.
    const bytes = await mediaStore.readAny(entry.mediaId);
    if (!bytes) continue;
    present.add(entry.mediaId);
    entries.push({
      id: entry.mediaId,
      projectId: entry.projectId,
      blob: new Blob([bytes]),
    });
  }
  return entries;
}

export async function getMediaIdsByProject(projectId: string): Promise<string[]> {
  const ids = new Set(await storage.getMediaIdsByProject(projectId));
  const mediaStore = desktopMediaStore();
  if (mediaStore) {
    for (const entry of await mediaStore.listProject(projectId)) ids.add(entry.mediaId);
  }
  return [...ids];
}

export async function getAllStoredMedia(): Promise<StoredMediaEntry[]> {
  const records = await storage.getAllMedia();
  const entries = new Map<string, StoredMediaEntry>(records.map((record) => [record.id, {
    ...record,
    sizeBytes: record.blob.size,
    controlledFiles: [] as { path: string; sizeBytes: number }[],
  }]));
  const mediaStore = desktopMediaStore();
  if (mediaStore) {
    const filesById = new Map<string, { path: string; sizeBytes: number }[]>();
    const projectsById = new Map<string, Set<string>>();
    for (const entry of await mediaStore.listAll()) {
      filesById.set(entry.mediaId, [...(filesById.get(entry.mediaId) ?? []), {
        path: entry.path,
        sizeBytes: entry.sizeBytes,
      }]);
      const projects = projectsById.get(entry.mediaId) ?? new Set<string>();
      projects.add(entry.projectId);
      projectsById.set(entry.mediaId, projects);
    }
    for (const [mediaId, files] of filesById) {
      const existing = entries.get(mediaId);
      const contentUrl = existing?.contentUrl ?? files[0]?.path;
      const projectIds = [...new Set([
        ...(existing?.projectIds ?? (existing ? [existing.projectId] : [])),
        ...(projectsById.get(mediaId) ?? []),
      ])];
      if (existing) {
        entries.set(mediaId, {
          ...existing,
          projectIds,
          ...(contentUrl ? { contentUrl } : {}),
          controlledFiles: files,
        });
      } else {
        const first = files[0];
        if (!first) continue;
        entries.set(mediaId, {
          id: mediaId,
          projectId: projectIds[0] ?? "",
          projectIds,
          contentUrl: first.path,
          controlledFiles: files,
          sizeBytes: first.sizeBytes,
          metadata: {
            duration: 0,
            width: 0,
            height: 0,
            frameRate: 0,
            codec: "",
            sampleRate: 0,
            channels: 0,
            fileSize: first.sizeBytes,
          },
        });
      }
    }
  }
  return [...entries.values()];
}

async function deleteMediaBlobUnlocked(mediaId: string, projectId?: string): Promise<void> {
  const record = await storage.loadMedia(mediaId);
  if (projectId && record) {
    const owners = record.projectIds ?? [record.projectId];
    if (owners.some((owner) => owner !== projectId)) return;
  }
  await storage.deleteMedia(mediaId);
  const mediaStore = desktopMediaStore();
  if (!mediaStore) return;
  if (projectId) {
    // The controlled store keeps one file per owning project directory and
    // its global delete unlinks every copy, so only run it when no other
    // project still owns this media id.
    const foreignOwner = (await mediaStore.listAll()).some(
      (entry) => entry.mediaId === mediaId && entry.projectId !== projectId,
    );
    if (foreignOwner) return;
  }
  await mediaStore.delete(mediaId);
}

/** Internal GC primitive. Call only while holding withMediaReferenceWrite. */
export async function deleteMediaBlobUnderReferenceWrite(
  mediaId: string,
  projectId?: string,
): Promise<void> {
  await deleteMediaBlobUnlocked(mediaId, projectId);
}

export async function deleteMediaBlob(mediaId: string, projectId?: string): Promise<void> {
  await withMediaReferenceWrite(() => deleteMediaBlobUnlocked(mediaId, projectId));
}

export async function deleteProjectMedia(projectId: string): Promise<void> {
  await withMediaReferenceWrite(async () => {
    const ids = new Set(await getMediaIdsByProject(projectId));
    for (const mediaId of ids) await deleteMediaBlobUnlocked(mediaId, projectId);
  });
}

export async function saveFileHandle(name: string, size: number, handle: FileSystemFileHandle): Promise<void> {
  await storage.saveFileHandle(name, size, handle);
}

export async function loadFileHandle(name: string, size: number): Promise<FileSystemFileHandle | null> {
  return storage.loadFileHandle(name, size);
}

export async function saveDirectoryHandle(projectId: string, handle: FileSystemDirectoryHandle): Promise<void> {
  await storage.saveDirectoryHandle(projectId, handle);
}

export async function loadDirectoryHandle(projectId: string): Promise<{ handle: FileSystemDirectoryHandle; folderName: string } | null> {
  return storage.loadDirectoryHandle(projectId);
}

export async function getStorageStats(): Promise<{
  used: number;
  quota: number;
  mediaCount: number;
}> {
  const usage = await storage.getStorageUsage();
  return {
    used: usage.used,
    quota: usage.quota,
    mediaCount: usage.mediaItems,
  };
}

export async function clearAllStorage(): Promise<void> {
  await withMediaReferenceWrite(async () => {
    await storage.clearAllData();
    await desktopMediaStore()?.clearAll();
  });

  const databasesToDelete = [
    LEGACY_AUTO_SAVE_DB_NAME,
    LEGACY_PROJECT_DB_NAME,
    LEGACY_TEMPLATE_DB_NAME,
  ];
  await Promise.allSettled(
    databasesToDelete.map(
      (dbName) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(dbName);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
          request.onblocked = () => resolve();
        }),
    ),
  );
}
