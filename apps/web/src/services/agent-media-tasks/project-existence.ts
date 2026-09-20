/**
 * Target-project existence oracle for the artifact import gate.
 *
 * This reads the `projects` object store of the project database directly —
 * the full, authoritative project index — and never the recent-projects
 * list, which is a bounded, evictable convenience list (top-10, cleared on
 * open failures) that says nothing about whether a project still exists. A
 * task whose target project simply fell out of the recent list must stay
 * importable, so "not in the recent list" must never read as "deleted".
 *
 * The query is read-only and opens the database without an explicit version,
 * so it attaches to whatever schema version currently exists and never
 * triggers an upgrade. Failures answer "unknown": the import gate then keeps
 * the task in `awaiting_import` instead of failing it on a guess.
 */

import { LEGACY_PROJECT_DB_NAME } from "../legacy-storage-keys";

// Persisted database name — legacy registry, value frozen (user projects).
const PROJECT_DB_NAME = LEGACY_PROJECT_DB_NAME;
const PROJECTS_STORE = "projects";

export type ProjectExistence =
  | { readonly status: "exists" }
  | { readonly status: "missing" }
  /** The oracle could not answer (no IndexedDB, unexpected schema, query failed). */
  | { readonly status: "unknown" };

export async function checkProjectExists(
  projectId: string,
): Promise<ProjectExistence> {
  if (typeof indexedDB === "undefined" || !projectId) {
    return { status: "unknown" };
  }
  let db: IDBDatabase;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(PROJECT_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("open failed"));
    });
  } catch {
    return { status: "unknown" };
  }
  try {
    if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
      // Store absent. On a database that never held projects this means the
      // target cannot exist; on an unexpected schema it stays a guess, so
      // only a version-1 database (the current, store-at-v1 schema) answers.
      return db.version === 1 ? { status: "missing" } : { status: "unknown" };
    }
    const found = await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(PROJECTS_STORE, "readonly");
      const request = tx.objectStore(PROJECTS_STORE).count(projectId);
      request.onsuccess = () => resolve(request.result > 0);
      request.onerror = () => reject(request.error ?? new Error("count failed"));
    });
    return { status: found ? "exists" : "missing" };
  } catch {
    return { status: "unknown" };
  } finally {
    db.close();
  }
}
