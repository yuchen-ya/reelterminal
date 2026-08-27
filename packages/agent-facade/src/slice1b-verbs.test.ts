/**
 * Slice-1b verb contract tests with STUB providers (no Chromium): the facade
 * side of the boundary is pinned here — capability independence, preflight
 * gating, idempotency, revision preconditions, containment, job lifecycle
 * wiring and the no-fake-artifact invariant.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentFacade, type AgentFacade } from "./index";
import type {
  ExportCallbacks,
  ExportProvider,
  ExportVideoRequest,
  ProviderPreflight,
  RenderProvider,
} from "./providers";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";

/* ------------------------------ stubs ------------------------------ */

function availablePreflight(details?: Record<string, unknown>): ProviderPreflight {
  return { available: true, ...(details ? { details } : {}) };
}

function unavailablePreflight(reason: string): ProviderPreflight {
  return { available: false, reason, requires: "test-required-thing" };
}

function stubRenderProvider(overrides?: Partial<RenderProvider>): RenderProvider {
  return {
    id: "stub-render",
    preflight: async () => availablePreflight(),
    renderFramePng: async (request) => {
      // A real provider writes real bytes to destPath; the stub writes a
      // minimal but non-empty payload so hashing/stat paths execute.
      await mkdir(path.dirname(request.destPath), { recursive: true });
      const bytes = Buffer.from(`fake-png:${request.timeSec}:${request.width}x${request.height}`);
      await writeFile(request.destPath, bytes);
      return { bytesWritten: bytes.length };
    },
    ...overrides,
  };
}

interface ExportStubControl {
  readonly provider: ExportProvider;
  readonly requests: ExportVideoRequest[];
  settle(jobId: string, mode: "done" | "error" | "cancelled" | "hang"): void;
  awaitStart(jobId: string): Promise<void>;
}

