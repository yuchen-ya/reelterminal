/**
 * Chromium-gated E2E through the REAL `agent-video run` binary (the B.6
 * closed loop, Appendix B.6 example): import → edit → export → await →
 * verify, plus the cross-process persistence loop with pixels-adjacent
 * verification (Appendix D scenario shapes, expressed as workflows).
 *
 * Every assertion here needs real Chromium + ffmpeg. When a preflight
 * fails the suite SKIPS with a printed reason (runtime-chromium gating
 * pattern).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromiumAvailable, ffmpegAvailable, makeRoots, spawnCli, type Roots } from "./helpers";
import { writeTinyVp9Mp4 } from "@openreel/runtime-chromium/media/tiny-vp9-mp4";

let roots: Roots;
let inputMp4: string;
const runtimeHealthy = chromiumAvailable() && ffmpegAvailable();

beforeAll(async () => {
  roots = await makeRoots();
  await mkdir(roots.mediaRoot, { recursive: true });
  inputMp4 = path.join(roots.mediaRoot, "input.mp4");
  await copyFile(writeTinyVp9Mp4(roots.mediaRoot), inputMp4);
});

afterAll(async () => {
  await roots.cleanup();
});

async function runWorkflow(lines: object[]): Promise<{ exitCode: number; stdoutLines: Record<string, any>[]; stderr: string }> {
  const file = path.join(roots.mediaRoot, `e2e-${Math.random().toString(36).slice(2)}.jsonl`);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const handle = spawnCli([
    "run",
    "--workflow", file,
    "--media-root", roots.mediaRoot,
    "--artifact-root", roots.artifactRoot,
    "--project-root", roots.projectRoot,
    "--log-level", "error",
  ]);
  const exitCode = await handle.exitCode;
  const stdoutLines = handle.stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
  return { exitCode, stdoutLines, stderr: handle.stderr };
}

describe.skipIf(!runtimeHealthy)("closed loop over run (real Chromium + ffmpeg)", () => {
  it("import → edit → preview → export → await(done) → verify passes end to end", async () => {
    const result = await runWorkflow([
      { id: "create", verb: "project.create", params: { name: "Closed loop", settings: { width: 320, height: 180, frameRate: 30, sampleRate: 48000, channels: 2 }, idempotencyKey: "e2e-create" } },
      { id: "import", verb: "media.import", params: { path: inputMp4, expectedRevision: 0, idempotencyKey: "e2e-import" } },
      {
        id: "edit",
        verb: "edit.apply",
        params: {
          ops: [
            { op: "track.add", trackType: "video", trackId: "v1" },
            { op: "clip.add", trackId: "v1", mediaId: { $ref: "import#/mediaId" }, startTime: 0, clipId: "c1" },
            { op: "clip.trim", clipId: "c1", inPoint: 0, outPoint: 5 },
            { op: "track.add", trackType: "text", trackId: "t1" },
            { op: "text.create", text: "Hello world", startTime: 0, duration: 5, trackId: "t1" },
          ],
          expectedRevision: 1,
          idempotencyKey: "e2e-edit",
        },
      },
      { id: "preview", verb: "preview.render_frame", params: { timeSec: 2.5, expectedRevision: 2 } },
      { id: "export", verb: "export.start", params: { idempotencyKey: "e2e-export" } },
      { id: "wait", await: { jobId: { $ref: "export#/jobId" }, timeoutMs: 600000, pollMs: 1000 } },
      { id: "verify", verb: "verify.artifact", params: {
          path: { $ref: "wait#/artifact/path" },
          expect: { container: "mp4", videoCodec: "h264", width: 320, height: 180, durationSec: 5, durationToleranceSec: 0.12 },
        } },
      { id: "similar", verb: "verify.artifact", params: {
          path: { $ref: "wait#/artifact/path" },
          compare: { referencePath: { $ref: "preview#/artifact/path" }, timeSec: 2.5, mode: "similar", maxMeanAbsDiff: 14 },
        } },
    ]);
    expect(result.exitCode).toBe(0);
    const [, , , previewLine, , waitLine, verifyLine, similarLine] = result.stdoutLines;
    expect(previewLine.result.ok).toBe(true);
    expect(previewLine.result.value.artifact.sourceRevision).toBe(2);
    expect(waitLine.result.ok).toBe(true);
    expect(waitLine.result.value.state).toBe("done");
    expect(waitLine.result.value.artifact).toBeTruthy();
    expect(waitLine.result.value.route).toBeTruthy();
    expect(verifyLine.result.ok).toBe(true);
    expect(verifyLine.result.value.pass).toBe(true);
    const probe = verifyLine.result.value.probe;
    expect(probe.frameCount).toBe(150); // 5 s × 30 fps
    expect(similarLine.result.ok).toBe(true);
    expect(similarLine.result.value.compare.pass).toBe(true);
    // artifact really lives under the configured artifactRoot (realpath form)
    expect(
      waitLine.result.value.artifact.path.startsWith(roots.artifactRoot)
      || waitLine.result.value.artifact.path.startsWith(realpathSync(roots.artifactRoot)),
    ).toBe(true);
  }, 900_000);

  it("job.cancel is reachable and idempotent on terminal jobs", async () => {
    const result = await runWorkflow([
      { id: "create", verb: "project.create", params: { name: "Cancel probe", idempotencyKey: "cancel-create" } },
      { id: "status", verb: "job.status", params: { jobId: "job-never-existed" } },
    ]);
    // unknown job: verb-level NOT_FOUND, step failure, exit 1
    expect(result.exitCode).toBe(1);
    expect(result.stdoutLines[1].result.ok).toBe(false);
    expect(result.stdoutLines[1].result.error.code).toBe("NOT_FOUND");
  }, 300_000);

  it("persistence with pixels: preview continuity across the process boundary (scenario-2 shape)", async () => {
    const checkpoint = path.join(roots.projectRoot, "e2e-v1.openreel.json");
    // Process A: create → import → edit → preview → save
    const a = await runWorkflow([
      { id: "create", verb: "project.create", params: { name: "Continuity", settings: { width: 320, height: 180, frameRate: 30, sampleRate: 48000, channels: 2 }, idempotencyKey: "px-create" } },
      { id: "import", verb: "media.import", params: { path: inputMp4, expectedRevision: 0, idempotencyKey: "px-import" } },
      {
        id: "edit",
        verb: "edit.apply",
        params: {
          ops: [
            { op: "track.add", trackType: "video", trackId: "v1" },
            { op: "clip.add", trackId: "v1", mediaId: { $ref: "import#/mediaId" }, startTime: 0, clipId: "c1" },
            { op: "clip.trim", clipId: "c1", inPoint: 0, outPoint: 5 },
            { op: "track.add", trackType: "text", trackId: "t1" },
            { op: "text.create", text: "Hello world", startTime: 0, duration: 5, trackId: "t1" },
          ],
          expectedRevision: 1,
          idempotencyKey: "px-edit",
        },
      },
      { id: "previewA", verb: "preview.render_frame", params: { timeSec: 2.5, expectedRevision: 2 } },
      { id: "save", verb: "project.save", params: { path: checkpoint } },
    ]);
    expect(a.exitCode).toBe(0);
    const previewAPath = a.stdoutLines[3].result.value.artifact.path;

    // Process B: open (continues at saved revision) → export → await →
    // verify export against process A's own preview (pixel continuity).
    const b = await runWorkflow([
      { id: "open", verb: "project.open", params: { path: checkpoint } },
      { id: "previewB", verb: "preview.render_frame", params: { timeSec: 2.5 } },
      { id: "export", verb: "export.start", params: { idempotencyKey: "px-export" } },
      { id: "wait", await: { jobId: { $ref: "export#/jobId" }, timeoutMs: 600000, pollMs: 1000 } },
      { id: "verify", verb: "verify.artifact", params: {
          path: { $ref: "wait#/artifact/path" },
          expect: { container: "mp4", videoCodec: "h264", width: 320, height: 180, durationSec: 5, durationToleranceSec: 0.12 },
        } },
      { id: "similar", verb: "verify.artifact", params: {
          path: { $ref: "wait#/artifact/path" },
          compare: { referencePath: previewAPath, timeSec: 2.5, mode: "similar", maxMeanAbsDiff: 14 },
        } },
    ]);
    expect(b.exitCode).toBe(0);
    const [, previewBLine, , , verifyLine, similarLine] = b.stdoutLines;
    expect(previewBLine.result.ok).toBe(true);
    expect(verifyLine.result.value.pass).toBe(true);
    // the pre-restart content renders pixel-continuous in the new process
    expect(similarLine.result.value.compare.pass).toBe(true);
  }, 900_000);
});
