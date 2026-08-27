/**
 * Slice-1b reference scenario (public example):
 *
 *   project.create(320x180@30) → import input.mp4 → clip 0–5 s
 *   → "Hello world" 0–5 s → Chromium PNG at 2.5 s → export output.mp4
 *   → ffprobe + frame/pixel verification.
 *
 * Usage (see README): bundle with esbuild, then
 *   node hello-world-e2e.mjs --input /abs/input.mp4 \
 *     --media-root /abs/media --artifact-root /abs/artifacts
 *
 * --input must live under --media-root. Everything is written under
 * --artifact-root. Exits non-zero when any step or check fails.
 */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createAgentFacade } from "@openreel/agent-facade";
import {
  createChromiumProviders,
  FfmpegArtifactVerifier,
} from "@openreel/runtime-chromium";

interface Args {
  input: string;
  mediaRoot: string;
  artifactRoot: string;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key?.startsWith("--")) {
      out[key.slice(2)] = argv[i + 1] ?? "";
      i += 1;
    }
  }
  if (!out.input || !out["media-root"] || !out["artifact-root"]) {
    console.error(
      "usage: node hello-world-e2e.mjs --input <mp4> --media-root <dir> --artifact-root <dir>",
    );
    process.exit(2);
  }
  return {
    input: path.resolve(out.input),
    mediaRoot: path.resolve(out["media-root"]),
    artifactRoot: path.resolve(out["artifact-root"]),
  };
}

function must<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }, step: string): T {
  if (!result.ok) {
    throw new Error(`${step} failed [${result.error.code}]: ${result.error.message}`);
  }
  return result.value;
}

