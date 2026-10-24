import type { FileResource, ReviewNode, ReviewWorkspace } from "@reelterminal/core/review/types";
import { openMaterialDatabase } from "../material-library/storage";
import { requestDigest, reviewError, targetGuard, UUID, type ReviewTarget } from "./guards";

interface ResourceRef { id: string; nodeId: string; resourceId: string; ownerType: string }
interface Inventory { node: ReviewNode; refs: ResourceRef[]; resources: Array<{ resource: FileResource; shared: boolean }> }
export interface ReviewPurgePreview {
  nodeId: string; name: string; nodeRevision: number;
  resources: Array<{ id: string; name: string; size: number; external: boolean; shared: boolean }>;
  retainedReferences: Record<string, number>; reclaimableBytes: number;
}
export interface ReviewPurgeResult { nodeId: string; workspaceRevision: number; keptResourceIds: string[]; releasedResourceIds: string[]; replayed: boolean }

function inventory(transaction: IDBTransaction, target: ReviewTarget, done: (value: Inventory) => void, abort: (error: unknown) => void): void {
  const node = transaction.objectStore("reviewNodes").get(target.nodeId!);
  const refs = transaction.objectStore("resourceRefs").index("node").getAll(target.nodeId!) as IDBRequest<ResourceRef[]>;
  let pending = 2;
  for (const request of [node, refs]) request.onsuccess = () => {
    if (--pending) return;
    if (!node.result || node.result.workspaceId !== target.reviewWorkspaceId) { abort(reviewError("NOT_FOUND", "Review node does not belong to this workspace")); return; }
    if (!node.result.trashedAt) { abort(reviewError("CONFLICT", "Move the node to the recycle bin before permanently clearing it")); return; }
    const ids = [...new Set(refs.result.map(ref => ref.resourceId))];
    const value: Inventory = { node: node.result, refs: refs.result, resources: [] };
    let remaining = ids.length * 2;
    if (!remaining) { done(value); return; }
    for (const id of ids) {
      const resource = transaction.objectStore("fileResources").get(id) as IDBRequest<FileResource | undefined>;
      const holds = transaction.objectStore("resourceRefs").index("resource").getAll(id) as IDBRequest<ResourceRef[]>;
      let local = 2;
      for (const request of [resource, holds]) request.onsuccess = () => {
        if (--local === 0) {
          if (!resource.result) { abort(reviewError("NOT_FOUND", "A referenced resource record is missing; no content was cleared")); return; }
          value.resources.push({ resource: resource.result, shared: holds.result.some(ref => ref.nodeId !== target.nodeId) });
        }
        if (--remaining === 0) done(value);
      };
    }
  };
}
function deleteIndex(transaction: IDBTransaction, store: string, index: string | undefined, range: IDBKeyRange): void {
  const objectStore = transaction.objectStore(store);
  const request = (index ? objectStore.index(index) : objectStore).openKeyCursor(range);
  request.onsuccess = () => { const cursor = request.result; if (cursor) { objectStore.delete(cursor.primaryKey); cursor.continue(); } };
}

