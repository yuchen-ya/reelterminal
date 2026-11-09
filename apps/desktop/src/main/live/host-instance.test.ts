import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Project } from "@reelterminal/core/types/project";
import {
  type ArtifactVerifier,
  type ExportProvider,
  type JobStatusView,
  type LiveProjectStore,
} from "@reelterminal/agent-facade";
import { createEmptyProject } from "@reelterminal/agent-facade/project-factory";
import type { LiveProviders, LiveSessionHost } from "./live-session-host";
import type { LiveStoreBridge } from "./renderer-store-adapter";

const state = vi.hoisted(() => ({
  root: "",
  bridge: undefined as import("./renderer-store-adapter").LiveStoreBridge | undefined,
  providers: undefined as import("./live-session-host").LiveProviders | undefined,
  exportStarts: [] as string[],
  verifiedPaths: [] as string[],
}));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return path.join(state.root, "user-data");
      return path.join(state.root, name);
    },
    getVersion: () => "test",
  },
}));
vi.mock("../data-root", () => ({
  agentWorkspaceDefault: () => path.join(state.root, "default-workspace"),
}));
vi.mock("../ipc/controlled-media", () => ({
  controlledMediaRoot: () => path.join(state.root, "controlled-media"),
}));
vi.mock("../ipc/review-files", () => ({ getReviewFileStore: vi.fn() }));
vi.mock("./review-media-bridge", () => ({ createReviewMediaBridge: vi.fn() }));
vi.mock("./renderer-store-adapter", () => ({
  installLiveStoreBridge: vi.fn(),
  liveTargetWebContents: () => null,
}));
vi.mock("./access-instance", async () => {
  const { createAgentAccessPreferenceStore } = await import("./access-preference");
  return { getAgentAccessPreferenceStore: () => createAgentAccessPreferenceStore() };
});
vi.mock("@reelterminal/runtime-chromium", () => ({
  createChromiumProviders: vi.fn(),
  FfmpegArtifactVerifier: vi.fn(),
  adaptPerfSinkForExport: vi.fn(),
}));
vi.mock("./live-session-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./live-session-host")>();
  return {
    ...actual,
    createLiveSessionHost: (deps: import("./live-session-host").LiveSessionHostDeps) =>
      actual.createLiveSessionHost({
        ...deps,
        installStoreBridge: () => {
          if (!state.bridge) throw new Error("test bridge is not initialized");
          return state.bridge;
        },
        createProviders: () => {
          if (!state.providers) throw new Error("test providers are not initialized");
          return state.providers;
        },
        endpointFilePath: path.join(state.root, "isolated-live-endpoint.json"),
        port: 0,
      }),
  };
});

import { disposeLiveSessionHost, getLiveSessionHost } from "./host-instance";

const projectTarget = {
  projectId: "project-host-test",
  workspaceId: "workspace-host-test",
};

