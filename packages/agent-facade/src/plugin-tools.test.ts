import { BUNDLED_PLUGINS } from "./plugins";
import { afterEach, describe, expect, it } from "vitest";
import { copyFile, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentFacade, createLiveFacade, LiveWriterLease } from "./index";
import { assertUniqueToolNames, bindTools, collectPluginTools, definePlugin, defineTool, type ToolContext } from "./plugin-api";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import type { RenderFrameRequest, RenderProvider } from "./providers";
import type { LiveProjectStore } from "./live-store";
import type { Project } from "@reelterminal/core/types/project";
import { AgentFacadeSession } from "./session";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const dirs: string[] = [];
const liveSessions: ReturnType<typeof createLiveFacade>[] = [];
afterEach(async () => {
  await Promise.all(liveSessions.splice(0).map((live) => live.dispose()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "source-plugin-")); dirs.push(root);
  const requests: RenderFrameRequest[] = [];
  const provider: RenderProvider = {
    id: "test", preflight: async () => ({ available: true }),
    async renderFramePng(request) { requests.push(request); await writeFile(request.destPath, PNG); return { bytesWritten: PNG.length }; },
    async renderContactSheetPng(request) { await writeFile(request.destPath, PNG); return { bytesWritten: PNG.length }; },
  };
  const config = { mediaRoots: [root], artifactRoot: path.join(root, "artifacts"), renderProvider: provider };
  const facade = createAgentFacade(config);
  await facade["project.create"]({ name: "Keep this project" });
  const imported = await facade["media.import"]({ path: writeTinyMp4(root) });
  if (!imported.ok) throw new Error(imported.error.message);
  const openLive = async (mutate?: (project: Project) => void) => {
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("No project");
    mutate?.(state.value.project);
    const store = { getState: async () => structuredClone(state.value) } as unknown as LiveProjectStore;
    const live = createLiveFacade({ ...config, store, sessionId: `source-test-${liveSessions.length}`, access: "read-only", lease: new LiveWriterLease() });
    liveSessions.push(live);
    return live;
  };
  return { facade, config, requests, openLive, input: { mediaId: imported.value.mediaId, startSec: 0.1, endSec: 0.5, sampleCount: 3 } };
}

describe("bundled tool plugins", () => {
  it("binds a second tool from its definition, with typed execution and strict input validation", async () => {
    const plugin = definePlugin({ id: "example", tools: [defineTool({
      name: "example.echo", description: "Echo", effect: "read", schemaCases: [],
      input: { message: { required: true, check: (v) => typeof v === "string", describe: "string", emits: { kind: "leaf", schema: { type: "string" } } } },
      output: { type: "string" }, async execute(input: { message: string }) { return input.message; },
    })] });
    const tools = bindTools(collectPluginTools([...BUNDLED_PLUGINS, plugin]), {} as ToolContext);
    expect(await tools["example.echo"]({ message: "hello" })).toEqual({ ok: true, value: "hello" });
    expect(await tools["example.echo"]({ message: 1 } as never)).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(() => assertUniqueToolNames(["example.echo", "example_echo"])).toThrow("Duplicate");
  });

  it("inspects an unplaced source with source timestamps and no project changes; concurrent ranges never overwrite", async () => {
    const { facade, input, requests } = await setup();
    const before = await facade["project.get_state"]();
    const [a, b] = await Promise.all([facade["media.inspect"](input), facade["media.inspect"]({ ...input, startSec: 0.2 })]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error("Inspection failed");
    expect(a.value.frames.map((frame) => frame.timeSec)).toEqual([0.1, 0.30000000000000004, 0.45]);
    expect(a.value.contactSheet?.path).not.toEqual(b.value.contactSheet?.path);
    expect(a.value.frames[0].artifact.path).not.toEqual(b.value.frames[0].artifact.path);
    expect(requests.every((request) => request.project.timeline.tracks[0].clips[0].inPoint === 0)).toBe(true);
    expect(await facade["project.get_state"]()).toEqual(before);
  });

  it("dense explicit times and paired ROI expose short events missed by a uniform overview", async () => {
    const { facade, input, requests, config } = await setup();
    Object.assign(config.renderProvider, { supportsRegion: true });
    const overview = await facade["media.inspect"]({ ...input, sampleCount: 2 });
    if (!overview.ok) throw new Error(overview.error.message);
    expect(overview.value.frames.some((f) => f.timeSec >= .29 && f.timeSec <= .31)).toBe(false);
    const detailed = await facade["media.inspect"]({ mediaId: input.mediaId, startSec: .25, endSec: .35, timesSec: [.29, .3, .31], roi: { x: .7, y: 0, width: .3, height: .2 } });
    expect(detailed).toMatchObject({ ok: true, value: { coordinateSpace: "source", frames: [{ timeSec: .29, regionArtifact: { format: "png" } }, { timeSec: .3 }, { timeSec: .31 }] } });
    expect(requests.filter((r) => r.region).map((r) => r.timeSec)).toEqual([.29, .3, .31]);
    expect(await facade["media.inspect"]({ ...input, timesSec: [.3] })).toMatchObject({ ok: false });
    expect(await facade["media.inspect"]({ mediaId: input.mediaId, startSec: .1, endSec: .5, timesSec: [.5] })).toMatchObject({ ok: false });
    expect(await facade["media.inspect"]({ ...input, roi: { x: .9, y: 0, width: .5, height: .2 } })).toMatchObject({ ok: false });
  });

  it("reports source trim/speed mapping without mutating project state", async () => {
    const { facade, input } = await setup();
    await facade["edit.apply"]({ ops: [{ op: "track.add", trackType: "video", trackId: "v1" }, { op: "clip.add", trackId: "v1", mediaId: input.mediaId, startTime: 2, inPoint: .1, outPoint: .5, clipId: "c1" }, { op: "clip.setSpeed", clipId: "c1", speed: 2 }] });
    const before = await facade["project.get_state"]();
    const result = await facade["media.inspect"](input);
    expect(result).toMatchObject({ ok: true, value: { timeMappings: [{ clipId: "c1", sourceInSec: .1, sourceOutSec: .5, timelineStartSec: 2, speed: 2 }] } });
    expect(await facade["project.get_state"]()).toEqual(before);
  });

  it("rejects invalid ranges, stale revisions and unsupported media before rendering", async () => {
    const { facade, input, requests } = await setup();
    for (const bad of [{ ...input, startSec: 0.5 }, { ...input, endSec: 100 }, { ...input, width: 3 }]) {
      expect(await facade["media.inspect"](bad)).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    }
    expect(await facade["media.inspect"]({ ...input, expectedRevision: 99 })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(await facade["media.inspect"]({ ...input, mediaId: "missing" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(requests).toHaveLength(0);
    const caps = await createAgentFacade()["capabilities.get"]();
    expect(caps).toMatchObject({ ok: true, value: { pluginTools: { "media.inspect": { available: false } } } });
  });

  it("runs the same plugin on a live read-only snapshot without calling the store's mutation methods", async () => {
    const { facade, config, input } = await setup();
    const before = await facade["project.get_state"]();
    if (!before.ok) throw new Error("No project");
    const store = { getState: async () => structuredClone(before.value) } as unknown as LiveProjectStore;
    const live = createLiveFacade({ ...config, store, sessionId: "read-only-test", access: "read-only", lease: new LiveWriterLease() });
    expect(await live["media.inspect"](input)).toMatchObject({ ok: true, value: { sourceRevision: before.value.revision } });
    expect(await live["project.get_state"]()).toEqual(before);
    await live.dispose();
  });

  it("returns frames if contact-sheet composition fails and rejects sources outside current roots", async () => {
    const { facade, config, input } = await setup();
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("No project");
    const store = { getState: async () => structuredClone(state.value) } as unknown as LiveProjectStore;
    const live = createLiveFacade({ ...config, mediaRoots: [], store, sessionId: "root-test", access: "read-only", lease: new LiveWriterLease() });
    expect(await live["media.inspect"](input)).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    await live.dispose();
    config.renderProvider.renderContactSheetPng = async () => { throw new Error("No sheet"); };
    expect(await facade["media.inspect"](input)).toMatchObject({ ok: true, value: { contactSheet: null } });
  });

  it.each([
    { id: "M01", original: "deleted" },
    { id: "M02", original: "replaced" },
  ] as const)("$id media.inspect reads only the controlled copy and preserves the snapshot", async ({ original }) => {
    const { facade, config, input, requests, openLive } = await setup();
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("No project");
    const originalPath = state.value.project.mediaLibrary.items[0]!.originalUrl!;
    const controlledPath = path.join(config.mediaRoots[0]!, "controlled-A.mp4");
    await copyFile(originalPath, controlledPath);
    const live = await openLive((project) => {
      project.mediaLibrary.items[0] = { ...project.mediaLibrary.items[0]!, contentUrl: controlledPath };
    });
    if (original === "deleted") await rm(originalPath);
    else await writeFile(originalPath, "visually different original B");
    const before = await live["project.get_state"]();
    const result = await live["media.inspect"](input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const file = await stat(controlledPath);
    const resolvedControlled = await realpath(controlledPath);
    expect(result.value.sourceFingerprint).toEqual({ size: file.size, lastModified: Math.round(file.mtimeMs) });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.mediaFiles[input.mediaId] === resolvedControlled)).toBe(true);
    expect(await live["project.get_state"]()).toEqual(before);
  });

  it("M03 reports a missing controlled copy without rendering the readable original", async () => {
    const { config, input, requests, openLive } = await setup();
    const controlledPath = path.join(config.mediaRoots[0]!, "missing-controlled.mp4");
    const live = await openLive((project) => {
      project.mediaLibrary.items[0] = { ...project.mediaLibrary.items[0]!, contentUrl: controlledPath };
    });
    const result = await live["media.inspect"](input);
    expect(result).toMatchObject({ ok: false, error: {
      code: "NOT_FOUND",
      details: { reason: "source_missing", mediaId: input.mediaId, sourceKind: "controlled" },
    } });
    if (!result.ok) expect(result.error.message).toMatch(/without falling back|no fallback|refusing to fall back/i);
    expect(requests).toHaveLength(0);
  });

  it.each(["", null])("M03 treats malformed controlled contentUrl %s as authoritative, never as a fallback", async (contentUrl) => {
    const { input, requests, openLive } = await setup();
    const live = await openLive((project) => {
      project.mediaLibrary.items[0] = { ...project.mediaLibrary.items[0]!, contentUrl: contentUrl as string };
    });
    expect(await live["media.inspect"](input)).toMatchObject({ ok: false, error: {
      code: "UNSUPPORTED",
      details: { reason: "file_backing_unavailable", mediaId: input.mediaId, sourceKind: "controlled" },
    } });
    expect(requests).toHaveLength(0);
  });

  it("M04 rejects a controlled copy outside media roots without reading the original", async () => {
    const { facade, input, requests, openLive } = await setup();
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("No project");
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "source-outside-"));
    dirs.push(outsideRoot);
    const controlledPath = path.join(outsideRoot, "controlled-A.mp4");
    await copyFile(state.value.project.mediaLibrary.items[0]!.originalUrl!, controlledPath);
    const live = await openLive((project) => {
      project.mediaLibrary.items[0] = { ...project.mediaLibrary.items[0]!, contentUrl: controlledPath };
    });
    expect(await live["media.inspect"](input)).toMatchObject({ ok: false, error: {
      code: "INVALID_PARAMS",
      details: { reason: "outside_roots", mediaId: input.mediaId, sourceKind: "controlled" },
    } });
    expect(requests).toHaveLength(0);
  });

  it("M05 keeps legacy originalUrl media and classifies unknown, missing and unbacked records", async () => {
    const { facade, input, requests, openLive } = await setup();
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("No project");
    const originalPath = state.value.project.mediaLibrary.items[0]!.originalUrl!;
    const legacy = await openLive();
    const valid = await legacy["media.inspect"](input);
    expect(valid.ok).toBe(true);
    if (!valid.ok) throw new Error(valid.error.message);
    const originalStat = await stat(originalPath);
    expect(valid.value.sourceFingerprint).toEqual({ size: originalStat.size, lastModified: Math.round(originalStat.mtimeMs) });
    expect(await legacy["media.inspect"]({ ...input, mediaId: "unknown" })).toMatchObject({ ok: false, error: {
      code: "NOT_FOUND", details: { reason: "media_not_found", mediaId: "unknown" },
    } });

    await rm(originalPath);
    const requestCount = requests.length;
    expect(await legacy["media.inspect"](input)).toMatchObject({ ok: false, error: {
      code: "NOT_FOUND", details: { reason: "source_missing", mediaId: input.mediaId, sourceKind: "original" },
    } });
    expect(requests).toHaveLength(requestCount);

    const unbacked = await openLive((project) => {
      const { originalUrl: _originalUrl, contentUrl: _contentUrl, ...item } = project.mediaLibrary.items[0]!;
      project.mediaLibrary.items[0] = item;
    });
    expect(await unbacked["media.inspect"](input)).toMatchObject({ ok: false, error: {
      code: "UNSUPPORTED", details: { reason: "file_backing_unavailable", mediaId: input.mediaId, sourceKind: "original" },
    } });
  });

  it("M02 maps headless timeline previews to the controlled source", async () => {
    const { facade, config, input, requests } = await setup();
    await facade["edit.apply"]({ ops: [
      { op: "track.add", trackType: "video", trackId: "v1" },
      { op: "clip.add", trackId: "v1", mediaId: input.mediaId, clipId: "c1", startTime: 0, inPoint: 0, outPoint: 0.5 },
    ] });
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("No project");
    const controlledPath = path.join(config.mediaRoots[0]!, "headless-controlled.mp4");
    await copyFile(state.value.project.mediaLibrary.items[0]!.originalUrl!, controlledPath);
    state.value.project.mediaLibrary.items[0] = { ...state.value.project.mediaLibrary.items[0]!, contentUrl: controlledPath };
    const session = new AgentFacadeSession(config);
    (session as unknown as { project: Project }).project = state.value.project;
    const preview = await session.previewRenderFrame({ timeSec: 0.2 });
    expect(preview.ok).toBe(true);
    expect(requests.at(-1)?.mediaFiles[input.mediaId]).toBe(await realpath(controlledPath));
  });
});
