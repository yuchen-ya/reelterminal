import { StorageEngine } from "@reelterminal/core";
import type { MediaRecord, MediaMetadata } from "@reelterminal/core";
import {
  LEGACY_AUTO_SAVE_DB_NAME,
  LEGACY_PROJECT_DB_NAME,
  LEGACY_TEMPLATE_DB_NAME,
} from "./legacy-storage-keys";

const storage = new StorageEngine();

export async function saveMediaBlob(
  projectId: string,
  mediaId: string,
  blob: Blob,
  metadata: MediaMetadata,
): Promise<void> {
  const record: MediaRecord = {
    id: mediaId,
    projectId,
    blob,
    metadata,
  };

  await storage.saveMedia(record);
}

export async function loadMediaBlob(mediaId: string): Promise<Blob | null> {
  const record = await storage.loadMedia(mediaId);
  return record?.blob || null;
}

export async function loadMediaRecord(
  mediaId: string,
): Promise<MediaRecord | null> {
  return storage.loadMedia(mediaId);
}

export async function loadProjectMedia(
  projectId: string,
): Promise<MediaRecord[]> {
  return storage.getMediaByProject(projectId);
}

export async function getMediaIdsByProject(
  projectId: string,
): Promise<string[]> {
  return storage.getMediaIdsByProject(projectId);
}

export async function deleteMediaBlob(mediaId: string): Promise<void> {
  await storage.deleteMedia(mediaId);
}

export async function deleteProjectMedia(projectId: string): Promise<void> {
  const records = await storage.getMediaByProject(projectId);
  for (const record of records) {
    await storage.deleteMedia(record.id);
  }
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
  await storage.clearAllData();

  // Legacy database names — must match the frozen registry
  // (packages/core/src/legacy/physical-identifiers.ts) or old data survives
  // the "clear all" action.
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
