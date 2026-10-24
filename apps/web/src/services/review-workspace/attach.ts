import { v5 as uuidv5 } from "uuid";
import type { FileResource, WorkspaceTarget } from "@reelterminal/core/review/types";
import { openMaterialDatabase } from "../material-library/storage";
import { workspaceManager } from "../workspace-manager";
import { runExclusiveLiveWrite } from "../agent/live-write-lock";
import { requestDigest, reviewError, targetGuard, UUID, type ReviewTarget } from "./guards";
import { reviewService } from "./service";

export interface ReviewAttachRequest {
  target: ReviewTarget;
  expectedNodeRevision: number;
  itemId: string;
  requestId: string;
  destination: Extract<WorkspaceTarget, { kind: "video" }>;
  expectedProjectRevision: number;
}
export interface ReviewAttachResult {
  projectId: string; workspaceId: string; mediaId: string; itemId: string;
  version: number; resourceId: string; revision: number; replayed: boolean; present: boolean;
}
interface Attachment {
  requestId: string; intent: string; nodeId: string; version: number;
  resource: FileResource; mediaId: string; result?: ReviewAttachResult;
}

/** A durable pending receipt binds retries before crossing into project storage. */
async function attachmentReceipt(requestId: string, intent: string, value?: Attachment): Promise<Attachment | undefined> {
  const database = await openMaterialDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("reviewUsages", value ? "readwrite" : "readonly");
      const store = transaction.objectStore("reviewUsages");
      const request = store.get(requestId) as IDBRequest<Attachment | undefined>;
      let result: Attachment | undefined;
      let failure: Error | undefined;
      request.onsuccess = () => {
        if (request.result && request.result.intent !== intent) {
          failure = reviewError("CONFLICT", "Attachment request ID belongs to another source or destination");
          transaction.abort(); return;
        }
        result = request.result?.result ? request.result : value ?? request.result;
        if (value && !request.result?.result) store.put(result!);
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  } finally { database.close(); }
}

/** OPFS provides a seekable File without accumulating a video in JS memory. */
async function withReviewFile<T>(resource: FileResource, operation: (file: File) => Promise<T>): Promise<T> {
  const root = await navigator.storage.getDirectory();
  const name = `.reelterminal-review-import-${crypto.randomUUID()}`;
  const handle = await root.getFileHandle(name, { create: true });
  try {
    const response = await fetch(`app://reelterminal/review-media/${resource.id}`);
    if (!response.ok || !response.body) throw reviewError("NOT_FOUND", "Review source file is unavailable");
    await response.body.pipeTo(await handle.createWritable());
    const source = await handle.getFile();
    if (source.size !== resource.size) throw reviewError("CONFLICT", "Review source size changed before import");
    return await operation(new File([source], resource.originalFileName, { type: resource.mime }));
  } finally { await root.removeEntry(name); }
}

/** Exact human-adopted version → independent project media; never inserts a clip. */
export async function attachReviewMedia(input: ReviewAttachRequest, actor: "human" | "agent"): Promise<ReviewAttachResult> {
  targetGuard(input.target, true);
  if (!UUID.test(input.itemId) || !UUID.test(input.requestId) || input.destination.kind !== "video" ||
      !input.destination.projectId || !input.destination.workspaceId || !UUID.test(input.destination.instanceId) ||
      !Number.isSafeInteger(input.expectedProjectRevision) || input.expectedProjectRevision < 0) throw reviewError("INVALID_PARAMS", "Attachment requires an explicit video target, revisions and UUID request");
  // Runtime generations guard this invocation; stable identities bind durable retries.
  const intent = await requestDigest({ workspaceId: input.target.reviewWorkspaceId, nodeId: input.target.nodeId,
    itemId: input.itemId, expectedNodeRevision: input.expectedNodeRevision, destination: {
      projectId: input.destination.projectId, workspaceId: input.destination.workspaceId,
    }, expectedProjectRevision: input.expectedProjectRevision });
  return runExclusiveLiveWrite(async () => {
    const context = await workspaceManager.getWorkspaceContext(input.destination);
    if (context.instanceId !== input.destination.instanceId) throw reviewError("CONFLICT", "Video workspace runtime changed; read its context again");
    let receipt = await attachmentReceipt(input.requestId, intent);
    if (!receipt) {
      const plan = await reviewService.freezeExport({ target: input.target, expectedNodeRevision: input.expectedNodeRevision,
        exportId: input.requestId, mode: "adopted", scope: "selected", itemIds: [input.itemId] });
      const entry = plan.entries[0];
      if (!entry.resourceId) throw reviewError("UNSUPPORTED", "Only adopted image and video files can be added to project media");
      const resource = (await reviewService.getResources([entry.resourceId]))[0];
      if (!resource.sha256 || (resource.metadata?.type !== "image" && resource.metadata?.type !== "video")) throw reviewError("UNSUPPORTED", "Attachment needs a verified image or video resource");
      receipt = (await attachmentReceipt(input.requestId, intent, { requestId: input.requestId, intent, nodeId: input.target.nodeId!,
        resource, version: entry.itemVersion!, mediaId: uuidv5("review-project-media", input.requestId) }))!;
    }
    const store = context.store;
    const existing = store.getState().project.mediaLibrary.items.find(item => item.id === receipt!.mediaId);
    if (receipt.result) return { ...receipt.result, replayed: true, present: !!existing };
    if (existing && (existing.reviewSource?.requestId !== input.requestId || existing.contentHash !== receipt.resource.sha256)) throw reviewError("CONFLICT", "Attachment media identity already contains different content");
    if (!existing) {
      const result = await withReviewFile(receipt.resource, file => store.getState().importMedia(file, {
        projectId: input.destination.projectId, workspaceId: input.destination.workspaceId, expectedRevision: input.expectedProjectRevision,
        mediaId: receipt!.mediaId, detachSource: true, expectedContentHash: receipt!.resource.sha256,
        type: receipt!.resource.metadata!.type as "image" | "video", historyOwner: actor === "agent" ? "agent" : "human",
        historyGroupLabel: "Add adopted review media", reviewSource: { reviewWorkspaceId: input.target.reviewWorkspaceId,
          nodeId: input.target.nodeId!, itemId: input.itemId, version: receipt!.version, resourceId: receipt!.resource.id, requestId: input.requestId },
      }));
      if (!result.success) throw reviewError(result.error?.code === "INVALID_PARAMS" ? "CONFLICT" : "INTERNAL", result.error?.message ?? "Project media import failed");
    }
    await workspaceManager.flushWorkspace(input.destination);
    const result: ReviewAttachResult = { projectId: input.destination.projectId, workspaceId: input.destination.workspaceId,
      mediaId: receipt.mediaId, itemId: input.itemId, resourceId: receipt.resource.id, version: receipt.version,
      revision: store.getState().workspaceRevision, replayed: !!existing, present: true };
    await attachmentReceipt(input.requestId, intent, { ...receipt, result });
    return result;
  }, input.destination);
}
