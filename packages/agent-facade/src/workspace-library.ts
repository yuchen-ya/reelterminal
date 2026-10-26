/**
 * Live project/workspace/node operations owned by the renderer's durable
 * workspace manager. The facade validates the public command and forwards a
 * JSON-safe request; the renderer remains the persistence authority.
 */
export const WORKSPACE_VERBS = [
  "project.list",
  "workspace.list",
  "workspace.create",
  "workspace.delete",
  "workspace.close",
  "workspace.switch_view",
  "workspace.list_drafts",
  "workspace.recover_draft",
  "node.list",
  "node.get",
  "node.save",
  "node.restore",
  "node.rename",
  "node.media",
  "node.compare",
  "media.references",
  "media.cleanup.review",
  "media.cleanup.plan",
  "media.cleanup.execute",
] as const;

export type WorkspaceVerb = (typeof WORKSPACE_VERBS)[number];

export type WorkspaceLibraryBridgeVerb = WorkspaceVerb | "project.create" | "retainTaskInputs" | "releaseTaskInputs" | "prepareRenderFonts";

export interface WorkspaceLibraryBridgeRequest {
  readonly verb: WorkspaceLibraryBridgeVerb;
  readonly params: Record<string, unknown>;
}

export interface WorkspaceLibraryBridgeError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export type WorkspaceLibraryBridgeReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: WorkspaceLibraryBridgeError };

export type WorkspaceLibraryBridge = (
  request: WorkspaceLibraryBridgeRequest,
) => Promise<WorkspaceLibraryBridgeReply>;

export interface WorkspaceTargetParams {
  readonly projectId: string;
  readonly workspaceId: string;
}

export interface ProjectListParams {}
export interface WorkspaceListParams { readonly projectId: string }
export interface WorkspaceCreateParams {
  readonly projectId: string;
  readonly name?: string;
  readonly sourceNodeId?: string;
  readonly sourceWorkspaceId?: string;
  readonly kind?: "trial";
}
export interface WorkspaceDeleteParams extends WorkspaceTargetParams {
  readonly expectedRevision: number;
  readonly idempotencyKey?: string;
}
export interface WorkspaceCloseParams extends WorkspaceTargetParams {}
export interface WorkspaceSwitchViewParams extends WorkspaceTargetParams {}
export interface WorkspaceListDraftsParams extends WorkspaceTargetParams {}
export interface WorkspaceRecoverDraftParams extends WorkspaceTargetParams {
  readonly draftId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}
export interface NodeListParams { readonly projectId: string }
export interface NodeGetParams { readonly projectId: string; readonly nodeId: string }
export interface NodeSaveParams extends WorkspaceTargetParams {
  readonly name?: string;
  readonly summary?: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}
export interface NodeRestoreParams extends WorkspaceTargetParams {
  readonly nodeId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}
export interface NodeRenameParams {
  readonly projectId: string;
  readonly nodeId: string;
  readonly name: string;
  readonly summary?: string;
}
export interface NodeMediaParams { readonly projectId: string; readonly nodeId: string }
export interface NodeCompareParams {
  readonly projectId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
}
export interface MediaReferencesParams {
  readonly projectId: string;
  readonly mediaId: string;
  readonly workspaceId?: string;
}
export type MediaCleanupAction = "purge-media" | "purge-deleted-nodes" | "recycle-nodes" | "restore-nodes" | "purge-cache" | "purge-failed-jobs";
export interface MediaCleanupTaskFile {
  readonly jobId: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly lastModifiedMs: number;
}
export interface MediaCleanupReviewParams extends WorkspaceTargetParams {
  readonly exportId?: string;
  readonly cleanupTaskId?: string;
  readonly selectedNodeIds?: readonly string[];
}
export interface MediaCleanupPlanParams extends WorkspaceTargetParams {
  readonly exportId?: string;
  readonly cleanupTaskId?: string;
  readonly action: MediaCleanupAction;
  readonly nodeIds?: readonly string[];
  readonly mediaIds?: readonly string[];
  readonly cacheKeys?: readonly string[];
  readonly jobIds?: readonly string[];
}
export interface MediaCleanupExecuteParams extends WorkspaceTargetParams {
  readonly exportId?: string;
  readonly cleanupTaskId?: string;
  readonly planId: string;
  readonly action: MediaCleanupAction;
  readonly revision: number;
  readonly workspaceInstanceId: string;
  readonly nodeIds: readonly string[];
  readonly mediaIds: readonly string[];
  readonly cacheKeys: readonly string[];
  readonly cleanupTaskNodeIds: readonly string[];
  readonly jobIds: readonly string[];
  readonly jobFiles: readonly MediaCleanupTaskFile[];
  readonly confirmed: true;
}

/** Manager pin request used before a background task can start. */
export interface RetainTaskInputsParams {
  readonly jobId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sourceRevision: number;
  readonly inputProject: unknown;
}
