import type { ReviewContext, ReviewWorkspace } from "@reelterminal/core/review/types";
import { openMaterialDatabase } from "../material-library/storage";

// Runtime identity changes on renderer restart; workspace identity survives it.
const instanceId = crypto.randomUUID();
export const reviewRuntimeInstanceId = (): string => instanceId;

export async function getReviewContext(): Promise<ReviewContext> {
  const database = await openMaterialDatabase();
  try {
    return await new Promise<ReviewContext>((resolve, reject) => {
      const transaction = database.transaction("reviewWorkspaces", "readwrite");
      const store = transaction.objectStore("reviewWorkspaces");
      const request = store.getAll(undefined, 2) as IDBRequest<ReviewWorkspace[]>;
      let workspace: ReviewWorkspace;
      let failure: Error | undefined;
      request.onsuccess = () => {
        if (request.result.length > 1) {
          failure = new Error("Review workspace singleton is inconsistent");
          transaction.abort();
          return;
        }
        workspace = request.result[0] ?? { id: crypto.randomUUID(), schemaVersion: 1, revision: 0 };
        if (request.result.length === 0) store.add(workspace);
      };
      transaction.oncomplete = () => resolve({
        target: { kind: "review", reviewWorkspaceId: workspace.id, instanceId },
        revision: workspace.revision, access: "read-only", ready: true,
      });
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Review initialization aborted"));
    });
  } finally {
    database.close();
  }
}
