/**
 * Data-root session glue (docs/DATA-ROOT.md): resolves the root, migrates any
 * pre-data-root data into it BEFORE the Chromium profile is first touched,
 * then points Electron's userData at `<root>/app-data` so the IndexedDB
 * stores (projects, media bytes, material library) and settings live under
 * the one relocatable folder together with `projects/`, `agent-workspace/`
 * and `logs/`.
 *
 * Failure semantics: the startup batch copies sources through staging and
 * leaves them in place. Any failed item stops the batch and keeps the app on
 * its previous root; the next launch retries. Only a batch with no failed
 * items adopts the selected root.
 */
import { app, dialog } from "electron";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  DATA_ROOT_DIR_NAME,
  dataRootLayout,
  dataRootPointerPath,
  dataRootUninstallInfoPath,
  machineConfigDir,
  parseDataRootPointer,
  resolveDataRoot,
  serializeDataRootPointer,
  serializeUninstallInfo,
  type DataRootLayout,
  type DataRootPointer,
  type DataRootSource,
} from "../shared/data-root";
import {
  migrateIntoDataRoot,
  type MigrationItemResult,
  type MigrationOptions,
  type MigrationReport,
  type MigrationSource,
} from "./data-root-migration";

// Pre-data-root builds used Electron's default userData directory; the
// packaged app.json carries no productName, so that default was
// `<appData>/@reelterminal/desktop`. Always offered as a migration source.
const LEGACY_USER_DATA_SEGMENTS = ["@reelterminal", "desktop"] as const;
const LEGACY_WORKSPACE_NAME = "ReelTerminal Agent Workspace";
const DATA_ROOT_MIGRATION_MARKER = "data-root-migration.json";

export interface DataRootSession {
  readonly resolvedRoot: string;
  readonly source: DataRootSource;
  readonly targetLayout: DataRootLayout;
  readonly migration: MigrationReport;
  /** False only when a failure left the session on the previous location. */
  readonly adopted: boolean;
  /** Where this session's data actually lives; null = legacy flat paths. */
  readonly activeLayout: DataRootLayout | null;
}

let session: DataRootSession | null = null;

function configDir(): string {
  return machineConfigDir(process.platform, process.env, app.getPath("home"));
}

export function readDataRootPointer(): DataRootPointer | null {
  try {
    return parseDataRootPointer(
      readFileSync(dataRootPointerPath(process.platform, process.env, app.getPath("home")), "utf8"),
    );
  } catch {
    return null;
  }
}

