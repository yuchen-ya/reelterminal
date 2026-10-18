import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCli } from "./helpers";

/** The installed CLI dispatches on the subcommand. */
const pkgDir = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
  bin: Record<string, string>;
};

describe("CLI bin naming", () => {
  it("only advertises run and doctor and rejects the removed server command", async () => {
    const help = spawnCli(["--help"]);
    expect(await help.exitCode).toBe(0);
    expect(help.stdout).toContain("run --workflow");
    expect(help.stdout).toContain("doctor");
    expect(help.stdout).not.toContain("serve");
    const removed = spawnCli(["serve"]);
    expect(await removed.exitCode).toBe(2);
    expect(removed.stdout).toBe("");
    expect(JSON.parse(removed.stderr.split("\n")[0]!).msg).toContain('unknown subcommand "serve"');
  });

  it("exposes reelterminal-agent as the primary command", () => {
    expect(pkg.bin["reelterminal-agent"]).toBe("dist/cli.js");
  });


  it("dispatches on the subcommand (argv[2])", () => {
    const src = readFileSync(path.join(pkgDir, "src", "cli.ts"), "utf8");
    // No argv[1]/basename self-identification anywhere in the entry.
    expect(src).not.toMatch(/argv\[1\]|argv\[0\]|basename|process\.argv\[1\]/);
    // Subcommand dispatch reads position 2 (destructured as `cmd`).
    expect(src).toMatch(/const \[, , cmd, \.\.\.rest\] = process\.argv;/);
  });
});
