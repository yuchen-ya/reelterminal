/**
 * Data-root layout and resolution (pure: no fs, no Electron).
 *
 * ReelTerminal keeps everything user-scoped under ONE relocatable data root
 * (docs/DATA-ROOT.md): `app-data` (the Electron userData profile — the
 * IndexedDB project/media/material-library stores and settings), `projects`
 * (the default .oreel save folder), `agent-workspace` (`jobs/` + `shared/`),
 * and `logs`. The chosen root is remembered in a tiny machine-local pointer
 * file so the root may live on any drive and survive uninstall; the NSIS
 * uninstaller reads a sidecar INI next to the pointer to offer layered data
 * cleanup (see apps/desktop/build/installer.nsh).
 */
import { isAbsolute, join } from "node:path";

export const DATA_ROOT_DIR_NAME = "ReelTerminal";
export const DATA_ROOT_POINTER_FILE = "data-root.json";
/** Plain-text sidecar the NSIS uninstaller reads (ReadINIStr) for its prompts. */
export const DATA_ROOT_UNINSTALL_INFO_FILE = "uninstall-info.ini";

export interface DataRootLayout {
  readonly root: string;
  /** Electron userData: IndexedDB stores (projects, media bytes, material library) + settings. */
  readonly appData: string;
  /** Default save folder for `.oreel` project files. */
  readonly projects: string;
  /** The Agent workspace root (`jobs/` + `shared/`). */
  readonly agentWorkspace: string;
  readonly logs: string;
}

export type DataRootSource = "env" | "pointer" | "default";

export interface DataRootPointer {
  readonly dataRoot: string;
  readonly changedAt: number;
  /** Root in use before the last change — startup migrates data out of it. */
  readonly previousRoot?: string;
}

export function dataRootLayout(root: string): DataRootLayout {
  return {
    root,
    appData: join(root, "app-data"),
    projects: join(root, "projects"),
    agentWorkspace: join(root, "agent-workspace"),
    logs: join(root, "logs"),
  };
}

/**
 * Machine-local config directory holding the data-root pointer. Deliberately
 * OUTSIDE the data root (the pointer must be findable before the root is
 * known) and OUTSIDE the uninstall-surviving root tree on purpose: the
 * uninstaller removes it only together with the rest of the app's footprint.
 */
export function machineConfigDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: string,
): string {
  if (platform === "win32") {
    const localAppData =
      env.LOCALAPPDATA && env.LOCALAPPDATA.trim() !== ""
        ? env.LOCALAPPDATA
        : join(homedir, "AppData", "Local");
    return join(localAppData, DATA_ROOT_DIR_NAME);
  }
  if (platform === "darwin") {
    return join(homedir, "Library", "Application Support", DATA_ROOT_DIR_NAME);
  }
  const xdg =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ""
      ? env.XDG_CONFIG_HOME
      : join(homedir, ".config");
  return join(xdg, DATA_ROOT_DIR_NAME);
}

export function dataRootPointerPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: string,
): string {
  return join(machineConfigDir(platform, env, homedir), DATA_ROOT_POINTER_FILE);
}

export function dataRootUninstallInfoPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: string,
): string {
  return join(
    machineConfigDir(platform, env, homedir),
    DATA_ROOT_UNINSTALL_INFO_FILE,
  );
}

export function parseDataRootPointer(text: string): DataRootPointer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.dataRoot !== "string" || record.dataRoot.trim() === "") {
    return null;
  }
  const previousRoot =
    typeof record.previousRoot === "string" && record.previousRoot.trim() !== ""
      ? record.previousRoot
      : undefined;
  return {
    dataRoot: record.dataRoot,
    changedAt: typeof record.changedAt === "number" ? record.changedAt : 0,
    ...(previousRoot !== undefined ? { previousRoot } : {}),
  };
}

export function serializeDataRootPointer(pointer: DataRootPointer): string {
  return `${JSON.stringify(pointer, null, 2)}\n`;
}

/**
 * INI body for the NSIS uninstaller (`ReadINIStr`). One section, plain
 * values — NSIS cannot parse the JSON pointer reliably.
 */
export function serializeUninstallInfo(info: {
  dataRoot: string;
  machineConfigDir: string;
}): string {
  return [
    "[DataRoot]",
    `path=${info.dataRoot}`,
    `configDir=${info.machineConfigDir}`,
    "",
  ].join("\r\n");
}

export interface ResolveDataRootInput {
  /** Raw `REELTERMINAL_DATA_ROOT` value (new capability: no legacy alias). */
  readonly envDataRoot: string | undefined;
  readonly pointer: DataRootPointer | null;
  /** Platform default, computed by the caller (Electron: `<videos>/ReelTerminal`). */
  readonly defaultRoot: string;
}

/**
 * Root precedence: `REELTERMINAL_DATA_ROOT` (must be an absolute path; an
 * empty or relative value is ignored and resolution falls through, same
 * convention as `REELTERMINAL_AGENT_WORKSPACE_ROOT`) → the pointer file →
 * the platform default.
 */
export function resolveDataRoot(
  input: ResolveDataRootInput,
): { root: string; source: DataRootSource } {
  const envRoot = input.envDataRoot?.trim() ?? "";
  if (envRoot !== "" && isAbsolute(envRoot)) {
    return { root: envRoot, source: "env" };
  }
  if (input.pointer && isAbsolute(input.pointer.dataRoot.trim())) {
    return { root: input.pointer.dataRoot.trim(), source: "pointer" };
  }
  return { root: input.defaultRoot, source: "default" };
}
