/**
 * LiveFacadeSession — the live human–agent collaboration facade
 * (ADR 0004: Slice 3). A SEPARATE implementation of the same 17-verb
 * contract as AgentFacadeSession (Decision 11: headless is untouched):
 *
 *  - It holds NO project copy. The renderer's store stays canonical
 *    (Decision 1); every verb works from on-demand `LiveProjectStore`
 *    snapshots, and every mutation is translated to core actions by the
 *    SAME ops.ts translator as headless (Decision 2: one contract) and
 *    committed through `store.applyActions` as ONE undo unit with CAS
 *    preconditions (Decisions 3/4).
 *  - One AI writer at a time (Decision 6): construction acquires the
 *    `LiveWriterLease` for write-enabled sessions; a session without it runs
 *    read-only and its write verbs fail CONFLICT naming the holder. The
 *    human never takes the lease and can always edit.
 *  - Work mode controls collaboration behavior only. Read/write access is a
 *    separate facade boundary: read-only access rejects write verbs with
 *    FORBIDDEN, while every work mode sees the same authorized verb surface.
 *  - Honesty: project.create/project.open remain GUI-owned; media.import
 *    validates and delegates through the explicit live store bridge; preview/export run on a snapshot
 *    and require its media to be file-backed and readable from THIS process
 *    — blob/GUI-only media fails loudly instead of silently rendering
 *    wrong pixels. Text-only projects render fine.
 *
 * Serialization mirrors headless: every verb body runs inside one
 * promise-chained lane, so verb calls never interleave.
 */
import { ActionExecutor } from "@openreel/core/actions/action-executor";
import { ActionHistory } from "@openreel/core/actions/action-history";
import type { Action } from "@openreel/core/types/actions";
import type { Project } from "@openreel/core/types/project";
import { rm, stat } from "node:fs/promises";
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
import { JobRegistry, jobStatusView } from "./jobs";
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
import { opToCoreActions, validateEditOp } from "./ops";
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
  PREVIEW_RENDER_FRAME_SCHEMA,
  VISUAL_INSPECT_RANGE_SCHEMA,
  VISUAL_INSPECT_SCHEMA,
  VERIFY_ARTIFACT_SCHEMA,
  VERIFY_COMPARE_SCHEMA,
  VERIFY_EXPECT_SCHEMA,
  VERIFY_REGION_SCHEMA,
  EDITOR_CONTROL_SCHEMA,
  EDITOR_CONTROL_TARGET_SCHEMA,
} from "./verb-schemas";
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
  type OpApplied,
  type PreviewRenderFrameParams,
  type PreviewRenderFrameResult,
  type VisualInspectParams,
  type VisualInspectResult,
  type ProjectCreateParams,
  type ProjectCreateResult,
  type ProjectOpenParams,
  type ProjectOpenResult,
  type ProjectState,
  type SessionDescription,
  type TimelineState,
  type VerifyArtifactParams,
  type VerifyArtifactResult,
} from "./types";
import {
  DEFAULT_AGENT_ACCESS_MODE,
  DEFAULT_AGENT_WORK_MODE,
  agentWorkModeSemantics,
  type AgentAccessMode,
  type AgentWorkMode,
} from "./work-mode";
import {
  buildVisualSamplePlan,
  MAX_VISUAL_CONTACT_SHEET_PIXELS,
  MAX_VISUAL_FRAME_PIXELS,
  MAX_VISUAL_PNG_BYTES,
  visualRasterSize,
} from "./visual-inspect";

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
  /** Collaboration preference; a getter lets the GUI switch without remounting this session. */
  readonly workMode?: AgentWorkMode | (() => AgentWorkMode);
  /** Authorization boundary, deliberately independent from work mode. */
  readonly access?: AgentAccessMode;
  /**
   * Absolute root every generated artifact (preview PNGs, exported videos)
   * is written under, with the same containment discipline as headless.
   */
  readonly artifactRoot: string;
  /** Export job tracking; defaults to a fresh in-memory JobRegistry. */
  readonly jobTracker?: JobRegistry;
}