async function waitForJob(
  facade: ReturnType<typeof createAgentFacade>,
  jobId: string,
  timeoutMs = 600_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = must(await facade["job.status"]({ jobId }), "job.status");
    if (status.state === "done" || status.state === "error" || status.state === "cancelled") {
      return status;
    }
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle in time`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.artifactRoot, { recursive: true });

  // The scenario's input.mp4: copy the source into the media root.
  const inputPath = path.join(args.mediaRoot, "input.mp4");
  await copyFile(args.input, inputPath);

  const providers = createChromiumProviders();
  const facade = createAgentFacade({
    mediaRoots: [args.mediaRoot],
    artifactRoot: args.artifactRoot,
    renderProvider: providers.renderProvider,
    exportProvider: providers.exportProvider,
    artifactVerifier: new FfmpegArtifactVerifier(),
  });

  try {
    const caps = must(await facade["capabilities.get"](), "capabilities.get");
    console.log(
      `[scenario] preview=${caps.preview.available} export=${caps.export.available} verify=${caps.verify.available}`,
    );
    if (!caps.preview.available || !caps.export.available || !caps.verify.available) {
      throw new Error(
        `runtime unavailable: preview=${caps.preview.reason ?? "ok"} export=${caps.export.reason ?? "ok"} verify=${caps.verify.reason ?? "ok"}`,
      );
    }

    must(
      await facade["project.create"]({
        name: "Hello world scenario",
        settings: { width: 320, height: 180, frameRate: 30, sampleRate: 48000, channels: 2 },
      }),
      "project.create",
    );
    const imported = must(
      await facade["media.import"]({ path: inputPath, name: "input.mp4", expectedRevision: 0 }),
      "media.import",
    );
    console.log(
      `[scenario] imported ${imported.name}: ${imported.metadata.width}x${imported.metadata.height} ${imported.metadata.durationSec.toFixed(2)}s ${imported.metadata.codec}`,
    );
    if (imported.metadata.durationSec < 5) {
      throw new Error(`input is too short (${imported.metadata.durationSec}s < 5s)`);
    }

    must(
      await facade["edit.apply"]({
        ops: [
          { op: "track.add", trackType: "video", trackId: "v1" },
          { op: "clip.add", trackId: "v1", mediaId: imported.mediaId, startTime: 0, clipId: "c1" },
          { op: "clip.trim", clipId: "c1", inPoint: 0, outPoint: 5 },
          { op: "track.add", trackType: "text", trackId: "t1" },
          { op: "text.create", trackId: "t1", text: "Hello world", startTime: 0, duration: 5 },
        ],
        expectedRevision: 1,
        idempotencyKey: "scenario-edit-1",
      }),
      "edit.apply",
    );

    const timeline = must(await facade["timeline.get"](), "timeline.get");
    if (timeline.textOverlays[0]?.text !== "Hello world") {
      throw new Error("model state does not contain exactly 'Hello world'");
    }

    const preview = must(
      await facade["preview.render_frame"]({ timeSec: 2.5, expectedRevision: 2 }),
      "preview.render_frame",
    );
    console.log(
      `[scenario] preview PNG @2.5s: ${preview.artifact.path} (${preview.artifact.sizeBytes} bytes, sha256=${preview.artifact.sha256})`,
    );

    const started = must(
      await facade["export.start"]({ idempotencyKey: "scenario-export-1" }),
      "export.start",
    );
    console.log(`[scenario] export started: jobId=${started.jobId} sourceRevision=${started.sourceRevision}`);
    const final = await waitForJob(facade, started.jobId);
    if (final.state !== "done" || !final.artifact) {
      throw new Error(`export job ended as ${final.state}: ${final.error?.message ?? "no artifact"}`);
    }
    console.log(
      `[scenario] exported MP4 via ${final.route}: ${final.artifact.path} (${final.artifact.sizeBytes} bytes, sha256=${final.artifact.sha256})`,
    );

    const verified = must(
      await facade["verify.artifact"]({
        path: final.artifact.path,
        expect: { container: "mp4", videoCodec: "h264", width: 320, height: 180, durationSec: 5, durationToleranceSec: 0.12 },
      }),
      "verify.artifact(probe)",
    );
    console.log(
      `[scenario] ffprobe: container=${verified.probe.container} vcodec=${verified.probe.videoCodec} ` +
        `${verified.probe.width}x${verified.probe.height} dur=${verified.probe.durationSec.toFixed(3)}s frames=${verified.probe.frameCount}`,
    );
    if (!verified.pass) {
      throw new Error(`probe checks failed: ${verified.checks.filter((c) => !c.pass).map((c) => `${c.name}=${c.details}`).join("; ")}`);
    }

    const similar = must(
      await facade["verify.artifact"]({
        path: final.artifact.path,
        compare: { referencePath: preview.artifact.path, timeSec: 2.5, mode: "similar", maxMeanAbsDiff: 14 },
      }),
      "verify.artifact(similar)",
    );
    console.log(
      `[scenario] preview-vs-export @2.5s: mean|Δ|=${similar.compare?.meanAbsDiff.toFixed(3)} pass=${similar.compare?.pass}`,
    );
    if (!similar.compare?.pass) throw new Error("exported frame does not match preview");

    const different = must(
      await facade["verify.artifact"]({
        path: final.artifact.path,
        compare: {
          referencePath: inputPath,
          timeSec: 2.5,
          referenceTimeSec: 2.5,
          region: { x: 0.15, y: 0.3, width: 0.7, height: 0.4 },
          mode: "different",
          minChangedPixelsRatio: 0.02,
        },
      }),
      "verify.artifact(different)",
    );
    console.log(
      `[scenario] export-vs-input @2.5s (text region): mean|Δ|=${different.compare?.meanAbsDiff.toFixed(3)} ` +
        `changed=${((different.compare?.changedPixelsRatio ?? 0) * 100).toFixed(2)}% pass=${different.compare?.pass}`,
    );
    if (!different.compare?.pass) throw new Error("text overlay is not visible in the export");

    console.log("[scenario] PASS — output:", final.artifact.path);
  } finally {
    await providers.close();
  }
}

main().catch((error) => {
  console.error(`[scenario] FAIL: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
