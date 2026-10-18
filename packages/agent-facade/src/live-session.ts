import { AUDIO_NORMALIZE_MAX_RANGE_SEC } from "./audio-normalize";
import { AUDIO_DENOISE_MAX_RANGE_SEC } from "./audio-denoise";
import { runAudioNormalizationTask, runAudioDenoiseTask, completedAudioArtifact, verifyAudioArtifact } from "./audio-process-task";
import type { AudioProcessDenoiseParams, AudioProcessDenoiseResult, AudioProcessNormalizeParams, AudioProcessNormalizeResult, AudioProcessRegisterParams, AudioProcessRegisterResult } from "./types";
import { AUDIO_PROCESS_DENOISE_SCHEMA, AUDIO_PROCESS_NORMALIZE_SCHEMA, AUDIO_PROCESS_REGISTER_SCHEMA } from "./verb-schemas";
import { reviewVideo, videoReviewPreflight } from "./video-review";
import { AUDIO_LIMITS, analyzeBeatGrid, analyzeLocalAudio, analyzeSilence, audioAnalysisPreflight, resolveSilenceAnalysisParams } from "./audio-analysis";
import { analyzeSpeechActivity, resolveSpeechVadParams, speechVadRuntimePreflight } from "./speech-vad";
import { transcribeSpeechRegions, resolveTranscriptParams, assertTranscriptModelReady, type ResolvedTranscriptParams } from "./speech-transcript";
import { probeAudioModelsRuntime } from "./media/audio-models-runner";
import { analyzeSyncOffset, resolveSyncOffsetParams, SYNC_OFFSET_ANALYSIS_RATE, type ResolvedSyncOffsetParams, type SyncOffsetReference } from "./sync-offset";
import { runVideoCandidateAnalyses, videoCandidatesPreflight, type VideoCandidateBundle } from "./video-candidates";
import { resolveToolFfmpeg } from "./media/ffmpeg-bin";
import { probeVideoFacts } from "./media/frame-exact";
import { bindBundledTools } from "./plugin-runtime";
import { withValidatedFacadeCalls } from "./request-validation";
/**
 * LiveFacadeSession — the live agent facade. It implements the same
 * registered contract as AgentFacadeSession:
 *
 *  - It holds NO project copy. The renderer's store stays canonical
 *    every verb works from on-demand `LiveProjectStore` snapshots, and every
 *    mutation is translated to core actions by the same ops.ts translator as
 *    headless, then
 *    committed through `store.applyActions` as ONE undo unit with CAS
 *    preconditions (Decisions 3/4).
 *  - CLI and MCP clients share the desktop host's external writer identity;
 *    construction acquires the `LiveWriterLease` for write-enabled sessions;
 *    a session without it runs
 *    read-only and its write verbs fail CONFLICT naming the holder. The
 *    human never takes the lease and can always edit.
 *  - Read/write access is an independent facade boundary: read-only access
 *    rejects write verbs with FORBIDDEN.
 *  - Honesty: project.create creates a distinct project without switching the GUI; project.open
 *    remains unavailable in live mode; preview/export run on a snapshot
 *    and require its media to be file-backed and readable from THIS process
 *    — blob/GUI-only media fails loudly instead of silently rendering
 *    wrong pixels. Text-only projects render fine.
 *
 * Calls serialize per explicit project/workspace target so unrelated workspaces
 * can progress independently.
 */
import { ActionExecutor } from "@reelterminal/core/actions/action-executor";
import { ActionHistory } from "@reelterminal/core/actions/action-history";
import type { Action } from "@reelterminal/core/types/actions";
import type { Project, ProjectSettings } from "@reelterminal/core/types/project";
import { stat } from "node:fs/promises";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";

import {
  artifactRefFor,
  assertContainedWrittenFile,
  prepareArtifactDir,
  requireArtifactRoot,
  requireProviderPreflight,
} from "./artifact-io";
import { buildCapabilities, buildSessionDescription } from "./capabilities";
import {
  FacadeError,
  FACADE_ERROR_CODES,
  ok,
  toFailure,
  type FacadeResult,
  type FacadeErrorCode,
} from "./errors";
import type { AgentFacade } from "./index";
import {
  deliverExportArtifact,
  resolveDeliveryDestination,
  type DeliveryDestination,
} from "./delivery";
import {
  IdempotencyLedger,
  stableStringify,
  type LedgerReceipt,
} from "./idempotency";
import {
  assertMediaFingerprintsUnchanged,
  discardArtifact,
  fingerprintMediaFiles,
  inspectionRequestKey,
  pendingArtifactPath,
  publishArtifact,
} from "./inspection-artifacts";
import { cancelExportWithin, JobRegistry, jobStatusView, type JobDeliveryOutcome } from "./jobs";
import { queryTimeline } from "./timeline-query";
import { mapTimelineSourceTimes } from "./timeline-source-map";
import { validateEditPlan } from "./edit-validation";
import type { LiveWriterLease } from "./live-lease";
import {
  isLiveStoreConflict,
  LiveStoreConflictError,
  type LiveApplyActionsResult,
  type LiveMediaImportRequest,
  type LiveMediaImportResult,
  type LiveEditorControlParams,
  type LiveEditorControlResult,
  type LiveProjectStore,
} from "./live-store";
import {
  liveControlBridgeFailure,
  liveUnavailable,
  materialBridgeFailure,
  presetBridgeFailure,
} from "./live-bridge-errors";
import {
  assertPresetApplyTarget,
  assertPresetPayloadValid,
  resolveFontUploadBytes,
  resolveLibraryMediaPath,
} from "./live-library-params";
import {
  partitionCreatedIds,
  type EditApplyPayload,
} from "./edit-apply-partition";
import { hasUrlScheme, resolveContainedPathDetailed } from "./media/path-roots";
import { probeLocalMediaFile } from "./media/node-media-adapter";
import { produceHtmlRenderArtifact } from "./media-render-html";
import { assessColorSupport, probeColorMetadata } from "./color-policy";
import {
  compactAnalysisFacts,
  getAnalysisRecordView,
  listAnalysisRecords,
  removeAnalysisRecord,
  resolveRecheckTarget,
  saveAnalysisRecord,
  validateAnalysisGetQuery,
} from "./analysis-records";
import {
  composeComparisonVideo,
  referenceFilePath,
  renderComparisonStill,
  requireComparisonConfig,
  validateComparisonRange,
  withComparisonReference,
} from "./reference-comparison";
import { opToCoreActions } from "./ops";
import { prepareEditOp, type PrepareEditOpOptions } from "./edit-op-preparation";
import { buildAnalysisProgressPlan } from "./analysis-progress";
import {
  projectStateView,
  timelineDurationSec,
  timelineStateView,
} from "./projection";
import type {
  ArtifactVerifier,
  ExportCallbacks,
  ExportProvider,
  RenderProvider,
  RenderContactSheetRequest,
  VerifyArtifactRequest,
} from "./providers";
import { validateObject } from "./validate";
import {
  REQUIREMENTS_LIST_SCHEMA, REQUIREMENTS_GET_SCHEMA,
  type RequirementsListParams, type RequirementsListResult,
  type RequirementsGetParams, type RequirementsGetResult,
} from "./requirements";
import {
  EDIT_APPLY_SCHEMA,
  EMPTY_PARAMS_SCHEMA,
  EXPORT_SETTINGS_SCHEMA,
  EXPORT_START_SCHEMA,
  isEvenDimension,
  JOB_PARAMS_SCHEMA,
  MEDIA_IMPORT_SCHEMA,
  MEDIA_RENDER_HTML_SCHEMA,
  MEDIA_ANALYZE_START_SCHEMA,
  normalizeProjectName,
  ANALYSIS_GET_SCHEMA,
  ANALYSIS_LIST_SCHEMA,
  PREVIEW_RENDER_COMPARISON_SCHEMA,
  PREVIEW_RENDER_FRAME_SCHEMA,
  PROJECT_RENAME_SCHEMA,
  PROJECT_CREATE_SCHEMA,
  PROJECT_SETTINGS_SCHEMA,
  VISUAL_INSPECT_SCHEMA,
  VERIFY_ARTIFACT_SCHEMA,
  EDITOR_CONTROL_SCHEMA,
  PROJECT_CHANGES_SCHEMA,
  TIMELINE_QUERY_SCHEMA,
  TIMELINE_MAP_SOURCE_TIMES_SCHEMA,
  EDIT_VALIDATE_SCHEMA,
  HISTORY_GET_SCHEMA,
  HISTORY_CONTROL_SCHEMA,
  MATERIAL_LIST_SCHEMA,
  MATERIAL_GET_SCHEMA,
  MATERIAL_CREATE_SCHEMA,
  MATERIAL_UPDATE_SCHEMA,
  MATERIAL_BATCH_UPDATE_SCHEMA,
  MATERIAL_REMOVE_SCHEMA,
  MATERIAL_ATTACH_SCHEMA,
  MATERIAL_UNDO_SCHEMA,
  FONT_UPLOAD_SCHEMA,
  PRESET_LIST_SCHEMA,
  PRESET_GET_SCHEMA,
  PRESET_CREATE_SCHEMA,
  PRESET_UPDATE_SCHEMA,
  PRESET_REMOVE_SCHEMA,
  PRESET_APPLY_SCHEMA,
  HELP_DESCRIBE_SCHEMA,
  HELP_LIST_SCREENS_SCHEMA,
  HELP_SEARCH_SCHEMA,
} from "./verb-schemas";
import {
  describeManualScreen,
  listManualScreens,
  searchManualScreens,
} from "./gui-manual";
import {
  MATERIAL_VERBS,
  type MaterialLibraryBridge,
  type MaterialLibraryBridgeReply,
  type MaterialLibraryBridgeVerb,
  type MaterialListParams,
  type MaterialGetParams,
  type MaterialGetResult,
  type MaterialCreateParams,
  type MaterialCreateResult,
  type MaterialUpdateParams,
  type MaterialUpdateResult,
  type MaterialBatchUpdateParams,
  type MaterialBatchUpdateResult,
  type MaterialRemoveParams,
  type MaterialRemoveResult,
  type MaterialAttachParams,
  type MaterialAttachResult,
  type MaterialUndoParams,
  type MaterialUndoResult,
} from "./material-library";
import {
  type FontLibraryBridge,
  type FontLibraryBridgeReply,
  type FontLibraryBridgeVerb,
  type FontListParams,
  type FontListResult,
  type FontUploadParams,
  type FontUploadResult,
} from "./font-library";
import {
  type PresetApplyParams,
  type PresetApplyResult,
  type PresetCreateParams,
  type PresetCreateResult,
  type PresetGetParams,
  type PresetGetResult,
  type PresetLibraryBridge,
  type PresetLibraryBridgeReply,
  type PresetLibraryBridgeVerb,
  type PresetListParams,
  type PresetListResult,
  type PresetRemoveParams,
  type PresetRemoveResult,
  type PresetUpdateParams,
  type PresetUpdateResult,
} from "./preset-verbs";
import {
  validatePresetName,
  validatePresetThumbnail,
} from "@reelterminal/core/presets/validate";
import type { MaterialListResult } from "@reelterminal/core/material/types";
import {
  isReadOnlyVerb,
  type Capabilities,
  type CapabilitiesGetParams,
  type EditApplyParams,
  type EditApplyResult,
  type EditorGetContextResult,
  type ExportStartParams,
  type ExportStartResult,
  type FacadeVerb,
  type JobParams,
  type JobStatusView,
  type LiveProjectSaveResult,
  type MediaImportParams,
  type MediaImportResult,
  type MediaRenderHtmlParams,
  type MediaRenderHtmlResult,
  type MediaAnalyzeStartParams,
  type MediaAnalyzeStartResult,
  type PreviewRenderFrameParams,
  type PreviewRenderFrameResult,
  type VisualInspectParams,
  type VisualInspectResult,
  type ProjectCreateParams,
  type ProjectCreateResult,
  type ProjectOpenParams,
  type ProjectOpenResult,
  type ProjectRenameParams,
  type ProjectRenameResult,
  type ProjectState,
  type SessionDescription,
  type TimelineState,
  type ProjectChangesParams,
  type ProjectChangesResult,
  type TimelineQueryParams,
  type TimelineQueryResult,
  type TimelineMapSourceTimesParams,
  type TimelineMapSourceTimesResult,
  type EditValidateParams,
  type EditValidateResult,
  type EditOp,
  type HistoryGetParams,
  type HistoryGetResult,
  type HistoryControlParams,
  type HistoryControlResult,
  type VerifyArtifactParams,
  type VerifyArtifactResult,
  AnalysisGetParams,
  AnalysisListParams,
  AnalysisListResult,
  PreviewRenderComparisonParams,
  PreviewRenderComparisonResult,
} from "./types";
import {
  DEFAULT_AGENT_ACCESS_MODE,
  type AgentAccessMode,
} from "./access";
import {
  MAX_VISUAL_PNG_BYTES,
} from "./visual-inspect";
import {
  assertValidEditBatch,
  parseEditOps,
  parseVerifyCompare,
  parseVerifyExpect,
  prepareVisualInspectRenderPlan,
  resolveVerifyArtifactTarget,
  resolveVerifyReferencePath,
  buildVerifyCompareRequest,
  validateEditOpList,
  validateEditorControlAction,
  validateEditorControlTargets,
  validateTimelineQueryTimeRange,
  validateVisualInspectTimeRange,
} from "./verb-param-rules";
import { DEFAULT_FRAME_BUDGET_BYTES, fitFrameToBudget } from "./frame-budget";
import { createEmptyProject } from "./project-factory";
import { WORKSPACE_VERB_SCHEMAS } from "./workspace-schemas";
import type {
  WorkspaceLibraryBridge,
  WorkspaceLibraryBridgeRequest,
  WorkspaceLibraryBridgeReply,
  WorkspaceVerb,
  RetainTaskInputsParams,
} from "./workspace-library";
import { WORKSPACE_VERBS } from "./workspace-library";

/** Max media file size accepted for Chromium reads (2 GiB safety valve). */
const MAX_MEDIA_FILE_BYTES = 2 * 1024 * 1024 * 1024;
/**
 * Live import currently crosses Electron IPC as one ArrayBuffer. Keep that
 * transfer far below the Chromium-read ceiling so a valid request cannot
 * exhaust the renderer before its own identical guard runs.
 */
const MAX_LIVE_IMPORT_FILE_BYTES = 256 * 1024 * 1024;
/** Shared live export/analysis lane stays bounded while edits commit immediately. */
const MAX_ACTIVE_LIVE_TASKS = 2;

/**
 * Verbs that exist in the contract but are honestly unavailable in live
 * mode (Decision 11). The GUI still owns opening project files; project
 * creation and workspace selection are explicit manager operations.
 */
export const LIVE_UNAVAILABLE_VERBS = [
  "project.open",
] as const satisfies readonly FacadeVerb[];

export interface LiveTaskInput extends RetainTaskInputsParams {
  readonly kind: "export" | "analysis" | "audio-process";
  readonly inputProject: Project;
  readonly parameters: unknown;
}

export interface LivePersistedTaskRecord {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly status: JobStatusView;
  readonly parameters?: unknown;
}

export interface LiveTaskLifecycle {
  list(): readonly LivePersistedTaskRecord[];
  begin(input: LiveTaskInput): void;
  update(status: JobStatusView): void;
}

export interface LiveTaskInputReferences {
  retain(input: LiveTaskInput): Promise<Project | void>;
  release(jobId: string): Promise<void>;
}

export interface LiveFacadeConfig {
  /** The canonical-store seam (Decision 1). */
  readonly store: LiveProjectStore;
  /** Absolute roots from which media.import may read local files. */
  readonly mediaRoots?: readonly string[];
  /**
   * Absolute roots under which export.start's destinationPath may deliver a
   * verified artifact copy (`<deliveryRoot>/jobs/<slug>/output/`) — same
   * rule as headless (docs/AGENT-WORKSPACE.md). Default: none.
   */
  readonly deliveryRoots?: readonly string[];
  /** preview.render_frame backing (same provider type as headless). */
  readonly renderProvider?: RenderProvider;
  /** export.start / job.cancel backing (same provider type as headless). */
  readonly exportProvider?: ExportProvider;
  /** verify.artifact backing (same provider type as headless). */
  readonly artifactVerifier?: ArtifactVerifier;
  /** The shared single-writer lease (Decision 6), held by the session host. */
  readonly lease: LiveWriterLease;
  /** Identity of THIS AI session, used as the lease holder id. */
  readonly sessionId: string;
  /**
   * Explicit authorization boundary. A
   * getter lets the desktop recover a safely migrated read-only preference
   * without replacing the facade (and losing jobs/idempotency state).
   */
  readonly access?: AgentAccessMode | (() => AgentAccessMode);
  /**
   * Absolute root every generated artifact (preview PNGs, exported videos)
   * is written under, with the same containment discipline as headless.
   */
  readonly artifactRoot: string;
  /** Export job tracking; defaults to a fresh in-memory JobRegistry. */
  readonly jobTracker?: JobRegistry;
  /**
   * The user-level material library seam: forwards material.* verbs to the
   * GUI renderer, which owns the canonical records, journal, and IndexedDB
   * persistence. Absent ⇒ the material verbs report UNSUPPORTED honestly.
   */
  readonly materialLibrary?: MaterialLibraryBridge;
  /**
   * The user-level custom-font seam: forwards font.* verbs to the GUI
   * renderer, which owns the canonical font store (IndexedDB +
   * FontFace activation). Absent ⇒ the font verbs report UNSUPPORTED
   * honestly; capabilities_get reports the same via fonts.available.
   */
  readonly fontLibrary?: FontLibraryBridge;
  /**
   * The user-level custom-preset seam: forwards preset.* verbs to the GUI
   * renderer, which owns the canonical preset store (IndexedDB) and the
   * apply expansion into core actions. Absent ⇒ the preset verbs report
   * UNSUPPORTED honestly; capabilities_get reports the same via
   * customPresets.available.
   */
  readonly presetLibrary?: PresetLibraryBridge;
  /** Persistent project/workspace/node APIs owned by the renderer manager. */
  readonly workspaceLibrary?: WorkspaceLibraryBridge;
  /** Durable records for fixed export/analysis snapshots. */
  readonly taskLifecycle?: LiveTaskLifecycle;
  /** Retains media versions while a task is pending or running. */
  readonly taskInputReferences?: LiveTaskInputReferences;
  /** Captures immutable renderer fonts for a frozen live rendering snapshot. */
  readonly prepareRenderProject?: (project: Project) => Promise<Project>;
  /** Request-local queue key; the desktop scopes it by project/workspace target. */
  readonly executionScope?: () => string;
}

/**
 * The live facade contract: the same verbs as AgentFacade, with
 * project.save honestly re-shaped for live mode (it saves an immutable node
 * through the workspace manager — see LiveProjectSaveResult)
 * plus dispose() (release the lease, cancel jobs).
 */
export interface LiveAgentFacade extends Omit<AgentFacade, "project.save"> {
  readonly "node.get": (params: Record<string, unknown>) => Promise<FacadeResult<unknown>>;
  readonly "project.save": (
    params?: Record<string, unknown>,
  ) => Promise<FacadeResult<LiveProjectSaveResult>>;
  /** Release write ownership without losing jobs or idempotency state. */
  releaseWriterLease(): void;
  /** Internal host metadata; no capability preflights or registered tool. */
  readWriterStatus?(): boolean;
  dispose(): Promise<void>;
}

export class LiveFacadeSession {
  private readonly config: LiveFacadeConfig;
  private readonly jobs: JobRegistry;
  private readonly ledger: IdempotencyLedger;
  /** True while this session holds the writer lease. */
  private writer: boolean;
  private disposed = false;
  private readonly analysisControllers = new Map<string, AbortController>();
  private readonly audioProcessTasks = new Map<string, Promise<void>>();
  private readonly releasedTaskIds = new Set<string>();
  private readonly chains = new Map<string, Promise<void>>();
  private taskStartChain: Promise<void> = Promise.resolve();

  constructor(config: LiveFacadeConfig) {
    this.config = config;
    this.jobs = config.jobTracker ?? new JobRegistry();
    this.ledger = new IdempotencyLedger();
    for (const record of config.taskLifecycle?.list() ?? []) {
      this.jobs.restore(record.status, {
        projectId: record.projectId,
        workspaceId: record.workspaceId,
      });
      const parameters = record.parameters;
      if (typeof parameters === "object" && parameters !== null) {
        const item = parameters as Record<string, unknown>;
        if (typeof item.idempotencyKey === "string" && typeof item.payloadHash === "string") {
          // Each restored receipt is pinned to ITS OWN record's scope, so
          // restore order can never cross-write project/workspace receipts.
          const scope = this.ledgerScope(record.projectId, record.workspaceId);
          if (record.status.kind === "export") {
            this.ledger.record(scope, "export.start", item.idempotencyKey, {
              revision: record.status.sourceRevision,
              value: { jobId: record.status.jobId, sourceRevision: record.status.sourceRevision },
              payloadHash: item.payloadHash,
            });
          } else if (record.status.kind === "analysis" && Array.isArray(item.analysisTypes) && item.analysisTypes.every((value) => typeof value === "string")) {
            this.ledger.record(scope, "media.analyze_start", item.idempotencyKey, {
              revision: record.status.sourceRevision,
              value: {
                jobId: record.status.jobId,
                sourceRevision: record.status.sourceRevision,
                analysisTypes: item.analysisTypes,
              },
              payloadHash: item.payloadHash,
            });
          } else if (record.status.kind === "audio-process") {
            this.ledger.record(scope, "audio.process.normalize", item.idempotencyKey, {
              revision: record.status.sourceRevision,
              value: { jobId: record.status.jobId, sourceRevision: record.status.sourceRevision },
              payloadHash: item.payloadHash,
            });
          }
        }
      }
      this.observeTask(record.status.jobId);
    }
    // Write-enabled sessions take the writer lease at construction. Failure
    // is not fatal — the session runs read-only and its write verbs fail
    // CONFLICT naming the current holder.
    this.writer =
      this.accessMode() === "write" && config.lease.acquire(config.sessionId);
  }

