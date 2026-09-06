import { BUNDLED_PLUGINS } from "./plugins";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentFacade, createLiveFacade, LiveWriterLease } from "./index";
import { assertUniqueToolNames, bindTools, collectPluginTools, definePlugin, defineTool, type ToolContext } from "./plugin-api";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import type { RenderFrameRequest, RenderProvider } from "./providers";
import type { LiveProjectStore } from "./live-store";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

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
  return { facade, config, requests, input: { mediaId: imported.value.mediaId, startSec: 0.1, endSec: 0.5, sampleCount: 3 } };
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
});
