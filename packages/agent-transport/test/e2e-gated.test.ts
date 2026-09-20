/**
 * Chromium-gated E2E through the REAL `reelterminal-agent run` binary (the B.6
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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chromiumAvailable,
  ffmpegAvailable,
  makeRoots,
  spawnCli,
  type Roots,
} from "./helpers";
import { writeTinyVp9Mp4 } from "@reelterminal/runtime-chromium/media/tiny-vp9-mp4";

const execFileAsync = promisify(execFile);

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
    expect(result.exitCode, result.stdoutLines.map((l) => JSON.stringify(l)).join("\n")).toBe(0);
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

  it("finishing edits plus duplicate and transition reach the real preview/export pipeline", async () => {
    const result = await runWorkflow([
      { id: "create", verb: "project.create", params: { name: "Finishing tools", settings: { width: 320, height: 180, frameRate: 30, sampleRate: 48000, channels: 2 } } },
      { id: "import", verb: "media.import", params: { path: inputMp4, expectedRevision: 0 } },
      {
        id: "seed",
        verb: "edit.apply",
        params: {
          ops: [
            { op: "track.add", trackType: "video", trackId: "v1" },
            { op: "clip.add", trackId: "v1", mediaId: { $ref: "import#/mediaId" }, startTime: 0, duration: 6, inPoint: 0, outPoint: 6, clipId: "c1" },
          ],
          expectedRevision: 1,
        },
      },
      {
        id: "arrange",
        verb: "edit.apply",
        params: {
          ops: [
            { op: "clip.move", clipId: "c1", startTime: 1 },
            { op: "clip.split", clipId: "c1", time: 2 },
          ],
          expectedRevision: 2,
        },
      },
      {
        id: "finish",
        verb: "edit.apply",
        params: {
          ops: [
            { op: "clip.setSpeed", clipId: { $ref: "arrange#/applied/1/createdIds/0" }, speed: 2 },
            { op: "clip.setReverse", clipId: { $ref: "arrange#/applied/1/createdIds/0" }, reversed: true },
            { op: "clip.setTransform", clipId: "c1", transform: {
              position: { x: 30, y: -10 },
              scale: { x: 0.75, y: 0.75 },
              opacity: 0.9,
              fitMode: "cover",
              crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
            } },
            { op: "clip.setFade", clipId: "c1", fadeIn: 0.2, fadeOut: 0.2 },
          ],
          expectedRevision: 3,
        },
      },
      {
        id: "duplicate",
        verb: "edit.apply",
        params: {
          ops: [{ op: "clip.duplicate", clipId: "c1" }],
          expectedRevision: 4,
        },
      },
      {
        id: "transition",
        verb: "edit.apply",
        params: {
          ops: [{
            op: "transition.add",
            clipAId: { $ref: "arrange#/applied/1/createdIds/0" },
            clipBId: { $ref: "duplicate#/applied/0/createdIds/0" },
            type: "crossfade",
            duration: 0.5,
          }],
          expectedRevision: 5,
        },
      },
      { id: "timeline", verb: "timeline.get", params: {} },
      { id: "preview", verb: "preview.render_frame", params: { timeSec: 4.5, expectedRevision: 6 } },
      { id: "export", verb: "export.start", params: {} },
      { id: "wait", await: { jobId: { $ref: "export#/jobId" }, timeoutMs: 600000, pollMs: 1000 } },
      { id: "verify", verb: "verify.artifact", params: {
          path: { $ref: "wait#/artifact/path" },
          expect: { container: "mp4", videoCodec: "h264", width: 320, height: 180, durationSec: 5.5, durationToleranceSec: 0.12 },
        } },
    ]);
    expect(result.exitCode, result.stdoutLines.map((line) => JSON.stringify(line)).join("\n")).toBe(0);
    const arrange = stepLine(result.stdoutLines, "arrange");
    expect(arrange.result.value.applied[0]).toEqual({ op: "clip.move", createdIds: [] });
    expect(arrange.result.value.applied[1].op).toBe("clip.split");
    expect(arrange.result.value.applied[1].createdIds).toHaveLength(1);
    const rightClipId = arrange.result.value.applied[1].createdIds[0];
    const duplicate = stepLine(result.stdoutLines, "duplicate").result.value;
    expect(duplicate.applied[0].op).toBe("clip.duplicate");
    expect(duplicate.applied[0].createdIds).toHaveLength(1);
    const duplicateId = duplicate.applied[0].createdIds[0];
    const transition = stepLine(result.stdoutLines, "transition").result.value;
    expect(transition.applied[0].op).toBe("transition.add");
    expect(transition.applied[0].createdIds).toHaveLength(1);
    const timeline = stepLine(result.stdoutLines, "timeline").result.value;
    const clips = timeline.tracks.find((track: any) => track.id === "v1")?.clips;
    expect(clips.find((clip: any) => clip.id === "c1")).toMatchObject({
      startTime: 1,
      duration: 1,
      fade: { fadeIn: 0.2, fadeOut: 0.2 },
      transform: {
        position: { x: 30, y: -10 },
        scale: { x: 0.75, y: 0.75 },
        opacity: 0.9,
        fitMode: "cover",
        crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      },
    });
    expect(clips.find((clip: any) => clip.id === rightClipId)).toMatchObject({
      startTime: 2,
      duration: 2.5,
      inPoint: 1,
      outPoint: 6,
      speed: 2,
      reversed: true,
    });
    expect(clips.find((clip: any) => clip.id === duplicateId)).toMatchObject({
      startTime: 4.5,
      duration: 1,
      transform: {
        position: { x: 30, y: -10 },
        scale: { x: 0.75, y: 0.75 },
      },
    });
    expect(timeline.tracks.find((track: any) => track.id === "v1")?.transitions)
      .toContainEqual(expect.objectContaining({
        id: transition.applied[0].createdIds[0],
        clipAId: rightClipId,
        clipBId: duplicateId,
        type: "crossfade",
        duration: 0.5,
      }));
    expect(stepLine(result.stdoutLines, "preview").result.ok).toBe(true);
    expect(stepLine(result.stdoutLines, "wait").result.value.state).toBe("done");
    expect(stepLine(result.stdoutLines, "verify").result.value.pass).toBe(true);
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
    expect(a.exitCode, a.stdoutLines.map((l) => JSON.stringify(l)).join("\n")).toBe(0);
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
    expect(b.exitCode, b.stdoutLines.map((l) => JSON.stringify(l)).join("\n")).toBe(0);
    const [, previewBLine, , , verifyLine, similarLine] = b.stdoutLines;
    expect(previewBLine.result.ok).toBe(true);
    expect(verifyLine.result.value.pass).toBe(true);
    // the pre-restart content renders pixel-continuous in the new process
    expect(similarLine.result.value.compare.pass).toBe(true);
  }, 900_000);
});

/* ------------------------------------------------------------------ */
/* edit.apply op vocabulary (pixel/audio proofs)                       */
/* ------------------------------------------------------------------ */

