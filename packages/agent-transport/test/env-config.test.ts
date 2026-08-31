/**
 * B.5 env-config regression tests. The creative acceptance agent found
 * that `serve`/`run` silently ignored every `OPENREEL_AVE_*` env var the
 * SKILL and doctor document (only flags worked): `mergeEnvRoots` existed
 * but no command called it, and `OPENREEL_TRANSPORT_LOG` was read
 * nowhere. Every real MCP client following SKILL.md's env-based
 * per-client snippets would have hit this. These tests pin the merge
 * functions AND the command-level wiring end to end.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigRefusal, mergeEnvLogLevel, mergeEnvRoots } from "../src/config";
import { initialize, makeRoots, spawnCli, startServe, type Roots } from "./helpers";

let roots: Roots;

beforeAll(async () => {
  roots = await makeRoots();
});

afterAll(async () => {
  await roots.cleanup();
});

function envRoots(): Record<string, string> {
  return {
    OPENREEL_AVE_MEDIA_ROOTS: roots.mediaRoot,
    OPENREEL_AVE_ARTIFACT_ROOT: roots.artifactRoot,
    OPENREEL_AVE_PROJECT_ROOTS: roots.projectRoot,
  };
}

describe("B.5 env merge functions (unit)", () => {
  it("mergeEnvRoots fills only the classes flags left empty", () => {
    const merged = mergeEnvRoots(
      { mediaRoots: ["/flag/m"], projectRoots: [] },
      {
        OPENREEL_AVE_MEDIA_ROOTS: `/env/m1${path.delimiter}/env/m2`,
        OPENREEL_AVE_ARTIFACT_ROOT: "/env/a",
        OPENREEL_AVE_PROJECT_ROOTS: "/env/p",
      },
    );
    expect(merged.mediaRoots).toEqual(["/flag/m"]); // flag wins
    expect(merged.artifactRoot).toBe("/env/a"); // env fills
    expect(merged.projectRoots).toEqual(["/env/p"]); // env fills
  });

  it("mergeEnvRoots without env leaves every class empty", () => {
    const merged = mergeEnvRoots({ mediaRoots: [], projectRoots: [] }, {});
    expect(merged.mediaRoots).toEqual([]);
    expect(merged.artifactRoot).toBeUndefined();
    expect(merged.projectRoots).toEqual([]);
  });

  it("mergeEnvLogLevel: flag wins, env fills, default info, invalid env refuses startup", () => {
    expect(mergeEnvLogLevel("debug", { OPENREEL_TRANSPORT_LOG: "error" })).toBe("debug");
    expect(mergeEnvLogLevel(undefined, { OPENREEL_TRANSPORT_LOG: "error" })).toBe("error");
    expect(mergeEnvLogLevel(undefined, {})).toBe("info");
    expect(() => mergeEnvLogLevel(undefined, { OPENREEL_TRANSPORT_LOG: "loud" })).toThrow(ConfigRefusal);
  });
});

describe("B.5 env config honored by the commands (integration)", () => {
  it("serve with env-only roots: capabilities_get reports mediaImport available", async () => {
    const client = startServe([], envRoots());
    await initialize(client);
    client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "capabilities_get", arguments: {} } });
    const response = await client.read();
    const result = JSON.parse((response.result as any).content[0].text);
    expect(result.ok).toBe(true);
    expect(result.value.mediaImport.available).toBe(true);
    client.handle.child.kill("SIGTERM");
    await client.handle.exitCode;
  }, 120_000);

  it("run with an env-only project root: project.save lands the checkpoint", async () => {
    const checkpoint = path.join(roots.projectRoot, "env-run.openreel.json");
    const workflow = path.join(roots.projectRoot, "env-run.jsonl");
    await writeFile(
      workflow,
      [
        JSON.stringify({ id: "create", verb: "project.create", params: { name: "Env", idempotencyKey: "env-c" } }),
        JSON.stringify({ id: "save", verb: "project.save", params: { path: checkpoint } }),
      ].join("\n") + "\n",
    );
    const handle = spawnCli(
      ["run", "--workflow", workflow, "--log-level", "error"],
      envRoots(),
    );
    expect(await handle.exitCode).toBe(0);
    const lines = handle.stdout.split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[1].result.ok).toBe(true);
    expect(lines[1].result.value.path).toContain("env-run.openreel.json");
  }, 120_000);

  it("OPENREEL_TRANSPORT_LOG=error suppresses info-level stderr logs on serve", async () => {
    // Readiness via the MCP handshake: at error level there is no
    // "listening" info line to wait for, and a fixed sleep races handler
    // installation on loaded runners.
    const client = startServe([], { ...envRoots(), OPENREEL_TRANSPORT_LOG: "error" });
    await initialize(client);
    client.handle.child.kill("SIGTERM");
    expect(await client.handle.exitCode).toBe(143);
    const levels = client.handle.stderr
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => (JSON.parse(l) as { level: string }).level);
    expect(levels).not.toContain("info");
    expect(levels).not.toContain("debug");
  }, 120_000);
});
