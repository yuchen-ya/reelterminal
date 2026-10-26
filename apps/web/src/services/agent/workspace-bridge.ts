import type {
  WorkspaceLibraryBridgeReply,
  WorkspaceLibraryBridgeVerb,
} from "@reelterminal/agent-facade/workspace-library";
import type { Project } from "@reelterminal/core";
import {
  compareNodes,
  getMediaReferences,
  listNodeMedia,
} from "../project-media-gc";
import {
  createCleanupPlan,
  executeCleanupPlan,
  getCleanupReview,
  type CleanupAction,
  type CleanupTaskFile,
  type CleanupTarget,
} from "../export-cleanup";
import { prepareProjectRenderFonts } from "../project-render-dependencies";
import { workspaceManager, type WorkspaceTarget } from "../workspace-manager";
import { codedError, managerErrorCode } from "./bridge-error";

function requiredString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) throw codedError("INVALID_PARAMS", `${name} is required`);
  return value;
}

function expectedRevision(params: Record<string, unknown>): number {
  const value = params.expectedRevision;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw codedError("INVALID_PARAMS", "expectedRevision must be a non-negative integer");
  }
  return value;
}

function optionalString(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(params: Record<string, unknown>, name: string): string[] {
  const value = params[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw codedError("INVALID_PARAMS", `${name} must be an array of non-empty strings`);
  }
  return value as string[];
}

function requiredStringArray(params: Record<string, unknown>, name: string): string[] {
  if (!Object.prototype.hasOwnProperty.call(params, name)) {
    throw codedError("INVALID_PARAMS", `${name} is required`);
  }
  return stringArray(params, name);
}

function requiredCleanupTaskFiles(params: Record<string, unknown>, name = "jobFiles"): CleanupTaskFile[] {
  if (!Object.prototype.hasOwnProperty.call(params, name)) {
    throw codedError("INVALID_PARAMS", `${name} is required`);
  }
  const value = params[name];
  if (!Array.isArray(value)) throw codedError("INVALID_PARAMS", "jobFiles must be an array");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw codedError("INVALID_PARAMS", "jobFiles entries must be objects");
    }
    const file = entry as Record<string, unknown>;
    if (Object.keys(file).some((key) => !["jobId", "path", "sizeBytes", "lastModifiedMs", ...(name === "workFiles" ? ["fileId"] : [])].includes(key)) ||
      typeof file.jobId !== "string" || file.jobId.length === 0 ||
      typeof file.path !== "string" || file.path.length === 0 ||
      typeof file.sizeBytes !== "number" || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 ||
      typeof file.lastModifiedMs !== "number" || !Number.isFinite(file.lastModifiedMs) || file.lastModifiedMs < 0) {
      throw codedError("INVALID_PARAMS", "jobFiles entries must contain jobId, path, sizeBytes, and lastModifiedMs");
    }
    if (name === "workFiles" && (typeof file.fileId !== "string" || !file.fileId)) throw codedError("INVALID_PARAMS", "workFiles entries require fileId");
    return { jobId: file.jobId, path: file.path, sizeBytes: file.sizeBytes, lastModifiedMs: file.lastModifiedMs, ...(name === "workFiles" ? { fileId: file.fileId as string } : {}) };
  });
}

function cleanupAction(params: Record<string, unknown>): CleanupAction {
  const value = requiredString(params, "action");
  const actions: readonly CleanupAction[] = [
    "purge-media", "purge-deleted-nodes", "recycle-nodes", "restore-nodes", "purge-cache", "purge-failed-jobs", "purge-work-files",
  ];
  if (!actions.includes(value as CleanupAction)) throw codedError("INVALID_PARAMS", "action is not a supported cleanup action");
  return value as CleanupAction;
}

function targetFrom(params: Record<string, unknown>): WorkspaceTarget {
  return {
    projectId: requiredString(params, "projectId"),
    workspaceId: requiredString(params, "workspaceId"),
  };
}

function cleanupTargetFrom(params: Record<string, unknown>): CleanupTarget {
  return {
    ...targetFrom(params),
    ...(optionalString(params, "exportId") ? { exportId: optionalString(params, "exportId") } : {}),
    ...(optionalString(params, "cleanupTaskId") ? { cleanupTaskId: optionalString(params, "cleanupTaskId") } : {}),
  };
}

function cleanupRevision(params: Record<string, unknown>): number {
  const value = params.revision;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw codedError("INVALID_PARAMS", "revision must be a non-negative integer");
  }
  return value;
}

/**
 * project-media-gc failures are plain errors from a module the bridges do
 * not own. Until that module grows codes (follow-up), these three messages
 * keep the classification their callers already got — exact-match, so no
 * other message text is ever classified by shape again.
 */
function legacyMediaCleanupCode(message: string): string | undefined {
  switch (message) {
    case "Version node was not found in this project":
      return "NOT_FOUND";
    case "Cleanup project does not match the reviewed plan":
    case "Both version nodes must belong to the requested project":
      return "INVALID_PARAMS";
    default:
      return undefined;
  }
}

