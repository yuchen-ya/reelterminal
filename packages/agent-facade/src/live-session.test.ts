/**
 * Live facade session tests (ADR 0004 Slice 3): createLiveFacade over an
 * in-memory FakeLiveStore that owns a real Project, keeps revision and
 * contextRevision counters, CAS-checks applyActions exactly like the
 * renderer bridge must, records every committed batch, and can simulate a
 * concurrent human edit landing between the agent's snapshot read and its
 * apply. Covered: the visual.inspect read path and live/headless honesty, CAS conflict paths,
 * the observe/assist mode gate, the single-writer lease, live-unavailable
 * lifecycle verbs, snapshot preview/export with stub providers, the
 * file-backed-media honesty rule, idempotent replay, and dispose.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActionExecutor } from "@openreel/core/actions/action-executor";
import { ActionHistory } from "@openreel/core/actions/action-history";
import type { Action } from "@openreel/core/types/actions";
import type { Project } from "@openreel/core/types/project";

import {
  createAgentFacade,
  createLiveFacade,
  LiveWriterLease,
  type LiveAgentFacade,
} from "./index";
import { LiveStoreConflictError } from "./live-store";
import type {
  LiveApplyActionsOptions,
  LiveEditorContext,
  LiveMediaImportRequest,
  LiveProjectStore,
} from "./live-store";
import { collectEntityIds, diffCreatedIdsByCategory } from "./ops";
import { createEmptyProject } from "./project-factory";
import type {
  ExportCallbacks,
  ExportProvider,
  ExportVideoRequest,
  ProviderPreflight,
  RenderProvider,
} from "./providers";
import { READ_ONLY_VERBS } from "./types";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";

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
      windowId: "win-1",
    };
  }

  async getState() {
    return { project: structuredClone(this.project), revision: this.revision };
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
    return { revision: this.revision, mediaId };
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
    mode: "observe" | "assist" | "autonomous";
    sessionId: string;
    mediaRoots: readonly string[];
    deliveryRoots: readonly string[];
    renderProvider: RenderProvider;
    exportProvider: ExportProvider;
    store: LiveProjectStore;
  }>,
): LiveAgentFacade {
  return createLiveFacade({
    store: opts?.store ?? store,
    lease,
    sessionId: opts?.sessionId ?? "agent-1",
    mode: opts?.mode ?? "assist",
    artifactRoot,
    ...(opts?.mediaRoots ? { mediaRoots: opts.mediaRoots } : {}),
    ...(opts?.deliveryRoots ? { deliveryRoots: opts.deliveryRoots } : {}),
    ...(opts?.renderProvider ? { renderProvider: opts.renderProvider } : {}),
    ...(opts?.exportProvider ? { exportProvider: opts.exportProvider } : {}),
  });
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
      identity: {
        projectId: store.project.id,
        projectName: "Live Demo",
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
      // A human edit lands between the agent's snapshot read (translate)
      // and its apply — exactly the window an unguarded call used to miss.
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

/* --------------------------- session modes --------------------------- */

