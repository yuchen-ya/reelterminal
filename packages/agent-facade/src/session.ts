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
import { basename, resolve as resolvePath } from "node:path";
import { lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import { buildCapabilities, buildSessionDescription } from "./capabilities";
import { FacadeError, ok, toFailure, type FacadeResult } from "./errors";
import { IdempotencyLedger, stableStringify } from "./idempotency";
import { JobRegistry, type JobRecord } from "./jobs";
import {
  applyClipIdOverride,
  collectEntityIds,
  diffCreatedIds,
  opToCoreActions,
  validateEditOp,
} from "./ops";
import { createEmptyProject, DEFAULT_PROJECT_SETTINGS } from "./project-factory";
import type {
  ArtifactRef,
  ArtifactVerifier,
  ExportCallbacks,
  ExportProvider,
  RenderProvider,
  VerifyArtifactRequest,
} from "./providers";
import type { ProjectRenderAdapter } from "./render/adapter";
import {
  hasUrlScheme,
  resolveContainedPathDetailed,
} from "./media/path-roots";
import { probeLocalMediaFile } from "./media/node-media-adapter";
import {
  isFiniteNumber,
  isNonEmptyString,
  isNonNegativeInteger,
  isNonNegativeNumber,
  isPlainObject,
  isPositiveInteger,
  isPositiveNumber,
  oneOf,
  validateObject,
  type ObjectSchema,
} from "./validate";
import type {
  Capabilities,
  EditApplyParams,
  EditApplyResult,
  ExportStartParams,
  ExportStartResult,
  JobParams,
  JobStatusView,
  MediaImportParams,
  MediaImportResult,
  OpApplied,
  PreviewRenderFrameParams,
  PreviewRenderFrameResult,
  ProjectCounts,
  ProjectCreateParams,
  ProjectCreateResult,
  ProjectState,
  SessionDescription,
  TimelineState,
  VerifyArtifactParams,
  VerifyArtifactResult,
} from "./types";

export interface AgentFacadeConfig {
  /**
   * Absolute roots that media.import may read from. Imports resolving
   * outside every root fail with zero side effects. Default: none (imports
   * are then rejected until the caller configures roots).
   */
  readonly mediaRoots?: readonly string[];
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

const PROJECT_CREATE_SCHEMA: ObjectSchema = {
  name: { check: isNonEmptyString, describe: "a non-empty string" },
  settings: {
    check: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
    describe: "an object",
  },
  idempotencyKey: { check: isNonEmptyString, describe: "a non-empty string" },
};

// Hardened settings subset: dimensions and audio layout must be positive
// INTEGERS; frameRate is the one field that legitimately carries a fraction
// (29.97 etc.), so it is a positive finite number.
const PROJECT_SETTINGS_SCHEMA: ObjectSchema = {
  width: { check: isPositiveInteger, describe: "a positive integer" },
  height: { check: isPositiveInteger, describe: "a positive integer" },
  frameRate: { check: isPositiveNumber, describe: "a positive finite number" },
  sampleRate: { check: isPositiveInteger, describe: "a positive integer" },
  channels: { check: isPositiveInteger, describe: "a positive integer" },
};

const MEDIA_IMPORT_SCHEMA: ObjectSchema = {
  path: { check: isNonEmptyString, describe: "a non-empty string", required: true },
  name: { check: isNonEmptyString, describe: "a non-empty string" },
  expectedRevision: { check: isNonNegativeInteger, describe: "a non-negative integer" },
  idempotencyKey: { check: isNonEmptyString, describe: "a non-empty string" },
};

const EDIT_APPLY_SCHEMA: ObjectSchema = {
  ops: {
    check: (v) => Array.isArray(v),
    describe: "an array of ops",
    required: true,
  },
  expectedRevision: { check: isNonNegativeInteger, describe: "a non-negative integer" },
  idempotencyKey: { check: isNonEmptyString, describe: "a non-empty string" },
};

/** Rasters/encoders need even dimensions; 8192 caps browser-tab memory. */
const isEvenDimension = (v: unknown): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= 2 && v <= 8192 && v % 2 === 0;

const isUnitInterval = (v: unknown): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

const PREVIEW_RENDER_FRAME_SCHEMA: ObjectSchema = {
  timeSec: { check: isNonNegativeNumber, describe: "a non-negative finite number", required: true },
  width: { check: isEvenDimension, describe: "an even integer in [2, 8192]" },
  height: { check: isEvenDimension, describe: "an even integer in [2, 8192]" },
  expectedRevision: { check: isNonNegativeInteger, describe: "a non-negative integer" },
  idempotencyKey: { check: isNonEmptyString, describe: "a non-empty string" },
};

const EXPORT_START_SCHEMA: ObjectSchema = {
  settings: { check: isPlainObject, describe: "an object" },
  expectedRevision: { check: isNonNegativeInteger, describe: "a non-negative integer" },
  idempotencyKey: { check: isNonEmptyString, describe: "a non-empty string" },
};

const EXPORT_SETTINGS_SCHEMA: ObjectSchema = {
  format: { check: oneOf(["mp4"]), describe: '"mp4" (the only container in this slice)' },
  codec: { check: oneOf(["h264"]), describe: '"h264" (the only codec in this slice)' },
  width: { check: isEvenDimension, describe: "an even integer in [2, 8192]" },
  height: { check: isEvenDimension, describe: "an even integer in [2, 8192]" },
  frameRate: { check: isPositiveNumber, describe: "a positive finite number" },
  videoBitrateKbps: { check: isPositiveInteger, describe: "a positive integer" },
};

const JOB_PARAMS_SCHEMA: ObjectSchema = {
  jobId: { check: isNonEmptyString, describe: "a non-empty string", required: true },
};

const VERIFY_EXPECT_SCHEMA: ObjectSchema = {
  container: { check: oneOf(["mp4"]), describe: '"mp4"' },
  videoCodec: { check: oneOf(["h264"]), describe: '"h264"' },
  width: { check: isPositiveInteger, describe: "a positive integer" },
  height: { check: isPositiveInteger, describe: "a positive integer" },
  durationSec: { check: isPositiveNumber, describe: "a positive finite number" },
  durationToleranceSec: { check: isPositiveNumber, describe: "a positive finite number" },
};

const VERIFY_REGION_SCHEMA: ObjectSchema = {
  x: { check: isUnitInterval, describe: "a number in [0, 1]", required: true },
  y: { check: isUnitInterval, describe: "a number in [0, 1]", required: true },
  width: { check: isUnitInterval, describe: "a number in [0, 1]", required: true },
  height: { check: isUnitInterval, describe: "a number in [0, 1]", required: true },
};

const VERIFY_COMPARE_SCHEMA: ObjectSchema = {
  referencePath: { check: isNonEmptyString, describe: "a non-empty string", required: true },
  timeSec: { check: isNonNegativeNumber, describe: "a non-negative finite number", required: true },
  referenceTimeSec: { check: isNonNegativeNumber, describe: "a non-negative finite number" },
  region: { check: isPlainObject, describe: "an object" },
  mode: { check: oneOf(["similar", "different"]), describe: '"similar" or "different"', required: true },
  maxMeanAbsDiff: { check: isFiniteNumber, describe: "a finite number" },
  minMeanAbsDiff: { check: isFiniteNumber, describe: "a finite number" },
  minChangedPixelsRatio: { check: isUnitInterval, describe: "a number in [0, 1]" },
};

const VERIFY_ARTIFACT_SCHEMA: ObjectSchema = {
  path: { check: isNonEmptyString, describe: "a non-empty string", required: true },
  expect: { check: isPlainObject, describe: "an object" },
  compare: { check: isPlainObject, describe: "an object" },
};

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
    const project = this.project;
    return ok({
      revision: this.revision,
      duration: project.timeline.duration,
      tracks: project.timeline.tracks.map((track) => ({
        id: track.id,
        type: track.type,
        name: track.name,
        clips: track.clips.map((clip) => ({
          id: clip.id,
          trackId: clip.trackId,
          mediaId: clip.mediaId,
          startTime: clip.startTime,
          duration: clip.duration,
          inPoint: clip.inPoint,
          outPoint: clip.outPoint,
        })),
      })),
      textOverlays: (project.textClips ?? []).map((clip) => ({
        id: clip.id,
        trackId: clip.trackId,
        text: clip.text,
        startTime: clip.startTime,
        duration: clip.duration,
      })),
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
      const artifactRoot = this.requireArtifactRoot("preview.render_frame");
      await this.requireProviderPreflight(provider, "preview.render_frame");

      const project = this.project;
      const width = valid.width ?? project.settings.width;
      const height = valid.height ?? project.settings.height;
      if (!isEvenDimension(width) || !isEvenDimension(height)) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `preview.render_frame: raster size must be even; project settings are ${project.settings.width}x${project.settings.height} — pass explicit even width/height`,
        );
      }

      const duration = this.timelineDurationSec(project);
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
      await mkdir(rendersDir, { recursive: true });
      // Containment BEFORE the provider writes: a symlinked/junctioned
      // renders dir (or a linked ancestor) must fail the verb with zero
      // bytes written outside artifactRoot.
      await this.assertSafeArtifactDir(rendersDir, artifactRoot, "preview.render_frame");
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
      // the artifact is hashed and published.
      await this.assertContainedWrittenFile(destPath, artifactRoot, "preview.render_frame");
      const artifact = await this.artifactRefFor(
        destPath,
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
      const artifactRoot = this.requireArtifactRoot("export.start");
      await this.requireProviderPreflight(provider, "export.start");

      const settingsInput =
        valid.settings !== undefined
          ? validateObject<NonNullable<ExportStartParams["settings"]>>(
              valid.settings,
              EXPORT_SETTINGS_SCHEMA,
              "export.start params.settings",
            )
          : undefined;

      const payload = { settings: settingsInput ?? null };
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

      const project = this.project;
      const duration = this.timelineDurationSec(project);
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
      await mkdir(exportsDir, { recursive: true });
      // Containment BEFORE anything is created inside: a symlinked/junctioned
      // exports dir must fail here — mkdir'ing the job dir through a link
      // would already create a directory outside artifactRoot.
      await this.assertSafeArtifactDir(exportsDir, artifactRoot, "export.start");
      const jobDir = resolvePath(exportsDir, jobId);
      await mkdir(jobDir, { recursive: true });
      await this.assertSafeArtifactDir(jobDir, artifactRoot, "export.start");
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
          void this.finalizeExport(jobId, sourceRevision, completion);
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
      return ok(this.jobView(job));
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
        return ok(this.jobView(job));
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
      return ok(this.jobView(this.jobs.get(valid.jobId) ?? job));
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
      await this.requireProviderPreflight(verifier, "verify.artifact");

      const artifactRoot = this.requireArtifactRoot("verify.artifact");
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
   * Artifact-producing verbs need an artifactRoot; its absence is a session
   * configuration gap, reported as UNSUPPORTED (never a silent temp-dir
   * fallback — outputs must live where the caller can audit them).
   */
  private requireArtifactRoot(verb: string): string {
    const root = this.config.artifactRoot;
    if (root === undefined || root.length === 0) {
      throw new FacadeError(
        "UNSUPPORTED",
        `${verb}: no artifactRoot configured for this session — artifact-producing verbs need an explicit output root`,
      );
    }
    return resolvePath(root);
  }

  /**
   * Pre-write output-containment gate for a DIRECTORY the facade is about to
   * let a provider write into (renders/, exports/, exports/<jobId>). Two
   * independent checks, both fail-closed:
   *
   *  1. The directory itself must NOT be a symlink/junction. A link that
   *     points inside today can be re-pointed outside between check and
   *     write (TOCTOU), so linked output dirs are rejected outright — the
   *     facade only ever creates real directories here, anything else was
   *     placed by someone else. (Node's lstat reports Windows junctions as
   *     symbolic links, so one check covers both.)
   *  2. Its realpath must stay inside the realpath of artifactRoot, so even
   *     a real directory nested under a linked ancestor fails containment.
   */
  private async assertSafeArtifactDir(
    dir: string,
    artifactRoot: string,
    verb: string,
  ): Promise<void> {
    const dirStat = await lstat(dir).catch(() => null);
    // The link check comes FIRST: lstat does not follow links, so a
    // symlink/junction to a directory reports isDirectory() === false and
    // would otherwise mask the escape as a plain "not a directory".
    if (dirStat?.isSymbolicLink()) {
      throw new FacadeError(
        "JOB_FAILED",
        `${verb}: refusing to write through a symlink/junction in the output path: ${dir} — remove it and let the facade create a real directory`,
      );
    }
    if (!dirStat || !dirStat.isDirectory()) {
      throw new FacadeError(
        "JOB_FAILED",
        `${verb}: output directory cannot be used (missing or not a directory): ${dir}`,
      );
    }
    let realDir: string;
    let realRoot: string;
    try {
      [realDir, realRoot] = await Promise.all([
        realpath(dir),
        realpath(artifactRoot),
      ]);
    } catch (error) {
      throw new FacadeError(
        "JOB_FAILED",
        `${verb}: output directory cannot be verified (realpath failed): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (resolveContainedPathDetailed(realDir, [realRoot]).kind !== "ok") {
      throw new FacadeError(
        "JOB_FAILED",
        `${verb}: output directory escapes the configured artifactRoot: ${dir}`,
      );
    }
  }

  /**
   * Post-write containment gate for a FILE a provider claims to have written
   * under artifactRoot. On escape the dishonest file is removed best-effort
   * (it is the file the provider just wrote through the escape; when the
   * path itself is a symlink, unlink removes the link, never the target) and
   * the verb fails — the facade never publishes an artifact it cannot
   * contain.
   */
  private async assertContainedWrittenFile(
    filePath: string,
    artifactRoot: string,
    verb: string,
  ): Promise<void> {
    const resolution = resolveContainedPathDetailed(filePath, [artifactRoot]);
    if (resolution.kind === "ok") return;
    await rm(filePath, { force: true }).catch(() => undefined);
    throw new FacadeError(
      "JOB_FAILED",
      `${verb}: provider wrote outside the configured artifactRoot — the file was rejected and removed`,
      { path: filePath },
    );
  }

  /**
   * Verbs gate on the provider's OWN live preflight: a capability that
   * reports unavailable must make the verb fail UNSUPPORTED with the same
   * reason — never a silent attempt against a dead runtime.
   */
  private async requireProviderPreflight(
    provider: { preflight(): Promise<{ available: boolean; reason?: string; requires?: string }> },
    verb: string,
  ): Promise<void> {
    let pre;
    try {
      pre = await provider.preflight();
    } catch (error) {
      throw new FacadeError(
        "UNSUPPORTED",
        `${verb}: provider preflight threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!pre.available) {
      throw new FacadeError(
        "UNSUPPORTED",
        `${verb}: provider is unavailable — ${pre.reason ?? "preflight failed"}`,
        pre.requires ? { requires: pre.requires } : undefined,
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

  /** Streaming sha256 — artifacts are never buffered wholesale for hashing. */
  private async sha256File(absPath: string): Promise<string> {
    const hash = createHash("sha256");
    await pipeline(createReadStream(absPath), async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk as Buffer);
      }
    });
    return hash.digest("hex");
  }

  private async artifactRefFor(
    absPath: string,
    kind: "image" | "video",
    format: "png" | "mp4",
    sourceRevision: number,
    expectedBytes?: number,
  ): Promise<ArtifactRef> {
    const fileStat = await stat(absPath);
    if (!fileStat.isFile() || fileStat.size === 0) {
      throw new FacadeError(
        "JOB_FAILED",
        `provider reported success but the artifact is missing or empty: ${absPath}`,
      );
    }
    if (expectedBytes !== undefined && expectedBytes > fileStat.size) {
      throw new FacadeError(
        "JOB_FAILED",
        `provider wrote fewer bytes (${fileStat.size}) than it reported (${expectedBytes}) for ${absPath}`,
      );
    }
    return {
      kind,
      format,
      path: absPath,
      sizeBytes: fileStat.size,
      sha256: await this.sha256File(absPath),
      sourceRevision,
    };
  }

  /** Terminalize a finished export: verify containment + hash the MP4. */
  private async finalizeExport(
    jobId: string,
    sourceRevision: number,
    completion: { path: string; sizeBytes: number; route: string },
  ): Promise<void> {
    try {
      const artifactRoot = this.requireArtifactRoot("export.finalize");
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
      const artifact = await this.artifactRefFor(
        resolution.path,
        "video",
        "mp4",
        sourceRevision,
        completion.sizeBytes,
      );
      this.jobs.markDone(jobId, artifact, completion.route);
    } catch (error) {
      this.jobs.markError(jobId, {
        code: error instanceof FacadeError ? error.code : "JOB_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private jobView(job: JobRecord): JobStatusView {
    return {
      jobId: job.jobId,
      kind: job.kind,
      state: job.state,
      progress: job.progress ? { ...job.progress } : null,
      artifact: job.artifact ? { ...job.artifact } : null,
      error: job.error ? { ...job.error } : null,
      sourceRevision: job.sourceRevision,
      route: job.route,
      cancelRequested: job.cancelRequested,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private timelineDurationSec(project: Project): number {
    let maxEnd = 0;
    for (const track of project.timeline.tracks) {
      for (const clip of track.clips) {
        maxEnd = Math.max(maxEnd, clip.startTime + clip.duration);
      }
    }
    for (const clip of project.textClips ?? []) {
      maxEnd = Math.max(maxEnd, clip.startTime + clip.duration);
    }
    return maxEnd;
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
    const project = this.project as Project;
    return {
      revision: this.revision,
      project: structuredClone(project),
      counts: this.counts(project),
    };
  }

  private counts(project: Project): ProjectCounts {
    return {
      tracks: project.timeline.tracks.length,
      clips: project.timeline.tracks.reduce((n, t) => n + t.clips.length, 0),
      mediaItems: project.mediaLibrary.items.length,
      textOverlays: (project.textClips ?? []).length,
    };
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