/**
 * The live facade contract: the same 17 verbs as AgentFacade, with
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
  "transition.add",
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

  private workMode(): AgentWorkMode {
    const configured = this.config.workMode;
    return typeof configured === "function"
      ? configured()
      : configured ?? DEFAULT_AGENT_WORK_MODE;
  }

  private accessMode(): AgentAccessMode {
    return this.config.access ?? DEFAULT_AGENT_ACCESS_MODE;
  }

  private capabilityContext() {
    const mediaImportAvailable =
      (this.config.mediaRoots?.length ?? 0) > 0 &&
      typeof this.config.store.importMedia === "function";
    const unavailableVerbs: FacadeVerb[] = [...LIVE_UNAVAILABLE_VERBS];
    if (!mediaImportAvailable) unavailableVerbs.push("media.import");
    return {
      workMode: this.workMode(),
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
        `${verb}: this live session has read-only access — work mode never grants write permission`,
        {
          access: this.accessMode(),
          workMode: this.workMode(),
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
      return ok<EditorGetContextResult>({
        mode: "live",
        workMode: this.workMode(),
        workModeSemantics: agentWorkModeSemantics(this.workMode()),
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
        identity: {
          projectId: identity.projectId,
          projectName: identity.projectName,
          windowId: identity.windowId,
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
      this.gate("editor.control");
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
      const actions: Action[] = [];
      const autoTextTrackIds: Array<string | undefined> = [];
      for (const [index, op] of ops.entries()) {
        const hadTextTrack =
          op.op === "text.create" && op.trackId === undefined
            ? draft.timeline.tracks.some((track) => track.type === "text")
            : true;
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
        autoTextTrackIds[index] =
          op.op === "text.create" && op.trackId === undefined && !hadTextTrack
            ? (opActions.find((action) => action.type === "track/add")?.params
                .trackId as string | undefined)
            : undefined;
        actions.push(...opActions);
      }

      let committed: LiveApplyActionsResult;
      try {
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
      const applied = partitionCreatedIds(ops, committed.createdIds, autoTextTrackIds);
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
          { requires: "RenderProvider (e.g. @openreel/runtime-chromium)" },
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
      const rendersDir = resolvePath(artifactRoot, "renders");
      // Same containment discipline as headless, before AND after the write.
      await prepareArtifactDir(rendersDir, artifactRoot, "preview.render_frame");
      const timeMs = Math.round(valid.timeSec * 1000);
      const destPath = resolvePath(
        rendersDir,
        `frame-${project.id}-r${revision}-t${timeMs}-${width}x${height}.png`,
      );

      const rendered = await provider.renderFramePng({
        project: structuredClone(project),
        sourceRevision: revision,
        timeSec,
        width,
        height,
        destPath,
        mediaFiles,
      });
      const verifiedPath = await assertContainedWrittenFile(
        destPath,
        artifactRoot,
        "preview.render_frame",
      );
      const artifact = await artifactRefFor(
        verifiedPath,
        "image",
        "png",
        revision,
        rendered.bytesWritten,
      );
      const value: PreviewRenderFrameResult = {
        revision,
        timeSec,
        width,
        height,
        artifact,
        replayed: false,
      };
      if (valid.idempotencyKey !== undefined) {
        this.ledger.set("preview.render_frame", valid.idempotencyKey, {
          revision,
          value,
          payloadHash: stableStringify(payload),
        });
      }
      return ok(value);
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
          { requires: "RenderProvider (e.g. @openreel/runtime-chromium)" },
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
      const framesDir = resolvePath(artifactRoot, "visual", "frames");
      await prepareArtifactDir(framesDir, artifactRoot, "visual.inspect");
      const frames = [] as VisualInspectResult["frames"][number][];
      for (const [index, sample] of plan.samples.entries()) {
        const destPath = resolvePath(
          framesDir,
          `frame-${project.id}-r${sourceRevision}-${index}-${Math.round(sample.timeSec * 1000)}-${width}x${height}.png`,
        );
        const rendered = await provider.renderFramePng({
          project: structuredClone(project),
          sourceRevision,
          timeSec: sample.timeSec,
          width,
          height,
          destPath,
          mediaFiles,
        });
        if (rendered.bytesWritten > MAX_VISUAL_PNG_BYTES) {
          await rm(destPath, { force: true });
          throw new FacadeError(
            "JOB_FAILED",
            `visual.inspect: frame PNG exceeds the ${MAX_VISUAL_PNG_BYTES}-byte artifact limit`,
            { index },
          );
        }
        const verifiedPath = await assertContainedWrittenFile(
          destPath,
          artifactRoot,
          "visual.inspect",
        );
        const artifact = await artifactRefFor(
          verifiedPath,
          "image",
          "png",
          sourceRevision,
          rendered.bytesWritten,
        );
        if (artifact.sizeBytes > MAX_VISUAL_PNG_BYTES) {
          await rm(verifiedPath, { force: true });
          throw new FacadeError(
            "JOB_FAILED",
            `visual.inspect: frame PNG exceeds the ${MAX_VISUAL_PNG_BYTES}-byte artifact limit`,
            { index },
          );
        }
        frames.push({
          index,
          timeSec: sample.timeSec,
          label: sample.label,
          sourceRevision,
          artifact,
        });
      }

      const limitations: string[] = [];
      let contactSheet: VisualInspectResult["contactSheet"] = null;
      if (provider.renderContactSheetPng) {
        const contactDir = resolvePath(artifactRoot, "visual", "contact-sheets");
        await prepareArtifactDir(contactDir, artifactRoot, "visual.inspect");
        const contactPath = resolvePath(
          contactDir,
          `contact-${project.id}-r${sourceRevision}-${sampleCount}-${width}x${height}.png`,
        );
        try {
          const rendered = await provider.renderContactSheetPng({
            project: structuredClone(project),
            sourceRevision,
            samples: plan.samples,
            width,
            height,
            destPath: contactPath,
            mediaFiles,
          } satisfies RenderContactSheetRequest);
          if (rendered.bytesWritten > MAX_VISUAL_PNG_BYTES) {
            await rm(contactPath, { force: true });
            limitations.push(
              `contact sheet exceeded the ${MAX_VISUAL_PNG_BYTES}-byte artifact limit; individual frame PNGs are returned`,
            );
          } else {
            const verifiedPath = await assertContainedWrittenFile(
              contactPath,
              artifactRoot,
              "visual.inspect",
            );
            const artifact = await artifactRefFor(
              verifiedPath,
              "image",
              "png",
              sourceRevision,
              rendered.bytesWritten,
            );
            if (artifact.sizeBytes > MAX_VISUAL_PNG_BYTES) {
              await rm(verifiedPath, { force: true });
              limitations.push(
                `contact sheet exceeded the ${MAX_VISUAL_PNG_BYTES}-byte artifact limit; individual frame PNGs are returned`,
              );
            } else {
              contactSheet = artifact;
            }
          }
        } catch (error) {
          if (error instanceof FacadeError && error.code === "JOB_FAILED") {
            throw error;
          }
          await rm(contactPath, { force: true }).catch(() => undefined);
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
          { requires: "ExportProvider (e.g. @openreel/runtime-chromium)" },
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

      // The snapshot is the export's entire world: deep-cloned here,
      // synchronously, inside the serialized lane.
      const snapshot = structuredClone(project);
      const sourceRevision = revision;
      const mediaFiles = await this.buildLiveMediaFiles(project, "export.start");

      const jobId = `job-${crypto.randomUUID()}`;
      const exportsDir = resolvePath(artifactRoot, "exports");
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

      const callbacks: ExportCallbacks = {
        onRunning: () => this.jobs.markRunning(jobId),
        onProgress: (event) => this.jobs.markProgress(jobId, event),
        onDone: (completion) => {
          void this.finalizeExport(jobId, sourceRevision, completion, delivery);
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
        await Promise.race([
          provider.cancel(valid.jobId),
          new Promise<"timeout">((resolveTimeout) =>
            setTimeout(() => resolveTimeout("timeout" as const), 10_000),
          ),
        ]);
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
    const provider = this.config.exportProvider;
    for (const job of this.jobs.list()) {
      if (job.state === "queued" || job.state === "running") {
        this.jobs.markCancelRequested(job.jobId);
        if (provider) {
          await provider.cancel(job.jobId).catch(() => undefined);
        }
        this.jobs.markCancelled(job.jobId);
      }
    }
    this.releaseWriterLease();
    // Let the serialized lane drain (a verb in flight finishes first).
    await this.chain.catch(() => undefined);
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
    try {
      const { projectId } = await this.config.store.getIdentity();
      this.ledgerProjectId = projectId;
    } catch {
      // Identity unreadable (e.g. no project open): keep the last known
      // scope — the store's own errors/CAS stay authoritative.
    }
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
    completion: { path: string; sizeBytes: number; route: string },
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
      this.jobs.markDone(jobId, artifact, completion.route);
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
    const result = this.chain.then(() => task()).catch(toFailure<T>);
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
 */
function partitionCreatedIds(
  ops: readonly EditOp[],
  createdIds: LiveCreatedIds,
  autoTextTrackIds: readonly (string | undefined)[] = [],
): OpApplied[] {
  const categories = {
    "track.add": "tracks",
    "clip.add": "clips",
    "clip.split": "clips",
    "clip.duplicate": "clips",
    "text.create": "textClips",
    "transition.add": "transitions",
  } as const;
  const usedTracks = new Set<string>();
  const cursors = {
    tracks: 0,
    clips: 0,
    textClips: 0,
    transitions: 0,
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
      const autoTrackId = autoTextTrackIds[index];
      if (autoTrackId !== undefined && createdIds.tracks.includes(autoTrackId)) {
        usedTracks.add(autoTrackId);
        ids.push(autoTrackId);
      }
      const id = createdIds.textClips[cursors.textClips];
      cursors.textClips += 1;
      if (id !== undefined) ids.push(id);
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
    releaseWriterLease: () => session.releaseWriterLease(),
    dispose: () => session.dispose(),
  };
}