describe("session modes + writer lease (Decisions 6/7)", () => {
  it("observe: read-only verbs run, every write verb fails FORBIDDEN", async () => {
    const facade = liveFacade({ mode: "observe" });
    // All eight read-only verbs are allowed through the gate.
    expect((await facade["session.describe"]()).ok).toBe(true);
    expect((await facade["capabilities.get"]()).ok).toBe(true);
    expect((await facade["project.get_state"]()).ok).toBe(true);
    expect((await facade["timeline.get"]()).ok).toBe(true);
    expect((await facade["editor.get_context"]()).ok).toBe(true);
    const jobStatus = await facade["job.status"]({ jobId: "job-none" });
    expect(jobStatus.ok).toBe(false);
    if (!jobStatus.ok) expect(jobStatus.error.code).toBe("NOT_FOUND"); // gated? no — reached the registry
    const verify = await facade["verify.artifact"]({ path: "/x.mp4" });
    expect(verify.ok).toBe(false);
    if (!verify.ok) expect(verify.error.code).toBe("UNSUPPORTED"); // no verifier — NOT FORBIDDEN
    expect(READ_ONLY_VERBS).toHaveLength(9);

    // Every non-read-only verb is FORBIDDEN, and the gate fires BEFORE
    // param validation (an empty/invalid payload is still FORBIDDEN).
    const writeCalls: Array<[string, Promise<{ ok: boolean; error?: { code: string } }>]> = [
      ["project.create", facade["project.create"]({ name: "X" })],
      ["project.open", facade["project.open"]({ path: "/x" })],
      ["project.save", facade["project.save"]()],
      ["media.import", facade["media.import"]({ path: "/x.mp4" })],
      ["edit.apply", facade["edit.apply"]({ ops: [{ op: "track.add", trackType: "video" }] })],
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
  });

  it("lease held by another session: write verbs fail CONFLICT naming the holder; reads still work", async () => {
    expect(lease.acquire("agent-other")).toBe(true);
    const facade = liveFacade({ sessionId: "agent-1" }); // acquire fails
    const describeRes = await facade["session.describe"]();
    expect(describeRes.ok).toBe(true);
    if (describeRes.ok) {
      expect(describeRes.value.writer).toBe(false);
      expect(describeRes.value.leaseHolder).toBe("agent-other");
      expect(describeRes.value.mode).toBe("assist");
      expect(describeRes.value.sessionId).toBe("agent-1");
    }
    const edit = await facade["edit.apply"]({ ops: [...TEXT_BATCH] });
    expect(edit.ok).toBe(false);
    if (!edit.ok) {
      expect(edit.error.code).toBe("CONFLICT");
      expect(edit.error.details?.leaseHolder).toBe("agent-other");
    }
    const save = await facade["project.save"]();
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
    const facade = liveFacade({ mode: "autonomous" });
    const res = await facade["session.describe"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.runtime).toBe("live");
    expect(res.value.mode).toBe("autonomous");
    expect(res.value.writer).toBe(true);
    expect(res.value.leaseHolder).toBe("agent-1");
    expect(res.value.sessionId).toBe("agent-1");
    expect(res.value.verbs).toHaveLength(17);
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
      "project.create",
      "project.open",
      "media.import",
    ]);
    expect(res.value.mediaImport.available).toBe(false);
    expect(res.value.mediaImport.reason).toContain("media roots");
    expect(res.value.visualInspection.details?.fileBackedMediaRequired).toBe(true);
  });
});

/* --------------------- live-unavailable lifecycle -------------------- */

describe("live-unavailable verbs (Decision 11)", () => {
  it("project.create / project.open / media.import fail UNSUPPORTED in live mode", async () => {
    const facade = liveFacade();
    const create = await facade["project.create"]({ name: "Nope" });
    expect(create.ok).toBe(false);
    if (!create.ok) {
      expect(create.error.code).toBe("UNSUPPORTED");
      expect(create.error.message).toContain("live mode");
    }
    const open = await facade["project.open"]({ path: "/tmp/x.openreel.json" });
    expect(open.ok).toBe(false);
    if (!open.ok) expect(open.error.code).toBe("UNSUPPORTED");
    const imp = await facade["media.import"]({ path: "/tmp/x.mp4" });
    expect(imp.ok).toBe(false);
    if (!imp.ok) expect(imp.error.code).toBe("UNSUPPORTED");
  });

  it("project.save routes to the GUI save path and reports the revision", async () => {
    const facade = liveFacade();
    await facade["edit.apply"]({ ops: [...TEXT_BATCH] });
    const res = await facade["project.save"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual({ revision: 1 });
    expect(store.saveCount).toBe(1);
    // Saving is a snapshot, not a mutation: no revision bump.
    expect(store.revision).toBe(1);
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
      "project.create",
      "project.open",
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
    });
    expect(store.mediaImports[0]?.request.path).toMatch(/\/tiny-6s\.mp4$/);
    expect(store.project.mediaLibrary.items[0]).toMatchObject({
      id: res.value.mediaId,
      originalUrl: store.mediaImports[0]?.request.path,
      name: "Opening shot",
    });

    // Exact retries replay the committed result without probing or adding a
    // second canonical media item; this remains true after the source goes
    // away, matching the headless idempotency contract.
    await rm(inputPath, { force: true });
    const replay = await facade["media.import"]({
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

    const relative = await facade["media.import"]({
      path: path.relative(process.cwd(), inputPath),
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
      const facade = liveFacade({
        exportProvider: stub.provider,
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