/** Map a thrown error to the facade's coarse failure codes (exported for tests). */
export function failureCode(error: unknown): string {
  const code = managerErrorCode(error);
  if (code) return code;
  const message = error instanceof Error ? error.message : String(error);
  return legacyMediaCleanupCode(message) ?? "BRIDGE_ERROR";
}

/** Execute the public workspace command set against the renderer's durable manager. */
export async function handleWorkspaceLibraryRequest(
  verb: WorkspaceLibraryBridgeVerb | undefined,
  rawParams: Record<string, unknown> | undefined,
): Promise<WorkspaceLibraryBridgeReply> {
  if (!verb || !rawParams) {
    return { ok: false, error: { code: "INVALID_PARAMS", message: "workspaceLibrary requires a command and params" } };
  }
  const params = rawParams;
  try {
    switch (verb) {
      case "prepareRenderFonts": {
        const project = params.project as Project | undefined;
        if (!project || typeof project.id !== "string" || !project.settings || !project.timeline || !project.mediaLibrary) {
          throw codedError("INVALID_PARAMS", "project must be a complete project document");
        }
        return { ok: true, result: { project: await prepareProjectRenderFonts(project) } };
      }
      case "project.create": {
        const project = params.project as Project | undefined;
        if (!project || typeof project.id !== "string" || !project.settings || !project.timeline || !project.mediaLibrary) {
          throw codedError("INVALID_PARAMS", "project must be a complete project document");
        }
        const created = await workspaceManager.createProject(project, {
          ...(typeof params.name === "string" ? { name: params.name } : {}),
          ...(typeof params.idempotencyKey === "string" ? { idempotencyKey: params.idempotencyKey } : {}),
          ...(params.requestPayload !== undefined ? { requestPayload: params.requestPayload } : {}),
        });
        return {
          ok: true,
          result: {
            project: created.project,
            projectId: created.project.id,
            defaultWorkspaceId: created.defaultWorkspaceId,
            revision: created.revision,
            ...("replayed" in created ? { replayed: Boolean(created.replayed) } : {}),
          },
        };
      }
      case "project.list":
        return { ok: true, result: { projects: await workspaceManager.listProjects() } };
      case "workspace.list": {
        const projectId = requiredString(params, "projectId");
        return { ok: true, result: { projectId, workspaces: await workspaceManager.listWorkspaces(projectId) } };
      }
      case "workspace.create": {
        const projectId = requiredString(params, "projectId");
        const workspace = await workspaceManager.createWorkspace(projectId, {
          ...(optionalString(params, "name") ? { name: optionalString(params, "name") } : {}),
          ...(optionalString(params, "sourceNodeId") ? { sourceNodeId: optionalString(params, "sourceNodeId") } : {}),
          ...(optionalString(params, "sourceWorkspaceId") ? { sourceWorkspaceId: optionalString(params, "sourceWorkspaceId") } : {}),
          ...(params.kind === "trial" ? { kind: "trial" as const } : {}),
          ...(optionalString(params, "idempotencyKey") ? { idempotencyKey: optionalString(params, "idempotencyKey") } : {}),
        });
        return { ok: true, result: { workspace } };
      }
      case "workspace.delete": {
        const target = targetFrom(params);
        const deleted = await workspaceManager.deleteWorkspace(target, {
          expectedRevision: expectedRevision(params),
          ...(optionalString(params, "idempotencyKey") ? { idempotencyKey: optionalString(params, "idempotencyKey") } : {}),
        });
        return { ok: true, result: { ...target, ...deleted } };
      }
      case "workspace.close": {
        const target = targetFrom(params);
        await workspaceManager.closeWorkspace(target);
        return { ok: true, result: { ...target, closed: true } };
      }
      case "workspace.switch_view": {
        const target = targetFrom(params);
        await workspaceManager.switchView(target);
        return { ok: true, result: { ...target, switched: true } };
      }
      case "workspace.list_drafts": {
        const target = targetFrom(params);
        return { ok: true, result: { ...target, drafts: await workspaceManager.listRecoveryDrafts(target) } };
      }
      case "workspace.recover_draft": {
        const target = targetFrom(params);
        const draftId = requiredString(params, "draftId");
        const result = await workspaceManager.recoverDraft(
          target,
          draftId,
          expectedRevision(params),
          requiredString(params, "idempotencyKey"),
        );
        return { ok: true, result: { ...target, draftId, ...result } };
      }
      case "node.list": {
        const projectId = requiredString(params, "projectId");
        const nodes = await workspaceManager.listNodes(projectId);
        return {
          ok: true,
          result: { projectId, nodes },
        };
      }
      case "node.get": {
        const projectId = requiredString(params, "projectId");
        const nodeId = requiredString(params, "nodeId");
        const node = await workspaceManager.getNode(projectId, nodeId);
        if (!node) throw codedError("NOT_FOUND", `Unknown node ${nodeId}`);
        return { ok: true, result: { projectId, node } };
      }
      case "node.save": {
        const target = targetFrom(params);
        return {
          ok: true,
          result: await workspaceManager.saveNode({
            target,
            expectedRevision: expectedRevision(params),
            idempotencyKey: requiredString(params, "idempotencyKey"),
            ...(optionalString(params, "name") ? { name: optionalString(params, "name") } : {}),
            ...(optionalString(params, "summary") ? { summary: optionalString(params, "summary") } : {}),
          }),
        };
      }
      case "node.restore": {
        const target = targetFrom(params);
        const nodeId = requiredString(params, "nodeId");
        const result = await workspaceManager.restoreNode({
          target,
          nodeId,
          expectedRevision: expectedRevision(params),
          idempotencyKey: requiredString(params, "idempotencyKey"),
        });
        return { ok: true, result: { ...target, nodeId, restored: true, ...result } };
      }
      case "node.rename": {
        const projectId = requiredString(params, "projectId");
        const nodeId = requiredString(params, "nodeId");
        const node = await workspaceManager.renameNode({
          projectId,
          nodeId,
          name: requiredString(params, "name"),
          ...(optionalString(params, "summary") ? { summary: optionalString(params, "summary") } : {}),
        });
        return { ok: true, result: { projectId, nodeId, node } };
      }
      case "node.media": {
        const projectId = requiredString(params, "projectId");
        const nodeId = requiredString(params, "nodeId");
        return { ok: true, result: await listNodeMedia({ projectId, nodeId }) };
      }
      case "node.compare":
        return {
          ok: true,
          result: await compareNodes({
            projectId: requiredString(params, "projectId"),
            fromNodeId: requiredString(params, "fromNodeId"),
            toNodeId: requiredString(params, "toNodeId"),
          }),
        };
      case "media.references":
        return {
          ok: true,
          result: {
            projectId: requiredString(params, "projectId"),
            mediaId: requiredString(params, "mediaId"),
            references: await getMediaReferences({
              projectId: requiredString(params, "projectId"),
              mediaId: requiredString(params, "mediaId"),
              ...(optionalString(params, "workspaceId") ? { workspaceId: optionalString(params, "workspaceId") } : {}),
            }),
          },
        };
      case "media.cleanup.review":
        return {
          ok: true,
          result: await getCleanupReview(cleanupTargetFrom(params), stringArray(params, "selectedNodeIds")),
        };
      case "media.cleanup.plan": {
        const action = cleanupAction(params);
        return {
          ok: true,
          result: await createCleanupPlan(cleanupTargetFrom(params), action, {
            nodeIds: stringArray(params, "nodeIds"),
            mediaIds: stringArray(params, "mediaIds"),
            cacheKeys: stringArray(params, "cacheKeys"),
            jobIds: stringArray(params, "jobIds"),
            workFileIds: stringArray(params, "workFileIds"),
          }),
        };
      }
      case "media.cleanup.execute": {
        if (params.confirmed !== true) throw codedError("INVALID_PARAMS", "confirmed must be true after reviewing the exact cleanup scope");
        return {
          ok: true,
          result: await executeCleanupPlan({
            planId: requiredString(params, "planId"),
            target: cleanupTargetFrom(params),
            action: cleanupAction(params),
            revision: cleanupRevision(params),
            workspaceInstanceId: requiredString(params, "workspaceInstanceId"),
            nodeIds: requiredStringArray(params, "nodeIds"),
            mediaIds: requiredStringArray(params, "mediaIds"),
            cacheKeys: requiredStringArray(params, "cacheKeys"),
            cleanupTaskNodeIds: requiredStringArray(params, "cleanupTaskNodeIds"),
            jobIds: requiredStringArray(params, "jobIds"),
            jobFiles: requiredCleanupTaskFiles(params),
            ...(params.workFiles !== undefined ? { workFiles: requiredCleanupTaskFiles(params, "workFiles") as import("../../../../desktop/src/shared/project-library-cleanup").ProjectLibraryTrackedWorkFingerprint[] } : {}),
            confirmed: true,
          }),
        };
      }
      case "retainTaskInputs": {
        const inputProject = await workspaceManager.retainTaskInputs({
          jobId: requiredString(params, "jobId"),
          projectId: requiredString(params, "projectId"),
          workspaceId: requiredString(params, "workspaceId"),
          sourceRevision: expectedRevision({ expectedRevision: params.sourceRevision }),
          inputProject: params.inputProject as Project,
        });
        return { ok: true, result: { retained: true, inputProject } };
      }
      case "releaseTaskInputs":
        await workspaceManager.releaseTaskInputs(requiredString(params, "jobId"));
        return { ok: true, result: { released: true } };
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: failureCode(error),
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
