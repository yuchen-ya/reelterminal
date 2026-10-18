import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigRefusal, mergeEnvLogLevel, mergeEnvRoots } from "../src/config";
import { makeRoots, spawnCli, type Roots } from "./helpers";

let roots: Roots;

beforeAll(async () => {
  roots = await makeRoots();
});

afterAll(async () => {
  await roots.cleanup();
});

function envRoots(): Record<string, string> {
  return {
    REELTERMINAL_AVE_MEDIA_ROOTS: roots.mediaRoot,
    REELTERMINAL_AVE_ARTIFACT_ROOT: roots.artifactRoot,
    REELTERMINAL_AVE_PROJECT_ROOTS: roots.projectRoot,
  };
}

describe("B.5 env merge functions (unit)", () => {
  it("mergeEnvRoots fills only the classes flags left empty", () => {
    const merged = mergeEnvRoots(
      { mediaRoots: ["/flag/m"], projectRoots: [], deliveryRoots: ["/flag/d"] },
      {
        REELTERMINAL_AVE_MEDIA_ROOTS: `/env/m1${path.delimiter}/env/m2`,
        REELTERMINAL_AVE_ARTIFACT_ROOT: "/env/a",
        REELTERMINAL_AVE_PROJECT_ROOTS: "/env/p",
        REELTERMINAL_AVE_DELIVERY_ROOTS: "/env/d",
      },
    );
    expect(merged.mediaRoots).toEqual(["/flag/m"]); // flag wins
    expect(merged.artifactRoot).toBe("/env/a"); // env fills
    expect(merged.projectRoots).toEqual(["/env/p"]); // env fills
    expect(merged.deliveryRoots).toEqual(["/flag/d"]); // flag wins
  });

  it("mergeEnvRoots fills deliveryRoots from REELTERMINAL_AVE_DELIVERY_ROOTS", () => {
    const merged = mergeEnvRoots(
      { mediaRoots: [], projectRoots: [], deliveryRoots: [] },
      { REELTERMINAL_AVE_DELIVERY_ROOTS: `/env/d1${path.delimiter}/env/d2` },
    );
    expect(merged.deliveryRoots).toEqual(["/env/d1", "/env/d2"]);
  });

  it("mergeEnvRoots without env leaves every class empty", () => {
    const merged = mergeEnvRoots({ mediaRoots: [], projectRoots: [], deliveryRoots: [] }, {});
    expect(merged.mediaRoots).toEqual([]);
    expect(merged.artifactRoot).toBeUndefined();
    expect(merged.projectRoots).toEqual([]);
    expect(merged.deliveryRoots).toEqual([]);
  });

  it("mergeEnvLogLevel: flag wins, env fills, default info, invalid env refuses startup", () => {
    expect(mergeEnvLogLevel("debug", { REELTERMINAL_TRANSPORT_LOG: "error" })).toBe("debug");
    expect(mergeEnvLogLevel(undefined, { REELTERMINAL_TRANSPORT_LOG: "error" })).toBe("error");
    expect(mergeEnvLogLevel(undefined, {})).toBe("info");
    expect(() => mergeEnvLogLevel(undefined, { REELTERMINAL_TRANSPORT_LOG: "loud" })).toThrow(ConfigRefusal);
  });
});

describe("B.5 env config honored by the commands (integration)", () => {
  it("run with env-only roots reports media import capability and honors the log level", async () => {
    const workflow = path.join(roots.projectRoot, "env-capabilities.jsonl");
    await writeFile(workflow, JSON.stringify({ id: "capabilities", verb: "capabilities.get", params: {} }) + "\n");
    const handle = spawnCli(["run", "--workflow", workflow], {
      ...envRoots(), REELTERMINAL_TRANSPORT_LOG: "error",
    });
    expect(await handle.exitCode).toBe(0);
    const result = JSON.parse(handle.stdout).result;
    expect(result.ok).toBe(true);
    expect(result.value.mediaImport.available).toBe(true);
    const levels = handle.stderr.split("\n").filter(Boolean).map((line) => JSON.parse(line).level);
    expect(levels).not.toContain("info");
    expect(levels).not.toContain("debug");
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

});
