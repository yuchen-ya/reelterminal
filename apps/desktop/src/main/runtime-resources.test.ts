import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runtimeIconPath } from "./runtime-resources";

describe("runtime icon", () => {
  it("finds the development asset beside the desktop build directory", () => {
    const desktop = fileURLToPath(new URL("../../", import.meta.url));
    const icon = runtimeIconPath(false, "unused", path.join(desktop, "dist/main"));
    expect(existsSync(icon)).toBe(true);
    expect(readFileSync(icon).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it.each(["win-unpacked/resources", "ReelTerminal.app/Contents/Resources"])("uses physical resources for %s", (resources) => {
    expect(runtimeIconPath(true, resources, "app.asar/dist/main")).toBe(path.join(resources, "icon.png"));
  });
});
