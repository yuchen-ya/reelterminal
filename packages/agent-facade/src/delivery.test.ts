/**
 * export.start destinationPath (Agent workspace delivery) — unit rules for
 * resolveDeliveryDestination plus headless end-to-end delivery through the
 * job registry with a stub ExportProvider. Live parity is pinned in
 * live-session.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAgentFacade, type AgentFacade } from "./index";
import {
  deliverExportArtifact,
  resolveDeliveryDestination,
} from "./delivery";
import type {
  ExportCallbacks,
  ExportProvider,
  ExportVideoRequest,
} from "./providers";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";

let root: string;
let mediaRoot: string;
let artifactRoot: string;
let deliveryRoot: string;
let outputDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "delivery-test-"));
  mediaRoot = path.join(root, "media");
  artifactRoot = path.join(root, "artifacts");
  deliveryRoot = path.join(root, "workspace");
  outputDir = path.join(deliveryRoot, "jobs", "2026-09-03-demo", "output");
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await mkdir(outputDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const dest = (name = "promo.mp4") => path.join(outputDir, name);

/* ------------------------- destination rules ------------------------- */

describe("resolveDeliveryDestination", () => {
  it("fails INVALID_PARAMS with the requirement when no delivery roots exist", async () => {
    await expect(resolveDeliveryDestination(dest(), [], "export.start")).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      message: expect.stringContaining("no delivery roots"),
    });
  });

  it("refuses relative paths and URLs", async () => {
    await expect(
      resolveDeliveryDestination("jobs/x/output/a.mp4", [deliveryRoot], "export.start"),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(
      resolveDeliveryDestination("file:///tmp/a.mp4", [deliveryRoot], "export.start"),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("refuses non-mp4 destinations (the only export container)", async () => {
    await expect(
      resolveDeliveryDestination(dest("promo.mov"), [deliveryRoot], "export.start"),
    ).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      message: expect.stringContaining(".mp4"),
    });
  });

  it("refuses a missing output directory instead of creating it silently", async () => {
    const missing = path.join(
      deliveryRoot,
      "jobs",
      "2026-09-04-other",
      "output",
      "a.mp4",
    );
    await expect(
      resolveDeliveryDestination(missing, [deliveryRoot], "export.start"),
    ).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      message: expect.stringContaining("does not exist"),
    });
  });

  it("refuses paths outside the jobs/<slug>/output layout", async () => {
    const workspaceLevel = path.join(deliveryRoot, "a.mp4");
    const jobLevel = path.join(deliveryRoot, "jobs", "2026-09-03-demo", "a.mp4");
    const siblingDir = path.join(deliveryRoot, "jobs", "2026-09-03-demo", "generated", "a.mp4");
    await mkdir(path.dirname(siblingDir), { recursive: true });
    for (const candidate of [workspaceLevel, jobLevel, siblingDir]) {
      await expect(
        resolveDeliveryDestination(candidate, [deliveryRoot], "export.start"),
      ).rejects.toMatchObject({
        code: "INVALID_PARAMS",
        message: expect.stringContaining("jobs/<slug>/output"),
      });
    }
  });

  it("accepts a fresh .mp4 inside jobs/<slug>/output and resolves symlinks", async () => {
    const resolved = await resolveDeliveryDestination(dest(), [deliveryRoot], "export.start");
    expect(resolved.path.endsWith(path.join("jobs", "2026-09-03-demo", "output", "promo.mp4"))).toBe(true);
  });

  it("fails CONFLICT on an existing file (delivery never overwrites)", async () => {
    await writeFile(dest(), "already here");
    await expect(
      resolveDeliveryDestination(dest(), [deliveryRoot], "export.start"),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("never overwrites"),
    });
  });

  it("fails CONFLICT on a dangling symlink at the destination", async () => {
    await symlink(path.join(outputDir, "nowhere.mp4"), dest());
    await expect(
      resolveDeliveryDestination(dest(), [deliveryRoot], "export.start"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("deliverExportArtifact copies bytes and never overwrites (COPYFILE_EXCL)", async () => {
    const source = path.join(artifactRoot, "output.mp4");
    await writeFile(source, "stub-mp4-bytes");
    const resolved = await resolveDeliveryDestination(dest(), [deliveryRoot], "export.start");
    await deliverExportArtifact(source, resolved);
    expect(await readFile(dest(), "utf8")).toBe("stub-mp4-bytes");
    await expect(deliverExportArtifact(source, resolved)).rejects.toThrow();
  });
});

/* ---------------------- headless end-to-end -------------------------- */

function stubDeliveryExportProvider(hooks?: {
  onStart?: (request: ExportVideoRequest) => Promise<void>;
}): ExportProvider {
  return {
    id: "stub-export-delivery",
    preflight: async () => ({ available: true, details: { route: "stub" } }),
    startExport: async (request, callbacks: ExportCallbacks) => {
      callbacks.onRunning();
      await hooks?.onStart?.(request);
      const finalPath = path.join(request.jobDir, "output.mp4");
      await writeFile(finalPath, Buffer.from("stub-mp4-bytes"));
      callbacks.onDone({
        path: finalPath,
        sizeBytes: (await readFile(finalPath)).length,
        route: "chromium-webcodecs",
        framesEncoded: 150,
      });
    },
    cancel: async () => undefined,
  };
}

async function waitForJob(
  facade: AgentFacade,
  jobId: string,
  awaitDelivery = false,
) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const status = await facade["job.status"]({ jobId });
    if (!status.ok) throw new Error(`job.status failed: ${status.error.message}`);
    if (status.value.state !== "queued" && status.value.state !== "running") {
      // Delivery is a post-done copy outside the serialized lane; when the
      // test cares about its outcome, wait until it has settled too.
      if (
        !awaitDelivery ||
        status.value.state !== "done" ||
        status.value.deliveredTo !== null ||
        status.value.deliveryError !== null
      ) {
        return status.value;
      }
    }
    if (Date.now() > deadline) throw new Error("job did not settle");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function makeProjectWithMedia(facade: AgentFacade) {
  const inputPath = writeTinyMp4(mediaRoot);
  await facade["project.create"]({
    name: "Delivery",
    settings: { width: 320, height: 180, frameRate: 30, sampleRate: 48000, channels: 2 },
  });
  const imported = await facade["media.import"]({ path: inputPath, expectedRevision: 0 });
  if (!imported.ok) throw new Error("import failed");
  const edited = await facade["edit.apply"]({
    ops: [
      { op: "track.add", trackType: "video", trackId: "v1" },
      { op: "clip.add", trackId: "v1", mediaId: imported.value.mediaId, startTime: 0, clipId: "c1" },
    ],
    expectedRevision: 1,
  });
  if (!edited.ok) throw new Error("edit failed");
}

describe("export.start destinationPath (headless end-to-end)", () => {
  it("delivers the verified artifact into the workspace output directory", async () => {
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      deliveryRoots: [deliveryRoot],
      exportProvider: stubDeliveryExportProvider(),
    });
    await makeProjectWithMedia(facade);

    const started = await facade["export.start"]({
      destinationPath: dest(),
      idempotencyKey: "exp-deliver-1",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const done = await waitForJob(facade, started.value.jobId, true);
    expect(done.state).toBe("done");
    expect(done.artifact).not.toBeNull();
    expect(done.deliveryError).toBeNull();
    expect(done.deliveredTo).not.toBeNull();
    // The delivered copy carries the artifact's bytes; the artifactRoot
    // original stays in place (delivery is a copy, not a move).
    expect(await readFile(done.deliveredTo!, "utf8")).toBe("stub-mp4-bytes");
    expect(await readFile(done.artifact!.path, "utf8")).toBe("stub-mp4-bytes");

    // A replay of the same key+payload replays the same job (no second copy).
    const replay = await facade["export.start"]({
      destinationPath: dest(),
      idempotencyKey: "exp-deliver-1",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.jobId).toBe(started.value.jobId);
  });

  it("reports deliveredTo/deliveryError as null when no destination was requested", async () => {
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      deliveryRoots: [deliveryRoot],
      exportProvider: stubDeliveryExportProvider(),
    });
    await makeProjectWithMedia(facade);
    const started = await facade["export.start"]({});
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const done = await waitForJob(facade, started.value.jobId);
    expect(done.state).toBe("done");
    expect(done.deliveredTo).toBeNull();
    expect(done.deliveryError).toBeNull();
  });

  it("fails fast with zero side effects when destinationPath is invalid", async () => {
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      deliveryRoots: [deliveryRoot],
      exportProvider: stubDeliveryExportProvider(),
    });
    await makeProjectWithMedia(facade);
    const bad = await facade["export.start"]({
      destinationPath: path.join(deliveryRoot, "not-a-job-output.mp4"),
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.code).toBe("INVALID_PARAMS");
    // No job was created: a subsequent export without destinationPath works.
    const good = await facade["export.start"]({});
    expect(good.ok).toBe(true);
  });

  it("keeps the job done with the artifact and reports deliveryError when the copy loses a race", async () => {
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      deliveryRoots: [deliveryRoot],
      exportProvider: stubDeliveryExportProvider({
        // The destination appears AFTER export.start validated it (a
        // same-name file shows up mid-export) — COPYFILE_EXCL must lose.
        onStart: async () => {
          await writeFile(dest(), "racer");
        },
      }),
    });
    await makeProjectWithMedia(facade);
    const started = await facade["export.start"]({ destinationPath: dest() });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const done = await waitForJob(facade, started.value.jobId, true);
    expect(done.state).toBe("done");
    expect(done.artifact).not.toBeNull();
    expect(done.deliveredTo).toBeNull();
    expect(done.deliveryError).not.toBeNull();
    // The racer's bytes are untouched — no overwrite, ever.
    expect(await readFile(dest(), "utf8")).toBe("racer");
  });

  it("fails INVALID_PARAMS before any job when deliveryRoots are not configured", async () => {
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      exportProvider: stubDeliveryExportProvider(),
    });
    await makeProjectWithMedia(facade);
    const result = await facade["export.start"]({ destinationPath: dest() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_PARAMS");
    expect(result.error.message).toContain("no delivery roots");
  });

  it("advertises delivery roots and the destinationPath rule in capabilities", async () => {
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      deliveryRoots: [deliveryRoot],
      exportProvider: stubDeliveryExportProvider(),
    });
    const caps = await facade["capabilities.get"]();
    expect(caps.ok).toBe(true);
    if (!caps.ok) return;
    const details = caps.value.export.details as Record<string, unknown>;
    expect(details.deliveryRoots).toEqual([deliveryRoot]);
    expect(details.destinationPathRule).toEqual(
      expect.stringContaining("destinationPath"),
    );
  });
});