  private accessMode(): AgentAccessMode {
    const configured = this.config.access;
    return typeof configured === "function"
      ? configured()
      : configured ?? DEFAULT_AGENT_ACCESS_MODE;
  }

  private capabilityContext() {
    const mediaImportAvailable =
      (this.config.mediaRoots?.length ?? 0) > 0 &&
      typeof this.config.store.importMedia === "function";
    const materialLibraryAvailable =
      typeof this.config.materialLibrary === "function";
    const fontLibraryAvailable =
      typeof this.config.fontLibrary === "function";
    const presetLibraryAvailable =
      typeof this.config.presetLibrary === "function";
    const workspaceLibraryAvailable =
      typeof this.config.workspaceLibrary === "function";
    const unavailableVerbs: FacadeVerb[] = [...LIVE_UNAVAILABLE_VERBS];
    if (!mediaImportAvailable) unavailableVerbs.push("media.import");
    if (!materialLibraryAvailable) unavailableVerbs.push(...MATERIAL_VERBS);
    if (!workspaceLibraryAvailable) unavailableVerbs.push("project.create", "project.save", ...WORKSPACE_VERBS);
    return {

      mediaRoots: this.config.mediaRoots ?? [],
      deliveryRoots: this.config.deliveryRoots ?? [],
      ...(this.config.renderProvider
        ? { renderProvider: this.config.renderProvider }
        : {}),
      ...(this.config.exportProvider
        ? { exportProvider: this.config.exportProvider }
        : {}),
      ...(this.config.artifactVerifier
        ? { artifactVerifier: this.config.artifactVerifier }
        : {}),
      artifactRoot: this.config.artifactRoot,
      live: {
        access: this.accessMode(),
        writer: this.writer,
        leaseHolder: this.config.lease.holder(),
        sessionId: this.config.sessionId,
      mediaImportAvailable,
      materialLibraryAvailable,
      fontLibraryAvailable,
        presetLibraryAvailable,
        workspaceLibraryAvailable,
      unavailableVerbs,
      },
    };
  }

  private observeTask(jobId: string): void {
    if (!this.config.taskLifecycle) return;
    this.jobs.observe(jobId, (status) => {
      this.config.taskLifecycle!.update(status);
      if (status.state === "done" || status.state === "error" || status.state === "cancelled") {
        if (!this.releasedTaskIds.has(jobId)) {
          this.releasedTaskIds.add(jobId);
          void this.config.taskInputReferences?.release(jobId).catch(() => {
            // A failed release leaves the durable input pin in place, which is safe for later cleanup.
            this.releasedTaskIds.delete(jobId);
          });
        }
      }
    }, "task-lifecycle");
  }

  private async createTrackedTask(input: LiveTaskInput): Promise<Project> {
    const prior = this.taskStartChain;
    let release!: () => void;
    this.taskStartChain = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    let retained = false;
    try {
      this.assertTaskCapacity(input.kind === "export" ? "export.start"
        : input.kind === "analysis" ? "media.analyze_start" : "audio.process.normalize");
      let taskInput = input;
      if (this.config.taskInputReferences) {
        const preparedProject = await this.config.taskInputReferences.retain(input);
        if (preparedProject) taskInput = { ...input, inputProject: preparedProject };
        retained = true;
      }
      this.config.taskLifecycle?.begin(taskInput);
      this.jobs.create(taskInput.jobId, taskInput.sourceRevision, taskInput.kind, {
        projectId: taskInput.projectId,
        workspaceId: taskInput.workspaceId,
      });
      this.observeTask(taskInput.jobId);
      return taskInput.inputProject;
    } catch (error) {
      if (retained) await this.config.taskInputReferences?.release(input.jobId);
      throw error;
    } finally {
      release();
    }
  }

  private assertTaskCapacity(verb: string): void {
    const active = this.jobs.list().filter((job) => job.state === "queued" || job.state === "running").length;
    if (active >= MAX_ACTIVE_LIVE_TASKS) {
      throw new FacadeError(
        "UNSUPPORTED",
        `${verb}: the shared live task queue is full; wait for an active export or analysis job to finish`,
        { activeTasks: active, maximumActiveTasks: MAX_ACTIVE_LIVE_TASKS },
      );
    }
  }

  /**
   * The authorization gate, enforced BEFORE any param validation or state
   * access: read-only rejects every non-read-only verb FORBIDDEN; a
   * writer-less write session first tries to ACQUIRE the lease — it may have
   * been released since construction (for example, when the previous holder's
   * session ended) —
   * and only then fails CONFLICT, naming the ACTUAL current holder (or
   * honestly reporting the lease unavailable when there is none).
   */
  private gate(verb: FacadeVerb): void {
    if (isReadOnlyVerb(verb)) return;
    if (this.accessMode() === "read-only") {
      throw new FacadeError(
        "FORBIDDEN",
        `${verb}: this live session has read-only access`,
        {
          access: this.accessMode(),

          sessionId: this.config.sessionId,
        },
      );
    }
    if (!this.writer) {
      // A disposed session must not resurrect as the writer; a live one
      // takes the freed lease instead of failing CONFLICT forever.
      if (!this.disposed && this.config.lease.acquire(this.config.sessionId)) {
        this.writer = true;
        return;
      }
      const holder = this.config.lease.holder();
      throw new FacadeError(
        "CONFLICT",
        holder !== null
          ? `${verb}: another AI session ("${holder}") holds the writer lease — this session runs read-only until it releases`
          : `${verb}: the writer lease is unavailable — this session could not acquire it`,
        {
          leaseHolder: holder,
          sessionId: this.config.sessionId,
        },
      );
    }
  }

  /** Run the live access/lease gate at the facade factory boundary. */
  assertVerbAccess(verb: FacadeVerb): void {
    this.gate(verb);
  }

  /* ------------------------------ reads ------------------------------ */

  readWriterStatus(): boolean {
    return this.writer;
  }

  async sessionDescribe(): Promise<FacadeResult<SessionDescription>> {
    try {
      return ok(await buildSessionDescription(this.capabilityContext()));
    } catch (error) {
      return toFailure<SessionDescription>(error);
    }
  }

  async capabilitiesGet(params: CapabilitiesGetParams = {}): Promise<FacadeResult<Capabilities>> {
    try {
      return ok(await buildCapabilities(this.capabilityContext(), params));
    } catch (error) {
      return toFailure<Capabilities>(error);
    }
  }

  async projectGetState(): Promise<FacadeResult<ProjectState>> {
    return this.enqueue(async () => {
      const { project, revision } = await this.config.store.getState();
      // The SAME projection as headless (projection.ts, single logic).
      return ok(projectStateView(project, revision));
    });
  }

