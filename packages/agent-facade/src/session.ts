/**
 * AgentFacadeSession — the Slice-1 in-process facade.
 *
 * Guarantees (audit/facade-v0.md contracts #1–#3, #5):
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
import { ActionExecutor } from "@openreel/core/actions/action-executor";
import { ActionHistory } from "@openreel/core/actions/action-history";
import type { Project, ProjectSettings } from "@openreel/core/types/project";
import type { MediaItem } from "@openreel/core/types/project";
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
import { JobRegistry, jobStatusView } from "./jobs";
import {
  applyClipIdOverride,
  collectEntityIds,
  diffCreatedIds,
  opToCoreActions,
  validateEditOp,
} from "./ops";
import {
  projectStateView,
  timelineDurationSec,
  timelineStateView,
} from "./projection";
import { createEmptyProject, DEFAULT_PROJECT_SETTINGS } from "./project-factory";
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
  PREVIEW_RENDER_FRAME_SCHEMA,
  VISUAL_INSPECT_RANGE_SCHEMA,
  VISUAL_INSPECT_SCHEMA,
  PROJECT_CREATE_SCHEMA,
  PROJECT_OPEN_SCHEMA,
  PROJECT_SAVE_SCHEMA,
  PROJECT_SETTINGS_SCHEMA,
  VERIFY_ARTIFACT_SCHEMA,
  VERIFY_COMPARE_SCHEMA,
  VERIFY_EXPECT_SCHEMA,
  VERIFY_REGION_SCHEMA,
  EDITOR_CONTROL_SCHEMA,
  EDITOR_CONTROL_TARGET_SCHEMA,
} from "./verb-schemas";
import type {
  LiveEditorControlParams,
  LiveEditorControlResult,
  LiveEditorControlTarget,
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
  OpApplied,
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
import {
  buildVisualSamplePlan,
  MAX_VISUAL_CONTACT_SHEET_PIXELS,
  MAX_VISUAL_FRAME_PIXELS,
  MAX_VISUAL_PNG_BYTES,
  visualRasterSize,
} from "./visual-inspect";

export interface AgentFacadeConfig {
  /**
   * Absolute roots that media.import may read from. Imports resolving
   * outside every root fail with zero side effects. Default: none (imports
   * are then rejected until the caller configures roots).
   */
  readonly mediaRoots?: readonly string[];
  /**
   * Absolute roots that project.open / project.save may read and write
   * checkpoint files under (ADR 0003 Decision 10.1). The transport
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
   * Dormant Slice-1 seam, kept for contract stability. Injecting an adapter
   * changes NOTHING observable: no facade verb consumes it and it flips no
   * capability (see render/adapter.ts and capabilities.ts).
   */
  readonly renderAdapter?: ProjectRenderAdapter;
  /**
   * Absolute root every generated artifact (preview PNGs, exported videos)
   * is written under. Artifact-producing verbs fail UNSUPPORTED without it;
   * verify.artifact only inspects files inside it.
   */
  readonly artifactRoot?: string;
  /** Slice-1b preview.render_frame backing (independent capability). */
  readonly renderProvider?: RenderProvider;
  /** Slice-1b export.start backing (independent capability). */
  readonly exportProvider?: ExportProvider;
  /** Slice-1b verify.artifact backing (independent capability). */
  readonly artifactVerifier?: ArtifactVerifier;
}

