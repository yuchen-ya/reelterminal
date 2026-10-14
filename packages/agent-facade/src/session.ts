import { reviewVideo, videoReviewPreflight } from "./video-review";
import { analyzeLocalAudio, analyzeSilence, analyzeBeatGrid, audioAnalysisPreflight, resolveSilenceAnalysisParams, AUDIO_LIMITS } from "./audio-analysis";
import { runVideoCandidateAnalyses, videoCandidatesPreflight, type VideoCandidateBundle } from "./video-candidates";
import { resolveToolFfmpeg } from "./media/ffmpeg-bin";
import { probeVideoFacts } from "./media/frame-exact";
/**
 * Core in-process agent facade session.
 *
 * Guarantees:
 *  - Project is the canonical state; all mutations go through ONE serialized
 *    execution lane (promise-chained), never interleaved.
 *  - Every mutating verb runs as a snapshot transaction: ops are applied to a
 *    structuredClone'd draft via the core ActionExecutor; the draft replaces
 *    the live project only when EVERY step succeeds. A failure anywhere
 *    discards the draft — the original Project object is never touched, so
 *    rollback is byte-exact by construction (no core executeMany, no
 *    batch_actions, no core undo).
 *  - `expectedRevision` gives optimistic concurrency; `idempotencyKey` gives
 *    at-most-once semantics across transport retries.
 *  - Strict closed-schema validation at the boundary: unknown fields, wrong
 *    field names and unsupported ops fail with zero side effects.
 */
import { ActionExecutor } from "@reelterminal/core/actions/action-executor";
import { ActionHistory } from "@reelterminal/core/actions/action-history";
import type { Project, ProjectSettings } from "@reelterminal/core/types/project";
import type { MediaItem } from "@reelterminal/core/types/project";
import type { MaterialListResult } from "@reelterminal/core/material/types";
import type { FacadeVerb } from "./types";
import type { WorkspaceVerb } from "./workspace-library";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import { readFile, rm, stat } from "node:fs/promises";

import { buildCapabilities, buildSessionDescription } from "./capabilities";
import {
  artifactRefFor,
  assertContainedWrittenFile,
  prepareArtifactDir,
  requireArtifactRoot,
  requireProviderPreflight,
} from "./artifact-io";
import {
  assertCheckpointIntegrity,
  buildCheckpointDocument,
  findMediaBindingOffenders,
  MAX_CHECKPOINT_BYTES,
  parseCheckpointText,
  publishCheckpoint,
  validateCheckpointStructure,
} from "./checkpoint";
import { FacadeError, ok, toFailure, type FacadeResult } from "./errors";
import {
  deliverExportArtifact,
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
import { ProjectChangeJournal } from "./project-changes";
import { queryTimeline } from "./timeline-query";
import { mapTimelineSourceTimes } from "./timeline-source-map";
import { validateEditPlan } from "./edit-validation";
import {
  applyClipIdOverride,
  collectEntityIds,
  diffCreatedIds,
  enrichMediaFileOps,
  opToCoreActions,
} from "./ops";
import {
  projectStateView,
  timelineDurationSec,
  timelineStateView,
} from "./projection";
import {
  REQUIREMENTS_LIST_SCHEMA, REQUIREMENTS_GET_SCHEMA,
  requirementsListView, requirementsGetView,
  type RequirementsListParams, type RequirementsListResult,
  type RequirementsGetParams, type RequirementsGetResult,
} from "./requirements";
import { createEmptyProject, DEFAULT_PROJECT_SETTINGS } from "./project-factory";
import type {
  AnalysisGetParams,
  AnalysisListParams,
  AnalysisListResult,
  PreviewRenderComparisonParams,
  PreviewRenderComparisonResult,
} from "./types";
import type {
  ArtifactVerifier,
  ExportCallbacks,
  ExportProvider,
  RenderProvider,
  RenderContactSheetRequest,
  VerifyArtifactRequest,
} from "./providers";
import type { ProjectRenderAdapter } from "./render/adapter";
import {
  hasUrlScheme,
  resolveContainedPathDetailed,
} from "./media/path-roots";
import { probeLocalMediaFile } from "./media/node-media-adapter";
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
import {
  validateObject,
} from "./validate";
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
  ANALYSIS_GET_SCHEMA,
  ANALYSIS_LIST_SCHEMA,
  PREVIEW_RENDER_COMPARISON_SCHEMA,
  PREVIEW_RENDER_FRAME_SCHEMA,
  VISUAL_INSPECT_SCHEMA,
  PROJECT_CREATE_SCHEMA,
  PROJECT_OPEN_SCHEMA,
  PROJECT_RENAME_SCHEMA,
  PROJECT_SAVE_SCHEMA,
  PROJECT_SETTINGS_SCHEMA,
  normalizeProjectName,
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
import type {
  MaterialListParams,
  MaterialGetParams,
  MaterialGetResult,
  MaterialCreateParams,
  MaterialCreateResult,
  MaterialUpdateParams,
  MaterialUpdateResult,
  MaterialBatchUpdateParams,
  MaterialBatchUpdateResult,
  MaterialRemoveParams,
  MaterialRemoveResult,
  MaterialAttachParams,
  MaterialAttachResult,
  MaterialUndoParams,
  MaterialUndoResult,
} from "./material-library";
import type {
  LiveEditorControlParams,
  LiveEditorControlResult,
} from "./live-store";
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
  MediaRenderHtmlParams,
  MediaRenderHtmlResult,
  MediaAnalyzeStartParams,
  MediaAnalyzeStartResult,
  OpApplied,
  PreviewRenderFrameParams,
  PreviewRenderFrameResult,
  VisualInspectParams,
  VisualInspectResult,
  ProjectCreateParams,
  ProjectCreateResult,
  ProjectOpenParams,
  ProjectOpenResult,
  ProjectRenameParams,
  ProjectRenameResult,
  ProjectSaveParams,
  ProjectSaveResult,
  ProjectState,
  SessionDescription,
  TimelineState,
  ProjectChangesParams,
  ProjectChangesResult,
  TimelineQueryParams,
  TimelineQueryResult,
  TimelineMapSourceTimesParams,
  TimelineMapSourceTimesResult,
  EditValidateParams,
  EditValidateResult,
  HistoryGetParams,
  HistoryGetResult,
  HistoryControlParams,
  HistoryControlResult,
  VerifyArtifactParams,
  VerifyArtifactResult,
} from "./types";
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
import { produceHtmlRenderArtifact } from "./media-render-html";
import { DEFAULT_FRAME_BUDGET_BYTES, fitFrameToBudget } from "./frame-budget";

export interface AgentFacadeConfig {
  /**
   * Absolute roots that media.import may read from. Imports resolving
   * outside every root fail with zero side effects. Default: none (imports
   * are then rejected until the caller configures roots).
   */
  readonly mediaRoots?: readonly string[];
  /**
   * Absolute roots that project.open / project.save may read and write
   * checkpoint files under. The transport
   * canonicalizes them to realpath at startup; the facade treats them as
   * opaque containment roots exactly like mediaRoots. Default: none —
   * both persistence verbs then fail UNSUPPORTED.
   */
  readonly projectRoots?: readonly string[];
  /**
   * Absolute roots under which export.start's destinationPath may deliver a
   * verified artifact copy. The destination must resolve to a fresh .mp4
   * file directly inside `<deliveryRoot>/jobs/<slug>/output/` — the Agent
   * workspace deliverables directory (docs/AGENT-WORKSPACE.md). Default:
   * none — destinationPath then fails INVALID_PARAMS before any job runs.
   */
  readonly deliveryRoots?: readonly string[];
  /**
   * No facade verb consumes this adapter or derives a capability from it.
   */
  readonly renderAdapter?: ProjectRenderAdapter;
  /**
   * Absolute root every generated artifact (preview PNGs, exported videos)
   * is written under. Artifact-producing verbs fail UNSUPPORTED without it;
   * verify.artifact inspects files inside it — plus a delivered copy at its
   * deliveredTo location inside a delivery root's jobs/<slug>/output dir.
   */
  readonly artifactRoot?: string;
  /** Provider for preview.render_frame. */
  readonly renderProvider?: RenderProvider;
  /** Provider for export.start. */
  readonly exportProvider?: ExportProvider;
  /** Provider for verify.artifact. */
  readonly artifactVerifier?: ArtifactVerifier;
}

// The per-verb parameter declarations are the single maintained source;
// validation below and the emitted draft-2020-12
// JSON Schemas (jsonschema.ts) both derive from them.

/** Max media file size accepted for Chromium reads (2 GiB safety valve). */
const MAX_MEDIA_FILE_BYTES = 2 * 1024 * 1024 * 1024;

interface MutationOutcome<T> {
  readonly revision: number;
  readonly value: T;
  readonly replayed: boolean;
}

