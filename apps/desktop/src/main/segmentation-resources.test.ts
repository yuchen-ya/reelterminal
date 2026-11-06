import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import manifest from "../../resources/segmentation/mobilesam-manifest.json";
import { createTaskReviewSegmentationBackendFactory, segmentationResourcePaths, SEGMENTATION_MODEL_VERSION, SEGMENTATION_PROMPT_TOKEN_LIMIT, type SegmentationResourceContext } from "./segmentation-resources";

const backend = vi.hoisted(() => ({
  segment: vi.fn(), resetRefinement: vi.fn(), dispose: vi.fn(), construct: vi.fn(),
  isDisposed: false,
}));
vi.mock("./segmentation/backend", () => ({
  PromptableSegmentationBackend: class {
    promptTokenLimit = 32;
    get isDisposed() { return backend.isDisposed; }
    segment = backend.segment;
    resetRefinement = backend.resetRefinement;
    dispose = backend.dispose;
    constructor(options: unknown) { backend.construct(options); }
  },
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
  backend.isDisposed = false;
});
function context(isPackaged: boolean): SegmentationResourceContext {
  const root = mkdtempSync(path.join(os.tmpdir(), "reel-segmentation-resources-"));
  roots.push(root);
  return { isPackaged, appPath: isPackaged ? path.join(root, "resources", "app.asar") : root, resourcesPath: path.join(root, "resources") };
}
function write(file: string, contents: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}
function install(ctx: SegmentationResourceContext) {
  const resources = segmentationResourcePaths(ctx);
  const modelRoot = path.dirname(resources.encoderPath);
  write(path.join(modelRoot, "manifest.json"), JSON.stringify(manifest));
  for (const model of Object.values(manifest.files)) {
    const file = path.join(modelRoot, model.name);
    write(file, ""); truncateSync(file, model.bytes);
  }
  for (const name of ["LICENSE-MobileSAM.txt", "NOTICE-MobileSAM.txt"]) write(path.join(modelRoot, name), "notice fixture");
  write(resources.workerPath, "throw new Error('worker must remain lazy')");
  const appRoot = ctx.isPackaged ? path.join(ctx.resourcesPath, "app.asar.unpacked") : ctx.appPath;
  const runtimeRoot = path.join(appRoot, "node_modules", "onnxruntime-node");
  write(path.join(runtimeRoot, "package.json"), JSON.stringify({ name: "onnxruntime-node", main: "dist/index.js" }));
  write(path.join(runtimeRoot, "dist", "index.js"), "throw new Error('native runtime must not load in main')");
  const commonRoot = path.join(appRoot, "node_modules", "onnxruntime-common");
  write(path.join(commonRoot, "package.json"), JSON.stringify({ name: "onnxruntime-common", main: "index.js" }));
  write(path.join(commonRoot, "index.js"), "throw new Error('runtime common must not load in main')");
  const binding = path.join(runtimeRoot, "bin", "napi-v6", process.platform, process.arch, "onnxruntime_binding.node");
  write(binding, "binding fixture");
  return { resources, binding, commonRoot };
}

describe("MobileSAM resource factory", () => {
  it("allows application startup/catalog use without installed models or workers", () => {
    const factory = createTaskReviewSegmentationBackendFactory(context(false));
    expect(factory).toBeTypeOf("function");
    expect(backend.construct).not.toHaveBeenCalled();
    expect(SEGMENTATION_PROMPT_TOKEN_LIMIT).toBe(32);
    expect(() => factory("task")).toThrow(expect.objectContaining({ code: "SEGMENTATION_UNAVAILABLE" }));
  });

  for (const packaged of [false, true]) {
    it(`uses ${packaged ? "packaged physical" : "development staged"} resources and delegates task lifecycle`, async () => {
      const ctx = context(packaged);
      const { resources } = install(ctx);
      const factory = createTaskReviewSegmentationBackendFactory(ctx);
      const first = factory("task-1");
      factory("task-2");
      expect(backend.construct).toHaveBeenCalledTimes(2);
      expect(backend.construct).toHaveBeenCalledWith(resources);
      expect(resources.workerPath).toBe(path.join(packaged ? path.join(ctx.resourcesPath, "app.asar.unpacked") : ctx.appPath, "dist/main/segmentation/worker.js"));
      expect(resources.encoderPath).toBe(path.join(packaged ? ctx.resourcesPath : path.join(ctx.appPath, "resources"), "segmentation/mobilesam", manifest.files.encoder.name));
      expect(first.modelVersion).toBe(SEGMENTATION_MODEL_VERSION);
      expect(first.isDisposed).toBe(false);
      backend.isDisposed = true;
      expect(first.isDisposed).toBe(true);
      backend.isDisposed = false;
      const request = { frame: { id: "frame", revision: "v1", width: 1, height: 1, rgba: new Uint8Array(4), rotation: 0 as const }, refinementId: "session", prompts: { points: [{ x: 0.5, y: 0.5, foreground: true }] } };
      const signal = new AbortController().signal;
      await first.segment(request, signal);
      first.resetRefinement!(); await first.dispose!();
      expect(backend.segment).toHaveBeenCalledWith(request, signal);
      expect(backend.resetRefinement).toHaveBeenCalledOnce();
      expect(backend.dispose).toHaveBeenCalledOnce();
    });
  }

  it("rejects an incomplete model or a manifest from another conversion", () => {
    const ctx = context(false);
    const { resources } = install(ctx);
    truncateSync(resources.decoderPath, 1);
    const factory = createTaskReviewSegmentationBackendFactory(ctx);
    expect(() => factory("task")).toThrow(/model is incomplete/);
    write(path.join(path.dirname(resources.encoderPath), "manifest.json"), JSON.stringify({ ...manifest, modelVersion: "different-model" }));
    expect(() => factory("task")).toThrow(/manifest does not match/);
    expect(backend.construct).not.toHaveBeenCalled();
  });

  it("rejects a packaged native runtime without the target binding", () => {
    const ctx = context(true);
    const { binding } = install(ctx);
    rmSync(binding);
    expect(() => createTaskReviewSegmentationBackendFactory(ctx)("task")).toThrow(expect.objectContaining({ code: "SEGMENTATION_UNAVAILABLE" }));
    expect(backend.construct).not.toHaveBeenCalled();
  });

  it("requires onnxruntime-common alongside the physical worker runtime", () => {
    const ctx = context(true);
    const { commonRoot } = install(ctx);
    rmSync(commonRoot, { recursive: true });
    expect(() => createTaskReviewSegmentationBackendFactory(ctx)("task")).toThrow(/onnxruntime-common/);
    expect(backend.construct).not.toHaveBeenCalled();
  });
});
