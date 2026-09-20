import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * N02 CLI naming contract for the desktop live connector:
 * `reelterminal-live-mcp` is the primary command, `openreel-live-mcp` stays as
 * a thin alias pointing at the SAME entry file (one implementation, no fork).
 */
const desktopDir = path.resolve(__dirname, "..");
const pkg = JSON.parse(
  readFileSync(path.join(desktopDir, "package.json"), "utf8"),
) as { bin: Record<string, string> };

describe("live-mcp bin naming (N02)", () => {
  it("exposes reelterminal-live-mcp as the primary command", () => {
    expect(pkg.bin["reelterminal-live-mcp"]).toBe("dist/live-mcp/index.js");
  });

  it("keeps openreel-live-mcp as a thin alias to the SAME entry file", () => {
    expect(pkg.bin["openreel-live-mcp"]).toBeDefined();
    expect(pkg.bin["openreel-live-mcp"]).toBe(pkg.bin["reelterminal-live-mcp"]);
  });
});
