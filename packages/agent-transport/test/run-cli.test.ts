/**
 * `agent-video run` CLI tests against the REAL binary (slice 2c):
 * startup refusals (exit 2), static validation failures (exit 2, no
 * stdout), real pure-Node workflows (project.create → edit.apply →
 * timeline.get; import/save/open are pure Node too), stop-on-first-
 * failure and --keep-going exit codes, `$ref`-fed relative path
 * rejection, and the cross-process persistence loop (two `run`
 * invocations with a checkpoint between them).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnCli, makeRoots, type Roots } from "./helpers";
import { writeTinyVp9Mp4 } from "@reelterminal/runtime-chromium/media/tiny-vp9-mp4";

let roots: Roots;
let inputMp4: string;
let workflowPath: (name: string) => string;

beforeAll(async () => {
  roots = await makeRoots();
  await mkdir(roots.mediaRoot, { recursive: true });
  // Generated ≥5 s input (deterministic embedded VP9 fixture — decodes
  // everywhere Chromium runs, no committed binary).
  inputMp4 = path.join(roots.mediaRoot, "input.mp4");
  await writeFile(inputMp4, (await import("node:fs")).readFileSync(writeTinyVp9Mp4(roots.mediaRoot)));
  workflowPath = (name: string) => path.join(roots.mediaRoot, `${name}.jsonl`);
  await mkdir(path.dirname(workflowPath("x")), { recursive: true });
});

afterAll(async () => {
  await roots.cleanup();
});

async function runWorkflow(lines: object[], extraArgs: string[] = []): Promise<{
  exitCode: number;
  stdoutLines: Record<string, any>[];
  stderr: string;
}> {
  const file = workflowPath(`wf-${Math.random().toString(36).slice(2)}`);
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const handle = spawnCli([
    "run",
    "--workflow", file,
    "--media-root", roots.mediaRoot,
    "--artifact-root", roots.artifactRoot,
    "--project-root", roots.projectRoot,
    "--log-level", "error",
    ...extraArgs,
  ]);
  const exitCode = await handle.exitCode;
  const stdoutLines = handle.stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
  return { exitCode, stdoutLines, stderr: handle.stderr };
}

async function runRaw(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const handle = spawnCli(["run", ...args]);
  const exitCode = await handle.exitCode;
  return { exitCode, stdout: handle.stdout, stderr: handle.stderr };
}

describe("run: startup refusals (exit 2, Decision 6 / B.5)", () => {
  it("refuses a relative --workflow path", async () => {
    const r = await runRaw(["--workflow", "relative/workflow.jsonl"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("absolute path");
  });

  it("refuses a missing --workflow", async () => {
    const r = await runRaw([]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--workflow");
  });

  it("refuses relative media roots", async () => {
    const r = await runRaw(["--workflow", "/tmp/wf.jsonl", "--media-root", "relative/media"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("not an absolute path");
  });

  it("refuses missing roots (never auto-created)", async () => {
    const r = await runRaw(["--workflow", "/tmp/wf.jsonl", "--artifact-root", "/definitely/not/here-ave"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("does not exist");
  });

  it("refuses non-directory roots and `~` roots without expansion", async () => {
    // An existing non-directory path on every platform (POSIX traditionally
    // used /etc/hosts, which does not exist on Windows).
    const r = await runRaw(["--workflow", "/tmp/wf.jsonl", "--media-root", process.execPath]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("not a directory");
    const tilde = await runRaw(["--workflow", "/tmp/wf.jsonl", "--media-root", "~/Movies"]);
    expect(tilde.exitCode).toBe(2);
    expect(tilde.stderr).toContain("'~'");
  });

  it("refuses unknown flags", async () => {
    const r = await runRaw(["--workflow", "/tmp/wf.jsonl", "--frobnicate", "1"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown argument");
  });
});

describe("run: static validation failures (exit 2, no steps executed)", () => {
  async function expectStaticFailure(lines: object[], messagePart: string): Promise<void> {
    const r = await runRaw([
      "--workflow", (await writeFileTemp(lines)) ?? "",
      "--media-root", roots.mediaRoot,
      "--artifact-root", roots.artifactRoot,
      "--project-root", roots.projectRoot,
    ]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(messagePart);
  }

  async function writeFileTemp(lines: object[]): Promise<string> {
    const file = workflowPath(`static-${Math.random().toString(36).slice(2)}`);
    await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return file;
  }

  it("duplicate ids", async () => {
    await expectStaticFailure(
      [
        { id: "a", verb: "timeline.get" },
        { id: "a", verb: "timeline.get" },
      ],
      "duplicate step id",
    );
  });

  it("forward reference", async () => {
    await expectStaticFailure(
      [
        { id: "a", verb: "media.import", params: { path: "/x.mp4", path2: { $ref: "b#/y" } } },
        { id: "b", verb: "timeline.get" },
      ],
      "not an earlier step",
    );
  });

  it("bad pointer syntax", async () => {
    await expectStaticFailure(
      [{ id: "a", verb: "timeline.get", params: { x: { $ref: "a#oops" } } }],
      "invalid reference",
    );
  });

  it("unknown verb", async () => {
    await expectStaticFailure([{ id: "a", verb: "timeline.destroy" }], "unknown verb");
  });

  it("await.jobId referencing a non-job-start step", async () => {
    await expectStaticFailure(
      [
        { id: "t", verb: "timeline.get" },
        { id: "w", await: { jobId: { $ref: "t" }, timeoutMs: 1000 } },
      ],
      "may only reference an earlier export.start or media.analyze_start step",
    );
  });

  it("await.timeoutMs missing / too big", async () => {
    await expectStaticFailure([{ id: "w", await: { jobId: "job-1" } }], "timeoutMs is required");
    await expectStaticFailure(
      [{ id: "w", await: { jobId: "job-1", timeoutMs: 3_600_001 } }],
      "must be <=",
    );
  });

  it("malformed JSONL line", async () => {
    const file = workflowPath("static-bad-json");
    await writeFile(file, "{not json}\n");
    const r = await runRaw([
      "--workflow", file,
      "--media-root", roots.mediaRoot,
      "--artifact-root", roots.artifactRoot,
      "--project-root", roots.projectRoot,
    ]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("not valid JSON");
  });
});

describe("run: real pure-Node workflows against a fresh session", () => {
  it("create → import → edit → timeline_get happy path emits one JSON line per step, exit 0", async () => {
    const result = await runWorkflow([
      { id: "create", verb: "project.create", params: { name: "Run smoke", settings: { width: 320, height: 180, frameRate: 30 }, idempotencyKey: "run-create" } },
      { id: "import", verb: "media.import", params: { path: inputMp4, expectedRevision: 0, idempotencyKey: "run-import" } },
      {
        id: "edit",
        verb: "edit.apply",
        params: {
          ops: [
            { op: "track.add", trackType: "video", trackId: "v1" },
            { op: "clip.add", trackId: "v1", mediaId: { $ref: "import#/mediaId" }, startTime: 0, clipId: "c1" },
          ],
          expectedRevision: 1,
          idempotencyKey: "run-edit",
        },
      },
      { id: "timeline", verb: "timeline.get" },
      { id: "check", verb: "project.get_state" },
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdoutLines).toHaveLength(5);
    const [, importLine, editLine, timelineLine] = result.stdoutLines;
    expect(importLine.id).toBe("import");
    expect(importLine.result.ok).toBe(true);
    expect(importLine.result.value.metadata.durationSec).toBeGreaterThanOrEqual(5);
    expect(editLine.result.value.revision).toBe(2);
    expect(timelineLine.result.value.tracks[0].clips[0].id).toBe("c1");
    expect(importLine.verb).toBe("media.import");
    expect(Object.prototype.hasOwnProperty.call(importLine, "workflowError")).toBe(false);
  });

  it("a verb failure stops the run with exit 1 and only the executed lines on stdout", async () => {
    const result = await runWorkflow([
      { id: "create", verb: "project.create", params: { idempotencyKey: "k1" } },
      { id: "second", verb: "project.create", params: { idempotencyKey: "k2" } },
      { id: "timeline", verb: "timeline.get" },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdoutLines).toHaveLength(2);
    expect(result.stdoutLines[0].result.ok).toBe(true);
    expect(result.stdoutLines[1].result.ok).toBe(false);
    expect(result.stdoutLines[1].result.error.code).toBe("CONFLICT");
  });

  it("--keep-going continues, exit still 1; ref to failed step is a workflowError", async () => {
    const result = await runWorkflow(
      [
        { id: "create", verb: "project.create", params: { idempotencyKey: "kg1" } },
        { id: "conflict", verb: "project.create", params: { idempotencyKey: "kg2" } },
        { id: "ref", verb: "timeline.get", params: { prev: { $ref: "conflict#/revision" } } },
      ],
      ["--keep-going"],
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdoutLines).toHaveLength(3);
    expect(result.stdoutLines[1].result.ok).toBe(false);
    expect(result.stdoutLines[2].workflowError.code).toBe("REF_STEP_FAILED");
  });

  it("a literal relative path param is rejected at the boundary with clear wording", async () => {
    const result = await runWorkflow([
      { id: "create", verb: "project.create", params: { idempotencyKey: "rel" } },
      { id: "import", verb: "media.import", params: { path: "relative/input.mp4" } },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdoutLines).toHaveLength(2);
    const failure = result.stdoutLines[1].result;
    expect(failure.ok).toBe(false);
    expect(failure.error.code).toBe("INVALID_PARAMS");
    expect(failure.error.message).toContain("must be an absolute path");
  });

  it("a $ref-fed relative path is rejected AFTER substitution (Decision 6 injection pin)", async () => {
    // project.get_state echoes mediaLibrary only after an import; use the
    // checkpoint result path instead: save returns a relative path? No —
    // craft it with the timeline view and a save whose path arg came from
    // an earlier text field. Simplest deterministic source of a relative
    // string: project.create name, then project.open path via $ref.
    const result = await runWorkflow([
      { id: "create", verb: "project.create", params: { name: "relative/oops.openreel.json", idempotencyKey: "name-src" } },
      { id: "open", verb: "project.open", params: { path: { $ref: "create#/project/name" } } },
    ]);
    expect(result.exitCode).toBe(1);
    const openLine = result.stdoutLines[1];
    expect(openLine.result.ok).toBe(false);
    expect(openLine.result.error.code).toBe("INVALID_PARAMS");
    expect(openLine.result.error.message).toContain("must be an absolute path");
    expect(openLine.result.error.message).toContain("relative/oops.openreel.json");
  });
});

describe("run: persistence via the checkpoint pair (Decision 10, two invocations)", () => {
  it("invocation A creates/edits/saves; invocation B opens at the saved revision and continues", async () => {
    const checkpoint = path.join(roots.projectRoot, "promo-v1.openreel.json");
    const checkpoint2 = path.join(roots.projectRoot, "promo-v2.openreel.json");

    // Invocation A: create → import → edit → save (all pure Node).
    const a = await runWorkflow([
      { id: "create", verb: "project.create", params: { name: "Persisted", settings: { width: 320, height: 180, frameRate: 30 }, idempotencyKey: "pa-create" } },
      { id: "import", verb: "media.import", params: { path: inputMp4, expectedRevision: 0, idempotencyKey: "pa-import" } },
      {
        id: "edit",
        verb: "edit.apply",
        params: {
          ops: [
            { op: "track.add", trackType: "video", trackId: "v1" },
            { op: "clip.add", trackId: "v1", mediaId: { $ref: "import#/mediaId" }, startTime: 0, duration: 5, clipId: "c1" },
          ],
          expectedRevision: 1,
          idempotencyKey: "pa-edit",
        },
      },
      { id: "save", verb: "project.save", params: { path: checkpoint } },
    ]);
    expect(a.exitCode).toBe(0);
    const saveLine = a.stdoutLines[3];
    expect(saveLine.result.ok).toBe(true);
    const savedRevision = saveLine.result.value.revision;
    expect(saveLine.result.value.bytesWritten).toBeGreaterThan(0);
    expect(saveLine.result.value.stateSha256).toMatch(/^[0-9a-f]{64}$/);

    // No .tmp siblings left behind after a clean save.
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(roots.projectRoot)).some((f) => f.endsWith(".tmp"))).toBe(false);

    // Invocation B: fresh session, fresh ledger — open continues at the
    // saved revision; the next mutation commits savedRevision + 1.
    const b = await runWorkflow([
      { id: "open", verb: "project.open", params: { path: checkpoint, idempotencyKey: "pb-open" } },
      { id: "timeline", verb: "timeline.get" },
      {
        id: "edit2",
        verb: "edit.apply",
        params: {
          ops: [{ op: "track.add", trackType: "text", trackId: "t1" }],
          expectedRevision: savedRevision,
          idempotencyKey: "pb-edit",
        },
      },
      { id: "save2", verb: "project.save", params: { path: checkpoint2 } },
      { id: "save1again", verb: "project.save", params: { path: checkpoint } },
    ]);
    expect(b.exitCode).toBe(1); // the last save hits CONFLICT (no-overwrite default)
    const [openLine, timelineLine, editLine, save2Line, save1AgainLine] = b.stdoutLines;
    expect(openLine.result.ok).toBe(true);
    expect(openLine.result.value.revision).toBe(savedRevision);
    expect(timelineLine.result.value.tracks.some((t: any) => t.clips.some((c: any) => c.id === "c1"))).toBe(true);
    expect(editLine.result.value.revision).toBe(savedRevision + 1);
    expect(save2Line.result.ok).toBe(true);
    expect(save1AgainLine.result.ok).toBe(false);
    expect(save1AgainLine.result.error.code).toBe("CONFLICT");
  });
});
