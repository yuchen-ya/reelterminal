import { describe, expect, it } from "vitest";
import { agentStartupInfo } from "./agent-startup-info";

describe("Agent startup command", () => {
  it("uses the packaged Windows launcher with PowerShell-safe paths", () => {
    expect(agentStartupInfo({
      platform: "win32",
      packaged: true,
      appPath: "C:\\Editor\\resources\\app.asar",
      executablePath: "C:\\User's Editor\\ReelTerminal.exe",
      workspaceRoot: "E:\\Data\\agent-workspace",
    })).toEqual({
      cliCommand: "& 'C:\\User''s Editor\\reelctl.cmd'",
      workspaceRoot: "E:\\Data\\agent-workspace",
    });
  });

  it("uses an absolute source CLI entry in development", () => {
    const info = agentStartupInfo({
      platform: "linux",
      packaged: false,
      appPath: "/work/editor/apps/desktop",
      executablePath: "/work/electron",
      workspaceRoot: "/data/agent-workspace",
    });
    expect(info.cliCommand).toBe("node '/work/editor/apps/desktop/dist/reelctl/index.js'");
  });

  it("uses the installed Electron runtime on macOS", () => {
    const info = agentStartupInfo({
      platform: "darwin",
      packaged: true,
      appPath: "/Applications/ReelTerminal.app/Contents/Resources/app.asar",
      executablePath: "/Applications/ReelTerminal.app/Contents/MacOS/ReelTerminal",
      workspaceRoot: "/data/agent-workspace",
    });
    expect(info.cliCommand).toBe("ELECTRON_RUN_AS_NODE=1 '/Applications/ReelTerminal.app/Contents/MacOS/ReelTerminal' '/Applications/ReelTerminal.app/Contents/Resources/app.asar/dist/reelctl/index.js'");
  });
});
