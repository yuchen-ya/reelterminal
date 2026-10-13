import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";
import type { PerformanceFixtureManifest } from "../../performance/fixtures";
import { performanceFixtureManifestSha256 } from "../../performance/fixtures";
import { launchApp } from "../launch";
import { ARTIFACTS_DIR, E2E_DIR } from "../paths";
import { createPerformanceResult, type RawPerformanceOperation } from "./result";
import { captureBuildIdentity, readEnvironmentIdentity } from "./identity";
import type { PerformanceRunOptions } from "./driver";
import type { PlaybackAvBrowserResult } from "../../performance/browser/playback-av-harness";
import { validateResultDocument } from "../../../../../scripts/performance/result-contract.mjs";

const CASE_IDS = ["one_x", "two_x", "speed_curve", "segment_seek", "reverse", "reverse_freeze"] as const;
const MAX_FRAME_SAMPLES_PER_CASE = 100;
const PLAYBACK_AV_TIME_BUDGET_MS = 30_000;

type PlaybackAvBrowserGlobal = typeof globalThis & {
  ReelterminalPlaybackAvHarness: {
    runPlaybackAvBrowserScenario(samplesPerCase: number, videoBase64: string, pcmBase64: string): Promise<PlaybackAvBrowserResult>;
  };
  __a01AudioUnlocked?: boolean;
};

