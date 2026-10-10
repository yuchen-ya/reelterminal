import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

import {
  agentWorkspaceDefault,
  changeDataRoot,
  getDataRootInfo,
  prepareDataRootSession,
  reportMigrationProblem,
} from "./data-root";
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

  it("keeps the previous root active after a workspace copy fails and retries without moving sources", async () => {
    await prepareDataRootSession();
    const previous = getDataRootInfo();
    await writeFile(path.join(previous.appData, "profile.db"), "profile");
    const taskBrief = path.join(
      previous.agentWorkspace,
      "jobs",
      "existing-task",
      "brief.md",
    );
    await mkdir(path.dirname(taskBrief), { recursive: true });
    await writeFile(
      taskBrief,
      "Existing task",
    );
    const selectedRoot = path.join(sandbox, "selected-data");

    expect(changeDataRoot(selectedRoot)).toEqual({ ok: true, requiresRestart: true });

    const failed = await prepareDataRootSession({
      copy: async (from, to, options) => {
        if (from === previous.agentWorkspace) {
          throw Object.assign(new Error("workspace is locked"), { code: "EIO" });
        }
        await cp(from, to, options);
      },
    });

    expect(failed.migration.ok).toBe(false);
    expect(failed.adopted).toBe(false);
    expect(failed.activeLayout?.root).toBe(previous.root);
    expect(electron.paths.userData).toBe(previous.appData);
    expect(agentWorkspaceDefault()).toBe(previous.agentWorkspace);
    expect(await readFile(path.join(previous.appData, "profile.db"), "utf8")).toBe("profile");
    expect(await readFile(taskBrief, "utf8")).toBe("Existing task");
    expect(existsSync(path.join(selectedRoot, "app-data"))).toBe(false);
    expect(existsSync(path.join(selectedRoot, "agent-workspace"))).toBe(false);

    reportMigrationProblem(failed);
    expect(electron.showErrorBox.mock.calls.at(-1)?.[1]).toContain(
      "destination copies created by this failed batch were removed",
    );

    // The old root remains active between attempts and may change. Equal-sized
    // edits must be copied fresh rather than reusing an earlier target copy.
    await writeFile(path.join(previous.appData, "profile.db"), "updated");

    const retried = await prepareDataRootSession({
      copy: (from, to, options) => cp(from, to, options),
    });

    expect(retried.migration.ok).toBe(true);
    expect(retried.adopted).toBe(true);
    expect(retried.activeLayout?.root).toBe(selectedRoot);
    expect(electron.paths.userData).toBe(path.join(selectedRoot, "app-data"));
    expect(await readFile(path.join(selectedRoot, "app-data", "profile.db"), "utf8")).toBe("updated");
    expect(await readFile(path.join(selectedRoot, "agent-workspace", "jobs", "existing-task", "brief.md"), "utf8")).toBe("Existing task");
    expect(await readFile(path.join(previous.appData, "profile.db"), "utf8")).toBe("updated");
    expect(await readFile(taskBrief, "utf8")).toBe("Existing task");
  });
});
