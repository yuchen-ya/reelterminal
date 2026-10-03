import { reviewVideo, videoReviewPreflight } from "./video-review";
import { analyzeLocalAudio, audioAnalysisPreflight } from "./audio-analysis";
import { runVideoCandidateAnalyses, videoCandidatesPreflight, type VideoCandidateBundle } from "./video-candidates";
import { resolveToolFfmpeg } from "./media/ffmpeg-bin";
import { probeVideoFacts } from "./media/frame-exact";
import { bindBundledTools } from "./plugin-runtime";
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
 *  - One AI writer at a time: construction acquires the
 *    `LiveWriterLease` for write-enabled sessions; a session without it runs
 *    read-only and its write verbs fail CONFLICT naming the holder. The
 *    human never takes the lease and can always edit.
 *  - Read/write access is an independent facade boundary: read-only access
 *    rejects write verbs with FORBIDDEN.
 *  - Honesty: project.create/project.open remain GUI-owned; media.import
 *    validates and delegates through the explicit live store bridge; preview/export run on a snapshot
 *    and require its media to be file-backed and readable from THIS process
 *    — blob/GUI-only media fails loudly instead of silently rendering
 *    wrong pixels. Text-only projects render fine.
 *
 * Serialization mirrors headless: every verb body runs inside one
 * promise-chained lane, so verb calls never interleave.
 */
import { ActionExecutor } from "@reelterminal/core/actions/action-executor";
import { ActionHistory } from "@reelterminal/core/actions/action-history";
import type { Action } from "@reelterminal/core/types/actions";
import type { Project } from "@reelterminal/core/types/project";
import { stat } from "node:fs/promises";
import { readFile as readFileFontBytes } from "node:fs/promises";
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
  resolveDeliveredArtifactPath,
  resolveDeliveryDestination,
  type DeliveryDestination,
} from "./delivery";
import { IdempotencyLedger, stableStringify } from "./idempotency";
import {
  assertMediaFingerprintsUnchanged,
  discardArtifact,
  fingerprintMediaFiles,
  inspectionRequestKey,
  pendingArtifactPath,
  publishArtifact,
} from "./inspection-artifacts";
import { cancelExportWithin, JobRegistry, jobStatusView } from "./jobs";
import { queryTimeline } from "./timeline-query";
import { validateEditPlan } from "./edit-validation";
import type { LiveWriterLease } from "./live-lease";
import {
  isLiveStoreConflict,
  LiveStoreConflictError,
  type LiveApplyActionsResult,
  type LiveCreatedIds,
  type LiveMediaImportRequest,
  type LiveMediaImportResult,
  type LiveEditorControlParams,
  type LiveEditorControlResult,
  type LiveEditorControlTarget,
  type LiveProjectStore,
} from "./live-store";
import { hasUrlScheme, resolveContainedPathDetailed } from "./media/path-roots";
import { probeLocalMediaFile } from "./media/node-media-adapter";
import { produceHtmlRenderArtifact } from "./media-render-html";
import { assessColorSupport, probeColorMetadata } from "./color-policy";
import {
  loadAnalysisRecord,
  listAnalysisRecords,
  resolveRecheckTarget,
  saveAnalysisRecord,
} from "./analysis-records";
import {
  composeComparisonVideo,
  referenceFilePath,
  renderComparisonStill,
  requireComparisonConfig,
  validateComparisonRange,
  withComparisonReference,
} from "./reference-comparison";
import { enrichMediaFileOps, opToCoreActions, validateEditBatch, validateEditOp } from "./ops";
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
  VISUAL_INSPECT_RANGE_SCHEMA,
  VISUAL_INSPECT_SCHEMA,
  VERIFY_ARTIFACT_SCHEMA,
  VERIFY_COMPARE_SCHEMA,
  VERIFY_EXPECT_SCHEMA,
  VERIFY_REGION_SCHEMA,
  EDITOR_CONTROL_SCHEMA,
  EDITOR_CONTROL_TARGET_SCHEMA,
  PROJECT_CHANGES_SCHEMA,
  TIMELINE_QUERY_SCHEMA,
  TIMELINE_QUERY_RANGE_SCHEMA,
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
  FONT_LIBRARY_LIMITS,
  type FontLibraryBridge,
  type FontLibraryBridgeReply,
  type FontLibraryBridgeVerb,
  type FontListParams,
  type FontListResult,
  type FontUploadParams,
  type FontUploadResult,
} from "./font-library";
import {
  presetApplyTargetProblem,
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
  validatePresetPayload,
  validatePresetThumbnail,
} from "@reelterminal/core/presets/validate";
import type { MaterialListResult } from "@reelterminal/core/material/types";
import {
  isReadOnlyVerb,
  type Capabilities,
  type EditApplyParams,
  type EditApplyResult,
  type EditOp,
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
  type OpApplied,
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
  type EditValidateParams,
  type EditValidateResult,
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
  buildVisualSamplePlan,
  MAX_VISUAL_CONTACT_SHEET_PIXELS,
  MAX_VISUAL_FRAME_PIXELS,
  MAX_VISUAL_PNG_BYTES,
  visualRasterSize,
} from "./visual-inspect";
import { DEFAULT_FRAME_BUDGET_BYTES, fitFrameToBudget } from "./frame-budget";

/** Max media file size accepted for Chromium reads (2 GiB safety valve). */
const MAX_MEDIA_FILE_BYTES = 2 * 1024 * 1024 * 1024;
/**
 * Live import currently crosses Electron IPC as one ArrayBuffer. Keep that
 * transfer far below the Chromium-read ceiling so a valid request cannot
 * exhaust the renderer before its own identical guard runs.
 */
const MAX_LIVE_IMPORT_FILE_BYTES = 256 * 1024 * 1024;

/**
 * Verbs that exist in the contract but are honestly unavailable in live
 * mode (Decision 11): the GUI owns the project lifecycle. Media import is
 * available when the host supplies media roots and the explicit live-store
 * import bridge.
 */
export const LIVE_UNAVAILABLE_VERBS = [
  "project.create",
  "project.open",
] as const satisfies readonly FacadeVerb[];

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
}

/**
 * The live facade contract: the same verbs as AgentFacade, with
 * project.save honestly re-shaped for live mode (the GUI's save path
 * reports a revision, not a checkpoint file — see LiveProjectSaveResult)
 * plus dispose() (release the lease, cancel jobs).
 */
export interface LiveAgentFacade extends Omit<AgentFacade, "project.save"> {
  readonly "project.save": (
    params?: Record<string, never>,
  ) => Promise<FacadeResult<LiveProjectSaveResult>>;
  /** Release write ownership without losing jobs or idempotency state. */
  releaseWriterLease(): void;
  dispose(): Promise<void>;
}

/** Ops that create exactly one entity each, in action order. */
const CREATING_OPS: ReadonlySet<EditOp["op"]> = new Set([
  "track.add",
  "clip.add",
  "clip.split",
  "clip.duplicate",
  "text.create",
  "svg.create",
  "transition.add",
  "subtitle.importSrt",
  // Instantiation creates one clip plus its own implicit lane when the
  // translator prepends a track/add — or, for kind "multi" assets, the whole
  // member expansion (several lanes + several clips, all pinned to the op).
  "workAsset.instantiate",
  // workAsset.capture deliberately absent: it creates an ASSET, not timeline
  // entities, so createdIds is always [] and the agent recovers the asset id
  // via timeline.query (same convention as single capture).
]);

interface EditApplyPayload {
  readonly applied: readonly OpApplied[];
}

