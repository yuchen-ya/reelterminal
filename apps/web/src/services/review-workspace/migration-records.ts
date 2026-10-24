import type { StoreApi } from "zustand";
import { reviewMigrationKey, reviewMigrationPointer, type ReviewMigrationRecord } from "@reelterminal/core/review/migration";
import type { ProjectState } from "../../stores/project-store";
import { openMaterialDatabase } from "../material-library/storage";
import { reviewError } from "./guards";

type Source = Pick<ReviewMigrationRecord, "sourceProjectId" | "sourceWorkspaceId">;

export function persistReviewMigration(transaction: IDBTransaction, record: ReviewMigrationRecord): void {
  transaction.objectStore("reviewMigrations").add(record);
  transaction.objectStore("reviewMigrationSources").put({ sourceProjectId: record.sourceProjectId, sourceWorkspaceId: record.sourceWorkspaceId,
    sourceDigest: record.sourceDigest, migrationVersion: record.migrationVersion });
}

export async function readReviewMigration(source: Source & { sourceDigest: string }): Promise<ReviewMigrationRecord | undefined> {
  const database = await openMaterialDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("reviewMigrations", "readonly");
      const request = transaction.objectStore("reviewMigrations").get([...reviewMigrationKey({ ...source, migrationVersion: 1 })]);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { database.close(); }
}

export async function latestReviewMigration(source: Source): Promise<ReviewMigrationRecord | undefined> {
  const database = await openMaterialDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(["reviewMigrationSources", "reviewMigrations"], "readonly");
      const pointer = transaction.objectStore("reviewMigrationSources").get([source.sourceProjectId, source.sourceWorkspaceId]);
      let result: ReviewMigrationRecord | undefined;
      let failure: Error | undefined;
      pointer.onsuccess = () => {
        if (!pointer.result) return;
        const record = transaction.objectStore("reviewMigrations").get([...reviewMigrationKey(pointer.result)]);
        record.onsuccess = () => {
          if (!record.result) { failure = reviewError("INTERNAL", "Migration source points to a missing receipt"); transaction.abort(); return; }
          result = record.result;
        };
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  } finally { database.close(); }
}

export async function markReviewMigrationSaved(record: ReviewMigrationRecord): Promise<void> {
  const database = await openMaterialDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("reviewMigrations", "readwrite");
      const store = transaction.objectStore("reviewMigrations");
      const request = store.get([...reviewMigrationKey(record)]);
      let failure: Error | undefined;
      request.onsuccess = () => {
        if (request.result?.migrationId !== record.migrationId) { failure = reviewError("CONFLICT", "Migration receipt changed before project save confirmation"); transaction.abort(); return; }
        store.put({ ...request.result, projectSaved: true });
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  } finally { database.close(); }
}

/** Finish the metadata side of an already committed migration after interruption. */
export async function recoverReviewMigration(store: Pick<StoreApi<ProjectState>, "getState" | "setState">): Promise<void> {
  const before = store.getState();
  if (before.project.reviewMigration || !before.project.workbench?.items.length || !before.workspaceId) return;
  const record = await latestReviewMigration({ sourceProjectId: before.project.id, sourceWorkspaceId: before.workspaceId });
  if (!record) return;
  const current = store.getState();
  if (current.project.id !== before.project.id || current.workspaceId !== before.workspaceId) throw reviewError("CONFLICT", "Project target changed during migration recovery");
  if (current.project.reviewMigration) return;
  current.actionHistory.discardUndoGroupsContaining(action => action.type.startsWith("workbench/"));
  store.setState({ project: { ...current.project, reviewMigration: reviewMigrationPointer(record) } });
}