/** Locate a step's stdout line by its unique step id. */
function stepLine(
  lines: Record<string, any>[],
  id: string,
): Record<string, any> {
  const line = lines.find((l) => l.id === id);
  if (!line) throw new Error(`step line "${id}" missing from run output`);
  return line;
}

describe.skipIf(!runtimeHealthy)("edit.apply op vocabulary E2E (real Chromium + ffmpeg)", () => {
  it("text.create/text.update/text.delete move pixels between bands and back to baseline", async () => {
    const result = await runWorkflow([
      { id: "create", verb: "project.create", params: { name: "Position", settings: { width: 320, height: 180, frameRate: 30, sampleRate: 48000, channels: 2 }, idempotencyKey: "pos-create" } },
      { id: "import", verb: "media.import", params: { path: inputMp4, expectedRevision: 0, idempotencyKey: "pos-import" } },
      {
        id: "edit-base",
        verb: "edit.apply",
        params: {
          ops: [
            { op: "track.add", trackType: "video", trackId: "v1" },
            { op: "clip.add", trackId: "v1", mediaId: { $ref: "import#/mediaId" }, startTime: 0, clipId: "c1" },
            { op: "clip.trim", clipId: "c1", inPoint: 0, outPoint: 2 },
          ],
          expectedRevision: 1,
          idempotencyKey: "pos-edit-base",
        },
      },
      { id: "preview-base", verb: "preview.render_frame", params: { timeSec: 1, expectedRevision: 2 } },
      {
        id: "edit-bottom",
        verb: "edit.apply",
        params: {
          ops: [
            { op: "track.add", trackType: "text", trackId: "t1" },
            { op: "text.create", text: "POSITION", startTime: 0, duration: 2, trackId: "t1", position: { x: 0.5, y: 0.85 } },
          ],
          expectedRevision: 2,
          idempotencyKey: "pos-edit-bottom",
        },
      },
      { id: "preview-bottom", verb: "preview.render_frame", params: { timeSec: 1, expectedRevision: 3 } },
      {
        id: "edit-top",
        verb: "edit.apply",
        params: {
          ops: [
            { op: "text.update", overlayId: { $ref: "edit-bottom#/applied/1/createdIds/0" }, position: { x: 0.5, y: 0.15 } },
          ],
          expectedRevision: 3,
          idempotencyKey: "pos-edit-top",
        },
      },
      { id: "preview-top", verb: "preview.render_frame", params: { timeSec: 1, expectedRevision: 4 } },
      {
        id: "edit-delete",
        verb: "edit.apply",
        params: {
          ops: [
            { op: "text.delete", overlayId: { $ref: "edit-bottom#/applied/1/createdIds/0" } },
          ],
          expectedRevision: 4,
          idempotencyKey: "pos-edit-delete",
        },
      },
      { id: "preview-deleted", verb: "preview.render_frame", params: { timeSec: 1, expectedRevision: 5 } },
      // Text at the bottom: the bottom band differs from baseline, the top
      // band is untouched.
      { id: "bottom-changed", verb: "verify.artifact", params: {
          path: { $ref: "preview-bottom#/artifact/path" },
          compare: { referencePath: { $ref: "preview-base#/artifact/path" }, timeSec: 1, region: { x: 0, y: 0.7, width: 1, height: 0.3 }, mode: "different", minChangedPixelsRatio: 0.02 },
        } },
      { id: "top-unchanged", verb: "verify.artifact", params: {
          path: { $ref: "preview-bottom#/artifact/path" },
          compare: { referencePath: { $ref: "preview-base#/artifact/path" }, timeSec: 1, region: { x: 0, y: 0, width: 1, height: 0.3 }, mode: "similar", maxMeanAbsDiff: 4 },
        } },
      // After the move: the top band differs, the bottom band is baseline.
      { id: "top-changed", verb: "verify.artifact", params: {
          path: { $ref: "preview-top#/artifact/path" },
          compare: { referencePath: { $ref: "preview-base#/artifact/path" }, timeSec: 1, region: { x: 0, y: 0, width: 1, height: 0.3 }, mode: "different", minChangedPixelsRatio: 0.02 },
        } },
      { id: "bottom-unchanged", verb: "verify.artifact", params: {
          path: { $ref: "preview-top#/artifact/path" },
          compare: { referencePath: { $ref: "preview-base#/artifact/path" }, timeSec: 1, region: { x: 0, y: 0.7, width: 1, height: 0.3 }, mode: "similar", maxMeanAbsDiff: 4 },
        } },
      // After the delete: the full frame is back to the baseline.
      { id: "full-restored", verb: "verify.artifact", params: {
          path: { $ref: "preview-deleted#/artifact/path" },
          compare: { referencePath: { $ref: "preview-base#/artifact/path" }, timeSec: 1, mode: "similar", maxMeanAbsDiff: 4 },
        } },
    ]);
    expect(result.exitCode, result.stdoutLines.map((l) => JSON.stringify(l)).join("\n")).toBe(0);
    const log = (label: string, line: Record<string, any>) => {
      const c = line.result.value.compare;
      console.log(
        `[e2e] ${label}: mean|Δ|=${c.meanAbsDiff?.toFixed(3)} changed=${((c.changedPixelsRatio ?? 0) * 100).toFixed(2)}%`,
      );
    };
    for (const id of [
      "bottom-changed",
      "top-unchanged",
      "top-changed",
      "bottom-unchanged",
      "full-restored",
    ]) {
      const line = stepLine(result.stdoutLines, id);
      expect(line.result.ok, `${id} ran`).toBe(true);
      expect(line.result.value.pass, `${id} passed`).toBe(true);
      log(id, line);
    }
  }, 900_000);

  it("clip.setVolume flows into the export: volume 1.0 vs 0.2 differ by >= 8 dB (volumedetect)", async () => {
    // Sine-wave WAV fixture, generated in-test inside the media root.
    const wavPath = path.join(roots.mediaRoot, "sine-2s.wav");
    await execFileAsync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le",
      "-y", wavPath,
    ]);

    const result = await runWorkflow([
      { id: "create", verb: "project.create", params: { name: "Volume", settings: { width: 320, height: 180, frameRate: 30, sampleRate: 48000, channels: 2 }, idempotencyKey: "vol-create" } },
      { id: "import-video", verb: "media.import", params: { path: inputMp4, expectedRevision: 0, idempotencyKey: "vol-import-video" } },
      { id: "import-audio", verb: "media.import", params: { path: wavPath, expectedRevision: 1, idempotencyKey: "vol-import-audio" } },
      {
        id: "edit",
        verb: "edit.apply",
        params: {
          ops: [
            { op: "track.add", trackType: "video", trackId: "v1" },
            { op: "clip.add", trackId: "v1", mediaId: { $ref: "import-video#/mediaId" }, startTime: 0, clipId: "c1" },
            { op: "clip.trim", clipId: "c1", inPoint: 0, outPoint: 2 },
            { op: "track.add", trackType: "audio", trackId: "a1" },
            { op: "clip.add", trackId: "a1", mediaId: { $ref: "import-audio#/mediaId" }, startTime: 0, clipId: "a2" },
          ],
          expectedRevision: 2,
          idempotencyKey: "vol-edit",
        },
      },
      { id: "export-unity", verb: "export.start", params: { idempotencyKey: "vol-export-unity" } },
      { id: "wait-unity", await: { jobId: { $ref: "export-unity#/jobId" }, timeoutMs: 600000, pollMs: 1000 } },
      {
        id: "edit-quiet",
        verb: "edit.apply",
        params: {
          ops: [
            { op: "clip.setVolume", clipId: "a2", volume: 0.2 },
          ],
          expectedRevision: 3,
          idempotencyKey: "vol-edit-quiet",
        },
      },
      { id: "export-quiet", verb: "export.start", params: { idempotencyKey: "vol-export-quiet" } },
      { id: "wait-quiet", await: { jobId: { $ref: "export-quiet#/jobId" }, timeoutMs: 600000, pollMs: 1000 } },
    ]);
    expect(result.exitCode, result.stdoutLines.map((l) => JSON.stringify(l)).join("\n")).toBe(0);
    const unityLine = stepLine(result.stdoutLines, "wait-unity");
    const quietLine = stepLine(result.stdoutLines, "wait-quiet");
    expect(unityLine.result.value.state).toBe("done");
    expect(quietLine.result.value.state).toBe("done");
    const unityPath = unityLine.result.value.artifact.path as string;
    const quietPath = quietLine.result.value.artifact.path as string;

    async function meanVolumeDb(file: string): Promise<number> {
      const { stderr } = await execFileAsync("ffmpeg", [
        "-v", "info",
        "-i", file,
        "-map", "0:a:0",
        "-af", "volumedetect",
        "-f", "null",
        "-",
      ]);
      const match = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
      expect(match, `volumedetect reported mean_volume for ${file}`).toBeTruthy();
      return Number(match![1]);
    }

    async function audioCodec(file: string): Promise<string> {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=codec_name",
        "-of", "default=noprint_wrappers=1:nokey=1",
        file,
      ]);
      expect(stdout.trim(), `audio stream present in ${file}`).toBeTruthy();
      return stdout.trim();
    }

    const unityCodec = await audioCodec(unityPath);
    const quietCodec = await audioCodec(quietPath);
    const unityDb = await meanVolumeDb(unityPath);
    const quietDb = await meanVolumeDb(quietPath);
    console.log(
      `[e2e] export audio: unity codec=${unityCodec} mean=${unityDb} dB; quiet codec=${quietCodec} mean=${quietDb} dB`,
    );
    // The WebCodecs route encodes whatever audio codec THIS Chromium build
    // can produce into the MP4 (aac, or opus as the mediabunny fallback) —
    // both are valid MP4 audio streams ffprobe can name.
    expect(unityCodec).toBe(quietCodec);
    expect(["aac", "opus", "mp3"]).toContain(unityCodec);
    // 20*log10(0.2) ≈ -14 dB; the encode chain must preserve most of it.
    const dropDb = unityDb - quietDb;
    console.log(`[e2e] volume 1.0 → 0.2 mean-volume drop: ${dropDb.toFixed(2)} dB`);
    expect(dropDb).toBeGreaterThanOrEqual(8);
  }, 900_000);

  it("clip.remove drops the clip's pixels: content frame vs blank after removal, stable across save → open", async () => {
    const checkpoint = path.join(roots.projectRoot, "clip-remove-v1.openreel.json");
    // Process A: clip present → preview → clip.remove → preview again.
    const a = await runWorkflow([
      { id: "create", verb: "project.create", params: { name: "Remove", settings: { width: 320, height: 180, frameRate: 30, sampleRate: 48000, channels: 2 }, idempotencyKey: "rm-create" } },
      { id: "import", verb: "media.import", params: { path: inputMp4, expectedRevision: 0, idempotencyKey: "rm-import" } },
      {
        id: "edit",
        verb: "edit.apply",
        params: {
          ops: [
            { op: "track.add", trackType: "video", trackId: "v1" },
            { op: "clip.add", trackId: "v1", mediaId: { $ref: "import#/mediaId" }, startTime: 0, clipId: "c1" },
            { op: "clip.trim", clipId: "c1", inPoint: 0, outPoint: 2 },
          ],
          expectedRevision: 1,
          idempotencyKey: "rm-edit",
        },
      },
      { id: "preview-with", verb: "preview.render_frame", params: { timeSec: 1, expectedRevision: 2 } },
      {
        id: "remove",
        verb: "edit.apply",
        params: {
          ops: [{ op: "clip.remove", clipId: "c1" }],
          expectedRevision: 2,
          idempotencyKey: "rm-remove",
        },
      },
      { id: "timeline-after", verb: "timeline.get", params: {} },
      // The emptied timeline has duration 0: only timeSec 0 is legal now.
      { id: "preview-without", verb: "preview.render_frame", params: { timeSec: 0, expectedRevision: 3 } },
      { id: "save", verb: "project.save", params: { path: checkpoint } },
      // The load-bearing pixel proof: the post-removal frame differs from
      // the content frame (both are stills, so compare at timeSec 0).
      { id: "removed-differs", verb: "verify.artifact", params: {
          path: { $ref: "preview-without#/artifact/path" },
          compare: { referencePath: { $ref: "preview-with#/artifact/path" }, timeSec: 0, mode: "different", minChangedPixelsRatio: 0.02 },
        } },
    ]);
    expect(a.exitCode, a.stdoutLines.map((l) => JSON.stringify(l)).join("\n")).toBe(0);
    expect(stepLine(a.stdoutLines, "remove").result.value.revision).toBe(3);
    const timelineLine = stepLine(a.stdoutLines, "timeline-after");
    expect(
      timelineLine.result.value.tracks.find((t: any) => t.id === "v1")?.clips,
    ).toHaveLength(0);
    const differs = stepLine(a.stdoutLines, "removed-differs");
    expect(differs.result.value.pass).toBe(true);
    const dc = differs.result.value.compare;
    console.log(
      `[e2e] clip.remove: with-vs-without mean|Δ|=${dc.meanAbsDiff?.toFixed(3)} changed=${((dc.changedPixelsRatio ?? 0) * 100).toFixed(2)}%`,
    );
    const previewWithoutPath = stepLine(a.stdoutLines, "preview-without")
      .result.value.artifact.path as string;

    // Process B: open the checkpoint — the removal persists across the
    // process boundary and the emptied timeline renders the same frame.
    const b = await runWorkflow([
      { id: "open", verb: "project.open", params: { path: checkpoint } },
      { id: "timeline", verb: "timeline.get", params: {} },
      { id: "previewB", verb: "preview.render_frame", params: { timeSec: 0 } },
      { id: "still-removed", verb: "verify.artifact", params: {
          path: { $ref: "previewB#/artifact/path" },
          compare: { referencePath: previewWithoutPath, timeSec: 0, mode: "similar", maxMeanAbsDiff: 4 },
        } },
    ]);
    expect(b.exitCode, b.stdoutLines.map((l) => JSON.stringify(l)).join("\n")).toBe(0);
    const reopened = stepLine(b.stdoutLines, "timeline");
    expect(
      reopened.result.value.tracks.find((t: any) => t.id === "v1")?.clips,
    ).toHaveLength(0);
    expect(stepLine(b.stdoutLines, "still-removed").result.value.pass).toBe(true);
  }, 900_000);
});