function textProject(): Project {
  const base = createEmptyProject("Host delivery wiring");
  return {
    ...base,
    id: projectTarget.projectId,
    timeline: {
      ...base.timeline,
      duration: 2,
      tracks: [{
        id: "text-track",
        type: "text",
        name: "Text",
        clips: [],
      } as unknown as Project["timeline"]["tracks"][number]],
    },
    textClips: [{
      id: "text-clip",
      trackId: "text-track",
      startTime: 0,
      duration: 2,
      text: "delivery fixture",
      style: {},
      transform: {
        position: { x: 0.5, y: 0.5 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      keyframes: [],
    } as unknown as NonNullable<Project["textClips"]>[number]],
  };
}

function makeBridge(): LiveStoreBridge {
  const project = textProject();
  const store = {
    getIdentity: async () => ({
      projectId: project.id,
      projectName: project.name,
      workspaceId: projectTarget.workspaceId,
      workspaceInstanceId: "runtime-host-test",
      windowId: "window-host-test",
    }),
    getState: async () => ({ project: structuredClone(project), revision: 0 }),
  } as LiveProjectStore;
  return {
    store,
    workspaceLibrary: async (request) => {
      if (request.verb === "retainTaskInputs") {
        return { ok: true, result: { inputProject: request.params.inputProject } };
      }
      if (request.verb === "releaseTaskInputs") return { ok: true, result: null };
      if (request.verb === "prepareRenderFonts") {
        return { ok: true, result: { project: request.params.project } };
      }
      return {
        ok: false,
        error: { code: "UNSUPPORTED", message: `Unexpected test bridge verb: ${request.verb}` },
      };
    },
    handleResponse: () => undefined,
    teardown: () => undefined,
    pendingCount: 0,
  };
}

function makeProviders(): LiveProviders {
  const exportProvider: ExportProvider = {
    id: "host-wiring-stub-export",
    preflight: async () => ({ available: true, details: { route: "stub" } }),
    startExport: async (request, callbacks) => {
      state.exportStarts.push(request.jobId);
      callbacks.onRunning();
      const output = path.join(request.jobDir, "output.mp4");
      await writeFile(output, "host-wiring-mp4-bytes");
      callbacks.onDone({
        path: output,
        sizeBytes: (await stat(output)).size,
        route: "chromium-webcodecs",
        framesEncoded: 60,
      });
    },
    cancel: async () => undefined,
  };
  const artifactVerifier: ArtifactVerifier = {
    id: "host-wiring-stub-verifier",
    preflight: async () => ({ available: true }),
    verify: async (request) => {
      state.verifiedPaths.push(request.path);
      return {
        pass: true,
        probe: {
          container: "mp4",
          videoCodec: "h264",
          audioCodec: "aac",
          width: 320,
          height: 180,
          durationSec: 2,
          frameCount: 60,
          frameRate: 30,
          sizeBytes: (await stat(request.path)).size,
          sha256: "host-wiring-sha256",
        },
        checks: [{ name: "container", pass: true, details: "stub probe" }],
      };
    },
  };
  return {
    exportProvider,
    artifactVerifier,
    close: vi.fn(async () => undefined),
  };
}

async function startHost(): Promise<LiveSessionHost> {
  const host = getLiveSessionHost();
  await host.enable();
  await host.setAccess("write");
  return host;
}

async function readCapabilities(host: LiveSessionHost, kind?: "video" | "review") {
  const result = await host.callExternal("capabilities.get", kind ? { kind } : {});
  if (!result.ok) throw new Error(`capabilities.get failed: ${result.error.message}`);
  return result.value as {
    mediaImport: { recommendedRoot: string | null };
    export: { details: { deliveryRoots: string[] } };
  };
}

async function waitForDelivery(host: LiveSessionHost, jobId: string): Promise<JobStatusView> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const result = await host.callExternal("job.status", { ...projectTarget, jobId });
    if (!result.ok) throw new Error(`job.status failed: ${result.error.message}`);
    const status = result.value as JobStatusView;
    if (
      status.state === "error" ||
      status.state === "cancelled" ||
      (status.state === "done" && (status.deliveredTo !== null || status.deliveryError !== null))
    ) {
      return status;
    }
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function exportAndVerify(host: LiveSessionHost, destination: string, key: string) {
  const started = await host.callExternal("export.start", {
    ...projectTarget,
    destinationPath: destination,
    idempotencyKey: key,
    expectedRevision: 0,
  });
  if (!started.ok) throw new Error(`export.start failed: ${started.error.code}: ${started.error.message}`);
  const jobId = (started.value as { jobId: string }).jobId;
  const done = await waitForDelivery(host, jobId);
  expect(done.state).toBe("done");
  expect(done.deliveryError).toBeNull();
  expect(done.deliveredTo).not.toBeNull();
  expect(await readFile(done.deliveredTo!, "utf8")).toBe("host-wiring-mp4-bytes");

  const verified = await host.callExternal("verify.artifact", { ...projectTarget, path: done.deliveredTo });
  expect(verified).toMatchObject({ ok: true, value: { pass: true } });
  expect(state.verifiedPaths.at(-1)).toBe(done.deliveredTo);
  return done;
}

async function expectNoExportTask(destination: string): Promise<void> {
  expect(state.exportStarts).toEqual([]);
  expect(existsSync(destination)).toBe(false);
  const recordsDir = path.join(state.root, "user-data", "live-artifacts", "task-records");
  const entries = await readdir(recordsDir).catch(() => [] as string[]);
  expect(entries.filter((entry) => entry.endsWith(".status.json"))).toEqual([]);
}

beforeEach(async () => {
  state.root = await mkdtemp(path.join(tmpdir(), "host-instance-delivery-"));
  state.bridge = makeBridge();
  state.providers = makeProviders();
  state.exportStarts = [];
  state.verifiedPaths = [];
  vi.stubEnv("REELTERMINAL_AGENT_WORKSPACE_ROOT", path.join(state.root, "agent-workspace"));
  vi.stubEnv("REELTERMINAL_LIVE_DELIVERY_ROOTS", "");
  vi.stubEnv("REELTERMINAL_LIVE_MEDIA_ROOTS", "");
});

afterEach(async () => {
  await disposeLiveSessionHost();
  vi.unstubAllEnvs();
  await rm(state.root, { recursive: true, force: true });
  state.bridge = undefined;
  state.providers = undefined;
});

describe("production host delivery roots", () => {
  it("D01 delivers from the video recommendation and the legacy parent workspace", async () => {
    const host = await startHost();
    const workspace = path.join(state.root, "agent-workspace");
    const videoRoot = path.join(workspace, "video");
    const reviewRoot = path.join(workspace, "review");

    const videoCapabilities = await readCapabilities(host, "video");
    expect(videoCapabilities.mediaImport.recommendedRoot).toBe(videoRoot);
    expect(videoCapabilities.export.details.deliveryRoots).toEqual([videoRoot, workspace]);
    expect((await readCapabilities(host)).mediaImport.recommendedRoot).toBe(workspace);
    expect((await readCapabilities(host, "review")).mediaImport.recommendedRoot).toBe(reviewRoot);

    for (const [index, deliveryRoot] of [videoRoot, workspace].entries()) {
      const output = path.join(deliveryRoot, "jobs", `2026-11-09-d01-${index}`, "output");
      await mkdir(output, { recursive: true });
      const destination = path.join(output, "delivered.mp4");
      const done = await exportAndVerify(host, destination, `d01-${index}`);
      expect(done.deliveredTo).toBe(path.join(await realpath(output), "delivered.mp4"));
    }
    expect(state.exportStarts).toHaveLength(2);
  }, 15_000);

  it("D02 rejects review output without creating a task or file", async () => {
    const host = await startHost();
    const workspace = path.join(state.root, "agent-workspace");
    const reviewCapabilities = await readCapabilities(host, "review");
    expect(reviewCapabilities.mediaImport.recommendedRoot).toBe(path.join(workspace, "review"));
    expect(reviewCapabilities.export.details.deliveryRoots).not.toContain(reviewCapabilities.mediaImport.recommendedRoot);

    const output = path.join(reviewCapabilities.mediaImport.recommendedRoot!, "jobs", "2026-11-09-d02", "output");
    await mkdir(output, { recursive: true });
    const destination = path.join(output, "review-escape.mp4");
    const result = await host.callExternal("export.start", { ...projectTarget, destinationPath: destination, expectedRevision: 0 });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    await expectNoExportTask(destination);
  });

  it("D03 rejects a job output link that resolves outside every delivery root", async () => {
    const host = await startHost();
    const videoRoot = (await readCapabilities(host, "video")).mediaImport.recommendedRoot!;
    const jobDir = path.join(videoRoot, "jobs", "2026-11-09-d03");
    const outside = path.join(state.root, "outside-delivery");
    await mkdir(jobDir, { recursive: true });
    await mkdir(outside, { recursive: true });
    const linkedOutput = path.join(jobDir, "output");
    await symlink(outside, linkedOutput, process.platform === "win32" ? "junction" : "dir");
    const destination = path.join(linkedOutput, "escape.mp4");

    const result = await host.callExternal("export.start", { ...projectTarget, destinationPath: destination, expectedRevision: 0 });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    await expectNoExportTask(destination);
    expect(await readdir(outside)).toEqual([]);
  });

  it("keeps an explicit delivery-root override exclusive of default roots", async () => {
    const override = path.join(state.root, "explicit-delivery");
    await mkdir(override, { recursive: true });
    vi.stubEnv("REELTERMINAL_LIVE_DELIVERY_ROOTS", override);
    const host = await startHost();
    const capabilities = await readCapabilities(host, "video");
    expect(capabilities.export.details.deliveryRoots).toEqual([override]);

    const output = path.join(capabilities.mediaImport.recommendedRoot!, "jobs", "2026-11-09-override", "output");
    await mkdir(output, { recursive: true });
    const destination = path.join(output, "not-granted.mp4");
    const result = await host.callExternal("export.start", { ...projectTarget, destinationPath: destination, expectedRevision: 0 });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    await expectNoExportTask(destination);
  });
});
