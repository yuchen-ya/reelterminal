import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Live CLI install contract: reelctl is the default desktop-project entry;
 * the installed launcher invokes the same CLI.
 */
const desktopDir = path.resolve(__dirname, "..");
const pkg = JSON.parse(
  readFileSync(path.join(desktopDir, "package.json"), "utf8"),
) as { bin: Record<string, string> };

describe("live CLI bin naming", () => {
  it("exposes reelctl as the current-project command", () => {
    expect(pkg.bin).toEqual({ reelctl: "dist/reelctl/index.js" });
  });



  it("ships command launchers in the installed app for Windows", () => {
    const launcher = (name: string) => readFileSync(path.join(desktopDir, "resources", "bin", name), "utf8");
    expect(launcher("reelctl.cmd")).toContain("ReelTerminal.exe");
    const builder = readFileSync(path.join(desktopDir, "electron-builder.yml"), "utf8");
    expect(builder).toContain("to: reelctl.cmd");
  });
});