  async requirementsList(params: RequirementsListParams = {}): Promise<FacadeResult<RequirementsListResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<RequirementsListParams>(params, REQUIREMENTS_LIST_SCHEMA, "requirements.list params");
      return ok(await this.config.store.listRequirements(valid));
    });
  }

  async requirementsGet(params: RequirementsGetParams): Promise<FacadeResult<RequirementsGetResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<RequirementsGetParams>(params, REQUIREMENTS_GET_SCHEMA, "requirements.get params");
      return ok(await this.config.store.getRequirement(valid));
    });
  }

  async timelineGet(): Promise<FacadeResult<TimelineState>> {
    return this.enqueue(async () => {
      const { project, revision } = await this.config.store.getState();
      return ok(timelineStateView(project, revision));
    });
  }

  async projectChanges(
    params: ProjectChangesParams,
  ): Promise<FacadeResult<ProjectChangesResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<ProjectChangesParams>(
        params,
        PROJECT_CHANGES_SCHEMA,
        "project.changes params",
      );
      const { revision } = await this.config.store.getState();
      if (valid.sinceRevision > revision) {
        throw new FacadeError(
          "CONFLICT",
          `project.changes: sinceRevision ${valid.sinceRevision} is newer than current revision ${revision}`,
          { currentRevision: revision },
        );
      }
      return ok(await this.config.store.getProjectChanges(valid));
    });
  }

  async timelineQuery(
    params: TimelineQueryParams = {},
  ): Promise<FacadeResult<TimelineQueryResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<TimelineQueryParams>(
        params,
        TIMELINE_QUERY_SCHEMA,
        "timeline.query params",
      );
      validateTimelineQueryTimeRange(valid);
      const [state, context] = await Promise.all([
        this.config.store.getState(),
        this.config.store.getContext(),
      ]);
      return ok(queryTimeline(state.project, state.revision, valid, context.references ?? {}));
    });
  }

  async timelineMapSourceTimes(
    params: TimelineMapSourceTimesParams,
  ): Promise<FacadeResult<TimelineMapSourceTimesResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<TimelineMapSourceTimesParams>(
        params,
        TIMELINE_MAP_SOURCE_TIMES_SCHEMA,
        "timeline.mapSourceTimes params",
      );
      const { project, revision } = await this.config.store.getState();
      if (valid.expectedRevision !== undefined && valid.expectedRevision !== revision) {
        throw new FacadeError(
          "CONFLICT",
          `revision conflict: expected ${valid.expectedRevision}, current is ${revision}`,
          { currentRevision: revision },
        );
      }
      return ok(mapTimelineSourceTimes(project, revision, valid));
    });
  }

  private editOpPreparation(verb: "edit.apply" | "edit.validate"): PrepareEditOpOptions {
    return {
      mediaRoots: this.config.mediaRoots ?? [],
      artifactRoot: this.config.artifactRoot,
      probeFile: async (absPath: string) => {
        const probed = await probeLocalMediaFile(absPath);
        return {
          durationSec: probed.durationSec, width: probed.width, height: probed.height,
          frameRate: probed.frameRate, codec: probed.codec, fileSize: probed.fileSize,
          mimeType: probed.mimeType, hasVideo: probed.hasVideo, hasAudio: probed.hasAudio,
          sampleRate: 0, channels: 0,
        };
      },
      statFile: async (absPath: string) => {
        const fileStat = await stat(absPath);
        return { name: basename(absPath), size: fileStat.size, lastModified: Math.round(fileStat.mtimeMs) };
      },
      verb,
    };
  }

  async editValidate(
    params: EditValidateParams,
  ): Promise<FacadeResult<EditValidateResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<EditValidateParams>(
        params,
        EDIT_VALIDATE_SCHEMA,
        "edit.validate params",
      );
      const ops = validateEditOpList(valid.ops);
      assertValidEditBatch("edit.validate", ops);
      const [state, context] = await Promise.all([
        this.config.store.getState(),
        this.config.store.getContext(),
      ]);
      const preparation = this.editOpPreparation("edit.validate");
      return ok(
        await validateEditPlan(state.project, ops, {
          mode: "live",
          revision: state.revision,
          contextRevision: context.contextRevision,
          ...(valid.expectedRevision !== undefined
            ? { expectedRevision: valid.expectedRevision }
            : {}),
          ...(valid.expectedContextRevision !== undefined
            ? { expectedContextRevision: valid.expectedContextRevision }
            : {}),
          // Dry-run against the same sequential draft the real apply uses.
          prepareOp: (op: EditOp, draft, opIndex) =>
            prepareEditOp(op, draft, opIndex, preparation),
        }),
      );
    });
  }

  async historyGet(
    params: HistoryGetParams = {},
  ): Promise<FacadeResult<HistoryGetResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<HistoryGetParams>(
        params,
        HISTORY_GET_SCHEMA,
        "history.get params",
      );
      return ok(await this.config.store.getHistory(valid));
    });
  }

  async historyControl(
    params: HistoryControlParams,
  ): Promise<FacadeResult<HistoryControlResult>> {
    return this.enqueue(async () => {
      this.gate("history.control");
      const valid = validateObject<HistoryControlParams>(
        params,
        HISTORY_CONTROL_SCHEMA,
        "history.control params",
      );
      const payload = { action: valid.action };
      const receipt = await this.replayLookup<
        Omit<HistoryControlResult, "replayed">
      >("history.control", valid.idempotencyKey, payload);
      if (receipt?.prior) {
        return ok({
          ...receipt.prior.value,
          revision: receipt.prior.revision,
          replayed: true,
        });
      }

      const state = await this.config.store.getState();
      if (
        valid.expectedRevision !== undefined &&
        valid.expectedRevision !== state.revision &&
        valid.idempotencyKey === undefined
      ) {
        throw new FacadeError(
          "CONFLICT",
          `revision conflict: expected ${valid.expectedRevision}, current is ${state.revision}`,
          { currentRevision: state.revision },
        );
      }
      try {
        this.gate("history.control");
        const controlled = await this.config.store.historyControl(valid.action, {
          expectedRevision: valid.expectedRevision ?? state.revision,
          ...(valid.idempotencyKey !== undefined
            ? { idempotencyKey: valid.idempotencyKey }
            : {}),
        });
        const value = {
          action: valid.action,
          revision: controlled.revision,
          canUndo: controlled.canUndo,
          canRedo: controlled.canRedo,
        };
        receipt?.commit(value, controlled.revision);
        return ok({ ...value, replayed: controlled.replayed });
      } catch (error) {
        if (isLiveStoreConflict(error)) {
          throw new FacadeError(
            "CONFLICT",
            `history.control: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof LiveStoreConflictError ? error.details : undefined,
          );
        }
        const code =
          typeof error === "object" && error !== null
            ? (error as { code?: unknown }).code
            : undefined;
        if (code === "NOT_FOUND") {
          throw new FacadeError("NOT_FOUND", error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
    });
  }

  async editorGetContext(
    params: Record<string, never> = {},
  ): Promise<FacadeResult<EditorGetContextResult>> {
    return this.enqueue(async () => {
      validateObject(params, EMPTY_PARAMS_SCHEMA, "editor.get_context params");
      const [identity, state, context] = await Promise.all([
        this.config.store.getIdentity(),
        this.config.store.getState(),
        this.config.store.getContext(),
      ]);
      const requirementItems = state.project.requirements?.items ?? [];
      return ok<EditorGetContextResult>({
        mode: "live",

        projectRevision: state.revision,
        contextAvailable: true,
        contextRevision: context.contextRevision,
        playheadSeconds: context.playheadSeconds,
        selectedClipIds: [...context.selectedClipIds],
        selectedTextIds: [...context.selectedTextIds],
        selectedMediaIds: [...context.selectedMediaIds],
        timeRange: context.timeRange ? { ...context.timeRange } : null,
        canvasPoint: context.canvasPoint ? { ...context.canvasPoint } : null,
        references: context.references ? { ...context.references } : {},
        requirements: {
          ready: requirementItems.filter((item) => item.status === "ready").length,
          inProgress: requirementItems.filter((item) => item.status === "in_progress").length,
          ids: requirementItems
            .filter((item) => item.status === "ready" || item.status === "in_progress")
            .map((item) => `Q${item.number}`),
        },
        identity: {
          projectId: identity.projectId,
          projectName: identity.projectName,
          windowId: identity.windowId,
          ...(identity.projectEpoch ? { projectEpoch: identity.projectEpoch } : {}),
          ...(identity.workspaceId ? { workspaceId: identity.workspaceId } : {}),
          ...(identity.workspaceInstanceId ? { workspaceInstanceId: identity.workspaceInstanceId } : {}),
        },
      });
    });
  }

  /**
   * Control only ephemeral editor state. The renderer owns playback,
   * selection and focus; this facade never mutates the project or revision.
   */
  async editorControl(
    params: LiveEditorControlParams,
  ): Promise<FacadeResult<LiveEditorControlResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<LiveEditorControlParams>(
        params,
        EDITOR_CONTROL_SCHEMA,
        "editor.control params",
      );
      const normalizedTargets = validateEditorControlTargets(valid.targets);
      validateEditorControlAction(valid);
      try {
        return ok(
          await this.config.store.editorControl({
            ...valid,
            ...(normalizedTargets !== undefined
              ? { targets: normalizedTargets }
              : {}),
          }),
        );
      } catch (error) {
        const mapped = liveControlBridgeFailure(error);
        if (mapped) throw mapped;
        throw error;
      }
    });
  }

  /* --------------------- live lifecycle ------------------------------ */

  async projectCreate(
    params?: ProjectCreateParams,
  ): Promise<FacadeResult<ProjectCreateResult>> {
    return this.enqueue(async () => {
      this.gate("project.create");
      const valid = validateObject<ProjectCreateParams>(params ?? {}, PROJECT_CREATE_SCHEMA, "project.create params");
      const settings = valid.settings !== undefined
        ? validateObject<Partial<ProjectSettings>>(valid.settings, PROJECT_SETTINGS_SCHEMA, "project.create params.settings")
        : undefined;
      const project = createEmptyProject(valid.name, settings);
      const requestPayload = { name: valid.name ?? project.name, settings: settings ?? project.settings };
      const result = await this.callWorkspaceLibrary({
        verb: "project.create",
        params: {
          project,
          requestPayload,
          ...(valid.idempotencyKey !== undefined ? { idempotencyKey: valid.idempotencyKey } : {}),
        },
      });
      const created = result as { revision?: unknown; defaultWorkspaceId?: unknown; project?: unknown; replayed?: unknown };
      // The bridge contract always carries the persisted revision; a missing
      // or non-numeric one is a protocol bug, not something to paper over
      // with a fabricated 0.
      if (typeof created.revision !== "number") {
        throw new FacadeError(
          "INTERNAL",
          "project.create: workspace bridge reply is missing its revision",
        );
      }
      const revision = created.revision;
      const canonicalProject = typeof created.project === "object" && created.project !== null &&
        typeof (created.project as { id?: unknown }).id === "string"
        ? created.project as Project
        : project;
      const state = projectStateView(canonicalProject, revision);
      return ok<ProjectCreateResult>({
        ...state,
        projectId: canonicalProject.id,
        ...(typeof created.defaultWorkspaceId === "string" ? { defaultWorkspaceId: created.defaultWorkspaceId } : {}),
        replayed: created.replayed === true,
      });
    });
  }

  async projectOpen(
    _params: ProjectOpenParams,
  ): Promise<FacadeResult<ProjectOpenResult>> {
    return this.enqueue(async () => {
      this.gate("project.open");
      throw liveUnavailable(
        "project.open",
        "the GUI owns the project lifecycle — a live session attaches to the project already open in the editor",
      );
    });
  }

  async projectRename(
    params: ProjectRenameParams,
  ): Promise<FacadeResult<ProjectRenameResult>> {
    return this.enqueue(async () => {
      this.gate("project.rename");
      const valid = validateObject<ProjectRenameParams>(
        params,
        PROJECT_RENAME_SCHEMA,
        "project.rename params",
      );
      const name = normalizeProjectName(valid.name);
      const payload = { name };
      const receipt = await this.replayLookup<
        Omit<ProjectRenameResult, "revision" | "replayed">
      >("project.rename", valid.idempotencyKey, payload);
      if (receipt?.prior) {
        return ok<ProjectRenameResult>({
          ...receipt.prior.value,
          revision: receipt.prior.revision,
          replayed: true,
        });
      }

      const { project, revision } = await this.config.store.getState();
      const value = {
        projectId: project.id,
        previousName: project.name,
        name,
      };
      let committed: LiveApplyActionsResult;
      try {
        this.gate("project.rename");
        committed = await this.config.store.applyActions(
          [{
            type: "project/rename",
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            params: { name },
          }],
          {
            groupLabel: "agent: project.rename",
            expectedRevision: valid.expectedRevision ?? revision,
            ...(valid.idempotencyKey !== undefined
              ? { idempotencyKey: valid.idempotencyKey }
              : {}),
          },
        );
      } catch (error) {
        if (isLiveStoreConflict(error)) {
          throw new FacadeError(
            "CONFLICT",
            `project.rename: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof LiveStoreConflictError ? error.details : undefined,
          );
        }
        throw error;
      }
      receipt?.commit(value, committed.revision);
      return ok<ProjectRenameResult>({
        ...value,
        revision: committed.revision,
        replayed: false,
      });
    });
  }

  async mediaImport(
    params: MediaImportParams,
  ): Promise<FacadeResult<MediaImportResult>> {
    return this.enqueue(() => this.importMediaWithinMutation(params));
  }

  private async importMediaWithinMutation(
    params: MediaImportParams,
    target?: { projectId: string; workspaceId?: string },
    beforeImport?: () => Promise<void>,
  ): Promise<FacadeResult<MediaImportResult>> {
    this.gate("media.import");
    const valid = validateObject<MediaImportParams>(
      params,
      // Keep the same closed schema and payload semantics as headless.
      // expectedRevision is a guard, not part of the idempotency payload.
      MEDIA_IMPORT_SCHEMA,
      "media.import params",
    );

    const payload = { path: valid.path, name: valid.name };
    const receipt = await this.replayLookup<
      Omit<MediaImportResult, "revision" | "replayed">
    >("media.import", valid.idempotencyKey, payload);
    if (receipt?.prior) {
      return ok<MediaImportResult>({
        ...receipt.prior.value,
        revision: receipt.prior.revision,
        replayed: true,
      });
    }

    if (
      valid.idempotencyKey !== undefined &&
      this.config.store.getMediaImportReplay
    ) {
      let durablePrior: MediaImportResult | null;
      try {
        durablePrior = await this.config.store.getMediaImportReplay(
          valid.idempotencyKey,
          payload,
        );
      } catch (error) {
        if (isLiveStoreConflict(error)) {
          throw new FacadeError(
            "CONFLICT",
            `media.import: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof LiveStoreConflictError ? error.details : undefined,
          );
        }
        throw error;
      }
      if (durablePrior) {
        const value: Omit<MediaImportResult, "revision" | "replayed"> = {
          mediaId: durablePrior.mediaId,
          name: durablePrior.name,
          type: durablePrior.type,
          metadata: durablePrior.metadata,
        };
        receipt?.commit(value, durablePrior.revision);
        return ok<MediaImportResult>({
          ...value,
          revision: durablePrior.revision,
          replayed: true,
        });
      }
    }

    // Read the revision before touching the filesystem. This preserves the
    // headless precedence contract: a stale caller revision is CONFLICT,
    // even when its source path is missing or malformed. The store repeats
    // the CAS at commit time to catch a human edit during probing.
    const { revision } = await this.config.store.getState();
    if (
      valid.expectedRevision !== undefined &&
      valid.expectedRevision !== revision
    ) {
      throw new FacadeError(
        "CONFLICT",
        `revision conflict: expected ${valid.expectedRevision}, current is ${revision}`,
        { currentRevision: revision },
      );
    }

    const importer = this.config.store.importMedia;
    if (typeof importer !== "function") {
      throw new FacadeError(
        "UNSUPPORTED",
        "media.import: the live store does not expose an import bridge",
      );
    }

    await beforeImport?.();
    const roots = this.config.mediaRoots ?? [];
    if (roots.length === 0) {
      throw new FacadeError(
        "UNSUPPORTED",
        "media.import: no media roots configured for this live session",
      );
    }
    if (hasUrlScheme(valid.path)) {
      throw new FacadeError(
        "INVALID_PARAMS",
        "media.import: URLs are not accepted in live mode — pass an absolute local file path inside a configured media root",
        { path: valid.path },
      );
    }
    if (!isAbsolute(valid.path)) {
      throw new FacadeError(
        "INVALID_PARAMS",
        "media.import: paths must be absolute — nothing is resolved against the host process cwd",
        { path: valid.path },
      );
    }
    const resolution = resolveContainedPathDetailed(valid.path, roots);
    if (resolution.kind === "outside") {
      throw new FacadeError(
        "INVALID_PARAMS",
        "media.import: path escapes the configured media roots",
        { path: valid.path, mediaRoots: [...roots] },
      );
    }
    if (resolution.kind === "unresolvable") {
      throw new FacadeError(
        "INVALID_PARAMS",
        "media.import: path cannot be read (not found or unreadable)",
        { path: valid.path },
      );
    }

    const resolved = resolution.path;
    const fileStat = await stat(resolved).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      throw new FacadeError(
        "INVALID_PARAMS",
        "media.import: path is not a regular file",
        { path: valid.path },
      );
    }
    if (fileStat.size > MAX_LIVE_IMPORT_FILE_BYTES) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `media.import: file exceeds the ${MAX_LIVE_IMPORT_FILE_BYTES}-byte live import limit`,
        {
          path: valid.path,
          bytes: fileStat.size,
          maxBytes: MAX_LIVE_IMPORT_FILE_BYTES,
        },
      );
    }

    let probed: Awaited<ReturnType<typeof probeLocalMediaFile>>;
    try {
      probed = await probeLocalMediaFile(resolved);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new FacadeError(
        "INVALID_PARAMS",
        `media.import: cannot read media metadata: ${message}`,
        { path: resolved },
      );
    }

    const name = valid.name ?? basename(resolved);
    const request: LiveMediaImportRequest = {
      path: resolved,
      name,
      type: probed.type,
      metadata: {
        durationSec: probed.durationSec,
        width: probed.width,
        height: probed.height,
        frameRate: probed.frameRate,
        codec: probed.codec,
        fileSize: probed.fileSize,
      },
      sourceFile: {
        name: basename(resolved),
        size: fileStat.size,
        lastModified: Math.round(fileStat.mtimeMs),
      },
      ...(valid.idempotencyKey !== undefined
        ? { idempotencyKey: valid.idempotencyKey }
        : {}),
    };

    let committed: LiveMediaImportResult;
    try {
      this.gate("media.import");
      // Preserve the store receiver: concrete bridges may implement this
      // as a class method with stateful revision/history bookkeeping.
      if (target) {
        const identity = await this.config.store.getIdentity();
        if (identity.projectId !== target.projectId || (identity.workspaceId ?? "default") !== (target.workspaceId ?? "default")) {
          throw new FacadeError("CONFLICT", "audio.process.register: target project/workspace changed during import");
        }
      }
      committed = await this.config.store.importMedia(request, {
        groupLabel: "agent: media.import",
        // As with live edit.apply, omitted expectedRevision is still an
        // unconditional CAS against the snapshot we validated/probed.
        expectedRevision: valid.expectedRevision ?? revision,
        ...(valid.idempotencyKey !== undefined
          ? { idempotencyKey: valid.idempotencyKey, idempotencyPayload: payload }
          : {}),
      });
    } catch (error) {
      if (isLiveStoreConflict(error)) {
        throw new FacadeError(
          "CONFLICT",
          `media.import: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof LiveStoreConflictError ? error.details : undefined,
        );
      }
      // Renderer bridges retain a typed error code on ordinary failures.
      // Keep invalid/decode input failures in the facade's public taxonomy
      // instead of letting the enqueue boundary turn them into INTERNAL.
      const typed =
        typeof error === "object" && error !== null
          ? (error as { code?: unknown; details?: Record<string, unknown> })
          : undefined;
      if (typed?.code === "INVALID_PARAMS") {
        throw new FacadeError(
          "INVALID_PARAMS",
          error instanceof Error ? error.message : String(error),
          typed.details,
        );
      }
      if (typed?.code === "DECODE_ERROR") {
        throw new FacadeError(
          "INVALID_PARAMS",
          error instanceof Error ? error.message : String(error),
          { ...typed.details, bridgeCode: "DECODE_ERROR" },
        );
      }
      if (typed?.code === "NO_PROJECT") {
        throw new FacadeError(
          "NOT_FOUND",
          "media.import: no project is open in the GUI",
          typed.details,
        );
      }
      throw error;
    }

    const value: Omit<MediaImportResult, "revision" | "replayed"> = {
      mediaId: committed.mediaId,
      name,
      type: probed.type,
      metadata: request.metadata,
    };
    receipt?.commit(value, committed.revision);
    return ok<MediaImportResult>({
      ...value,
      revision: committed.revision,
      replayed: false,
    });
  }

  /**
   * media.render_html (live): same artifact core as headless — constrained
   * HTML/CSS → PNG under the media roots, content-policy gated, published
   * temp-then-publish with sha256 + PNG re-inspection. Writes a file (a
   * mutation for the access/writer gates) but never touches project state:
   * the caller imports the returned path via media.import.
   */
  async mediaRenderHtml(
    params: MediaRenderHtmlParams,
  ): Promise<FacadeResult<MediaRenderHtmlResult>> {
    return this.enqueue(async () => {
      this.gate("media.render_html");
      const valid = validateObject<MediaRenderHtmlParams>(
        params,
        MEDIA_RENDER_HTML_SCHEMA,
        "media.render_html params",
      );

      const payload = {
        source: valid.source,
        assetsRoot: valid.assetsRoot,
        width: valid.width,
        height: valid.height,
        transparent: valid.transparent ?? true,
        timeoutMs: valid.timeoutMs,
        outputDir: valid.outputDir,
      };
      const receipt = await this.replayLookup<MediaRenderHtmlResult>(
        "media.render_html",
        valid.idempotencyKey,
        payload,
      );
      if (receipt?.prior) {
        const stillThere = await stat(receipt.prior.value.path).then(
          (s) => s.isFile(),
          () => false,
        );
        if (stillThere) {
          return ok<MediaRenderHtmlResult>({
            ...receipt.prior.value,
            replayed: true,
          });
        }
      }

      const provider = this.config.renderProvider;
      if (!provider || typeof provider.renderHtmlPng !== "function") {
        throw new FacadeError(
          "UNSUPPORTED",
          "media.render_html: no render provider with HTML rendering is configured for this live session",
          {
            requires:
              "a RenderProvider exposing renderHtmlPng (the desktop MAIN process supplies it from createChromiumProviders)",
          },
        );
      }
      const roots = this.config.mediaRoots ?? [];
      if (roots.length === 0) {
        throw new FacadeError(
          "UNSUPPORTED",
          "media.render_html: no media roots configured for this live session",
        );
      }
      await requireProviderPreflight(provider, "media.render_html");

      this.gate("media.render_html");
      const artifact = await produceHtmlRenderArtifact({
        provider,
        mediaRoots: roots,
        params: {
          source: valid.source,
          ...(valid.assetsRoot !== undefined ? { assetsRoot: valid.assetsRoot } : {}),
          width: valid.width,
          height: valid.height,
          ...(valid.transparent !== undefined ? { transparent: valid.transparent } : {}),
          ...(valid.timeoutMs !== undefined ? { timeoutMs: valid.timeoutMs } : {}),
          ...(valid.outputDir !== undefined ? { outputDir: valid.outputDir } : {}),
        },
      });
      const value: MediaRenderHtmlResult = { ...artifact, replayed: false };
      // file-producing verb: no project revision to pin.
      receipt?.commit(value, 0);
      return ok(value);
    });
  }

  /**
   * project.save (live): flushes the GUI's autosave/recovery snapshot via
   * the GUI's own save path — it does NOT write a .openreel project file
   * (the GUI owns where and how project files are written), so the verb
   * takes no path and honestly reports only the revision at flush time.
   */
  async projectSave(
    params: Record<string, unknown> = {},
  ): Promise<FacadeResult<LiveProjectSaveResult>> {
    return this.enqueue(async () => {
      this.gate("project.save");
      const valid = validateObject<Record<string, unknown>>(
        params,
        WORKSPACE_VERB_SCHEMAS["node.save"],
        "project.save params",
      );
      // Bind the request to the current runtime generation before the manager
      // performs its persistent workspace write.
      await this.config.store.getState();
      const saved = await this.callWorkspaceLibrary({ verb: "node.save", params: valid }) as {
        node?: { id?: unknown };
        revision?: unknown;
        replayed?: unknown;
      };
      // The manager's saveNode always reports the persisted revision; falling
      // back to expectedRevision here would hide a protocol drift behind a
      // plausible-looking number.
      if (typeof saved.revision !== "number") {
        throw new FacadeError(
          "INTERNAL",
          "project.save: workspace bridge reply is missing its revision",
        );
      }
      return ok<LiveProjectSaveResult>({
        revision: saved.revision,
        ...(typeof saved.node?.id === "string" ? { nodeId: saved.node.id } : {}),
        ...(typeof saved.replayed === "boolean" ? { replayed: saved.replayed } : {}),
      });
    });
  }

  async workspaceCommand(
    verb: WorkspaceVerb,
    params: Record<string, unknown> = {},
  ): Promise<FacadeResult<unknown>> {
    return this.enqueue(async () => {
      if (!isReadOnlyVerb(verb)) this.gate(verb);
      const valid = validateObject<Record<string, unknown>>(
        params,
        WORKSPACE_VERB_SCHEMAS[verb],
        `${verb} params`,
      );
      if (verb === "workspace.delete" || verb === "workspace.recover_draft" ||
          verb === "node.save" || verb === "node.restore") {
        await this.config.store.getState();
      }
      return ok(await this.callWorkspaceLibrary({ verb, params: valid }));
    });
  }

  private async callWorkspaceLibrary(request: WorkspaceLibraryBridgeRequest): Promise<unknown> {
    if (!this.config.workspaceLibrary) {
      throw liveUnavailable(request.verb, "the desktop workspace manager bridge is unavailable");
    }
    const reply: WorkspaceLibraryBridgeReply = await this.config.workspaceLibrary(request);
    if (!reply.ok) {
      const code = (FACADE_ERROR_CODES as readonly string[]).includes(reply.error.code)
        ? reply.error.code as FacadeErrorCode
        : "INTERNAL";
      throw new FacadeError(code, `${request.verb}: ${reply.error.message}`, reply.error.details);
    }
    return reply.result;
  }

  private async prepareRenderProject(project: Project): Promise<Project> {
    return this.config.prepareRenderProject
      ? this.config.prepareRenderProject(project)
      : project;
  }

  async audioProcessNormalize(params: AudioProcessNormalizeParams): Promise<FacadeResult<AudioProcessNormalizeResult>> {
    return this.enqueue<AudioProcessNormalizeResult>(async () => {
      this.gate("audio.process.normalize");
      const valid = validateObject<AudioProcessNormalizeParams>(params, AUDIO_PROCESS_NORMALIZE_SCHEMA, "audio.process.normalize params");
      if (!(valid.endSec > valid.startSec) || valid.endSec - valid.startSec > AUDIO_NORMALIZE_MAX_RANGE_SEC) {
        throw new FacadeError("INVALID_PARAMS", "audio.process.normalize requires startSec < endSec and a range of at most 120 seconds");
      }
      const { expectedRevision, idempotencyKey, ...parameters } = valid;
      const identity = await this.config.store.getIdentity();
      const receipt = this.ledger.lookup<{ jobId: string; sourceRevision: number }>(
        this.ledgerScope(identity.projectId, identity.workspaceId),
        "audio.process.normalize", idempotencyKey, parameters,
      );
      if (receipt?.prior) {
        const job = this.jobs.get(receipt.prior.value.jobId);
        if (!job) throw new FacadeError("NOT_FOUND", "audio.process.normalize: prior job is no longer available");
        return ok({ ...receipt.prior.value, kind: "audio-process", state: job.state, replayed: true });
      }
      const state = await this.config.store.getState();
      if (expectedRevision !== undefined && expectedRevision !== state.revision) {
        throw new FacadeError("CONFLICT", `revision conflict: expected ${expectedRevision}, current is ${state.revision}`, { currentRevision: state.revision });
      }
      if (identity.projectId !== state.project.id) throw new FacadeError("CONFLICT", "audio.process.normalize: target project changed while preparing input");
      const media = state.project.mediaLibrary.items.find((item) => item.id === valid.mediaId);
      if (!media) throw new FacadeError("NOT_FOUND", `audio.process.normalize: media "${valid.mediaId}" not found`);
      if (valid.endSec > media.metadata.duration) throw new FacadeError("INVALID_PARAMS", "audio.process.normalize: range exceeds source duration");
      const roots = this.config.mediaRoots ?? [];
      if (roots.length === 0 || typeof this.config.store.importMedia !== "function") throw new FacadeError("UNSUPPORTED", "audio.process.normalize requires media roots and a live media import bridge for generated assets");
      const sourcePath = await this.resolveLiveMediaItemFile(media);
      const resolution = resolveContainedPathDetailed(sourcePath ?? "", roots);
      if (resolution.kind !== "ok") throw new FacadeError("UNSUPPORTED", "audio.process.normalize requires a readable source inside configured media roots");
      const ready = await audioAnalysisPreflight();
      if (!ready.available) throw new FacadeError("UNSUPPORTED", ready.reason!);
      this.gate("audio.process.normalize");
      this.assertTaskCapacity("audio.process.normalize");
      const currentIdentity = await this.config.store.getIdentity();
      if (currentIdentity.projectId !== identity.projectId || currentIdentity.workspaceId !== identity.workspaceId) {
        throw new FacadeError("CONFLICT", "audio.process.normalize: target project/workspace changed while preparing input");
      }
      const jobId = `job-${crypto.randomUUID()}`;
      const workspaceId = identity.workspaceId ?? "default";
      await this.createTrackedTask({
        jobId, kind: "audio-process", projectId: state.project.id, workspaceId,
        sourceRevision: state.revision, inputProject: structuredClone(state.project),
        parameters: { ...parameters, idempotencyKey, payloadHash: stableStringify(parameters) },
      });
      const controller = new AbortController();
      this.analysisControllers.set(jobId, controller);
      const value = { jobId, sourceRevision: state.revision };
      receipt?.commit(value, state.revision);
      const task = runAudioNormalizationTask(this.jobs, this.analysisControllers, jobId, controller, {
        sourcePath: resolution.path, mediaRoots: roots, params: parameters,
        sourceProjectId: state.project.id, sourceWorkspaceId: workspaceId, sourceRevision: state.revision,
      });
      this.audioProcessTasks.set(jobId, task);
      void task.then(
        () => this.audioProcessTasks.delete(jobId),
        () => this.audioProcessTasks.delete(jobId),
      );
      return ok({ ...value, kind: "audio-process", state: "queued", replayed: false });
    });
  }

  async audioProcessDenoise(params: AudioProcessDenoiseParams): Promise<FacadeResult<AudioProcessDenoiseResult>> {
    return this.enqueue<AudioProcessDenoiseResult>(async () => {
      this.gate("audio.process.denoise");
      const valid = validateObject<AudioProcessDenoiseParams>(params, AUDIO_PROCESS_DENOISE_SCHEMA, "audio.process.denoise params");
      if (!(valid.endSec > valid.startSec) || valid.endSec - valid.startSec > AUDIO_DENOISE_MAX_RANGE_SEC) {
        throw new FacadeError("INVALID_PARAMS", "audio.process.denoise requires startSec < endSec and a range of at most 120 seconds");
      }
      const { expectedRevision, idempotencyKey, ...parameters } = valid;
      const identity = await this.config.store.getIdentity();
      const receipt = this.ledger.lookup<{ jobId: string; sourceRevision: number }>(
        this.ledgerScope(identity.projectId, identity.workspaceId),
        "audio.process.denoise", idempotencyKey, parameters,
      );
      if (receipt?.prior) {
        const job = this.jobs.get(receipt.prior.value.jobId);
        if (!job) throw new FacadeError("NOT_FOUND", "audio.process.denoise: prior job is no longer available");
        return ok({ ...receipt.prior.value, kind: "audio-process", state: job.state, replayed: true });
      }
      const state = await this.config.store.getState();
      if (expectedRevision !== undefined && expectedRevision !== state.revision) {
        throw new FacadeError("CONFLICT", `revision conflict: expected ${expectedRevision}, current is ${state.revision}`, { currentRevision: state.revision });
      }
      if (identity.projectId !== state.project.id) throw new FacadeError("CONFLICT", "audio.process.denoise: target project changed while preparing input");
      const media = state.project.mediaLibrary.items.find((item) => item.id === valid.mediaId);
      if (!media) throw new FacadeError("NOT_FOUND", `audio.process.denoise: media "${valid.mediaId}" not found`);
      if (valid.endSec > media.metadata.duration) throw new FacadeError("INVALID_PARAMS", "audio.process.denoise: range exceeds source duration");
      const roots = this.config.mediaRoots ?? [];
      if (roots.length === 0 || typeof this.config.store.importMedia !== "function") throw new FacadeError("UNSUPPORTED", "audio.process.denoise requires media roots and a live media import bridge for generated assets");
      const sourcePath = await this.resolveLiveMediaItemFile(media);
      const resolution = resolveContainedPathDetailed(sourcePath ?? "", roots);
      if (resolution.kind !== "ok") throw new FacadeError("UNSUPPORTED", "audio.process.denoise requires a readable source inside configured media roots");
      const ready = await audioAnalysisPreflight();
      if (!ready.available) throw new FacadeError("UNSUPPORTED", ready.reason!);
      this.gate("audio.process.denoise");
      this.assertTaskCapacity("audio.process.denoise");
      const currentIdentity = await this.config.store.getIdentity();
      if (currentIdentity.projectId !== identity.projectId || currentIdentity.workspaceId !== identity.workspaceId) {
        throw new FacadeError("CONFLICT", "audio.process.denoise: target project/workspace changed while preparing input");
      }
      const jobId = `job-${crypto.randomUUID()}`;
      const workspaceId = identity.workspaceId ?? "default";
      await this.createTrackedTask({
        jobId, kind: "audio-process", projectId: state.project.id, workspaceId,
        sourceRevision: state.revision, inputProject: structuredClone(state.project),
        parameters: { ...parameters, idempotencyKey, payloadHash: stableStringify(parameters) },
      });
      const controller = new AbortController();
      this.analysisControllers.set(jobId, controller);
      const value = { jobId, sourceRevision: state.revision };
      receipt?.commit(value, state.revision);
      const task = runAudioDenoiseTask(this.jobs, this.analysisControllers, jobId, controller, {
        sourcePath: resolution.path, mediaRoots: roots, params: parameters,
        sourceProjectId: state.project.id, sourceWorkspaceId: workspaceId, sourceRevision: state.revision,
      });
      this.audioProcessTasks.set(jobId, task);
      void task.then(
        () => this.audioProcessTasks.delete(jobId),
        () => this.audioProcessTasks.delete(jobId),
      );
      return ok({ ...value, kind: "audio-process", state: "queued", replayed: false });
    });
  }

  async audioProcessRegister(params: AudioProcessRegisterParams): Promise<FacadeResult<AudioProcessRegisterResult>> {
    return this.enqueue(async () => {
      this.gate("audio.process.register");
      const valid = validateObject<AudioProcessRegisterParams>(params, AUDIO_PROCESS_REGISTER_SCHEMA, "audio.process.register params");
      const artifact = completedAudioArtifact(this.jobs, valid.jobId);
      const identity = await this.config.store.getIdentity();
      if (artifact.source.projectId !== identity.projectId || artifact.source.workspaceId !== (identity.workspaceId ?? "default")) {
        throw new FacadeError("CONFLICT", "audio.process.register: job belongs to another project/workspace");
      }
      return this.importMediaWithinMutation({
        path: artifact.path, expectedRevision: valid.expectedRevision,
        idempotencyKey: `audio-process-register:${valid.jobId}`,
      }, { projectId: artifact.source.projectId, workspaceId: artifact.source.workspaceId },
      () => verifyAudioArtifact(artifact, this.config.mediaRoots ?? []));
    });
  }

  async mediaAnalyzeStart(
    params: MediaAnalyzeStartParams,
  ): Promise<FacadeResult<MediaAnalyzeStartResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<MediaAnalyzeStartParams>(
        params,
        MEDIA_ANALYZE_START_SCHEMA,
        "media.analyze_start params",
      );
      if (valid.analysisTypes.includes("videoReview")) {
        if (valid.cloudUpload !== true) throw new FacadeError("INVALID_PARAMS", "videoReview uploads media to the selected cloud provider; cloudUpload must explicitly be true after user authorization.");
        if (valid.startSec === undefined || valid.endSec === undefined || valid.endSec - valid.startSec > 20) throw new FacadeError("INVALID_PARAMS", "videoReview requires explicit startSec/endSec, at most 20 source seconds.");
        if (!this.config.artifactRoot) throw new FacadeError("UNSUPPORTED", "videoReview requires artifactRoot for bounded inspection copies.");
      } else if (valid.reviewQuestion !== undefined || valid.cloudUpload !== undefined) {
        throw new FacadeError("INVALID_PARAMS", "cloudUpload/reviewQuestion apply only to videoReview");
      }
      if (valid.silenceParams !== undefined && !valid.analysisTypes.includes("silence")) {
        throw new FacadeError("INVALID_PARAMS", "silenceParams apply only when analysisTypes includes \"silence\"");
      }
      const silenceParams = valid.analysisTypes.includes("silence")
        ? resolveSilenceAnalysisParams(valid.silenceParams) : undefined;
      if (valid.vadParams !== undefined && !valid.analysisTypes.includes("speechActivity") && !valid.analysisTypes.includes("speechTranscript")) {
        throw new FacadeError("INVALID_PARAMS", "vadParams apply only when analysisTypes includes \"speechActivity\" or \"speechTranscript\"");
      }
      const vadParams = valid.analysisTypes.includes("speechActivity") || valid.analysisTypes.includes("speechTranscript")
        ? resolveSpeechVadParams(valid.vadParams) : undefined;
      if (valid.transcriptParams !== undefined && !valid.analysisTypes.includes("speechTranscript")) {
        throw new FacadeError("INVALID_PARAMS", "transcriptParams apply only when analysisTypes includes \"speechTranscript\"");
      }
      const transcriptParams = valid.analysisTypes.includes("speechTranscript")
        ? resolveTranscriptParams(valid.transcriptParams) : undefined;
      if (valid.syncOffsetParams !== undefined && !valid.analysisTypes.includes("syncOffset")) {
        throw new FacadeError("INVALID_PARAMS", "syncOffsetParams apply only when analysisTypes includes \"syncOffset\"");
      }
      const syncOffsetParams = valid.analysisTypes.includes("syncOffset")
        ? resolveSyncOffsetParams(valid.syncOffsetParams) : undefined;
      const unavailable = valid.analysisTypes.filter(
        (type) => type !== "technicalQuality" && type !== "audioSummary" && type !== "videoReview" && type !== "silence" && type !== "beatGrid" &&
          type !== "speechActivity" && type !== "speechTranscript" && type !== "syncOffset" && type !== "sceneCuts" && type !== "blackFrames" && type !== "duplicateFrames",
      );
      if (unavailable.length > 0) {
        throw new FacadeError(
          "UNSUPPORTED",
          `media.analyze_start: unavailable analysis types: ${unavailable.join(", ")}`,
          { unavailableTypes: unavailable, availableTypes: ["technicalQuality", "audioSummary", "silence", "beatGrid", "speechActivity", "speechTranscript", "syncOffset", "sceneCuts", "blackFrames", "duplicateFrames"] },
        );
      }
      const audioBackedTypes = valid.analysisTypes.filter(
        (type) => type === "audioSummary" || type === "silence" || type === "beatGrid" || type === "speechActivity" || type === "speechTranscript" || type === "syncOffset",
      );
      if (audioBackedTypes.length > 0) {
        requireArtifactRoot(this.config.artifactRoot, "media.analyze_start audio analysis");
        const ready = await audioAnalysisPreflight();
        if (!ready.available) throw new FacadeError("UNSUPPORTED", ready.reason!);
        if (valid.analysisTypes.includes("speechActivity")) {
          // Runtime is required up front; a missing model downloads on first use.
          const vadRuntime = await speechVadRuntimePreflight();
          if (!vadRuntime.available) throw new FacadeError("UNSUPPORTED", vadRuntime.reason);
        }
        if (valid.analysisTypes.includes("speechTranscript")) {
          const vadRuntime = await speechVadRuntimePreflight();
          if (!vadRuntime.available) throw new FacadeError("UNSUPPORTED", vadRuntime.reason);
          const models = await probeAudioModelsRuntime();
          if (!models.available) throw new FacadeError("UNSUPPORTED", models.reason);
        }
      }
      const videoCandidateTypes = valid.analysisTypes.filter(
        (type) => type === "sceneCuts" || type === "blackFrames" || type === "duplicateFrames",
      );
      if (videoCandidateTypes.length > 0) {
        const ready = await videoCandidatesPreflight();
        if (!ready.available) throw new FacadeError("UNSUPPORTED", ready.reason!);
      }
      const state = await this.config.store.getState();
      const media = state.project.mediaLibrary.items.find(
        (item) => item.id === valid.mediaId,
      );
      if (!media) {
        throw new FacadeError(
          "NOT_FOUND",
          `media.analyze_start: media "${valid.mediaId}" not found`,
          { mediaId: valid.mediaId },
        );
      }
      if (valid.analysisTypes.includes("videoReview") && media.type !== "video") throw new FacadeError("UNSUPPORTED", "videoReview requires video media");
      let transcriptModelDir: string | null | undefined;
      if (transcriptParams) transcriptModelDir = await assertTranscriptModelReady(transcriptParams);
      const startSec = valid.startSec ?? 0;
      const endSec = valid.endSec ?? media.metadata.duration;
      if (!(endSec > startSec) || endSec > media.metadata.duration ||
          (audioBackedTypes.length > 0 && endSec - startSec > AUDIO_LIMITS.maxRangeSec)) {
        throw new FacadeError("INVALID_PARAMS", "Analysis requires 0 ≤ startSec < endSec ≤ source duration; audioSummary, silence, beatGrid, speechActivity, speechTranscript and syncOffset ranges are at most 120 seconds. Split longer sources into explicit ranges.");
      }
      const payload = {
        mediaId: valid.mediaId,
        analysisTypes: [...valid.analysisTypes].sort(),
        startSec: valid.startSec, endSec: valid.endSec, cloudUpload: valid.cloudUpload, reviewQuestion: valid.reviewQuestion,
        silenceParams,
        vadParams,
        syncOffsetParams,
        transcriptParams,
      };
      const receipt = await this.replayLookup<{
        jobId: string;
        sourceRevision: number;
        analysisTypes: readonly import("./types").MediaAnalysisType[];
      }>("media.analyze_start", valid.idempotencyKey, payload);
      if (receipt?.prior && this.jobs.has(receipt.prior.value.jobId)) {
        return ok<MediaAnalyzeStartResult>({
          ...receipt.prior.value,
          kind: "analysis",
          state: this.jobs.get(receipt.prior.value.jobId)?.state ?? "queued",
          replayed: true,
        });
      }
      if (
        valid.expectedRevision !== undefined &&
        valid.expectedRevision !== state.revision
      ) {
        throw new FacadeError(
          "CONFLICT",
          `revision conflict: expected ${valid.expectedRevision}, current is ${state.revision}`,
          { currentRevision: state.revision },
        );
      }
      const originalUrl = typeof media.contentUrl === "string" ? media.contentUrl
        : typeof media.originalUrl === "string" ? media.originalUrl : "";
      const resolution = resolveContainedPathDetailed(
        originalUrl,
        this.config.mediaRoots ?? [],
      );
      if (resolution.kind !== "ok") {
        throw new FacadeError(
          "UNSUPPORTED",
          `media.analyze_start: media "${valid.mediaId}" is outside configured media roots or unreadable`,
        );
      }
      const sourceStat = await stat(resolution.path).catch(() => null);
      if (!sourceStat?.isFile() || sourceStat.size > MAX_MEDIA_FILE_BYTES) {
        throw new FacadeError(
          "UNSUPPORTED",
          `media.analyze_start: media "${valid.mediaId}" is not file-backed and readable from the desktop host`,
        );
      }
      if (valid.analysisTypes.includes("videoReview")) {
        const ready = await videoReviewPreflight();
        if (!ready.available) throw new FacadeError("UNSUPPORTED", ready.reason!);
      }
      let syncReference: SyncOffsetReference | undefined;
      if (syncOffsetParams) {
        const referenceMedia = state.project.mediaLibrary.items.find((item) => item.id === syncOffsetParams.referenceMediaId);
        if (!referenceMedia) {
          throw new FacadeError("NOT_FOUND", `syncOffset: reference media "${syncOffsetParams.referenceMediaId}" is not in this project's media library`, { referenceMediaId: syncOffsetParams.referenceMediaId });
        }
        const targetDurationSec = endSec - startSec;
        const referenceEndSec = syncOffsetParams.referenceStartSec + targetDurationSec;
        if (referenceEndSec > referenceMedia.metadata.duration + 1 / SYNC_OFFSET_ANALYSIS_RATE) {
          throw new FacadeError("INVALID_PARAMS", `syncOffset: reference range ${syncOffsetParams.referenceStartSec.toFixed(3)}–${referenceEndSec.toFixed(3)}s exceeds reference media duration ${referenceMedia.metadata.duration.toFixed(3)}s`, { referenceMediaId: referenceMedia.id, referenceDurationSec: referenceMedia.metadata.duration });
        }
        const referenceUrl = typeof referenceMedia.contentUrl === "string" ? referenceMedia.contentUrl
          : typeof referenceMedia.originalUrl === "string" ? referenceMedia.originalUrl : "";
        const referenceResolution = resolveContainedPathDetailed(referenceUrl, this.config.mediaRoots ?? []);
        if (referenceResolution.kind !== "ok") {
          throw new FacadeError("UNSUPPORTED", `syncOffset: reference media "${referenceMedia.id}" is outside configured media roots or unreadable`);
        }
        const referenceStat = await stat(referenceResolution.path).catch(() => null);
        if (!referenceStat?.isFile() || referenceStat.size > MAX_MEDIA_FILE_BYTES) {
          throw new FacadeError("UNSUPPORTED", `syncOffset: reference media "${referenceMedia.id}" is not backed by a readable source file`);
        }
        syncReference = {
          mediaId: referenceMedia.id,
          name: referenceMedia.name,
          path: referenceResolution.path,
          startSec: syncOffsetParams.referenceStartSec,
          endSec: referenceEndSec,
          durationSec: referenceMedia.metadata.duration,
          sourceFingerprint: { size: referenceStat.size, lastModified: Math.round(referenceStat.mtimeMs) },
        };
      }
      this.assertTaskCapacity("media.analyze_start");
      const sourcePath = resolution.path;
      const jobId = `job-${crypto.randomUUID()}`;
      const analysisTypes = [...valid.analysisTypes];
      const identity = await this.config.store.getIdentity();
      if (identity.projectId !== state.project.id) {
        throw new FacadeError("CONFLICT", "media.analyze_start: target workspace changed while the input was being prepared");
      }
      const workspaceId = identity.workspaceId ?? "default";
      const payloadHash = stableStringify(payload);
      await this.createTrackedTask({
        jobId,
        kind: "analysis",
        projectId: state.project.id,
        workspaceId,
        sourceRevision: state.revision,
        inputProject: structuredClone(state.project),
        parameters: {
          ...payload,
          ...(valid.idempotencyKey ? { idempotencyKey: valid.idempotencyKey } : {}),
          payloadHash,
        },
      });
      const controller = new AbortController();
      this.analysisControllers.set(jobId, controller);
      const ledgerValue = {
        jobId,
        sourceRevision: state.revision,
        analysisTypes,
      };
      receipt?.commit(ledgerValue, state.revision);
      void this.runTechnicalQualityAnalysis(
        jobId,
        sourcePath,
        media.id,
        media.name,
        analysisTypes,
        controller,
        { startSec, endSec },
        state.project.id,
        state.revision,
        valid.reviewQuestion,
        valid.recheckOfRecordId,
        silenceParams,
        vadParams,
        syncOffsetParams,
        syncReference,
        transcriptParams,
        transcriptModelDir,
      );
      return ok<MediaAnalyzeStartResult>({
        ...ledgerValue,
        kind: "analysis",
        state: "queued",
        replayed: false,
      });
    });
  }

  /* ---------------------------- edit.apply ---------------------------- */

  async editApply(
    params: EditApplyParams,
  ): Promise<FacadeResult<EditApplyResult>> {
    return this.enqueue(async () => {
      this.gate("edit.apply");
      const valid = validateObject<EditApplyParams>(
        params,
        EDIT_APPLY_SCHEMA,
        "edit.apply params",
      );
      // Pre-validate EVERY op's closed schema before any state access —
      // same zero-side-effect ordering as headless.
      const ops = parseEditOps("edit.apply", valid.ops);

      // Idempotent replay first (headless semantics): a transport retry
      // replays the committed result without touching the store.
      const payload = { ops };
      const receipt = await this.replayLookup<EditApplyPayload>(
        "edit.apply",
        valid.idempotencyKey,
        payload,
      );
      if (receipt?.prior) {
        return ok<EditApplyResult>({
          ...receipt.prior.value,
          revision: receipt.prior.revision,
          replayed: true,
        });
      }

      if (valid.idempotencyKey !== undefined && this.config.store.getActionBatchReplay) {
        let durablePrior: LiveApplyActionsResult | null;
        try {
          durablePrior = await this.config.store.getActionBatchReplay(
            valid.idempotencyKey,
            payload,
            "agent: edit.apply",
          );
        } catch (error) {
          if (isLiveStoreConflict(error)) {
            throw new FacadeError(
              "CONFLICT",
              `edit.apply: ${error instanceof Error ? error.message : String(error)}`,
              error instanceof LiveStoreConflictError ? error.details : undefined,
            );
          }
          throw error;
        }
        if (durablePrior) {
          const projection = durablePrior.idempotencyMetadata;
          if (!projection) {
            throw new FacadeError(
              "UNSUPPORTED",
              "edit.apply: the durable replay receipt is missing its per-operation result projection",
            );
          }
          const applied = partitionCreatedIds(
            ops,
            durablePrior.createdIds,
            projection.autoTrackIds,
            projection.opClipCounts,
          );
          const value: EditApplyPayload = { applied };
          receipt?.commit(value, durablePrior.revision);
          return ok<EditApplyResult>({
            revision: durablePrior.revision,
            applied,
            replayed: true,
          });
        }
      }

      // On-demand snapshot read: translation and the facade-level semantic
      // pre-checks run against THIS state; the store re-CASes at apply time
      // (a human edit landing in between is caught there, never silently
      // overwritten — Decision 3).
      const { project: snapshot, revision } = await this.config.store.getState();

      // expectedRevision fail-fast against the snapshot the ops were
      // translated from (headless parity: the guard runs before any apply
      // attempt); the store's own CAS remains the authority.
      if (
        valid.expectedRevision !== undefined &&
        valid.expectedRevision !== revision
      ) {
        throw new FacadeError(
          "CONFLICT",
          `revision conflict: expected ${valid.expectedRevision}, current is ${revision}`,
          { currentRevision: revision },
        );
      }
      // Caller-assigned clip ids cannot be honored live: the canonical
      // store applies the core action stream and core mints clip ids
      // (headless renames inside its private draft transaction; there is no
      // draft here). Reject honestly rather than silently ignoring the id.
      for (const [index, op] of ops.entries()) {
        if (op.op === "clip.add" && op.clipId !== undefined) {
          throw new FacadeError(
            "INVALID_PARAMS",
            `edit.apply: ops[${index}] clip.add with an explicit clipId is not supported in live mode — the canonical store mints clip ids; omit clipId and use the createdIds the result reports`,
            { opIndex: index },
          );
        }
      }

      // Translate with the SAME ops.ts translator as headless (Decision 2:
      // one contract), running its existence pre-checks and a full executor
      // dry-run against a clone of the snapshot so intra-batch references
      // resolve sequentially and a doomed batch never reaches the store.
      const draft = structuredClone(snapshot);
      const executor = new ActionExecutor(new ActionHistory());
      const preparation = this.editOpPreparation("edit.apply");
      const actions: Action[] = [];
      // Per op: either ONE implicit lane id (text.create/svg.create) or EVERY
      // lane the op's translator emitted (workAsset.instantiate multi
      // expansion) — partitionCreatedIds pins all of them to THIS op so an
      // explicit track.add in the same batch cannot steal or reorder them.
      const autoTrackIds: Array<string | readonly string[] | undefined> = [];
      // Per op: how many clips the op minted (workAsset.instantiate multi
      // expands to one clip per member); undefined = exactly one.
      const opClipCounts: Array<number | undefined> = [];
      for (const [index, submitted] of ops.entries()) {
        // Prepare against the draft that already contains earlier ops in this
        // batch (file-backed ops + record-driven ducking).
        const op = await prepareEditOp(submitted, draft, index, preparation);
        // text.create/svg.create with no explicit track imply their lane;
        // when that lane is missing, the translator prepends one track/add
        // whose id partitionCreatedIds must pin for THIS op (an explicit
        // track.add op in the same batch must not steal or reorder it).
        const impliedTrackType =
          op.op === "text.create" && op.trackId === undefined
            ? "text"
            : op.op === "svg.create" && op.trackId === undefined
              ? "graphics"
              : null;
        const hadImpliedTrack =
          impliedTrackType === null
            ? true
            : draft.timeline.tracks.some(
                (track) => track.type === impliedTrackType,
              );
        const opActions = opToCoreActions(op, draft);
        for (const action of opActions) {
          const result = await executor.execute(action, draft);
          if (!result.success) {
            throw new FacadeError(
              "ACTION_FAILED",
              `edit.apply: ops[${index}] (${op.op}) failed: ${result.error?.message ?? "unknown core error"}`,
              {
                opIndex: index,
                op: op.op,
                coreCode: result.error?.code,
              },
            );
          }
        }
        autoTrackIds[index] =
          impliedTrackType !== null && !hadImpliedTrack
            ? (opActions.find((action) => action.type === "track/add")?.params
                .trackId as string | undefined)
            : op.op === "workAsset.instantiate"
              ? // Every lane the expansion created; an explicit trackId only
                // binds the anchor lane, so the anchor then has no track/add
                // and is simply not listed here.
                opActions
                  .filter((action) => action.type === "track/add")
                  .map(
                    (action) => action.params.trackId as string,
                  )
              : undefined;
        opClipCounts[index] =
          op.op === "workAsset.instantiate"
            ? opActions.filter((action) => action.type === "clip/add").length
            : undefined;
        actions.push(...opActions);
      }

      let committed: LiveApplyActionsResult;
      try {
        this.gate("edit.apply");
        committed = await this.config.store.applyActions(actions, {
          groupLabel: "agent: edit.apply",
          // The renderer CAS is UNCONDITIONAL in live mode: a caller that
          // omits expectedRevision is guarded with the revision of the
          // snapshot the ops were translated against, so a human edit
          // landing between translate and apply is a CONFLICT — never a
          // silent stale-overwrite (Decision 3). An explicit caller
          // expectedRevision is honored as-is (fail-fast checked above).
          expectedRevision: valid.expectedRevision ?? revision,
          ...(valid.expectedContextRevision !== undefined
            ? { expectedContextRevision: valid.expectedContextRevision }
            : {}),
          ...(valid.idempotencyKey !== undefined
            ? { idempotencyKey: valid.idempotencyKey }
            : {}),
          ...(valid.idempotencyKey !== undefined
            ? { idempotencyPayload: payload }
            : {}),
          ...(valid.idempotencyKey !== undefined
            ? { idempotencyMetadata: { autoTrackIds, opClipCounts } }
            : {}),
        });
      } catch (error) {
        // Store CONFLICTs become facade CONFLICT results — domain errors
        // are never thrown across the facade boundary.
        if (isLiveStoreConflict(error)) {
          throw new FacadeError(
            "CONFLICT",
            `edit.apply: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof LiveStoreConflictError ? error.details : undefined,
          );
        }
        throw error;
      }

      // Partition the store-diffed created ids back onto the ops: every
      // creating op consumes one id from its own category bucket (the store
      // diffs per category, so a mixed batch can't cross-assign ids).
      const applied = partitionCreatedIds(
        ops,
        committed.createdIds,
        autoTrackIds,
        opClipCounts,
      );
      const value: EditApplyPayload = { applied };
      receipt?.commit(value, committed.revision);
      return ok<EditApplyResult>({
        revision: committed.revision,
        applied,
        replayed: false,
      });
    });
  }

  /* --------------------- preview / export / verify -------------------- */

  /**
   * preview.render_frame (live): rasterize ONE PNG frame of a fresh
   * snapshot through the configured RenderProvider — the same render path
   * the GUI and headless use (Decision 10: one world, one render result).
   */
  async previewRenderFrame(
    params: PreviewRenderFrameParams,
  ): Promise<FacadeResult<PreviewRenderFrameResult>> {
    return this.enqueue(async () => {
      this.gate("preview.render_frame");
      const valid = validateObject<PreviewRenderFrameParams>(
        params,
        PREVIEW_RENDER_FRAME_SCHEMA,
        "preview.render_frame params",
      );
      const provider = this.config.renderProvider;
      if (!provider) {
        throw new FacadeError(
          "UNSUPPORTED",
          "preview.render_frame: no render provider configured for this session",
          { requires: "RenderProvider (e.g. @reelterminal/runtime-chromium)" },
        );
      }
      const artifactRoot = requireArtifactRoot(
        this.config.artifactRoot,
        "preview.render_frame",
      );
      await requireProviderPreflight(provider, "preview.render_frame");

      const { project, revision } = await this.config.store.getState();

      const width = valid.width ?? project.settings.width;
      const height = valid.height ?? project.settings.height;
      if (!isEvenDimension(width) || !isEvenDimension(height)) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `preview.render_frame: raster size must be even; project settings are ${project.settings.width}x${project.settings.height} — pass explicit even width/height`,
        );
      }

      const duration = timelineDurationSec(project);
      if (valid.timeSec > duration) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `preview.render_frame: timeSec ${valid.timeSec} is beyond the timeline duration ${duration}`,
          { timeSec: valid.timeSec, durationSec: duration },
        );
      }
      // The exact end of the timeline is past every clip's [start, end)
      // interval; clamp it onto the last rendered frame.
      const frameRate = project.settings.frameRate;
      const timeSec =
        valid.timeSec >= duration
          ? Math.max(0, duration - 1 / (2 * frameRate))
          : valid.timeSec;

      const payload = { timeSec: valid.timeSec, width, height };
      const receipt = await this.replayLookup<PreviewRenderFrameResult>(
        "preview.render_frame",
        valid.idempotencyKey,
        payload,
      );
      if (receipt?.prior) {
        // Replay only while the artifact file still exists; a deleted file
        // falls through to an honest re-render of the same deterministic path.
        const stillThere = await stat(receipt.prior.value.artifact.path).then(
          (s) => s.isFile(),
          () => false,
        );
        if (stillThere) {
          // Mirrors headless session.ts exactly (same spread + overwrite):
          // the top-level revision is the CURRENT one — the verb runs now —
          // while artifact.sourceRevision (inside prior.value, untouched)
          // keeps the truth about which snapshot the PNG was rendered from.
          return ok<PreviewRenderFrameResult>({
            ...receipt.prior.value,
            revision,
            replayed: true,
          });
        }
      }
      // The optional expectedRevision is a pure guard against the snapshot
      // this frame would render (a read guard; nothing is mutated). Mirrors
      // headless ordering: replay resolves first, the guard second.
      if (
        valid.expectedRevision !== undefined &&
        valid.expectedRevision !== revision
      ) {
        throw new FacadeError(
          "CONFLICT",
          `revision conflict: expected ${valid.expectedRevision}, current is ${revision}`,
          { currentRevision: revision },
        );
      }

      const renderProject = await this.prepareRenderProject(project);
      const mediaFiles = await this.buildLiveMediaFiles(
        project,
        "preview.render_frame",
      );
      const sourceRevision = revision;
      const mediaFingerprints = await fingerprintMediaFiles(mediaFiles);
      const requestKey = inspectionRequestKey({
        projectId: project.id,
        revision: sourceRevision,
        selector: { kind: "preview", timeSec },
        sampleTimesMs: [Math.round(timeSec * 1000)],
        width,
        height,
        maxFrameBytes: MAX_VISUAL_PNG_BYTES,
        media: mediaFingerprints,
      });
      const rendersDir = resolvePath(artifactRoot, "renders");
      // Same containment discipline as headless, before AND after the write.
      await prepareArtifactDir(rendersDir, artifactRoot, "preview.render_frame");
      const timeMs = Math.round(valid.timeSec * 1000);
      const stem = `frame-${project.id}-r${sourceRevision}-${requestKey}-t${timeMs}-${width}x${height}`;
      const tempPath = pendingArtifactPath(rendersDir, stem, "png");
      const finalPath = resolvePath(rendersDir, `${stem}.png`);

      this.gate("preview.render_frame");
      const rendered = await provider.renderFramePng({
        project: structuredClone(renderProject),
        sourceRevision,
        timeSec,
        width,
        height,
        destPath: tempPath,
        mediaFiles,
      });
      const verifiedTemp = await assertContainedWrittenFile(
        tempPath,
        artifactRoot,
        "preview.render_frame",
      );
      try {
        await assertMediaFingerprintsUnchanged(
          mediaFiles,
          mediaFingerprints,
          "preview.render_frame",
        );
      } catch (error) {
        await discardArtifact(verifiedTemp);
        throw error;
      }
      const verifiedPath = await publishArtifact({
        tempPath: verifiedTemp,
        finalPath,
        artifactRoot,
        verb: "preview.render_frame",
      });
      const artifact = await artifactRefFor(
        verifiedPath,
        "image",
        "png",
        sourceRevision,
        rendered.bytesWritten,
      );
      const value: PreviewRenderFrameResult = {
        revision: sourceRevision,
        timeSec,
        width,
        height,
        artifact,
        replayed: false,
      };
      receipt?.commit(value, sourceRevision);
      return ok(value);
    });
  }

  /** Live preview.render_comparison: reads the canonical shared comparison
   * config; renders through the same Chromium provider as preview.render_frame. */
  async previewRenderComparison(
    params: PreviewRenderComparisonParams,
  ): Promise<FacadeResult<PreviewRenderComparisonResult>> {
    return this.enqueue(async () => {
      this.gate("preview.render_comparison");
      const valid = validateObject<PreviewRenderComparisonParams>(
        params,
        PREVIEW_RENDER_COMPARISON_SCHEMA,
        "preview.render_comparison params",
      );
      const provider = this.config.renderProvider;
      if (!provider) {
        throw new FacadeError(
          "UNSUPPORTED",
          "preview.render_comparison: no render provider configured for this session",
          { requires: "RenderProvider (e.g. @reelterminal/runtime-chromium)" },
        );
      }
      const artifactRoot = requireArtifactRoot(this.config.artifactRoot, "preview.render_comparison");
      await requireProviderPreflight(provider, "preview.render_comparison");

      const { project, revision } = await this.config.store.getState();
      const config = requireComparisonConfig(project, "preview.render_comparison");
      const duration = timelineDurationSec(project);
      if (valid.timeSec > duration) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `preview.render_comparison: timeSec ${valid.timeSec} is beyond the timeline duration ${duration}`,
          { timeSec: valid.timeSec, durationSec: duration },
        );
      }
      const width = valid.width ?? project.settings.width;
      const height = valid.height ?? project.settings.height;
      if (!isEvenDimension(width) || !isEvenDimension(height)) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `preview.render_comparison: raster size must be even; project settings are ${project.settings.width}x${project.settings.height} — pass explicit even width/height`,
        );
      }
      const frameRate = project.settings.frameRate;
      const timeSec =
        valid.timeSec >= duration
          ? Math.max(0, duration - 1 / (2 * frameRate))
          : valid.timeSec;
      const frameBudgetBytes = valid.maxFrameBytes ?? DEFAULT_FRAME_BUDGET_BYTES;

      const payload = {
        timeSec: valid.timeSec,
        width,
        height,
        layout: valid.layout ?? config.layout,
        maxFrameBytes: frameBudgetBytes,
      };
      const receipt = await this.replayLookup<PreviewRenderComparisonResult>(
        "preview.render_comparison",
        valid.idempotencyKey,
        payload,
      );
      if (receipt?.prior) {
        const stillThere = await stat(receipt.prior.value.artifact.path).then((s) => s.isFile(), () => false);
        if (stillThere) {
          return ok<PreviewRenderComparisonResult>({
            ...receipt.prior.value,
            revision,
            replayed: true,
          });
        }
      }
      if (
        valid.expectedRevision !== undefined &&
        valid.expectedRevision !== revision
      ) {
        throw new FacadeError(
          "CONFLICT",
          `revision conflict: expected ${valid.expectedRevision}, current is ${revision}`,
          { currentRevision: revision },
        );
      }

      const renderProject = await this.prepareRenderProject(project);
      const sourceRevision = revision;
      const mediaFiles = await withComparisonReference(
        project,
        config,
        await this.buildLiveMediaFiles(project, "preview.render_comparison"),
        (item) => this.resolveLiveMediaItemFile(item),
      );
      const referencePath = referenceFilePath(project, config, mediaFiles, "preview.render_comparison");

      const rendersDir = resolvePath(artifactRoot, "renders");
      await prepareArtifactDir(rendersDir, artifactRoot, "preview.render_comparison");
      const timelineTemp = pendingArtifactPath(rendersDir, `cmp-src-${project.id}-r${sourceRevision}-t${Math.round(timeSec * 1000)}`, "png");
      try {
        await provider.renderFramePng({
          project: structuredClone(renderProject),
          sourceRevision,
          timeSec,
          width,
          height,
          destPath: timelineTemp,
          mediaFiles,
        });
        const value = await renderComparisonStill({
          project,
          sourceRevision,
          request: { timeSec, width, height, maxFrameBytes: frameBudgetBytes, layout: valid.layout },
          config,
          referencePath,
          timelineStillPath: timelineTemp,
          artifactRoot,
        });
        const result: PreviewRenderComparisonResult = {
          revision,
          sourceRevision,
          timeSec: value.timeSec,
          referenceSec: value.referenceSec,
          clamped: value.clamped,
          layout: value.layout,
          width: value.width,
          height: value.height,
          frameBudgetBytes: value.frameBudgetBytes,
          artifact: value.artifact,
          limitations: value.limitations,
          replayed: false,
        };
        receipt?.commit(result, sourceRevision);
        return ok(result);
      } finally {
        await discardArtifact(timelineTemp);
      }
    });
  }

  /** Live visual.inspect: reads the canonical store snapshot and never
   * creates a shadow project. Frames and optional contact sheet use the same
   * Chromium render provider as preview.render_frame. */
  async visualInspect(
    params: VisualInspectParams,
  ): Promise<FacadeResult<VisualInspectResult>> {
    return this.enqueue(async () => {
      this.gate("visual.inspect");
      const valid = validateObject<VisualInspectParams>(
        params,
        VISUAL_INSPECT_SCHEMA,
        "visual.inspect params",
      );
      validateVisualInspectTimeRange(valid);
      const provider = this.config.renderProvider;
      if (!provider) {
        throw new FacadeError(
          "UNSUPPORTED",
          "visual.inspect: no render provider configured for this session",
          { requires: "RenderProvider (e.g. @reelterminal/runtime-chromium)" },
        );
      }
      const artifactRoot = requireArtifactRoot(this.config.artifactRoot, "visual.inspect");
      await requireProviderPreflight(provider, "visual.inspect");

      const { project, revision } = await this.config.store.getState();
      const { plan, width, height, sampleCount } = prepareVisualInspectRenderPlan(project, valid);

      const payload = {
        ...(valid.clipId !== undefined ? { clipId: valid.clipId } : {}),
        ...(valid.timeRange !== undefined ? { timeRange: valid.timeRange } : {}),
        sampleCount,
        width,
        height,
        maxFrameBytes: valid.maxFrameBytes ?? DEFAULT_FRAME_BUDGET_BYTES,
      };
      const receipt = await this.replayLookup<VisualInspectResult>(
        "visual.inspect",
        valid.idempotencyKey,
        payload,
      );
      if (receipt?.prior) {
        const artifacts = [
          ...receipt.prior.value.frames.map((frame) => frame.artifact.path),
          ...(receipt.prior.value.contactSheet
            ? [receipt.prior.value.contactSheet.path]
            : []),
        ];
        const allThere = await Promise.all(
          artifacts.map((path) => stat(path).then((s) => s.isFile(), () => false)),
        );
        if (allThere.every(Boolean)) {
          return ok<VisualInspectResult>({
            ...receipt.prior.value,
            revision,
            replayed: true,
          });
        }
      }
      // Match preview.render_frame: an idempotent replay is resolved first;
      // otherwise expectedRevision guards the snapshot this read would use.
      if (
        valid.expectedRevision !== undefined &&
        valid.expectedRevision !== revision
      ) {
        throw new FacadeError(
          "CONFLICT",
          `revision conflict: expected ${valid.expectedRevision}, current is ${revision}`,
          { currentRevision: revision },
        );
      }

      const renderProject = await this.prepareRenderProject(project);
      const sourceRevision = revision;
      const mediaFiles = await this.buildLiveMediaFiles(project, "visual.inspect");
      const frameBudgetBytes = valid.maxFrameBytes ?? DEFAULT_FRAME_BUDGET_BYTES;
      // Immutable evidence: mirrors headless session.ts — the artifact name
      // embeds a hash of the full normalized request (selector, sampling
      // plan, raster, budget, revision, source media fingerprints) so a
      // different inspection never overwrites evidence an earlier response
      // still references.
      const mediaFingerprints = await fingerprintMediaFiles(mediaFiles);
      const requestKey = inspectionRequestKey({
        projectId: project.id,
        revision: sourceRevision,
        selector:
          valid.clipId !== undefined
            ? { kind: "clip", clipId: valid.clipId }
            : {
              kind: "timeRange",
              startSec: plan.selection.startSec,
              endSec: plan.selection.endSec,
            },
        sampleTimesMs: plan.samples.map((sample) => Math.round(sample.timeSec * 1000)),
        width,
        height,
        maxFrameBytes: frameBudgetBytes,
        media: mediaFingerprints,
      });
      const framesDir = resolvePath(artifactRoot, "visual", "frames");
      await prepareArtifactDir(framesDir, artifactRoot, "visual.inspect");
      const limitations: string[] = [];
      const frames = [] as VisualInspectResult["frames"][number][];
      let reencoded = 0;
      let overBudget = 0;
      for (const [index, sample] of plan.samples.entries()) {
        const stem = `frame-${project.id}-r${sourceRevision}-${requestKey}-${index}-${Math.round(sample.timeSec * 1000)}-${width}x${height}`;
        const tempPath = pendingArtifactPath(framesDir, stem, "png");
        const rendered = await provider.renderFramePng({
          project: structuredClone(renderProject),
          sourceRevision,
          timeSec: sample.timeSec,
          width,
          height,
          destPath: tempPath,
          mediaFiles,
        });
        if (rendered.bytesWritten > MAX_VISUAL_PNG_BYTES) {
          await discardArtifact(tempPath);
          throw new FacadeError(
            "JOB_FAILED",
            `visual.inspect: frame PNG exceeds the ${MAX_VISUAL_PNG_BYTES}-byte artifact limit`,
            { index },
          );
        }
        const verifiedTemp = await assertContainedWrittenFile(
          tempPath,
          artifactRoot,
          "visual.inspect",
        );
        // Tool results land in the caller agent's context: fit every frame
        // into the per-frame byte budget (lossless PNG when it already fits,
        // otherwise the deterministic JPEG ladder) and disclose the outcome.
        const fitted = await fitFrameToBudget({
          pngPath: verifiedTemp,
          width,
          height,
          budgetBytes: frameBudgetBytes,
          sourceWidth: project.settings.width,
          sourceHeight: project.settings.height,
        });
        const fittedTempPath = fitted.path === verifiedTemp
          ? verifiedTemp
          : await assertContainedWrittenFile(fitted.path, artifactRoot, "visual.inspect");
        if ((await stat(fittedTempPath)).size > MAX_VISUAL_PNG_BYTES) {
          await discardArtifact(fittedTempPath);
          throw new FacadeError(
            "JOB_FAILED",
            `visual.inspect: frame artifact exceeds the ${MAX_VISUAL_PNG_BYTES}-byte artifact limit`,
            { index },
          );
        }
        try {
          await assertMediaFingerprintsUnchanged(
            mediaFiles,
            mediaFingerprints,
            "visual.inspect",
          );
        } catch (error) {
          await discardArtifact(fittedTempPath);
          throw error;
        }
        const publishedPath = await publishArtifact({
          tempPath: fittedTempPath,
          finalPath: resolvePath(framesDir, `${stem}.${fitted.format === "jpeg" ? "jpg" : "png"}`),
          artifactRoot,
          verb: "visual.inspect",
        });
        const artifact = await artifactRefFor(
          publishedPath,
          "image",
          fitted.format,
          sourceRevision,
          fitted.format === "png" ? rendered.bytesWritten : undefined,
        );
        if (!fitted.fidelity.withinBudget) overBudget++;
        if (fitted.format === "jpeg") reencoded++;
        frames.push({
          index,
          timeSec: sample.timeSec,
          coordinateSpace: "timeline",
          requestedTimelineTimeSec: sample.timeSec,
          renderedTimelineTimeSec: null,
          sourceFrameNumber: null,
          sourcePtsSec: null,
          label: sample.label,
          sourceRevision,
          artifact,
          fidelity: fitted.fidelity,
        });
      }
      if (reencoded > 0) {
        limitations.push(
          `${reencoded} of ${frames.length} frame artifact(s) exceeded the ${frameBudgetBytes}-byte lossless budget and were re-encoded as lossy JPEG${overBudget > 0 ? `; ${overBudget} still did not fit and were delivered oversized` : ""}. See frames[].fidelity for the delivered raster and quality; re-request with roi, a smaller width, or a larger maxFrameBytes for finer detail.`,
        );
      }
      limitations.push(
        "Frame artifacts were requested at the reported timeline times; the render provider does not return an actual rendered timeline time, decoded source frame number or media PTS, so those values are unknown.",
      );

      let contactSheet: VisualInspectResult["contactSheet"] = null;
      if (provider.renderContactSheetPng) {
        const contactDir = resolvePath(artifactRoot, "visual", "contact-sheets");
        await prepareArtifactDir(contactDir, artifactRoot, "visual.inspect");
        const stem = `contact-${project.id}-r${sourceRevision}-${requestKey}-${sampleCount}-${width}x${height}`;
        const tempPath = pendingArtifactPath(contactDir, stem, "png");
        const finalPath = resolvePath(contactDir, `${stem}.png`);
        try {
          const rendered = await provider.renderContactSheetPng({
            project: structuredClone(renderProject),
            sourceRevision,
            samples: plan.samples,
            width,
            height,
            destPath: tempPath,
            mediaFiles,
          } satisfies RenderContactSheetRequest);
          const actualBytes = (await stat(tempPath).catch(() => null))?.size ?? 0;
          if (
            rendered.bytesWritten > MAX_VISUAL_PNG_BYTES ||
            actualBytes > MAX_VISUAL_PNG_BYTES ||
            actualBytes === 0
          ) {
            await discardArtifact(tempPath);
            limitations.push(
              `contact sheet exceeded the ${MAX_VISUAL_PNG_BYTES}-byte artifact limit; individual frame PNGs are returned`,
            );
          } else {
            await assertMediaFingerprintsUnchanged(
              mediaFiles,
              mediaFingerprints,
              "visual.inspect",
            );
            const publishedPath = await publishArtifact({
              tempPath,
              finalPath,
              artifactRoot,
              verb: "visual.inspect",
            });
            contactSheet = await artifactRefFor(
              publishedPath,
              "image",
              "png",
              sourceRevision,
              rendered.bytesWritten,
            );
          }
        } catch (error) {
          if (
            error instanceof FacadeError
            && (error.code === "JOB_FAILED" || error.code === "CONFLICT")
          ) {
            await discardArtifact(tempPath);
            throw error;
          }
          await discardArtifact(tempPath);
          limitations.push(
            `contact sheet unavailable: ${error instanceof Error ? error.message : String(error)}; individual frame PNGs are returned`,
          );
        }
      } else {
        limitations.push(
          "render provider does not expose native contact-sheet composition; individual frame PNGs are returned",
        );
      }

      const value: VisualInspectResult = {
        revision: sourceRevision,
        sourceRevision,
        selection: plan.selection,
        sampleCount,
        mediaSources: mediaFingerprints.map(({ mediaId, sizeBytes, mtimeMs, sha256 }) => ({
          mediaId,
          sizeBytes,
          mtimeMs,
          sha256,
        })),
        width,
        height,
        frameBudgetBytes,
        frames,
        contactSheet,
        limitations,
        replayed: false,
      };
      receipt?.commit(value, sourceRevision);
      return ok(value);
    });
  }

  /**
   * export.start (live): snapshot the canonical project NOW and hand the
   * frozen snapshot to the ExportProvider as a background job — later
   * edits (human or agent) never reach the job.
   */
  async exportStart(
    params: ExportStartParams,
  ): Promise<FacadeResult<ExportStartResult>> {
    return this.enqueue(async () => {
      this.gate("export.start");
      const valid = validateObject<ExportStartParams>(
        params,
        EXPORT_START_SCHEMA,
        "export.start params",
      );
      const provider = this.config.exportProvider;
      if (!provider) {
        throw new FacadeError(
          "UNSUPPORTED",
          "export.start: no export provider configured for this session",
          { requires: "ExportProvider (e.g. @reelterminal/runtime-chromium)" },
        );
      }
      const artifactRoot = requireArtifactRoot(
        this.config.artifactRoot,
        "export.start",
      );
      await requireProviderPreflight(provider, "export.start");
      this.assertTaskCapacity("export.start");

      const settingsInput =
        valid.settings !== undefined
          ? validateObject<NonNullable<ExportStartParams["settings"]>>(
              valid.settings,
              EXPORT_SETTINGS_SCHEMA,
              "export.start params.settings",
            )
          : undefined;

      // The payload pins the RAW destinationPath so an idempotent retry of
      // the same request replays even after the delivery created the file.
      const payload = {
        settings: settingsInput ?? null,
        destinationPath: valid.destinationPath ?? null,
        comparison: valid.comparison ?? null,
      };
      const receipt = await this.replayLookup<{ jobId: string; sourceRevision: number }>(
        "export.start",
        valid.idempotencyKey,
        payload,
      );
      if (receipt?.prior && this.jobs.has(receipt.prior.value.jobId)) {
        const job = this.jobs.get(receipt.prior.value.jobId);
        return ok<ExportStartResult>({
          jobId: receipt.prior.value.jobId,
          state: job?.state ?? "queued",
          sourceRevision: receipt.prior.value.sourceRevision,
          replayed: true,
        });
      }

      // Validate the delivery destination BEFORE any job state exists: a bad
      // destination fails fast with zero side effects (same as headless).
      const delivery =
        valid.destinationPath !== undefined
          ? await resolveDeliveryDestination(
              valid.destinationPath,
              this.config.deliveryRoots ?? [],
              "export.start",
            )
          : null;

      const { project, revision } = await this.config.store.getState();
      if (
        valid.expectedRevision !== undefined &&
        valid.expectedRevision !== revision
      ) {
        throw new FacadeError(
          "CONFLICT",
          `revision conflict: expected ${valid.expectedRevision}, current is ${revision}`,
          { currentRevision: revision },
        );
      }

      const duration = timelineDurationSec(project);
      if (duration <= 0) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "export.start: the timeline is empty — add clips before exporting",
        );
      }
      const toEven = (n: number) => n - (n % 2);
      const width = settingsInput?.width ?? toEven(project.settings.width);
      const height = settingsInput?.height ?? toEven(project.settings.height);
      if (!isEvenDimension(width) || !isEvenDimension(height)) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `export.start: export size must be even and ≥2; resolved ${width}x${height}`,
        );
      }
      const frameRate = settingsInput?.frameRate ?? project.settings.frameRate;
      const videoBitrateKbps =
        settingsInput?.videoBitrateKbps ??
        Math.min(12000, Math.max(400, Math.round((width * height * frameRate * 0.12) / 1000)));

      // Comparison exports need the shared config and a valid range BEFORE
      // any job state exists — a bad request fails fast with zero effects.
      const comparisonConfig = valid.comparison
        ? requireComparisonConfig(project, "export.start")
        : null;
      if (valid.comparison) {
        validateComparisonRange(project, valid.comparison);
      }

      // The snapshot is the export's entire world: deep-cloned here,
      // synchronously, inside the serialized lane.
      let snapshot = await this.prepareRenderProject(structuredClone(project));
      const sourceRevision = revision;
      const mediaFiles = await this.buildLiveMediaFiles(project, "export.start");
      if (comparisonConfig) {
        Object.assign(
          mediaFiles,
          await withComparisonReference(project, comparisonConfig, mediaFiles, (item) =>
            this.resolveLiveMediaItemFile(item),
          ),
        );
      }

      const jobId = `job-${crypto.randomUUID()}`;
      const exportsDir = resolvePath(artifactRoot, "exports");
      this.gate("export.start");
      await prepareArtifactDir(exportsDir, artifactRoot, "export.start");
      const jobDir = resolvePath(exportsDir, jobId);
      this.gate("export.start");
      await prepareArtifactDir(jobDir, artifactRoot, "export.start");
      this.gate("export.start");
      const identity = await this.config.store.getIdentity();
      if (identity.projectId !== project.id) {
        throw new FacadeError("CONFLICT", "export.start: target workspace changed while the input was being prepared");
      }
      const workspaceId = identity.workspaceId ?? "default";
      const payloadHash = stableStringify(payload);
      snapshot = await this.createTrackedTask({
        jobId,
        kind: "export",
        projectId: project.id,
        workspaceId,
        sourceRevision,
        inputProject: snapshot,
        parameters: {
          settings: settingsInput ?? null,
          destinationPath: valid.destinationPath ?? null,
          comparison: valid.comparison ?? null,
          ...(valid.idempotencyKey ? { idempotencyKey: valid.idempotencyKey } : {}),
          payloadHash,
        },
      });
      receipt?.commit({ jobId, sourceRevision }, sourceRevision);

      const comparisonRange = valid.comparison ?? null;
      const callbacks: ExportCallbacks = {
        onRunning: () => this.jobs.markRunning(jobId),
        onProgress: (event) => this.jobs.markProgress(jobId, event),
        onDone: (completion) => {
          if (!comparisonConfig || !comparisonRange) {
            void this.finalizeExport(jobId, sourceRevision, completion, delivery);
            return;
          }
          // Comparison export: compose the reference against the JUST
          // FINISHED canonical export (the timeline was rendered exactly
          // once), then publish the composed file as the job's artifact.
          void (async () => {
            try {
              this.jobs.markProgress(jobId, { phase: "encoding", percent: 0.95 });
              const composedPath = resolvePath(jobDir, "comparison.mp4");
              const composed = await composeComparisonVideo({
                config: comparisonConfig,
                referencePath: referenceFilePath(
                  snapshot,
                  comparisonConfig,
                  mediaFiles,
                  "export.start",
                ),
                timelineExportPath: completion.path,
                destPath: composedPath,
                width,
                height,
                frameRate,
                range: comparisonRange,
              });
              await this.finalizeExport(
                jobId,
                sourceRevision,
                {
                  path: composedPath,
                  sizeBytes: composed.sizeBytes,
                  route: "comparison-compose",
                  ...(completion.upscalingRequestedButInactive !== undefined
                    ? {
                        upscalingRequestedButInactive:
                          completion.upscalingRequestedButInactive,
                      }
                    : {}),
                },
                delivery,
              );
            } catch (error) {
              this.jobs.markError(jobId, {
                code: error instanceof FacadeError ? error.code : "JOB_FAILED",
                message: `comparison export failed: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          })();
        },
        onError: (error) => this.jobs.markError(jobId, error),
        onCancelled: () => this.jobs.markCancelled(jobId),
      };
      // Fire-and-forget: the verb has already answered. A synchronously
      // throwing provider still lands in a terminal error state.
      void provider
        .startExport(
          {
            project: snapshot,
            sourceRevision,
            settings: {
              format: "mp4",
              codec: "h264",
              width,
              height,
              frameRate,
              videoBitrateKbps,
              ...(settingsInput?.upscaling !== undefined
                ? { upscaling: settingsInput.upscaling }
                : {}),
            },
            jobId,
            jobDir,
            mediaFiles,
          },
          callbacks,
        )
        .catch((error: unknown) => {
          this.jobs.markError(jobId, {
            code: "JOB_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
        });

      return ok<ExportStartResult>({
        jobId,
        state: "queued",
        sourceRevision,
        replayed: false,
      });
    });
  }

  /** analysis.list — durable analysis records, newest first, staleness-checked. */
  async analysisList(params?: AnalysisListParams): Promise<FacadeResult<AnalysisListResult>> {
    return this.enqueue(async () => {
      this.gate("analysis.list");
      const valid = validateObject<AnalysisListParams>(params ?? {}, ANALYSIS_LIST_SCHEMA, "analysis.list params");
      const artifactRoot = requireArtifactRoot(this.config.artifactRoot, "analysis.list");
      const records = await listAnalysisRecords(artifactRoot, valid);
      return ok(records.map((record) => ({
        id: record.id,
        finishedAt: record.finishedAt,
        sourceRevision: record.sourceRevision,
        coordinateSpace: record.coordinateSpace,
        subject: { mediaId: record.subject.mediaId, name: record.subject.name },
        analysisTypes: record.analysisTypes,
        stale: { kind: record.stale.kind },
        recheckOf: record.recheckOf,
      })));
    });
  }

  /** analysis.get — compact view by default; explicit detail requests are paged. */
  async analysisGet(params: AnalysisGetParams): Promise<FacadeResult<unknown>> {
    return this.enqueue(async () => {
      this.gate("analysis.get");
      const valid = validateObject<AnalysisGetParams>(params, ANALYSIS_GET_SCHEMA, "analysis.get params");
      validateAnalysisGetQuery(valid);
      const artifactRoot = requireArtifactRoot(this.config.artifactRoot, "analysis.get");
      return ok(await getAnalysisRecordView(artifactRoot, valid));
    });
  }

  /** job.status — poll this session's job registry (read-only verb). */
  currentJob(jobId: string): JobStatusView | null {
    const job = this.jobs.get(jobId);
    return job ? jobStatusView(job) : null;
  }

  observeJob(jobId: string, persist: (job: JobStatusView) => void): void {
    this.jobs.observe(jobId, persist);
  }

  async jobStatus(params: JobParams): Promise<FacadeResult<JobStatusView>> {
    return this.enqueue(async () => {
      const valid = validateObject<JobParams>(params, JOB_PARAMS_SCHEMA, "job.status params");
      const job = this.jobs.get(valid.jobId);
      if (!job) {
        throw new FacadeError("NOT_FOUND", `job.status: unknown jobId "${valid.jobId}"`, {
          jobId: valid.jobId,
        });
      }
      return ok(jobStatusView(job));
    });
  }

  /** job.cancel — cooperative cancellation (mirrors headless). */
  async jobCancel(params: JobParams): Promise<FacadeResult<JobStatusView>> {
    return this.enqueue(async () => {
      this.gate("job.cancel");
      const valid = validateObject<JobParams>(params, JOB_PARAMS_SCHEMA, "job.cancel params");
      const job = this.jobs.get(valid.jobId);
      if (!job) {
        throw new FacadeError("NOT_FOUND", `job.cancel: unknown jobId "${valid.jobId}"`, {
          jobId: valid.jobId,
        });
      }
      if (job.state === "done" || job.state === "error" || job.state === "cancelled") {
        return ok(jobStatusView(job));
      }
      if (job.kind === "analysis") {
        this.jobs.markCancelRequested(valid.jobId);
        this.analysisControllers.get(valid.jobId)?.abort();
        this.jobs.markCancelled(valid.jobId);
        return ok(jobStatusView(this.jobs.get(valid.jobId) ?? job));
      }
      if (job.kind === "audio-process") {
        this.jobs.markCancelRequested(valid.jobId);
        this.analysisControllers.get(valid.jobId)?.abort();
        return ok(jobStatusView(this.jobs.get(valid.jobId) ?? job));
      }
      const provider = this.config.exportProvider;
      if (!provider) {
        throw new FacadeError(
          "UNSUPPORTED",
          "job.cancel: no export provider configured for this session",
        );
      }
      this.jobs.markCancelRequested(valid.jobId);
      try {
        // The cancel path must never wedge the session's serialized lane.
        await cancelExportWithin(provider, valid.jobId);
      } catch (error) {
        throw new FacadeError(
          "JOB_FAILED",
          `job.cancel: provider failed to cancel: ${error instanceof Error ? error.message : String(error)}`,
          { jobId: valid.jobId },
        );
      }
      return ok(jobStatusView(this.jobs.get(valid.jobId) ?? job));
    });
  }

  /**
   * verify.artifact (live): read-only inspection of a file inside
   * artifactRoot, or of a delivered copy at its exact deliveredTo location
   * (`<deliveryRoot>/jobs/<slug>/output/` — same rule as headless). The
   * live session has no mediaRoots, so compare references must live inside
   * artifactRoot.
   */
  async verifyArtifact(
    params: VerifyArtifactParams,
  ): Promise<FacadeResult<VerifyArtifactResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<VerifyArtifactParams>(
        params,
        VERIFY_ARTIFACT_SCHEMA,
        "verify.artifact params",
      );
      const verifier = this.config.artifactVerifier;
      if (!verifier) {
        throw new FacadeError(
          "UNSUPPORTED",
          "verify.artifact: no artifact verifier configured for this session",
          { requires: "ArtifactVerifier backed by ffprobe/ffmpeg" },
        );
      }
      await requireProviderPreflight(verifier, "verify.artifact");

      const artifactRoot = requireArtifactRoot(
        this.config.artifactRoot,
        "verify.artifact",
      );
      const targetPath = await resolveVerifyArtifactTarget(
        valid.path,
        artifactRoot,
        this.config.deliveryRoots,
      );

      let request: VerifyArtifactRequest = { path: targetPath };
      const expect = parseVerifyExpect(valid);
      if (expect !== undefined) {
        request = { ...request, expect };
      }
      if (valid.compare !== undefined) {
        const parsed = parseVerifyCompare(valid.compare);
        // Live contract: no mediaRoots to fall back to — references must
        // live inside artifactRoot (documented live/headless difference).
        const referencePath = resolveVerifyReferencePath(
          parsed.compare.referencePath,
          artifactRoot,
          undefined,
        );
        request = {
          ...request,
          compare: buildVerifyCompareRequest(parsed, referencePath),
        };
      }

      const report = await verifier.verify(request);
      return ok(report);
    });
  }

  /* ----------------- material.* (user-level library) ------------------ */

  private async callMaterialBridge<T>(
    verb: FacadeVerb,
    bridgeVerb: MaterialLibraryBridgeVerb,
    params: Record<string, unknown>,
  ): Promise<T> {
    this.gate(verb);
    const bridge = this.config.materialLibrary;
    if (typeof bridge !== "function") {
      throw new FacadeError(
        "UNSUPPORTED",
        `${verb}: this live host does not expose a material-library bridge`,
      );
    }
    let reply: MaterialLibraryBridgeReply;
    try {
      reply = await bridge({ verb: bridgeVerb, params });
    } catch (error) {
      throw materialBridgeFailure(verb, error);
    }
    if (!reply.ok) {
      throw materialBridgeFailure(verb, reply.error);
    }
    return reply.result as T;
  }

  async materialList(
    params?: MaterialListParams,
  ): Promise<FacadeResult<MaterialListResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<MaterialListParams>(
        params ?? {},
        MATERIAL_LIST_SCHEMA,
        "material.list params",
      );
      const result = await this.callMaterialBridge<MaterialListResult>(
        "material.list",
        "list",
        valid as unknown as Record<string, unknown>,
      );
      return ok(result);
    });
  }

  async materialGet(
    params: MaterialGetParams,
  ): Promise<FacadeResult<MaterialGetResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<MaterialGetParams>(
        params,
        MATERIAL_GET_SCHEMA,
        "material.get params",
      );
      const result = await this.callMaterialBridge<MaterialGetResult>(
        "material.get",
        "get",
        { id: valid.id },
      );
      return ok(result);
    });
  }

  async materialCreate(
    params: MaterialCreateParams,
  ): Promise<FacadeResult<MaterialCreateResult>> {
    return this.enqueue(async () => {
      this.gate("material.create");
      const valid = validateObject<MaterialCreateParams>(
        params,
        MATERIAL_CREATE_SCHEMA,
        "material.create params",
      );
      const { idempotencyKey, ...payload } = valid;
      const receipt = await this.replayLookup<MaterialCreateResult>(
        "material.create",
        idempotencyKey,
        payload,
      );
      if (receipt?.prior) {
        return ok<MaterialCreateResult>({ ...receipt.prior.value, replayed: true });
      }

      const bridgeParams: Record<string, unknown> = {
        kind: valid.kind,
        ...(valid.title !== undefined ? { title: valid.title } : {}),
        ...(valid.tags !== undefined ? { tags: [...valid.tags] } : {}),
        ...(valid.organizeStatus !== undefined
          ? { organizeStatus: valid.organizeStatus }
          : {}),
        ...(valid.aiSummary !== undefined ? { aiSummary: valid.aiSummary } : {}),
        ...(valid.origin !== undefined ? { origin: valid.origin } : {}),
        ...(valid.url !== undefined ? { url: valid.url } : {}),
        ...(valid.description !== undefined ? { description: valid.description } : {}),
        ...(valid.parentMaterialId !== undefined
          ? { parentMaterialId: valid.parentMaterialId }
          : {}),
        ...(valid.startSec !== undefined ? { startSec: valid.startSec } : {}),
        ...(valid.endSec !== undefined ? { endSec: valid.endSec } : {}),
        ...(valid.skillName !== undefined ? { skillName: valid.skillName } : {}),
        ...(valid.prompt !== undefined ? { prompt: valid.prompt } : {}),
        ...(valid.steps !== undefined ? { steps: [...valid.steps] } : {}),
        ...(valid.inputs !== undefined ? { inputs: [...valid.inputs] } : {}),
      };

      if (valid.kind === "media") {
        if (!valid.filePath) {
          throw new FacadeError(
            "INVALID_PARAMS",
            "material.create: media materials require filePath (an absolute path inside a configured media root)",
            { kind: "media" },
          );
        }
        if (!valid.mediaType) {
          throw new FacadeError(
            "INVALID_PARAMS",
            'material.create: media materials require mediaType ("video" | "audio" | "image")',
            { kind: "media" },
          );
        }
        const resolved = await resolveLibraryMediaPath(
          "material.create",
          valid.filePath,
          this.config.mediaRoots ?? [],
        );
        // Best-effort technical metadata from the SAME Node probe media.import
        // uses. A probe failure is fatal only for audio/video claims; images
        // are accepted without metadata (mediabunny probes audio/video only).
        let metadata: Record<string, unknown> = {};
        if (valid.mediaType !== "image") {
          try {
            const probed = await probeLocalMediaFile(resolved.path);
            metadata = {
              durationSec: probed.durationSec,
              ...(probed.width !== null ? { width: probed.width } : {}),
              ...(probed.height !== null ? { height: probed.height } : {}),
              ...(probed.frameRate !== null ? { frameRate: probed.frameRate } : {}),
              ...(probed.codec ? { codec: probed.codec } : {}),
              fileSizeBytes: probed.fileSize,
            };
          } catch (error) {
            throw new FacadeError(
              "INVALID_PARAMS",
              `material.create: cannot read media metadata: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { path: resolved.path },
            );
          }
        } else {
          metadata = { fileSizeBytes: resolved.sizeBytes };
        }
        bridgeParams.mediaType = valid.mediaType;
        bridgeParams.fileRef = {
          type: "path",
          path: resolved.path,
          fileName: basename(resolved.path),
          sizeBytes: resolved.sizeBytes,
          lastModifiedMs: resolved.lastModifiedMs,
        };
        bridgeParams.metadata = metadata;
      }

      const result = await this.callMaterialBridge<MaterialCreateResult>(
        "material.create",
        "create",
        bridgeParams,
      );
      receipt?.commit(result, 0);
      return ok(result);
    });
  }

  async materialUpdate(
    params: MaterialUpdateParams,
  ): Promise<FacadeResult<MaterialUpdateResult>> {
    return this.enqueue(async () => {
      this.gate("material.update");
      const valid = validateObject<MaterialUpdateParams>(
        params,
        MATERIAL_UPDATE_SCHEMA,
        "material.update params",
      );
      const { idempotencyKey, ...payload } = valid;
      const receipt = await this.replayLookup<MaterialUpdateResult>(
        "material.update",
        idempotencyKey,
        payload,
      );
      if (receipt?.prior) {
        return ok<MaterialUpdateResult>({ ...receipt.prior.value, replayed: true });
      }
      const result = await this.callMaterialBridge<MaterialUpdateResult>(
        "material.update",
        "update",
        payload as unknown as Record<string, unknown>,
      );
      receipt?.commit(result, 0);
      return ok(result);
    });
  }

  async materialBatchUpdate(
    params: MaterialBatchUpdateParams,
  ): Promise<FacadeResult<MaterialBatchUpdateResult>> {
    return this.enqueue(async () => {
      this.gate("material.batch_update");
      const valid = validateObject<MaterialBatchUpdateParams>(
        params,
        MATERIAL_BATCH_UPDATE_SCHEMA,
        "material.batch_update params",
      );
      const { idempotencyKey, ...payload } = valid;
      const receipt = await this.replayLookup<MaterialBatchUpdateResult>(
        "material.batch_update",
        idempotencyKey,
        payload,
      );
      if (receipt?.prior) {
        return ok<MaterialBatchUpdateResult>({
          ...receipt.prior.value,
          replayed: true,
        });
      }
      const result = await this.callMaterialBridge<MaterialBatchUpdateResult>(
        "material.batch_update",
        "batchUpdate",
        {
          updates: valid.updates.map((item) => ({
            ...item,
            ...(item.tags !== undefined ? { tags: [...item.tags] } : {}),
          })),
        },
      );
      receipt?.commit(result, 0);
      return ok(result);
    });
  }

  async materialRemove(
    params: MaterialRemoveParams,
  ): Promise<FacadeResult<MaterialRemoveResult>> {
    return this.enqueue(async () => {
      this.gate("material.remove");
      const valid = validateObject<MaterialRemoveParams>(
        params,
        MATERIAL_REMOVE_SCHEMA,
        "material.remove params",
      );
      const { idempotencyKey, ...payload } = valid;
      const receipt = await this.replayLookup<MaterialRemoveResult>(
        "material.remove",
        idempotencyKey,
        payload,
      );
      if (receipt?.prior) {
        return ok<MaterialRemoveResult>({ ...receipt.prior.value, replayed: true });
      }
      const result = await this.callMaterialBridge<MaterialRemoveResult>(
        "material.remove",
        "remove",
        { id: valid.id, ...(valid.force !== undefined ? { force: valid.force } : {}) },
      );
      receipt?.commit(result, 0);
      return ok(result);
    });
  }

  async materialAttach(
    params: MaterialAttachParams,
  ): Promise<FacadeResult<MaterialAttachResult>> {
    return this.enqueue(async () => {
      this.gate("material.attach");
      const valid = validateObject<MaterialAttachParams>(
        params,
        MATERIAL_ATTACH_SCHEMA,
        "material.attach params",
      );
      const { idempotencyKey, expectedRevision, ...payload } = valid;
      const receipt = await this.replayLookup<MaterialAttachResult>(
        "material.attach",
        idempotencyKey,
        payload,
      );
      if (receipt?.prior) {
        return ok<MaterialAttachResult>({ ...receipt.prior.value, replayed: true });
      }
      // Precedence contract mirrors media.import: a stale caller revision is
      // CONFLICT even before the renderer is involved; the renderer repeats
      // the CAS at commit time.
      const { revision } = await this.config.store.getState();
      if (
        expectedRevision !== undefined &&
        expectedRevision !== revision
      ) {
        throw new FacadeError(
          "CONFLICT",
          `revision conflict: expected ${expectedRevision}, current is ${revision}`,
          { currentRevision: revision },
        );
      }
      const result = await this.callMaterialBridge<MaterialAttachResult>(
        "material.attach",
        "attach",
        {
          materialId: valid.materialId,
          ...(valid.startSec !== undefined ? { startSec: valid.startSec } : {}),
          ...(valid.endSec !== undefined ? { endSec: valid.endSec } : {}),
          ...(valid.addClip !== undefined ? { addClip: valid.addClip } : {}),
          // Unconditional CAS like live edit.apply: omitted still guards
          // with the revision we just read.
          expectedRevision: expectedRevision ?? revision,
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        },
      );
      receipt?.commit(result, result.revision);
      return ok(result);
    });
  }

  async materialUndo(
    params?: MaterialUndoParams,
  ): Promise<FacadeResult<MaterialUndoResult>> {
    return this.enqueue(async () => {
      this.gate("material.undo");
      const valid = validateObject<MaterialUndoParams>(
        params ?? {},
        MATERIAL_UNDO_SCHEMA,
        "material.undo params",
      );
      const { idempotencyKey, ...payload } = valid;
      // Undo without a key is dangerous to retry (a retry would undo the
      // NEXT entry), so replay protection matters most here.
      const receipt = await this.replayLookup<MaterialUndoResult>(
        "material.undo",
        idempotencyKey,
        payload,
      );
      if (receipt?.prior) {
        return ok<MaterialUndoResult>({ ...receipt.prior.value, replayed: true });
      }
      const result = await this.callMaterialBridge<MaterialUndoResult>(
        "material.undo",
        "undo",
        {
          ...(valid.entryId !== undefined ? { entryId: valid.entryId } : {}),
          actor: "agent",
        },
      );
      receipt?.commit(result, 0);
      return ok(result);
    });
  }

  /* ------------------ font.* (user-level custom fonts) ----------------- */

  /**
   * The renderer owns the canonical custom-font store (IndexedDB +
   * FontFace activation); the facade validates params, enforces the byte
   * budget and path containment, and forwards. Mirrors the material.* seam.
   */
  private async callFontBridge<T>(
    verb: FacadeVerb,
    bridgeVerb: FontLibraryBridgeVerb,
    params: Record<string, unknown>,
  ): Promise<T> {
    this.gate(verb);
    const bridge = this.config.fontLibrary;
    if (typeof bridge !== "function") {
      throw new FacadeError(
        "UNSUPPORTED",
        `${verb}: this live host does not expose a font-library bridge`,
      );
    }
    let reply: FontLibraryBridgeReply;
    try {
      reply = await bridge({ verb: bridgeVerb, params });
    } catch (error) {
      throw materialBridgeFailure(verb, error);
    }
    if (!reply.ok) {
      throw materialBridgeFailure(verb, reply.error);
    }
    return reply.result as T;
  }

  async fontUpload(
    params: FontUploadParams,
  ): Promise<FacadeResult<FontUploadResult>> {
    return this.enqueue(async () => {
      this.gate("font.upload");
      const valid = validateObject<FontUploadParams>(
        params,
        FONT_UPLOAD_SCHEMA,
        "font.upload params",
      );
      const { data, baseName } = await resolveFontUploadBytes(
        valid,
        this.config.mediaRoots ?? [],
      );
      const result = await this.callFontBridge<FontUploadResult>(
        "font.upload",
        "upload",
        { name: baseName, data },
      );
      return ok({
        ...result,
        deduped: result.fontFamily !== baseName.trim(),
      });
    });
  }

  async fontList(
    params?: FontListParams,
  ): Promise<FacadeResult<FontListResult>> {
    return this.enqueue(async () => {
      validateObject<FontListParams>(params ?? {}, EMPTY_PARAMS_SCHEMA, "font.list params");
      const result = await this.callFontBridge<FontListResult>(
        "font.list",
        "list",
        {},
      );
      return ok(result);
    });
  }

  /* ---------------- preset.* (user-level custom presets) ---------------- */

  /**
   * The renderer owns the canonical preset store (IndexedDB) and the apply
   * expansion into core actions; the facade validates params (including a
   * deep payload check with the SAME core validator the GUI uses), guards
   * retries and the project revision, and forwards. Bridge failure codes
   * cross as the facade's public taxonomy.
   */
  private async callPresetBridge<T>(
    verb: FacadeVerb,
    bridgeVerb: PresetLibraryBridgeVerb,
    params: Record<string, unknown>,
  ): Promise<T> {
    this.gate(verb);
    const bridge = this.config.presetLibrary;
    if (typeof bridge !== "function") {
      throw new FacadeError(
        "UNSUPPORTED",
        `${verb}: this live host does not expose a preset-library bridge`,
      );
    }
    let reply: PresetLibraryBridgeReply;
    try {
      reply = await bridge({ verb: bridgeVerb, params });
    } catch (error) {
      throw presetBridgeFailure(verb, error);
    }
    if (!reply.ok) {
      throw presetBridgeFailure(verb, reply.error);
    }
    return reply.result as T;
  }

  async presetList(
    params?: PresetListParams,
  ): Promise<FacadeResult<PresetListResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<PresetListParams>(
        params ?? {},
        PRESET_LIST_SCHEMA,
        "preset.list params",
      );
      const result = await this.callPresetBridge<PresetListResult>(
        "preset.list",
        "list",
        {
          ...(valid.kind !== undefined ? { kind: valid.kind } : {}),
          ...(valid.query !== undefined ? { query: valid.query } : {}),
          ...(valid.includePayload !== undefined
            ? { includePayload: valid.includePayload }
            : {}),
        },
      );
      return ok(result);
    });
  }

  async presetGet(
    params: PresetGetParams,
  ): Promise<FacadeResult<PresetGetResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<PresetGetParams>(
        params,
        PRESET_GET_SCHEMA,
        "preset.get params",
      );
      const result = await this.callPresetBridge<PresetGetResult>(
        "preset.get",
        "get",
        { id: valid.id },
      );
      return ok(result);
    });
  }

  async presetCreate(
    params: PresetCreateParams,
  ): Promise<FacadeResult<PresetCreateResult>> {
    return this.enqueue(async () => {
      this.gate("preset.create");
      const valid = validateObject<PresetCreateParams>(
        params,
        PRESET_CREATE_SCHEMA,
        "preset.create params",
      );
      const { idempotencyKey, ...payload } = valid;
      const receipt = await this.replayLookup<PresetCreateResult>(
        "preset.create",
        idempotencyKey,
        payload,
      );
      if (receipt?.prior) {
        return ok<PresetCreateResult>({ ...receipt.prior.value, replayed: true });
      }
      const name = validatePresetName(valid.name);
      if (!name.ok) {
        throw new FacadeError("INVALID_PARAMS", `preset.create: ${name.message}`, {
          validationCode: name.code,
        });
      }
      const normalizedPayload = assertPresetPayloadValid(
        "preset.create",
        valid.payload,
      );
      if (valid.thumbnailDataUrl !== undefined) {
        const thumbnail = validatePresetThumbnail(valid.thumbnailDataUrl);
        if (!thumbnail.ok) {
          throw new FacadeError(
            "INVALID_PARAMS",
            `preset.create: ${thumbnail.message}`,
            { validationCode: thumbnail.code, ...(thumbnail.details ?? {}) },
          );
        }
      }
      const result = await this.callPresetBridge<PresetCreateResult>(
        "preset.create",
        "create",
        {
          kind: valid.kind,
          name: name.value,
          payload: normalizedPayload,
          ...(valid.tags !== undefined ? { tags: [...valid.tags] } : {}),
          ...(valid.builtinBaseId !== undefined
            ? { builtinBaseId: valid.builtinBaseId }
            : {}),
          ...(valid.thumbnailDataUrl !== undefined
            ? { thumbnailDataUrl: valid.thumbnailDataUrl }
            : {}),
        },
      );
      receipt?.commit(result, 0);
      return ok(result);
    });
  }

  async presetUpdate(
    params: PresetUpdateParams,
  ): Promise<FacadeResult<PresetUpdateResult>> {
    return this.enqueue(async () => {
      this.gate("preset.update");
      const valid = validateObject<PresetUpdateParams>(
        params,
        PRESET_UPDATE_SCHEMA,
        "preset.update params",
      );
      const { idempotencyKey, ...payload } = valid;
      const receipt = await this.replayLookup<PresetUpdateResult>(
        "preset.update",
        idempotencyKey,
        payload,
      );
      if (receipt?.prior) {
        return ok<PresetUpdateResult>({ ...receipt.prior.value, replayed: true });
      }
      let normalizedPayload: Record<string, unknown> | undefined;
      if (valid.payload !== undefined) {
        normalizedPayload = assertPresetPayloadValid(
          "preset.update",
          valid.payload,
        );
      }
      if (valid.name !== undefined) {
        const name = validatePresetName(valid.name);
        if (!name.ok) {
          throw new FacadeError("INVALID_PARAMS", `preset.update: ${name.message}`, {
            validationCode: name.code,
          });
        }
      }
      if (valid.thumbnailDataUrl !== undefined) {
        const thumbnail = validatePresetThumbnail(valid.thumbnailDataUrl);
        if (!thumbnail.ok) {
          throw new FacadeError(
            "INVALID_PARAMS",
            `preset.update: ${thumbnail.message}`,
            { validationCode: thumbnail.code, ...(thumbnail.details ?? {}) },
          );
        }
      }
      const result = await this.callPresetBridge<PresetUpdateResult>(
        "preset.update",
        "update",
        {
          id: valid.id,
          ...(valid.name !== undefined ? { name: valid.name } : {}),
          ...(valid.tags !== undefined ? { tags: [...valid.tags] } : {}),
          ...(normalizedPayload !== undefined ? { payload: normalizedPayload } : {}),
          ...(valid.thumbnailDataUrl !== undefined
            ? { thumbnailDataUrl: valid.thumbnailDataUrl }
            : {}),
          ...(valid.expectedRevision !== undefined
            ? { expectedRevision: valid.expectedRevision }
            : {}),
        },
      );
      receipt?.commit(result, 0);
      return ok(result);
    });
  }

  async presetRemove(
    params: PresetRemoveParams,
  ): Promise<FacadeResult<PresetRemoveResult>> {
    return this.enqueue(async () => {
      this.gate("preset.remove");
      const valid = validateObject<PresetRemoveParams>(
        params,
        PRESET_REMOVE_SCHEMA,
        "preset.remove params",
      );
      const { idempotencyKey, ...payload } = valid;
      const receipt = await this.replayLookup<PresetRemoveResult>(
        "preset.remove",
        idempotencyKey,
        payload,
      );
      if (receipt?.prior) {
        return ok<PresetRemoveResult>({ ...receipt.prior.value, replayed: true });
      }
      const result = await this.callPresetBridge<PresetRemoveResult>(
        "preset.remove",
        "remove",
        { id: valid.id },
      );
      receipt?.commit(result, 0);
      return ok(result);
    });
  }

  async presetApply(
    params: PresetApplyParams,
  ): Promise<FacadeResult<PresetApplyResult>> {
    return this.enqueue(async () => {
      this.gate("preset.apply");
      const valid = validateObject<PresetApplyParams>(
        params,
        PRESET_APPLY_SCHEMA,
        "preset.apply params",
      );
      const { idempotencyKey, expectedRevision, ...payload } = valid;
      const receipt = await this.replayLookup<PresetApplyResult>(
        "preset.apply",
        idempotencyKey,
        payload,
      );
      if (receipt?.prior) {
        return ok<PresetApplyResult>({ ...receipt.prior.value, replayed: true });
      }
      // Precedence contract mirrors material.attach: a stale caller revision
      // is CONFLICT even before the renderer is involved; the renderer
      // repeats the CAS at commit time.
      const { revision } = await this.config.store.getState();
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        throw new FacadeError(
          "CONFLICT",
          `revision conflict: expected ${expectedRevision}, current is ${revision}`,
          { currentRevision: revision },
        );
      }
      const target = assertPresetApplyTarget(
        valid.target as unknown as Record<string, unknown>,
      );
      const result = await this.callPresetBridge<PresetApplyResult>(
        "preset.apply",
        "apply",
        {
          presetId: valid.presetId,
          target,
          // Unconditional CAS like live edit.apply: omitted still guards
          // with the revision we just read.
          expectedRevision: expectedRevision ?? revision,
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        },
      );
      receipt?.commit(result, result.revision);
      return ok(result);
    });
  }

  /* ----------------- help.* (static manual, all modes) ----------------- */

  /**
   * The GUI manual is shipped static data in this package: live sessions
   * answer from the same module as headless, with no project, provider, or
   * renderer bridge involved. Reads, so neither the writer lease nor the
   * access gate applies.
   */
  async helpListScreens(
    params?: import("./gui-manual").ManualListScreensParams,
  ): Promise<FacadeResult<import("./gui-manual").ManualListScreensResult>> {
    return this.enqueue(async () => {
      validateObject<import("./gui-manual").ManualListScreensParams>(
        params ?? {},
        HELP_LIST_SCREENS_SCHEMA,
        "help.list_screens params",
      );
      return ok(listManualScreens());
    });
  }

  async helpDescribe(
    params: import("./gui-manual").ManualDescribeParams,
  ): Promise<FacadeResult<import("./gui-manual").ManualDescribeResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<import("./gui-manual").ManualDescribeParams>(
        params,
        HELP_DESCRIBE_SCHEMA,
        "help.describe params",
      );
      return ok(describeManualScreen(valid.screenId));
    });
  }

  async helpSearch(
    params: import("./gui-manual").ManualSearchParams,
  ): Promise<FacadeResult<import("./gui-manual").ManualSearchResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<import("./gui-manual").ManualSearchParams>(
        params,
        HELP_SEARCH_SCHEMA,
        "help.search params",
      );
      return ok(searchManualScreens(valid.query));
    });
  }

  /* ---------------------------- lifecycle ----------------------------- */

  /**
   * Drop only write ownership. The session remains usable and preserves its
   * job registry and idempotency ledger; the next write may lazily reacquire.
   */
  releaseWriterLease(): void {
    if (!this.writer) return;
    this.config.lease.release(this.config.sessionId);
    this.writer = false;
  }

  /**
   * Release the writer lease (if held) and cooperatively cancel every live
   * job. Best-effort and idempotent; in-flight provider work still settles
   * through its callbacks but the jobs are marked cancelled here.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseWriterLease();
    await Promise.all([...this.chains.values()].map((chain) => chain.catch(() => undefined)));

    const provider = this.config.exportProvider;
    const audioProcessTasks: Promise<void>[] = [];
    const cancellations = this.jobs.list().map(async (job) => {
      if (job.state === "queued" || job.state === "running") {
        this.jobs.markCancelRequested(job.jobId);
        if (job.kind === "audio-process") {
          this.analysisControllers.get(job.jobId)?.abort();
          const task = this.audioProcessTasks.get(job.jobId);
          if (task) audioProcessTasks.push(task);
          return;
        }
        if (job.kind === "analysis") {
          this.analysisControllers.get(job.jobId)?.abort();
        } else if (provider) {
          await cancelExportWithin(provider, job.jobId).catch(() => false);
        }
        this.jobs.markCancelled(job.jobId);
      }
    });
    await Promise.all(cancellations);
    await Promise.all(audioProcessTasks);
  }

  /* ---------------------------- internals ----------------------------- */

  /**
   * Idempotency-ledger replay lookup (the live half of headless
   * beginMutation's ledger phase — the revision CAS lives in the store, not
   * here). Returns a receipt carrying the stored committed outcome on a
   * replay hit; the same key with a DIFFERENT payload is a CONFLICT, never a
   * blind replay.
   *
   * The project/workspace identity is CAPTURED here and the receipt's
   * `commit` stays permanently bound to it: two concurrent requests may
   * resolve different targets, so a write must never re-derive its scope
   * from shared mutable state after its async work completes.
   */
  private async replayLookup<T>(
    verb: string,
    idempotencyKey: string | undefined,
    payload: unknown,
  ): Promise<LedgerReceipt<T> | null> {
    if (idempotencyKey === undefined) return null;
    // Never replay a result from the last project if the current identity is
    // unavailable or its request guard has failed during a project switch.
    const identity = await this.config.store.getIdentity();
    return this.ledger.lookup(
      this.ledgerScope(identity.projectId, identity.workspaceId),
      verb,
      idempotencyKey,
      payload,
    );
  }

  /** The ledger scope for one explicit project/workspace target. */
  private ledgerScope(
    projectId: string,
    workspaceId: string | undefined,
  ): string {
    return `live:${this.config.sessionId}#${projectId}:${workspaceId ?? "default"}`;
  }

  /**
   * Map every timeline-referenced media item to a readable local file. Live
   * honesty rule (Decision 10): the snapshot's media must be FILE-BACKED —
   * an absolute path readable from this process. Blob/GUI-only media has no
   * honest pixels here, so the verb fails UNSUPPORTED instead of silently
   * rendering without them. Text-only projects pass trivially.
   */
  private async runTechnicalQualityAnalysis(
    jobId: string,
    sourcePath: string,
    mediaId: string,
    name: string,
    analysisTypes: readonly import("./types").MediaAnalysisType[],
    controller: AbortController,
    range: { startSec: number; endSec: number },
    projectId: string,
    sourceRevision: number,
    reviewQuestion?: string,
    recheckOfRecordId?: string,
    silenceParams?: import("./types").MediaSilenceAnalysisParams,
    vadParams?: import("./types").MediaSpeechVadParams,
    syncOffsetParams?: ResolvedSyncOffsetParams,
    syncReference?: SyncOffsetReference,
    transcriptParams?: ResolvedTranscriptParams,
    transcriptModelDir?: string | null,
  ): Promise<void> {
    let persistedRecordId: string | null = null;
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (controller.signal.aborted) {
        this.jobs.markCancelled(jobId);
        return;
      }
      this.jobs.markRunning(jobId);
      const [probe, file, color] = await Promise.all([
        probeLocalMediaFile(sourcePath),
        stat(sourcePath),
        // Container color facts drive the honest support verdict agents and
        // users rely on (docs/COLOR.md); best-effort, never a guess.
        probeColorMetadata(sourcePath),
      ]);
      if (controller.signal.aborted) {
        this.jobs.markCancelled(jobId);
        return;
      }
      const progressPlan = buildAnalysisProgressPlan(analysisTypes);
      this.jobs.markProgress(jobId, { phase: "preparing", percent: .1 });
      const video = analysisTypes.includes("videoReview")
        ? await reviewVideo(sourcePath, range, this.config.artifactRoot!, controller.signal, reviewQuestion, (percent) => this.jobs.markProgress(jobId, { phase: "rendering", percent: progressPlan.percent("videoReview", percent) })) : undefined;
      const audio = analysisTypes.includes("audioSummary")
        ? await analyzeLocalAudio(sourcePath, range, controller.signal, (percent) => this.jobs.markProgress(jobId, { phase: "rendering", percent: progressPlan.percent("audioSummary", percent) })) : undefined;
      const silence = analysisTypes.includes("silence")
        ? await analyzeSilence(sourcePath, range, silenceParams, controller.signal, (percent) => this.jobs.markProgress(jobId, { phase: "rendering", percent: progressPlan.percent("silence", percent) })) : undefined;
      const beatGrid = analysisTypes.includes("beatGrid")
        ? await analyzeBeatGrid(sourcePath, range, controller.signal, (percent) => this.jobs.markProgress(jobId, { phase: "rendering", percent: progressPlan.percent("beatGrid", percent) })) : undefined;
      const wantsSpeechActivity = analysisTypes.includes("speechActivity");
      const wantsTranscript = analysisTypes.includes("speechTranscript");
      const speechActivity = wantsSpeechActivity || wantsTranscript
        ? await analyzeSpeechActivity(sourcePath, range, vadParams, controller.signal, (percent) => this.jobs.markProgress(jobId, {
            phase: "rendering",
            percent: wantsSpeechActivity
              ? progressPlan.percent("speechActivity", percent)
              : progressPlan.percent("speechTranscript", percent * 0.2),
          })) : undefined;
      const speechTranscript = wantsTranscript
        ? await transcribeSpeechRegions(
            sourcePath,
            range,
            speechActivity!.speechRegions,
            transcriptParams!,
            resolveSpeechVadParams(vadParams),
            transcriptModelDir ?? null,
            controller.signal,
            (percent) => this.jobs.markProgress(jobId, {
              phase: "rendering",
              percent: progressPlan.percent("speechTranscript", (wantsSpeechActivity ? 0 : 0.2) + (wantsSpeechActivity ? 1 : 0.8) * percent),
            }),
          ) : undefined;
      const syncOffset = analysisTypes.includes("syncOffset")
        ? await analyzeSyncOffset(sourcePath, range, syncReference!.path, syncOffsetParams!, syncReference!, controller.signal, (percent) => this.jobs.markProgress(jobId, { phase: "rendering", percent: progressPlan.percent("syncOffset", percent) })) : undefined;
      if (controller.signal.aborted) { this.jobs.markCancelled(jobId); return; }
      const videoCandidateTypes = analysisTypes.filter(
        (type) => type === "sceneCuts" || type === "blackFrames" || type === "duplicateFrames",
      );
      let candidates: VideoCandidateBundle | undefined;
      if (videoCandidateTypes.length > 0) {
        const binaries = await resolveToolFfmpeg();
        if (!binaries) throw new FacadeError("UNSUPPORTED", "Local video candidate analysis needs ffmpeg/ffprobe on PATH (or REELTERMINAL_FFMPEG_PATH / REELTERMINAL_FFPROBE_PATH)");
        candidates = await runVideoCandidateAnalyses(binaries, sourcePath, range, analysisTypes, controller.signal, (percent) => this.jobs.markProgress(jobId, { phase: "rendering", percent: progressPlan.percent("candidates", percent) }));
      }
      if (controller.signal.aborted) { this.jobs.markCancelled(jobId); return; }
      let frameFacts: Awaited<ReturnType<typeof probeVideoFacts>> | null = candidates?.facts ?? null;
      let frameFactsUnavailableNote: string | null = null;
      if (!frameFacts && analysisTypes.includes("technicalQuality")) {
        const binaries = await resolveToolFfmpeg();
        if (binaries) {
          try {
            frameFacts = await probeVideoFacts(binaries.ffprobe, sourcePath, { signal: controller.signal });
          } catch (error) {
            frameFactsUnavailableNote = `frame facts unavailable: ${error instanceof Error ? error.message : String(error)}`;
          }
        } else {
          frameFactsUnavailableNote = "ffmpeg/ffprobe not configured — decoded frame count, time base and the CFR/VFR verdict are unknown (install on PATH or set REELTERMINAL_FFMPEG_PATH/REELTERMINAL_FFPROBE_PATH)";
        }
      }
      const after = await stat(sourcePath);
      if (after.size !== file.size || after.mtimeMs !== file.mtimeMs) throw new FacadeError("CONFLICT", "Source changed during analysis; retry");
      const summary = {
        ...(video ? { videoReview: { ...video, mediaId, sourceFingerprint: { size: file.size, lastModified: Math.round(file.mtimeMs) } } } : {}),
        ...(audio ? { audioSummary: { ...audio, mediaId, sourceFingerprint: { size: file.size, lastModified: Math.round(file.mtimeMs) } } } : {}),
        ...(silence ? { silence: { ...silence, mediaId, sourceFingerprint: { size: file.size, lastModified: Math.round(file.mtimeMs) } } } : {}),
        ...(beatGrid ? { beatGrid: { ...beatGrid, mediaId, sourceFingerprint: { size: file.size, lastModified: Math.round(file.mtimeMs) } } } : {}),
        ...(speechActivity ? { speechActivity: { ...speechActivity, mediaId, sourceFingerprint: { size: file.size, lastModified: Math.round(file.mtimeMs) } } } : {}),
        ...(speechTranscript ? { speechTranscript: { ...speechTranscript, mediaId, sourceFingerprint: { size: file.size, lastModified: Math.round(file.mtimeMs) } } } : {}),
        ...(syncOffset ? { syncOffset: { ...syncOffset, mediaId, sourceFingerprint: { size: file.size, lastModified: Math.round(file.mtimeMs) } } } : {}),
        technicalQuality: {
          mediaId,
          name,
          readable: true,
          durationSec: probe.durationSec,
          width: probe.width,
          height: probe.height,
          frameRate: probe.frameRate,
          codec: probe.codec,
          fileSize: probe.fileSize,
          color: assessColorSupport(color),
          ...(frameFacts ? { frames: {
            decodedFrameCount: frameFacts.decodedFrameCount,
            headerFrameCount: frameFacts.headerFrameCount,
            timeBase: frameFacts.timeBase,
            rFrameRate: frameFacts.rFrameRate,
            avgFrameRate: frameFacts.avgFrameRate,
            frameTiming: frameFacts.timing,
          } } : { frames: null }),
          ...(frameFactsUnavailableNote ? { frameFactsUnavailable: frameFactsUnavailableNote } : {}),
          sourceFingerprint: {
            size: file.size,
            lastModified: Math.round(file.mtimeMs),
          },
        },
        ...(candidates?.sceneCuts ? { sceneCuts: { ...candidates.sceneCuts, mediaId, sourceFingerprint: { size: file.size, lastModified: Math.round(file.mtimeMs) } } } : {}),
        ...(candidates?.blackFrames ? { blackFrames: { ...candidates.blackFrames, mediaId, sourceFingerprint: { size: file.size, lastModified: Math.round(file.mtimeMs) } } } : {}),
        ...(candidates?.duplicateFrames ? { duplicateFrames: { ...candidates.duplicateFrames, mediaId, sourceFingerprint: { size: file.size, lastModified: Math.round(file.mtimeMs) } } } : {}),
      };
      const compactSummary = {
        ...summary,
        ...(audio ? { audioSummary: compactAnalysisFacts("audioSummary", summary.audioSummary!) } : {}),
        ...(silence ? { silence: compactAnalysisFacts("silence", summary.silence!) } : {}),
        ...(beatGrid ? { beatGrid: compactAnalysisFacts("beatGrid", summary.beatGrid!) } : {}),
        ...(speechActivity ? { speechActivity: compactAnalysisFacts("speechActivity", summary.speechActivity!) } : {}),
        ...(speechTranscript ? { speechTranscript: compactAnalysisFacts("speechTranscript", summary.speechTranscript!) } : {}),
        ...(syncOffset ? { syncOffset: compactAnalysisFacts("syncOffset", summary.syncOffset!) } : {}),
      };
      // Durable, traceable record: audio analysis requires artifactRoot so
      // full event facts remain readable; non-audio analyses can still return
      // an ephemeral job summary when no record root is configured.
      let recordRef: { id: string; recordPath: string; recheckOf: string | null } | null = null;
      if (this.config.artifactRoot) {
      let recheckTarget = null;
      if (recheckOfRecordId) {
        recheckTarget = await resolveRecheckTarget(this.config.artifactRoot, recheckOfRecordId);
      }
      const saved = await saveAnalysisRecord(this.config.artifactRoot, {
        projectId,
        sourceRevision,
        coordinateSpace: "source",
        subject: {
          mediaId,
          name,
          sourcePath,
          sourceFingerprint: { size: file.size, lastModified: Math.round(file.mtimeMs) },
        },
        analysisTypes,
        rangeSec: range,
        config: {
          analysisTypes,
          startSec: range.startSec,
          endSec: range.endSec,
          cloudUpload: analysisTypes.includes("videoReview"),
          ...(reviewQuestion !== undefined ? { reviewQuestion } : {}),
          ...(silence ? { silenceParams: silence.parameters } : {}),
          ...(speechActivity ? { vadParams: speechActivity.parameters } : {}),
          ...(speechTranscript ? { transcriptParams: speechTranscript.parameters } : {}),
          ...(syncOffset ? { syncOffsetParams: syncOffset.parameters } : {}),
        },
        provenance: [
          ...(analysisTypes.includes("technicalQuality")
            ? [{ kind: "local-measurement" as const, provider: "built-in-mediabunny-stat+ffprobe-color", analysisType: "technicalQuality" }]
            : []),
          ...(analysisTypes.includes("audioSummary")
            ? [{ kind: "local-measurement" as const, provider: "local-ffmpeg-ebur128", analysisType: "audioSummary" }]
            : []),
          ...(analysisTypes.includes("silence")
            ? [{ kind: "local-measurement" as const, provider: "local-ffmpeg-pcm-silence-kernel", analysisType: "silence" }]
            : []),
          ...(analysisTypes.includes("beatGrid")
            ? [{ kind: "local-measurement" as const, provider: "local-ffmpeg-pcm-beat-engine", analysisType: "beatGrid" }]
            : []),
          ...(analysisTypes.includes("speechActivity")
            ? [{ kind: "local-measurement" as const, provider: "local-silero-vad-onnx", analysisType: "speechActivity" }]
            : []),
          ...(analysisTypes.includes("speechTranscript")
            ? [{ kind: "local-measurement" as const, provider: "local-sensevoice-funasr-python", analysisType: "speechTranscript" }]
            : []),
          ...(analysisTypes.includes("syncOffset")
            ? [{ kind: "local-measurement" as const, provider: "local-ffmpeg-pcm-gcc-phat", analysisType: "syncOffset" }]
            : []),
          ...(analysisTypes.includes("sceneCuts")
            ? [{ kind: "local-measurement" as const, provider: "local-ffmpeg-scene-score", analysisType: "sceneCuts" }]
            : []),
          ...(analysisTypes.includes("blackFrames")
            ? [{ kind: "local-measurement" as const, provider: "local-ffmpeg-blackdetect", analysisType: "blackFrames" }]
            : []),
          ...(analysisTypes.includes("duplicateFrames")
            ? [{ kind: "local-measurement" as const, provider: "local-ffmpeg-freezedetect", analysisType: "duplicateFrames" }]
            : []),
          ...(video ? [{ kind: "cloud-opinion" as const, provider: video.provider, analysisType: "videoReview" }] : []),
        ],
        observations: [
          { source: "technicalQuality", facts: summary.technicalQuality },
          ...(audio ? [{ source: "audioSummary", facts: audio }] : []),
          ...(silence ? [{ source: "silence", facts: silence }] : []),
          ...(beatGrid ? [{ source: "beatGrid", facts: beatGrid }] : []),
          ...(speechActivity ? [{ source: "speechActivity", facts: speechActivity }] : []),
          ...(speechTranscript ? [{ source: "speechTranscript", facts: speechTranscript }] : []),
          ...(syncOffset ? [{ source: "syncOffset", facts: syncOffset }] : []),
          ...(candidates?.sceneCuts ? [{ source: "sceneCuts", facts: candidates.sceneCuts }] : []),
          ...(candidates?.blackFrames ? [{ source: "blackFrames", facts: candidates.blackFrames }] : []),
          ...(candidates?.duplicateFrames ? [{ source: "duplicateFrames", facts: candidates.duplicateFrames }] : []),
        ],
        inferences: [
          ...(audio?.bpmCandidates
            ? [{ source: "audioSummary", note: "BPM candidates are analyzer inferences from periodicity, not ground truth", bpmCandidates: audio.bpmCandidates }]
            : []),
          ...(beatGrid
            ? [{ source: "beatGrid", note: "beats and bpm are analyzer inferences from energy periodicity, not ground truth; no downbeat detector is installed", bpm: beatGrid.bpm, confidence: beatGrid.confidence, beatCount: beatGrid.beatCount }]
            : []),
          ...(speechActivity
            ? [{ source: "speechActivity", note: "speech regions are Silero model inferences from speech probability, not semantic understanding; non-speech gaps are not automatically deletable", regionCount: speechActivity.regionCount, totalSpeechDurationSec: speechActivity.totalSpeechDurationSec }]
            : []),
          ...(speechTranscript
            ? [{ source: "speechTranscript", note: "transcript text/emotion/event tags are SenseVoice model output; timestamps come from the external Silero VAD sentence segmentation, not word-level ASR timing; emotion/event labels are segment-level, not precise intervals", segmentCount: speechTranscript.segmentCount, languageCounts: speechTranscript.languageCounts }]
            : []),
          ...(syncOffset
            ? [{ source: "syncOffset", note: "GCC-PHAT correlation statistics, not a calibrated confidence; a positive offset means the target lags the reference; clock drift is reported, never silently corrected", verdict: syncOffset.verdict, offsetSec: syncOffset.offsetSec, prominenceDb: syncOffset.peaks.prominenceDb, marginToSecondPeakDb: syncOffset.peaks.marginToSecondPeakDb, driftDetected: syncOffset.drift.detected }]
            : []),
        ],
        recommendations: [],
        unknowns: [
          ...(video ? [{ field: "videoReview.serverSamplingFps", note: "The cloud provider does not disclose its sampling rate; short events may be missed" }] : []),
          ...(video ? [
            { field: "videoReview.sourceFrameNumber", note: "The provider returns prose opinions without a verifiable source frame number or source PTS." },
            { field: "videoReview.eventLocalizationUncertaintySec", note: "The provider does not disclose frame-level event localization uncertainty." },
            { field: "videoReview.audioDetectionUncertaintySec", note: "The provider does not disclose frame-level audio event localization uncertainty." },
          ] : []),
          ...(analysisTypes.includes("beatGrid")
            ? [{ field: "beatGrid.downbeats", note: "No downbeat detector is installed; beatGrid results intentionally omit downbeats" }]
            : []),
          ...(analysisTypes.includes("speechTranscript")
            ? [
                { field: "speechTranscript.wordTimestamps", note: "SenseVoice-Small emits no timestamps; stored segment boundaries are external Silero VAD sentence boundaries" },
                { field: "speechTranscript.confidence", note: "The model returns no confidence; no confidence value is fabricated" },
                { field: "speechTranscript.modelRevision", note: "The pinned model file is sha-verified, but the upstream repository may publish newer revisions under the same name" },
              ]
            : []),
        ],
        recheckOf: recheckTarget ? recheckTarget.id : null,
        cloudOpinion: video
          ? {
              provider: video.provider,
              text: typeof video.text === "string" ? video.text : JSON.stringify(video),
              status: video.status ?? "opinion",
              serverSamplingFps: video.preparation?.serverSamplingFps ?? null,
            }
          : null,
      });
      recordRef = { id: saved.id, recordPath: saved.recordPath, recheckOf: saved.recheckOf };
      persistedRecordId = saved.id;
      }
      if (controller.signal.aborted) {
        if (persistedRecordId && this.config.artifactRoot) {
          await removeAnalysisRecord(this.config.artifactRoot, persistedRecordId);
          persistedRecordId = null;
        }
        this.jobs.markCancelled(jobId);
        return;
      }
      this.jobs.markAnalysisDone(jobId, {
        analysisTypes,
        summary: {
          ...compactSummary,
          ...(recordRef ? { analysisRecord: recordRef } : {}),
        },
        artifacts: [],
      });
      if (this.jobs.get(jobId)?.state === "done") {
        persistedRecordId = null;
      } else if (persistedRecordId && this.config.artifactRoot) {
        await removeAnalysisRecord(this.config.artifactRoot, persistedRecordId);
        persistedRecordId = null;
      }
    } catch (error) {
      let failure: unknown = error;
      if (persistedRecordId && this.config.artifactRoot) {
        try {
          await removeAnalysisRecord(this.config.artifactRoot, persistedRecordId);
        } catch (cleanupError) {
          failure = new Error(`${error instanceof Error ? error.message : String(error)}; saved analysis record cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
      }
      if (controller.signal.aborted && failure === error) { this.jobs.markCancelled(jobId); return; }
      this.jobs.markError(jobId, {
        code: failure instanceof FacadeError ? failure.code : "JOB_FAILED",
        message: failure instanceof Error ? failure.message : String(failure),
      });
    } finally {
      this.analysisControllers.delete(jobId);
    }
  }

  /** Resolve ONE media item's file with the live builder's checks. */
  private async resolveLiveMediaItemFile(itemInput: unknown): Promise<string | null> {
    const item = itemInput as { id: string; contentUrl?: unknown; originalUrl?: unknown };
    const originalUrl = typeof item.contentUrl === "string" ? item.contentUrl
      : typeof item.originalUrl === "string" ? item.originalUrl : null;
    if (!originalUrl || !isAbsolute(originalUrl)) return null;
    const fileStat = await stat(originalUrl).catch(() => null);
    if (!fileStat || !fileStat.isFile() || fileStat.size > MAX_MEDIA_FILE_BYTES) return null;
    return originalUrl;
  }

  private async buildLiveMediaFiles(
    project: Project,
    verb: string,
  ): Promise<Record<string, string>> {
    const referenced = new Set<string>();
    for (const track of project.timeline.tracks) {
      for (const clip of track.clips) {
        referenced.add(clip.mediaId);
      }
    }
    const files: Record<string, string> = {};
    const unavailable: string[] = [];
    for (const item of project.mediaLibrary.items) {
      if (!referenced.has(item.id)) continue;
      const mediaItem = item as { contentUrl?: unknown; originalUrl?: unknown };
      const originalUrl = typeof mediaItem.contentUrl === "string" ? mediaItem.contentUrl
        : typeof mediaItem.originalUrl === "string" ? mediaItem.originalUrl : null;
      if (!originalUrl || !isAbsolute(originalUrl)) {
        unavailable.push(item.id);
        continue;
      }
      const fileStat = await stat(originalUrl).catch(() => null);
      if (!fileStat || !fileStat.isFile() || fileStat.size > MAX_MEDIA_FILE_BYTES) {
        unavailable.push(item.id);
        continue;
      }
      files[item.id] = originalUrl;
    }
    if (unavailable.length > 0) {
      throw new FacadeError(
        "UNSUPPORTED",
        `${verb}: live preview/export requires file-backed media — ${unavailable.length} referenced media item(s) are not absolute file paths readable from this process; blob/GUI-only media cannot be rendered honestly here`,
        { mediaIds: unavailable },
      );
    }
    return files;
  }

  /** Terminalize a finished export: verify containment + hash the MP4. */
  private async finalizeExport(
    jobId: string,
    sourceRevision: number,
    completion: {
      path: string;
      sizeBytes: number;
      route: string;
      upscalingRequestedButInactive?: boolean;
    },
    delivery: DeliveryDestination | null = null,
  ): Promise<void> {
    try {
      const artifactRoot = requireArtifactRoot(
        this.config.artifactRoot,
        "export.finalize",
      );
      const resolution = resolveContainedPathDetailed(completion.path, [artifactRoot]);
      if (resolution.kind === "outside") {
        throw new FacadeError(
          "JOB_FAILED",
          "export provider reported an artifact outside artifactRoot — refusing to publish it",
          { path: completion.path },
        );
      }
      if (resolution.kind !== "ok") {
        throw new FacadeError(
          "JOB_FAILED",
          "export provider reported an artifact that cannot be read (missing or unreadable)",
          { path: completion.path },
        );
      }
      const artifact = await artifactRefFor(
        resolution.path,
        "video",
        "mp4",
        sourceRevision,
        completion.sizeBytes,
      );
      let deliveryOutcome: JobDeliveryOutcome | undefined;
      if (delivery !== null) {
        try {
          await deliverExportArtifact(resolution.path, delivery);
          deliveryOutcome = { deliveredTo: delivery.path };
        } catch (deliveryError) {
          deliveryOutcome = {
            deliveryError: deliveryError instanceof Error
              ? deliveryError.message
              : String(deliveryError),
          };
        }
      }
      this.jobs.markDone(
        jobId,
        artifact,
        completion.route,
        completion.upscalingRequestedButInactive === true,
        deliveryOutcome,
      );
    } catch (error) {
      this.jobs.markError(jobId, {
        code: error instanceof FacadeError ? error.code : "JOB_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Serialize each explicit target independently; unrelated workspaces may proceed concurrently. */
  private enqueue<T>(task: () => Promise<FacadeResult<T>>): Promise<FacadeResult<T>> {
    const scope = this.config.executionScope?.() ?? "session";
    const prior = this.chains.get(scope) ?? Promise.resolve();
    const result = prior.then(() => task()).catch((error: unknown) => {
      if (isLiveStoreConflict(error)) {
        const conflict = error as { message?: string; details?: Record<string, unknown> };
        return toFailure<T>(new FacadeError("CONFLICT", conflict.message ?? "Project changed", conflict.details));
      }
      return toFailure<T>(error);
    });
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(scope, settled);
    void settled.then(() => {
      if (this.chains.get(scope) === settled) this.chains.delete(scope);
    });
    return result;
  }
}

/**
 * Create a live facade session over the canonical-store seam. Construction
 * acquires the writer lease for write-enabled sessions; when another AI session
 * holds it, the returned session still works read-only (session.describe
 * reports `writer: false` and the current holder).
 */
export function createLiveFacade(config: LiveFacadeConfig): LiveAgentFacade {
  const session = new LiveFacadeSession(config);
  return withValidatedFacadeCalls({
    ...bindBundledTools(session, config, "live"),
    ...Object.fromEntries(WORKSPACE_VERBS.map((verb) => [verb, (params: Record<string, unknown> = {}) => session.workspaceCommand(verb, params)])) as Pick<LiveAgentFacade, WorkspaceVerb>,
    "session.describe": () => session.sessionDescribe(),
    "capabilities.get": (params) => session.capabilitiesGet(params),
    "project.create": (params) => session.projectCreate(params),
    "project.open": (params) => session.projectOpen(params),
    "project.save": (params) => session.projectSave(params),
    "project.rename": (params) => session.projectRename(params),
    "project.get_state": () => session.projectGetState(),
    "requirements.list": (params) => session.requirementsList(params),
    "requirements.get": (params) => session.requirementsGet(params),
    "project.changes": (params) => session.projectChanges(params),
    "media.import": (params) => session.mediaImport(params),
    "media.render_html": (params) => session.mediaRenderHtml(params),
    "media.analyze_start": (params) => session.mediaAnalyzeStart(params),
    "audio.process.normalize": (params) => session.audioProcessNormalize(params),
    "audio.process.denoise": (params) => session.audioProcessDenoise(params),
    "audio.process.register": (params) => session.audioProcessRegister(params),
    "timeline.get": () => session.timelineGet(),
    "timeline.query": (params) => session.timelineQuery(params),
    "timeline.mapSourceTimes": (params) => session.timelineMapSourceTimes(params),
    "editor.get_context": (params) => session.editorGetContext(params),
    "editor.control": (params) => session.editorControl(params),
    "edit.apply": (params) => session.editApply(params),
    "edit.validate": (params) => session.editValidate(params),
    "history.get": (params) => session.historyGet(params),
    "history.control": (params) => session.historyControl(params),
    "preview.render_frame": (params) => session.previewRenderFrame(params),
    "preview.render_comparison": (params) => session.previewRenderComparison(params),
    "analysis.list": (params) => session.analysisList(params),
    "analysis.get": (params) => session.analysisGet(params),
    "visual.inspect": (params) => session.visualInspect(params),
    "export.start": (params) => session.exportStart(params),
    "job.status": (params) => session.jobStatus(params),
    "job.cancel": (params) => session.jobCancel(params),
    "verify.artifact": (params) => session.verifyArtifact(params),
    "material.list": (params) => session.materialList(params),
    "material.get": (params) => session.materialGet(params),
    "material.create": (params) => session.materialCreate(params),
    "material.update": (params) => session.materialUpdate(params),
    "material.batch_update": (params) => session.materialBatchUpdate(params),
    "material.remove": (params) => session.materialRemove(params),
    "material.attach": (params) => session.materialAttach(params),
    "material.undo": (params) => session.materialUndo(params),
    "font.upload": (params) => session.fontUpload(params as FontUploadParams),
    "font.list": (params) => session.fontList(params as FontListParams),
    "preset.list": (params) => session.presetList(params as PresetListParams),
    "preset.get": (params) => session.presetGet(params as PresetGetParams),
    "preset.create": (params) => session.presetCreate(params as PresetCreateParams),
    "preset.update": (params) => session.presetUpdate(params as PresetUpdateParams),
    "preset.remove": (params) => session.presetRemove(params as PresetRemoveParams),
    "preset.apply": (params) => session.presetApply(params as PresetApplyParams),
    "help.list_screens": (params) =>
      session.helpListScreens(params as import("./gui-manual").ManualListScreensParams),
    "help.describe": (params) =>
      session.helpDescribe(params as import("./gui-manual").ManualDescribeParams),
    "help.search": (params) =>
      session.helpSearch(params as import("./gui-manual").ManualSearchParams),
    releaseWriterLease: () => session.releaseWriterLease(),
    readWriterStatus: () => session.readWriterStatus(),
    dispose: () => session.dispose(),
  }, "live", (verb) => session.assertVerbAccess(verb as FacadeVerb)) as LiveAgentFacade;
}