// The per-verb param declarations are the SINGLE hand-maintained source
// (ADR 0003 Decision 4): validation below and the emitted draft-2020-12
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

  async timelineGet(): Promise<FacadeResult<TimelineState>> {
    if (!this.project) return this.noProject();
    return ok(timelineStateView(this.project, this.revision));
  }

  /**
   * editor.get_context (ADR 0004 Decision 4) — headless honesty: there is
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
      valid.targets?.forEach((target, index) =>
        validateObject<LiveEditorControlTarget>(
          target,
          EDITOR_CONTROL_TARGET_SCHEMA,
          `editor.control params.targets[${index}]`,
        ),
      );
      if (valid.action === "seek" && valid.timeSeconds === undefined) {
        throw new FacadeError("INVALID_PARAMS", "editor.control: seek requires timeSeconds");
      }
      if (valid.action !== "seek" && valid.timeSeconds !== undefined) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `editor.control: timeSeconds is only valid for seek, not ${valid.action}`,
        );
      }
      if (valid.action === "select" && (!valid.targets || valid.targets.length === 0)) {
        throw new FacadeError("INVALID_PARAMS", "editor.control: select requires at least one target");
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
          "project.create: this session already has an open project — project.create is a single-initialization lifecycle verb and Slice 1 provides no replace/reset",
        );
      }

      this.project = createEmptyProject(valid.name, settings);
      this.revision = 0;
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
      // ADR 0004 Decision 4: the context CAS exists only where an editor
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
      const ops = valid.ops.map((raw, index) => validateEditOp(raw, index));
      if (ops.length === 0) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "edit.apply: ops must contain at least one op",
        );
      }

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

      const outcome = await this.commitMutation<EditApplyPayload>({
        verb: "edit.apply",
        idempotencyKey: valid.idempotencyKey,
        payload: { ops },
        apply: async (draft) => {
          // One executor + history per batch: the facade never reuses core
          // undo machinery, and a discarded draft leaves no history behind.
          const executor = new ActionExecutor(new ActionHistory());
          const applied: OpApplied[] = [];
          for (const [index, op] of ops.entries()) {
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

  /* --------------------- Slice-1b: preview/export --------------------- */

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
          { requires: "RenderProvider (e.g. @openreel/runtime-chromium)" },
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
      const rendersDir = resolvePath(artifactRoot, "renders");
      // Containment BEFORE the provider writes: a symlinked/junctioned
      // renders dir (or a linked ancestor) must fail the verb with zero
      // bytes written outside artifactRoot.
      await prepareArtifactDir(rendersDir, artifactRoot, "preview.render_frame");
      const timeMs = Math.round(valid.timeSec * 1000);
      // Scoped by project id: two sessions sharing one artifactRoot can
      // never overwrite each other's preview artifacts.
      const destPath = resolvePath(
        rendersDir,
        `frame-${project.id}-r${this.revision}-t${timeMs}-${width}x${height}.png`,
      );

      const rendered = await provider.renderFramePng({
        project: structuredClone(project),
        sourceRevision: this.revision,
        timeSec,
        width,
        height,
        destPath,
        mediaFiles,
      });
      // Containment AFTER the write: a provider that swapped the output dir
      // for a link mid-render (or wrote through one) is caught here, before
      // the artifact is hashed and published. The VERIFIED real path is
      // what gets hashed — no swap window between check and hash.
      const verifiedPath = await assertContainedWrittenFile(destPath, artifactRoot, "preview.render_frame");
      const artifact = await artifactRefFor(
        verifiedPath,
        "image",
        "png",
        this.revision,
        rendered.bytesWritten,
      );
      const value: PreviewRenderFrameResult = {
        revision: this.revision,
        timeSec,
        width,
        height,
        artifact,
        replayed: false,
      };
      if (valid.idempotencyKey !== undefined) {
        this.ledger.set("preview.render_frame", valid.idempotencyKey, {
          revision: this.revision,
          value,
          payloadHash: stableStringify(payload),
        });
      }
      return ok(value);
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
      if (valid.timeRange !== undefined) {
        validateObject(
          valid.timeRange,
          VISUAL_INSPECT_RANGE_SCHEMA,
          "visual.inspect params.timeRange",
        );
      }
      if (!this.project) return this.noProject();
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

      const project = this.project;
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
          // Containment failures are security failures, not optional-feature
          // failures. Provider/runtime errors can fall back to real frames.
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
          { requires: "ExportProvider (e.g. @openreel/runtime-chromium)" },
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

      // The snapshot is the export's entire world: deep-cloned here,
      // synchronously, inside the serialized lane. Later edits can proceed;
      // they never reach this job.
      const snapshot = structuredClone(project);
      const sourceRevision = this.revision;
      const mediaFiles = await this.buildMediaFiles(project, "export.start");

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

  /** job.status — poll the facade-owned job registry. */
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
   * verify.artifact — read-only inspection (ffprobe-style probe + optional
   * pixel comparison) of a file inside artifactRoot. A failed assertion is
   * reported as data (checks[], pass:false), never as a thrown domain error;
   * only infrastructure problems fail the call.
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
      if (hasUrlScheme(valid.path)) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "verify.artifact: URLs are not accepted — pass a local artifact path inside artifactRoot",
          { path: valid.path },
        );
      }
      const target = resolveContainedPathDetailed(valid.path, [artifactRoot]);
      if (target.kind === "outside") {
        throw new FacadeError(
          "INVALID_PARAMS",
          "verify.artifact: path escapes the configured artifactRoot",
          { path: valid.path },
        );
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
            "verify.artifact: reference URLs are not accepted — pass a local path inside mediaRoots or artifactRoot",
          );
        }
        let reference = resolveContainedPathDetailed(compare.referencePath, [artifactRoot]);
        if (reference.kind !== "ok") {
          reference = resolveContainedPathDetailed(
            compare.referencePath,
            this.config.mediaRoots ?? [],
          );
        }
        if (reference.kind === "outside") {
          throw new FacadeError(
            "INVALID_PARAMS",
            "verify.artifact: referencePath escapes both artifactRoot and mediaRoots",
            { referencePath: compare.referencePath },
          );
        }
        if (reference.kind === "unresolvable") {
          throw new FacadeError(
            "INVALID_PARAMS",
            "verify.artifact: referencePath cannot be read (not found or unreadable)",
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

  /* ---------------------------- internals ---------------------------- */

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
    completion: { path: string; sizeBytes: number; route: string },
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
    const draft = structuredClone(this.project) as Project;
    const value = await opts.apply(draft);
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
