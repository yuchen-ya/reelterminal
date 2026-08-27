/**
 * @openreel/agent-facade — the Slice-1 agent-facing facade.
 *
 * Pure-Node, in-process, transport-agnostic. The public surface is the
 * seven-verb `AgentFacade` object returned by createAgentFacade(); verb
 * names mirror audit/facade-v0.md. All verbs return FacadeResult<T> and
 * never throw for domain errors.
 */
import {
  AgentFacadeSession,
  type AgentFacadeConfig,
} from "./session";
import type { FacadeResult } from "./errors";
import type {
  Capabilities,
  EditApplyParams,
  EditApplyResult,
  MediaImportParams,
  MediaImportResult,
  ProjectCreateParams,
  ProjectCreateResult,
  ProjectState,
  SessionDescription,
  TimelineState,
} from "./types";

export interface AgentFacade {
  readonly "session.describe": () => Promise<FacadeResult<SessionDescription>>;
  readonly "capabilities.get": () => Promise<FacadeResult<Capabilities>>;
  readonly "project.create": (
    params?: ProjectCreateParams,
  ) => Promise<FacadeResult<ProjectCreateResult>>;
  readonly "project.get_state": () => Promise<FacadeResult<ProjectState>>;
  readonly "media.import": (
    params: MediaImportParams,
  ) => Promise<FacadeResult<MediaImportResult>>;
  readonly "timeline.get": () => Promise<FacadeResult<TimelineState>>;
  readonly "edit.apply": (
    params: EditApplyParams,
  ) => Promise<FacadeResult<EditApplyResult>>;
}

/**
 * Create an in-process facade session. One session owns one open project,
 * its revision counter and its idempotency ledger.
 */
export function createAgentFacade(config: AgentFacadeConfig = {}): AgentFacade {
  const session = new AgentFacadeSession(config);
  return {
    "session.describe": () => session.sessionDescribe(),
    "capabilities.get": () => session.capabilitiesGet(),
    "project.create": (params) => session.projectCreate(params),
    "project.get_state": () => session.projectGetState(),
    "media.import": (params) => session.mediaImport(params),
    "timeline.get": () => session.timelineGet(),
    "edit.apply": (params) => session.editApply(params),
  };
}

export { AgentFacadeSession, createAgentFacadeSession } from "./session";
export type { AgentFacadeConfig } from "./session";
export {
  FacadeError,
  FACADE_ERROR_CODES,
  type FacadeErrorBody,
  type FacadeErrorCode,
  type FacadeResult,
} from "./errors";
export type { ProjectRenderAdapter } from "./render/adapter";
export { createEmptyProject, DEFAULT_PROJECT_SETTINGS } from "./project-factory";
export * from "./types";
