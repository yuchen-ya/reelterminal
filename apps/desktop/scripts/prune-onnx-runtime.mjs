/**
 * electron-builder afterPack: keep only the target platform/arch ONNX runtime
 * binaries in the packaged app. The config-level `files` patterns already drop
 * other OS trees for each target; this hook additionally handles per-arch
 * pruning for targets that build multiple arches in one command (mac arm64+x64
 * otherwise ships both ~60 MB trees in every installer).
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const ARCH_NAMES = ["ia32", "x64", "armv7l", "arm64", "universal"];

/**
 * Pure directory operation so it can be unit-tested without electron-builder.
 * `archName === "universal"` (or an unknown arch) keeps every arch tree.
 */
export function pruneOnnxRuntime(root, platform, archName) {
  if (!existsSync(root)) return [];
  const removed = [];
  for (const platformEntry of readdirSync(root, { withFileTypes: true })) {
    if (!platformEntry.isDirectory()) continue;
    const platformDir = path.join(root, platformEntry.name);
    if (platformEntry.name !== platform) {
      rmSync(platformDir, { recursive: true, force: true });
      removed.push(platformEntry.name);
      continue;
    }
    if (!archName || archName === "universal") continue;
    for (const archEntry of readdirSync(platformDir, { withFileTypes: true })) {
      if (!archEntry.isDirectory() || archEntry.name === archName) continue;
      rmSync(path.join(platformDir, archEntry.name), { recursive: true, force: true });
      removed.push(`${platformEntry.name}/${archEntry.name}`);
    }
  }
  return removed;
}

export default async function afterPack(context) {
  const archName = ARCH_NAMES[context.arch] ?? null;
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  const root = path.join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "onnxruntime-node",
    "bin",
    "napi-v6",
  );
  const removed = pruneOnnxRuntime(root, context.electronPlatformName, archName);
  if (removed.length > 0) {
    process.stderr.write(`[prune-onnx-runtime] removed ${removed.join(", ")} for ${context.electronPlatformName}/${archName ?? "all"}\n`);
  }
}
