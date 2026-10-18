/** Business contracts previously exercised through the stdio adapter, now via run. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FACADE_VERBS, FACADE_CONTRACT_VERSION } from "@reelterminal/agent-facade";
import { writeTinyVp9Mp4 } from "@reelterminal/runtime-chromium/media/tiny-vp9-mp4";
import { chromiumAvailable, makeRoots, spawnCli, type Roots } from "./helpers";

let roots: Roots;
beforeAll(async () => { roots = await makeRoots(); });
afterAll(async () => { await roots.cleanup(); });

async function run(steps: object[], keepGoing = false) {
  const workflow = path.join(roots.projectRoot, "contract.jsonl");
  await writeFile(workflow, steps.map((step) => JSON.stringify(step)).join("\n") + "\n");
  const handle = spawnCli([
    "run", "--workflow", workflow,
    "--media-root", roots.mediaRoot, "--artifact-root", roots.artifactRoot,
    "--project-root", roots.projectRoot, "--log-level", "error",
    ...(keepGoing ? ["--keep-going"] : []),
  ]);
  const code = await handle.exitCode;
  const results = handle.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { code, results, stderr: handle.stderr };
}

describe("headless command contract through the real CLI", () => {
  it("preserves discovery, revisions, replay, rename and domain failures", async () => {
    const create = { name: "Contract", settings: { width: 320, height: 180, frameRate: 30 }, idempotencyKey: "create" };
    const { code, results, stderr } = await run([
      { id: "describe", verb: "session.describe", params: {} },
      { id: "create", verb: "project.create", params: create },
      { id: "replay", verb: "project.create", params: create },
      { id: "edit", verb: "edit.apply", params: { ops: [{ op: "track.add", trackType: "text", trackId: "t1" }, { op: "text.create", text: "Hello", startTime: 0, duration: 5, trackId: "t1" }], expectedRevision: 0, idempotencyKey: "edit" } },
      { id: "rename", verb: "project.rename", params: { name: "Renamed", expectedRevision: 1, idempotencyKey: "rename" } },
      { id: "conflict", verb: "edit.apply", params: { ops: [{ op: "track.add", trackType: "video" }], expectedRevision: 99, idempotencyKey: "stale" } },
      { id: "missing", verb: "job.status", params: { jobId: "missing-job" } },
      { id: "invalid", verb: "media.import", params: { path: path.join(roots.mediaRoot, "missing.mp4") } },
    ], true);
    expect(code, stderr).toBe(1);
    expect(results).toHaveLength(8);
    expect(results[0].result.value).toMatchObject({ contractVersion: FACADE_CONTRACT_VERSION });
    expect(results[0].result.value.verbs).toHaveLength(FACADE_VERBS.length);
    expect(results[0].result.value.errorCodes).toHaveLength(9);
    expect(results[1].result.value).toMatchObject({ revision: 0, replayed: false });
    expect(results[2].result.value).toMatchObject({ revision: 0, replayed: true });
    expect(results[3].result.value.revision).toBe(1);
    expect(results[4].result.value).toMatchObject({ revision: 2, previousName: "Contract", name: "Renamed", replayed: false });
    expect(results.slice(5).map((line) => line.result.error.code)).toEqual(["CONFLICT", "NOT_FOUND", "INVALID_PARAMS"]);
  });

  it.skipIf(!chromiumAvailable())("visual inspection returns readable image artifacts", async () => {
    const source = writeTinyVp9Mp4(roots.mediaRoot);
    const { code, results, stderr } = await run([
      { id: "create", verb: "project.create", params: { name: "Visual", settings: { width: 320, height: 180, frameRate: 30 } } },
      { id: "import", verb: "media.import", params: { path: source } },
      { id: "edit", verb: "edit.apply", params: { ops: [{ op: "track.add", trackType: "video", trackId: "v1" }, { op: "clip.add", trackId: "v1", mediaId: { $ref: "import#/mediaId" }, startTime: 0, duration: 5, clipId: "c1" }], expectedRevision: 1 } },
      { id: "visual", verb: "visual.inspect", params: { clipId: "c1", sampleCount: 1, width: 320, height: 180 } },
    ]);
    expect(code, stderr).toBe(0);
    const value = results[3].result.value;
    expect(value.frames).toHaveLength(1);
    const png = await readFile(value.frames[0].artifact.path);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });
});
