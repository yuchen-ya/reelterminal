import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import manifest from "../../resources/segmentation/mobilesam-manifest.json";
import { PromptableSegmentationBackend } from "./segmentation/backend";
import { MAX_PROMPT_TOKENS } from "./segmentation/geometry";
import type { SegmentationBackendOptions } from "./segmentation/types";
import type { TaskSegmentationBackend } from "./task-review-media";

export const SEGMENTATION_MODEL_VERSION = manifest.modelVersion;
export const SEGMENTATION_PROMPT_TOKEN_LIMIT = MAX_PROMPT_TOKENS;

export interface SegmentationResourceContext {
  isPackaged: boolean;
  /** Electron app.getAppPath(); desktop package root in development. */
  appPath: string;
  /** Electron process.resourcesPath. */
  resourcesPath: string;
}

/** Resolve one deliberate resource location; no cache/environment model fallback. */
export function segmentationResourcePaths(context: SegmentationResourceContext): SegmentationBackendOptions {
  const modelRoot = context.isPackaged
    ? path.join(context.resourcesPath, "segmentation", "mobilesam")
    : path.join(context.appPath, "resources", "segmentation", "mobilesam");
  const workerRoot = context.isPackaged
    ? path.join(context.resourcesPath, "app.asar.unpacked")
    : context.appPath;
  return {
    workerPath: path.join(workerRoot, "dist", "main", "segmentation", "worker.js"),
    encoderPath: path.join(modelRoot, manifest.files.encoder.name),
    decoderPath: path.join(modelRoot, manifest.files.decoder.name),
  };
}

function verifyResources(resources: SegmentationBackendOptions, context: SegmentationResourceContext): void {
  const modelRoot = path.dirname(resources.encoderPath);
  const installed = JSON.parse(readFileSync(path.join(modelRoot, "manifest.json"), "utf8"));
  if (installed.modelVersion !== manifest.modelVersion || installed.sourceRevision !== manifest.sourceRevision) {
    throw new Error("Installed MobileSAM manifest does not match the application model version");
  }
  for (const file of Object.values(manifest.files)) {
    const absolute = path.join(modelRoot, file.name);
    const info = statSync(absolute);
    if (!info.isFile() || info.size !== file.bytes) throw new Error(`Installed MobileSAM model is incomplete: ${absolute}`);
  }
  for (const absolute of [resources.workerPath, path.join(modelRoot, "LICENSE-MobileSAM.txt"), path.join(modelRoot, "NOTICE-MobileSAM.txt")]) {
    const info = statSync(absolute);
    if (!info.isFile() || info.size === 0) throw new Error(`Segmentation resource is missing or empty: ${absolute}`);
  }
  // Resolve only: do not load native modules or allocate inference sessions in
  // the main process. A real unpacked worker needs both packages on its path.
  const runtimeEntry = createRequire(resources.workerPath).resolve("onnxruntime-node");
  const commonEntry = createRequire(runtimeEntry).resolve("onnxruntime-common");
  for (const entry of [runtimeEntry, commonEntry]) {
    if (context.isPackaged) {
      const modulesRoot = path.join(context.resourcesPath, "app.asar.unpacked", "node_modules");
      const relative = path.relative(modulesRoot, entry);
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
        throw new Error(`Packaged ONNX dependency must resolve inside app.asar.unpacked/node_modules: ${entry}`);
      }
    }
    if (!statSync(entry).isFile()) throw new Error(`ONNX dependency is unavailable: ${entry}`);
  }
  const binding = path.resolve(path.dirname(runtimeEntry), "..", "bin", "napi-v6", process.platform, process.arch, "onnxruntime_binding.node");
  if (!statSync(binding).isFile()) throw new Error(`ONNX native binding is unavailable: ${binding}`);
}

/** Creating the factory is inert; resource checks and workers start on execution. */
export function createTaskReviewSegmentationBackendFactory(context: SegmentationResourceContext): (taskId: string) => TaskSegmentationBackend {
  return (_taskId: string) => {
    const resources = segmentationResourcePaths(context);
    try {
      verifyResources(resources, context);
    } catch (cause) {
      // This is the availability boundary exposed by the task media service.
      throw Object.assign(new Error(`MobileSAM segmentation resources are unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }), { code: "SEGMENTATION_UNAVAILABLE" });
    }
    const backend = new PromptableSegmentationBackend(resources);
    return {
      modelVersion: SEGMENTATION_MODEL_VERSION,
      promptTokenLimit: backend.promptTokenLimit,
      get isDisposed() { return backend.isDisposed; },
      segment: (request, signal) => backend.segment(request, signal),
      resetRefinement: () => backend.resetRefinement(),
      dispose: () => backend.dispose(),
    };
  };
}