/** Permanent human action: atomic reference release, followed by existing delayed native GC. */
export class ReviewPurge {
  constructor(private readonly changed: () => void) {}
  async preview(target: ReviewTarget): Promise<ReviewPurgePreview> {
    targetGuard(target, true);
    const database = await openMaterialDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(["reviewNodes", "resourceRefs", "fileResources"], "readonly");
        let value: ReviewPurgePreview;
        let failure: unknown;
        inventory(transaction, target, source => {
          const retainedReferences: Record<string, number> = {};
          for (const ref of source.refs) retainedReferences[ref.ownerType] = (retainedReferences[ref.ownerType] ?? 0) + 1;
          value = { nodeId: source.node.id, name: source.node.name, nodeRevision: source.node.revision, retainedReferences,
            reclaimableBytes: source.resources.reduce((sum, { resource, shared }) => sum + (!shared && resource.storage.kind === "managed" ? resource.size : 0), 0),
            resources: source.resources.map(({ resource, shared }) => ({ id: resource.id, name: resource.originalFileName, size: resource.size, external: resource.storage.kind === "external", shared })) };
        }, error => { failure = error; transaction.abort(); });
        transaction.oncomplete = () => resolve(value);
        transaction.onabort = () => reject(failure ?? transaction.error);
      });
    } finally { database.close(); }
  }

  async clear(input: { target: ReviewTarget; expectedNodeRevision: number; expectedWorkspaceRevision: number; requestId: string; confirmDeleteHistory: true }): Promise<ReviewPurgeResult> {
    targetGuard(input.target, true);
    if (!UUID.test(input.requestId) || input.confirmDeleteHistory !== true || !Number.isSafeInteger(input.expectedNodeRevision) || input.expectedNodeRevision < 0 || !Number.isSafeInteger(input.expectedWorkspaceRevision) || input.expectedWorkspaceRevision < 0) throw reviewError("INVALID_PARAMS", "Permanent clearing requires explicit history deletion, revisions and a UUID request");
    const digest = await requestDigest({ ...input, target: { workspaceId: input.target.reviewWorkspaceId, nodeId: input.target.nodeId } });
    const database = await openMaterialDatabase();
    try {
      const result = await new Promise<ReviewPurgeResult>((resolve, reject) => {
        const transaction = database.transaction(["reviewWorkspaces", "reviewNodes", "reviewBatches", "reviewItems", "reviewVersions", "reviewFeedback", "reviewHandoffs", "reviewSteps", "reviewJournal", "reviewEvents", "reviewArchives", "reviewOperations", "fileResources", "resourceRefs"], "readwrite");
        const operation = transaction.objectStore("reviewOperations").get(input.requestId);
        const workspace = transaction.objectStore("reviewWorkspaces").get(input.target.reviewWorkspaceId) as IDBRequest<ReviewWorkspace | undefined>;
        let pending = 2, result: ReviewPurgeResult;
        let failure: unknown;
        const abort = (error: unknown) => { failure = error; transaction.abort(); };
        for (const request of [operation, workspace]) request.onsuccess = () => {
          if (--pending) return;
          if (operation.result) {
            if (operation.result.requestDigest !== digest) { abort(reviewError("CONFLICT", "Permanent-clear request ID was used for another operation")); return; }
            result = { ...operation.result.result, replayed: true }; return;
          }
          if (!workspace.result || workspace.result.revision !== input.expectedWorkspaceRevision) { abort(reviewError("CONFLICT", "Review directory changed after the clear preview")); return; }
          inventory(transaction, input.target, source => {
            if (source.node.revision !== input.expectedNodeRevision) { abort(reviewError("CONFLICT", "Review content changed after the clear preview")); return; }
            const nodeId = source.node.id;
            for (const ref of source.refs) transaction.objectStore("resourceRefs").delete(ref.id);
            const released = source.resources.filter(entry => !entry.shared).map(entry => entry.resource.id);
            for (const id of released) transaction.objectStore("fileResources").delete(id);
            const composite = IDBKeyRange.bound([nodeId, ""], [nodeId, "\uffff"]);
            for (const store of ["reviewBatches", "reviewItems", "reviewHandoffs"]) deleteIndex(transaction, store, "node", composite);
            for (const store of ["reviewVersions", "reviewFeedback"]) deleteIndex(transaction, store, "node", IDBKeyRange.only(nodeId));
            deleteIndex(transaction, "reviewSteps", "run", IDBKeyRange.bound([nodeId, "", ""], [nodeId, "\uffff", "\uffff"]));
            deleteIndex(transaction, "reviewJournal", "scope", IDBKeyRange.only(nodeId));
            deleteIndex(transaction, "reviewEvents", undefined, IDBKeyRange.bound([nodeId, 0], [nodeId, Number.MAX_SAFE_INTEGER]));
            deleteIndex(transaction, "reviewOperations", "scope", IDBKeyRange.bound([nodeId, 0], [nodeId, Number.MAX_SAFE_INTEGER]));
            transaction.objectStore("reviewArchives").delete(nodeId);
            transaction.objectStore("reviewNodes").delete(nodeId);
            const revision = workspace.result!.revision + 1;
            transaction.objectStore("reviewWorkspaces").put({ ...workspace.result!, revision, history: {} });
            transaction.objectStore("reviewJournal").add({ scopeId: input.target.reviewWorkspaceId, sequence: revision, kind: "event", actor: "human", changes: [], label: "Permanently clear node and history" });
            result = { nodeId, workspaceRevision: revision, keptResourceIds: source.resources.filter(entry => entry.shared).map(entry => entry.resource.id), releasedResourceIds: released, replayed: false };
            transaction.objectStore("reviewOperations").add({ operationId: input.requestId, requestDigest: digest, scopeId: input.target.reviewWorkspaceId, sequence: revision, result });
          }, abort);
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(failure ?? transaction.error);
      });
      if (!result.replayed) this.changed();
      return result;
    } finally { database.close(); }
  }
}