/** Preserve typed renderer failures across the live facade boundary. */
function liveControlBridgeFailure(error: unknown): FacadeError | null {
  const typed =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; details?: unknown })
      : undefined;
  const code = typeof typed?.code === "string" ? typed.code : undefined;
  const details =
    typeof typed?.details === "object" && typed.details !== null
      ? (typed.details as Record<string, unknown>)
      : undefined;
  const message = error instanceof Error ? error.message : String(error);

  if (isLiveStoreConflict(error) || code === "CONFLICT") {
    return new FacadeError("CONFLICT", `editor.control: ${message}`, details);
  }
  // The renderer uses NO_PROJECT for a detached window; expose the facade's
  // stable public taxonomy rather than leaking a bridge-only code.
  if (code === "NO_PROJECT") {
    return new FacadeError(
      "NOT_FOUND",
      "editor.control: no project is open in the GUI",
      details,
    );
  }
  if (
    code !== undefined &&
    (FACADE_ERROR_CODES as readonly string[]).includes(code)
  ) {
    return new FacadeError(
      code as FacadeErrorCode,
      `editor.control: ${message}`,
      details,
    );
  }
  return null;
}

export class LiveFacadeSession {
  private readonly config: LiveFacadeConfig;
  private readonly jobs: JobRegistry;
  private readonly ledger: IdempotencyLedger;
  /**
   * Lazily resolved id of the OPEN project, folded into the ledger scope
   * (headless scopes its ledger per project id; the live project id is only
   * known asynchronously). Refreshed on every ledger access so a project
   * switch never serves the previous project's committed results.
   */
  private ledgerProjectId: string | null = null;
  /** True while this session holds the writer lease. */
  private writer: boolean;
  private disposed = false;
  private readonly analysisControllers = new Map<string, AbortController>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(config: LiveFacadeConfig) {
    this.config = config;
    this.jobs = config.jobTracker ?? new JobRegistry();
    this.ledger = new IdempotencyLedger(
      () => `live:${config.sessionId}#${this.ledgerProjectId ?? "unresolved"}`,
    );
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
    const unavailableVerbs: FacadeVerb[] = [...LIVE_UNAVAILABLE_VERBS];
    if (!mediaImportAvailable) unavailableVerbs.push("media.import");
    if (!materialLibraryAvailable) unavailableVerbs.push(...MATERIAL_VERBS);
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
      unavailableVerbs,
      },
    };
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

  /* ------------------------------ reads ------------------------------ */

  async sessionDescribe(): Promise<FacadeResult<SessionDescription>> {
    try {
      return ok(await buildSessionDescription(this.capabilityContext()));
    } catch (error) {
      return toFailure<SessionDescription>(error);
    }
  }

  async capabilitiesGet(): Promise<FacadeResult<Capabilities>> {
    try {
      return ok(await buildCapabilities(this.capabilityContext()));
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
      if (valid.timeRange !== undefined) {
        const range = validateObject<{ startSec: number; endSec: number }>(
          valid.timeRange,
          TIMELINE_QUERY_RANGE_SCHEMA,
          "timeline.query params.timeRange",
        );
        if (range.endSec <= range.startSec) {
          throw new FacadeError(
            "INVALID_PARAMS",
            "timeline.query: timeRange.endSec must be greater than startSec",
          );
        }
      }
      const [state, context] = await Promise.all([
        this.config.store.getState(),
        this.config.store.getContext(),
      ]);
      return ok(queryTimeline(state.project, state.revision, valid, context.references ?? {}));
    });
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
      const ops = await enrichMediaFileOps(
        valid.ops.map((raw, index) => validateEditOp(raw, index)),
        this.config.mediaRoots ?? [],
        async (absPath: string) => {
          const probed = await probeLocalMediaFile(absPath);
          return {
            durationSec: probed.durationSec, width: probed.width, height: probed.height,
            frameRate: probed.frameRate, codec: probed.codec, fileSize: probed.fileSize,
            mimeType: probed.mimeType, hasVideo: probed.hasVideo, hasAudio: probed.hasAudio,
            sampleRate: 0, channels: 0,
          };
        },
        async (absPath: string) => {
          const fileStat = await stat(absPath);
          return { name: basename(absPath), size: fileStat.size, lastModified: Math.round(fileStat.mtimeMs) };
        },
      );
      validateEditBatch(ops);
      if (ops.length === 0) {
        throw new FacadeError("INVALID_PARAMS", "edit.validate: ops must contain at least one op");
      }
      const [state, context] = await Promise.all([
        this.config.store.getState(),
        this.config.store.getContext(),
      ]);
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
      const prior = await this.replayLookup<
        Omit<HistoryControlResult, "replayed">
      >("history.control", valid.idempotencyKey, payload);
      if (prior) return ok({ ...prior.value, revision: prior.revision, replayed: true });

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
        if (valid.idempotencyKey !== undefined) {
          this.ledger.set("history.control", valid.idempotencyKey, {
            revision: controlled.revision,
            value,
            payloadHash: stableStringify(payload),
          });
        }
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
      const normalizedTargets = valid.targets?.map((target, index) =>
        validateObject<LiveEditorControlTarget>(
          target,
          EDITOR_CONTROL_TARGET_SCHEMA,
          `editor.control params.targets[${index}]`,
        ),
      );
      if (valid.action === "seek" && valid.timeSeconds === undefined) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "editor.control: seek requires timeSeconds",
        );
      }
      if (valid.action !== "seek" && valid.timeSeconds !== undefined) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `editor.control: timeSeconds is only valid for seek, not ${valid.action}`,
        );
      }
      if (valid.action === "select" && (!valid.targets || valid.targets.length === 0)) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "editor.control: select requires at least one target",
        );
      }
      if (
        valid.action !== "select" &&
        (valid.targets !== undefined || valid.selectionMode !== undefined)
      ) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `editor.control: targets and selectionMode are only valid for select, not ${valid.action}`,
        );
      }
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
    _params?: ProjectCreateParams,
  ): Promise<FacadeResult<ProjectCreateResult>> {
    return this.enqueue(async () => {
      this.gate("project.create");
      throw this.liveUnavailable(
        "project.create",
        "the GUI owns the project lifecycle — a live session attaches to the project already open in the editor",
      );
    });
  }

  async projectOpen(
    _params: ProjectOpenParams,
  ): Promise<FacadeResult<ProjectOpenResult>> {
    return this.enqueue(async () => {
      this.gate("project.open");
      throw this.liveUnavailable(
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
      const prior = await this.replayLookup<
        Omit<ProjectRenameResult, "revision" | "replayed">
      >("project.rename", valid.idempotencyKey, payload);
      if (prior) {
        return ok<ProjectRenameResult>({
          ...prior.value,
          revision: prior.revision,
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
      if (valid.idempotencyKey !== undefined) {
        this.ledger.set("project.rename", valid.idempotencyKey, {
          revision: committed.revision,
          value,
          payloadHash: stableStringify(payload),
        });
      }
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
    return this.enqueue(async () => {
      this.gate("media.import");
      const valid = validateObject<MediaImportParams>(
        params,
        // Keep the same closed schema and payload semantics as headless.
        // expectedRevision is a guard, not part of the idempotency payload.
        MEDIA_IMPORT_SCHEMA,
        "media.import params",
      );

      const payload = { path: valid.path, name: valid.name };
      const prior = await this.replayLookup<
        Omit<MediaImportResult, "revision" | "replayed">
      >("media.import", valid.idempotencyKey, payload);
      if (prior) {
        return ok<MediaImportResult>({
          ...prior.value,
          revision: prior.revision,
          replayed: true,
        });
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
        committed = await this.config.store.importMedia(request, {
          groupLabel: "agent: media.import",
          // As with live edit.apply, omitted expectedRevision is still an
          // unconditional CAS against the snapshot we validated/probed.
          expectedRevision: valid.expectedRevision ?? revision,
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
      if (valid.idempotencyKey !== undefined) {
        this.ledger.set("media.import", valid.idempotencyKey, {
          revision: committed.revision,
          value,
          payloadHash: stableStringify(payload),
        });
      }
      return ok<MediaImportResult>({
        ...value,
        revision: committed.revision,
        replayed: false,
      });
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
      const prior = await this.replayLookup<MediaRenderHtmlResult>(
        "media.render_html",
        valid.idempotencyKey,
        payload,
      );
      if (prior) {
        const stillThere = await stat(prior.value.path).then(
          (s) => s.isFile(),
          () => false,
        );
        if (stillThere) {
          return ok<MediaRenderHtmlResult>({ ...prior.value, replayed: true });
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
      if (valid.idempotencyKey !== undefined) {
        this.ledger.set("media.render_html", valid.idempotencyKey, {
          revision: 0, // file-producing verb: no project revision to pin
          value,
          payloadHash: stableStringify(payload),
        });
      }
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
    params: Record<string, never> = {},
  ): Promise<FacadeResult<LiveProjectSaveResult>> {
    return this.enqueue(async () => {
      this.gate("project.save");
      validateObject(
        params,
        EMPTY_PARAMS_SCHEMA,
        "project.save params (live mode takes no path — the GUI owns the save target)",
      );
      const { revision } = await this.config.store.requestSave();
      return ok<LiveProjectSaveResult>({ revision });
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
      if (valid.analysisTypes.includes("audioSummary")) {
        const ready = await audioAnalysisPreflight();
        if (!ready.available) throw new FacadeError("UNSUPPORTED", ready.reason!);
      }
      const unavailable = valid.analysisTypes.filter(
        (type) => type !== "technicalQuality" && type !== "audioSummary" && type !== "videoReview" &&
          type !== "sceneCuts" && type !== "blackFrames" && type !== "duplicateFrames",
      );
      if (unavailable.length > 0) {
        throw new FacadeError(
          "UNSUPPORTED",
          `media.analyze_start: unavailable analysis types: ${unavailable.join(", ")}`,
          { unavailableTypes: unavailable, availableTypes: ["technicalQuality", "sceneCuts", "blackFrames", "duplicateFrames"] },
        );
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
      const startSec = valid.startSec ?? 0;
      const endSec = valid.endSec ?? media.metadata.duration;
      if (!(endSec > startSec) || endSec > media.metadata.duration ||
          (valid.analysisTypes.includes("audioSummary") && endSec - startSec > 120)) {
        throw new FacadeError("INVALID_PARAMS", "Analysis requires 0 ≤ startSec < endSec ≤ source duration; audioSummary range is at most 120 seconds. Split longer sources into explicit ranges.");
      }
      const payload = {
        mediaId: valid.mediaId,
        analysisTypes: [...valid.analysisTypes].sort(),
        startSec: valid.startSec, endSec: valid.endSec, cloudUpload: valid.cloudUpload, reviewQuestion: valid.reviewQuestion,
      };
      const prior = await this.replayLookup<{
        jobId: string;
        sourceRevision: number;
        analysisTypes: readonly import("./types").MediaAnalysisType[];
      }>("media.analyze_start", valid.idempotencyKey, payload);
      if (prior && this.jobs.has(prior.value.jobId)) {
        return ok<MediaAnalyzeStartResult>({
          ...prior.value,
          kind: "analysis",
          state: this.jobs.get(prior.value.jobId)?.state ?? "queued",
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
      const originalUrl = typeof media.originalUrl === "string" ? media.originalUrl : "";
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
      if (this.analysisControllers.size >= 2) throw new FacadeError("UNSUPPORTED", "At most two analysis jobs per session; wait or cancel an existing job.");
      const sourcePath = resolution.path;
      const jobId = `job-${crypto.randomUUID()}`;
      const analysisTypes = [...valid.analysisTypes];
      this.jobs.create(jobId, state.revision, "analysis");
      const controller = new AbortController();
      this.analysisControllers.set(jobId, controller);
      const ledgerValue = {
        jobId,
        sourceRevision: state.revision,
        analysisTypes,
      };
      if (valid.idempotencyKey !== undefined) {
        this.ledger.set("media.analyze_start", valid.idempotencyKey, {
          revision: state.revision,
          value: ledgerValue,
          payloadHash: stableStringify(payload),
        });
      }
      void this.runTechnicalQualityAnalysis(
        jobId,
        sourcePath,
        media.id,
        media.name,
        analysisTypes,
        controller,
        { startSec, endSec },
        state.project.id,
        valid.reviewQuestion,
        valid.recheckOfRecordId,
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
      const ops = valid.ops.map((raw, index) => validateEditOp(raw, index));
      validateEditBatch(ops);
      if (ops.length === 0) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "edit.apply: ops must contain at least one op",
        );
      }

      // Idempotent replay first (headless semantics): a transport retry
      // replays the committed result without touching the store.
      const payload = { ops };
      const prior = await this.replayLookup<EditApplyPayload>(
        "edit.apply",
        valid.idempotencyKey,
        payload,
      );
      if (prior) {
        return ok<EditApplyResult>({
          ...prior.value,
          revision: prior.revision,
          replayed: true,
        });
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
      const enrichedOps = await enrichMediaFileOps(
        ops,
        this.config.mediaRoots ?? [],
        async (absPath: string) => {
          const probed = await probeLocalMediaFile(absPath);
          return {
            durationSec: probed.durationSec, width: probed.width, height: probed.height,
            frameRate: probed.frameRate, codec: probed.codec, fileSize: probed.fileSize,
            mimeType: probed.mimeType, hasVideo: probed.hasVideo, hasAudio: probed.hasAudio,
            sampleRate: 0, channels: 0,
          };
        },
        async (absPath: string) => {
          const fileStat = await stat(absPath);
          return { name: basename(absPath), size: fileStat.size, lastModified: Math.round(fileStat.mtimeMs) };
        },
      );

      // Caller-assigned clip ids cannot be honored live: the canonical
      // store applies the core action stream and core mints clip ids
      // (headless renames inside its private draft transaction; there is no
      // draft here). Reject honestly rather than silently ignoring the id.
      for (const [index, op] of enrichedOps.entries()) {
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
      const actions: Action[] = [];
      // Per op: either ONE implicit lane id (text.create/svg.create) or EVERY
      // lane the op's translator emitted (workAsset.instantiate multi
      // expansion) — partitionCreatedIds pins all of them to THIS op so an
      // explicit track.add in the same batch cannot steal or reorder them.
      const autoTrackIds: Array<string | readonly string[] | undefined> = [];
      // Per op: how many clips the op minted (workAsset.instantiate multi
      // expands to one clip per member); undefined = exactly one.
      const opClipCounts: Array<number | undefined> = [];
      for (const [index, op] of enrichedOps.entries()) {
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
      if (valid.idempotencyKey !== undefined) {
        this.ledger.set("edit.apply", valid.idempotencyKey, {
          revision: committed.revision,
          value,
          payloadHash: stableStringify(payload),
        });
      }
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
      const prior = await this.replayLookup<PreviewRenderFrameResult>(
        "preview.render_frame",
        valid.idempotencyKey,
        payload,
      );
      if (prior) {
        // Replay only while the artifact file still exists; a deleted file
        // falls through to an honest re-render of the same deterministic path.
        const stillThere = await stat(prior.value.artifact.path).then(
          (s) => s.isFile(),
          () => false,
        );
        if (stillThere) {
          // Mirrors headless session.ts exactly (same spread + overwrite):
          // the top-level revision is the CURRENT one — the verb runs now —
          // while artifact.sourceRevision (inside prior.value, untouched)
          // keeps the truth about which snapshot the PNG was rendered from.
          return ok<PreviewRenderFrameResult>({
            ...prior.value,
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
        project: structuredClone(project),
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
      if (valid.idempotencyKey !== undefined) {
        this.ledger.set("preview.render_frame", valid.idempotencyKey, {
          revision: sourceRevision,
          value,
          payloadHash: stableStringify(payload),
        });
      }
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
      const prior = await this.replayLookup<PreviewRenderComparisonResult>(
        "preview.render_comparison",
        valid.idempotencyKey,
        payload,
      );
      if (prior) {
        const stillThere = await stat(prior.value.artifact.path).then((s) => s.isFile(), () => false);
        if (stillThere) {
          return ok<PreviewRenderComparisonResult>({
            ...prior.value,
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
          project: structuredClone(project),
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
        if (valid.idempotencyKey !== undefined) {
          this.ledger.set("preview.render_comparison", valid.idempotencyKey, {
            revision: sourceRevision,
            value: result,
            payloadHash: stableStringify(payload),
          });
        }
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
      if (valid.timeRange !== undefined) {
        validateObject(
          valid.timeRange,
          VISUAL_INSPECT_RANGE_SCHEMA,
          "visual.inspect params.timeRange",
        );
      }
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
      const plan = buildVisualSamplePlan(project, valid);
      const sampleCount = plan.samples.length;
      const { width, height } = visualRasterSize(project, valid.width, valid.height);
      const framePixels = width * height;
      const columns = Math.min(4, sampleCount);
      const rows = Math.ceil(sampleCount / columns);
      const sheetPixels =
        (columns * (width + 8) + 8) * (rows * (height + 28) + 8);
      if (framePixels > MAX_VISUAL_FRAME_PIXELS) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `visual.inspect: raster size ${width}x${height} exceeds the ${MAX_VISUAL_FRAME_PIXELS}-pixel frame limit`,
        );
      }
      if (sampleCount * framePixels > MAX_VISUAL_CONTACT_SHEET_PIXELS || sheetPixels > MAX_VISUAL_CONTACT_SHEET_PIXELS) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "visual.inspect: requested samples exceed the contact-sheet pixel budget",
          { sampleCount, width, height },
        );
      }

      const payload = {
        ...(valid.clipId !== undefined ? { clipId: valid.clipId } : {}),
        ...(valid.timeRange !== undefined ? { timeRange: valid.timeRange } : {}),
        sampleCount,
        width,
        height,
        maxFrameBytes: valid.maxFrameBytes ?? DEFAULT_FRAME_BUDGET_BYTES,
      };
      const prior = await this.replayLookup<VisualInspectResult>(
        "visual.inspect",
        valid.idempotencyKey,
        payload,
      );
      if (prior) {
        const artifacts = [
          ...prior.value.frames.map((frame) => frame.artifact.path),
          ...(prior.value.contactSheet ? [prior.value.contactSheet.path] : []),
        ];
        const allThere = await Promise.all(
          artifacts.map((path) => stat(path).then((s) => s.isFile(), () => false)),
        );
        if (allThere.every(Boolean)) {
          return ok<VisualInspectResult>({
            ...prior.value,
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
          project: structuredClone(project),
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

      let contactSheet: VisualInspectResult["contactSheet"] = null;
      if (provider.renderContactSheetPng) {
        const contactDir = resolvePath(artifactRoot, "visual", "contact-sheets");
        await prepareArtifactDir(contactDir, artifactRoot, "visual.inspect");
        const stem = `contact-${project.id}-r${sourceRevision}-${requestKey}-${sampleCount}-${width}x${height}`;
        const tempPath = pendingArtifactPath(contactDir, stem, "png");
        const finalPath = resolvePath(contactDir, `${stem}.png`);
        try {
          const rendered = await provider.renderContactSheetPng({
            project: structuredClone(project),
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
        width,
        height,
        frameBudgetBytes,
        frames,
        contactSheet,
        limitations,
        replayed: false,
      };
      if (valid.idempotencyKey !== undefined) {
        this.ledger.set("visual.inspect", valid.idempotencyKey, {
          revision: sourceRevision,
          value,
          payloadHash: stableStringify(payload),
        });
      }
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
      const prior = await this.replayLookup<{ jobId: string; sourceRevision: number }>(
        "export.start",
        valid.idempotencyKey,
        payload,
      );
      if (prior && this.jobs.has(prior.value.jobId)) {
        const job = this.jobs.get(prior.value.jobId);
        return ok<ExportStartResult>({
          jobId: prior.value.jobId,
          state: job?.state ?? "queued",
          sourceRevision: prior.value.sourceRevision,
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
      const snapshot = structuredClone(project);
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
      this.jobs.create(jobId, sourceRevision);
      if (valid.idempotencyKey !== undefined) {
        this.ledger.set("export.start", valid.idempotencyKey, {
          revision: sourceRevision,
          value: { jobId, sourceRevision },
          payloadHash: stableStringify(payload),
        });
      }

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
        subject: { mediaId: record.subject.mediaId, name: record.subject.name },
        analysisTypes: record.analysisTypes,
        stale: { kind: record.stale.kind },
        recheckOf: record.recheckOf,
      })));
    });
  }

  /** analysis.get — one full record with provenance and staleness. */
  async analysisGet(params: AnalysisGetParams): Promise<FacadeResult<unknown>> {
    return this.enqueue(async () => {
      this.gate("analysis.get");
      const valid = validateObject<AnalysisGetParams>(params, ANALYSIS_GET_SCHEMA, "analysis.get params");
      const artifactRoot = requireArtifactRoot(this.config.artifactRoot, "analysis.get");
      return ok(await loadAnalysisRecord(artifactRoot, valid.recordId));
    });
  }

  /** job.status — poll this session's job registry (read-only verb). */
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
      if (hasUrlScheme(valid.path)) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "verify.artifact: URLs are not accepted — pass a local artifact path inside artifactRoot",
          { path: valid.path },
        );
      }
      let target = resolveContainedPathDetailed(valid.path, [artifactRoot]);
      if (target.kind === "outside") {
        // The delivered copy of a verified artifact lives outside
        // artifactRoot BY CONTRACT: accept it at its exact deliveredTo
        // location when the path sits in a delivery root's job output
        // directory (the export.start destinationPath containment rule).
        const delivered = await resolveDeliveredArtifactPath(
          valid.path,
          this.config.deliveryRoots ?? [],
        );
        if (delivered === null) {
          throw new FacadeError(
            "INVALID_PARAMS",
            "verify.artifact: path escapes the configured artifactRoot and every delivery root's job deliverables directory (<deliveryRoot>/jobs/<slug>/output/)",
            { path: valid.path },
          );
        }
        target = { kind: "ok", path: delivered };
      }
      if (target.kind === "unresolvable") {
        throw new FacadeError(
          "INVALID_PARAMS",
          "verify.artifact: path cannot be read (not found or unreadable)",
          { path: valid.path },
        );
      }
      const targetStat = await stat(target.path).catch(() => null);
      if (!targetStat || !targetStat.isFile()) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "verify.artifact: path is not a regular file",
          { path: valid.path },
        );
      }

      let request: VerifyArtifactRequest = { path: target.path };
      if (valid.expect !== undefined) {
        const expect = validateObject<NonNullable<VerifyArtifactParams["expect"]>>(
          valid.expect,
          VERIFY_EXPECT_SCHEMA,
          "verify.artifact params.expect",
        );
        request = { ...request, expect };
      }
      if (valid.compare !== undefined) {
        const compare = validateObject<NonNullable<VerifyArtifactParams["compare"]>>(
          valid.compare,
          VERIFY_COMPARE_SCHEMA,
          "verify.artifact params.compare",
        );
        if (hasUrlScheme(compare.referencePath)) {
          throw new FacadeError(
            "INVALID_PARAMS",
            "verify.artifact: reference URLs are not accepted — pass a local path inside artifactRoot",
          );
        }
        const reference = resolveContainedPathDetailed(compare.referencePath, [artifactRoot]);
        if (reference.kind !== "ok") {
          throw new FacadeError(
            "INVALID_PARAMS",
            "verify.artifact: referencePath escapes the configured artifactRoot (a live session has no mediaRoots to fall back to)",
            { referencePath: compare.referencePath },
          );
        }
        let region;
        if (compare.region !== undefined) {
          region = validateObject<NonNullable<typeof compare.region>>(
            compare.region,
            VERIFY_REGION_SCHEMA,
            "verify.artifact params.compare.region",
          );
          if (region.x + region.width > 1 || region.y + region.height > 1) {
            throw new FacadeError(
              "INVALID_PARAMS",
              "verify.artifact: compare.region must satisfy x+width ≤ 1 and y+height ≤ 1",
              { region },
            );
          }
        }
        request = {
          ...request,
          compare: {
            referencePath: reference.path,
            timeSec: compare.timeSec,
            ...(compare.referenceTimeSec !== undefined
              ? { referenceTimeSec: compare.referenceTimeSec }
              : {}),
            ...(region !== undefined ? { region } : {}),
            mode: compare.mode,
            ...(compare.maxMeanAbsDiff !== undefined
              ? { maxMeanAbsDiff: compare.maxMeanAbsDiff }
              : {}),
            ...(compare.minMeanAbsDiff !== undefined
              ? { minMeanAbsDiff: compare.minMeanAbsDiff }
              : {}),
            ...(compare.minChangedPixelsRatio !== undefined
              ? { minChangedPixelsRatio: compare.minChangedPixelsRatio }
              : {}),
          },
        };
      }

      const report = await verifier.verify(request);
      return ok(report);
    });
  }

  /* ----------------- material.* (user-level library) ------------------ */

  /**
   * The renderer owns the canonical user-level library (records + journal +
   * IndexedDB); the facade stays stateless and only validates, guards, and
   * forwards. Error codes cross the bridge as the facade's public taxonomy.
   */
  private materialBridgeFailure(verb: FacadeVerb, error: unknown): FacadeError {
    const typed =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown; message?: unknown; details?: unknown })
        : undefined;
    const message =
      (typeof typed?.message === "string" && typed.message) ||
      (error instanceof Error ? error.message : String(error));
    const details =
      typed?.details && typeof typed.details === "object"
        ? (typed.details as Record<string, unknown>)
        : undefined;
    const code = typeof typed?.code === "string" ? typed.code : undefined;
    if (isLiveStoreConflict(error) || code === "CONFLICT") {
      return new FacadeError("CONFLICT", `${verb}: ${message}`, details);
    }
    if (code === "NOT_FOUND" || code === "NO_PROJECT") {
      return new FacadeError(
        "NOT_FOUND",
        code === "NO_PROJECT"
          ? `${verb}: no project is open in the GUI`
          : `${verb}: ${message}`,
        details,
      );
    }
    if (code === "INVALID_PARAMS" || code === "UNSUPPORTED") {
      return new FacadeError(code, `${verb}: ${message}`, details);
    }
    if (code === "MISSING_FILE") {
      return new FacadeError("INVALID_PARAMS", `${verb}: ${message}`, {
        ...(details ?? {}),
        reason: "missing_file",
      });
    }
    return new FacadeError("INTERNAL", `${verb}: ${message}`, details);
  }

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
      throw this.materialBridgeFailure(verb, error);
    }
    if (!reply.ok) {
      throw this.materialBridgeFailure(verb, reply.error);
    }
    return reply.result as T;
  }

  /**
   * Validate that an agent-supplied media path stays inside the configured
   * media roots and exists — the same containment rule as media.import, so
   * the library can never become a side channel for reading arbitrary files
   * (a later material.attach reads the path through the trusted renderer).
   */
  private async resolveMaterialMediaPath(verb: FacadeVerb, filePath: string): Promise<{
    path: string;
    sizeBytes: number;
    lastModifiedMs: number;
  }> {
    const roots = this.config.mediaRoots ?? [];
    if (roots.length === 0) {
      throw new FacadeError(
        "UNSUPPORTED",
        `${verb}: no media roots configured for this live session`,
      );
    }
    if (hasUrlScheme(filePath)) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: URLs are not accepted — pass an absolute local file path inside a configured media root`,
        { path: filePath },
      );
    }
    if (!isAbsolute(filePath)) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: paths must be absolute — nothing is resolved against the host process cwd`,
        { path: filePath },
      );
    }
    const resolution = resolveContainedPathDetailed(filePath, roots);
    if (resolution.kind === "outside") {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: path escapes the configured media roots`,
        { path: filePath, mediaRoots: [...roots] },
      );
    }
    if (resolution.kind === "unresolvable") {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: source file is missing or unreadable`,
        { path: filePath, reason: "missing_file" },
      );
    }
    const fileStat = await stat(resolution.path).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: source file is missing or not a regular file`,
        { path: filePath, reason: "missing_file" },
      );
    }
    return {
      path: resolution.path,
      sizeBytes: fileStat.size,
      lastModifiedMs: Math.round(fileStat.mtimeMs),
    };
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
      const prior = await this.replayLookup<MaterialCreateResult>(
        "material.create",
        idempotencyKey,
        payload,
      );
      if (prior) {
        return ok<MaterialCreateResult>({ ...prior.value, replayed: true });
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
        const resolved = await this.resolveMaterialMediaPath(
          "material.create",
          valid.filePath,
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
      if (idempotencyKey !== undefined) {
        this.ledger.set("material.create", idempotencyKey, {
          revision: 0,
          value: result,
          payloadHash: stableStringify(payload),
        });
      }
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
      const prior = await this.replayLookup<MaterialUpdateResult>(
        "material.update",
        idempotencyKey,
        payload,
      );
      if (prior) {
        return ok<MaterialUpdateResult>({ ...prior.value, replayed: true });
      }
      const result = await this.callMaterialBridge<MaterialUpdateResult>(
        "material.update",
        "update",
        payload as unknown as Record<string, unknown>,
      );
      if (idempotencyKey !== undefined) {
        this.ledger.set("material.update", idempotencyKey, {
          revision: 0,
          value: result,
          payloadHash: stableStringify(payload),
        });
      }
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
      const prior = await this.replayLookup<MaterialBatchUpdateResult>(
        "material.batch_update",
        idempotencyKey,
        payload,
      );
      if (prior) {
        return ok<MaterialBatchUpdateResult>({
          ...prior.value,
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
      if (idempotencyKey !== undefined) {
        this.ledger.set("material.batch_update", idempotencyKey, {
          revision: 0,
          value: result,
          payloadHash: stableStringify(payload),
        });
      }
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
      const prior = await this.replayLookup<MaterialRemoveResult>(
        "material.remove",
        idempotencyKey,
        payload,
      );
      if (prior) {
        return ok<MaterialRemoveResult>({ ...prior.value, replayed: true });
      }
      const result = await this.callMaterialBridge<MaterialRemoveResult>(
        "material.remove",
        "remove",
        { id: valid.id, ...(valid.force !== undefined ? { force: valid.force } : {}) },
      );
      if (idempotencyKey !== undefined) {
        this.ledger.set("material.remove", idempotencyKey, {
          revision: 0,
          value: result,
          payloadHash: stableStringify(payload),
        });
      }
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
      const prior = await this.replayLookup<MaterialAttachResult>(
        "material.attach",
        idempotencyKey,
        payload,
      );
      if (prior) {
        return ok<MaterialAttachResult>({ ...prior.value, replayed: true });
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
      if (idempotencyKey !== undefined) {
        this.ledger.set("material.attach", idempotencyKey, {
          revision: result.revision,
          value: result,
          payloadHash: stableStringify(payload),
        });
      }
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
      const prior = await this.replayLookup<MaterialUndoResult>(
        "material.undo",
        idempotencyKey,
        payload,
      );
      if (prior) {
        return ok<MaterialUndoResult>({ ...prior.value, replayed: true });
      }
      const result = await this.callMaterialBridge<MaterialUndoResult>(
        "material.undo",
        "undo",
        {
          ...(valid.entryId !== undefined ? { entryId: valid.entryId } : {}),
          actor: "agent",
        },
      );
      if (idempotencyKey !== undefined) {
        this.ledger.set("material.undo", idempotencyKey, {
          revision: 0,
          value: result,
          payloadHash: stableStringify(payload),
        });
      }
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
      throw this.materialBridgeFailure(verb, error);
    }
    if (!reply.ok) {
      throw this.materialBridgeFailure(verb, reply.error);
    }
    return reply.result as T;
  }

  /**
   * Decode + validate the font bytes for one upload request: exactly one of
   * filePath/dataBase64, media-root containment for paths, 10 MiB decoded
   * budget. Returns the bytes plus the base name the family derives from
   * (matching the renderer's own name derivation).
   */
  private async resolveFontUploadBytes(
    valid: FontUploadParams,
  ): Promise<{ data: ArrayBuffer; baseName: string }> {
    const hasPath = valid.filePath !== undefined;
    const hasBase64 = valid.dataBase64 !== undefined;
    if (hasPath === hasBase64) {
      throw new FacadeError(
        "INVALID_PARAMS",
        "font.upload: exactly one of filePath or dataBase64 is required",
      );
    }

    let data: ArrayBuffer;
    let baseName: string;
    if (hasPath) {
      // Same containment rule as media.import/material.create: the path can
      // never become a side channel for reading arbitrary files.
      const resolved = await this.resolveMaterialMediaPath(
        "font.upload",
        valid.filePath as string,
      );
      if (resolved.sizeBytes > FONT_LIBRARY_LIMITS.maxFontBytes) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `font.upload: font file is ${resolved.sizeBytes} bytes; the limit is ${FONT_LIBRARY_LIMITS.maxFontBytes} bytes`,
          {
            sizeBytes: resolved.sizeBytes,
            maxFontBytes: FONT_LIBRARY_LIMITS.maxFontBytes,
          },
        );
      }
      data = await readFileFontBytes(resolved.path).then(bufferToArrayBuffer);
      baseName = basename(resolved.path);
    } else {
      const decoded = decodeBase64ToBuffer(valid.dataBase64 as string);
      if (decoded === null) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "font.upload: dataBase64 is not valid base64",
        );
      }
      if (
        decoded.byteLength > FONT_LIBRARY_LIMITS.maxFontBytes
      ) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `font.upload: decoded font is ${decoded.byteLength} bytes; the limit is ${FONT_LIBRARY_LIMITS.maxFontBytes} bytes`,
          {
            sizeBytes: decoded.byteLength,
            maxFontBytes: FONT_LIBRARY_LIMITS.maxFontBytes,
          },
        );
      }
      data = decoded;
      baseName = "";
    }

    // Pass the renderer the exact base name the family derives from, so the
    // deduped flag in the response compares against the same string.
    return {
      data,
      baseName: (valid.name ?? baseName).replace(/\.(ttf|otf|woff2?)$/i, ""),
    };
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
      const { data, baseName } = await this.resolveFontUploadBytes(valid);
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
      throw this.presetBridgeFailure(verb, error);
    }
    if (!reply.ok) {
      throw this.presetBridgeFailure(verb, reply.error);
    }
    return reply.result as T;
  }

  /**
   * Placement/apply problems are parameter errors, not INTERNAL failures:
   * the specific renderer code is preserved in details.reason (TARGET_NOT_FOUND
   * maps to NOT_FOUND, matching the taxonomy's missing-entity code).
   */
  private presetBridgeFailure(verb: FacadeVerb, error: unknown): FacadeError {
    const typed =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown; message?: unknown; details?: unknown })
        : undefined;
    const code = typeof typed?.code === "string" ? typed.code : undefined;
    const message =
      (typeof typed?.message === "string" && typed.message) ||
      (error instanceof Error ? error.message : String(error));
    const details =
      typed?.details && typeof typed.details === "object"
        ? (typed.details as Record<string, unknown>)
        : undefined;
    if (code === "TARGET_NOT_FOUND") {
      return new FacadeError("NOT_FOUND", `${verb}: ${message}`, details);
    }
    if (
      code === "PLACEMENT_INVALID" ||
      code === "TARGET_REQUIRED" ||
      code === "TARGET_MISMATCH" ||
      code === "PRESET_INVALID" ||
      code === "PRESET_APPLY_UNSUPPORTED" ||
      code === "PAYLOAD_VERSION_UNSUPPORTED"
    ) {
      return new FacadeError("INVALID_PARAMS", `${verb}: ${message}`, {
        ...(details ?? {}),
        reason: code,
      });
    }
    return this.materialBridgeFailure(verb, error);
  }

  /**
   * Deep payload check with the core validator (Node-safe). Name and
   * thumbnail run through their own core validators at the verb layer.
   */
  private assertPresetPayloadValid(
    verb: FacadeVerb,
    payload: unknown,
  ): Record<string, unknown> {
    const checked = validatePresetPayload(payload);
    if (!checked.ok) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: ${checked.message}`,
        { validationCode: checked.code, ...(checked.details ?? {}) },
      );
    }
    return checked.value as unknown as Record<string, unknown>;
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
      const prior = await this.replayLookup<PresetCreateResult>(
        "preset.create",
        idempotencyKey,
        payload,
      );
      if (prior) {
        return ok<PresetCreateResult>({ ...prior.value, replayed: true });
      }
      const name = validatePresetName(valid.name);
      if (!name.ok) {
        throw new FacadeError("INVALID_PARAMS", `preset.create: ${name.message}`, {
          validationCode: name.code,
        });
      }
      const normalizedPayload = this.assertPresetPayloadValid(
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
      if (idempotencyKey !== undefined) {
        this.ledger.set("preset.create", idempotencyKey, {
          revision: 0,
          value: result,
          payloadHash: stableStringify(payload),
        });
      }
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
      const prior = await this.replayLookup<PresetUpdateResult>(
        "preset.update",
        idempotencyKey,
        payload,
      );
      if (prior) {
        return ok<PresetUpdateResult>({ ...prior.value, replayed: true });
      }
      let normalizedPayload: Record<string, unknown> | undefined;
      if (valid.payload !== undefined) {
        normalizedPayload = this.assertPresetPayloadValid(
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
      if (idempotencyKey !== undefined) {
        this.ledger.set("preset.update", idempotencyKey, {
          revision: 0,
          value: result,
          payloadHash: stableStringify(payload),
        });
      }
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
      const prior = await this.replayLookup<PresetRemoveResult>(
        "preset.remove",
        idempotencyKey,
        payload,
      );
      if (prior) {
        return ok<PresetRemoveResult>({ ...prior.value, replayed: true });
      }
      const result = await this.callPresetBridge<PresetRemoveResult>(
        "preset.remove",
        "remove",
        { id: valid.id },
      );
      if (idempotencyKey !== undefined) {
        this.ledger.set("preset.remove", idempotencyKey, {
          revision: 0,
          value: result,
          payloadHash: stableStringify(payload),
        });
      }
      return ok(result);
    });
  }

  /**
   * Structural target validation before any renderer round-trip: the
   * kind-specific target shape is closed here (shared predicate, also used
   * by the transports' runtime mirrors); payload/target kind pairing and
   * clip existence stay renderer-side where the project lives.
   */
  private assertPresetApplyTarget(
    target: Record<string, unknown>,
  ): Record<string, unknown> {
    const problem = presetApplyTargetProblem(target);
    if (problem !== null) {
      throw new FacadeError("INVALID_PARAMS", `preset.apply: ${problem}`);
    }
    const kind = target.kind as string;
    if (kind === "text") {
      return { kind, mode: target.mode, clipId: target.clipId };
    }
    if (kind === "effect") {
      return { kind, clipIds: [...(target.clipIds as readonly string[])] };
    }
    if (kind === "graphics") {
      return {
        kind,
        ...(target.trackId !== undefined ? { trackId: target.trackId } : {}),
        ...(target.startTime !== undefined ? { startTime: target.startTime } : {}),
        ...(target.durationSec !== undefined ? { durationSec: target.durationSec } : {}),
      };
    }
    return {
      kind,
      clipAId: target.clipAId,
      ...(target.clipBId !== undefined ? { clipBId: target.clipBId } : {}),
    };
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
      const prior = await this.replayLookup<PresetApplyResult>(
        "preset.apply",
        idempotencyKey,
        payload,
      );
      if (prior) {
        return ok<PresetApplyResult>({ ...prior.value, replayed: true });
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
      const target = this.assertPresetApplyTarget(
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
      if (idempotencyKey !== undefined) {
        this.ledger.set("preset.apply", idempotencyKey, {
          revision: result.revision,
          value: result,
          payloadHash: stableStringify(payload),
        });
      }
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
    await this.chain.catch(() => undefined);

    const provider = this.config.exportProvider;
    const cancellations = this.jobs.list().map(async (job) => {
      if (job.state === "queued" || job.state === "running") {
        this.jobs.markCancelRequested(job.jobId);
        if (job.kind === "analysis") {
          this.analysisControllers.get(job.jobId)?.abort();
        } else if (provider) {
          await cancelExportWithin(provider, job.jobId).catch(() => false);
        }
        this.jobs.markCancelled(job.jobId);
      }
    });
    await Promise.all(cancellations);
  }

  /* ---------------------------- internals ----------------------------- */

  private liveUnavailable(verb: string, why: string): FacadeError {
    return new FacadeError(
      "UNSUPPORTED",
      `${verb}: unavailable in live mode — ${why}`,
    );
  }

  /**
   * Idempotency-ledger replay lookup (the live half of headless
   * beginMutation's ledger phase — the revision CAS lives in the store, not
   * here). Returns the stored committed outcome on a replay hit; the same
   * key with a DIFFERENT payload is a CONFLICT, never a blind replay.
   *
   * The ledger scope tracks the open project: refreshed here, before every
   * lookup, so a key replayed after a project switch misses the OLD
   * project's entry and executes fresh (headless parity: per-project scope).
   */
  private async replayLookup<T>(
    verb: string,
    idempotencyKey: string | undefined,
    payload: unknown,
  ): Promise<{ revision: number; value: T } | null> {
    if (idempotencyKey === undefined) return null;
    // Never replay a result from the last project if the current identity is
    // unavailable or its request guard has failed during a project switch.
    const { projectId, projectEpoch } = await this.config.store.getIdentity();
    this.ledgerProjectId = `${projectId}:${projectEpoch ?? "legacy"}`;
    const stored = this.ledger.get<T>(verb, idempotencyKey);
    if (!stored) return null;
    if (stableStringify(payload) !== stored.payloadHash) {
      throw new FacadeError(
        "CONFLICT",
        `idempotency key "${idempotencyKey}" was already committed with a different payload`,
        { idempotencyKey, verb },
      );
    }
    return { revision: stored.revision, value: stored.value };
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
    reviewQuestion?: string,
    recheckOfRecordId?: string,
  ): Promise<void> {
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
      this.jobs.markProgress(jobId, { phase: "preparing", percent: .1 });
      const video = analysisTypes.includes("videoReview")
        ? await reviewVideo(sourcePath, range, this.config.artifactRoot!, controller.signal, reviewQuestion, (percent) => this.jobs.markProgress(jobId, { phase: "rendering", percent: .1 + percent * .7 })) : undefined;
      const audio = analysisTypes.includes("audioSummary")
        ? await analyzeLocalAudio(sourcePath, range, controller.signal, (percent) => this.jobs.markProgress(jobId, { phase: "rendering", percent: video ? .8 + percent * .15 : percent })) : undefined;
      if (controller.signal.aborted) { this.jobs.markCancelled(jobId); return; }
      const videoCandidateTypes = analysisTypes.filter(
        (type) => type === "sceneCuts" || type === "blackFrames" || type === "duplicateFrames",
      );
      let candidates: VideoCandidateBundle | undefined;
      if (videoCandidateTypes.length > 0) {
        const binaries = await resolveToolFfmpeg();
        if (!binaries) throw new FacadeError("UNSUPPORTED", "Local video candidate analysis needs ffmpeg/ffprobe on PATH (or REELTERMINAL_FFMPEG_PATH / REELTERMINAL_FFPROBE_PATH)");
        candidates = await runVideoCandidateAnalyses(binaries, sourcePath, range, analysisTypes, controller.signal, (percent) => this.jobs.markProgress(jobId, { phase: "rendering", percent: .5 + percent * .4 }));
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
      // Durable, traceable record (P2) — mirrors headless exactly.
      // Records need an artifactRoot; without one the analysis completes
      // exactly as before (ephemeral job summary only).
      let recordRef: { id: string; recordPath: string; recheckOf: string | null } | null = null;
      if (this.config.artifactRoot) {
      let recheckTarget = null;
      if (recheckOfRecordId) {
        recheckTarget = await resolveRecheckTarget(this.config.artifactRoot, recheckOfRecordId);
      }
      const saved = await saveAnalysisRecord(this.config.artifactRoot, {
        projectId,
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
        },
        provenance: [
          ...(analysisTypes.includes("technicalQuality")
            ? [{ kind: "local-measurement" as const, provider: "built-in-mediabunny-stat+ffprobe-color", analysisType: "technicalQuality" }]
            : []),
          ...(analysisTypes.includes("audioSummary")
            ? [{ kind: "local-measurement" as const, provider: "local-ffmpeg-ebur128", analysisType: "audioSummary" }]
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
          ...(candidates?.sceneCuts ? [{ source: "sceneCuts", facts: candidates.sceneCuts }] : []),
          ...(candidates?.blackFrames ? [{ source: "blackFrames", facts: candidates.blackFrames }] : []),
          ...(candidates?.duplicateFrames ? [{ source: "duplicateFrames", facts: candidates.duplicateFrames }] : []),
        ],
        inferences: audio?.bpmCandidates
          ? [{ source: "audioSummary", note: "BPM candidates are analyzer inferences from periodicity, not ground truth", bpmCandidates: audio.bpmCandidates }]
          : [],
        recommendations: [],
        unknowns: [
          ...(video ? [{ field: "videoReview.serverSamplingFps", note: "The cloud provider does not disclose its sampling rate; short events may be missed" }] : []),
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
      }
      this.jobs.markAnalysisDone(jobId, {
        analysisTypes,
        summary: {
          ...summary,
          ...(recordRef ? { analysisRecord: recordRef } : {}),
        },
        artifacts: [],
      });
    } catch (error) {
      if (controller.signal.aborted) { this.jobs.markCancelled(jobId); return; }
      this.jobs.markError(jobId, {
        code: error instanceof FacadeError ? error.code : "JOB_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.analysisControllers.delete(jobId);
    }
  }

  /** Resolve ONE media item's file with the live builder's checks. */
  private async resolveLiveMediaItemFile(itemInput: unknown): Promise<string | null> {
    const item = itemInput as (typeof this.config.store extends never ? never : { id: string; originalUrl?: unknown });
    const originalUrl =
      typeof item.originalUrl === "string" ? (item.originalUrl as string) : null;
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
      const originalUrl =
        typeof (item as { originalUrl?: unknown }).originalUrl === "string"
          ? ((item as { originalUrl?: string }).originalUrl as string)
          : null;
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
      this.jobs.markDone(
        jobId,
        artifact,
        completion.route,
        completion.upscalingRequestedButInactive === true,
      );
      if (delivery !== null) {
        // Post-publish copy into the Agent workspace deliverables directory.
        // A delivery failure never downgrades the done job or hides the
        // artifact — it surfaces as deliveryError on job.status.
        try {
          await deliverExportArtifact(resolution.path, delivery);
          this.jobs.markDelivered(jobId, delivery.path);
        } catch (deliveryError) {
          this.jobs.markDeliveryFailed(
            jobId,
            deliveryError instanceof Error
              ? deliveryError.message
              : String(deliveryError),
          );
        }
      }
    } catch (error) {
      this.jobs.markError(jobId, {
        code: error instanceof FacadeError ? error.code : "JOB_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Serialized execution: every verb body runs inside this single lane. */
  private enqueue<T>(task: () => Promise<FacadeResult<T>>): Promise<FacadeResult<T>> {
    const result = this.chain.then(() => task()).catch((error: unknown) => {
      if (isLiveStoreConflict(error)) {
        const conflict = error as { message?: string; details?: Record<string, unknown> };
        return toFailure<T>(new FacadeError("CONFLICT", conflict.message ?? "Project changed", conflict.details));
      }
      return toFailure<T>(error);
    });
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Partition store-diffed created ids onto ops. Each creating op consumes one
 * id from ITS OWN category bucket, in batch order within that category —
 * mirroring ops.ts diffCreatedIdsByCategory. A mixed batch (e.g.
 * [text.create, clip.add]) thus hands every op the id of the entity it
 * created; a flat project-ordered list would cross-assign the ids.
 *
 * workAsset.instantiate consumes per op: EVERY lane its translator created
 * (pinned via autoTrackIds — a single entry or the multi expansion's whole
 * list), then as many clip ids as the expansion minted (opClipCounts; single
 * assets mint exactly one, multi assets one per member).
 */
function partitionCreatedIds(
  ops: readonly EditOp[],
  createdIds: LiveCreatedIds,
  autoTrackIds: readonly (string | readonly string[] | undefined)[] = [],
  opClipCounts: readonly (number | undefined)[] = [],
): OpApplied[] {
  const categories = {
    "track.add": "tracks",
    "clip.add": "clips",
    "clip.split": "clips",
    "clip.duplicate": "clips",
    "transition.add": "transitions",
  } as const;
  const usedTracks = new Set<string>();
  const cursors = {
    tracks: 0,
    clips: 0,
    textClips: 0,
    svgClips: 0,
    transitions: 0,
    subtitles: 0,
  };
  const autoTrackIdList = (index: number): readonly string[] => {
    const value = autoTrackIds[index];
    if (value === undefined) return [];
    return typeof value === "string" ? [value] : value;
  };
  return ops.map((op, index) => {
    if (!CREATING_OPS.has(op.op)) return { op: op.op, createdIds: [] };
    const ids: string[] = [];
    if (op.op === "track.add") {
      const id = createdIds.tracks.find((candidate) => !usedTracks.has(candidate));
      if (id !== undefined) {
        usedTracks.add(id);
        ids.push(id);
      }
    } else if (op.op === "text.create") {
      // An implicit text lane is part of this higher-level op. Use the exact
      // id emitted by the translator, so explicit track.add ops in the same
      // batch cannot steal or reorder it.
      for (const autoTrackId of autoTrackIdList(index)) {
        if (createdIds.tracks.includes(autoTrackId)) {
          usedTracks.add(autoTrackId);
          ids.push(autoTrackId);
        }
      }
      const id = createdIds.textClips[cursors.textClips];
      cursors.textClips += 1;
      if (id !== undefined) ids.push(id);
    } else if (op.op === "svg.create") {
      // Same implicit-lane convention as text.create, including the reported
      // order [autoTrackId, overlayId]. A seam store without the svgClips
      // bucket (optional on LiveCreatedIds) reports no clip id here — the
      // agent falls back to timeline.query's svg projection.
      for (const autoTrackId of autoTrackIdList(index)) {
        if (createdIds.tracks.includes(autoTrackId)) {
          usedTracks.add(autoTrackId);
          ids.push(autoTrackId);
        }
      }
      const svgClips = createdIds.svgClips ?? [];
      const id = svgClips[cursors.svgClips];
      cursors.svgClips += 1;
      if (id !== undefined) ids.push(id);
    } else if (op.op === "subtitle.importSrt") {
      ids.push(...createdIds.subtitles.slice(cursors.subtitles));
      cursors.subtitles = createdIds.subtitles.length;
    } else if (op.op === "workAsset.instantiate") {
      // Same implicit-lane convention as text.create/svg.create, generalized
      // to multi assets: every track/add the translator emitted is pinned for
      // THIS op, then one clip id per member is consumed from the clips
      // bucket in batch order (single assets mint exactly one).
      for (const autoTrackId of autoTrackIdList(index)) {
        if (createdIds.tracks.includes(autoTrackId)) {
          usedTracks.add(autoTrackId);
          ids.push(autoTrackId);
        }
      }
      const clipCount = opClipCounts[index] ?? 1;
      for (let consumed = 0; consumed < clipCount; consumed++) {
        const id = createdIds.clips[cursors.clips];
        cursors.clips += 1;
        if (id !== undefined) ids.push(id);
      }
    } else {
      const category = categories[op.op as keyof typeof categories];
      const id = createdIds[category][cursors[category]];
      cursors[category] += 1;
      if (id !== undefined) ids.push(id);
    }
    // A missing bucket entry means the store created nothing for this op
    // (e.g. an implicit dependency was diffed instead) — report honestly.
    return { op: op.op, createdIds: ids };
  });
}

/**
 * Create a live facade session over the canonical-store seam. Construction
 * acquires the writer lease for write-enabled sessions; when another AI session
 * holds it, the returned session still works read-only (session.describe
 * reports `writer: false` and the current holder).
 */
export function createLiveFacade(config: LiveFacadeConfig): LiveAgentFacade {
  const session = new LiveFacadeSession(config);
  return {
    ...bindBundledTools(session, config, "live"),
    "session.describe": () => session.sessionDescribe(),
    "capabilities.get": () => session.capabilitiesGet(),
    "project.create": (params) => session.projectCreate(params),
    "project.open": (params) => session.projectOpen(params),
    "project.save": (params) => session.projectSave(params),
    "project.rename": (params) => session.projectRename(params),
    "project.get_state": () => session.projectGetState(),
    "project.changes": (params) => session.projectChanges(params),
    "media.import": (params) => session.mediaImport(params),
    "media.render_html": (params) => session.mediaRenderHtml(params),
    "media.analyze_start": (params) => session.mediaAnalyzeStart(params),
    "timeline.get": () => session.timelineGet(),
    "timeline.query": (params) => session.timelineQuery(params),
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
    dispose: () => session.dispose(),
  };
}

/**
 * font.upload byte plumbing (module-local): strict-ish base64 decoding and
 * a Node Buffer → ArrayBuffer transfer so the bytes can cross the bridge
 * as a structured-cloneable ArrayBuffer.
 */
function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(out).set(buffer);
  return out;
}

function decodeBase64ToBuffer(text: string): ArrayBuffer | null {
  const normalized = text.replace(/\s+/g, "");
  if (normalized.length === 0 || normalized.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0) return null;
  return bufferToArrayBuffer(buffer);
}
