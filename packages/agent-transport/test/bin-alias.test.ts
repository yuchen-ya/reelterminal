import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `reelterminal-agent` is the primary command and
 * `agent-video` a thin alias. Both package.json bin entries MUST point at the
 * same entry file, and the entry must dispatch on argv[2] only (no argv[1] /
 * basename branching), which is what makes the alias share one implementation
 * instead of forking behavior.
 */
const pkgDir = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
  bin: Record<string, string>;
};

describe("CLI bin naming", () => {
  it("exposes reelterminal-agent as the primary command", () => {
    expect(pkg.bin["reelterminal-agent"]).toBe("dist/cli.js");
  });

  it("keeps agent-video as a thin alias to the SAME entry file", () => {
    expect(pkg.bin["agent-video"]).toBeDefined();
    expect(pkg.bin["agent-video"]).toBe(pkg.bin["reelterminal-agent"]);
  });

  it("dispatches on the subcommand (argv[2]) only, so both names behave identically", () => {
    const src = readFileSync(path.join(pkgDir, "src", "cli.ts"), "utf8");
    // No argv[1]/basename self-identification anywhere in the entry.
    expect(src).not.toMatch(/argv\[1\]|argv\[0\]|basename|process\.argv\[1\]/);
    // Subcommand dispatch reads position 2 (destructured as `cmd`).
    expect(src).toMatch(/const \[, , cmd, \.\.\.rest\] = process\.argv;/);
  });
});
