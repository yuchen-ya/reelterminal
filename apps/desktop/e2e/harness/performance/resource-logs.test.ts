import { test, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeResourceLogs } from "./resource-logs";

test("soak logs survive profile removal and redact credentials split across stdout chunks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reelterminal-resource-evidence-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "reelterminal-resource-profile-"));
  const prefix = path.join(root, "run");
  const token = "a".repeat(64);
  try {
    await writeResourceLogs(prefix, {
      mainStdout: ["ready\nBearer " + token.slice(0, 20), token.slice(20) + "\nclosed\n"],
      mainStderr: ["original failure\n"],
      rendererConsole: ["[warning] retained", "[pageerror] original"],
    });
    await rm(profile, { recursive: true, force: true });
    expect(await readFile(`${prefix}.mainStdout.redacted.log`, "utf8")).toBe("ready\nBearer [redacted]\nclosed\n");
    expect(await readFile(`${prefix}.mainStderr.redacted.log`, "utf8")).toBe("original failure\n");
    expect(await readFile(`${prefix}.rendererConsole.redacted.log`, "utf8")).toBe("[warning] retained\n[pageerror] original");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
});