interface A01FixtureManifest extends Omit<PerformanceFixtureManifest, "assets" | "parameters"> {
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
  readonly assets: readonly {
    readonly assetId: string;
    readonly kind: "synthetic-video" | "synthetic-pcm";
    readonly mediaType: string;
    readonly encoding: "binary";
    readonly byteLength: number;
    readonly sha256: string;
  }[];
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function createManifest(
  options: PerformanceRunOptions,
  videoBytes: Buffer | null,
  pcmBytes: Buffer | null,
): A01FixtureManifest {
  return {
    schema: "reelterminal.performance-fixture/v1",
    scenarioId: "A01",
    version: 1,
    seed: options.seed,
    parameters: {
      requestedFrameSamplesPerCase: options.samples,
      fixtureRecipeVersion: "a01-time-marked-av-v2",
      videoFixtureMaterialized: videoBytes !== null,
      pcmFixtureMaterialized: pcmBytes !== null,
      videoWidth: 64,
      videoHeight: 64,
      videoFrameRate: 15,
      videoDurationSeconds: 8,
      videoMarkerBinSeconds: 0.2,
      videoMarkerEncoding: "40 unique grayscale bins over the eight-second fixture",
      pcmSampleRate: 48_000,
      pcmChannels: 1,
      pcmEncoding: "float32le",
      pcmDurationSeconds: 8,
      pcmMarkerIntervalSeconds: 0.25,
      pcmMarkerEncoding: "32 unique amplitude bins over 440Hz sine; copied to two identical channels before stereo panning",
      maxPerCaseCaptureMs: 5_000,
    },
    expectedSemantics: [
      "1x and 2x realtime audio scheduling",
      "prepared variable speed curve preserves source PTS markers",
      "mid-clip seek restarts the audio schedule at the mapped source PTS",
      "reverse PCM follows descending source PTS",
      "reverse freeze holds its declared visual source PTS and audio remains unsupported during freeze",
      "output timestamp is an estimate and does not prove audible or native presentation sync",
    ],
    assets: [
      ...(videoBytes ? [{ assetId: "a01-time-coded-video", kind: "synthetic-video" as const, mediaType: "video/mp4", encoding: "binary" as const, byteLength: videoBytes.byteLength, sha256: sha256(videoBytes) }] : []),
      ...(pcmBytes ? [{ assetId: "a01-time-marked-pcm", kind: "synthetic-pcm" as const, mediaType: "audio/pcm; codec=f32le; rate=48000; channels=1", encoding: "binary" as const, byteLength: pcmBytes.byteLength, sha256: sha256(pcmBytes) }] : []),
    ],
    requiredCapabilities: ["AudioContext", "RealtimeAudioGraph", "MasterTimelineClock", "requestAnimationFrame"],
    expectedOperations: CASE_IDS.length,
    timeBudgetMs: PLAYBACK_AV_TIME_BUDGET_MS,
  };
}

function createSyntheticVideo(file: string): void {
  const frameRate = 15;
  const segmentSeconds = 0.2;
  const segmentCount = 40;
  const argumentsList = ["-v", "error"];
  for (let index = 0; index < segmentCount; index++) {
    const gray = 32 + index * 5;
    const hex = gray.toString(16).padStart(2, "0");
    argumentsList.push("-f", "lavfi", "-i", `color=c=0x${hex}${hex}${hex}:s=64x64:r=${frameRate}:d=${segmentSeconds}`);
  }
  const concat = Array.from({ length: segmentCount }, (_, index) => `[${index}:v]`).join("") +
    `concat=n=${segmentCount}:v=1:a=0,format=yuv420p[outv]`;
  argumentsList.push(
    "-filter_complex", concat,
    "-map", "[outv]",
    "-an",
    "-r", String(frameRate),
    "-c:v", "libx264",
    "-crf", "0",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-y", file,
  );
  execFileSync(process.env.REELTERMINAL_FFMPEG_PATH || "ffmpeg", argumentsList, { windowsHide: true, timeout: 15_000 });
}

function createSyntheticPcm(): Buffer {
  const sampleRate = 48_000;
  const frameCount = sampleRate * 8;
  const bytes = Buffer.allocUnsafe(frameCount * Float32Array.BYTES_PER_ELEMENT);
  for (let frame = 0; frame < frameCount; frame++) {
    const sourcePtsSec = frame / sampleRate;
    const bucket = Math.floor((sourcePtsSec + 1e-9) / 0.25);
    const amplitude = 0.08 + bucket * 0.018;
    bytes.writeFloatLE(amplitude * Math.sin(2 * Math.PI * 440 * sourcePtsSec), frame * 4);
  }
  return bytes;
}

function assertPlaybackAvEvidence(evidence: PlaybackAvBrowserResult, requestedSamples: number): void {
  if (evidence.schema !== "reelterminal.performance-playback-av/v1") throw new Error("A01 playback AV evidence schema mismatch");
  if (evidence.durationMs > PLAYBACK_AV_TIME_BUDGET_MS) throw new Error("A01 playback AV measurement exceeded its 30 second budget");
  if (evidence.requestedFrameSamplesPerCase !== requestedSamples) throw new Error("A01 did not consume the requested frame sample count");
  if (evidence.cases.length !== CASE_IDS.length || evidence.cases.some((result, index) => result.id !== CASE_IDS[index])) {
    throw new Error("A01 playback AV case set or order changed");
  }

  for (const result of evidence.cases) {
    if (result.frameSamples !== requestedSamples || !result.frameMarkersVerified) {
      throw new Error(`A01 ${result.id} did not verify every requested synthetic frame sample`);
    }
    if (result.audioSchedulingStatus === "scheduled" && result.pcmToDecodedVideoSourcePts.n === 0) {
      throw new Error(`A01 ${result.id} did not decode a synthetic PCM source PTS marker`);
    }
    if (result.audioSchedulingStatus === "scheduled") {
      const observations = [...result.samples, ...result.seekVerificationSamples];
      const maximumSourceRate = result.playbackRate === "curve" ? 2 : result.playbackRate;
      const pcmResolutionSeconds = 0.125 + 2048 / 48_000 * maximumSourceRate;
      if (!observations.some((sample) => sample.pcmMarkerSourcePtsSec !== null &&
          Math.abs(sample.pcmMarkerSourcePtsSec - sample.expectedSourcePtsAtCommitSec) <= pcmResolutionSeconds)) {
        throw new Error(`A01 ${result.id} decoded PCM did not match the scheduled source position within its marker and analyser resolution`);
      }
    }
  }
  const seek = evidence.cases.find((result) => result.id === "segment_seek")!;
  if (seek.seekMarkerVerified !== true || seek.seekVideoMarkerVerified !== true || seek.seekToPcmMarkerMs === null) {
    throw new Error("A01 mid-clip seek did not commit a matching video frame and PCM marker");
  }
  const reverseFreeze = evidence.cases.find((result) => result.id === "reverse_freeze")!;
  if (reverseFreeze.audioSchedulingStatus !== "unsupported" || reverseFreeze.pcmToDecodedVideoSourcePts.status !== "not_applicable") {
    throw new Error("A01 must keep freeze-frame audio unsupported and unmeasured");
  }
  if (!reverseFreeze.freezeFrameProbes || reverseFreeze.freezeFrameProbes.length !== 3 ||
      reverseFreeze.freezeFrameProbes.some((probe) => !probe.verified)) {
    throw new Error("A01 reverse-freeze semantics were not verified with decoded and committed before/during/after probes");
  }
  if (evidence.reference.actualPresented !== "unsupported" || evidence.reference.actualAudibleSync !== "unsupported") {
    throw new Error("A01 must not claim native presentation or audible synchronization evidence");
  }
  if (evidence.reference.decodedVideoTimestamp !== "source PTS is reconstructed from synthetic video pixel bins; native VideoFrame timestamp is unsupported") {
    throw new Error("A01 video PTS marker evidence is mislabeled");
  }
}

/** Run A01 inside the isolated desktop renderer and write one standard result artifact. */
export async function runPlaybackAvScenario(options: PerformanceRunOptions, repeat: number): Promise<string> {
  if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > MAX_FRAME_SAMPLES_PER_CASE) {
    throw new RangeError(`A01 supports 1 to ${MAX_FRAME_SAMPLES_PER_CASE} requested frame samples per mode`);
  }
  const buildIdentity = await captureBuildIdentity();
  const runId = `a01-${randomUUID()}`;
  if (!buildIdentity.build_verified) {
    const directory = path.join(ARTIFACTS_DIR, "performance");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${runId}.preflight.json`);
    await writeFile(file, JSON.stringify({
      schema: "reelterminal.performance-preflight/v1",
      status: "invalid",
      run_id: runId,
      scenario_id: "A01",
      reason_codes: ["unverified_build"],
      build: buildIdentity,
    }, null, 2));
    throw new Error(`A01 requires a verified production build: ${buildIdentity.build_reason}`);
  }

  let launched: Awaited<ReturnType<typeof launchApp>> | undefined;
  let evidence: PlaybackAvBrowserResult | undefined;
  let environment: Awaited<ReturnType<typeof readEnvironmentIdentity>> | undefined;
  let videoBytes: Buffer | null = null;
  let pcmBytes: Buffer | null = null;
  let manifest: A01FixtureManifest | undefined;
  let fixtureGenerationMs: number | null = null;
  let failureReasonCode: string | null = null;
  let failure: unknown;
  let captureStartedAt: number | null = null;
  try {
    launched = await launchApp();
    await launched.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("A01 desktop window is unavailable");
      window.setContentSize(1280, 800);
      window.show();
      window.focus();
    });
    environment = await readEnvironmentIdentity(launched);
    if (!environment.visible || environment.devtools_open) throw new Error("A01 requires a visible desktop renderer without DevTools");

    const fixtureStartedAt = performance.now();
    const videoPath = path.join(launched.runDir, "a01-time-coded-video.mp4");
    const pcmPath = path.join(launched.runDir, "a01-time-marked-audio.f32le");
    createSyntheticVideo(videoPath);
    videoBytes = await readFile(videoPath);
    pcmBytes = createSyntheticPcm();
    await writeFile(pcmPath, pcmBytes);
    fixtureGenerationMs = performance.now() - fixtureStartedAt;
    manifest = createManifest(options, videoBytes, pcmBytes);

    const bundle = await build({
      entryPoints: [path.join(E2E_DIR, "performance/browser/playback-av-harness.ts")],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "chrome142",
      globalName: "ReelterminalPlaybackAvHarness",
      footer: { js: "globalThis.ReelterminalPlaybackAvHarness = ReelterminalPlaybackAvHarness;" },
      alias: { "@reelterminal/core": path.resolve(E2E_DIR, "../../../packages/core/src") },
    });
    await launched.page.evaluate(bundle.outputFiles[0]!.text);

    await launched.page.evaluate(() => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.testid = "a01-audio-unlock";
      button.textContent = "Start synthetic playback measurement";
      button.style.cssText = "position:fixed;top:8px;left:8px;z-index:2147483647";
      button.addEventListener("click", async () => {
        const context = new AudioContext();
        await context.resume();
        (globalThis as PlaybackAvBrowserGlobal).__a01AudioUnlocked = context.state === "running";
        await context.close();
        button.remove();
      }, { once: true });
      document.body.append(button);
    });
    await launched.page.getByTestId("a01-audio-unlock").click();
    await launched.page.waitForFunction(() => (globalThis as PlaybackAvBrowserGlobal).__a01AudioUnlocked === true, undefined, { timeout: 5_000 });
    const videoBase64 = videoBytes.toString("base64");
    const pcmBase64 = pcmBytes.toString("base64");
    captureStartedAt = performance.now();
    const browserEvidence = launched.page.evaluate(({ samplesPerCase, videoBase64, pcmBase64 }) =>
      (globalThis as PlaybackAvBrowserGlobal).ReelterminalPlaybackAvHarness.runPlaybackAvBrowserScenario(
        samplesPerCase,
        videoBase64,
        pcmBase64,
      ), { samplesPerCase: options.samples, videoBase64, pcmBase64 });
    let timeoutId: NodeJS.Timeout | undefined;
    try {
      evidence = await Promise.race([
        browserEvidence,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            const error = new Error("A01 browser playback measurement exceeded its hard timeout");
            error.name = "TimeoutError";
            reject(error);
          }, Math.max(35_000, options.operationTimeoutMs));
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    const observedEvidence = evidence;
    if (!observedEvidence) throw new Error("A01 browser playback evidence was not returned");
    assertPlaybackAvEvidence(observedEvidence, options.samples);
  } catch (error) {
    failure = error;
    failureReasonCode = error instanceof RangeError ? "request_out_of_budget" : error instanceof Error && error.name === "TimeoutError" ? "scenario_timeout" : "scenario_failed";
    console.warn("A01 playback AV scenario failed", failureReasonCode);
  } finally {
    try { await launched?.close({ keepRunDir: failureReasonCode !== null }); }
    catch (error) { failure ??= error; failureReasonCode ??= "process_cleanup_failed"; }
  }

  if (!environment) {
    const directory = path.join(ARTIFACTS_DIR, "performance");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${runId}.preflight.json`);
    await writeFile(file, JSON.stringify({
      schema: "reelterminal.performance-preflight/v1",
      status: "invalid",
      run_id: runId,
      scenario_id: "A01",
      reason_codes: [failureReasonCode ?? "environment_unavailable"],
      build: buildIdentity,
      fixture_manifest: createManifest(options, videoBytes, pcmBytes),
    }, null, 2));
    throw new Error(`A01 preflight failed (${failureReasonCode ?? "environment_unavailable"}); evidence: ${file}`);
  }
  manifest ??= createManifest(options, videoBytes, pcmBytes);
  if (!evidence) failureReasonCode ??= "playback_evidence_unavailable";
  const operations: RawPerformanceOperation[] = (evidence?.cases ?? []).map((result) => {
    const id = result.id;
    const targetVerified = Boolean(result && result.frameMarkersVerified &&
      (result.audioSchedulingStatus === "unsupported" || result.pcmToDecodedVideoSourcePts.n > 0) &&
      (result.seekMarkerVerified !== false) && (result.seekVideoMarkerVerified !== false));
    const operationSucceeded = failureReasonCode === null && targetVerified;
    return {
      operation_id: `${id}-${repeat + 1}`,
      metric: `playback_av_${id}_elapsed_ms`,
      outcome: operationSucceeded ? "ok" as const : "failed" as const,
      duration_ms: result ? result.elapsedMs : null,
      target_verified: operationSucceeded,
    };
  });
  if (!evidence && captureStartedAt !== null) {
    operations.push({
      operation_id: "playback-capture",
      metric: "playback_av_capture_failed_ms",
      outcome: failureReasonCode === "scenario_timeout" ? "timeout" : "failed",
      duration_ms: null,
      waited_ms: performance.now() - captureStartedAt,
      target_verified: false,
    });
  }
  const fixtureManifestSha256 = performanceFixtureManifestSha256(manifest as unknown as PerformanceFixtureManifest);
  const result = createPerformanceResult({
    run: {
      run_id: runId,
      scenario_id: "A01",
      scenario_version: manifest.version,
      seed: manifest.seed,
      fixture_manifest: manifest,
      fixture_manifest_sha256: fixtureManifestSha256,
      expected_operations: operations.length,
      mode: "light",
      cache_state: "warm_synthetic_audio_playback",
      sampling: { input_every_n: 1, frame_every_n: 1 },
      budgets: {
        capture_seconds: options.operationTimeoutMs / 1000,
        events_capacity: 16_384,
        run_seconds: options.runTimeoutSeconds,
      },
      warmup: "audio_context_resumed_and_speed_curve_prepared_before_each_sample_window",
      repeat,
      cold_launch_index: 0,
      physical_disk_cold: "not_measured",
      measurement_boundary: "production_video_engine_decode_and_frame_scheduler_commit_with_master_clock_and_realtime_audio_graph",
      frame_evidence: "time-coded synthetic video decoded by VideoEngine and painted through shared commitRenderedFrame to a harness-owned canvas",
      decoded_video_pts: "synthetic pixel marker, 200ms bins; native VideoFrame timestamp unsupported",
      pcm_pts: "synthetic float32 PCM marker, 250ms bins",
      actual_presented: "unsupported",
      actual_audible_sync: "unsupported",
    },
    build: { ...buildIdentity },
    environment: { ...environment },
    samples: operations,
    correctness: {
      frame_markers_verified: Boolean(evidence?.cases.every((entry) => entry.frameMarkersVerified)),
      scheduled_audio_pcm_markers_verified: Boolean(evidence?.cases.filter((entry) => entry.audioSchedulingStatus === "scheduled")
        .every((entry) => entry.pcmToDecodedVideoSourcePts.n > 0)),
      segment_seek_pcm_marker_verified: evidence?.cases.find((entry) => entry.id === "segment_seek")?.seekMarkerVerified === true &&
        evidence.cases.find((entry) => entry.id === "segment_seek")?.seekVideoMarkerVerified === true,
      reverse_freeze_visual_mapping_verified: evidence?.cases.find((entry) => entry.id === "reverse_freeze")?.frameMarkersVerified === true,
    },
    structural: {
      requested_frame_samples_per_case: options.samples,
      observed_frame_samples: evidence?.cases.reduce((sum, entry) => sum + entry.frameSamples, 0) ?? 0,
      decoded_video_marker_samples: evidence?.cases.reduce((sum, entry) => sum + entry.decodedVideoMarkerSamples, 0) ?? 0,
      frame_commits: evidence?.cases.reduce((sum, entry) => sum + entry.frameCommits, 0) ?? 0,
      decoded_pcm_marker_samples: evidence?.cases.reduce((sum, entry) => sum + entry.pcmToDecodedVideoSourcePts.n, 0) ?? 0,
      output_timestamp_estimate_samples: evidence?.cases.reduce((sum, entry) => sum + entry.outputTimestampToDecodedVideoSourcePts.n, 0) ?? 0,
    },
    validity: {
      complete: failureReasonCode === null,
      reason_codes: failureReasonCode ? [failureReasonCode] : [],
      probe_calibrated: false,
    },
    forceInvalid: failureReasonCode !== null,
  });
  const artifactDocument = {
    ...result,
    playback_av: {
      ...(evidence ?? {
        schema: "reelterminal.performance-playback-av/v1",
        durationMs: null,
        requestedFrameSamplesPerCase: options.samples,
        outputTimestampApiStatus: "unsupported",
        cases: [],
      }),
      fixture_generation_ms: fixtureGenerationMs,
      fixture_assets_materialized: manifest.assets.map((asset) => ({ assetId: asset.assetId, byteLength: asset.byteLength, sha256: asset.sha256 })),
      failure_reason_code: failureReasonCode,
      sample_semantics: "requested_frame_samples_per_case counts sequential production frame render/commit observations per mode. Bounded seek-verification observations and reverse-freeze before/during/after decode probes are separately retained; AV paired error distributions include seek-verification pairs. Frame samples are not independent play/seek operations and do not contribute standard operation P95/P99.",
      marker_quantization_uncertainty_ms: { video_bin: 200, video_half_bin: 100, pcm_bin: 250, pcm_half_bin: 125, combined_half_bin: 225 },
      analyser_window_ms: 2048 / 48_000 * 1000,
      uncertainty_basis: "bin quantization only; analyser window and scheduler/decode latency are separate",
      output_timestamp_boundary: "AudioContext device-clock estimate; synthetic PCM is observed at the graph analyser and not sent to the speaker",
      native_video_frame_timestamp: "unsupported; source PTS is reconstructed from the time-coded synthetic video marker",
      operation_elapsed_boundary: "one full per-mode window including video decode/commit, audio preparation, playback, optional seek, and verified marker pairs",
    },
  };

  const directory = path.join(ARTIFACTS_DIR, "performance");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${runId}.result.json`);
  await writeFile(file, JSON.stringify(artifactDocument, null, 2));
  console.info("PERFORMANCE_RESULT", file);
  const validation = validateResultDocument(artifactDocument);
  if (!validation.valid) throw new Error(`A01 performance result invalid (${validation.errors.length} contract error(s)); artifact: ${file}`);
  if (failureReasonCode) throw new Error(`A01 playback AV run failed (${failureReasonCode}); artifact: ${file}`, { cause: failure });
  return file;
}
