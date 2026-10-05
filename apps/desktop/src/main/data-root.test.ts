import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const electron = vi.hoisted(() => ({
  paths: {} as Record<string, string>,
  showErrorBox: vi.fn(),
}));
vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => electron.paths[name],
    setPath: (name: string, value: string) => { electron.paths[name] = value; },
  },
  dialog: { showErrorBox: electron.showErrorBox },
}));

import { agentWorkspaceDefault, changeDataRoot, getDataRootInfo, prepareDataRootSession } from "./data-root";
import { agentStartupInfo } from "./live/agent-startup-info";

let sandbox: string;
beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "rt-storage-location-"));
  electron.paths = {
    home: path.join(sandbox, "home"),
    videos: path.join(sandbox, "videos"),
    appData: path.join(sandbox, "roaming"),
    userData: path.join(sandbox, "legacy-profile"),
  };
  vi.stubEnv("LOCALAPPDATA", path.join(sandbox, "local"));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(sandbox, "config"));
  vi.stubEnv("REELTERMINAL_DATA_ROOT", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(sandbox, { recursive: true, force: true });
});

describe("storage location and Agent startup paths", () => {
  it("keeps the active workspace until restart, then reports the relocated workspace", async () => {
    await prepareDataRootSession();
    const original = getDataRootInfo();
    const task = path.join(original.agentWorkspace, "jobs", "existing-task");
    await mkdir(task, { recursive: true });
    await writeFile(path.join(task, "brief.md"), "Existing task");
    const installation = {
      platform: process.platform,
      packaged: true,
      appPath: path.join(sandbox, "installed", "resources", "app.asar"),
      executablePath: path.join(sandbox, "installed", "ReelTerminal.exe"),
    };
    const before = agentStartupInfo({ ...installation, workspaceRoot: agentWorkspaceDefault() });
    const newRoot = path.join(sandbox, "Moved data 中文");

    expect(changeDataRoot(newRoot)).toEqual({ ok: true, requiresRestart: true });
    expect(agentWorkspaceDefault()).toBe(original.agentWorkspace);

    // The same startup preparation runs in the next desktop process.
    await prepareDataRootSession();
    const after = agentStartupInfo({ ...installation, workspaceRoot: agentWorkspaceDefault() });
    expect(after.cliCommand).toBe(before.cliCommand);
    expect(after.workspaceRoot).toBe(path.join(newRoot, "agent-workspace"));
    expect(electron.paths.userData).toBe(path.join(newRoot, "app-data"));
    expect(await readFile(path.join(after.workspaceRoot, "jobs", "existing-task", "brief.md"), "utf8")).toBe("Existing task");
  });

  it("honors a configured data root over a settings pointer", async () => {
    const configured = path.join(sandbox, "configured-data");
    vi.stubEnv("REELTERMINAL_DATA_ROOT", configured);
    await prepareDataRootSession();
    changeDataRoot(path.join(sandbox, "settings-data"));
    await prepareDataRootSession();
    expect(getDataRootInfo().root).toBe(configured);
    expect(agentWorkspaceDefault()).toBe(path.join(configured, "agent-workspace"));
  });
});
