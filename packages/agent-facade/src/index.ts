/**
 * @openreel/agent-facade — the agent-facing facade (Slice 1 + Slice 1b +
 * Slice 2a persistence + Slice 3 live collaboration).
 *
 * Pure-Node, in-process, transport-agnostic. The public surface is the
 * seventeen-verb `AgentFacade` object returned by createAgentFacade(); verb
 * names mirror audit/facade-v0.md + ADR 0003 Appendix B.1 + ADR 0004
 * (editor.get_context/editor.control). All verbs return FacadeResult<T> and never throw
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
  VisualInspectParams,
  VisualInspectResult,
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
  readonly "editor.control": (
    params: import("./live-store").LiveEditorControlParams,
  ) => Promise<FacadeResult<import("./live-store").LiveEditorControlResult>>;
  readonly "edit.apply": (
    params: EditApplyParams,
  ) => Promise<FacadeResult<EditApplyResult>>;
  readonly "preview.render_frame": (
    params: PreviewRenderFrameParams,
  ) => Promise<FacadeResult<PreviewRenderFrameResult>>;
  readonly "visual.inspect": (
    params: VisualInspectParams,
  ) => Promise<FacadeResult<VisualInspectResult>>;
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
    "editor.control": (params) => session.editorControl(params),
    "edit.apply": (params) => session.editApply(params),
    "preview.render_frame": (params) => session.previewRenderFrame(params),
    "visual.inspect": (params) => session.visualInspect(params),
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
  AGENT_WORK_MODES,
  AGENT_WORK_MODE_SEMANTICS,
  DEFAULT_AGENT_ACCESS_MODE,
  DEFAULT_AGENT_WORK_MODE,
  agentWorkModeSemantics,
  isAgentAccessMode,
  isAgentWorkMode,
  migrateLegacyAgentMode,
  normalizeAgentModePreference,
} from "./work-mode";
export type {
  AgentAccessMode,
  AgentModePreference,
  AgentWorkMode,
  AgentWorkModeSemantics,
  LegacyAgentMode,
} from "./work-mode";
export {
  isLiveStoreConflict,
  LiveStoreConflictError,
} from "./live-store";
export type {
  LiveApplyActionsOptions,
  LiveApplyActionsResult,
  LiveMediaImportRequest,
  LiveMediaImportResult,
  LiveEditorContext,
  LiveEditorReference,
  LiveEditorReferenceKind,
  LiveEditorReferences,
  LiveProjectIdentity,
  LiveProjectStore,
  LiveEditorControlParams,
  LiveEditorControlResult,
  LiveEditorControlTarget,
  LiveEditorControlTargetKind,
} from "./live-store";
export { LiveWriterLease } from "./live-lease";
export {
  ConversationBridge,
  ExternalConversationBridge,
  ExternalConversationBridgeError,
  createExternalConversationBridge,
} from "./conversation-bridge";
export type {
  ExternalConversationBridgeOptions,
  ExternalConversationPromptReceipt,
} from "./conversation-bridge";
export {
  EXTERNAL_CONVERSATION_CAPABILITIES,
  EXTERNAL_CONVERSATION_METHODS,
  OPENREEL_CONVERSATION_CLIENT,
  OPENREEL_CONVERSATION_PROTOCOL_VERSION,
  isExternalAgentInitializeResult,
  isExternalAgentConversationCapabilities,
  isExternalAgentSessionUpdate,
  isExternalAgentSessionUpdateNotification,
  normalizeExternalConversationCapabilities,
  projectExternalAgentPromptResult,
  projectExternalAgentSessionUpdate,
} from "./conversation-protocol";
export type {
  ConversationAttachmentLease,
  ExternalAgentApprovalDecision,
  ExternalAgentApprovalParams,
  ExternalAgentClientInfo,
  ExternalAgentCloseParams,
  ExternalAgentConnector,
  ExternalAgentContent,
  ExternalAgentInfo,
  ExternalAgentInitializeParams,
  ExternalAgentInitializeResult,
  ExternalAgentNotification,
  ExternalAgentPairing,
  ExternalAgentPromptParams,
  ExternalAgentPromptResult,
  ExternalAgentResumeParams,
  ExternalAgentSafeError,
  ExternalAgentSessionCapabilities,
  ExternalAgentSessionUpdate,
  ExternalAgentSessionUpdateNotification,
  ExternalAgentToolDisplayFields,
  ExternalAgentToolStatus,
  ExternalAgentTransport,
  ExternalAgentWorkModeContext,
  ExternalAgentWorkModeParams,
  ExternalAgentConversationCapabilities,
  ExternalConversationDisplayState,
  ExternalConversationCapability,
  ExternalConversationCapabilityState,
  ExternalConversationCapabilitySupport,
  ExternalConversationDisconnectReason,
  ExternalConversationError,
  ExternalConversationErrorCode,
  ExternalConversationEvent,
  ExternalConversationFallback,
  ExternalConversationLifecycle,
  ExternalConversationMethod,
  ExternalConversationOwnership,
} from "./conversation-protocol";
export {
  createConversationDisplayState,
  DEFAULT_CONVERSATION_DISPLAY_LIMIT,
  reduceConversationDisplayState,
} from "./conversation-state";
export type { ConversationStatePatch } from "./conversation-state";
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
  RenderContactSheetRequest,
  RenderedContactSheetInfo,
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
  LIVE_VERB_INPUT_SCHEMA_OVERRIDES,
} from "./jsonschema";
export type { JsonSchemaNode, JsonSchemaObject } from "./jsonschema";
export { EMITTED_VERB_OUTPUT_JSON_SCHEMAS } from "./output-schemas";
export type { OutputSchemaNode, OutputSchemaObject } from "./output-schemas";
export {
  MAX_EDIT_OPS_PER_BATCH,
  VERB_PARAM_SCHEMAS,
  PROJECT_SETTINGS_SCHEMA,
} from "./verb-schemas";
export {
  VERB_SCHEMA_CORPUS,
  type VerbSchemaCorpusCase,
} from "./verb-schema-corpus";
export * from "./types";