/** What the media.import apply callback produces (verb result minus envelope). */
type MediaImportPayload = Omit<MediaImportResult, "revision" | "replayed">;

/** What the edit.apply apply callback produces. */
interface EditApplyPayload {
  readonly applied: readonly OpApplied[];
}

export class AgentFacadeSession {
  private readonly config: AgentFacadeConfig;
  private project: Project | null = null;
  private revision = 0;
  private ledger = new IdempotencyLedger(() => this.project?.id ?? "no-project");
  private readonly jobs = new JobRegistry();
  private readonly changes = new ProjectChangeJournal();
  private readonly analysisControllers = new Map<string, AbortController>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(config: AgentFacadeConfig = {}) {
    this.config = config;
  }

  private capabilityContext() {
    return {

      mediaRoots: this.config.mediaRoots ?? [],
      deliveryRoots: this.config.deliveryRoots ?? [],
      ...(this.config.renderAdapter
        ? { renderAdapter: this.config.renderAdapter }
        : {}),
      ...(this.config.renderProvider
        ? { renderProvider: this.config.renderProvider }
        : {}),
      ...(this.config.exportProvider
        ? { exportProvider: this.config.exportProvider }
        : {}),
      ...(this.config.artifactVerifier
        ? { artifactVerifier: this.config.artifactVerifier }
        : {}),
      ...(this.config.artifactRoot !== undefined
        ? { artifactRoot: this.config.artifactRoot }
        : {}),
    };
  }

  /* ------------------------------ reads ------------------------------ */

  async sessionDescribe(): Promise<FacadeResult<SessionDescription>> {
    try {
      return ok(await buildSessionDescription(this.capabilityContext()));
    } catch (error) {
      return toFailure<SessionDescription>(error);
    }
  }

  /** Workspace persistence is owned by the desktop renderer, not headless sessions. */
  async workspaceCommand(
    verb: WorkspaceVerb,
    _params: Record<string, unknown> = {},
  ): Promise<FacadeResult<unknown>> {
    return toFailure(new FacadeError(
      "UNSUPPORTED",
      `${verb}: project/workspace storage is available only in the live desktop session`,
      { runtime: "node-headless" },
    ));
  }

  async capabilitiesGet(): Promise<FacadeResult<Capabilities>> {
    try {
      return ok(await buildCapabilities(this.capabilityContext()));
    } catch (error) {
      return toFailure<Capabilities>(error);
    }
  }

  async projectGetState(): Promise<FacadeResult<ProjectState>> {
    if (!this.project) return this.noProject();
    return ok(this.projectState());
  }

