/**
 * @openreel/agent-facade — the agent-facing facade (Slice 1 + Slice 1b +
 * Slice 2a persistence + Slice 3 live collaboration).
 *
 * Pure-Node, in-process, transport-agnostic. The public surface is the
 * fifteen-verb `AgentFacade` object returned by createAgentFacade(); verb
 * names mirror audit/facade-v0.md + ADR 0003 Appendix B.1 + ADR 0004
 * (editor.get_context). All verbs return FacadeResult<T> and never throw
 * for domain errors. Pixel/export/verify backing arrives via the
 * independent provider interfaces (providers.ts); the facade never imports
 * Chromium, Playwright or ffmpeg itself. Live sessions (createLiveFacade,
 * ADR 0004) implement the same verb contract over a LiveProjectStore seam
 * with no project copy.
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
  EditorGetContextResult,
  ExportStartParams,
  ExportStartResult,
  JobParams,
  JobStatusView,
  MediaImportParams,
  MediaImportResult,
  PreviewRenderFrameParams,
  PreviewRenderFrameResult,
  ProjectCreateParams,
  ProjectCreateResult,
  ProjectOpenParams,
  ProjectOpenResult,
  ProjectSaveParams,
  ProjectSaveResult,
  ProjectState,
  SessionDescription,
  TimelineState,
  VerifyArtifactParams,
  VerifyArtifactResult,
} from "./types";

export interface AgentFacade {
  readonly "session.describe": () => Promise<FacadeResult<SessionDescription>>;
  readonly "capabilities.get": () => Promise<FacadeResult<Capabilities>>;
  readonly "project.create": (
    params?: ProjectCreateParams,
  ) => Promise<FacadeResult<ProjectCreateResult>>;
  readonly "project.open": (
    params: ProjectOpenParams,
  ) => Promise<FacadeResult<ProjectOpenResult>>;
  readonly "project.save": (
    params: ProjectSaveParams,
  ) => Promise<FacadeResult<ProjectSaveResult>>;
  readonly "project.get_state": () => Promise<FacadeResult<ProjectState>>;
  readonly "media.import": (
    params: MediaImportParams,
  ) => Promise<FacadeResult<MediaImportResult>>;
  readonly "timeline.get": () => Promise<FacadeResult<TimelineState>>;
  readonly "editor.get_context": (
    params?: Record<string, never>,
  ) => Promise<FacadeResult<EditorGetContextResult>>;
  readonly "edit.apply": (
    params: EditApplyParams,
  ) => Promise<FacadeResult<EditApplyResult>>;
  readonly "preview.render_frame": (
    params: PreviewRenderFrameParams,
  ) => Promise<FacadeResult<PreviewRenderFrameResult>>;
  readonly "export.start": (
    params: ExportStartParams,
  ) => Promise<FacadeResult<ExportStartResult>>;
  readonly "job.status": (
    params: JobParams,
  ) => Promise<FacadeResult<JobStatusView>>;
  readonly "job.cancel": (
    params: JobParams,
  ) => Promise<FacadeResult<JobStatusView>>;
  readonly "verify.artifact": (
    params: VerifyArtifactParams,
  ) => Promise<FacadeResult<VerifyArtifactResult>>;
}

/**
 * Create an in-process facade session. One session owns one open project,
 * its revision counter, its idempotency ledger and its job registry.
 */
export function createAgentFacade(config: AgentFacadeConfig = {}): AgentFacade {
  const session = new AgentFacadeSession(config);
  return {
    "session.describe": () => session.sessionDescribe(),
    "capabilities.get": () => session.capabilitiesGet(),
    "project.create": (params) => session.projectCreate(params),
    "project.open": (params) => session.projectOpen(params),
    "project.save": (params) => session.projectSave(params),
    "project.get_state": () => session.projectGetState(),
    "media.import": (params) => session.mediaImport(params),
    "timeline.get": () => session.timelineGet(),
    "editor.get_context": (params) => session.editorGetContext(params),
    "edit.apply": (params) => session.editApply(params),
    "preview.render_frame": (params) => session.previewRenderFrame(params),
    "export.start": (params) => session.exportStart(params),
    "job.status": (params) => session.jobStatus(params),
    "job.cancel": (params) => session.jobCancel(params),
    "verify.artifact": (params) => session.verifyArtifact(params),
  };
}

export { AgentFacadeSession, createAgentFacadeSession } from "./session";
export type { AgentFacadeConfig } from "./session";
export { createLiveFacade, LiveFacadeSession, LIVE_UNAVAILABLE_VERBS } from "./live-session";
export type { LiveAgentFacade, LiveFacadeConfig } from "./live-session";
export {
  isLiveStoreConflict,
  LiveStoreConflictError,
} from "./live-store";
export type {
  LiveApplyActionsOptions,
  LiveApplyActionsResult,
  LiveEditorContext,
  LiveProjectIdentity,
  LiveProjectStore,
} from "./live-store";
export { LiveWriterLease } from "./live-lease";
export {
  FacadeError,
  FACADE_ERROR_CODES,
  type FacadeErrorBody,
  type FacadeErrorCode,
  type FacadeResult,
} from "./errors";
export type { ProjectRenderAdapter } from "./render/adapter";
export { JobRegistry, JOB_STATES, jobStatusView } from "./jobs";
export type { JobProgressView, JobRecord, JobState } from "./jobs";
export type {
  ArtifactProbeExpectation,
  ArtifactProbeReport,
  ArtifactRef,
  ArtifactVerifier,
  ExportCallbacks,
  ExportCompletion,
  ExportProgressEvent,
  ExportProvider,
  ExportVideoRequest,
  MediaFilesMap,
  PixelCompareRequest,
  ProviderPreflight,
  RenderedFrameInfo,
  RenderFrameRequest,
  RenderProvider,
  VerifyArtifactRequest,
  VerifyCheck,
  VerifyReport,
} from "./providers";
export { createEmptyProject, DEFAULT_PROJECT_SETTINGS } from "./project-factory";
export {
  buildCheckpointDocument,
  buildMediaRefs,
  CHECKPOINT_FORMAT,
  CHECKPOINT_FORMAT_VERSION,
  computeStateSha256,
  findMediaBindingOffenders,
  MAX_CHECKPOINT_BYTES,
  SUPPORTED_CHECKPOINT_FORMAT_VERSIONS,
} from "./checkpoint";
export type { CheckpointDocument, CheckpointMediaRef } from "./checkpoint";
export {
  emitObjectSchema,
  EMITTED_VERB_JSON_SCHEMAS,
} from "./jsonschema";
export type { JsonSchemaNode, JsonSchemaObject } from "./jsonschema";
export {
  VERB_PARAM_SCHEMAS,
  PROJECT_SETTINGS_SCHEMA,
} from "./verb-schemas";
export {
  VERB_SCHEMA_CORPUS,
  type VerbSchemaCorpusCase,
} from "./verb-schema-corpus";
export * from "./types";
