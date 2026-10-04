import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Live CLI install contract: reelctl is the default desktop-project entry;
 * the MCP launcher invokes the current adapter.
 */
const desktopDir = path.resolve(__dirname, "..");
const pkg = JSON.parse(
  readFileSync(path.join(desktopDir, "package.json"), "utf8"),
) as { bin: Record<string, string> };

describe("live CLI bin naming", () => {
  it("exposes reelctl as the current-project command", () => {
    expect(pkg.bin.reelctl).toBe("dist/reelctl/index.js");
  });

  it("keeps reelterminal-live-mcp as an explicit compatibility command", () => {
    expect(pkg.bin["reelterminal-live-mcp"]).toBe("dist/live-mcp/legacy.js");
  });


  it("ships command launchers in the installed app for Windows", () => {
    const launcher = (name: string) => readFileSync(path.join(desktopDir, "resources", "bin", name), "utf8");
    expect(launcher("reelctl.cmd")).toContain("ReelTerminal.exe");
    expect(launcher("reelterminal-live-mcp.cmd")).toContain("reelctl.cmd");
    const builder = readFileSync(path.join(desktopDir, "electron-builder.yml"), "utf8");
    expect(builder).toContain("to: reelctl.cmd");
    expect(builder).toContain("to: reelterminal-live-mcp.cmd");
  });
});
