import { app } from "electron";
import path from "node:path";
import { existsSync, statSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from "node:fs";

// Regenerable on-disk caches that Chromium/Electron rebuild on demand. A stale
// GPU/shader cache written by a previous Electron build crashes the new build's
// GPU process at startup (EXC_BREAKPOINT/SIGTRAP), so we drop them on upgrade.
// User data (IndexedDB, Local Storage, Cookies, projects) is never touched.
// Names cover the Metal (macOS) and Dawn (Windows/Linux) backends plus newer
// Chromium variants; absent dirs are skipped, so listing extras is harmless.
const REGENERABLE_CACHE_DIRS = [
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GraphiteDawnCache",
  "GPUPersistentCache",
  "ShaderCache",
  "GrShaderCache",
  "Code Cache",
];

const VERSION_MARKER_FILE = ".openreel-build";

type MarkerRead =
  | { state: "ok"; version: string }
  | { state: "absent" }
  | { state: "unreadable" };

function readMarker(markerPath: string): MarkerRead {
  try {
    if (statSync(markerPath).isFile()) {
      return { state: "ok", version: readFileSync(markerPath, "utf8").trim() };
    }
    // Corrupt marker (e.g. a directory) — remove it so a good one can be written.
    try {
      rmSync(markerPath, { recursive: true, force: true });
      return { state: "absent" };
    } catch {
      return { state: "unreadable" };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { state: "absent" };
    }
    // Present but unreadable (e.g. EACCES) — the caller must not advance.
    return { state: "unreadable" };
  }
}

function writeMarker(markerPath: string, version: string): void {
  try {
    const tmp = `${markerPath}.tmp`;
    writeFileSync(tmp, version, "utf8");
    renameSync(tmp, markerPath);
  } catch (error) {
    console.error("[gpu-cache] failed to write version marker:", error);
  }
}

export function migrateGpuCacheOnUpgrade(): void {
  try {
    const userData = app.getPath("userData");
    const currentVersion = app.getVersion();
    try {
      mkdirSync(userData, { recursive: true });
    } catch {
      // userData should be creatable; if not, the writes below will no-op safely.
    }
    const markerPath = path.join(userData, VERSION_MARKER_FILE);

    const marker = readMarker(markerPath);
    if (marker.state === "unreadable") {
      // We cannot tell whether this marker already records the current version.
      // Clearing now could drop a good cache, and advancing now could skip a
      // needed clear — leave everything as-is so a later launch can retry.
      console.warn("[gpu-cache] version marker unreadable; leaving caches and marker untouched");
      return;
    }
    const previousVersion = marker.state === "ok" ? marker.version : "";
    if (previousVersion === currentVersion) return;

    let allCleared = true;
    if (previousVersion) {
      for (const dir of REGENERABLE_CACHE_DIRS) {
        const target = path.join(userData, dir);
        if (!existsSync(target)) continue;
        try {
          rmSync(target, { recursive: true, force: true });
        } catch (error) {
          allCleared = false;
          console.error(`[gpu-cache] failed to clear ${dir}:`, error);
        }
      }
      console.warn(
        `[gpu-cache] cleared regenerable caches on version change ${previousVersion} -> ${currentVersion}`,
      );
    }

    // Only advance the marker when the clear fully succeeded (or there was
    // nothing to clear). If a clear failed, leave the old marker so the next
    // launch retries — otherwise a stale cache that crashes the GPU process
    // would never be recovered.
    if (allCleared) writeMarker(markerPath, currentVersion);
  } catch (error) {
    // Never block startup on cache migration.
    console.error("[gpu-cache] migration skipped:", error);
  }
}
