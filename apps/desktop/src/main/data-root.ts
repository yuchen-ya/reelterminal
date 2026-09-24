/**
 * Data-root session glue (docs/DATA-ROOT.md): resolves the root, migrates any
 * pre-data-root data into it BEFORE the Chromium profile is first touched,
 * then points Electron's userData at `<root>/app-data` so the IndexedDB
 * stores (projects, media bytes, material library) and settings live under
 * the one relocatable folder together with `projects/`, `agent-workspace/`
 * and `logs/`.
 *
 * Failure semantics: nothing is ever deleted; if a migration item fails and
 * nothing was moved yet, the session abstains from adopting the new root and
 * keeps running on the previous location (the next launch retries). If a
 * later item fails after earlier items already moved, the session adopts the
 * root anyway (the data is already there) and reports the leftovers loudly.
 */
import { app, dialog } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  type MigrationReport,
  type MigrationSource,
} from "./data-root-migration";

// Pre-data-root builds used Electron's default userData directory; the
// packaged app.json carries no productName, so that default was
// `<appData>/@reelterminal/desktop`. Always offered as a migration source.
const LEGACY_USER_DATA_SEGMENTS = ["@reelterminal", "desktop"] as const;
const LEGACY_WORKSPACE_NAME = "ReelTerminal Agent Workspace";

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
  // The previous root first: it is the freshest data when the user just
  // changed the location. The legacy flat locations follow so pre-data-root
  // installs are adopted unconditionally, with no extra bookkeeping.
  if (pointer?.previousRoot) {
    const previous = dataRootLayout(pointer.previousRoot);
    sources.push(
      { kind: "appData", from: previous.appData, to: target.appData },
      { kind: "workspace", from: previous.agentWorkspace, to: target.agentWorkspace },
    );
  }
  sources.push(
    { kind: "appData", from: legacyUserDataDir(), to: target.appData },
    { kind: "workspace", from: legacyWorkspaceRoot(), to: target.agentWorkspace },
  );
  return sources;
}

/**
 * Resolve → migrate → adopt. Call before anything opens the Chromium
 * profile; `app.setPath("userData", ...)` happens here and nowhere else.
 */
export async function prepareDataRootSession(): Promise<DataRootSession> {
  const pointer = readDataRootPointer();
  const defaultRoot = path.join(app.getPath("videos"), DATA_ROOT_DIR_NAME);
  const resolved = resolveDataRoot({
    envDataRoot: process.env.REELTERMINAL_DATA_ROOT,
    pointer,
    defaultRoot,
  });
  const targetLayout = dataRootLayout(resolved.root);
  const migration = await migrateIntoDataRoot(
    migrationSources(targetLayout, pointer),
  );

  const anythingMoved = migration.items.some(
    (item) => item.status === "moved" || item.status === "copied-backup-left",
  );
  const adopted = migration.ok || anythingMoved;

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
  return report.items
    .filter((item) => item.status === "failed")
    .map((item) => `• ${item.from}\n  ${item.error ?? "unknown error"}`)
    .join("\n");
}

export function reportMigrationProblem(sessionToReport: DataRootSession): void {
  if (sessionToReport.migration.ok) return;
  dialog.showErrorBox(
    "ReelTerminal data move incomplete",
    [
      "Some data could not be moved into the data folder:",
      "",
      summarizeMigrationFailures(sessionToReport.migration),
      "",
      sessionToReport.adopted
        ? "The app continues from the new data folder. Anything not moved is still at its previous location (see Settings → Storage)."
        : "Nothing was moved. The app keeps running from the previous location and will retry on the next start. Your data is untouched.",
    ].join("\n"),
  );
}
