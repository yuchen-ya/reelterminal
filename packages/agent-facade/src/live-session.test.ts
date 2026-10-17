import { FACADE_VERBS } from "./types";
import { WORKSPACE_VERBS } from "./workspace-library";
/**
 * Live facade session tests: createLiveFacade over an
 * in-memory FakeLiveStore that owns a real Project, keeps revision and
 * contextRevision counters, CAS-checks applyActions exactly like the
 * renderer bridge must, records every committed batch, and can simulate a
 * concurrent human edit landing between the agent's snapshot read and its
 * apply. Covered: the visual.inspect read path and live/headless honesty, CAS conflict paths,
 * the access gate, the single-writer lease, live-unavailable
 * lifecycle verbs, snapshot preview/export with stub providers, the
 * file-backed-media honesty rule, idempotent replay, and dispose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActionExecutor } from "@reelterminal/core/actions/action-executor";
import { ActionHistory } from "@reelterminal/core/actions/action-history";
import type { Action } from "@reelterminal/core/types/actions";
import type { Project } from "@reelterminal/core/types/project";

import {
  createAgentFacade,
  createLiveFacade,
  LiveWriterLease,
  type LiveAgentFacade,
} from "./index";
import type { LivePersistedTaskRecord, LiveTaskInput, LiveTaskInputReferences, LiveTaskLifecycle } from "./live-session";
import { LiveStoreConflictError } from "./live-store";
import { stableStringify } from "./idempotency";
import type {
  LiveApplyActionsOptions,
  LiveEditorContext,
  LiveMediaImportRequest,
  LiveProjectStore,
} from "./live-store";
import { collectEntityIds, diffCreatedIdsByCategory } from "./ops";
import { createEmptyProject } from "./project-factory";
import type {
  ArtifactVerifier,
  ExportCallbacks,
  ExportProvider,
  ExportVideoRequest,
  ProviderPreflight,
  RenderProvider,
} from "./providers";
import { READ_ONLY_VERBS } from "./types";
import type { AnalysisGetParams, JobStatusView, MediaImportResult } from "./types";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { resolveToolFfmpeg, runToolProcess } from "./media/ffmpeg-bin";
import { saveAnalysisRecord } from "./analysis-records";
import { setSpeechVadModelFactoryForTests } from "./speech-vad";

const LIVE_AUDIO_TOOLCHAIN = await resolveToolFfmpeg();

/* --------------------------- FakeLiveStore --------------------------- */

interface RecordedBatch {
  readonly actions: readonly Action[];
  readonly opts: LiveApplyActionsOptions;
}

/**
 * In-memory LiveProjectStore with the Decision 1 implementation contract:
 * CAS BEFORE apply (stale ⇒ LiveStoreConflictError, nothing applied), one
 * revision bump per committed batch, createdIds diffed per action in creation
 * order — the ids that genuinely exist afterwards.
 */
class FakeLiveStore implements LiveProjectStore {
  project: Project;
  revision = 0;
  contextRevision = 0;
  context: LiveEditorContext = {
    contextRevision: 0,
    playheadSeconds: null,
    selectedClipIds: [],
    selectedTextIds: [],
    selectedMediaIds: [],
    timeRange: null,
    canvasPoint: null,
    references: {},
  };
  readonly batches: RecordedBatch[] = [];
  readonly mediaImports: Array<{
    readonly request: LiveMediaImportRequest;
    readonly opts: LiveApplyActionsOptions;
  }> = [];
  private readonly mediaImportReceipts = new Map<
    string,
    { payloadHash: string; result: MediaImportResult }
  >();
  editorControlError: Error | null = null;
  saveCount = 0;
  /** Test hook: fires inside applyActions BEFORE the CAS check (a human
      edit landing between the agent's snapshot read and its apply). */
  beforeApply: (() => void | Promise<void>) | null = null;

  constructor(project?: Project) {
    this.project = project ?? createEmptyProject("Live Demo");
  }

  async getIdentity() {
    return {
      projectId: this.project.id,
      projectName: this.project.name,
      workspaceId: "workspace-live-1",
      workspaceInstanceId: "runtime-live-1",
      windowId: "win-1",
    };
  }

  async getState() {
    return { project: structuredClone(this.project), revision: this.revision };
  }
  async listRequirements(params: import("./requirements").RequirementsListParams) {
    const { requirementsListView } = await import("./requirements");
    return requirementsListView(this.project.requirements?.items ?? [], this.revision, params);
  }
  async getRequirement(params: import("./requirements").RequirementsGetParams) {
    const { requirementsGetView } = await import("./requirements");
    return requirementsGetView(this.project.requirements?.items ?? [], this.revision, params);
  }

  async getContext(): Promise<LiveEditorContext> {
    return {
      ...this.context,
      contextRevision: this.contextRevision,
      selectedClipIds: [...this.context.selectedClipIds],
      selectedTextIds: [...this.context.selectedTextIds],
      selectedMediaIds: [...this.context.selectedMediaIds],
      timeRange: this.context.timeRange ? { ...this.context.timeRange } : null,
      canvasPoint: this.context.canvasPoint
        ? { ...this.context.canvasPoint }
        : null,
      references: this.context.references ? { ...this.context.references } : {},
    };
  }

  async getProjectChanges(params: import("./types").ProjectChangesParams) {
    return {
      fromRevision: params.sinceRevision,
      toRevision: this.revision,
      changes: [],
      nextCursor: null,
      requiresFullRefresh: params.sinceRevision < this.revision,
    };
  }

  async getHistory(params: import("./types").HistoryGetParams) {
    void params;
    return {
      revision: this.revision,
      available: true,
      canUndo: false,
      canRedo: false,
      undoCount: 0,
      redoCount: 0,
      entries: [],
    };
  }

  async historyControl(
    action: "undo" | "redo",
    opts: { expectedRevision: number; idempotencyKey?: string },
  ): Promise<Omit<import("./types").HistoryControlResult, "action">> {
    void action;
    void opts.idempotencyKey;
    if (opts.expectedRevision !== this.revision) {
      throw new LiveStoreConflictError("history revision conflict", {
        currentRevision: this.revision,
      });
    }
    this.revision += 1;
    return {
      revision: this.revision,
      canUndo: false,
      canRedo: true,
      replayed: false,
    };
  }

  async applyActions(
    actions: readonly Action[],
    opts: LiveApplyActionsOptions,
  ) {
    await this.beforeApply?.();
    // CAS first, nothing applied on mismatch (Decision 3/4).
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== this.revision) {
      throw new LiveStoreConflictError(
        `store revision conflict: expected ${opts.expectedRevision}, current is ${this.revision}`,
        { currentRevision: this.revision },
      );
    }
    if (
      opts.expectedContextRevision !== undefined &&
      opts.expectedContextRevision !== this.contextRevision
    ) {
      throw new LiveStoreConflictError(
        `store context revision conflict: expected ${opts.expectedContextRevision}, current is ${this.contextRevision}`,
        { currentContextRevision: this.contextRevision },
      );
    }
    const draft = structuredClone(this.project);
    const createdIds = {
      tracks: [] as string[],
      clips: [] as string[],
      textClips: [] as string[],
      transitions: [] as string[],
      subtitles: [] as string[],
    };
    const executor = new ActionExecutor(new ActionHistory());
    for (const action of actions) {
      const beforeAction = collectEntityIds(draft);
      const result = await executor.execute(action, draft);
      if (!result.success) {
        throw new Error(
          `store apply failed: ${result.error?.message ?? "unknown core error"}`,
        );
      }
      const actionCreated = diffCreatedIdsByCategory(
        beforeAction,
        collectEntityIds(draft),
      );
      createdIds.tracks.push(...actionCreated.tracks);
      createdIds.clips.push(...actionCreated.clips);
      createdIds.textClips.push(...actionCreated.textClips);
      createdIds.transitions.push(...actionCreated.transitions);
      createdIds.subtitles.push(...actionCreated.subtitles);
    }
    this.project = draft;
    this.revision += 1;
    this.batches.push({ actions, opts });
    return { revision: this.revision, createdIds };
  }

  async importMedia(
    request: LiveMediaImportRequest,
    opts: LiveApplyActionsOptions,
  ) {
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== this.revision) {
      throw new LiveStoreConflictError(
        `store revision conflict: expected ${opts.expectedRevision}, current is ${this.revision}`,
        { currentRevision: this.revision },
      );
    }
    const mediaId = `media-live-${this.mediaImports.length + 1}`;
    const draft = structuredClone(this.project);
    draft.mediaLibrary.items.push({
      id: mediaId,
      name: request.name,
      type: request.type,
      fileHandle: null,
      blob: null,
      metadata: {
        duration: request.metadata.durationSec,
        width: request.metadata.width,
        height: request.metadata.height,
        frameRate: request.metadata.frameRate,
        codec: request.metadata.codec,
        sampleRate: 0,
        channels: 0,
        fileSize: request.metadata.fileSize,
      },
      thumbnailUrl: null,
      waveformData: null,
      originalUrl: request.path,
      sourceFile: request.sourceFile,
    });
    this.project = draft;
    this.revision += 1;
    this.mediaImports.push({ request, opts });
    if (opts.idempotencyKey !== undefined) {
      const result: MediaImportResult = {
        revision: this.revision,
        mediaId,
        name: request.name,
        type: request.type,
        metadata: {
          durationSec: request.metadata.durationSec,
          width: request.metadata.width,
          height: request.metadata.height,
          frameRate: request.metadata.frameRate,
          codec: request.metadata.codec,
          fileSize: request.metadata.fileSize,
        },
        replayed: false,
      };
      this.mediaImportReceipts.set(opts.idempotencyKey, {
        payloadHash: stableStringify(opts.idempotencyPayload),
        result,
      });
    }
    return { revision: this.revision, mediaId };
  }

  async getMediaImportReplay(
    idempotencyKey: string,
    idempotencyPayload: unknown,
  ): Promise<MediaImportResult | null> {
    const receipt = this.mediaImportReceipts.get(idempotencyKey);
    if (!receipt) return null;
    if (stableStringify(idempotencyPayload) !== receipt.payloadHash) {
      throw new LiveStoreConflictError(
        `idempotency key "${idempotencyKey}" was already committed with a different request`,
      );
    }
    return { ...receipt.result, replayed: true };
  }

  async requestSave() {
    this.saveCount += 1;
    return { revision: this.revision };
  }

  async editorControl(
    params: import("./live-store").LiveEditorControlParams,
  ): Promise<import("./live-store").LiveEditorControlResult> {
    if (this.editorControlError) throw this.editorControlError;
    const context = this.context;
    if (
      params.expectedContextRevision !== undefined &&
      params.expectedContextRevision !== this.contextRevision
    ) {
      throw new LiveStoreConflictError("context conflict", {
        currentContextRevision: this.contextRevision,
      });
    }
    if (params.action === "seek") this.context = { ...context, playheadSeconds: params.timeSeconds ?? 0 };
    if (params.action === "select") {
      this.context = {
        ...context,
        selectedClipIds: (params.targets ?? []).filter((t) => t.kind === "clip").map((t) => t.id),
        selectedTextIds: (params.targets ?? []).filter((t) => t.kind === "text").map((t) => t.id),
        selectedMediaIds: (params.targets ?? []).filter((t) => t.kind === "media").map((t) => t.id),
      };
    }
    this.contextRevision += 1;
    return {
      action: params.action,
      playbackState: params.action === "play" ? "playing" : "paused",
      playheadSeconds: this.context.playheadSeconds ?? 0,
      selectedClipIds: this.context.selectedClipIds,
      selectedTextIds: this.context.selectedTextIds,
      selectedMediaIds: this.context.selectedMediaIds,
      revealedTargets: params.targets ?? [],
      contextRevision: this.contextRevision,
    };
  }

  /** Simulate a HUMAN edit: one action straight into the canonical store,
      one revision bump — no lease, no facade (Decision 6). */
  async humanEdit(action: Action): Promise<void> {
    const draft = structuredClone(this.project);
    const executor = new ActionExecutor(new ActionHistory());
    const result = await executor.execute(action, draft);
    if (!result.success) throw new Error("humanEdit failed");
    this.project = draft;
    this.revision += 1;
  }

  setContext(patch: Partial<LiveEditorContext>): void {
    this.context = { ...this.context, ...patch };
    this.contextRevision += 1;
  }
}

/* ------------------------------ stubs ------------------------------ */

function availablePreflight(details?: Record<string, unknown>): ProviderPreflight {
  return { available: true, ...(details ? { details } : {}) };
}

function stubRenderProvider(): RenderProvider {
  return {
    id: "stub-render",
    preflight: async () => availablePreflight(),
    renderFramePng: async (request) => {
      await mkdir(path.dirname(request.destPath), { recursive: true });
      const bytes = Buffer.from(
        `fake-png:${request.timeSec}:${request.width}x${request.height}`,
      );
      await writeFile(request.destPath, bytes);
      return { bytesWritten: bytes.length };
    },
  };
}

interface ExportStubControl {
  readonly provider: ExportProvider;
  readonly requests: ExportVideoRequest[];
  settle(jobId: string, mode: "done" | "hang"): void;
  awaitStart(jobId: string): Promise<void>;
}

function stubExportProvider(): ExportStubControl {
  const requests: ExportVideoRequest[] = [];
  const callbacksByJob = new Map<string, ExportCallbacks>();
  const started = new Map<string, () => void>();
  const control: ExportStubControl = {
    requests,
    provider: {
      id: "stub-export",
      preflight: async () => availablePreflight({ route: "stub" }),
      startExport: async (request, callbacks) => {
        requests.push(request);
        callbacksByJob.set(request.jobId, callbacks);
        started.get(request.jobId)?.();
        callbacks.onRunning();
      },
      cancel: async (jobId) => {
        callbacksByJob.get(jobId)?.onCancelled();
      },
    },
    settle(jobId, mode) {
      const callbacks = callbacksByJob.get(jobId);
      if (!callbacks) throw new Error(`no such job ${jobId}`);
      if (mode === "hang") return;
      void (async () => {
        const request = requests.find((r) => r.jobId === jobId);
        if (!request) throw new Error(`no request for ${jobId}`);
        const finalPath = path.join(request.jobDir, "output.mp4");
        await writeFile(finalPath, Buffer.from("stub-mp4-bytes"));
        callbacks.onDone({
          path: finalPath,
          sizeBytes: (await stat(finalPath)).size,
          route: "chromium-webcodecs",
          framesEncoded: 60,
        });
      })();
    },
    awaitStart(jobId) {
      return new Promise<void>((resolvePromise) => {
        if (requests.some((r) => r.jobId === jobId)) {
          resolvePromise();
          return;
        }
        started.set(jobId, resolvePromise);
      });
    },
  };
  return control;
}

/** Stub verifier that records the paths it was asked to probe. */
function stubArtifactVerifier(seenPaths: string[]): ArtifactVerifier {
  return {
    id: "stub-verifier",
    preflight: async () => availablePreflight(),
    verify: async (request) => {
      seenPaths.push(request.path);
      return {
        pass: true,
        probe: {
          container: "mp4",
          videoCodec: "h264",
          audioCodec: "aac",
          width: 320,
          height: 180,
          durationSec: 5,
          frameCount: 60,
          frameRate: 30,
          sizeBytes: (await stat(request.path)).size,
          sha256: "stub-sha256",
        },
        checks: [{ name: "container", pass: true, details: "stub probe" }],
      };
    },
  };
}

