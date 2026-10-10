import type {
  WorkspaceLibraryBridgeReply,
  WorkspaceLibraryBridgeVerb,
} from "@reelterminal/agent-facade/workspace-library";
import type { Project } from "@reelterminal/core";
import {
  compareNodes,
  executeMediaCleanupById,
  getMediaReferences,
  listNodeMedia,
  planMediaCleanup,
} from "../project-media-gc";
import { prepareProjectRenderFonts } from "../project-render-dependencies";
import { workspaceManager, type WorkspaceTarget } from "../workspace-manager";

function requiredString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function expectedRevision(params: Record<string, unknown>): number {
  const value = params.expectedRevision;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("expectedRevision must be a non-negative integer");
  }
  return value;
}

function optionalString(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function targetFrom(params: Record<string, unknown>): WorkspaceTarget {
  return {
    projectId: requiredString(params, "projectId"),
    workspaceId: requiredString(params, "workspaceId"),
  };
}

/** Map a thrown error to the facade's coarse failure codes (exported for tests). */
export function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/revision conflict|revision mismatch|changed while|runtime changed|idempotency key.+different|already retained with different/i.test(message)) return "CONFLICT";
  if (/unknown (project|workspace|node|recovery draft)|not found|does not belong/i.test(message)) return "NOT_FOUND";
  if (/required|must be|cannot be deleted|does not match/i.test(message)) return "INVALID_PARAMS";
  return "BRIDGE_ERROR";
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
          throw new Error("project must be a complete project document");
        }
        return { ok: true, result: { project: await prepareProjectRenderFonts(project) } };
      }
      case "project.create": {
        const project = params.project as Project | undefined;
        if (!project || typeof project.id !== "string" || !project.settings || !project.timeline || !project.mediaLibrary) {
          throw new Error("project must be a complete project document");
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
        if (!node) throw new Error(`Unknown node ${nodeId}`);
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
      case "media.cleanup.plan":
        return { ok: true, result: await planMediaCleanup({ ...(optionalString(params, "projectId") ? { projectId: optionalString(params, "projectId") } : {}) }) };
      case "media.cleanup.execute":
        return {
          ok: true,
          result: await executeMediaCleanupById(
            requiredString(params, "planId"),
            optionalString(params, "projectId"),
          ),
        };
      case "retainTaskInputs":
        const inputProject = await workspaceManager.retainTaskInputs({
          jobId: requiredString(params, "jobId"),
          projectId: requiredString(params, "projectId"),
          workspaceId: requiredString(params, "workspaceId"),
          sourceRevision: expectedRevision({ expectedRevision: params.sourceRevision }),
          inputProject: params.inputProject as Project,
        });
        return { ok: true, result: { retained: true, inputProject } };
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