function stubExportProvider(opts?: {
  preflight?: ProviderPreflight;
  autoSettle?: "done" | "error" | "cancelled" | "hang";
  writeArtifact?: boolean;
}): ExportStubControl {
  const requests: ExportVideoRequest[] = [];
  const callbacksByJob = new Map<string, ExportCallbacks>();
  const started = new Map<string, () => void>();
  const control: ExportStubControl = {
    requests,
    provider: {
      id: "stub-export",
      preflight: async () => opts?.preflight ?? availablePreflight({ route: "stub" }),
      startExport: async (request, callbacks) => {
        requests.push(request);
        callbacksByJob.set(request.jobId, callbacks);
        started.get(request.jobId)?.();
        callbacks.onRunning();
        const mode = opts?.autoSettle ?? "hang";
        if (mode !== "hang") {
          control.settle(request.jobId, mode);
        }
      },
      cancel: async (jobId) => {
        const callbacks = callbacksByJob.get(jobId);
        callbacks?.onCancelled();
      },
    },
    settle(jobId, mode) {
      const callbacks = callbacksByJob.get(jobId);
      if (!callbacks) throw new Error(`no such job ${jobId}`);
      if (mode === "cancelled") {
        callbacks.onCancelled();
        return;
      }
      if (mode === "error") {
        callbacks.onError({ code: "JOB_FAILED", message: "stub failure" });
        return;
      }
      void (async () => {
        const request = requests.find((r) => r.jobId === jobId);
        if (!request) throw new Error(`no request for ${jobId}`);
        const finalPath = path.join(request.jobDir, "output.mp4");
        if (opts?.writeArtifact !== false) {
          await writeFile(finalPath, Buffer.from("stub-mp4-bytes"));
        }
        callbacks.onDone({
          path: finalPath,
          sizeBytes: (await stat(finalPath)).size,
          route: "chromium-webcodecs",
          framesEncoded: 150,
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

async function settleMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
}

/** Poll job.status until the job reaches a terminal state (or time out). */
async function waitForJob(
  facade: AgentFacade,
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

async function makeProjectWithMedia(facade: AgentFacade, mediaRoot: string) {
  const inputPath = writeTinyMp4(mediaRoot);
  await facade["project.create"]({
    name: "Slice1b",
    settings: { width: 320, height: 180, frameRate: 30, sampleRate: 48000, channels: 2 },
  });
  const imported = await facade["media.import"]({ path: inputPath, expectedRevision: 0 });
  if (!imported.ok) throw new Error("import failed");
  const edited = await facade["edit.apply"]({
    ops: [
      { op: "track.add", trackType: "video", trackId: "v1" },
      { op: "clip.add", trackId: "v1", mediaId: imported.value.mediaId, startTime: 0, clipId: "c1" },
      { op: "clip.trim", clipId: "c1", inPoint: 0, outPoint: 5 },
      { op: "track.add", trackType: "text", trackId: "t1" },
      { op: "text.create", trackId: "t1", text: "Hello world", startTime: 0, duration: 5 },
    ],
    expectedRevision: 1,
  });
  if (!edited.ok) throw new Error("edit failed");
  return { inputPath, mediaId: imported.value.mediaId };
}

/* ------------------------------ tests ------------------------------ */

describe("slice-1b verb contracts (stub providers)", () => {
  let mediaRoot: string;
  let artifactRoot: string;

  beforeEach(async () => {
    mediaRoot = await mkdtemp(path.join(tmpdir(), "s1b-media-"));
    artifactRoot = await mkdtemp(path.join(tmpdir(), "s1b-artifacts-"));
  });

  afterEach(async () => {
    await rm(mediaRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });

  it("capabilities are independent: render-only session reports export/verify unavailable", async () => {
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      renderProvider: stubRenderProvider(),
    });
    const caps = await facade["capabilities.get"]();
    expect(caps.ok).toBe(true);
    if (!caps.ok) return;
    expect(caps.value.preview.available).toBe(true);
    expect(caps.value.export.available).toBe(false);
    expect(caps.value.verify.available).toBe(false);
    expect(caps.value.textOverlay.pixelRendering).toBe(true);

    const desc = await facade["session.describe"]();
    if (!desc.ok) throw new Error("describe failed");
    expect(desc.value.stepLetters.textOverlayPixels).toBe("C");
    expect(desc.value.stepLetters.exportVideo).toBe("X");
    expect(desc.value.stepLetters.verifyArtifact).toBe("X");
  });

  it("verbs fail UNSUPPORTED without their provider, never silently", async () => {
    const facade = createAgentFacade({ mediaRoots: [mediaRoot], artifactRoot });
    await makeProjectWithMedia(facade, mediaRoot);
    const render = await facade["preview.render_frame"]({ timeSec: 2.5 });
    expect(render.ok).toBe(false);
    if (render.ok) return;
    expect(render.error.code).toBe("UNSUPPORTED");

    const start = await facade["export.start"]({});
    expect(start.ok).toBe(false);
    if (start.ok) return;
    expect(start.error.code).toBe("UNSUPPORTED");

    const verify = await facade["verify.artifact"]({ path: path.join(artifactRoot, "x.mp4") });
    expect(verify.ok).toBe(false);
    if (verify.ok) return;
    expect(verify.error.code).toBe("UNSUPPORTED");
  });

  it("verbs fail UNSUPPORTED when the provider preflight fails (capability honesty)", async () => {
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      renderProvider: stubRenderProvider({
        preflight: async () => unavailablePreflight("browser exploded in preflight"),
      }),
      exportProvider: stubExportProvider({
        preflight: unavailablePreflight("no h264 route"),
      }).provider,
    });
    await makeProjectWithMedia(facade, mediaRoot);
    const caps = await facade["capabilities.get"]();
    if (!caps.ok) throw new Error("caps failed");
    expect(caps.value.preview.available).toBe(false);
    expect(caps.value.preview.reason).toContain("browser exploded");
    expect(caps.value.export.available).toBe(false);

    const render = await facade["preview.render_frame"]({ timeSec: 1 });
    expect(render.ok).toBe(false);
    if (render.ok) return;
    expect(render.error.code).toBe("UNSUPPORTED");

    const start = await facade["export.start"]({});
    expect(start.ok).toBe(false);
    if (start.ok) return;
    expect(start.error.code).toBe("UNSUPPORTED");
  });

  it("preview.render_frame produces a hashed PNG artifact with sourceRevision", async () => {
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      renderProvider: stubRenderProvider(),
    });
    await makeProjectWithMedia(facade, mediaRoot);
    const render = await facade["preview.render_frame"]({ timeSec: 2.5, expectedRevision: 2 });
    expect(render.ok).toBe(true);
    if (!render.ok) return;
    expect(render.value.revision).toBe(2);
    expect(render.value.timeSec).toBe(2.5);
    expect(render.value.width).toBe(320);
    expect(render.value.height).toBe(180);
    expect(render.value.artifact.kind).toBe("image");
    expect(render.value.artifact.format).toBe("png");
    expect(render.value.artifact.sourceRevision).toBe(2);
    expect(render.value.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(render.value.artifact.sizeBytes).toBeGreaterThan(0);
    expect(render.value.artifact.path.startsWith(path.resolve(artifactRoot))).toBe(true);
    const fileStat = await stat(render.value.artifact.path);
    expect(fileStat.size).toBe(render.value.artifact.sizeBytes);
  });

  it("preview.render_frame validates time and revision, and replays idempotently", async () => {
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      renderProvider: stubRenderProvider(),
    });
    await makeProjectWithMedia(facade, mediaRoot);

    const beyond = await facade["preview.render_frame"]({ timeSec: 5.5 });
    expect(beyond.ok).toBe(false);
    if (beyond.ok) return;
    expect(beyond.error.code).toBe("INVALID_PARAMS");

    const stale = await facade["preview.render_frame"]({ timeSec: 1, expectedRevision: 99 });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe("CONFLICT");

    const first = await facade["preview.render_frame"]({ timeSec: 2.5, idempotencyKey: "rf-1" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await facade["preview.render_frame"]({ timeSec: 2.5, idempotencyKey: "rf-1" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.replayed).toBe(true);
    expect(second.value.artifact.sha256).toBe(first.value.artifact.sha256);

    const conflict = await facade["preview.render_frame"]({ timeSec: 3, idempotencyKey: "rf-1" });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe("CONFLICT");
  });

  it("capabilities gate on artifactRoot even when provider preflights pass", async () => {
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      // NO artifactRoot: artifact-producing capabilities must report
      // unavailable even with healthy providers (no capability promises
      // what the verb then refuses).
      renderProvider: stubRenderProvider(),
      exportProvider: stubExportProvider().provider,
    });
    const caps = await facade["capabilities.get"]();
    expect(caps.ok).toBe(true);
    if (!caps.ok) return;
    expect(caps.value.preview.available).toBe(false);
    expect(caps.value.preview.reason).toContain("artifactRoot");
    expect(caps.value.export.available).toBe(false);
    expect(caps.value.verify.available).toBe(false);
    expect(caps.value.textOverlay.pixelRendering).toBe(false);
  });

  it("preview idempotent replay after artifact deletion re-renders honestly", async () => {
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      renderProvider: stubRenderProvider(),
    });
    await makeProjectWithMedia(facade, mediaRoot);
    const first = await facade["preview.render_frame"]({ timeSec: 2.5, idempotencyKey: "rf-del" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const artifactPath = first.value.artifact.path;

    const replay = await facade["preview.render_frame"]({ timeSec: 2.5, idempotencyKey: "rf-del" });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);

    // Delete the artifact: the next call with the same key must NOT replay a
    // dangling reference — it re-renders the deterministic path.
    await rm(artifactPath);
    const rerendered = await facade["preview.render_frame"]({ timeSec: 2.5, idempotencyKey: "rf-del" });
    expect(rerendered.ok).toBe(true);
    if (!rerendered.ok) return;
    expect(rerendered.value.replayed).toBe(false);
    expect(rerendered.value.artifact.path).toBe(artifactPath);
    expect(rerendered.value.artifact.sha256).toBe(first.value.artifact.sha256);
    const restored = await stat(artifactPath);
    expect(restored.size).toBeGreaterThan(0);
  });

  it("export.start snapshots the project, returns jobId immediately, replays same jobId", async () => {
    const stub = stubExportProvider({ autoSettle: "done" });
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      exportProvider: stub.provider,
    });
    await makeProjectWithMedia(facade, mediaRoot);

    const started = await facade["export.start"]({ idempotencyKey: "exp-1" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.jobId).toMatch(/^job-/);
    expect(started.value.sourceRevision).toBe(2);
    expect(started.value.replayed).toBe(false);

    // Edits continue after export.start — the job's snapshot is unaffected.
    const edited = await facade["edit.apply"]({
      ops: [{ op: "text.create", trackId: "t1", text: "later edit", startTime: 1, duration: 1 }],
      expectedRevision: 2,
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.revision).toBe(3);

    await settleMicrotasks();
    const status = await waitForJob(facade, started.value.jobId);
    expect(status.state).toBe("done");
    expect(status.sourceRevision).toBe(2);
    expect(status.artifact).not.toBeNull();
    expect(status.artifact?.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The snapshot predates the edit: exactly one text overlay was exported.
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.sourceRevision).toBe(2);
    expect(stub.requests[0]?.project.textClips).toHaveLength(1);

    // Idempotent replay returns the SAME jobId with the job's current state.
    const replay = await facade["export.start"]({ idempotencyKey: "exp-1" });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.jobId).toBe(started.value.jobId);
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.state).toBe("done");
    expect(stub.requests).toHaveLength(1);

    const conflict = await facade["export.start"]({
      idempotencyKey: "exp-1",
      settings: { videoBitrateKbps: 900 },
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe("CONFLICT");
  });

  it("job cancel path settles cancelled with no artifact; cancel on done is a no-op", async () => {
    const stub = stubExportProvider({ autoSettle: "hang" });
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      exportProvider: stub.provider,
    });
    await makeProjectWithMedia(facade, mediaRoot);

    const started = await facade["export.start"]({});
    if (!started.ok) throw new Error("start failed");
    await stub.awaitStart(started.value.jobId);

    const cancelled = await facade["job.cancel"]({ jobId: started.value.jobId });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.value.state).toBe("cancelled");
    expect(cancelled.value.artifact).toBeNull();

    const again = await facade["job.cancel"]({ jobId: started.value.jobId });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.state).toBe("cancelled");

    // A completed job: cancel answers the current state without rewinding it.
    const stub2 = stubExportProvider({ autoSettle: "done" });
    const facade2 = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      exportProvider: stub2.provider,
    });
    await makeProjectWithMedia(facade2, mediaRoot);
    const started2 = await facade2["export.start"]({});
    if (!started2.ok) throw new Error("start2 failed");
    await waitForJob(facade2, started2.value.jobId);
    const cancelDone = await facade2["job.cancel"]({ jobId: started2.value.jobId });
    expect(cancelDone.ok).toBe(true);
    if (!cancelDone.ok) return;
    expect(cancelDone.value.state).toBe("done");
    expect(cancelDone.value.artifact).not.toBeNull();

    const unknown = await facade["job.status"]({ jobId: "job-does-not-exist" });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe("NOT_FOUND");
  });

  it("a provider error settles the job to error with NO artifact published", async () => {
    const stub = stubExportProvider({ autoSettle: "error" });
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      exportProvider: stub.provider,
    });
    await makeProjectWithMedia(facade, mediaRoot);
    const started = await facade["export.start"]({});
    if (!started.ok) throw new Error("start failed");
    const status = await waitForJob(facade, started.value.jobId);
    expect(status.state).toBe("error");
    expect(status.error?.message).toContain("stub failure");
    expect(status.artifact).toBeNull();
  });

  it("verify.artifact enforces artifactRoot containment", async () => {
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      artifactVerifier: {
        id: "stub-verifier",
        preflight: async () => availablePreflight(),
        verify: async () => {
          throw new Error("should not be reached");
        },
      },
    });
    // An EXISTING file outside artifactRoot must be rejected as an escape
    // (a nonexistent path fails closed as "unresolvable" instead).
    const outsidePath = path.join(mediaRoot, "outside.mp4");
    await writeFile(outsidePath, Buffer.from("not an artifact"));
    const outside = await facade["verify.artifact"]({ path: outsidePath });
    expect(outside.ok).toBe(false);
    if (outside.ok) return;
    expect(outside.error.code).toBe("INVALID_PARAMS");
    expect(outside.error.message).toContain("artifactRoot");

    const url = await facade["verify.artifact"]({ path: "https://evil.example/x.mp4" });
    expect(url.ok).toBe(false);
    if (url.ok) return;
    expect(url.error.code).toBe("INVALID_PARAMS");
  });

  it("export.start rejects non-mp4/non-h264 settings and stale revisions", async () => {
    const stub = stubExportProvider({ autoSettle: "done" });
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      exportProvider: stub.provider,
    });
    await makeProjectWithMedia(facade, mediaRoot);

    // @ts-expect-error runtime validation of the closed schema
    const webm = await facade["export.start"]({ settings: { format: "webm" } });
    expect(webm.ok).toBe(false);
    if (webm.ok) return;
    expect(webm.error.code).toBe("INVALID_PARAMS");

    // @ts-expect-error runtime validation of the closed schema
    const vp9 = await facade["export.start"]({ settings: { codec: "vp9" } });
    expect(vp9.ok).toBe(false);
    if (vp9.ok) return;
    expect(vp9.error.code).toBe("INVALID_PARAMS");

    const stale = await facade["export.start"]({ expectedRevision: 42 });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe("CONFLICT");
  });
});