/** Poll job.status until the job reaches a terminal state (or time out). */
async function waitForJob(
  facade: LiveAgentFacade,
  jobId: string,
  timeoutMs = 5_000,
): Promise<import("./types").JobStatusView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await facade["job.status"]({ jobId });
    if (!status.ok) throw new Error(`job.status failed: ${status.error.message}`);
    const { state } = status.value;
    if (state === "done" || state === "error" || state === "cancelled") {
      return status.value;
    }
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} did not settle within ${timeoutMs}ms (state=${state})`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

/* --------------------------- scaffolding ---------------------------- */

let artifactRoot: string;
let store: FakeLiveStore;
let lease: LiveWriterLease;

function liveFacade(
  opts?: Partial<{
    access: "read-only" | "write" | (() => "read-only" | "write");
    sessionId: string;
    mediaRoots: readonly string[];
    deliveryRoots: readonly string[];
    renderProvider: RenderProvider;
    exportProvider: ExportProvider;
    artifactVerifier: ArtifactVerifier;
    workspaceLibrary: import("./workspace-library").WorkspaceLibraryBridge;
    store: LiveProjectStore;
    prepareRenderProject: (project: Project) => Promise<Project>;
    taskInputReferences: LiveTaskInputReferences;
    taskLifecycle: import("./live-session").LiveTaskLifecycle;
    executionScope: () => string;
  }>,
): LiveAgentFacade {
  return createLiveFacade({
    store: opts?.store ?? store,
    lease,
    sessionId: opts?.sessionId ?? "agent-1",
    access: opts?.access ?? "write",
    artifactRoot,
    ...(opts?.mediaRoots ? { mediaRoots: opts.mediaRoots } : {}),
    ...(opts?.deliveryRoots ? { deliveryRoots: opts.deliveryRoots } : {}),
    ...(opts?.renderProvider ? { renderProvider: opts.renderProvider } : {}),
    ...(opts?.exportProvider ? { exportProvider: opts.exportProvider } : {}),
    ...(opts?.artifactVerifier ? { artifactVerifier: opts.artifactVerifier } : {}),
    ...(opts?.workspaceLibrary ? { workspaceLibrary: opts.workspaceLibrary } : {}),
    ...(opts?.prepareRenderProject ? { prepareRenderProject: opts.prepareRenderProject } : {}),
    ...(opts?.taskInputReferences ? { taskInputReferences: opts.taskInputReferences } : {}),
    ...(opts?.taskLifecycle ? { taskLifecycle: opts.taskLifecycle } : {}),
    ...(opts?.executionScope ? { executionScope: opts.executionScope } : {}),
  });
}

function memoryTaskLifecycle(): { lifecycle: LiveTaskLifecycle; records: Map<string, LivePersistedTaskRecord> } {
  const records = new Map<string, LivePersistedTaskRecord>();
  const lifecycle: LiveTaskLifecycle = {
    list: () => [...records.values()].map((record) => structuredClone(record)),
    begin: (input: LiveTaskInput) => {
      const now = new Date().toISOString();
      const status: JobStatusView = {
        jobId: input.jobId,
        kind: input.kind,
        sourceRevision: input.sourceRevision,
        state: "queued",
        progress: null,
        artifact: null,
        result: null,
        error: null,
        deliveredTo: null,
        deliveryError: null,
        route: null,
        upscalingRequestedButInactive: false,
        cancelRequested: false,
        createdAt: now,
        updatedAt: now,
      };
      records.set(input.jobId, {
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        status,
        parameters: structuredClone(input.parameters),
      });
    },
    update: (status) => {
      const record = records.get(status.jobId);
      if (record) records.set(status.jobId, { ...record, status: structuredClone(status) });
    },
  };
  return { lifecycle, records };
}

async function writeFloatWav(
  root: string,
  durationSec: number,
  beatTimes: readonly number[] = [],
): Promise<string> {
  const sampleRate = 8000;
  const data = Buffer.alloc(sampleRate * durationSec * 4);
  for (const time of beatTimes) {
    for (let offset = 0; offset < 960; offset++) {
      const index = Math.round(time * sampleRate) + offset;
      if (index >= sampleRate * durationSec) break;
      const sample = 0.8 * Math.sin(offset * 0.06) * Math.exp(-offset / 220);
      data.writeFloatLE(sample, index * 4);
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  const filePath = path.join(root, `audio-${durationSec}.wav`);
  await writeFile(filePath, Buffer.concat([header, data]));
  return filePath;
}

const TEXT_BATCH = [
  { op: "track.add", trackType: "text", trackId: "t1" },
  { op: "text.create", text: "Hello live", startTime: 0, duration: 2 },
] as const;

beforeEach(async () => {
  artifactRoot = await mkdtemp(path.join(tmpdir(), "facade-live-"));
  store = new FakeLiveStore();
  lease = new LiveWriterLease();
});

afterEach(async () => {
  await rm(artifactRoot, { recursive: true, force: true });
});

/* ------------------------- editor.get_context ----------------------- */

describe("internal writer status snapshot", () => {
  it("reads session lease state without running provider preflights or registering a tool", async () => {
    const provider = stubRenderProvider();
    const preflight = vi.spyOn(provider, "preflight");
    const facade = createLiveFacade({ store, lease, sessionId: "status-writer", access: "write", renderProvider: provider, artifactRoot, mediaRoots: [] });
    expect(facade.readWriterStatus?.()).toBe(true);
    expect(facade.readWriterStatus?.()).toBe(true);
    expect(preflight).not.toHaveBeenCalled();
    expect(FACADE_VERBS as readonly string[]).not.toContain("readWriterStatus");
    facade.releaseWriterLease();
    expect(facade.readWriterStatus?.()).toBe(false);
    await facade.dispose();
    expect(facade.readWriterStatus?.()).toBe(false);
  });

  it("does not report a writer for read-only sessions or a lease held by another session", async () => {
    lease.acquire("other-writer");
    const blocked = liveFacade({ access: "write", sessionId: "blocked" });
    const reader = liveFacade({ access: "read-only", sessionId: "reader" });
    expect(blocked.readWriterStatus?.()).toBe(false);
    expect(reader.readWriterStatus?.()).toBe(false);
    expect(lease.holder()).toBe("other-writer");
    await blocked.dispose();
    await reader.dispose();
  });
});

describe("editor.get_context and visual.inspect read verbs", () => {
  it("live: reports the real editor context and identity (contextAvailable true)", async () => {
    store.setContext({
      playheadSeconds: 4.25,
      selectedClipIds: ["clip-a", "clip-b"],
      selectedTextIds: ["text-1"],
      selectedMediaIds: [],
      timeRange: { startSeconds: 1, endSeconds: 3.5 },
      canvasPoint: { x: 0.5, y: 0.85 },
      references: {},
    });
    const facade = liveFacade();
    const res = await facade["editor.get_context"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual({
      mode: "live",

      projectRevision: 0,
      contextAvailable: true,
      contextRevision: 1,
      playheadSeconds: 4.25,
      selectedClipIds: ["clip-a", "clip-b"],
      selectedTextIds: ["text-1"],
      selectedMediaIds: [],
      timeRange: { startSeconds: 1, endSeconds: 3.5 },
      canvasPoint: { x: 0.5, y: 0.85 },
      references: {},
      requirements: { ready: 0, inProgress: 0, ids: [] },
      identity: {
        projectId: store.project.id,
        projectName: "Live Demo",
        workspaceId: "workspace-live-1",
        workspaceInstanceId: "runtime-live-1",
        windowId: "win-1",
      },
    });
  });

  it("live editor.control preserves renderer NOT_FOUND details", async () => {
    const bridgeError = Object.assign(new Error("target missing"), {
      code: "NOT_FOUND",
      details: { target: { kind: "clip", id: "missing" } },
    });
    store.editorControlError = bridgeError;
    const res = await liveFacade()["editor.control"]({
      action: "select",
      targets: [{ kind: "clip", id: "missing" }],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({
      code: "NOT_FOUND",
      message: "editor.control: target missing",
      details: { target: { kind: "clip", id: "missing" } },
    });
  });

  it("live editor.control preserves stale context CONFLICT details", async () => {
    const res = await liveFacade()["editor.control"]({
      action: "pause",
      expectedContextRevision: 1,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("CONFLICT");
    expect(res.error.details).toEqual({ currentContextRevision: 0 });
  });

  it("editor.control rejects malformed targets as INVALID_PARAMS before the bridge", async () => {
    const res = await liveFacade()["editor.control"]({
      action: "select",
      targets: [{ kind: "bogus", id: "x" }],
    } as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(store.editorControlError).toBeNull();
  });

  it("headless: honest empty context (contextAvailable false), real revision and identity", async () => {
    const facade = createAgentFacade();
    await facade["project.create"]({ name: "Headless Demo" });
    const res = await facade["editor.get_context"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.mode).toBe("headless");


    expect(res.value.projectRevision).toBe(0);
    expect(res.value.contextAvailable).toBe(false);
    expect(res.value.contextRevision).toBeNull();
    expect(res.value.playheadSeconds).toBeNull();
    expect(res.value.selectedClipIds).toEqual([]);
    expect(res.value.selectedTextIds).toEqual([]);
    expect(res.value.timeRange).toBeNull();
    expect(res.value.canvasPoint).toBeNull();
    expect(res.value.identity.windowId).toBeNull();
    const state = await facade["project.get_state"]();
    if (state.ok) {
      expect(res.value.identity.projectId).toBe(state.value.project.id);
      expect(res.value.identity.projectName).toBe("Headless Demo");
    }
  });

  it("headless without a project: honest nulls, never fabricated", async () => {
    const facade = createAgentFacade();
    const res = await facade["editor.get_context"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.mode).toBe("headless");
    expect(res.value.projectRevision).toBe(0);
    expect(res.value.contextAvailable).toBe(false);
    expect(res.value.identity).toEqual({
      projectId: null,
      projectName: null,
      windowId: null,
    });
  });

  it("live: unknown params fail INVALID_PARAMS (closed empty schema)", async () => {
    const facade = liveFacade();
    const res = await facade["editor.get_context"]({ verbose: true } as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
  });

  it("headless edit.apply rejects expectedContextRevision INVALID_PARAMS with zero side effects", async () => {
    const facade = createAgentFacade();
    await facade["project.create"]({ name: "Ctx" });
    const res = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video" }],
      expectedContextRevision: 3,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(res.error.message).toContain("context revision unavailable in headless mode");
    const state = await facade["project.get_state"]();
    expect(state.ok && state.value.revision).toBe(0);
  });
});

/* ------------------------------ edit.apply --------------------------- */

describe("live edit.apply", () => {
  it("happy path: translates, CAS-passes, commits one batch, reports new revision + createdIds", async () => {
    const facade = liveFacade();
    const res = await facade["edit.apply"]({
      ops: [...TEXT_BATCH],
      expectedRevision: 0,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.revision).toBe(1);
    expect(res.value.replayed).toBe(false);
    expect(res.value.applied).toHaveLength(2);
    expect(res.value.applied[0]).toEqual({ op: "track.add", createdIds: ["t1"] });
    expect(res.value.applied[1]?.op).toBe("text.create");
    expect(res.value.applied[1]?.createdIds).toHaveLength(1);

    // The canonical store (not a facade copy) carries the mutation.
    expect(store.revision).toBe(1);
    expect(store.project.textClips?.[0]?.text).toBe("Hello live");
    expect(store.project.textClips?.[0]?.id).toBe(
      res.value.applied[1]?.createdIds[0],
    );
    // Exactly one store batch, labeled as one undo unit, CAS passed through.
    expect(store.batches).toHaveLength(1);
    expect(store.batches[0]?.opts.groupLabel).toBe("agent: edit.apply");
    expect(store.batches[0]?.opts.expectedRevision).toBe(0);
    // The actions are the SAME core actions headless emits.
    expect(store.batches[0]?.actions.map((a) => a.type)).toEqual([
      "track/add",
      "text/create",
    ]);
  });

  it("text.create creates the missing text track in the same live undo batch", async () => {
    const facade = liveFacade();
    const res = await facade["edit.apply"]({
      ops: [{ op: "text.create", text: "auto lane", startTime: 0, duration: 2 }],
      expectedRevision: 0,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const createdIds = res.value.applied[0]?.createdIds ?? [];
    expect(createdIds).toHaveLength(2);
    expect(store.project.timeline.tracks).toHaveLength(1);
    expect(store.project.timeline.tracks[0]?.type).toBe("text");
    expect(store.project.timeline.tracks[0]?.id).toBe(createdIds[0]);
    expect(store.project.textClips?.[0]?.id).toBe(createdIds[1]);
    expect(store.batches[0]?.actions.map((action) => action.type)).toEqual([
      "track/add",
      "text/create",
    ]);
  });

  it("mixed batch [text.create, clip.add]: every op gets the id of its own entity", async () => {
    // Seed one media item so clip.add has something to place.
    store.project.mediaLibrary.items.push({
      id: "m1",
      name: "seed.mp4",
      type: "video",
      fileHandle: null,
      blob: null,
      metadata: {
        duration: 6,
        width: 1920,
        height: 1080,
        frameRate: 30,
        codec: "h264",
        sampleRate: 48000,
        channels: 2,
        fileSize: 1024,
      },
      thumbnailUrl: null,
      waveformData: null,
    });
    const facade = liveFacade();
    const res = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "text", trackId: "t1" },
        { op: "text.create", text: "overlay", startTime: 0, duration: 2 },
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "clip.add", trackId: "v1", mediaId: "m1", startTime: 0 },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.applied).toHaveLength(4);
    expect(res.value.applied[0]).toEqual({ op: "track.add", createdIds: ["t1"] });
    // The text overlay id comes from the textClips bucket — not the "v1"
    // track or the clip a flat project-ordered diff would have handed over.
    const textId = store.project.textClips?.[0]?.id;
    expect(textId).toBeDefined();
    expect(res.value.applied[1]).toEqual({ op: "text.create", createdIds: [textId] });
    expect(res.value.applied[2]).toEqual({ op: "track.add", createdIds: ["v1"] });
    const clipId = store.project.timeline.tracks
      .find((t) => t.id === "v1")
      ?.clips[0]?.id;
    expect(clipId).toBeDefined();
    expect(res.value.applied[3]).toEqual({ op: "clip.add", createdIds: [clipId] });
  });

  it("workAsset multi expansion pins EVERY created lane and clip to the op", async () => {
    // Seed one media item so clip.add has something to place.
    store.project.mediaLibrary.items.push({
      id: "m1",
      name: "seed.mp4",
      type: "video",
      fileHandle: null,
      blob: null,
      metadata: {
        duration: 6,
        width: 1920,
        height: 1080,
        frameRate: 30,
        codec: "h264",
        sampleRate: 48000,
        channels: 2,
        fileSize: 1024,
      },
      thumbnailUrl: null,
      waveformData: null,
    });
    const facade = liveFacade();
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "clip.add", trackId: "v1", mediaId: "m1", startTime: 0 },
        { op: "track.add", trackType: "video", trackId: "v2" },
        { op: "clip.add", trackId: "v2", mediaId: "m1", startTime: 1 },
      ],
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const c1 = seeded.value.applied[1]?.createdIds[0]!;
    const c2 = seeded.value.applied[3]?.createdIds[0]!;

    // Capture creates an ASSET, not timeline entities — no createdIds live.
    const captured = await facade["edit.apply"]({
      ops: [{ op: "workAsset.capture", clipIds: [c1, c2] }],
    });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.value.applied[0]).toEqual({
      op: "workAsset.capture",
      createdIds: [],
    });
    const assetId = store.project.workAssets?.[0]?.id;
    expect(assetId).toBeDefined();

    const res = await facade["edit.apply"]({
      ops: [{ op: "workAsset.instantiate", workAssetId: assetId! }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const applied = res.value.applied[0];
    expect(applied.op).toBe("workAsset.instantiate");
    // The multi expansion's whole batch belongs to THIS op: 2 new lanes
    // first, then 2 clips — never handed to another op or dropped.
    expect(applied.createdIds).toHaveLength(4);
    const [laneA, laneB, clipA, clipB] = applied.createdIds;
    const trackIds = store.project.timeline.tracks.map((track) => track.id);
    expect(trackIds).toContain(laneA);
    expect(trackIds).toContain(laneB);
    expect(trackIds).not.toContain(clipA);
    const flatClips = store.project.timeline.tracks.flatMap(
      (track) => track.clips,
    );
    expect(flatClips.some((clip) => clip.id === clipA)).toBe(true);
    expect(flatClips.some((clip) => clip.id === clipB)).toBe(true);
    // Relative timing is preserved (seed spans: 0..(0+dur) and 1..(1+dur)).
    const anchorClip = flatClips.find((clip) => clip.id === clipA)!;
    const secondClip = flatClips.find((clip) => clip.id === clipB)!;
    expect(
      secondClip.startTime - anchorClip.startTime,
    ).toBe(1);
  });

  it("clip finishing ops move, split, retime and fade the canonical live project", async () => {
    store.project.mediaLibrary.items.push({
      id: "m1",
      name: "seed.mp4",
      type: "video",
      fileHandle: null,
      blob: null,
      metadata: {
        duration: 6,
        width: 1920,
        height: 1080,
        frameRate: 30,
        codec: "h264",
        sampleRate: 48000,
        channels: 2,
        fileSize: 1024,
      },
      thumbnailUrl: null,
      waveformData: null,
    });
    const facade = liveFacade();
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: "m1",
          startTime: 0,
          duration: 4,
          inPoint: 0,
          outPoint: 4,
        },
      ],
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const clipId = seeded.value.applied[1]!.createdIds[0]!;

    const arranged = await facade["edit.apply"]({
      ops: [
        { op: "clip.move", clipId, startTime: 2 },
        { op: "clip.split", clipId, time: 3.5 },
      ],
    });
    expect(arranged.ok).toBe(true);
    if (!arranged.ok) return;
    expect(arranged.value.applied[0]).toEqual({ op: "clip.move", createdIds: [] });
    expect(arranged.value.applied[1]?.op).toBe("clip.split");
    expect(arranged.value.applied[1]?.createdIds).toHaveLength(1);
    const rightClipId = arranged.value.applied[1]!.createdIds[0]!;

    const finished = await facade["edit.apply"]({
      ops: [
        { op: "clip.setSpeed", clipId: rightClipId, speed: 2 },
        { op: "clip.setReverse", clipId: rightClipId, reversed: true },
        {
          op: "clip.setTransform",
          clipId,
          transform: {
            position: { x: 80, y: -20 },
            scale: { x: 0.75, y: 0.75 },
            crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
          },
        },
        { op: "clip.setFade", clipId, fadeIn: 0.2, fadeOut: 0.4 },
      ],
    });
    expect(finished.ok).toBe(true);
    expect(store.batches.at(-1)?.actions.map((action) => action.type)).toEqual([
      "clip/setSpeed",
      "clip/setReverse",
      "transform/update",
      "audio/setFade",
    ]);
    const clips = store.project.timeline.tracks[0]!.clips;
    expect(clips.find((clip) => clip.id === clipId)).toMatchObject({
      startTime: 2,
      duration: 1.5,
      fade: { fadeIn: 0.2, fadeOut: 0.4 },
      transform: {
        position: { x: 80, y: -20 },
        scale: { x: 0.75, y: 0.75 },
        crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      },
    });
    expect(clips.find((clip) => clip.id === rightClipId)).toMatchObject({
      startTime: 3.5,
      duration: 1.25,
      speed: 2,
      reversed: true,
    });

    const duplicated = await facade["edit.apply"]({
      ops: [{ op: "clip.duplicate", clipId }],
    });
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    expect(duplicated.value.applied[0]?.op).toBe("clip.duplicate");
    expect(duplicated.value.applied[0]?.createdIds).toHaveLength(1);
    const duplicateId = duplicated.value.applied[0]!.createdIds[0]!;

    const transitioned = await facade["edit.apply"]({
      ops: [{
        op: "transition.add",
        clipAId: rightClipId,
        clipBId: duplicateId,
        type: "crossfade",
        duration: 0.5,
      }],
    });
    expect(transitioned.ok).toBe(true);
    if (!transitioned.ok) return;
    expect(transitioned.value.applied[0]?.op).toBe("transition.add");
    expect(transitioned.value.applied[0]?.createdIds).toHaveLength(1);

    const ramped = store.project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === rightClipId) as unknown as {
      speedKeyframes: Array<{ id: string; time: number; speed: number; easing: "linear" }>;
    };
    ramped.speedKeyframes = [
      { id: "speed-1", time: 0, speed: 2, easing: "linear" },
    ];
    const unsupported = await facade["edit.apply"]({
      ops: [{ op: "clip.split", clipId: rightClipId, time: 4 }],
    });
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.error.code).toBe("UNSUPPORTED");
  });

  it("writes full speed configuration atomically and maps live timeline points without changing context", async () => {
    store.project.mediaLibrary.items.push({
      id: "m-speed",
      name: "speed.mp4",
      type: "video",
      fileHandle: null,
      blob: null,
      metadata: {
        duration: 6,
        width: 320,
        height: 180,
        frameRate: 10,
        codec: "h264",
        sampleRate: 0,
        channels: 0,
        fileSize: 1024,
      },
      thumbnailUrl: null,
      waveformData: null,
    });
    const facade = liveFacade();
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v-speed" },
        { op: "clip.add", trackId: "v-speed", mediaId: "m-speed", startTime: 4, inPoint: 1, outPoint: 5 },
      ],
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const clipId = seeded.value.applied[1]!.createdIds[0]!;

    const speedConfig = {
      op: "clip.setSpeedConfig" as const,
      clipId,
      speed: 2,
      reversed: false,
      pitchCorrection: true,
      keyframes: [],
      freezeFrames: [{ sourceTime: 1.5, startTime: 0.5, duration: 0.5 }],
    };
    const stale = await facade["edit.apply"]({
      ops: [speedConfig],
      expectedRevision: store.revision - 1,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("CONFLICT");

    const params = { ops: [speedConfig], idempotencyKey: "live-speed-config" };
    const written = await facade["edit.apply"](params);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(store.batches.at(-1)?.actions.map((action) => action.type)).toEqual([
      "speed/setRampData",
    ]);
    expect(store.project.timeline.tracks[0]!.clips[0]!.duration).toBeCloseTo(2.5, 8);

    const replay = await facade["edit.apply"](params);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.revision).toBe(written.value.revision);

    const contextBefore = await store.getContext();
    const mapped = await facade["timeline.mapSourceTimes"]({
      clipId,
      timelineTimes: [4.25, 4.5, 4.75, 5],
      expectedRevision: store.revision,
    });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.value.mappings[1]).toMatchObject({
      mediaId: "m-speed",
      clipLocalTime: 0.5,
      sourceTimeFromInPoint: 1.5,
      sourceTime: 2.5,
      frozen: true,
      freezeFrameId: expect.any(String),
    });
    expect(mapped.value.mappings[2]?.frozen).toBe(true);
    expect(mapped.value.mappings[3]?.frozen).toBe(false);
    expect(mapped.value.revision).toBe(store.revision);
    expect(await store.getContext()).toEqual(contextBefore);

    const batchCount = store.batches.length;
    const revision = store.revision;
    const atomicFailure = await facade["edit.apply"]({
      ops: [speedConfig, { op: "clip.trim", clipId, outPoint: 4.5 }],
    });
    expect(atomicFailure.ok).toBe(false);
    if (!atomicFailure.ok) expect(atomicFailure.error.code).toBe("UNSUPPORTED");
    expect(store.batches).toHaveLength(batchCount);
    expect(store.revision).toBe(revision);
  });

  it("reports multiple split ids in op order rather than project traversal order", async () => {
    store.project.mediaLibrary.items.push({
      id: "m1",
      name: "seed.mp4",
      type: "video",
      fileHandle: null,
      blob: null,
      metadata: {
        duration: 6,
        width: 1920,
        height: 1080,
        frameRate: 30,
        codec: "h264",
        sampleRate: 48000,
        channels: 2,
        fileSize: 1024,
      },
      thumbnailUrl: null,
      waveformData: null,
    });
    const facade = liveFacade();
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "track.add", trackType: "video", trackId: "v2" },
        { op: "clip.add", trackId: "v1", mediaId: "m1", startTime: 0 },
        { op: "clip.add", trackId: "v2", mediaId: "m1", startTime: 0 },
      ],
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const v1ClipId = seeded.value.applied[2]!.createdIds[0]!;
    const v2ClipId = seeded.value.applied[3]!.createdIds[0]!;

    // Split the clip on the later project track first. A whole-project diff
    // would return the v1 child before the v2 child and cross-assign them.
    const split = await facade["edit.apply"]({
      ops: [
        { op: "clip.split", clipId: v2ClipId, time: 2 },
        { op: "clip.split", clipId: v1ClipId, time: 3 },
      ],
    });
    expect(split.ok).toBe(true);
    if (!split.ok) return;

    const v2ChildId = split.value.applied[0]!.createdIds[0]!;
    const v1ChildId = split.value.applied[1]!.createdIds[0]!;
    expect(
      store.project.timeline.tracks.find((track) => track.id === "v2")?.clips
        .some((clip) => clip.id === v2ChildId),
    ).toBe(true);
    expect(
      store.project.timeline.tracks.find((track) => track.id === "v1")?.clips
        .some((clip) => clip.id === v1ChildId),
    ).toBe(true);
  });

  it("stale expectedRevision → CONFLICT, store untouched (no batch recorded)", async () => {
    const facade = liveFacade();
    await store.humanEdit({
      type: "track/add",
      id: "human-1",
      timestamp: Date.now(),
      params: { trackType: "video" },
    });
    expect(store.revision).toBe(1);
    const res = await facade["edit.apply"]({
      ops: [...TEXT_BATCH],
      expectedRevision: 0, // the agent's stale view
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("CONFLICT");
    expect(res.error.details?.currentRevision).toBe(1);
    expect(store.batches).toHaveLength(0);
    expect(store.revision).toBe(1);
    expect(store.project.textClips ?? []).toHaveLength(0);
  });

  it("unguarded edit.apply still CASes: a concurrent human edit → CONFLICT, store untouched", async () => {
    const tracksBefore = store.project.timeline.tracks.length;
    const facade = liveFacade();
    store.beforeApply = async () => {
      // A human edit lands between the agent's snapshot read and apply.
      await store.humanEdit({
        type: "track/add",
        id: "human-mid-apply",
        timestamp: Date.now(),
        params: { trackType: "video" },
      });
    };
    const res = await facade["edit.apply"]({
      ops: [...TEXT_BATCH], // NO expectedRevision passed by the caller
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("CONFLICT");
    // Nothing from the agent batch was applied; only the human edit stands.
    expect(store.batches).toHaveLength(0);
    expect(store.revision).toBe(1);
    expect(store.project.timeline.tracks.length).toBe(tracksBefore + 1);
    expect(store.project.textClips ?? []).toHaveLength(0);
  });

  it("unguarded edit.apply auto-attaches the snapshot revision to the store CAS", async () => {
    const facade = liveFacade();
    const res = await facade["edit.apply"]({ ops: [...TEXT_BATCH] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.revision).toBe(1);
    // The batch reached the store guarded with the snapshot revision (0),
    // even though the caller passed no expectedRevision.
    expect(store.batches).toHaveLength(1);
    expect(store.batches[0]?.opts.expectedRevision).toBe(0);
  });

  it("stale expectedContextRevision → CONFLICT from the store CAS, nothing applied", async () => {
    store.setContext({ playheadSeconds: 2 }); // contextRevision → 1
    const facade = liveFacade();
    const res = await facade["edit.apply"]({
      ops: [...TEXT_BATCH],
      expectedContextRevision: 0, // stale: context moved since the agent read it
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("CONFLICT");
    expect(res.error.details?.currentContextRevision).toBe(1);
    expect(store.batches).toHaveLength(0);
    expect(store.revision).toBe(0);
  });

  it("fresh expectedContextRevision passes the store CAS", async () => {
    store.setContext({ playheadSeconds: 2 });
    const facade = liveFacade();
    const res = await facade["edit.apply"]({
      ops: [...TEXT_BATCH],
      expectedContextRevision: 1,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.revision).toBe(1);
    expect(store.batches[0]?.opts.expectedContextRevision).toBe(1);
  });

  it("concurrent human edit landing between the snapshot read and apply → store CAS rejects, agent retries at the new revision", async () => {
    const facade = liveFacade();
    // A human edit lands mid-flight: after the agent's getState snapshot,
    // before the store's CAS check inside applyActions (deterministic hook).
    store.beforeApply = async () => {
      await store.humanEdit({
        type: "track/add",
        id: "human-mid-flight",
        timestamp: Date.now(),
        params: { trackType: "video" },
      });
    };
    const stale = await facade["edit.apply"]({
      ops: [...TEXT_BATCH],
      expectedRevision: 0,
    });
    // The session fail-fast passed (revision was 0 at snapshot time); the
    // STORE's own CAS is what rejects the stale batch — the authority.
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe("CONFLICT");
    expect(stale.error.details?.currentRevision).toBe(1);
    expect(store.batches).toHaveLength(0);
    expect(store.project.textClips ?? []).toHaveLength(0);
    // The human's edit is untouched (it was never CAS-guarded — Decision 6).
    expect(store.project.timeline.tracks.some((t) => t.type === "video")).toBe(true);

    // The agent re-reads and retries at the fresh revision: now it commits.
    store.beforeApply = null;
    const ctx = await facade["project.get_state"]();
    expect(ctx.ok).toBe(true);
    if (!ctx.ok) return;
    const retry = await facade["edit.apply"]({
      ops: [...TEXT_BATCH],
      expectedRevision: ctx.value.revision,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.revision).toBe(ctx.value.revision + 1);
  });

  it("does not replay a previous project result when identity validation fails", async () => {
    const facade = liveFacade();
    const params = { ops: [{ op: "track.add" as const, trackType: "video" as const }], idempotencyKey: "guarded-retry" };
    expect((await facade["edit.apply"](params)).ok).toBe(true);
    vi.spyOn(store, "getIdentity").mockRejectedValueOnce(new LiveStoreConflictError("Project opening changed"));
    const retry = await facade["edit.apply"](params);
    expect(retry).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(store.batches).toHaveLength(1);
  });

  it("idempotencyKey replay returns the committed result without a second store batch", async () => {
    const facade = liveFacade();
    const first = await facade["edit.apply"]({
      ops: [...TEXT_BATCH],
      idempotencyKey: "edit-1",
    });
    expect(first.ok).toBe(true);
    const replay = await facade["edit.apply"]({
      ops: [...TEXT_BATCH],
      idempotencyKey: "edit-1",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok || !first.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.revision).toBe(first.value.revision);
    expect(replay.value.applied).toEqual(first.value.applied);
    expect(store.batches).toHaveLength(1);
    // Same key, different payload ⇒ CONFLICT.
    const clash = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video" }],
      idempotencyKey: "edit-1",
    });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error.code).toBe("CONFLICT");
  });

  it("the ledger is scoped per project: a project switch never replays the old project's result", async () => {
    const facade = liveFacade();
    const first = await facade["edit.apply"]({
      ops: [...TEXT_BATCH],
      idempotencyKey: "edit-switch",
    });
    expect(first.ok).toBe(true);
    const firstProjectId = store.project.id;

    // Simulate a project switch: the same seam now serves a DIFFERENT
    // project (the GUI opened another one).
    store.project = createEmptyProject("Switched Project");
    store.revision = 0;
    expect(store.project.id).not.toBe(firstProjectId);

    // Replaying the same key + payload must NOT serve the old project's
    // committed result — it executes fresh against the new project.
    const afterSwitch = await facade["edit.apply"]({
      ops: [...TEXT_BATCH],
      idempotencyKey: "edit-switch",
    });
    expect(afterSwitch.ok).toBe(true);
    if (!afterSwitch.ok) return;
    expect(afterSwitch.value.replayed).toBe(false);
    expect(store.project.textClips?.[0]?.text).toBe("Hello live");

    // …and within the SAME project the key still replays honestly.
    const sameProject = await facade["edit.apply"]({
      ops: [...TEXT_BATCH],
      idempotencyKey: "edit-switch",
    });
    expect(sameProject.ok).toBe(true);
    if (!sameProject.ok || !first.ok) return;
    expect(sameProject.value.replayed).toBe(true);
    expect(sameProject.value.applied).toEqual(afterSwitch.value.applied);
  });

  it("clip.add with an explicit clipId is honestly rejected in live mode", async () => {
    const facade = liveFacade();
    const res = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "clip.add", trackId: "v1", mediaId: "m1", startTime: 0, clipId: "my-clip" },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(res.error.message).toContain("clipId");
    expect(store.batches).toHaveLength(0);
  });

  it("op validation runs before any store read: malformed ops fail zero-side-effect", async () => {
    const facade = liveFacade();
    const res = await facade["edit.apply"]({
      ops: [{ op: "track.add", track_type: "video" } as never],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("INVALID_PARAMS");
    expect(store.batches).toHaveLength(0);
  });
});

/* ---------------------- work mode + access gate ---------------------- */

describe("work mode + access gate + writer lease", () => {
  it("rechecks access after asynchronous edit preparation before committing", async () => {
    let access: "read-only" | "write" = "write";
    let releaseStateRead!: () => void;
    let signalStateRead!: () => void;
    const stateReadGate = new Promise<void>((resolve) => { releaseStateRead = resolve; });
    const stateReadStarted = new Promise<void>((resolve) => { signalStateRead = resolve; });
    const getState = store.getState.bind(store);
    store.getState = async () => {
      signalStateRead();
      await stateReadGate;
      return getState();
    };
    const facade = liveFacade({ access: () => access });
    const applying = facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video" }],
    });
    await stateReadStarted;

    access = "read-only";
    releaseStateRead();
    const result = await applying;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    expect(store.batches).toHaveLength(0);
  });

  it("observes an explicit read-only to write recovery and acquires lazily", async () => {
    let access: "read-only" | "write" = "read-only";
    const facade = liveFacade({ access: () => access });

    const denied = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video" }],
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");
    expect(lease.holder()).toBeNull();

    access = "write";
    const applied = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video" }],
    });
    expect(applied.ok).toBe(true);
    expect(lease.holder()).toBe("agent-1");
    const described = await facade["session.describe"]();
    expect(described.ok && described.value.access).toBe("write");
    expect(described.ok && described.value.writer).toBe(true);
  });

  it(
    "read-only access rejects mutations",
    async () => {
      const facade = liveFacade({ access: "read-only" });
      // All nine read-only verbs are allowed through the gate.
      expect((await facade["session.describe"]()).ok).toBe(true);
      expect((await facade["capabilities.get"]()).ok).toBe(true);
      expect((await facade["project.get_state"]()).ok).toBe(true);
      expect((await facade["timeline.get"]()).ok).toBe(true);
      expect((await facade["editor.get_context"]()).ok).toBe(true);
      const jobStatus = await facade["job.status"]({ jobId: "job-none" });
      expect(jobStatus.ok).toBe(false);
      if (!jobStatus.ok) expect(jobStatus.error.code).toBe("NOT_FOUND");
      const verify = await facade["verify.artifact"]({ path: "/x.mp4" });
      expect(verify.ok).toBe(false);
      if (!verify.ok) expect(verify.error.code).toBe("UNSUPPORTED");
      expect(READ_ONLY_VERBS).toContain("media.inspect");

      // Every non-read-only verb is FORBIDDEN, and the gate fires BEFORE
      // param validation (an empty/invalid payload is still FORBIDDEN).
      const writeCalls: Array<
        [string, Promise<{ ok: boolean; error?: { code: string } }>]
      > = [
        ["project.create", facade["project.create"]({ name: "X" })],
        ["project.open", facade["project.open"]({ path: "/x" })],
        [
          "project.save",
          facade["project.save"]({
            projectId: "project-1",
            workspaceId: "workspace-1",
            expectedRevision: 0,
            idempotencyKey: "save-1",
          }),
        ],
        ["project.rename", facade["project.rename"]({ name: "Nope" })],
        ["media.import", facade["media.import"]({ path: "/x.mp4" })],
        [
          "edit.apply",
          facade["edit.apply"]({
            ops: [{ op: "track.add", trackType: "video" }],
          }),
        ],
        ["preview.render_frame", facade["preview.render_frame"]({ timeSec: 0 })],
        ["export.start", facade["export.start"]({})],
        ["job.cancel", facade["job.cancel"]({ jobId: "job-none" })],
      ];
      for (const [verb, call] of writeCalls) {
        const res = await call;
        expect(res.ok, verb).toBe(false);
        if (!res.ok) {
          expect(res.error?.code, verb).toBe("FORBIDDEN");
        }
      }
      expect(store.batches).toHaveLength(0);
      expect(store.saveCount).toBe(0);
    },
  );

  it("lease held by another session: write verbs fail CONFLICT naming the holder; reads still work", async () => {
    expect(lease.acquire("agent-other")).toBe(true);
    const facade = liveFacade({ sessionId: "agent-1" }); // acquire fails
    const describeRes = await facade["session.describe"]();
    expect(describeRes.ok).toBe(true);
    if (describeRes.ok) {
      expect(describeRes.value.writer).toBe(false);
      expect(describeRes.value.leaseHolder).toBe("agent-other");

      expect(describeRes.value.access).toBe("write");
      expect(describeRes.value.sessionId).toBe("agent-1");
    }
    const edit = await facade["edit.apply"]({ ops: [...TEXT_BATCH] });
    expect(edit.ok).toBe(false);
    if (!edit.ok) {
      expect(edit.error.code).toBe("CONFLICT");
      expect(edit.error.details?.leaseHolder).toBe("agent-other");
    }
    const save = await facade["project.save"]({
      projectId: "project-1",
      workspaceId: "workspace-1",
      expectedRevision: 0,
      idempotencyKey: "save-1",
    });
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.error.code).toBe("CONFLICT");
    expect((await facade["timeline.get"]()).ok).toBe(true);
    expect(store.batches).toHaveLength(0);
  });

  it("lease unit semantics: single holder, re-acquire by holder is a no-op success, only holder releases", () => {
    const l = new LiveWriterLease();
    expect(l.holder()).toBeNull();
    expect(l.acquire("a")).toBe(true);
    expect(l.acquire("a")).toBe(true); // re-acquire: no-op success
    expect(l.acquire("b")).toBe(false);
    expect(l.holder()).toBe("a");
    l.release("b"); // not the holder: no-op
    expect(l.holder()).toBe("a");
    l.release("a");
    expect(l.holder()).toBeNull();
    expect(l.acquire("b")).toBe(true);
  });

  it("dispose releases the lease so a second session can write", async () => {
    const first = liveFacade({ sessionId: "agent-1" });
    expect(lease.holder()).toBe("agent-1");
    await first.dispose();
    expect(lease.holder()).toBeNull();
    const second = liveFacade({ sessionId: "agent-2" });
    const res = await second["edit.apply"]({ ops: [...TEXT_BATCH] });
    expect(res.ok).toBe(true);
  });

  it("an inactivity release preserves the session ledger and lazily reacquires", async () => {
    const facade = liveFacade({ sessionId: "agent-1" });
    const params = {
      idempotencyKey: "survives-heartbeat-gap",
      ops: [...TEXT_BATCH],
    };
    const first = await facade["edit.apply"](params);
    expect(first.ok).toBe(true);
    expect(store.batches).toHaveLength(1);

    facade.releaseWriterLease();
    expect(lease.holder()).toBeNull();
    const idle = await facade["session.describe"]();
    expect(idle.ok && idle.value.writer).toBe(false);

    const replay = await facade["edit.apply"](params);
    expect(replay.ok).toBe(true);
    if (!replay.ok || !first.ok) return;
    expect(replay.value).toMatchObject({
      replayed: true,
      revision: first.value.revision,
      applied: first.value.applied,
    });
    expect(store.batches).toHaveLength(1);
    expect(lease.holder()).toBe("agent-1");
  });

  it("a writer-less session acquires the freed lease at its next write (no re-creation)", async () => {
    const first = liveFacade({ sessionId: "agent-1" });
    // Constructed while agent-1 holds the lease: writer-less.
    const second = liveFacade({ sessionId: "agent-2" });
    const blocked = await second["edit.apply"]({ ops: [...TEXT_BATCH] });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.code).toBe("CONFLICT");
      expect(blocked.error.details?.leaseHolder).toBe("agent-1");
    }

    // The holder goes away (for example, the live session is disabled) — the
    // lease is released.
    await first.dispose();
    expect(lease.holder()).toBeNull();

    // The SAME second session's next write acquires the lease at the gate
    // instead of failing CONFLICT forever with a stale holder story.
    const res = await second["edit.apply"]({ ops: [...TEXT_BATCH] });
    expect(res.ok).toBe(true);
    expect(lease.holder()).toBe("agent-2");
    const describe = await second["session.describe"]();
    expect(describe.ok && describe.value.writer).toBe(true);
  });

  it("a disposed session does not resurrect as the writer", async () => {
    const first = liveFacade({ sessionId: "agent-1" });
    const second = liveFacade({ sessionId: "agent-2" });
    await second.dispose(); // never held the lease; now inert
    await first.dispose();
    expect(lease.holder()).toBeNull();
    const res = await second["edit.apply"]({ ops: [...TEXT_BATCH] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("CONFLICT");
    expect(lease.holder()).toBeNull();
  });

  it("session.describe mirrors the headless shape plus live fields", async () => {
    const facade = liveFacade();
    const res = await facade["session.describe"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.runtime).toBe("live");



    expect(res.value.access).toBe("write");
    expect(res.value.writer).toBe(true);
    expect(res.value.leaseHolder).toBe("agent-1");
    expect(res.value.sessionId).toBe("agent-1");
    expect(res.value.verbs).toHaveLength(FACADE_VERBS.length);
    expect(res.value.stepLetters.createProject).toBe("X");
    expect(res.value.stepLetters.importLocalMedia).toBe("X");
  });

  it("capabilities.get reports runtime live and honestly lists the unavailable verbs", async () => {
    const facade = liveFacade();
    const res = await facade["capabilities.get"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.runtime).toBe("live");
    expect(res.value.unavailableVerbs).toEqual([
      "project.open",
      "media.import",
      "material.list",
      "material.get",
      "material.create",
      "material.update",
      "material.batch_update",
      "material.remove",
      "material.attach",
      "material.undo",
      "project.create",
      "project.save",
      ...WORKSPACE_VERBS,
    ]);
    expect(res.value.mediaImport.available).toBe(false);
    expect(res.value.mediaImport.reason).toContain("media roots");
    expect(res.value.visualInspection.details?.fileBackedMediaRequired).toBe(true);
  });
});

/* --------------------- live-unavailable lifecycle -------------------- */

describe("live-unavailable verbs (Decision 11)", () => {
  it("project.create fails without a workspace manager; project.open / media.import are unavailable", async () => {
    const facade = liveFacade();
    const create = await facade["project.create"]({ name: "Nope" });
    expect(create.ok).toBe(false);
    if (!create.ok) {
      expect(create.error.code).toBe("UNSUPPORTED");
      expect(create.error.message).toContain("workspace manager bridge");
    }
    const open = await facade["project.open"]({ path: "/tmp/x.openreel.json" });
    expect(open.ok).toBe(false);
    if (!open.ok) expect(open.error.code).toBe("UNSUPPORTED");
    const imp = await facade["media.import"]({ path: "/tmp/x.mp4" });
    expect(imp.ok).toBe(false);
    if (!imp.ok) expect(imp.error.code).toBe("UNSUPPORTED");
  });

  it("project.save creates a node through the explicit workspace bridge", async () => {
    const workspaceLibrary = vi.fn(async () => ({
      ok: true as const,
      result: { node: { id: "node-1" }, revision: 1, replayed: false },
    }));
    const facade = liveFacade({ workspaceLibrary });
    await facade["edit.apply"]({ ops: [...TEXT_BATCH] });
    const res = await facade["project.save"]({
      projectId: store.project.id,
      workspaceId: "workspace-1",
      expectedRevision: 1,
      idempotencyKey: "save-node-1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual({ revision: 1, nodeId: "node-1", replayed: false });
    expect(workspaceLibrary).toHaveBeenCalledWith(expect.objectContaining({
      verb: "node.save",
      params: expect.objectContaining({ projectId: store.project.id, workspaceId: "workspace-1", expectedRevision: 1 }),
    }));
    expect(store.saveCount).toBe(0);
    expect(store.revision).toBe(1);
  });

  it("project.rename uses the canonical store action, CAS, and idempotency", async () => {
    const facade = liveFacade();
    const renamed = await facade["project.rename"]({
      name: "  Renamed Live Project  ",
      expectedRevision: 0,
      idempotencyKey: "rename-live-1",
    });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.value).toMatchObject({
      revision: 1,
      previousName: "Live Demo",
      name: "Renamed Live Project",
      replayed: false,
    });
    expect(store.project.name).toBe("Renamed Live Project");
    expect(store.batches.at(-1)?.actions[0]?.type).toBe("project/rename");

    const replay = await facade["project.rename"]({
      name: "Renamed Live Project",
      expectedRevision: 0,
      idempotencyKey: "rename-live-1",
    });
    expect(replay.ok && replay.value.replayed).toBe(true);
    expect(store.revision).toBe(1);

    const stale = await facade["project.rename"]({
      name: "Stale Name",
      expectedRevision: 0,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("CONFLICT");
    expect(store.project.name).toBe("Renamed Live Project");
  });
});

describe("live media.import through the canonical store bridge", () => {
  it("probes and imports an absolute file, with the store revision as a CAS", async () => {
    const mediaRoot = await mkdtemp(path.join(artifactRoot, "media-"));
    const inputPath = writeTinyMp4(mediaRoot);
    const facade = liveFacade({ mediaRoots: [mediaRoot] });

    const caps = await facade["capabilities.get"]();
    expect(caps.ok && caps.value.mediaImport.available).toBe(true);
    expect(caps.ok && caps.value.unavailableVerbs).toEqual([
      "project.open",
      "material.list",
      "material.get",
      "material.create",
      "material.update",
      "material.batch_update",
      "material.remove",
      "material.attach",
      "material.undo",
      "project.create",
      "project.save",
      ...WORKSPACE_VERBS,
    ]);

    const res = await facade["media.import"]({
      path: inputPath,
      name: "Opening shot",
      expectedRevision: 0,
      idempotencyKey: "import-1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({
      revision: 1,
      name: "Opening shot",
      type: "video",
      replayed: false,
      metadata: {
        durationSec: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
        fileSize: expect.any(Number),
      },
    });
    expect(store.mediaImports).toHaveLength(1);
    expect(store.mediaImports[0]?.opts).toEqual({
      groupLabel: "agent: media.import",
      expectedRevision: 0,
      idempotencyKey: "import-1",
      idempotencyPayload: { path: inputPath, name: "Opening shot" },
    });
    expect(store.mediaImports[0]?.request.path).toMatch(/[\\/]tiny-6s\.mp4$/);
    expect(store.project.mediaLibrary.items[0]).toMatchObject({
      id: res.value.mediaId,
      originalUrl: store.mediaImports[0]?.request.path,
      name: "Opening shot",
    });

    // Exact retries replay the committed result without probing or adding a
    // second canonical media item; this remains true after the source goes
    // away, matching the headless idempotency contract.
    await rm(inputPath, { force: true });
    const restartedFacade = liveFacade({ mediaRoots: [mediaRoot] });
    const replay = await restartedFacade["media.import"]({
      path: inputPath,
      name: "Opening shot",
      expectedRevision: 999,
      idempotencyKey: "import-1",
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.replayed).toBe(true);
      expect(replay.value.mediaId).toBe(res.value.mediaId);
      expect(replay.value.revision).toBe(1);
    }
    expect(store.mediaImports).toHaveLength(1);

    const conflictingReplay = await liveFacade({ mediaRoots: [mediaRoot] })["media.import"]({
      path: `${inputPath}.different`,
      name: "Opening shot",
      expectedRevision: 999,
      idempotencyKey: "import-1",
    });
    expect(conflictingReplay.ok).toBe(false);
    if (!conflictingReplay.ok) expect(conflictingReplay.error.code).toBe("CONFLICT");
  });

  it("enforces absolute root containment and revision precedence", async () => {
    const mediaRoot = await mkdtemp(path.join(artifactRoot, "media-"));
    const outsideRoot = await mkdtemp(path.join(artifactRoot, "outside-"));
    const inputPath = writeTinyMp4(mediaRoot);
    const facade = liveFacade({ mediaRoots: [mediaRoot] });

    const stale = await facade["media.import"]({
      path: path.join(mediaRoot, "missing.mp4"),
      expectedRevision: 4,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("CONFLICT");

    // A non-absolute path must be refused. path.relative only yields a
    // relative string when both paths share a drive/root; across drives on
    // Windows (e.g. repo on E:, tmpdir on C:) it returns an absolute path,
    // so fall back to a guaranteed-relative string with the same meaning.
    const relativeString = path.relative(process.cwd(), inputPath);
    const relative = await facade["media.import"]({
      path: path.isAbsolute(relativeString) ? "tiny-6s.mp4" : relativeString,
    });
    expect(relative.ok).toBe(false);
    if (!relative.ok) expect(relative.error.code).toBe("INVALID_PARAMS");

    const outsidePath = path.join(outsideRoot, "outside.mp4");
    await writeFile(outsidePath, Buffer.from("not-media"));
    const outside = await facade["media.import"]({ path: outsidePath });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.error.code).toBe("INVALID_PARAMS");
    expect(store.revision).toBe(0);
    expect(store.mediaImports).toHaveLength(0);
  });

  it("maps a store CAS race to CONFLICT without claiming a media import", async () => {
    const mediaRoot = await mkdtemp(path.join(artifactRoot, "media-"));
    const inputPath = writeTinyMp4(mediaRoot);
    const originalImport = store.importMedia.bind(store);
    store.importMedia = async (request, opts) => {
      store.revision += 1;
      return originalImport(request, opts);
    };
    const facade = liveFacade({ mediaRoots: [mediaRoot] });
    const result = await facade["media.import"]({ path: inputPath });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");
    expect(store.mediaImports).toHaveLength(0);
  });

  it("preserves typed renderer import failures instead of reporting INTERNAL", async () => {
    const mediaRoot = await mkdtemp(path.join(artifactRoot, "media-"));
    const inputPath = writeTinyMp4(mediaRoot);
    store.importMedia = async () => {
      const error = Object.assign(new Error("renderer could not decode file"), {
        code: "DECODE_ERROR",
        details: { path: inputPath },
      });
      throw error;
    };
    const facade = liveFacade({ mediaRoots: [mediaRoot] });
    const result = await facade["media.import"]({ path: inputPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_PARAMS");
      expect(result.error.details).toEqual({
        path: inputPath,
        bridgeCode: "DECODE_ERROR",
      });
    }
    expect(store.mediaImports).toHaveLength(0);
  });
});

/* -------------------- preview/export on snapshots -------------------- */

describe("live preview/export on a store snapshot (Decision 10)", () => {
  async function seedTextProject(): Promise<void> {
    // One text track + overlay via the store itself (a "human" edit).
    await store.humanEdit({
      type: "track/add",
      id: "seed-1",
      timestamp: Date.now(),
      params: { trackType: "text", trackId: "t1" },
    });
    await store.humanEdit({
      type: "text/create",
      id: "seed-2",
      timestamp: Date.now(),
      params: {
        clip: {
          id: "text-seed",
          trackId: "t1",
          startTime: 0,
          duration: 2,
          text: "seed",
          style: {},
          transform: {
            position: { x: 0.5, y: 0.5 },
            scale: { x: 1, y: 1 },
            rotation: 0,
            anchor: { x: 0.5, y: 0.5 },
            opacity: 1,
          },
          keyframes: [],
        },
      },
    });
  }

  it("preview.render_frame renders a text-only snapshot to a real artifact", async () => {
    await seedTextProject();
    const facade = liveFacade({ renderProvider: stubRenderProvider() });
    const res = await facade["preview.render_frame"]({ timeSec: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.revision).toBe(store.revision);
    expect(res.value.width).toBe(1920);
    expect(res.value.height).toBe(1080);
    const artifactStat = await stat(res.value.artifact.path);
    expect(artifactStat.size).toBeGreaterThan(0);
    expect(res.value.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The store is read, never mutated, by a preview.
    expect(store.batches).toHaveLength(0);
  });

  it("passes an immutable font-prepared snapshot to live preview", async () => {
    await seedTextProject();
    const font = {
      family: "Fixture Font",
      style: "normal",
      weight: "400",
      dataUrl: "data:font/woff2;base64,AA==",
    };
    let renderedProject: Project | undefined;
    const baseProvider = stubRenderProvider();
    const provider: RenderProvider = {
      ...baseProvider,
      renderFramePng: async (request) => {
        renderedProject = request.project;
        return baseProvider.renderFramePng(request);
      },
    };
    const prepareRenderProject = vi.fn(async (project: Project) => ({
      ...structuredClone(project),
      renderFonts: [font],
    }));
    const facade = liveFacade({ renderProvider: provider, prepareRenderProject });

    const result = await facade["preview.render_frame"]({ timeSec: 1 });

    expect(result.ok).toBe(true);
    expect(prepareRenderProject).toHaveBeenCalledOnce();
    expect(renderedProject?.renderFonts).toEqual([font]);
    expect(store.project.renderFonts).toBeUndefined();
  });

  it("preview replay mirrors headless: current top-level revision, truthful artifact.sourceRevision", async () => {
    await seedTextProject();
    const facade = liveFacade({ renderProvider: stubRenderProvider() });
    const first = await facade["preview.render_frame"]({
      timeSec: 1,
      idempotencyKey: "pv-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const renderedRevision = store.revision;
    expect(first.value.revision).toBe(renderedRevision);
    expect(first.value.artifact.sourceRevision).toBe(renderedRevision);

    // A human edit moves the revision AFTER the PNG was rendered.
    await store.humanEdit({
      type: "track/add",
      id: "later-human",
      timestamp: Date.now(),
      params: { trackType: "video" },
    });
    expect(store.revision).toBe(renderedRevision + 1);

    const replay = await facade["preview.render_frame"]({
      timeSec: 1,
      idempotencyKey: "pv-1",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    // Headless parity (session.ts preview.render_frame replay): the
    // top-level revision is the CURRENT one; the artifact ref keeps the
    // truth about which snapshot the PNG was actually rendered from.
    expect(replay.value.revision).toBe(renderedRevision + 1);
    expect(replay.value.artifact.sourceRevision).toBe(renderedRevision);
    expect(replay.value.artifact.path).toBe(first.value.artifact.path);
  });

  it("visual.inspect samples the canonical live snapshot and returns bounded frame artifacts", async () => {
    await seedTextProject();
    const facade = liveFacade({ renderProvider: stubRenderProvider() });
    const res = await facade["visual.inspect"]({
      timeRange: { startSec: 0.25, endSec: 1.75 },
      sampleCount: 2,
      width: 320,
      height: 180,
      expectedRevision: store.revision,
      idempotencyKey: "live-visual-1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.sourceRevision).toBe(store.revision);
    expect(res.value.frames).toHaveLength(2);
    expect(res.value.frames.map((frame) => frame.timeSec)).toEqual([0.25, 1.75]);
    expect(res.value.contactSheet).toBeNull();
    expect(res.value.limitations.join(" ")).toContain("individual frame PNGs");
    expect((await stat(res.value.frames[0]!.artifact.path)).size).toBeGreaterThan(0);
    expect(store.batches).toHaveLength(0);

    const replay = await facade["visual.inspect"]({
      timeRange: { startSec: 0.25, endSec: 1.75 },
      sampleCount: 2,
      width: 320,
      height: 180,
      idempotencyKey: "live-visual-1",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.frames[0]?.artifact.path).toBe(res.value.frames[0]?.artifact.path);

    const clash = await facade["visual.inspect"]({
      timeRange: { startSec: 0.25, endSec: 1.75 },
      sampleCount: 1,
      idempotencyKey: "live-visual-1",
    });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error.code).toBe("CONFLICT");

    await rm(res.value.frames[0]!.artifact.path, { force: true });
    const rerender = await facade["visual.inspect"]({
      timeRange: { startSec: 0.25, endSec: 1.75 },
      sampleCount: 2,
      width: 320,
      height: 180,
      idempotencyKey: "live-visual-1",
    });
    expect(rerender.ok).toBe(true);
    if (rerender.ok) expect(rerender.value.replayed).toBe(false);
  });

  it("visual.inspect rejects a stale expectedRevision before rendering", async () => {
    await seedTextProject();
    const facade = liveFacade({ renderProvider: stubRenderProvider() });
    const res = await facade["visual.inspect"]({
      timeRange: { startSec: 0, endSec: 1 },
      expectedRevision: store.revision + 1,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("CONFLICT");
    expect(await stat(path.join(artifactRoot, "visual")).catch(() => null)).toBeNull();
  });

  it("visual.inspect keeps published evidence immutable across different live requests", async () => {
    await seedTextProject();
    const facade = liveFacade({ renderProvider: stubRenderProvider() });
    // Same revision, sampleCount and raster; only the interval differs. The
    // old filename scheme rendered both into one contact-sheet/frame path.
    const first = await facade["visual.inspect"]({
      timeRange: { startSec: 0, endSec: 1 },
      sampleCount: 2,
      width: 320,
      height: 180,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await facade["visual.inspect"]({
      timeRange: { startSec: 1, endSec: 2 },
      sampleCount: 2,
      width: 320,
      height: 180,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    for (const [index, frame] of second.value.frames.entries()) {
      expect(frame.artifact.path).not.toBe(first.value.frames[index].artifact.path);
    }
    // The earlier response still resolves to exactly the bytes it returned.
    const { readFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    for (const artifact of first.value.frames.map((frame) => frame.artifact)) {
      const bytes = await readFile(artifact.path);
      expect(bytes.length).toBe(artifact.sizeBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
    }
  });

  it("passes a readable GUI-imported source path to the snapshot renderer", async () => {
    const sourcePath = path.join(artifactRoot, "human-shot.mp4");
    await writeFile(sourcePath, Buffer.from("desktop-imported-media"));
    const project = structuredClone(store.project) as unknown as {
      mediaLibrary: { items: Array<Record<string, unknown>> };
      timeline: {
        tracks: Array<Record<string, unknown>>;
        duration: number;
      };
    };
    project.mediaLibrary.items.push({
      id: "m-file",
      name: "human-shot.mp4",
      type: "video",
      fileHandle: null,
      blob: null,
      originalUrl: sourcePath,
      sourceFile: {
        name: "human-shot.mp4",
        size: 22,
        lastModified: Date.now(),
      },
      metadata: { duration: 5, width: 1920, height: 1080, frameRate: 30 },
      thumbnailUrl: null,
      waveformData: null,
    });
    project.timeline.tracks.push({
      id: "v1",
      type: "video",
      name: "Video 1",
      clips: [
        {
          id: "c1",
          trackId: "v1",
          mediaId: "m-file",
          startTime: 0,
          duration: 5,
          inPoint: 0,
          outPoint: 5,
        },
      ],
    });
    store.project = project as unknown as Project;

    const baseProvider = stubRenderProvider();
    const seenMediaFiles: Array<Readonly<Record<string, string>>> = [];
    const provider: RenderProvider = {
      ...baseProvider,
      renderFramePng: async (request) => {
        seenMediaFiles.push(request.mediaFiles);
        return baseProvider.renderFramePng(request);
      },
    };

    const res = await liveFacade({ renderProvider: provider })[
      "preview.render_frame"
    ]({ timeSec: 1 });

    expect(res.ok).toBe(true);
    expect(seenMediaFiles).toEqual([{ "m-file": sourcePath }]);
  });

  it("pixel-reading verbs reject blob/GUI-only media instead of rendering wrong pixels", async () => {
    // A clip referencing media with no absolute file path (blob-only).
    const project = structuredClone(store.project) as unknown as {
      mediaLibrary: { items: Array<Record<string, unknown>> };
      timeline: {
        tracks: Array<Record<string, unknown>>;
        duration: number;
      };
    };
    project.mediaLibrary.items.push({
      id: "m-blob",
      name: "blob-only.mp4",
      type: "video",
      fileHandle: null,
      blob: null,
      metadata: { duration: 5, width: 1920, height: 1080, frameRate: 30 },
      thumbnailUrl: null,
      waveformData: null,
      // no originalUrl, no sourceFile — GUI-only media
    });
    project.timeline.tracks.push({
      id: "v1",
      type: "video",
      name: "Video 1",
      clips: [
        {
          id: "c1",
          trackId: "v1",
          mediaId: "m-blob",
          startTime: 0,
          duration: 5,
          inPoint: 0,
          outPoint: 5,
        },
      ],
    });
    store.project = project as unknown as Project;
    store.revision += 1;

    const facade = liveFacade({ renderProvider: stubRenderProvider() });
    const res = await facade["preview.render_frame"]({ timeSec: 1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("UNSUPPORTED");
    expect(res.error.message).toContain("file-backed media");
    expect(res.error.details?.mediaIds).toEqual(["m-blob"]);

    const visual = await facade["visual.inspect"]({
      timeRange: { startSec: 0, endSec: 1 },
      sampleCount: 2,
    });
    expect(visual.ok).toBe(false);
    if (visual.ok) return;
    expect(visual.error.code).toBe("UNSUPPORTED");
    expect(visual.error.message).toContain("file-backed media");
    expect(visual.error.details?.mediaIds).toEqual(["m-blob"]);
  });

  it("export.start snapshots and runs through the job registry; job.cancel settles a hung job", async () => {
    await seedTextProject();
    const stub = stubExportProvider();
    const facade = liveFacade({ exportProvider: stub.provider });
    const started = await facade["export.start"]({ idempotencyKey: "exp-1" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.state).toBe("queued");
    expect(started.value.sourceRevision).toBe(store.revision);
    const jobId = started.value.jobId;

    // Idempotent replay reports the same job without a second provider call.
    const replay = await facade["export.start"]({ idempotencyKey: "exp-1" });
    expect(replay.ok && replay.value.replayed).toBe(true);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.project.textClips?.[0]?.id).toBe("text-seed");

    // The frozen snapshot does not see later edits.
    await facade["edit.apply"]({
      ops: [{ op: "text.update", overlayId: "text-seed", text: "changed after export" }],
    });
    expect(stub.requests[0]?.project.textClips?.[0]?.text).toBe("seed");

    await stub.awaitStart(jobId);
    stub.settle(jobId, "done");
    const done = await waitForJob(facade, jobId);
    expect(done.state).toBe("done");
    expect(done.artifact?.path.endsWith("output.mp4")).toBe(true);

    // A second job that hangs: job.cancel settles it to cancelled.
    const hung = await facade["export.start"]({ idempotencyKey: "exp-2" });
    expect(hung.ok).toBe(true);
    if (!hung.ok) return;
    await stub.awaitStart(hung.value.jobId);
    const cancelled = await facade["job.cancel"]({ jobId: hung.value.jobId });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.value.cancelRequested).toBe(true);
    const after = await waitForJob(facade, hung.value.jobId);
    expect(after.state).toBe("cancelled");
  });

  it("export.start destinationPath delivers into the workspace output directory (live/headless parity)", async () => {
    await seedTextProject();
    const deliveryRoot = await mkdtemp(path.join(tmpdir(), "facade-live-delivery-"));
    const outputDir = path.join(deliveryRoot, "jobs", "2026-09-03-demo", "output");
    await mkdir(outputDir, { recursive: true });
    try {
      const stub = stubExportProvider();
      const seenPaths: string[] = [];
      const facade = liveFacade({
        exportProvider: stub.provider,
        artifactVerifier: stubArtifactVerifier(seenPaths),
        deliveryRoots: [deliveryRoot],
      });
      const destination = path.join(outputDir, "promo.mp4");
      const started = await facade["export.start"]({ destinationPath: destination });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      await stub.awaitStart(started.value.jobId);
      stub.settle(started.value.jobId, "done");

      // Delivery is a post-done copy: poll job.status until it settles.
      const deadline = Date.now() + 5000;
      let view = await waitForJob(facade, started.value.jobId);
      while (
        view.deliveredTo === null &&
        view.deliveryError === null &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 10));
        view = await waitForJob(facade, started.value.jobId);
      }
      expect(view.state).toBe("done");
      expect(view.deliveryError).toBeNull();
      expect(view.deliveredTo).toContain(path.join("jobs", "2026-09-03-demo", "output", "promo.mp4"));

      // Live/headless parity: verify.artifact accepts the deliveredTo path
      // verbatim even though it lives outside artifactRoot.
      const verified = await facade["verify.artifact"]({ path: view.deliveredTo! });
      expect(verified.ok).toBe(true);
      if (verified.ok) expect(verified.value.pass).toBe(true);
      expect(seenPaths).toEqual([view.deliveredTo]);

      // Same rules as headless: a path outside jobs/<slug>/output fails fast.
      const bad = await facade["export.start"]({
        destinationPath: path.join(deliveryRoot, "elsewhere.mp4"),
      });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.code).toBe("INVALID_PARAMS");
      expect(stub.requests).toHaveLength(1); // no second provider call

      // And without delivery roots the destination is refused with the reason.
      const noRoots = liveFacade({ exportProvider: stubExportProvider().provider });
      const refused = await noRoots["export.start"]({ destinationPath: destination });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.code).toBe("INVALID_PARAMS");
        expect(refused.error.message).toContain("no delivery roots");
      }
    } finally {
      await rm(deliveryRoot, { recursive: true, force: true });
    }
  });

  it("dispose cancels live jobs and marks them cancelled", async () => {
    await seedTextProject();
    const stub = stubExportProvider();
    const facade = liveFacade({ exportProvider: stub.provider });
    const started = await facade["export.start"]({});
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await stub.awaitStart(started.value.jobId);
    await facade.dispose();
    const after = await facade["job.status"]({ jobId: started.value.jobId });
    expect(after.ok && after.value.state).toBe("cancelled");
    expect(lease.holder()).toBeNull();
  });

  it("uses the retained prepared project for the live export provider", async () => {
    await seedTextProject();
    const font = {
      family: "Fixture Font",
      style: "normal",
      weight: "400",
      dataUrl: "data:font/woff2;base64,AA==",
    };
    const retainedProject = { ...structuredClone(store.project), renderFonts: [font] };
    const refs: LiveTaskInputReferences = {
      retain: async () => retainedProject,
      release: async () => undefined,
    };
    const stub = stubExportProvider();
    const facade = liveFacade({ exportProvider: stub.provider, taskInputReferences: refs });

    const started = await facade["export.start"]({});

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await stub.awaitStart(started.value.jobId);
    expect(stub.requests[0]?.project.renderFonts).toEqual([font]);
    expect(store.project.renderFonts).toBeUndefined();
    await facade["job.cancel"]({ jobId: started.value.jobId });
  });

  it("disposal prevents an in-flight export start from launching", async () => {
    await seedTextProject();
    const stub = stubExportProvider();
    let releasePreflight!: () => void;
    let signalPreflightStarted!: () => void;
    const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve; });
    const preflightStarted = new Promise<void>((resolve) => { signalPreflightStarted = resolve; });
    const provider: ExportProvider = {
      ...stub.provider,
      preflight: async () => {
        signalPreflightStarted();
        await preflightGate;
        return availablePreflight();
      },
    };
    const facade = liveFacade({ exportProvider: provider });
    const starting = facade["export.start"]({});
    await preflightStarted;

    const disposing = facade.dispose();
    releasePreflight();
    const started = await starting;
    expect(started).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    await disposing;

    expect(stub.requests).toHaveLength(0);
    expect(lease.holder()).toBeNull();
  });

  it("disposal settles jobs when the export provider never answers cancellation", async () => {
    await seedTextProject();
    const stub = stubExportProvider();
    const provider: ExportProvider = {
      ...stub.provider,
      cancel: async () => new Promise<void>(() => undefined),
    };
    const facade = liveFacade({ exportProvider: provider });
    const started = await facade["export.start"]({});
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await stub.awaitStart(started.value.jobId);

    vi.useFakeTimers();
    try {
      const disposed = facade.dispose();
      await vi.advanceTimersByTimeAsync(10_000);
      await disposed;

      const after = await facade["job.status"]({ jobId: started.value.jobId });
      expect(after.ok && after.value.state).toBe("cancelled");
      expect(lease.holder()).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the cancellation deadline when the provider answers", async () => {
    await seedTextProject();
    const stub = stubExportProvider();
    const facade = liveFacade({ exportProvider: stub.provider });
    const started = await facade["export.start"]({});
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await stub.awaitStart(started.value.jobId);

    vi.useFakeTimers();
    try {
      const cancelled = await facade["job.cancel"]({ jobId: started.value.jobId });
      expect(cancelled.ok && cancelled.value.state).toBe("cancelled");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    await facade.dispose();
  });

  it("stale expectedRevision on preview/export → CONFLICT against the snapshot read", async () => {
    await seedTextProject();
    const facade = liveFacade({
      renderProvider: stubRenderProvider(),
      exportProvider: stubExportProvider().provider,
    });
    const preview = await facade["preview.render_frame"]({ timeSec: 1, expectedRevision: 0 });
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error.code).toBe("CONFLICT");
    const exportRes = await facade["export.start"]({ expectedRevision: 0 });
    expect(exportRes.ok).toBe(false);
    if (!exportRes.ok) expect(exportRes.error.code).toBe("CONFLICT");
  });
});

/* ----------------------- project markers (live) --------------------- */

describe("project markers over the live store seam", () => {
  it("mints sequential numbers, projects them sorted, and removes by number — identical to headless", async () => {
    const facade = liveFacade();
    const seeded = await facade["edit.apply"]({ ops: [...TEXT_BATCH] });
    expect(seeded.ok).toBe(true);

    const timeline0 = await facade["timeline.get"]();
    expect(timeline0.ok).toBe(true);
    if (!timeline0.ok) return;
    const textOverlayId = timeline0.value.textOverlays[0]!.id;
    expect(timeline0.value.markers).toEqual([]);

    const added = await facade["edit.apply"]({
      ops: [
        { op: "marker.add", target: { kind: "timeRange", start: 0, end: 1 }, label: "one" },
        { op: "marker.add", target: { kind: "text", textClipId: textOverlayId } },
        { op: "marker.add", target: { kind: "timeRange", start: 2, end: 3.5 } },
      ],
    });
    expect(added.ok).toBe(true);

    const timeline = await facade["timeline.get"]();
    expect(timeline.ok).toBe(true);
    if (!timeline.ok) return;
    expect(timeline.value.markers.map((m) => m.number)).toEqual([1, 2, 3]);
    expect(timeline.value.markers[0]).toMatchObject({
      target: { kind: "timeRange", start: 0, end: 1 },
      label: "one",
      color: "#f59e0b",
    });
    expect(timeline.value.markers[1]?.target).toEqual({
      kind: "text",
      textClipId: textOverlayId,
    });

    // The canonical store state carries the same watermark and items.
    expect(store.project.markers?.nextNumber).toBe(4);
    expect(store.project.markers?.items).toHaveLength(3);

    const removed = await facade["edit.apply"]({
      ops: [{ op: "marker.remove", number: 2 }],
    });
    expect(removed.ok).toBe(true);
    const after = await facade["timeline.get"]();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.markers.map((m) => m.number)).toEqual([1, 3]);

    const missed = await facade["edit.apply"]({
      ops: [{ op: "marker.remove", number: 2 }],
    });
    expect(missed.ok).toBe(false);
    if (!missed.ok) {
      expect(missed.error.code).toBe("NOT_FOUND");
      expect(missed.error.message).toContain("1, 3");
    }
  });

  it("rejects a dangling marker target live without touching the store", async () => {
    const facade = liveFacade();
    const revisionBefore = store.revision;
    const result = await facade["edit.apply"]({
      ops: [{ op: "marker.add", target: { kind: "clip", clipId: "ghost" } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    expect(store.revision).toBe(revisionBefore);
    expect(store.batches).toHaveLength(0);
  });
});

describe("live state-efficiency and history facade verbs", () => {
  it("dry-runs against a live snapshot without calling applyActions", async () => {
    const facade = liveFacade();
    const result = await facade["edit.validate"]({
      ops: [{ op: "track.add", trackType: "audio" }],
      expectedRevision: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ valid: true, estimatedRevision: 1 });
    expect(store.batches).toHaveLength(0);
    expect(store.revision).toBe(0);
  });

  it("delegates history control with unconditional CAS and facade replay", async () => {
    const facade = liveFacade();
    const first = await facade["history.control"]({
      action: "undo",
      expectedRevision: 0,
      idempotencyKey: "live-undo-1",
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value).toMatchObject({ revision: 1, replayed: false });
    const replay = await facade["history.control"]({
      action: "undo",
      expectedRevision: 0,
      idempotencyKey: "live-undo-1",
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value).toMatchObject({ revision: 1, replayed: true });
    expect(store.revision).toBe(1);
  });
});


describe("live cloud review is read-only", () => {
  it("uses a source snapshot without calling the canonical edit or playback path", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "unit-test-only");
    const network = vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"No reliable sync conclusion."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n'));
    vi.stubGlobal("fetch", network);
    const source = writeTinyMp4(artifactRoot);
    const importedStore = new FakeLiveStore();
    const facade = liveFacade({ store: importedStore, mediaRoots: [artifactRoot] });
    try {
      const imported = await facade["media.import"]({ path: source });
      if (!imported.ok) throw new Error(imported.error.message);
      const state = await importedStore.getState();
      const context = await facade["editor.get_context"]({});
      const request = { mediaId: imported.value.mediaId, analysisTypes: ["videoReview"] as const, startSec: 0, endSec: 1, cloudUpload: true, expectedRevision: state.revision, idempotencyKey: "cloud-live" };
      const started = await facade["media.analyze_start"](request);
      if (!started.ok) throw new Error(started.error.message);
      let job;
      for (let i = 0; i < 200; i++) {
        job = await facade["job.status"]({ jobId: started.value.jobId });
        if (job.ok && ["done", "error", "cancelled"].includes(job.value.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(job).toMatchObject({ ok: true, value: { state: "done", sourceRevision: state.revision, result: { summary: { videoReview: { provider: "qwen3.5-omni-flash" } } } } });
      if (!job?.ok) throw new Error("analysis did not finish");
      const result = job.value.result;
      if (!result || !("summary" in result)) throw new Error("video review returned no analysis result");
      const recordId = (result.summary.analysisRecord as { id?: string } | undefined)?.id;
      expect(recordId).toBeTruthy();
      const analysisRecord = await facade["analysis.get"]({ recordId: recordId! });
      expect(analysisRecord).toMatchObject({
        ok: true,
        value: { projectId: importedStore.project.id },
      });
      expect(await importedStore.getState()).toEqual(state);
      expect(await facade["editor.get_context"]({})).toEqual(context);
      expect(await facade["media.analyze_start"](request)).toMatchObject({ ok: true, value: { replayed: true, jobId: started.value.jobId } });
      expect(network).toHaveBeenCalledTimes(1);
    } finally { facade.dispose(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });
});

describe("live local audio analysis parity", () => {
  it("removes a saved record when the completion checkpoint fails", async () => {
    const mediaRoot = await mkdtemp(path.join(artifactRoot, "live-audio-checkpoint-"));
    const sourcePath = await writeFloatWav(mediaRoot, 6, [.5, 1, 1.5, 2, 2.5, 3]);
    const localStore = new FakeLiveStore();
    const facade = liveFacade({
      store: localStore,
      mediaRoots: [mediaRoot],
      taskLifecycle: {
        list: () => [],
        begin: () => undefined,
        update: (job) => {
          if (job.state === "done") throw new Error("checkpoint unavailable");
        },
      },
    });
    try {
      const imported = await facade["media.import"]({ path: sourcePath });
      if (!imported.ok) throw new Error(imported.error.message);
      const started = await facade["media.analyze_start"]({ mediaId: imported.value.mediaId, analysisTypes: ["audioSummary"] });
      if (!started.ok) throw new Error(started.error.message);
      const job = await waitForJob(facade, started.value.jobId, 15000);
      expect(job).toMatchObject({ state: "error", result: null, error: { code: "BATCH_PERSISTENCE_FAILED" } });
      expect(await facade["analysis.list"]({ mediaId: imported.value.mediaId })).toMatchObject({ ok: true, value: [] });
    } finally {
      await facade.dispose();
      await rm(mediaRoot, { recursive: true, force: true });
    }
  }, 20000);

  it("runs silence and beatGrid, records effective silence parameters, and discloses matching limits", async () => {
    const mediaRoot = await mkdtemp(path.join(artifactRoot, "live-audio-"));
    const sourcePath = await writeFloatWav(mediaRoot, 6, [.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]);
    const importedStore = new FakeLiveStore();
    const facade = liveFacade({ store: importedStore, mediaRoots: [mediaRoot] });
    try {
      const caps = await facade["capabilities.get"]();
      expect(caps.ok).toBe(true);
      if (!caps.ok) throw new Error(caps.error.message);
      expect(caps.value.mediaAnalysis.types.silence).toMatchObject({
        available: true,
        details: { maxRangeSec: 120, maxConcurrentPerSession: 2, maxEventsPerPage: 256, coordinateSpace: "source" },
      });
      expect(caps.value.mediaAnalysis.types.beatGrid).toMatchObject({
        available: true,
        details: { maxRangeSec: 120, maxConcurrentPerSession: 2, maxEventsPerPage: 256, coordinateSpace: "source" },
      });

      const imported = await facade["media.import"]({ path: sourcePath });
      if (!imported.ok) throw new Error(imported.error.message);
      const silenceParamsWithoutSilence = await facade["media.analyze_start"]({
        mediaId: imported.value.mediaId,
        analysisTypes: ["beatGrid"],
        silenceParams: { thresholdDb: -40 },
      });
      expect(silenceParamsWithoutSilence).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });

      const started = await facade["media.analyze_start"]({
        mediaId: imported.value.mediaId,
        analysisTypes: ["audioSummary", "silence", "beatGrid"],
        silenceParams: { minDurationSec: 0.1 },
      });
      if (!started.ok) throw new Error(started.error.message);
      const job = await waitForJob(facade, started.value.jobId, 15000);
      expect(job).toMatchObject({ state: "done" });
      const result = job.result;
      if (!result || !("summary" in result)) throw new Error("audio analysis returned no analysis result");
      const summary = result.summary as Record<string, any>;
      expect(summary.silence).toMatchObject({
        parameters: { thresholdDb: -40, minDurationSec: 0.1, paddingSec: 0.1 },
        coordinateSpace: "source",
        mediaId: imported.value.mediaId,
      });
      expect(summary.silence.regionCount).toBeGreaterThan(0);
      expect(summary.silence).not.toHaveProperty("silentRegions");
      expect(summary.beatGrid).toMatchObject({ coordinateSpace: "source", mediaId: imported.value.mediaId });
      expect(summary.beatGrid.bpm).toBeGreaterThan(100);
      expect(summary.beatGrid.beatCount).toBeGreaterThan(0);
      expect(summary.beatGrid).not.toHaveProperty("beats");
      expect(summary.audioSummary).not.toHaveProperty("waveform");
      expect(summary.audioSummary).not.toHaveProperty("onsets");
      expect(summary.audioSummary).not.toHaveProperty("silence");

      const recordId = (summary.analysisRecord as { id: string }).id;
      const record = await facade["analysis.get"]({ recordId });
      expect(record).toMatchObject({
        ok: true,
        value: {
          config: { silenceParams: { thresholdDb: -40, minDurationSec: 0.1, paddingSec: 0.1 } },
          provenance: expect.arrayContaining([
            { kind: "local-measurement", provider: "local-ffmpeg-pcm-silence-kernel", analysisType: "silence" },
            { kind: "local-measurement", provider: "local-ffmpeg-pcm-beat-engine", analysisType: "beatGrid" },
          ]),
          observations: expect.arrayContaining([
            expect.objectContaining({ source: "silence" }),
            expect.objectContaining({ source: "beatGrid" }),
          ]),
        },
      });

      const headless = createAgentFacade({ artifactRoot });
      const expectParity = async (params: AnalysisGetParams) => {
        const headlessResult = await headless["analysis.get"](params);
        const liveResult = await facade["analysis.get"](params);
        expect(headlessResult.ok).toBe(true);
        expect(liveResult).toEqual(headlessResult);
        return headlessResult;
      };
      await expectParity({ recordId });

      const query: AnalysisGetParams = { recordId, view: "events", series: "beatGrid.beats", startSec: 1, endSec: 3, limit: 2 };
      const firstPage = await expectParity(query);
      if (!firstPage.ok) throw new Error(firstPage.error.message);
      const firstEvents = (firstPage.value as { events: { items: Array<{ timeSec: number }>; nextCursor: string | null } }).events;
      expect(firstEvents.items.every((event) => event.timeSec >= 1 && event.timeSec < 3)).toBe(true);
      expect(firstEvents.nextCursor).toBeTruthy();
      const nextPage = await expectParity({ ...query, cursor: firstEvents.nextCursor! });
      if (!nextPage.ok) throw new Error(nextPage.error.message);
      const nextEvents = (nextPage.value as { events: { items: Array<{ timeSec: number }> } }).events;
      expect(nextEvents.items.every((event) => event.timeSec >= 1 && event.timeSec < 3)).toBe(true);
      expect(nextEvents.items.some((event) => firstEvents.items.some((item) => item.timeSec === event.timeSec))).toBe(false);

      const waveform = await expectParity({ recordId, view: "waveform", startSec: 0, endSec: 6, maxPoints: 7 });
      if (!waveform.ok) throw new Error(waveform.error.message);
      expect((waveform.value as { waveform: { points: unknown[]; maxPoints: number } }).waveform)
        .toMatchObject({ maxPoints: 7 });
      expect((waveform.value as { waveform: { points: unknown[] } }).waveform.points.length).toBeLessThanOrEqual(7);

      const longPath = await writeFloatWav(mediaRoot, 121);
      const longImport = await facade["media.import"]({ path: longPath });
      if (!longImport.ok) throw new Error(longImport.error.message);
      const tooLong = await facade["media.analyze_start"]({
        mediaId: longImport.value.mediaId,
        analysisTypes: ["beatGrid"],
        startSec: 0,
        endSec: 120.5,
      });
      expect(tooLong).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS", message: expect.stringContaining("120 seconds") } });
    } finally {
      await facade.dispose();
      await rm(mediaRoot, { recursive: true, force: true });
    }
  }, 30000);

  it("runs speechActivity with the shared Silero kernel path, compact status and paged regions", async () => {
    // Hermetic: a deterministic amplitude-threshold stand-in replaces the
    // onnxruntime session, so this test pins the live wiring, not the model.
    const mediaRoot = await mkdtemp(path.join(artifactRoot, "live-vad-"));
    const data = Buffer.alloc(16000 * 5 * 4);
    for (const window of [{ from: 1, to: 2 }, { from: 3, to: 4 }]) {
      for (let i = window.from * 16000; i < window.to * 16000; i++) {
        data.writeFloatLE(0.5 * Math.sin(i * 0.07), i * 4);
      }
    }
    const header = Buffer.alloc(44);
    header.write("RIFF"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24); header.writeUInt32LE(16000 * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(32, 34);
    header.write("data", 36); header.writeUInt32LE(data.length, 40);
    const sourcePath = path.join(mediaRoot, "vad.wav");
    await writeFile(sourcePath, Buffer.concat([header, data]));
    setSpeechVadModelFactoryForTests(async () => ({
      async detect(chunk: Float32Array) {
        let sum = 0;
        for (const sample of chunk) sum += sample * sample;
        return Math.sqrt(sum / chunk.length) > 0.02 ? 0.9 : 0.05;
      },
    }));
    const importedStore = new FakeLiveStore();
    const facade = liveFacade({ store: importedStore, mediaRoots: [mediaRoot] });
    try {
      const imported = await facade["media.import"]({ path: sourcePath });
      if (!imported.ok) throw new Error(imported.error.message);
      const vadParamsWithoutType = await facade["media.analyze_start"]({
        mediaId: imported.value.mediaId,
        analysisTypes: ["silence"],
        vadParams: { threshold: 0.5 },
      });
      expect(vadParamsWithoutType).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
      const started = await facade["media.analyze_start"]({
        mediaId: imported.value.mediaId,
        analysisTypes: ["speechActivity"],
        vadParams: { threshold: 0.45 },
      });
      if (!started.ok) throw new Error(started.error.message);
      const job = await waitForJob(facade, started.value.jobId, 15000);
      expect(job).toMatchObject({ state: "done" });
      const result = job.result;
      if (!result || !("summary" in result)) throw new Error("speechActivity returned no analysis result");
      const summary = result.summary as Record<string, any>;
      expect(summary.speechActivity).toMatchObject({
        coordinateSpace: "source",
        regionCount: 2,
        parameters: { threshold: 0.45, exitThreshold: 0.3 },
      });
      expect(summary.speechActivity).not.toHaveProperty("speechRegions");
      const recordId = (summary.analysisRecord as { id: string }).id;
      const query: AnalysisGetParams = { recordId, view: "events", series: "speechActivity.speechRegions", startSec: 0, endSec: 5, limit: 1 };
      const livePage = await facade["analysis.get"](query);
      if (!livePage.ok) throw new Error(livePage.error.message);
      const liveEvents = (livePage.value as import("./analysis-records").AnalysisAgentView).events!;
      expect(liveEvents.items).toHaveLength(1);
      expect(liveEvents.nextCursor).toBeTruthy();
      const headless = createAgentFacade({ artifactRoot });
      const headlessPage = await headless["analysis.get"](query);
      expect(headlessPage).toEqual(livePage);
      const record = await facade["analysis.get"]({ recordId });
      expect(record).toMatchObject({
        ok: true,
        value: {
          config: { vadParams: { threshold: 0.45 } },
          provenance: expect.arrayContaining([
            { kind: "local-measurement", provider: "local-silero-vad-onnx", analysisType: "speechActivity" },
          ]),
          inferences: expect.arrayContaining([expect.objectContaining({ source: "speechActivity" })]),
        },
      });
    } finally {
      setSpeechVadModelFactoryForTests(null);
      await facade.dispose();
      await rm(mediaRoot, { recursive: true, force: true });
    }
  }, 30000);

  it("applies record-driven ducking (AUD-02) through the same enrichment and shared kernel", async () => {
    const mediaRoot = await mkdtemp(path.join(artifactRoot, "live-ducking-"));
    const sourcePath = await writeFloatWav(mediaRoot, 20, [6, 6.5, 7]);
    const localStore = new FakeLiveStore();
    const facade = liveFacade({ store: localStore, mediaRoots: [mediaRoot] });
    try {
      const imported = await facade["media.import"]({ path: sourcePath });
      if (!imported.ok) throw new Error(imported.error.message);
      // Track ids may be explicit live; clip ids are minted by the store and
      // reported per op in createdIds.
      const seeded = await facade["edit.apply"]({
        ops: [
          { op: "track.add", trackType: "audio", trackId: "speech-lane" },
          { op: "clip.add", trackId: "speech-lane", mediaId: imported.value.mediaId, startTime: 10, duration: 4, inPoint: 5, outPoint: 9 },
          { op: "track.add", trackType: "audio", trackId: "bgm-lane" },
          { op: "clip.add", trackId: "bgm-lane", mediaId: imported.value.mediaId, startTime: 8, duration: 8 },
        ],
      });
      if (!seeded.ok) throw new Error(seeded.error.message);
      const speechClipId = seeded.value.applied[1]?.createdIds?.[0];
      const bgmClipId = seeded.value.applied[3]?.createdIds?.[0];
      if (!speechClipId || !bgmClipId) throw new Error("seed batch did not report created clip ids");

      const fileStat = await stat(sourcePath);
      const saved = await saveAnalysisRecord(artifactRoot, {
        projectId: localStore.project.id,
        sourceRevision: localStore.revision,
        coordinateSpace: "source",
        subject: { mediaId: imported.value.mediaId, name: "speech.wav", sourcePath, sourceFingerprint: { size: fileStat.size, lastModified: Math.round(fileStat.mtimeMs) } },
        analysisTypes: ["speechActivity"],
        rangeSec: { startSec: 0, endSec: 20 },
        config: { analysisTypes: ["speechActivity"], startSec: 0, endSec: 20, cloudUpload: false },
        provenance: [{ kind: "local-measurement", provider: "local-silero-vad-onnx", analysisType: "speechActivity" }],
        observations: [{ source: "speechActivity", facts: { speechRegions: [{ startSec: 6, endSec: 8, durationSec: 2 }], regionCount: 1 } }],
        inferences: [],
        recommendations: [],
        unknowns: [],
        recheckOf: null,
        cloudOpinion: null,
      });

      const applied = await facade["edit.apply"]({
        ops: [{ op: "clip.setDuckingFromAnalysis", clipId: bgmClipId, speechClipId, recordId: saved.id, threshold: -30, reduction: 0.6, attack: 0.1, release: 0.3, holdTime: 0.2 }],
      });
      expect(applied).toMatchObject({ ok: true, value: { replayed: false, applied: [{ op: "clip.setDuckingFromAnalysis" }] } });
      const bgm = localStore.project.timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === bgmClipId)!;
      expect(bgm.automation?.volume?.length).toBeGreaterThan(0);
      expect(bgm.metadata?.audioDucking).toMatchObject({ enabled: true, reduction: 0.6 });
      // Re-ducking without authorization conflicts — never a silent stack.
      const again = await facade["edit.apply"]({
        ops: [{ op: "clip.setDuckingFromAnalysis", clipId: bgmClipId, speechClipId, recordId: saved.id, threshold: -30, reduction: 0.6, attack: 0.1, release: 0.3, holdTime: 0.2 }],
      });
      expect(again).toMatchObject({ ok: false, error: { code: "CONFLICT", message: expect.stringContaining("existingEnvelope") } });

      // Same-batch placement: the move earlier in this batch must feed the
      // source→timeline mapping (stale mapping would duck at 2.9..5.3).
      const moved = await facade["edit.apply"]({
        ops: [
          { op: "clip.move", clipId: speechClipId, startTime: 12 },
          { op: "clip.setDuckingFromAnalysis", clipId: bgmClipId, speechClipId, recordId: saved.id, threshold: -30, reduction: 0.6, attack: 0.1, release: 0.3, holdTime: 0.2, existingEnvelope: "replace" },
        ],
      });
      expect(moved).toMatchObject({ ok: true });
      const movedBgm = localStore.project.timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === bgmClipId)!;
      expect(Math.min(...movedBgm.automation!.volume!.map((point) => point.time))).toBeGreaterThan(4.8);
    } finally {
      await facade.dispose();
      await rm(mediaRoot, { recursive: true, force: true });
    }
  }, 30000);

  it("applies record-driven silence cutting (AUD-05) through the same enrichment and expansion", async () => {
    const mediaRoot = await mkdtemp(path.join(artifactRoot, "live-cut-silence-"));
    const sourcePath = await writeFloatWav(mediaRoot, 20, [6, 6.5, 7]);
    const localStore = new FakeLiveStore();
    const facade = liveFacade({ store: localStore, mediaRoots: [mediaRoot] });
    try {
      const imported = await facade["media.import"]({ path: sourcePath });
      if (!imported.ok) throw new Error(imported.error.message);
      const seeded = await facade["edit.apply"]({
        ops: [
          { op: "track.add", trackType: "audio", trackId: "voice-lane" },
          { op: "clip.add", trackId: "voice-lane", mediaId: imported.value.mediaId, startTime: 10, duration: 10, inPoint: 5, outPoint: 15 },
        ],
      });
      if (!seeded.ok) throw new Error(seeded.error.message);
      const voiceClipId = seeded.value.applied[1]?.createdIds?.[0];
      if (!voiceClipId) throw new Error("seed batch did not report the created clip id");

      const fileStat = await stat(sourcePath);
      const saved = await saveAnalysisRecord(artifactRoot, {
        projectId: localStore.project.id,
        sourceRevision: localStore.revision,
        coordinateSpace: "source",
        subject: { mediaId: imported.value.mediaId, name: "voice.wav", sourcePath, sourceFingerprint: { size: fileStat.size, lastModified: Math.round(fileStat.mtimeMs) } },
        analysisTypes: ["silence"],
        rangeSec: { startSec: 0, endSec: 20 },
        config: { analysisTypes: ["silence"], startSec: 0, endSec: 20, cloudUpload: false, silenceParams: { thresholdDb: -40, minDurationSec: 0.5, paddingSec: 0.1 } },
        provenance: [{ kind: "local-measurement", provider: "local-ffmpeg-pcm-silence-kernel", analysisType: "silence" }],
        observations: [{ source: "silence", facts: { silentRegions: [{ startSec: 7, endSec: 9, durationSec: 2 }, { startSec: 11, endSec: 13, durationSec: 2 }], regionCount: 2 } }],
        inferences: [],
        recommendations: [],
        unknowns: [],
        recheckOf: null,
        cloudOpinion: null,
      });

      const applied = await facade["edit.apply"]({
        ops: [{ op: "clip.cutSilenceFromAnalysis", clipId: voiceClipId, recordId: saved.id }],
      });
      expect(applied).toMatchObject({ ok: true, value: { replayed: false, applied: [{ op: "clip.cutSilenceFromAnalysis" }] } });
      const lane = localStore.project.timeline.tracks.find((track) => track.id === "voice-lane")!;
      const fragments = [...lane.clips].sort((left, right) => left.startTime - right.startTime);
      expect(fragments.map((clip) => [clip.startTime, clip.duration])).toEqual([[10, 2], [12, 2], [14, 2]]);
      expect(fragments[1]!.fade).toMatchObject({ fadeIn: 0.01, fadeOut: 0.01 });
      expect(fragments.map((clip) => [clip.inPoint, clip.outPoint])).toEqual([[5, 7], [9, 11], [13, 15]]);

      // The original clip id survives as the leading fragment (5..7 s
      // source); the record's regions no longer overlap it, so a keyless
      // repeat is an honest nothing-to-cut rejection, never a second cut.
      const again = await facade["edit.apply"]({
        ops: [{ op: "clip.cutSilenceFromAnalysis", clipId: voiceClipId, recordId: saved.id }],
      });
      expect(again).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS", message: expect.stringContaining("nothing to cut") } });
    } finally {
      await facade.dispose();
      await rm(mediaRoot, { recursive: true, force: true });
    }
  }, 30000);

  it("applies beat-snapped splits (AUD-06) through the same enrichment", async () => {
    const mediaRoot = await mkdtemp(path.join(artifactRoot, "live-split-at-beat-"));
    const sourcePath = await writeFloatWav(mediaRoot, 12, [1, 2, 3]);
    const localStore = new FakeLiveStore();
    const facade = liveFacade({ store: localStore, mediaRoots: [mediaRoot] });
    try {
      const imported = await facade["media.import"]({ path: sourcePath });
      if (!imported.ok) throw new Error(imported.error.message);
      const seeded = await facade["edit.apply"]({
        ops: [
          { op: "track.add", trackType: "audio", trackId: "music-lane" },
          { op: "clip.add", trackId: "music-lane", mediaId: imported.value.mediaId, startTime: 10, duration: 4, inPoint: 5, outPoint: 9 },
        ],
      });
      if (!seeded.ok) throw new Error(seeded.error.message);
      const musicClipId = seeded.value.applied[1]?.createdIds?.[0];
      if (!musicClipId) throw new Error("seed batch did not report the created clip id");

      const fileStat = await stat(sourcePath);
      const saved = await saveAnalysisRecord(artifactRoot, {
        projectId: localStore.project.id,
        sourceRevision: localStore.revision,
        coordinateSpace: "source",
        subject: { mediaId: imported.value.mediaId, name: "music.wav", sourcePath, sourceFingerprint: { size: fileStat.size, lastModified: Math.round(fileStat.mtimeMs) } },
        analysisTypes: ["beatGrid"],
        rangeSec: { startSec: 0, endSec: 12 },
        config: { analysisTypes: ["beatGrid"], startSec: 0, endSec: 12, cloudUpload: false },
        provenance: [{ kind: "local-measurement", provider: "local-ffmpeg-pcm-beat-engine", analysisType: "beatGrid" }],
        observations: [{ source: "beatGrid", facts: { beats: [{ timeSec: 6, strength: 1, index: 0 }, { timeSec: 7, strength: 1, index: 1 }, { timeSec: 8, strength: 1, index: 2 }], beatCount: 3, bpm: 60, confidence: 0.9 } }],
        inferences: [],
        recommendations: [],
        unknowns: [],
        recheckOf: null,
        cloudOpinion: null,
      });

      const applied = await facade["edit.apply"]({
        ops: [{ op: "clip.splitAtBeat", clipId: musicClipId, recordId: saved.id, time: 12.3, maxShiftSec: 0.5 }],
      });
      expect(applied).toMatchObject({ ok: true, value: { replayed: false, applied: [{ op: "clip.splitAtBeat" }] } });
      const lane = localStore.project.timeline.tracks.find((track) => track.id === "music-lane")!;
      const pieces = [...lane.clips].sort((left, right) => left.startTime - right.startTime);
      expect(pieces.map((clip) => [clip.startTime, clip.duration, clip.inPoint, clip.outPoint]))
        .toEqual([[10, 2, 5, 7], [12, 2, 7, 9]]);

      // No beat inside the allowed movement is an honest rejection.
      const miss = await facade["edit.apply"]({
        ops: [{ op: "clip.splitAtBeat", clipId: pieces[1]!.id, recordId: saved.id, time: 12.45, maxShiftSec: 0.3 }],
      });
      expect(miss).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS", message: expect.stringContaining("within maxShiftSec") } });
    } finally {
      await facade.dispose();
      await rm(mediaRoot, { recursive: true, force: true });
    }
  }, 30000);
});

describe("live audio normalization task lifecycle", () => {
  it.skipIf(LIVE_AUDIO_TOOLCHAIN === null)("normalizes into a completed job and registers only through the revision-guarded media import path", { timeout: 60_000 }, async () => {
    const mediaRoot = await mkdtemp(path.join(artifactRoot, "live-audio-normalize-"));
    const sourcePath = path.join(mediaRoot, "normalization-source.wav");
    await runToolProcess(LIVE_AUDIO_TOOLCHAIN!.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=120",
      "-c:a", "pcm_s16le", sourcePath,
    ]);

    const importedStore = new FakeLiveStore();
    const { lifecycle, records } = memoryTaskLifecycle();
    const retained: string[] = [];
    const released: string[] = [];
    const taskInputReferences: LiveTaskInputReferences = {
      retain: async (input) => {
        retained.push(input.jobId);
        return input.inputProject;
      },
      release: async (jobId) => { released.push(jobId); },
    };
    const options = { store: importedStore, mediaRoots: [mediaRoot], taskLifecycle: lifecycle, taskInputReferences };
    const facade = liveFacade(options);
    let restartedFacade: LiveAgentFacade | undefined;
    let postImportFacade: LiveAgentFacade | undefined;
    let cancelFacade: LiveAgentFacade | undefined;
    try {
      const imported = await facade["media.import"]({ path: sourcePath });
      if (!imported.ok) throw new Error(imported.error.message);
      const sourceRevision = importedStore.revision;
      const request = {
        mediaId: imported.value.mediaId,
        audioStream: 0,
        startSec: 0.1,
        endSec: 2.1,
        targetLufs: -18,
        truePeakDbtp: -1,
        loudnessRangeLu: 7,
        sampleRate: 48_000 as const,
        channels: 2 as const,
        expectedRevision: sourceRevision,
        idempotencyKey: "live-audio-normalize-1",
      };
      const started = await facade["audio.process.normalize"](request);
      if (!started.ok) throw new Error(started.error.message);
      expect(started.value).toMatchObject({ kind: "audio-process", sourceRevision, state: "queued", replayed: false });

      const completed = await waitForJob(facade, started.value.jobId, 30_000);
      expect(completed).toMatchObject({ kind: "audio-process", state: "done", artifact: null, route: "local-ffmpeg-loudnorm-two-pass" });
      const result = completed.result;
      if (!result || !("source" in result)) throw new Error("audio-process completed without normalized provenance");
      expect(result.source).toMatchObject({ mediaId: imported.value.mediaId, startSec: 0.1, endSec: 2.1, projectId: importedStore.project.id, workspaceId: "workspace-live-1", revision: sourceRevision });
      expect(Number.isFinite(result.before.integratedLufs)).toBe(true);
      expect(Number.isFinite(result.after.integratedLufs)).toBe(true);
      expect(result.timing).toMatchObject({ sampleRate: 48_000, channels: 2, outputStartSec: 0, processingDelaySamples: 0 });
      expect(await stat(result.path)).toBeTruthy();
      expect(importedStore.revision).toBe(sourceRevision);
      expect(importedStore.mediaImports).toHaveLength(1);
      expect(importedStore.project.mediaLibrary.items).toHaveLength(1);
      expect(records.get(started.value.jobId)?.status.state).toBe("done");
      expect(retained).toEqual([started.value.jobId]);
      await vi.waitFor(() => expect(released).toContain(started.value.jobId));

      restartedFacade = liveFacade(options);
      const replayedStart = await restartedFacade["audio.process.normalize"](request);
      expect(replayedStart).toMatchObject({ ok: true, value: { jobId: started.value.jobId, replayed: true, state: "done" } });

      const staleRegistration = await restartedFacade["audio.process.register"]({ jobId: started.value.jobId, expectedRevision: 0 });
      expect(staleRegistration).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
      expect(importedStore.mediaImports).toHaveLength(1);

      const originalProject = importedStore.project;
      importedStore.project = createEmptyProject("Switched project");
      const projectSwitch = await restartedFacade["audio.process.register"]({ jobId: started.value.jobId, expectedRevision: sourceRevision });
      expect(projectSwitch).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
      importedStore.project = originalProject;

      const originalIdentity = importedStore.getIdentity.bind(importedStore);
      importedStore.getIdentity = async () => ({ ...await originalIdentity(), workspaceId: "workspace-switched" });
      const workspaceSwitch = await restartedFacade["audio.process.register"]({ jobId: started.value.jobId, expectedRevision: sourceRevision });
      expect(workspaceSwitch).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
      importedStore.getIdentity = originalIdentity;

      const registered = await restartedFacade["audio.process.register"]({ jobId: started.value.jobId, expectedRevision: sourceRevision });
      if (!registered.ok) throw new Error(registered.error.message);
      expect(registered.value).toMatchObject({ mediaId: expect.any(String), replayed: false, revision: sourceRevision + 1 });
      expect(registered.value.mediaId).not.toBe(imported.value.mediaId);
      expect(importedStore.mediaImports).toHaveLength(2);
      expect(importedStore.project.mediaLibrary.items).toHaveLength(2);
      expect(importedStore.project.mediaLibrary.items[0]?.id).toBe(imported.value.mediaId);
      expect(importedStore.project.mediaLibrary.items[1]?.id).toBe(registered.value.mediaId);

      postImportFacade = liveFacade(options);
      const registeredReplay = await postImportFacade["audio.process.register"]({ jobId: started.value.jobId, expectedRevision: importedStore.revision });
      expect(registeredReplay).toMatchObject({ ok: true, value: { mediaId: registered.value.mediaId, replayed: true, revision: sourceRevision + 1 } });
      expect(importedStore.mediaImports).toHaveLength(2);

      cancelFacade = liveFacade(options);
      const cancelStart = await cancelFacade["audio.process.normalize"]({
        ...request,
        startSec: 0.1,
        endSec: 119.9,
        expectedRevision: importedStore.revision,
        idempotencyKey: "live-audio-normalize-cancel",
      });
      if (!cancelStart.ok) throw new Error(cancelStart.error.message);
      const cancelRequested = await cancelFacade["job.cancel"]({ jobId: cancelStart.value.jobId });
      expect(cancelRequested).toMatchObject({ ok: true, value: { kind: "audio-process", cancelRequested: true } });
      const cancelled = await waitForJob(cancelFacade, cancelStart.value.jobId, 30_000);
      expect(cancelled).toMatchObject({ state: "cancelled", result: null, artifact: null });
      await expect(stat(path.join(mediaRoot, "generated-assets", "audio-normalize", cancelStart.value.jobId))).rejects.toMatchObject({ code: "ENOENT" });

      const disposeStart = await cancelFacade["audio.process.normalize"]({
        ...request,
        startSec: 0.1,
        endSec: 119.9,
        expectedRevision: importedStore.revision,
        idempotencyKey: "live-audio-normalize-dispose",
      });
      if (!disposeStart.ok) throw new Error(disposeStart.error.message);
      await cancelFacade.dispose();
      const disposed = await cancelFacade["job.status"]({ jobId: disposeStart.value.jobId });
      expect(disposed).toMatchObject({ ok: true, value: { state: "cancelled", result: null, artifact: null } });
      await expect(stat(path.join(mediaRoot, "generated-assets", "audio-normalize", disposeStart.value.jobId))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all([facade.dispose(), restartedFacade?.dispose(), postImportFacade?.dispose(), cancelFacade?.dispose()]);
      await rm(mediaRoot, { recursive: true, force: true });
    }
  });
});

describe("live verbs forward idempotencyKey to the store seam", () => {
  it("edit.apply passes valid.idempotencyKey into the store applyActions opts", async () => {
    const facade = liveFacade();
    const res = await facade["edit.apply"]({
      ops: [...TEXT_BATCH],
      idempotencyKey: "edit-opts-1",
    });
    expect(res.ok).toBe(true);
    expect(store.batches.at(-1)?.opts.idempotencyKey).toBe("edit-opts-1");

    // No caller key ⇒ the field is entirely absent from the opts
    // (conditional spread, mirroring historyControl at the same seam).
    const plain = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video" }],
    });
    expect(plain.ok).toBe(true);
    expect(store.batches.at(-1)?.opts).not.toHaveProperty("idempotencyKey");
  });

  it("project.rename passes valid.idempotencyKey into the store applyActions opts", async () => {
    const facade = liveFacade();
    const res = await facade["project.rename"]({
      name: "Opts Renamed",
      idempotencyKey: "rename-opts-1",
    });
    expect(res.ok).toBe(true);
    expect(store.batches.at(-1)?.opts.idempotencyKey).toBe("rename-opts-1");
  });
});

/* --------------- idempotency ledger: per-request scope capture --------------- */

/**
 * A FakeLiveStore reporting an EXPLICIT workspace id — the shared harness
 * store always answers "workspace-live-1", which would make two targets
 * indistinguishable to the ledger scope.
 */
class WorkspaceStore extends FakeLiveStore {
  constructor(
    readonly workspaceName: string,
    project?: Project,
  ) {
    super(project);
  }
  override async getIdentity() {
    return { ...(await super.getIdentity()), workspaceId: this.workspaceName };
  }
}

/**
 * One store seam serving several project/workspace targets: the identity,
 * snapshot and CAS all delegate to the CURRENT target, the way the desktop
 * serves concurrent requests routed to different open workspaces.
 */
class RoutingStore extends FakeLiveStore {
  current: FakeLiveStore;
  constructor(targets: readonly [FakeLiveStore, FakeLiveStore]) {
    super();
    this.current = targets[0];
  }
  override async getIdentity() {
    return this.current.getIdentity();
  }
  override async getState() {
    return this.current.getState();
  }
  override async applyActions(
    actions: readonly Action[],
    opts: LiveApplyActionsOptions,
  ) {
    return this.current.applyActions(actions, opts);
  }
}

describe("idempotency ledger scope is captured per request", () => {
  it("interleaved requests to two workspaces commit into their OWN scopes: A's retry replays under P1/w1 and conflicts under P2/w2", async () => {
    const p1 = new WorkspaceStore("ws-1");
    const p2 = new WorkspaceStore("ws-2", createEmptyProject("Second"));
    const routing = new RoutingStore([p1, p2]);
    let lane = 0;
    const facade = liveFacade({
      store: routing,
      // A distinct serialized lane per request: the two requests below run
      // concurrently (the desktop scopes lanes by project/workspace target).
      executionScope: () => `lane-${++lane}`,
    });

    // Deterministic race: A's lookup (P1/w1) → B's lookup (P2/w2) → A's
    // commit → B's commit. Each request parks inside its target's
    // applyActions until the test releases it, so B's lookup always lands
    // after A's lookup but BEFORE A's commit.
    let releaseA!: () => void;
    const arrivedA = new Promise<void>((resolveArrival) => {
      p1.beforeApply = () => {
        p1.beforeApply = null;
        resolveArrival();
        return new Promise<void>((resolvePark) => {
          releaseA = resolvePark;
        });
      };
    });
    let releaseB!: () => void;
    const arrivedB = new Promise<void>((resolveArrival) => {
      p2.beforeApply = () => {
        p2.beforeApply = null;
        resolveArrival();
        return new Promise<void>((resolvePark) => {
          releaseB = resolvePark;
        });
      };
    });

    const opsA = [...TEXT_BATCH] as const;
    const opsB = [
      { op: "track.add", trackType: "text", trackId: "t1" },
      { op: "text.create", text: "Second live", startTime: 0, duration: 2 },
    ] as const;

    routing.current = p1;
    const requestA = facade["edit.apply"]({ ops: [...opsA], idempotencyKey: "race-key" });
    await arrivedA; // A captured the P1/w1 scope and is parked pre-commit.

    routing.current = p2;
    const requestB = facade["edit.apply"]({ ops: [...opsB], idempotencyKey: "race-key" });
    await arrivedB; // B captured P2/w2 — under the old shared-field ledger this clobbered A's scope.

    releaseA();
    const resA = await requestA;
    releaseB();
    const resB = await requestB;
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    if (!resA.ok || !resB.ok) return;
    expect(resA.value.replayed).toBe(false);
    expect(resB.value.replayed).toBe(false);
    expect(p1.batches).toHaveLength(1);
    expect(p2.batches).toHaveLength(1);

    // Retrying A's key + payload against P1/w1 replays A's committed
    // receipt without re-executing — the receipt did NOT land in P2's scope
    // even though B's lookup ran between A's lookup and A's commit.
    routing.current = p1;
    const retryA = await facade["edit.apply"]({ ops: [...opsA], idempotencyKey: "race-key" });
    expect(retryA.ok).toBe(true);
    if (!retryA.ok) return;
    expect(retryA.value.replayed).toBe(true);
    expect(retryA.value.applied).toEqual(resA.value.applied);
    expect(p1.batches).toHaveLength(1);

    // The same key against P2/w2 must not serve A's result: the stored
    // receipt there is B's (different payload) ⇒ CONFLICT, never a replay.
    routing.current = p2;
    const crossA = await facade["edit.apply"]({ ops: [...opsA], idempotencyKey: "race-key" });
    expect(crossA.ok).toBe(false);
    if (!crossA.ok) {
      expect(crossA.error.code).toBe("CONFLICT");
      expect(crossA.error.details).toMatchObject({
        idempotencyKey: "race-key",
        verb: "edit.apply",
      });
    }
    expect(p2.batches).toHaveLength(1);

    // B's own retry still replays honestly under P2/w2.
    const retryB = await facade["edit.apply"]({ ops: [...opsB], idempotencyKey: "race-key" });
    expect(retryB.ok).toBe(true);
    if (!retryB.ok) return;
    expect(retryB.value.replayed).toBe(true);
    expect(p2.batches).toHaveLength(1);
    expect(p1.batches).toHaveLength(1);
  });

  it("the same key in two different scopes is fully independent — no cross-replay, no conflict", async () => {
    const p1 = new WorkspaceStore("ws-1");
    const p2 = new WorkspaceStore("ws-2", createEmptyProject("Second"));
    const routing = new RoutingStore([p1, p2]);
    const facade = liveFacade({ store: routing });

    // Identical key + IDENTICAL payload in both scopes: each executes fresh
    // (a scope miss never replays another scope's receipt).
    routing.current = p1;
    const first = await facade["edit.apply"]({ ops: [...TEXT_BATCH], idempotencyKey: "shared-key" });
    expect(first.ok).toBe(true);
    routing.current = p2;
    const second = await facade["edit.apply"]({ ops: [...TEXT_BATCH], idempotencyKey: "shared-key" });
    expect(second.ok).toBe(true);
    if (!second.ok || !first.ok) return;
    expect(second.value.replayed).toBe(false);
    expect(p1.batches).toHaveLength(1);
    expect(p2.batches).toHaveLength(1);

    // Each scope then replays exactly its OWN committed outcome.
    routing.current = p1;
    const replay1 = await facade["edit.apply"]({ ops: [...TEXT_BATCH], idempotencyKey: "shared-key" });
    routing.current = p2;
    const replay2 = await facade["edit.apply"]({ ops: [...TEXT_BATCH], idempotencyKey: "shared-key" });
    expect(replay1.ok && replay2.ok).toBe(true);
    if (replay1.ok && replay2.ok) {
      expect(replay1.value.replayed).toBe(true);
      expect(replay2.value.replayed).toBe(true);
      expect(replay1.value.revision).toBe(first.value.revision);
      expect(replay2.value.revision).toBe(second.value.revision);
      expect(replay1.value.applied).toEqual(first.value.applied);
      expect(replay2.value.applied).toEqual(second.value.applied);
    }
    expect(p1.batches).toHaveLength(1);
    expect(p2.batches).toHaveLength(1);
  });

  it("same scope + same key + different payload is a CONFLICT carrying the key and verb", async () => {
    const facade = liveFacade();
    const first = await facade["edit.apply"]({ ops: [...TEXT_BATCH], idempotencyKey: "clash" });
    expect(first.ok).toBe(true);
    const clash = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video" }],
      idempotencyKey: "clash",
    });
    expect(clash.ok).toBe(false);
    if (!clash.ok) {
      expect(clash.error.code).toBe("CONFLICT");
      expect(clash.error.details).toMatchObject({
        idempotencyKey: "clash",
        verb: "edit.apply",
      });
    }
    expect(store.batches).toHaveLength(1);
  });

  it("a request without an idempotencyKey bypasses the ledger and executes normally", async () => {
    const facade = liveFacade();
    const first = await facade["edit.apply"]({ ops: [...TEXT_BATCH] });
    const second = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v2" }],
    });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.replayed).toBe(false);
      expect(second.value.replayed).toBe(false);
      expect(second.value.revision).toBe(first.value.revision + 1);
    }
    // Two independent executions, no replay between them.
    expect(store.batches).toHaveLength(2);
  });

  it("restored task receipts replay under their OWN project:workspace scope, whatever the restore order", async () => {
    // The export.start payload this receipt was minted for (no settings,
    // no destination, no comparison).
    const exportPayloadHash = stableStringify({
      settings: null,
      destinationPath: null,
      comparison: null,
    });
    const recordFor = (
      projectId: string,
      workspaceId: string,
      jobId: string,
      key: string,
    ): LivePersistedTaskRecord => ({
      projectId,
      workspaceId,
      status: {
        jobId,
        kind: "export",
        projectId,
        workspaceId,
        state: "done",
        progress: null,
        artifact: null,
        result: null,
        error: null,
        deliveredTo: null,
        deliveryError: null,
        sourceRevision: 3,
        route: "stub",
        upscalingRequestedButInactive: false,
        cancelRequested: false,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      parameters: { idempotencyKey: key, payloadHash: exportPayloadHash },
    });

    async function seedExportableTimeline(target: FakeLiveStore): Promise<void> {
      await target.humanEdit({
        type: "track/add",
        id: "seed-1",
        timestamp: Date.now(),
        params: { trackType: "text", trackId: "t1" },
      });
      await target.humanEdit({
        type: "text/create",
        id: "seed-2",
        timestamp: Date.now(),
        params: {
          clip: {
            id: "text-seed",
            trackId: "t1",
            startTime: 0,
            duration: 2,
            text: "seed",
            style: {},
            transform: {
              position: { x: 0.5, y: 0.5 },
              scale: { x: 1, y: 1 },
              rotation: 0,
              anchor: { x: 0.5, y: 0.5 },
              opacity: 1,
            },
            keyframes: [],
          },
        },
      });
    }

    // Both restore orders: each receipt must land under ITS OWN record's
    // scope, independent of the order list() returns them in.
    for (const order of [[0, 1], [1, 0]] as const) {
      const targetA = new WorkspaceStore("ws-a");
      const targetB = new WorkspaceStore("ws-b", createEmptyProject("B"));
      await seedExportableTimeline(targetA);
      await seedExportableTimeline(targetB);
      // Bind the durable records to the targets' REAL project ids — the
      // ledger scope is the project/workspace identity the store reports.
      const records = [
        recordFor(targetA.project.id, "ws-a", "job-a", "restore-a"),
        recordFor(targetB.project.id, "ws-b", "job-b", "restore-b"),
      ];
      const routing = new RoutingStore([targetA, targetB]);
      const stub = stubExportProvider();
      const facade = createLiveFacade({
        store: routing,
        lease: new LiveWriterLease(),
        sessionId: "agent-restore",
        access: "write",
        artifactRoot,
        exportProvider: stub.provider,
        taskLifecycle: {
          list: () => order.map((index) => records[index]!),
          begin: () => undefined,
          update: () => undefined,
        },
      });

      // key restore-a under proj-a/ws-a replays the RESTORED receipt —
      // no new export starts — even when the OTHER record was restored last.
      routing.current = targetA;
      const replayA = await facade["export.start"]({ idempotencyKey: "restore-a" });
      expect(replayA.ok).toBe(true);
      if (!replayA.ok) return;
      expect(replayA.value).toMatchObject({
        jobId: "job-a",
        sourceRevision: 3,
        replayed: true,
      });

      // …and restore-b under proj-b/ws-b replays its own receipt too.
      routing.current = targetB;
      const replayB = await facade["export.start"]({ idempotencyKey: "restore-b" });
      expect(replayB.ok).toBe(true);
      if (!replayB.ok) return;
      expect(replayB.value.jobId).toBe("job-b");
      expect(replayB.value.replayed).toBe(true);
      expect(stub.requests).toHaveLength(0);

      // Cross-scope: restore-a against proj-b is NOT a hit — the key
      // executes a fresh export under proj-b's own scope.
      const miss = await facade["export.start"]({ idempotencyKey: "restore-a" });
      expect(miss.ok).toBe(true);
      if (!miss.ok) return;
      expect(miss.value.replayed).toBe(false);
      expect(miss.value.jobId).not.toBe("job-a");
      expect(stub.requests).toHaveLength(1);

      await facade.dispose();
    }
  });
});
