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
import { basename } from "node:path";
import { stat } from "node:fs/promises";

import { buildCapabilities, buildSessionDescription } from "./capabilities";
import { FacadeError, ok, toFailure, type FacadeResult } from "./errors";
import { IdempotencyLedger, stableStringify } from "./idempotency";
import {
  applyClipIdOverride,
  collectEntityIds,
  diffCreatedIds,
  opToCoreActions,
  validateEditOp,
} from "./ops";
import { createEmptyProject, DEFAULT_PROJECT_SETTINGS } from "./project-factory";
import type { ProjectRenderAdapter } from "./render/adapter";
import {
  hasUrlScheme,
  resolveContainedPathDetailed,
} from "./media/path-roots";
import { probeLocalMediaFile } from "./media/node-media-adapter";
import {
  isNonEmptyString,
  isNonNegativeInteger,
  isPositiveInteger,
  isPositiveNumber,
  validateObject,
  type ObjectSchema,
} from "./validate";
import type {
  Capabilities,
  EditApplyParams,
  EditApplyResult,
  MediaImportParams,
  MediaImportResult,
  OpApplied,
  ProjectCounts,
  ProjectCreateParams,
  ProjectCreateResult,
  ProjectState,
  SessionDescription,
  TimelineState,
} from "./types";

export interface AgentFacadeConfig {
  /**
   * Absolute roots that media.import may read from. Imports resolving
   * outside every root fail with zero side effects. Default: none (imports
   * are then rejected until the caller configures roots).
   */
  readonly mediaRoots?: readonly string[];
  /**
   * Reserved Slice-1b seam; no implementation ships in this slice. Injecting
   * an adapter changes NOTHING observable: Slice 1 has no preview/export verb
   * that could consume it, so capabilities.get keeps reporting both as
   * unavailable (see capabilities.ts).
   */
  readonly renderAdapter?: ProjectRenderAdapter;
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
  private chain: Promise<unknown> = Promise.resolve();

  constructor(config: AgentFacadeConfig = {}) {
    this.config = config;
  }

  /* ------------------------------ reads ------------------------------ */

  async sessionDescribe(): Promise<FacadeResult<SessionDescription>> {
    return ok(
      buildSessionDescription({
        mediaRoots: this.config.mediaRoots ?? [],
        ...(this.config.renderAdapter
          ? { renderAdapter: this.config.renderAdapter }
          : {}),
      }),
    );
  }

  async capabilitiesGet(): Promise<FacadeResult<Capabilities>> {
    return ok(
      buildCapabilities({
        mediaRoots: this.config.mediaRoots ?? [],
        ...(this.config.renderAdapter
          ? { renderAdapter: this.config.renderAdapter }
          : {}),
      }),
    );
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