function writeDataRootPointer(pointer: DataRootPointer): void {
  const file = dataRootPointerPath(process.platform, process.env, app.getPath("home"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serializeDataRootPointer(pointer), "utf8");
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function dataRootMigrationMarkerPath(): string {
  return path.join(configDir(), DATA_ROOT_MIGRATION_MARKER);
}

function hasCompletedMigration(root: string): boolean {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(dataRootMigrationMarkerPath(), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return false;
    const completedRoot = (parsed as Record<string, unknown>).root;
    return typeof completedRoot === "string" &&
      normalizedPath(completedRoot) === normalizedPath(root);
  } catch {
    return false;
  }
}

function markMigrationComplete(root: string): void {
  const marker = dataRootMigrationMarkerPath();
  const staging = `${marker}.tmp`;
  mkdirSync(path.dirname(marker), { recursive: true });
  try {
    writeFileSync(staging, `${JSON.stringify({ root }, null, 2)}\n`, "utf8");
    renameSync(staging, marker);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
}

function isNonEmptyDirectory(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const stat = statSync(dir);
  return stat.isDirectory() && readdirSync(dir).length > 0;
}

/** Sidecar the NSIS uninstaller reads (ReadINIStr) to offer layered cleanup. */
function writeUninstallInfo(dataRoot: string): void {
  const file = dataRootUninstallInfoPath(process.platform, process.env, app.getPath("home"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    serializeUninstallInfo({ dataRoot, machineConfigDir: configDir() }),
    "utf8",
  );
}

function legacyUserDataDir(): string {
  return path.join(app.getPath("appData"), ...LEGACY_USER_DATA_SEGMENTS);
}

function legacyWorkspaceRoot(): string {
  return path.join(app.getPath("videos"), LEGACY_WORKSPACE_NAME);
}

function migrationSources(target: DataRootLayout, pointer: DataRootPointer | null): MigrationSource[] {
  const sources: MigrationSource[] = [];
  // Migrate every profile source before either workspace source. The profile
  // determines which root can safely be opened; workspace copies must not
  // move ahead while that decision is still pending.
  if (pointer?.previousRoot) {
    const previous = dataRootLayout(pointer.previousRoot);
    sources.push({ kind: "appData", from: previous.appData, to: target.appData });
  }
  sources.push(
    { kind: "appData", from: legacyUserDataDir(), to: target.appData },
  );
  if (pointer?.previousRoot) {
    const previous = dataRootLayout(pointer.previousRoot);
    sources.push({ kind: "workspace", from: previous.agentWorkspace, to: target.agentWorkspace });
  }
  sources.push({ kind: "workspace", from: legacyWorkspaceRoot(), to: target.agentWorkspace });
  return sources;
}

/**
 * Resolve → migrate → adopt. Call before anything opens the Chromium
 * profile; `app.setPath("userData", ...)` happens here and nowhere else.
 */
export async function prepareDataRootSession(
  migrationOptions: MigrationOptions = {},
): Promise<DataRootSession> {
  const pointer = readDataRootPointer();
  const defaultRoot = path.join(app.getPath("videos"), DATA_ROOT_DIR_NAME);
  const resolved = resolveDataRoot({
    envDataRoot: process.env.REELTERMINAL_DATA_ROOT,
    pointer,
    defaultRoot,
  });
  const targetLayout = dataRootLayout(resolved.root);
  const pointerAlreadySelectsRoot =
    pointer !== null &&
    pointer.previousRoot === undefined &&
    normalizedPath(pointer.dataRoot) === normalizedPath(resolved.root);
  const existingDefaultOrEnvRoot =
    pointer?.previousRoot === undefined &&
    isNonEmptyDirectory(targetLayout.appData);
  const migrationComplete =
    hasCompletedMigration(resolved.root) ||
    pointerAlreadySelectsRoot ||
    existingDefaultOrEnvRoot;
  const migration = migrationComplete
    ? { ok: true, items: [] }
    : await migrateIntoDataRoot(
        migrationSources(targetLayout, pointer),
        {
          ...migrationOptions,
          preserveSources: true,
          onBatchComplete: () => markMigrationComplete(resolved.root),
        },
      );

  // Batch migration preserves all sources, and any failed store keeps the
  // previous root active. This avoids mixed roots when a later store fails.
  const adopted = migration.ok;

  let activeLayout: DataRootLayout | null = targetLayout;
  if (!adopted) {
    // Abstain: keep running where the data still is and retry next launch.
    const previous = pointer?.previousRoot
      ? dataRootLayout(pointer.previousRoot)
      : null;
    activeLayout =
      previous && existsSync(previous.appData) ? previous : null;
  }

  if (activeLayout) {
    app.setPath("userData", activeLayout.appData);
    for (const dir of [
      activeLayout.root,
      activeLayout.appData,
      activeLayout.projects,
      activeLayout.agentWorkspace,
      activeLayout.logs,
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    writeUninstallInfo(activeLayout.root);
  }

  session = {
    resolvedRoot: resolved.root,
    source: resolved.source,
    targetLayout,
    migration,
    adopted,
    activeLayout,
  };
  return session;
}

/** The layout this session uses, or null when running on legacy flat paths. */
export function getDataRootLayout(): DataRootLayout | null {
  return session?.activeLayout ?? null;
}

/**
 * Default Agent workspace: the data root's `agent-workspace/` when active,
 * otherwise the pre-data-root folder under Videos (unchanged behavior).
 */
export function agentWorkspaceDefault(): string {
  const layout = getDataRootLayout();
  return layout ? layout.agentWorkspace : legacyWorkspaceRoot();
}

/** True when the data root is in effect (adopted, not legacy flat paths). */
export function dataRootActive(): boolean {
  return getDataRootLayout() !== null;
}

export interface DataRootInfo {
  active: boolean;
  root: string;
  source: DataRootSource;
  appData: string;
  projects: string;
  agentWorkspace: string;
  logs: string;
  machineConfigDir: string;
  migrationItems: readonly MigrationItemResult[];
}

export function getDataRootInfo(): DataRootInfo {
  const current = session;
  const layout = current?.activeLayout ?? null;
  return {
    active: layout !== null,
    root: layout?.root ?? "",
    source: current?.source ?? "default",
    appData: layout?.appData ?? legacyUserDataDir(),
    projects: layout?.projects ?? "",
    agentWorkspace: layout?.agentWorkspace ?? legacyWorkspaceRoot(),
    logs: layout?.logs ?? "",
    machineConfigDir: configDir(),
    migrationItems: current?.migration.items ?? [],
  };
}

/**
 * Point the data root at a new folder. Data moves on the NEXT launch (before
 * the profile opens), so this only records the pointer and asks for a
 * restart — never a live copy of in-use data.
 */
export function changeDataRoot(newRoot: string): {
  ok: boolean;
  requiresRestart: boolean;
  error?: string;
} {
  const trimmed = newRoot.trim();
  if (trimmed === "" || !path.isAbsolute(trimmed)) {
    return { ok: false, requiresRestart: false, error: "path must be absolute" };
  }
  const currentRoot = session?.activeLayout?.root ?? null;
  if (currentRoot && path.resolve(currentRoot) === path.resolve(trimmed)) {
    return { ok: true, requiresRestart: false };
  }
  try {
    mkdirSync(trimmed, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      requiresRestart: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  writeDataRootPointer({
    dataRoot: trimmed,
    changedAt: Date.now(),
    ...(currentRoot ? { previousRoot: currentRoot } : {}),
  });
  writeUninstallInfo(trimmed);
  return { ok: true, requiresRestart: true };
}

/** One-line, non-sensitive summary for the startup failure dialog. */
export function summarizeMigrationFailures(report: MigrationReport): string {
  const itemFailures = report.items
    .filter((item) => item.status === "failed")
    .map((item) => `• ${item.from}\n  ${item.error ?? "unknown error"}`);
  return [report.error ? `• ${report.error}` : "", ...itemFailures]
    .filter(Boolean)
    .join("\n");
}

/**
 * Skipped items keep `ok` true, but when the source is still on disk the data
 * was left behind; surface it alongside the failures instead of silently
 * adopting a target that never received it.
 */
function summarizeMigrationLeftovers(report: MigrationReport): string {
  return report.items
    .filter(
      (item) =>
        (item.status === "skipped-target-exists" &&
          normalizedPath(item.from) !== normalizedPath(item.to)) ||
        (item.status === "skipped-missing" && existsSync(item.from)),
    )
    .map((item) =>
      `• ${item.from} (destination already contains data; source was kept)`,
    )
    .join("\n");
}

export function reportMigrationProblem(sessionToReport: DataRootSession): void {
  const failures = summarizeMigrationFailures(sessionToReport.migration);
  const leftovers = summarizeMigrationLeftovers(sessionToReport.migration);
  if (!failures && !leftovers) return;
  dialog.showErrorBox(
    "ReelTerminal data move incomplete",
    [
      "Some data could not be moved into the data folder:",
      "",
      [failures, leftovers].filter(Boolean).join("\n"),
      "",
      sessionToReport.adopted
        ? "The app continues from the new data folder. Any source not copied remains at its previous location; existing destination data was kept without merging (see Settings → Storage)."
        : "The app keeps running from the previous location and will retry on the next start. Source data remains there; destination copies created by this failed batch were removed where possible, and pre-existing destination data was preserved.",
    ].join("\n"),
  );
}