  async requirementsList(params: RequirementsListParams = {}): Promise<FacadeResult<RequirementsListResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<RequirementsListParams>(params, REQUIREMENTS_LIST_SCHEMA, "requirements.list params");
      if (!this.project) return this.noProject();
      return ok(requirementsListView(this.project.requirements?.items ?? [], this.revision, valid));
    });
  }

  async requirementsGet(params: RequirementsGetParams): Promise<FacadeResult<RequirementsGetResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<RequirementsGetParams>(params, REQUIREMENTS_GET_SCHEMA, "requirements.get params");
      if (!this.project) return this.noProject();
      return ok(requirementsGetView(this.project.requirements?.items ?? [], this.revision, valid));
    });
  }

  async timelineGet(): Promise<FacadeResult<TimelineState>> {
    if (!this.project) return this.noProject();
    return ok(timelineStateView(this.project, this.revision));
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
      if (!this.project) return this.noProject();
      if (valid.sinceRevision > this.revision) {
        throw new FacadeError(
          "CONFLICT",
          `project.changes: sinceRevision ${valid.sinceRevision} is newer than current revision ${this.revision}`,
          { currentRevision: this.revision },
        );
      }
      return ok(this.changes.query(valid, this.revision));
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
      if (!this.project) return this.noProject();
      return ok(queryTimeline(this.project, this.revision, valid));
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
      if (!this.project) return this.noProject();
      if (valid.expectedRevision !== undefined && valid.expectedRevision !== this.revision) {
        throw new FacadeError(
          "CONFLICT",
          `revision conflict: expected ${valid.expectedRevision}, current is ${this.revision}`,
          { currentRevision: this.revision },
        );
      }
      return ok(mapTimelineSourceTimes(this.project, this.revision, valid));
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
      if (!this.project) return this.noProject();
      const ops = await enrichMediaFileOps(
        validateEditOpList(valid.ops),
        this.config.mediaRoots ?? [],
        (absPath: string) => this.probeMediaForEnrichment(absPath),
        async (absPath: string) => {
          const fileStat = await stat(absPath);
          return { name: basename(absPath), size: fileStat.size, lastModified: Math.round(fileStat.mtimeMs) };
        },
        async () => this.project,
      );
      assertValidEditBatch("edit.validate", ops);
      return ok(
        await validateEditPlan(this.project, ops, {
          mode: "headless",
          revision: this.revision,
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
      validateObject<HistoryGetParams>(params, HISTORY_GET_SCHEMA, "history.get params");
      if (!this.project) return this.noProject();
      return ok({
        revision: this.revision,
        available: false,
        reason:
          "Headless sessions commit snapshot transactions and do not retain a canonical Core undo/redo stack; history.control is available only against the live GUI history.",
        canUndo: false,
        canRedo: false,
        undoCount: 0,
        redoCount: 0,
        entries: [],
      });
    });
  }

  async historyControl(
    params: HistoryControlParams,
  ): Promise<FacadeResult<HistoryControlResult>> {
    return this.enqueue(async () => {
      validateObject<HistoryControlParams>(
        params,
        HISTORY_CONTROL_SCHEMA,
        "history.control params",
      );
      if (!this.project) return this.noProject();
      throw new FacadeError(
        "UNSUPPORTED",
        "history.control: headless sessions have no canonical Core undo/redo stack; use revisioned checkpoints for recovery",
        { runtime: "node-headless" },
      );
    });
  }

  /**
   * editor.get_context — headless honesty: there is
   * no editor, so every context field is null/empty and contextAvailable is
   * false. Only the project revision and identity are real (read from the
   * session's own state); windowId is always null — never fabricated.
   */
  async editorGetContext(
    params: Record<string, never> = {},
  ): Promise<FacadeResult<EditorGetContextResult>> {
    return this.enqueue(async () => {
      validateObject(params, EMPTY_PARAMS_SCHEMA, "editor.get_context params");
      return ok<EditorGetContextResult>({
        mode: "headless",

        projectRevision: this.revision,
        contextAvailable: false,
        contextRevision: null,
        playheadSeconds: null,
        selectedClipIds: [],
        selectedTextIds: [],
        selectedMediaIds: [],
        timeRange: null,
        canvasPoint: null,
        references: {},
        requirements: { ready: 0, inProgress: 0, ids: [] },
        identity: {
          projectId: this.project?.id ?? null,
          projectName: this.project?.name ?? null,
          windowId: null,
        },
      });
    });
  }

  /**
   * Headless honesty: playback/selection/reveal are editor-only controls.
   * Validate the closed contract first, then report UNSUPPORTED without
   * inventing a playhead, selection or viewport.
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
      validateEditorControlTargets(valid.targets);
      validateEditorControlAction(valid);
      throw new FacadeError(
        "UNSUPPORTED",
        "editor.control: no live editor is attached to this headless session",
      );
    });
  }

  /* ---------------------------- mutations ---------------------------- */

  async projectCreate(
    params: ProjectCreateParams = {},
  ): Promise<FacadeResult<ProjectCreateResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<ProjectCreateParams>(
        params,
        PROJECT_CREATE_SCHEMA,
        "project.create params",
      );
      // The SANITIZED copy is what reaches the project — never the raw
      // nested caller object (each field is read exactly once, here).
      const settings =
        valid.settings !== undefined
          ? validateObject<Partial<ProjectSettings>>(
              valid.settings,
              PROJECT_SETTINGS_SCHEMA,
              "project.create params.settings",
            )
          : undefined;

      // project.create is a lifecycle verb OUTSIDE the revision machinery:
      // it takes no expectedRevision (there is no project to precondition
      // against), so replay/conflict resolution runs on the idempotency
      // ledger alone.
      const payload = { name: valid.name, settings };
      const prior = this.beginMutation<ProjectState>(
        "project.create",
        undefined,
        valid.idempotencyKey,
        payload,
      );
      if (prior) {
        // Exact replay (same key + same payload): hand back a fresh clone of
        // the committed creation snapshot. The live project is NOT reset.
        return ok<ProjectCreateResult>({
          revision: prior.revision,
          project: structuredClone(prior.value.project),
          counts: { ...prior.value.counts },
          replayed: true,
        });
      }
      if (this.project) {
        throw new FacadeError(
          "CONFLICT",
          "project.create: this session already has an open project; the facade has no replace/reset verb",
        );
      }

      this.project = createEmptyProject(valid.name, settings);
      this.revision = 0;
      this.changes.reset();
      const state = this.projectState();
      if (valid.idempotencyKey !== undefined) {
        // Recorded AFTER the swap so the entry is scoped to the NEW project
        // id (the ledger's projectScope reads this.project at call time).
        this.ledger.set("project.create", valid.idempotencyKey, {
          revision: state.revision,
          value: state,
          payloadHash: stableStringify(payload),
        });
      }
      return ok<ProjectCreateResult>({ ...state, replayed: false });
    });
  }

  /**
   * project.open — the lifecycle verb of Decision 10.4: adopts an
   * `openreel-project@2` checkpoint only after EVERY step validates
   * (containment → format → integrity → structure → media references);
   * any failure leaves the session empty and unchanged. The project is
   * adopted AT THE SAVED REVISION — the next committed mutation bumps
   * revision + 1, so revision arithmetic is continuous across the process
   * boundary. Create-style idempotent replay; the ledger after open is
   * empty (it was never saved) — agents mint fresh keys per session.
   */
  async projectOpen(
    params: ProjectOpenParams,
  ): Promise<FacadeResult<ProjectOpenResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<ProjectOpenParams>(
        params,
        PROJECT_OPEN_SCHEMA,
        "project.open params",
      );
      // Replay/conflict resolution runs BEFORE anything else, exactly as in
      // project.create: an exact retry must replay the committed open
      // snapshot without re-reading the file.
      const payload = { path: valid.path };
      const prior = this.beginMutation<ProjectState>(
        "project.open",
        undefined,
        valid.idempotencyKey,
        payload,
      );
      if (prior) {
        return ok<ProjectOpenResult>({
          revision: prior.revision,
          project: structuredClone(prior.value.project),
          counts: { ...prior.value.counts },
          replayed: true,
        });
      }
      if (this.project) {
        throw new FacadeError(
          "CONFLICT",
          "project.open: this session already has an open project — project.open is a single-initialization lifecycle verb and can never replace or reset it (a second project means a second session)",
        );
      }

      // Steps 1–5 of 10.4, in order; all validation happens BEFORE the
      // single-commit adoption below.
      const adopted = await this.validateCheckpointForOpen(valid.path);

      // Single-commit adoption inside the lane: from here nothing can fail.
      this.project = adopted.project;
      this.revision = adopted.revision;
      this.changes.reset();
      const state = this.projectState();
      if (valid.idempotencyKey !== undefined) {
        // Recorded AFTER the swap so the entry is scoped to the adopted
        // project id (the ledger's projectScope reads this.project).
        this.ledger.set("project.open", valid.idempotencyKey, {
          revision: state.revision,
          value: state,
          payloadHash: stableStringify(payload),
        });
      }
      return ok<ProjectOpenResult>({ ...state, replayed: false });
    });
  }

  async projectRename(
    params: ProjectRenameParams,
  ): Promise<FacadeResult<ProjectRenameResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<ProjectRenameParams>(
        params,
        PROJECT_RENAME_SCHEMA,
        "project.rename params",
      );
      if (!this.project) return this.noProject();
      const name = normalizeProjectName(valid.name);
      const payload = { name };
      const prior = this.beginMutation<Omit<ProjectRenameResult, "revision" | "replayed">>(
        "project.rename",
        valid.expectedRevision,
        valid.idempotencyKey,
        payload,
      );
      if (prior) {
        return ok<ProjectRenameResult>({
          ...prior.value,
          revision: prior.revision,
          replayed: true,
        });
      }

      const outcome = await this.commitMutation<
        Omit<ProjectRenameResult, "revision" | "replayed">
      >({
        verb: "project.rename",
        idempotencyKey: valid.idempotencyKey,
        payload,
        apply: async (draft) => {
          const previousName = draft.name;
          const executor = new ActionExecutor(new ActionHistory());
          const result = await executor.execute(
            {
              type: "project/rename",
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              params: { name },
            },
            draft,
          );
          if (!result.success) {
            throw new FacadeError(
              "ACTION_FAILED",
              `project.rename: ${result.error?.message ?? "core action failed"}`,
              { coreCode: result.error?.code },
            );
          }
          return { projectId: draft.id, previousName, name };
        },
      });
      return ok<ProjectRenameResult>({
        ...outcome.value,
        revision: outcome.revision,
        replayed: outcome.replayed,
      });
    });
  }

  /**
   * project.save — a snapshot, NOT a mutation (Decision 10.3): no revision
   * bump, no ledger entry, no idempotencyKey. Runs through the serialized
   * lane so a checkpoint can never capture a half-applied batch. Default
   * publication is race-atomic no-overwrite (hard-link publish, EEXIST ⇒
   * CONFLICT); overwrite:true renames over the target and still refuses
   * symlinks. Retry discipline: a save has no ledger, so an outcome-unknown
   * save must NOT be blindly retried at the same path — re-save to a fresh
   * versioned path instead.
   */
  async projectSave(
    params: ProjectSaveParams,
  ): Promise<FacadeResult<ProjectSaveResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<ProjectSaveParams>(
        params,
        PROJECT_SAVE_SCHEMA,
        "project.save params",
      );
      if (!this.project) {
        throw new FacadeError(
          "NOT_FOUND",
          "project.save: no project is open — call project.create or project.open first",
        );
      }
      // The optional expectedRevision is a pure guard, not a mutation.
      if (
        valid.expectedRevision !== undefined &&
        valid.expectedRevision !== this.revision
      ) {
        throw new FacadeError(
          "CONFLICT",
          `revision conflict: expected ${valid.expectedRevision}, current is ${this.revision}`,
          { currentRevision: this.revision },
        );
      }
      const roots = this.config.projectRoots ?? [];
      if (roots.length === 0) {
        throw new FacadeError(
          "UNSUPPORTED",
          "project.save: no project roots configured — the session was created without projectRoots",
        );
      }
      // Absoluteness is enforced by the facade itself (10.1): the guarantee
      // lives where the roots live, because the facade is a public library
      // consumed by bindings without this transport's boundary checks.
      if (!isAbsolute(valid.path)) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "project.save: checkpoint paths must be absolute — nothing is ever resolved against the process cwd",
          { path: valid.path },
        );
      }

      const document = buildCheckpointDocument(this.project, this.revision);
      const { bytesWritten } = await publishCheckpoint({
        path: valid.path,
        document,
        roots,
        overwrite: valid.overwrite ?? false,
      });
      return ok<ProjectSaveResult>({
        path: valid.path,
        revision: this.revision,
        bytesWritten,
        stateSha256: document.stateSha256,
        savedAt: document.savedAt,
      });
    });
  }

  /**
   * Steps 1–5 of 10.4 in order. Every failure throws BEFORE the session
   * adopts anything — the session stays empty and unchanged.
   */
  private async validateCheckpointForOpen(
    rawPath: string,
  ): Promise<{ project: Project; revision: number }> {
    const verb = "project.open";
    // Step 1 — containment: absolute; inside projectRoots (realpath);
    // regular readable file; ≤ 256 MiB (never buffer unbounded input).
    if (!isAbsolute(rawPath)) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: checkpoint paths must be absolute — nothing is ever resolved against the process cwd`,
        { path: rawPath },
      );
    }
    const roots = this.config.projectRoots ?? [];
    if (roots.length === 0) {
      throw new FacadeError(
        "UNSUPPORTED",
        `${verb}: no project roots configured — the session was created without projectRoots`,
      );
    }
    const resolution = resolveContainedPathDetailed(rawPath, roots);
    if (resolution.kind === "outside") {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: path escapes the configured project roots`,
        { path: rawPath, projectRoots: [...roots] },
      );
    }
    if (resolution.kind === "unresolvable") {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: path cannot be read (not found or unreadable)`,
        { path: rawPath },
      );
    }
    // A symlinked checkpoint FILE is followed and contained by realpath;
    // the resolved REAL path is what gets stat'ed and read.
    const resolvedPath = resolution.path;
    const fileStat = await stat(resolvedPath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: path is not a regular file`,
        { path: rawPath },
      );
    }
    if (fileStat.size > MAX_CHECKPOINT_BYTES) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: path cannot be read (checkpoint exceeds the 256 MiB read cap)`,
        { path: rawPath, bytes: fileStat.size, maxBytes: MAX_CHECKPOINT_BYTES },
      );
    }
    const text = await readFile(resolvedPath, "utf8").catch(() => {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: path cannot be read (not found or unreadable)`,
        { path: rawPath },
      );
    });

    // Step 2 — format: JSON parses; format + formatVersion in the supported
    // set; anything else ⇒ UNSUPPORTED naming found vs supported.
    const parsed = parseCheckpointText(text);
    // Step 3 — integrity: stateSha256 must recompute; mismatch is the
    // corrupted-or-hand-edited wording (distinct from structure wording).
    assertCheckpointIntegrity(parsed);
    // Step 4 — structure: closed-schema validation of every top-level
    // field + the headless-reachable project declaration + revision bounds.
    const validated = validateCheckpointStructure(parsed);

    // Step 5 — media references: exact 1:1 binding between mediaRefs and
    // project.mediaLibrary.items first (mediaIds, path === originalUrl,
    // sourceFile deep-equal), then every entry absolute + inside the
    // CURRENT mediaRoots + exists + readable + fingerprint match. Every
    // offending mediaId is listed in details.
    const items = validated.project.mediaLibrary.items;
    const bindingOffenders = findMediaBindingOffenders(validated.mediaRefs, items);
    if (bindingOffenders.length > 0) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: mediaRefs do not match project.mediaLibrary.items — every media id must appear exactly once with path == originalUrl and an equal sourceFile`,
        { mediaIds: bindingOffenders },
      );
    }
    if (validated.mediaRefs.length > 0) {
      const mediaRoots = this.config.mediaRoots ?? [];
      const offenders: string[] = [];
      for (const ref of validated.mediaRefs) {
        if (!isAbsolute(ref.path)) {
          offenders.push(ref.mediaId);
          continue;
        }
        const mediaResolution = resolveContainedPathDetailed(ref.path, mediaRoots);
        if (mediaResolution.kind !== "ok") {
          offenders.push(ref.mediaId);
          continue;
        }
        const mediaStat = await stat(mediaResolution.path).catch(() => null);
        if (!mediaStat || !mediaStat.isFile()) {
          offenders.push(ref.mediaId);
          continue;
        }
        if (
          mediaStat.size !== ref.sourceFile.size ||
          Math.round(mediaStat.mtimeMs) !== ref.sourceFile.lastModified
        ) {
          offenders.push(ref.mediaId);
        }
      }
      if (offenders.length > 0) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `${verb}: ${offenders.length} referenced media item(s) are missing, moved, or changed relative to the checkpoint — no relink, no fuzzy matching`,
          { mediaIds: offenders, mediaRoots: [...mediaRoots] },
        );
      }
    }

    return { project: validated.project, revision: validated.revision };
  }

  async mediaImport(
    params: MediaImportParams,
  ): Promise<FacadeResult<MediaImportResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<MediaImportParams>(
        params,
        MEDIA_IMPORT_SCHEMA,
        "media.import params",
      );
      if (!this.project) return this.noProject();

      // Idempotent replays and revision conflicts resolve BEFORE any
      // filesystem validation: a retry must replay the committed result even
      // if the source file has since moved or been deleted. The pinned
      // payload is the mutation-defining part (path + name), never the
      // transport-level expectedRevision.
      const prior = this.beginMutation<MediaImportPayload>(
        "media.import",
        valid.expectedRevision,
        valid.idempotencyKey,
        { path: valid.path, name: valid.name },
      );
      if (prior) {
        return ok<MediaImportResult>({
          ...prior.value,
          revision: prior.revision,
          replayed: true,
        });
      }

      const roots = this.config.mediaRoots ?? [];
      if (hasUrlScheme(valid.path)) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `media.import: URLs are not accepted in this runtime — pass a local file path inside a configured media root`,
          { path: valid.path },
        );
      }
      if (roots.length === 0) {
        throw new FacadeError(
          "UNSUPPORTED",
          "media.import: no media roots configured — the session was created without mediaRoots",
        );
      }
      const resolution = resolveContainedPathDetailed(valid.path, roots);
      if (resolution.kind === "outside") {
        throw new FacadeError(
          "INVALID_PARAMS",
          `media.import: path escapes the configured media roots`,
          { path: valid.path, mediaRoots: [...roots] },
        );
      }
      if (resolution.kind === "unresolvable") {
        throw new FacadeError(
          "INVALID_PARAMS",
          `media.import: path cannot be read (not found or unreadable)`,
          { path: valid.path },
        );
      }
      const resolved = resolution.path;

      const probed = await this.probeMedia(resolved);
      const fileStat = await stat(resolved);
      const name = valid.name ?? basename(resolved);

      const outcome = await this.commitMutation<MediaImportPayload>({
        verb: "media.import",
        idempotencyKey: valid.idempotencyKey,
        payload: { path: valid.path, name: valid.name },
        apply: (draft) => {
          const item: MediaItem = {
            id: `media-${crypto.randomUUID()}`,
            name,
            type: probed.type,
            fileHandle: null,
            blob: null,
            metadata: {
              duration: probed.durationSec,
              width: probed.width,
              height: probed.height,
              frameRate: probed.frameRate,
              codec: probed.codec,
              sampleRate: 0,
              channels: 0,
              fileSize: probed.fileSize,
            },
            thumbnailUrl: null,
            waveformData: null,
            originalUrl: resolved,
            sourceFile: {
              name: basename(resolved),
              size: probed.fileSize,
              lastModified: Math.round(fileStat.mtimeMs),
            },
          };
          (draft.mediaLibrary as { items: MediaItem[] }).items = [
            ...draft.mediaLibrary.items,
            item,
          ];
          return {
            mediaId: item.id,
            name: item.name,
            type: probed.type,
            metadata: {
              durationSec: probed.durationSec,
              width: probed.width,
              height: probed.height,
              frameRate: probed.frameRate,
              codec: probed.codec,
              fileSize: probed.fileSize,
            },
          };
        },
      });
      return ok<MediaImportResult>({
        revision: outcome.revision,
        mediaId: outcome.value.mediaId,
        name: outcome.value.name,
        type: outcome.value.type,
        metadata: outcome.value.metadata,
        replayed: outcome.replayed,
      });
    });
  }

  /**
   * media.render_html — constrained HTML/CSS → PNG under the media roots.
   * The verb WRITES A FILE, so it sits behind the mutation gates
   * and the idempotency ledger, but it never touches project state and does
   * not bump the revision: the published path is meant to flow straight
   * into media.import. All containment/publish/inspection discipline lives
   * in the shared produceHtmlRenderArtifact core (identical in live mode).
   */
  async mediaRenderHtml(
    params: MediaRenderHtmlParams,
  ): Promise<FacadeResult<MediaRenderHtmlResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<MediaRenderHtmlParams>(
        params,
        MEDIA_RENDER_HTML_SCHEMA,
        "media.render_html params",
      );
      const provider = this.config.renderProvider;
      if (!provider || typeof provider.renderHtmlPng !== "function") {
        throw new FacadeError(
          "UNSUPPORTED",
          "media.render_html: no render provider with HTML rendering is configured for this session",
          {
            requires:
              "a RenderProvider exposing renderHtmlPng (e.g. @reelterminal/runtime-chromium with the local playwright Chromium)",
          },
        );
      }
      const roots = this.config.mediaRoots ?? [];
      if (roots.length === 0) {
        throw new FacadeError(
          "UNSUPPORTED",
          "media.render_html: no media roots configured — the session was created without mediaRoots",
        );
      }
      await requireProviderPreflight(provider, "media.render_html");

      // Idempotent replays resolve BEFORE filesystem work (media.import
      // convention); the payload is the mutation-defining part.
      const payload = {
        source: valid.source,
        assetsRoot: valid.assetsRoot,
        width: valid.width,
        height: valid.height,
        transparent: valid.transparent ?? true,
        timeoutMs: valid.timeoutMs,
        outputDir: valid.outputDir,
      };
      const prior = this.beginMutation<MediaRenderHtmlResult>(
        "media.render_html",
        valid.expectedRevision,
        valid.idempotencyKey,
        payload,
      );
      if (prior) {
        // Replay only while the artifact file still exists (same honesty as
        // preview.render_frame): a deleted file falls through to an honest
        // re-render of the same content-addressed path.
        const stillThere = await stat(prior.value.path).then(
          (s) => s.isFile(),
          () => false,
        );
        if (stillThere) {
          return ok<MediaRenderHtmlResult>({ ...prior.value, replayed: true });
        }
      }

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
          revision: this.revision,
          value,
          payloadHash: stableStringify(payload),
        });
      }
      return ok(value);
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
      if (!this.project) return this.noProject();
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
      const audioBackedTypes = valid.analysisTypes.filter(
        (type) => type === "audioSummary" || type === "silence" || type === "beatGrid",
      );
      if (audioBackedTypes.length > 0) {
        const ready = await audioAnalysisPreflight();
        if (!ready.available) throw new FacadeError("UNSUPPORTED", ready.reason!);
      }
      const videoCandidateTypes = valid.analysisTypes.filter(
        (type) => type === "sceneCuts" || type === "blackFrames" || type === "duplicateFrames",
      );
      if (videoCandidateTypes.length > 0) {
        const ready = await videoCandidatesPreflight();
        if (!ready.available) throw new FacadeError("UNSUPPORTED", ready.reason!);
      }
      const unavailable = valid.analysisTypes.filter(
        (type) => type !== "technicalQuality" && type !== "audioSummary" && type !== "videoReview" && type !== "silence" && type !== "beatGrid" &&
          type !== "sceneCuts" && type !== "blackFrames" && type !== "duplicateFrames",
      );
      if (unavailable.length > 0) {
        throw new FacadeError(
          "UNSUPPORTED",
          `media.analyze_start: unavailable analysis types: ${unavailable.join(", ")}`,
          {
            unavailableTypes: unavailable,
            availableTypes: ["technicalQuality", "audioSummary", "silence", "beatGrid", "sceneCuts", "blackFrames", "duplicateFrames"],
          },
        );
      }
      const media = this.project.mediaLibrary.items.find(
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
          (audioBackedTypes.length > 0 && endSec - startSec > AUDIO_LIMITS.maxRangeSec)) {
        throw new FacadeError("INVALID_PARAMS", "Analysis requires 0 ≤ startSec < endSec ≤ source duration; audioSummary, silence and beatGrid ranges are at most 120 seconds. Split longer sources into explicit ranges.");
      }
      const payload = {
        mediaId: valid.mediaId,
        analysisTypes: [...valid.analysisTypes].sort(),
        startSec: valid.startSec, endSec: valid.endSec, cloudUpload: valid.cloudUpload, reviewQuestion: valid.reviewQuestion,
        silenceParams,
      };
      const prior = this.beginMutation<{
        jobId: string;
        sourceRevision: number;
        analysisTypes: readonly typeof valid.analysisTypes[number][];
      }>(
        "media.analyze_start",
        valid.expectedRevision,
        valid.idempotencyKey,
        payload,
      );
      if (prior && this.jobs.has(prior.value.jobId)) {
        return ok<MediaAnalyzeStartResult>({
          jobId: prior.value.jobId,
          kind: "analysis",
          state: this.jobs.get(prior.value.jobId)?.state ?? "queued",
          sourceRevision: prior.value.sourceRevision,
          analysisTypes: prior.value.analysisTypes,
          replayed: true,
        });
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
          `media.analyze_start: media "${valid.mediaId}" is not backed by a readable source file`,
        );
      }
      if (valid.analysisTypes.includes("videoReview")) {
        const ready = await videoReviewPreflight();
        if (!ready.available) throw new FacadeError("UNSUPPORTED", ready.reason!);
      }
      if (this.analysisControllers.size >= AUDIO_LIMITS.maxConcurrentPerSession) throw new FacadeError("UNSUPPORTED", "At most two analysis jobs per session; wait or cancel an existing job.");
      const sourcePath = resolution.path;
      const sourceRevision = this.revision;
      const projectId = this.project.id;
      const jobId = `job-${crypto.randomUUID()}`;
      const analysisTypes = [...valid.analysisTypes];
      this.jobs.create(jobId, sourceRevision, "analysis");
      const controller = new AbortController();
      this.analysisControllers.set(jobId, controller);
      const ledgerValue = { jobId, sourceRevision, analysisTypes };
      if (valid.idempotencyKey !== undefined) {
        this.ledger.set("media.analyze_start", valid.idempotencyKey, {
          revision: sourceRevision,
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
        projectId,
        sourceRevision,
        valid.reviewQuestion,
        valid.recheckOfRecordId,
        silenceParams,
      );
      return ok<MediaAnalyzeStartResult>({
        ...ledgerValue,
        kind: "analysis",
        state: "queued",
        replayed: false,
      });
    });
  }

  async editApply(
    params: EditApplyParams,
  ): Promise<FacadeResult<EditApplyResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<EditApplyParams>(
        params,
        EDIT_APPLY_SCHEMA,
        "edit.apply params",
      );
      if (!this.project) return this.noProject();
      // The context CAS exists only where an editor
      // context exists. Headless has none — reject honestly rather than
      // silently ignoring a guard the agent believes protects it.
      if (valid.expectedContextRevision !== undefined) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "edit.apply: context revision unavailable in headless mode — expectedContextRevision requires a live session with an editor context",
        );
      }

      // Pre-validate EVERY op's closed schema before any execution or state
      // access — a malformed op anywhere fails the whole call with zero
      // side effects, and can never become an ok:true silent no-op.
      const ops = parseEditOps("edit.apply", valid.ops);

      const prior = this.beginMutation<EditApplyPayload>(
        "edit.apply",
        valid.expectedRevision,
        valid.idempotencyKey,
        { ops },
      );
      if (prior) {
        return ok<EditApplyResult>({
          ...prior.value,
          revision: prior.revision,
          replayed: true,
        });
      }

      const enrichedOps = await enrichMediaFileOps(
        ops,
        this.config.mediaRoots ?? [],
        (absPath: string) => this.probeMediaForEnrichment(absPath),
        async (absPath: string) => {
          const fileStat = await stat(absPath);
          return { name: basename(absPath), size: fileStat.size, lastModified: Math.round(fileStat.mtimeMs) };
        },
        async () => this.project,
      );

      const outcome = await this.commitMutation<EditApplyPayload>({
        verb: "edit.apply",
        idempotencyKey: valid.idempotencyKey,
        payload: { ops },
        apply: async (draft) => {
          // One executor + history per batch: the facade never reuses core
          // undo machinery, and a discarded draft leaves no history behind.
          const executor = new ActionExecutor(new ActionHistory());
          const applied: OpApplied[] = [];
          for (const [index, op] of enrichedOps.entries()) {
            const beforeIds = collectEntityIds(draft);
            const actions = opToCoreActions(op, draft);
            for (const action of actions) {
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
            const created = diffCreatedIds(beforeIds, collectEntityIds(draft));
            applyClipIdOverride(op, draft, created);
            applied.push({
              op: op.op,
              createdIds:
                op.op === "clip.add" && op.clipId !== undefined && created.length > 0
                  ? [op.clipId]
                  : created,
            });
          }
          return { applied };
        },
      });
      return ok<EditApplyResult>({
        revision: outcome.revision,
        applied: outcome.value.applied,
        replayed: outcome.replayed,
      });
    });
  }

  /* --------------------- Preview and export --------------------------- */

  /**
   * preview.render_frame — rasterize ONE real PNG frame through the
   * configured RenderProvider. Reads the canonical project at the current
   * revision (no mutation, no revision increment), writes the PNG under
   * artifactRoot and returns the hashed artifact ref.
   */
  async previewRenderFrame(
    params: PreviewRenderFrameParams,
  ): Promise<FacadeResult<PreviewRenderFrameResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<PreviewRenderFrameParams>(
        params,
        PREVIEW_RENDER_FRAME_SCHEMA,
        "preview.render_frame params",
      );
      if (!this.project) return this.noProject();
      const provider = this.config.renderProvider;
      if (!provider) {
        throw new FacadeError(
          "UNSUPPORTED",
          "preview.render_frame: no render provider configured for this session",
          { requires: "RenderProvider (e.g. @reelterminal/runtime-chromium)" },
        );
      }
      const artifactRoot = requireArtifactRoot(this.config.artifactRoot, "preview.render_frame");
      await requireProviderPreflight(provider, "preview.render_frame");

      const project = this.project;
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
      const prior = this.beginMutation<PreviewRenderFrameResult>(
        "preview.render_frame",
        valid.expectedRevision,
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
          return ok<PreviewRenderFrameResult>({
            ...prior.value,
            revision: this.revision,
            replayed: true,
          });
        }
      }

      const mediaFiles = await this.buildMediaFiles(project, "preview.render_frame");
      const sourceRevision = this.revision;
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
      // Containment BEFORE the provider writes: a symlinked/junctioned
      // renders dir (or a linked ancestor) must fail the verb with zero
      // bytes written outside artifactRoot.
      await prepareArtifactDir(rendersDir, artifactRoot, "preview.render_frame");
      const timeMs = Math.round(valid.timeSec * 1000);
      const stem = `frame-${project.id}-r${sourceRevision}-${requestKey}-t${timeMs}-${width}x${height}`;
      const tempPath = pendingArtifactPath(rendersDir, stem, "png");
      const finalPath = resolvePath(rendersDir, `${stem}.png`);

      const rendered = await provider.renderFramePng({
        project: structuredClone(project),
        sourceRevision,
        timeSec,
        width,
        height,
        destPath: tempPath,
        mediaFiles,
      });
      // Containment AFTER the write: a provider that swapped the output dir
      // for a link mid-render (or wrote through one) is caught here, before
      // the artifact is hashed and published. The VERIFIED real path is
      // what gets hashed — no swap window between check and hash.
      const verifiedTemp = await assertContainedWrittenFile(tempPath, artifactRoot, "preview.render_frame");
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

  /**
   * preview.render_comparison — one reference-comparison inspection still at
   * a timeline time: left the decoded reference frame at the MAPPED time,
   * right the canonical timeline render; letterboxed, never cropped; or a
   * blended overlay. Mapping, clamping and limitations are disclosed.
   */
  async previewRenderComparison(
    params: PreviewRenderComparisonParams,
  ): Promise<FacadeResult<PreviewRenderComparisonResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<PreviewRenderComparisonParams>(
        params,
        PREVIEW_RENDER_COMPARISON_SCHEMA,
        "preview.render_comparison params",
      );
      if (!this.project) return this.noProject();
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

      const project = this.project;
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
      const prior = this.beginMutation<PreviewRenderComparisonResult>(
        "preview.render_comparison",
        valid.expectedRevision,
        valid.idempotencyKey,
        payload,
      );
      if (prior) {
        const stillThere = await stat(prior.value.artifact.path).then((s) => s.isFile(), () => false);
        if (stillThere) {
          return ok<PreviewRenderComparisonResult>({
            ...prior.value,
            revision: this.revision,
            replayed: true,
          });
        }
      }

      const sourceRevision = this.revision;
      const mediaFiles = await withComparisonReference(
        project,
        config,
        await this.buildMediaFiles(project, "preview.render_comparison"),
        (item) => this.resolveMediaItemFile(item),
      );
      const referencePath = referenceFilePath(project, config, mediaFiles, "preview.render_comparison");

      // Timeline side: the canonical renderer, rendered to a private temp
      // inside artifactRoot (never published as its own artifact).
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
          revision: this.revision,
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

  /**
   * visual.inspect — read-only visual context for an explicit clip or time
   * range. Every frame is rendered by the same provider as preview frames;
   * the optional provider-native contact sheet is an additional real PNG.
   * When that composition is unavailable, the individual verified PNGs are
   * returned with a limitation rather than a fabricated sheet.
   */
  async visualInspect(
    params: VisualInspectParams,
  ): Promise<FacadeResult<VisualInspectResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<VisualInspectParams>(
        params,
        VISUAL_INSPECT_SCHEMA,
        "visual.inspect params",
      );
      validateVisualInspectTimeRange(valid);
      if (!this.project) return this.noProject();
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

      const project = this.project;
      const { plan, width, height, sampleCount } = prepareVisualInspectRenderPlan(project, valid);

      const payload = {
        ...(valid.clipId !== undefined ? { clipId: valid.clipId } : {}),
        ...(valid.timeRange !== undefined ? { timeRange: valid.timeRange } : {}),
        sampleCount,
        width,
        height,
        maxFrameBytes: valid.maxFrameBytes ?? DEFAULT_FRAME_BUDGET_BYTES,
      };
      const prior = this.beginMutation<VisualInspectResult>(
        "visual.inspect",
        valid.expectedRevision,
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
            revision: this.revision,
            replayed: true,
          });
        }
      }

      const sourceRevision = this.revision;
      const mediaFiles = await this.buildMediaFiles(project, "visual.inspect");
      const frameBudgetBytes = valid.maxFrameBytes ?? DEFAULT_FRAME_BUDGET_BYTES;
      // Immutable evidence: every artifact name embeds a hash of the full
      // normalized request (selector, sampling plan, raster, budget, revision
      // and source media fingerprints), so a different inspection — or the
      // same inspection after a media file changed without a revision bump —
      // publishes to a fresh path instead of overwriting returned evidence.
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
        // Publish only after validation: create-if-absent is atomic and a
        // failed attempt never deletes an already-published artifact.
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
          // Containment failures are security failures, not optional-feature
          // failures. Provider/runtime errors can fall back to real frames.
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
   * export.start — snapshot the project NOW and hand the snapshot to the
   * ExportProvider as a background job. Returns the jobId immediately; the
   * project stays editable (the job renders the frozen snapshot). Same
   * idempotencyKey + same payload replays the same jobId.
   */
  async exportStart(
    params: ExportStartParams,
  ): Promise<FacadeResult<ExportStartResult>> {
    return this.enqueue(async () => {
      const valid = validateObject<ExportStartParams>(
        params,
        EXPORT_START_SCHEMA,
        "export.start params",
      );
      if (!this.project) return this.noProject();
      const provider = this.config.exportProvider;
      if (!provider) {
        throw new FacadeError(
          "UNSUPPORTED",
          "export.start: no export provider configured for this session",
          { requires: "ExportProvider (e.g. @reelterminal/runtime-chromium)" },
        );
      }
      const artifactRoot = requireArtifactRoot(this.config.artifactRoot, "export.start");
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
      const prior = this.beginMutation<{ jobId: string; sourceRevision: number }>(
        "export.start",
        valid.expectedRevision,
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
      // destination fails fast with zero side effects (no job, no ledger
      // entry, no provider work).
      const delivery =
        valid.destinationPath !== undefined
          ? await resolveDeliveryDestination(
              valid.destinationPath,
              this.config.deliveryRoots ?? [],
              "export.start",
            )
          : null;


      const project = this.project;
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
      // synchronously, inside the serialized lane. Later edits can proceed;
      // they never reach this job.
      const snapshot = structuredClone(project);
      const sourceRevision = this.revision;
      const mediaFiles = await this.buildMediaFiles(project, "export.start");
      if (comparisonConfig) {
        Object.assign(
          mediaFiles,
          await withComparisonReference(project, comparisonConfig, mediaFiles, (item) =>
            this.resolveMediaItemFile(item),
          ),
        );
      }

      const jobId = `job-${crypto.randomUUID()}`;
      const exportsDir = resolvePath(artifactRoot, "exports");
      // Containment BEFORE anything is created inside: a symlinked/junctioned
      // exports dir must fail here — mkdir'ing the job dir through a link
      // would already create a directory outside artifactRoot.
      await prepareArtifactDir(exportsDir, artifactRoot, "export.start");
      const jobDir = resolvePath(exportsDir, jobId);
      await prepareArtifactDir(jobDir, artifactRoot, "export.start");
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
                  // The timeline leg rendered once by the canonical pipeline
                  // carries the upscale outcome; the composed publish keeps
                  // that disclosure instead of dropping it.
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
      // throwing provider still lands in a terminal error state, never in a
      // silent limbo.
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

  /** analysis.get — one full record with provenance and staleness. */
  async analysisGet(params: AnalysisGetParams): Promise<FacadeResult<unknown>> {
    return this.enqueue(async () => {
      const valid = validateObject<AnalysisGetParams>(params, ANALYSIS_GET_SCHEMA, "analysis.get params");
      const artifactRoot = requireArtifactRoot(this.config.artifactRoot, "analysis.get");
      return ok(await loadAnalysisRecord(artifactRoot, valid.recordId));
    });
  }

  /** job.status — poll the facade-owned job registry. */
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

  /**
   * job.cancel — cooperative cancellation. Terminal jobs answer with their
   * current state (idempotent no-op); live jobs get cancelRequested and the
   * provider is told to abort. The job always settles to a terminal state
   * afterwards; poll job.status to observe it.
   */
  async jobCancel(params: JobParams): Promise<FacadeResult<JobStatusView>> {
    return this.enqueue(async () => {
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
        // The cancel path must never wedge the session's serialized lane:
        // a provider that stops answering yields a bounded wait; the cancel
        // request stays registered and the job still settles via callbacks.
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
   * verify.artifact — read-only inspection (ffprobe-style probe + optional
   * pixel comparison) of a file inside artifactRoot, or of a delivered copy
   * at its exact deliveredTo location (`<deliveryRoot>/jobs/<slug>/output/`
   * — the same containment rule export.start enforces for destinationPath).
   * A failed assertion is reported as data (checks[], pass:false), never as
   * a thrown domain error; only infrastructure problems fail the call.
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

      const artifactRoot = requireArtifactRoot(this.config.artifactRoot, "verify.artifact");
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
        // Headless contract: the reference may live in artifactRoot OR any
        // configured mediaRoot (empty array keeps that contract when no
        // mediaRoots are configured).
        const referencePath = resolveVerifyReferencePath(
          parsed.compare.referencePath,
          artifactRoot,
          this.config.mediaRoots ?? [],
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

  /* ----------------- material.* (headless: UNSUPPORTED) --------------- */

  /**
   * The user-level material library lives in the desktop GUI renderer's
   * IndexedDB (cross-project, human-visible). Headless sessions have no GUI
   * renderer, so every material.* verb answers honestly UNSUPPORTED — the
   * same policy as the canonical-history verbs.
   */
  private materialUnsupported(verb: FacadeVerb): never {
    throw new FacadeError(
      "UNSUPPORTED",
      `${verb}: the user-level material library is available only in live desktop sessions (it lives in the GUI renderer's persistent storage, not the headless project checkpoint)`,
      { runtime: "node-headless" },
    );
  }

  async materialList(
    params?: MaterialListParams,
  ): Promise<FacadeResult<MaterialListResult>> {
    return this.enqueue(async () => {
      validateObject<MaterialListParams>(params ?? {}, MATERIAL_LIST_SCHEMA, "material.list params");
      this.materialUnsupported("material.list");
    });
  }

  async materialGet(
    params: MaterialGetParams,
  ): Promise<FacadeResult<MaterialGetResult>> {
    return this.enqueue(async () => {
      validateObject<MaterialGetParams>(params, MATERIAL_GET_SCHEMA, "material.get params");
      this.materialUnsupported("material.get");
    });
  }

  async materialCreate(
    params: MaterialCreateParams,
  ): Promise<FacadeResult<MaterialCreateResult>> {
    return this.enqueue(async () => {
      validateObject<MaterialCreateParams>(params, MATERIAL_CREATE_SCHEMA, "material.create params");
      this.materialUnsupported("material.create");
    });
  }

  async materialUpdate(
    params: MaterialUpdateParams,
  ): Promise<FacadeResult<MaterialUpdateResult>> {
    return this.enqueue(async () => {
      validateObject<MaterialUpdateParams>(params, MATERIAL_UPDATE_SCHEMA, "material.update params");
      this.materialUnsupported("material.update");
    });
  }

  async materialBatchUpdate(
    params: MaterialBatchUpdateParams,
  ): Promise<FacadeResult<MaterialBatchUpdateResult>> {
    return this.enqueue(async () => {
      validateObject<MaterialBatchUpdateParams>(params, MATERIAL_BATCH_UPDATE_SCHEMA, "material.batch_update params");
      this.materialUnsupported("material.batch_update");
    });
  }

  async materialRemove(
    params: MaterialRemoveParams,
  ): Promise<FacadeResult<MaterialRemoveResult>> {
    return this.enqueue(async () => {
      validateObject<MaterialRemoveParams>(params, MATERIAL_REMOVE_SCHEMA, "material.remove params");
      this.materialUnsupported("material.remove");
    });
  }

  async materialAttach(
    params: MaterialAttachParams,
  ): Promise<FacadeResult<MaterialAttachResult>> {
    return this.enqueue(async () => {
      validateObject<MaterialAttachParams>(params, MATERIAL_ATTACH_SCHEMA, "material.attach params");
      this.materialUnsupported("material.attach");
    });
  }

  async materialUndo(
    params?: MaterialUndoParams,
  ): Promise<FacadeResult<MaterialUndoResult>> {
    return this.enqueue(async () => {
      validateObject<MaterialUndoParams>(params ?? {}, MATERIAL_UNDO_SCHEMA, "material.undo params");
      this.materialUnsupported("material.undo");
    });
  }

  /* ------------------ font.* (headless: UNSUPPORTED) ------------------- */

  /**
   * Custom fonts live in the desktop GUI renderer's font store (IndexedDB +
   * FontFace activation) — the same store the GUI upload button writes.
   * Headless sessions have no GUI renderer, so font.* answers honestly
   * UNSUPPORTED after validating params (same policy as material.*).
   */
  async fontUpload(
    params: import("./font-library").FontUploadParams,
  ): Promise<FacadeResult<import("./font-library").FontUploadResult>> {
    return this.enqueue(async () => {
      validateObject<import("./font-library").FontUploadParams>(
        params,
        FONT_UPLOAD_SCHEMA,
        "font.upload params",
      );
      throw new FacadeError(
        "UNSUPPORTED",
        "font.upload: custom fonts are available only in live desktop sessions (they are installed in the GUI renderer's persistent font store, not the headless project checkpoint)",
        { runtime: "node-headless" },
      );
    });
  }

  async fontList(
    params?: import("./font-library").FontListParams,
  ): Promise<FacadeResult<import("./font-library").FontListResult>> {
    return this.enqueue(async () => {
      validateObject<import("./font-library").FontListParams>(
        params ?? {},
        EMPTY_PARAMS_SCHEMA,
        "font.list params",
      );
      throw new FacadeError(
        "UNSUPPORTED",
        "font.list: custom fonts are available only in live desktop sessions (they are installed in the GUI renderer's persistent font store, not the headless project checkpoint)",
        { runtime: "node-headless" },
      );
    });
  }

  /* ---------------- preset.* (headless: UNSUPPORTED) ------------------- */

  /**
   * User-level custom presets live in the desktop GUI renderer's IndexedDB
   * (cross-project, human-visible in the preset panels). Headless sessions
   * have no GUI renderer, so every preset verb answers honestly UNSUPPORTED
   * after validating params — the same policy as material and font verbs.
   */
  private presetUnsupported(verb: FacadeVerb): never {
    throw new FacadeError(
      "UNSUPPORTED",
      `${verb}: user-level custom presets are available only in live desktop sessions (they live in the GUI renderer's persistent store, not the headless project checkpoint)`,
      { runtime: "node-headless" },
    );
  }

  async presetList(
    params?: import("./preset-verbs").PresetListParams,
  ): Promise<FacadeResult<import("./preset-verbs").PresetListResult>> {
    return this.enqueue(async () => {
      validateObject<import("./preset-verbs").PresetListParams>(
        params ?? {},
        PRESET_LIST_SCHEMA,
        "preset.list params",
      );
      this.presetUnsupported("preset.list");
    });
  }

  async presetGet(
    params: import("./preset-verbs").PresetGetParams,
  ): Promise<FacadeResult<import("./preset-verbs").PresetGetResult>> {
    return this.enqueue(async () => {
      validateObject<import("./preset-verbs").PresetGetParams>(
        params,
        PRESET_GET_SCHEMA,
        "preset.get params",
      );
      this.presetUnsupported("preset.get");
    });
  }

  async presetCreate(
    params: import("./preset-verbs").PresetCreateParams,
  ): Promise<FacadeResult<import("./preset-verbs").PresetCreateResult>> {
    return this.enqueue(async () => {
      validateObject<import("./preset-verbs").PresetCreateParams>(
        params,
        PRESET_CREATE_SCHEMA,
        "preset.create params",
      );
      this.presetUnsupported("preset.create");
    });
  }

  async presetUpdate(
    params: import("./preset-verbs").PresetUpdateParams,
  ): Promise<FacadeResult<import("./preset-verbs").PresetUpdateResult>> {
    return this.enqueue(async () => {
      validateObject<import("./preset-verbs").PresetUpdateParams>(
        params,
        PRESET_UPDATE_SCHEMA,
        "preset.update params",
      );
      this.presetUnsupported("preset.update");
    });
  }

  async presetRemove(
    params: import("./preset-verbs").PresetRemoveParams,
  ): Promise<FacadeResult<import("./preset-verbs").PresetRemoveResult>> {
    return this.enqueue(async () => {
      validateObject<import("./preset-verbs").PresetRemoveParams>(
        params,
        PRESET_REMOVE_SCHEMA,
        "preset.remove params",
      );
      this.presetUnsupported("preset.remove");
    });
  }

  async presetApply(
    params: import("./preset-verbs").PresetApplyParams,
  ): Promise<FacadeResult<import("./preset-verbs").PresetApplyResult>> {
    return this.enqueue(async () => {
      validateObject<import("./preset-verbs").PresetApplyParams>(
        params,
        PRESET_APPLY_SCHEMA,
        "preset.apply params",
      );
      this.presetUnsupported("preset.apply");
    });
  }

  /* ------------------- help.* (static manual, all modes) ------------------ */

  /**
   * The GUI manual is shipped static data in this package, so the help
   * verbs answer in EVERY mode (headless included) and need neither a
   * project, a provider, nor a renderer bridge.
   */
  async helpListScreens(
    params?: Record<string, never>,
  ): Promise<FacadeResult<import("./gui-manual").ManualListScreensResult>> {
    return this.enqueue(async () => {
      validateObject<Record<string, never>>(
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

  /* ---------------------------- internals ---------------------------- */

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
  ): Promise<void> {
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (controller.signal.aborted) {
        this.jobs.markCancelled(jobId);
        return;
      }
      this.jobs.markRunning(jobId);
      const [probe, file, color] = await Promise.all([
        this.probeMedia(sourcePath),
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
      const otherAudioRequested = analysisTypes.includes("silence") || analysisTypes.includes("beatGrid");
      const audio = analysisTypes.includes("audioSummary")
        ? await analyzeLocalAudio(sourcePath, range, controller.signal, (percent) => this.jobs.markProgress(jobId, { phase: "rendering", percent: video ? .8 + percent * .15 : otherAudioRequested ? percent * .5 : percent })) : undefined;
      const silence = analysisTypes.includes("silence")
        ? await analyzeSilence(sourcePath, range, silenceParams, controller.signal, (percent) => this.jobs.markProgress(jobId, { phase: "rendering", percent: video ? .95 + percent * .025 : otherAudioRequested || analysisTypes.includes("audioSummary") ? .5 + percent * .25 : percent })) : undefined;
      const beatGrid = analysisTypes.includes("beatGrid")
        ? await analyzeBeatGrid(sourcePath, range, controller.signal, (percent) => this.jobs.markProgress(jobId, { phase: "rendering", percent: video ? .975 + percent * .025 : analysisTypes.includes("audioSummary") || analysisTypes.includes("silence") ? .75 + percent * .25 : percent })) : undefined;
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
      // Frame-exact technical facts: reuse the candidate run's probe, or
      // probe best-effort for technicalQuality alone. Absence is reported,
      // never guessed.
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
      const sourceFingerprint = { size: file.size, lastModified: Math.round(file.mtimeMs) };
      const summary = {
        ...(video ? { videoReview: { ...video, mediaId, sourceFingerprint } } : {}),
        ...(audio ? { audioSummary: { ...audio, mediaId, sourceFingerprint } } : {}),
        ...(silence ? { silence: { ...silence, mediaId, sourceFingerprint } } : {}),
        ...(beatGrid ? { beatGrid: { ...beatGrid, mediaId, sourceFingerprint } } : {}),
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
          // Frame-exact facts (decoded count, time base, CFR/VFR verdict)
          // come from ffprobe when available; absent means honestly absent.
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
        ...(candidates?.sceneCuts ? { sceneCuts: { ...candidates.sceneCuts, mediaId, sourceFingerprint } } : {}),
        ...(candidates?.blackFrames ? { blackFrames: { ...candidates.blackFrames, mediaId, sourceFingerprint } } : {}),
        ...(candidates?.duplicateFrames ? { duplicateFrames: { ...candidates.duplicateFrames, mediaId, sourceFingerprint } } : {}),
      };
      // Durable, traceable record (P2): observations/inferences/
      // recommendations stay separated, provenance and honest unknowns are
      // pinned, and a recheck links to its predecessor. Records need an
      // artifactRoot; without one the analysis completes exactly as before
      // (ephemeral job summary only) — never a silent failure of the job.
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
          ...(silence ? { silenceParams: silence.parameters } : {}),
          ...(reviewQuestion !== undefined ? { reviewQuestion } : {}),
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

  private async probeMedia(resolvedPath: string) {
    try {
      return await probeLocalMediaFile(resolvedPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new FacadeError(
        "INVALID_PARAMS",
        `media.import: cannot read media metadata: ${message}`,
        { path: resolvedPath },
      );
    }
  }


  /** Probe a media file for the media.replace enrichment pre-pass. */
  private async probeMediaForEnrichment(absPath: string) {
    const probed = await probeLocalMediaFile(absPath);
    return {
      durationSec: probed.durationSec,
      width: probed.width,
      height: probed.height,
      frameRate: probed.frameRate,
      codec: probed.codec,
      fileSize: probed.fileSize,
      mimeType: probed.mimeType,
      hasVideo: probed.hasVideo,
      hasAudio: probed.hasAudio,
      sampleRate: 0,
      channels: 0,
    };
  }

  /** Resolve ONE media item's file with the builder's containment checks. */
  private async resolveMediaItemFile(itemInput: unknown): Promise<string | null> {
    const item = itemInput as MediaItem;
    const originalUrl =
      typeof (item as { originalUrl?: unknown }).originalUrl === "string"
        ? ((item as { originalUrl?: string }).originalUrl as string)
        : null;
    if (!originalUrl) return null;
    const roots = this.config.mediaRoots ?? [];
    const resolution = resolveContainedPathDetailed(originalUrl, roots);
    if (resolution.kind !== "ok") return null;
    const fileStat = await stat(resolution.path).catch(() => null);
    if (!fileStat?.isFile() || fileStat.size > MAX_MEDIA_FILE_BYTES) return null;
    return resolution.path;
  }

  /**
   * Map every timeline-referenced media item to a re-validated local file.
   * The path is checked against mediaRoots AGAIN here (defense in depth: an
   * imported path could have been swapped between import and render), must
   * be a regular file, and is size-capped. A referenced item without a
   * readable file fails the verb loudly instead of silently rendering
   * without its pixels.
   */
  private async buildMediaFiles(project: Project, verb: string): Promise<Record<string, string>> {
    const referenced = new Set<string>();
    for (const track of project.timeline.tracks) {
      for (const clip of track.clips) {
        referenced.add(clip.mediaId);
      }
    }
    const roots = this.config.mediaRoots ?? [];
    const files: Record<string, string> = {};
    const missing: string[] = [];
    for (const item of project.mediaLibrary.items) {
      if (!referenced.has(item.id)) continue;
      const originalUrl =
        typeof (item as { originalUrl?: unknown }).originalUrl === "string"
          ? ((item as { originalUrl?: string }).originalUrl as string)
          : null;
      if (!originalUrl) {
        missing.push(item.id);
        continue;
      }
      const resolution = resolveContainedPathDetailed(originalUrl, roots);
      if (resolution.kind !== "ok") {
        missing.push(item.id);
        continue;
      }
      const fileStat = await stat(resolution.path).catch(() => null);
      if (!fileStat || !fileStat.isFile() || fileStat.size > MAX_MEDIA_FILE_BYTES) {
        missing.push(item.id);
        continue;
      }
      files[item.id] = resolution.path;
    }
    if (missing.length > 0) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `${verb}: ${missing.length} referenced media item(s) have no readable file inside the configured mediaRoots`,
        { mediaIds: missing, mediaRoots: [...roots] },
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
      const artifactRoot = requireArtifactRoot(this.config.artifactRoot, "export.finalize");
      const resolution = resolveContainedPathDetailed(completion.path, [artifactRoot]);
      if (resolution.kind === "outside") {
        // Post-write containment: never publish, and remove the file the
        // provider pushed through the escape (unlink never follows a final
        // symlink, so this cannot delete an outside pre-existing target).
        await rm(completion.path, { force: true }).catch(() => undefined);
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

  /**
   * Mutation phase 1: idempotency replay, then the revision precondition.
   * Returns the stored committed outcome on a replay hit, null when the
   * mutation may proceed. Both failure modes are zero-side-effect.
   *
   * The ledger is scoped per verb and pins the mutation-defining payload:
   * the same key carrying a DIFFERENT payload is a CONFLICT, never a blind
   * replay of an unrelated earlier call.
   */
  private beginMutation<T>(
    verb: string,
    expectedRevision: number | undefined,
    idempotencyKey: string | undefined,
    payload: unknown,
  ): MutationOutcome<T> | null {
    if (idempotencyKey !== undefined && this.ledger.has(verb, idempotencyKey)) {
      const stored = this.ledger.get<T>(verb, idempotencyKey);
      if (stored) {
        const incomingHash = stableStringify(payload);
        if (incomingHash !== stored.payloadHash) {
          throw new FacadeError(
            "CONFLICT",
            `idempotency key "${idempotencyKey}" was already committed with a different payload`,
            { idempotencyKey, verb },
          );
        }
        return { revision: stored.revision, value: stored.value, replayed: true };
      }
    }
    if (
      expectedRevision !== undefined &&
      expectedRevision !== this.revision
    ) {
      throw new FacadeError(
        "CONFLICT",
        `revision conflict: expected ${expectedRevision}, current is ${this.revision}`,
        { currentRevision: this.revision },
      );
    }
    return null;
  }

  /**
   * Mutation phase 2: run the apply callback against a structuredClone'd
   * draft and swap it in only on full success — revision increments exactly
   * once per committed verb call, and a thrown error discards the draft so
   * the original Project object is byte-exact untouched.
   */
  private async commitMutation<T>(opts: {
    readonly verb: string;
    readonly idempotencyKey?: string | undefined;
    readonly payload: unknown;
    readonly apply: (draft: Project) => T | Promise<T>;
  }): Promise<MutationOutcome<T>> {
    const before = this.project as Project;
    const draft = structuredClone(before) as Project;
    const value = await opts.apply(draft);
    this.changes.record(before, draft, this.revision, this.revision + 1);
    this.project = draft;
    this.revision += 1;
    const outcome: MutationOutcome<T> = {
      revision: this.revision,
      value,
      replayed: false,
    };
    if (opts.idempotencyKey !== undefined) {
      this.ledger.set(opts.verb, opts.idempotencyKey, {
        revision: outcome.revision,
        value,
        payloadHash: stableStringify(opts.payload),
      });
    }
    return outcome;
  }

  /** Serialized execution: every verb body runs inside this single lane. */
  private enqueue<T>(task: () => Promise<FacadeResult<T>>): Promise<FacadeResult<T>> {
    const result = this.chain.then(() => task()).catch(toFailure<T>);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private projectState(): ProjectState {
    return projectStateView(this.project as Project, this.revision);
  }

  private noProject<T>(): FacadeResult<T> {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "no project is open — call project.create first",
      },
    };
  }
}

export function createAgentFacadeSession(
  config: AgentFacadeConfig = {},
): AgentFacadeSession {
  return new AgentFacadeSession(config);
}

export { DEFAULT_PROJECT_SETTINGS };
