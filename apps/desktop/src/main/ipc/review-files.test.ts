import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FacadeError } from "@reelterminal/agent-facade/errors";
import { CHANNELS } from "../../shared/channels";
import { fileReply, getReviewFileStore, registerReviewFilesIpc } from "./review-files";
import { extractReviewFileFrames } from "../live/review-media-bridge";

const state = vi.hoisted(() => ({ root: "", handlers: new Map<string, (args: unknown) => Promise<unknown>>(), extract: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => state.root } }));
vi.mock("../data-root", () => ({ getDataRootLayout: () => ({ review: state.root }) }));
vi.mock("./index", () => ({ handle: (channel: string, _schema: unknown, handler: (args: unknown) => Promise<unknown>) => state.handlers.set(channel, handler) }));
vi.mock("./fs", () => ({ isAllocatedTempFile: () => false }));
vi.mock("../review-media-probe", () => ({ inspectReviewMedia: async () => ({ mime: "image/png", metadata: { type: "image", width: 2, height: 2 } }) }));
vi.mock("@reelterminal/agent-facade/plugins/frame-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@reelterminal/agent-facade/plugins/frame-tools")>();
  return { ...actual, frameToolsPlugin: { ...actual.frameToolsPlugin,
    tools: [{ ...actual.frameToolsPlugin.tools[0], execute: state.extract }] } };
});

afterEach(async () => { if (state.root) await rm(state.root, { recursive: true }); });

it.each(["JOB_FAILED", "ACTION_FAILED"] as const)("returns a structured %s facade failure with its original message", async (code) => {
  await expect(fileReply(async () => { throw new FacadeError(code, "decoder could not complete"); }))
    .resolves.toEqual({ ok: false, error: { code: "ACTION_FAILED", reason: code, message: "decoder could not complete" } });
});

it("propagates unknown internal errors", async () => {
  const failure = new Error("unexpected invariant failure");
  await expect(fileReply(async () => { throw failure; })).rejects.toBe(failure);
});

it("removes a saved frame's candidate job only after a verified managed copy exists", async () => {
  state.root = await mkdtemp(path.join(tmpdir(), "review-capture-"));
  const store = getReviewFileStore();
  const video = path.join(state.root, "source.mp4");
  await writeFile(video, "synthetic video source");
  const source = await store.prepare({ operationId: randomUUID(), resourceId: randomUUID(), sourcePath: video,
    mime: "video/mp4", source: "user", inspect: async () => ({ mime: "video/mp4",
      metadata: { type: "video", width: 2, height: 2, durationSec: 1, frameRate: 10, codec: "h264" } }) });
  const pixels = Buffer.from("synthetic decoded PNG");
  state.extract.mockImplementation(async (_input: unknown, context: { artifactRoot: string }) => {
    const frames = path.join(context.artifactRoot, "frame-tools", randomUUID(), "frames");
    await mkdir(frames, { recursive: true });
    const file = path.join(frames, "f000004.png");
    await writeFile(file, pixels);
    return { frames: [{ frame: 4, ptsTimeSec: 0.4, artifact: { path: file } }], facts: { frameTiming: { timing: "cfr" } } };
  });
  const candidates = await extractReviewFileFrames(store, source.id, [4], 1);
  registerReviewFilesIpc(() => []);
  const outputResourceId = randomUUID();
  const result = await state.handlers.get(CHANNELS.reviewFilesCaptureFrame)!({ resourceId: source.id, frameIndex: 4,
    nodeRevision: 1, operationId: randomUUID(), outputResourceId });
  const resolved = await store.resolve(outputResourceId, true);
  expect(result).toMatchObject({ ok: true, value: { path: resolved.path, resource: { id: outputResourceId }, frameIndex: 4 } });
  expect(await readFile(resolved.path)).toEqual(pixels);
  expect(await readdir(path.join(state.root, "jobs"))).toEqual([path.basename(candidates.jobDirectory)]);
  expect(await readFile(candidates.frames[0].artifact.path)).toEqual(pixels);
});
