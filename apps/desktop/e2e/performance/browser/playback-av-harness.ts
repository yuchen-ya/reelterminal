import type { Clip, FreezeFrame, SpeedKeyframe } from "@reelterminal/core/types/timeline";
import type { Project } from "@reelterminal/core/types/project";
import { RealtimeAudioGraph, type AudioClipSchedule } from "@reelterminal/core/audio/realtime-audio-graph";
import { MasterTimelineClock } from "@reelterminal/core/playback/master-timeline-clock";
import { VideoEngine } from "@reelterminal/core/video/video-engine";
import { getSpeedEngine } from "@reelterminal/core/video/speed-engine";
import { getMediaEngine } from "@reelterminal/core/media/mediabunny-engine";
import { FrameRenderScheduler, type FrameRequestToken } from "../../../../web/src/components/editor/preview/frame-scheduler";
import { commitRenderedFrame, type FrameCommitResult } from "../../../../web/src/components/editor/preview/frame-commit";
import {
  decodePcmMarkerSourcePts,
  decodeVideoMarkerSourcePts,
  estimateOutputTimestampMasterPts,
  summarizePlaybackAvErrors,
  VIDEO_MARKER_INTERVAL_SECONDS,
  type AudioOutputTimestampSample,
  type OutputTimestampEstimate,
} from "../../harness/performance/playback-av-metrics";

const SAMPLE_RATE = 48_000;
const VIDEO_WIDTH = 64;
const VIDEO_HEIGHT = 64;
const SOURCE_IN_POINT = 2;
const SOURCE_OUT_POINT = 6;
const CLIP_START_TIME = 1;
const WARMUP_MS = 100;
const MAX_CASE_CAPTURE_MS = 5_000;
const PCM_FFT_SIZE = 2048;
const MAX_ELAPSED_MS = 30_000;

type PlaybackAvCaseId = "one_x" | "two_x" | "speed_curve" | "segment_seek" | "reverse" | "reverse_freeze";

interface PlaybackAvSample {
  readonly performanceTimeMs: number;
  readonly requestedMasterPtsSec: number;
  readonly committedMasterPtsSec: number;
  readonly expectedSourcePtsAtCommitSec: number;
  readonly decodedVideoSourcePtsSec: number | null;
  readonly frameMarkerVerified: boolean;
  readonly frameCommitStatus: FrameCommitResult;
  readonly frameRenderMs: number;
  readonly pcmMarkerSourcePtsSec: number | null;
  readonly pcmToDecodedVideoErrorMs: number | null;
  readonly decodedVideoToMasterSourceErrorMs: number | null;
  readonly outputTimestampStatus: OutputTimestampEstimate["status"] | "not_applicable";
  readonly outputTimestampReason?: OutputTimestampEstimate["reason"];
  readonly outputMasterPtsSec: number | null;
  readonly outputSourcePtsSec: number | null;
  readonly outputToDecodedVideoErrorMs: number | null;
}

interface PlaybackAvCaseResult {
  readonly id: PlaybackAvCaseId;
  readonly elapsedMs: number;
  readonly audioPreparationMs: number | null;
  readonly videoPreparationMs: number;
  readonly audioSchedulingStatus: "scheduled" | "unsupported";
  readonly audioSchedulingReason: "freeze_audio_undefined" | null;
  readonly audioContextState: AudioContextState;
  readonly baseLatencySeconds: number | null;
  readonly outputLatencySeconds: number | null;
  readonly playbackRate: number | "curve";
  readonly frameSamples: number;
  readonly decodedVideoMarkerSamples: number;
  readonly frameCommits: number;
  readonly frameMarkersVerified: boolean;
  readonly decodedVideoToMasterSourcePts: ReturnType<typeof summarizePlaybackAvErrors>;
  readonly pcmToDecodedVideoSourcePts: ReturnType<typeof summarizePlaybackAvErrors>;
  readonly outputTimestampToDecodedVideoSourcePts: ReturnType<typeof summarizePlaybackAvErrors>;
  readonly outputTimestampApiStatus: "available" | "unsupported" | "not_applicable";
  readonly seekToPcmMarkerMs: number | null;
  readonly seekMarkerVerified: boolean | null;
  readonly seekVideoMarkerVerified: boolean | null;
  readonly seekVerificationSamples: readonly PlaybackAvSample[];
  readonly freezeSourcePts: {
    readonly before: number;
    readonly during: number;
    readonly after: number;
  } | null;
  readonly freezeFrameProbes: readonly FreezeFrameProbe[] | null;
  readonly samples: readonly PlaybackAvSample[];
}

export interface PlaybackAvBrowserResult {
  readonly schema: "reelterminal.performance-playback-av/v1";
  readonly durationMs: number;
  readonly requestedFrameSamplesPerCase: number;
  readonly reference: {
    readonly masterPts: "MasterTimelineClock.currentTime (seconds)";
    readonly sourcePts: "clip inPoint + SpeedEngine playback-time mapping (seconds)";
    readonly audioSchedule: "RealtimeAudioGraph and synthetic time-marked PCM";
    readonly videoFrame: "VideoEngine decoded time-coded MP4 frame; shared commit helpers painted the bitmap to a harness-owned canvas";
    readonly decodedVideoTimestamp: "source PTS is reconstructed from synthetic video pixel bins; native VideoFrame timestamp is unsupported";
    readonly markerQuantization: {
      readonly videoBinMs: number;
      readonly videoHalfBinUncertaintyMs: number;
      readonly pcmBinMs: number;
      readonly pcmHalfBinUncertaintyMs: number;
      readonly combinedHalfBinUncertaintyMs: number;
    };
    readonly outputTimestamp: "AudioContext.getOutputTimestamp mapped back to master and source PTS; estimate only";
    readonly actualPresented: "unsupported";
    readonly actualAudibleSync: "unsupported";
  };
  readonly outputTimestampApiStatus: "available" | "unsupported";
  readonly cases: readonly PlaybackAvCaseResult[];
}

interface CaseOptions {
  readonly id: PlaybackAvCaseId;
  readonly playbackRate: number | "curve";
  readonly reversed?: boolean;
  readonly freezeFrames?: FreezeFrame[];
  readonly seekAfterMs?: number;
  readonly seekToClipOffset?: number;
}

function createClip(options: CaseOptions): Clip {
  const speedKeyframes: SpeedKeyframe[] | undefined = options.playbackRate === "curve"
    ? [
      { id: "curve-start", time: 0, speed: 1, easing: "linear" },
      { id: "curve-end", time: SOURCE_OUT_POINT - SOURCE_IN_POINT, speed: 2, easing: "linear" },
    ]
    : undefined;
  return {
    id: options.id,
    trackId: "synthetic-track",
    mediaId: "synthetic-audio",
    startTime: CLIP_START_TIME,
    inPoint: SOURCE_IN_POINT,
    outPoint: SOURCE_OUT_POINT,
    duration: SOURCE_OUT_POINT - SOURCE_IN_POINT,
    speed: options.playbackRate === "curve" ? 1 : options.playbackRate,
    reversed: options.reversed ?? false,
    speedKeyframes,
    freezeFrames: options.freezeFrames,
    pitchCorrection: false,
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    volume: 1,
    effects: [],
    keyframes: [],
  } as Clip;
}

function createTimeMarkedPcm(context: AudioContext, pcmBase64: string): AudioBuffer {
  const binary = atob(pcmBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) throw new Error("A01 PCM asset is not float32 aligned");
  const frameCount = bytes.byteLength / Float32Array.BYTES_PER_ELEMENT;
  const buffer = context.createBuffer(2, frameCount, context.sampleRate);
  const channel = buffer.getChannelData(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let frame = 0; frame < frameCount; frame++) channel[frame] = view.getFloat32(frame * 4, true);
  buffer.copyToChannel(channel, 1);
  return buffer;
}

function createSchedule(clip: Clip, audioBuffer: AudioBuffer, duration: number): AudioClipSchedule {
  return {
    clipId: clip.id,
    trackId: clip.trackId,
    audioBuffer,
    startTime: CLIP_START_TIME,
    endTime: CLIP_START_TIME + duration,
    mediaOffset: SOURCE_IN_POINT,
    mediaEnd: SOURCE_OUT_POINT,
    reversed: clip.reversed,
    speedKeyframes: clip.speedKeyframes,
    freezeFrames: clip.freezeFrames,
    pitchCorrection: false,
    speed: clip.speed ?? 1,
    volume: 1,
    volumeAutomation: [],
    pan: 0,
    effects: [],
  };
}

function createProject(clip: Clip, videoBlob: Blob, duration: number): Project {
  return {
    id: "a01-synthetic-project",
    name: "A01 synthetic playback",
    createdAt: 1,
    modifiedAt: 1,
    settings: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT, frameRate: 15, sampleRate: SAMPLE_RATE, channels: 2 },
    mediaLibrary: {
      items: [{
        id: clip.mediaId,
        name: "a01-time-marked-video.mp4",
        type: "video",
        fileHandle: null,
        blob: videoBlob,
        metadata: {
          duration: 8,
          width: VIDEO_WIDTH,
          height: VIDEO_HEIGHT,
          frameRate: 15,
          codec: "h264",
          sampleRate: 0,
          channels: 0,
          fileSize: videoBlob.size,
        },
        thumbnailUrl: null,
        waveformData: null,
      }],
    },
    timeline: {
      tracks: [{
        id: clip.trackId,
        type: "video",
        name: "Synthetic video",
        clips: [clip],
        transitions: [],
        locked: false,
        hidden: false,
        muted: false,
        solo: false,
      }],
      subtitles: [],
      duration: CLIP_START_TIME + duration + 1,
      markers: [],
    },
  };
}

function sourcePtsAtMasterPts(engine: ReturnType<typeof getSpeedEngine>, clipId: string, masterPtsSec: number): number {
  const clipOffset = Math.max(0, masterPtsSec - CLIP_START_TIME);
  return SOURCE_IN_POINT + engine.getSourceTimeAtPlaybackTime(clipId, clipOffset);
}

function outputTimestampEstimate(context: AudioContext, nowMs: number, anchor: {
  contextTimeSec: number;
  masterPtsSec: number;
  masterRate: number;
}): OutputTimestampEstimate {
  const outputClock = context as AudioContext & {
    getOutputTimestamp?: () => AudioOutputTimestampSample;
  };
  if (typeof outputClock.getOutputTimestamp !== "function") {
    return estimateOutputTimestampMasterPts(null, nowMs, anchor);
  }
  try {
    return estimateOutputTimestampMasterPts(outputClock.getOutputTimestamp(), nowMs, anchor);
  } catch {
    return estimateOutputTimestampMasterPts({ contextTime: Number.NaN, performanceTime: Number.NaN }, nowMs, anchor);
  }
}

function sampleRms(analyser: AnalyserNode, data: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(data);
  let squareSum = 0;
  for (const value of data) squareSum += value * value;
  return Math.sqrt(squareSum / data.length);
}

function createFreezeFrame(): FreezeFrame {
  return { id: "synthetic-freeze", clipId: "reverse_freeze", startTime: 0.3, sourceTime: 1.5, duration: 0.3 };
}

interface VideoFrameEvidence {
  readonly requestedMasterPtsSec: number;
  readonly committedMasterPtsSec: number;
  readonly decodedVideoSourcePtsSec: number | null;
  readonly expectedSourcePtsAtCommitSec: number;
  readonly performanceTimeMs: number;
  readonly renderMs: number;
  readonly commitStatus: FrameCommitResult;
}

interface FreezeFrameProbe {
  readonly phase: "before" | "during" | "after";
  readonly requestedMasterPtsSec: number;
  readonly expectedSourcePtsSec: number;
  readonly decodedVideoSourcePtsSec: number | null;
  readonly commitStatus: FrameCommitResult;
  readonly verified: boolean;
}

function nextAnimationFrame(page: Window): Promise<void> {
  return new Promise((resolve) => page.requestAnimationFrame(() => resolve()));
}

async function runCase(
  options: CaseOptions,
  requestedSamplesPerCase: number,
  videoBlob: Blob,
  pcmBase64: string,
  page: Window,
): Promise<PlaybackAvCaseResult> {
  const measurementStartedAt = performance.now();
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const clock = new MasterTimelineClock({ audioContext: context, frameRate: 30 });
  const graph = new RealtimeAudioGraph(clock);
  const canvas = page.document.createElement("canvas");
  canvas.width = VIDEO_WIDTH;
  canvas.height = VIDEO_HEIGHT;
  canvas.setAttribute("data-testid", `playback-av-${options.id}`);
  canvas.style.cssText = "position:fixed;right:8px;bottom:8px;width:192px;height:192px;z-index:2147483647;background:#101010";
  page.document.body.append(canvas);
  const canvasContext = canvas.getContext("2d");
  if (!canvasContext) throw new Error("A01 frame commit canvas is unavailable");

  const baseClip = createClip(options);
  const speedEngine = getSpeedEngine();
  speedEngine.loadClips([baseClip]);
  const effectiveDuration = speedEngine.getEffectiveDuration(baseClip.id);
  const clip = { ...baseClip, duration: effectiveDuration };
  speedEngine.loadClips([clip]);
  const freezeSourcePts = options.freezeFrames?.length ? {
    before: sourcePtsAtMasterPts(speedEngine, clip.id, CLIP_START_TIME + 0.2),
    during: sourcePtsAtMasterPts(speedEngine, clip.id, CLIP_START_TIME + 0.45),
    after: sourcePtsAtMasterPts(speedEngine, clip.id, CLIP_START_TIME + 0.65),
  } : null;

  const videoEngine = new VideoEngine();
  videoEngine.setParallelDecoding(false);
  const mediaEngine = getMediaEngine();
  let frameScheduler: FrameRenderScheduler | null = null;
  const lastGoodFrame = { current: null as ImageBitmap | null };
  let resolvePendingFrame: ((evidence: VideoFrameEvidence) => void) | null = null;
  let rejectPendingFrame: ((error: Error) => void) | null = null;
  let analyser: AnalyserNode | null = null;
  let pcmData: Float32Array<ArrayBuffer> | null = null;
  let schedule: AudioClipSchedule | null = null;
  let audioPreparationMs: number | null = null;
  let videoPreparationMs: number | null = null;
  let outputTimestampApiAvailable = false;
  let timestampAnchor = { contextTimeSec: 0, masterPtsSec: 0, masterRate: 1 };
  const samples: PlaybackAvSample[] = [];
  const videoErrors: number[] = [];
  const pcmErrors: number[] = [];
  const outputTimestampErrors: number[] = [];
  let seekRequestedAtMs: number | null = null;
  let seekToPcmMarkerMs: number | null = null;
  const seekVerification = {
    pcmMarkerVerified: options.seekAfterMs === undefined ? null as boolean | null : false,
    videoMarkerVerified: options.seekAfterMs === undefined ? null as boolean | null : false,
  };

  try {
    clock.setDuration(20);
    clock.seek(CLIP_START_TIME);
    const project = createProject(clip, videoBlob, effectiveDuration);

    const videoPreparationStartedAt = performance.now();
    await videoEngine.initialize();
    if (!mediaEngine.isAvailable()) await mediaEngine.initialize();
    const decoder = await mediaEngine.createExportDecoder(clip.mediaId, videoBlob, VIDEO_WIDTH);
    if (!decoder) throw new Error("A01 production video decoder cannot initialize the synthetic MP4");
    videoPreparationMs = performance.now() - videoPreparationStartedAt;

    if (!options.freezeFrames?.length) {
      const buffer = createTimeMarkedPcm(context, pcmBase64);
      schedule = createSchedule(clip, buffer, effectiveDuration);
      const preparationStartedAt = performance.now();
      await graph.prepareClip(schedule);
      audioPreparationMs = performance.now() - preparationStartedAt;
      const outputBranch = context.createMediaStreamDestination();
      graph.getMasterGain().disconnect(context.destination);
      graph.getMasterGain().connect(outputBranch);
      analyser = context.createAnalyser();
      analyser.fftSize = PCM_FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      graph.getMasterGain().connect(analyser);
      pcmData = new Float32Array(new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT));
    }

    frameScheduler = new FrameRenderScheduler(async (token: FrameRequestToken) => {
      const renderStartedAt = performance.now();
      let rendered: Awaited<ReturnType<VideoEngine["renderFrame"]>> | null = null;
      try {
        rendered = await videoEngine.renderFrame(project, token.time, VIDEO_WIDTH, VIDEO_HEIGHT, { realtime: true });
        const result = await commitRenderedFrame(
          {
            isCurrent: () => frameScheduler!.isCurrent(token),
            claimCommit: () => frameScheduler!.markCommitted(token),
            lastGood: lastGoodFrame,
          },
          {
            produce: () => createImageBitmap(rendered!.image),
            paint: (committedFrame) => {
              canvasContext.clearRect(0, 0, canvas.width, canvas.height);
              canvasContext.drawImage(committedFrame, 0, 0, canvas.width, canvas.height);
            },
          },
        );
        const performanceTimeMs = performance.now();
        const committedMasterPtsSec = clock.currentTime;
        const expectedSourcePtsAtCommitSec = sourcePtsAtMasterPts(speedEngine, clip.id, committedMasterPtsSec);
        const pixel = canvasContext.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
        const gray = (pixel[0]! + pixel[1]! + pixel[2]!) / 3;
        const decodedVideoSourcePtsSec = result === "committed"
          ? decodeVideoMarkerSourcePts(gray)
          : null;
        resolvePendingFrame?.({
          requestedMasterPtsSec: rendered.timestamp,
          committedMasterPtsSec,
          decodedVideoSourcePtsSec,
          expectedSourcePtsAtCommitSec,
          performanceTimeMs,
          renderMs: performanceTimeMs - renderStartedAt,
          commitStatus: result,
        });
      } catch {
        rejectPendingFrame?.(new Error("A01 VideoEngine frame decode or commit failed"));
      } finally {
        rendered?.image.close();
        resolvePendingFrame = null;
        rejectPendingFrame = null;
      }
    });

    const renderOneFrame = async (masterPtsSec: number): Promise<VideoFrameEvidence> => new Promise((resolve, reject) => {
      const timer = page.setTimeout(() => {
        frameScheduler?.invalidate();
        resolvePendingFrame = null;
        rejectPendingFrame = null;
        reject(new Error("A01 VideoEngine frame commit timed out"));
      }, MAX_CASE_CAPTURE_MS);
      resolvePendingFrame = (evidence) => { page.clearTimeout(timer); resolve(evidence); };
      rejectPendingFrame = (error) => { page.clearTimeout(timer); reject(error); };
      frameScheduler!.request(masterPtsSec, 1);
    });

    await clock.play();
    if (schedule) {
      graph.startScheduler((time) => schedule &&
        schedule.startTime <= time + 0.2 && schedule.endTime > time ? [schedule] : []);
    }
    timestampAnchor = {
      contextTimeSec: context.currentTime,
      masterPtsSec: clock.currentTime,
      masterRate: clock.rate,
    };
    const startedAt = performance.now();
    let didSeek = false;

    const takeSample = async (): Promise<PlaybackAvSample> => {
      await nextAnimationFrame(page);
      const requestedMasterPtsSec = clock.currentTime;
      const frame = await renderOneFrame(requestedMasterPtsSec);
      const frameMarkerVerified = frame.commitStatus === "committed" && frame.decodedVideoSourcePtsSec !== null &&
        Math.abs(frame.decodedVideoSourcePtsSec - sourcePtsAtMasterPts(speedEngine, clip.id, frame.requestedMasterPtsSec)) <= VIDEO_MARKER_INTERVAL_SECONDS * 1.25;
      if (options.seekAfterMs !== undefined && didSeek) seekVerification.videoMarkerVerified = frameMarkerVerified;
      let pcmMarkerSourcePtsSec: number | null = null;
      let pcmToDecodedVideoErrorMs: number | null = null;
      let outputStatus: OutputTimestampEstimate["status"] | "not_applicable" = schedule ? "unsupported" : "not_applicable";
      let outputReason: OutputTimestampEstimate["reason"];
      let outputMasterPtsSec: number | null = null;
      let outputSourcePtsSec: number | null = null;
      let outputToDecodedVideoErrorMs: number | null = null;
      let decodedVideoToMasterSourceErrorMs: number | null = null;

      if (frame.decodedVideoSourcePtsSec !== null) {
        decodedVideoToMasterSourceErrorMs = Math.abs(frame.decodedVideoSourcePtsSec - frame.expectedSourcePtsAtCommitSec) * 1000;
        videoErrors.push(decodedVideoToMasterSourceErrorMs);
      }
      if (analyser && pcmData && frame.decodedVideoSourcePtsSec !== null) {
        pcmMarkerSourcePtsSec = decodePcmMarkerSourcePts(sampleRms(analyser, pcmData));
        if (pcmMarkerSourcePtsSec !== null) {
          pcmToDecodedVideoErrorMs = Math.abs(pcmMarkerSourcePtsSec - frame.decodedVideoSourcePtsSec) * 1000;
          pcmErrors.push(pcmToDecodedVideoErrorMs);
          if (seekRequestedAtMs !== null && seekToPcmMarkerMs === null &&
              Math.abs(pcmMarkerSourcePtsSec - frame.expectedSourcePtsAtCommitSec) <= 200 / 1000) {
            seekToPcmMarkerMs = frame.performanceTimeMs - seekRequestedAtMs;
            seekVerification.pcmMarkerVerified = true;
          }
        }
        const estimate = outputTimestampEstimate(context, frame.performanceTimeMs, timestampAnchor);
        outputStatus = estimate.status;
        outputReason = estimate.reason;
        outputMasterPtsSec = estimate.masterPtsSec;
        if (estimate.masterPtsSec !== null) {
          outputTimestampApiAvailable = true;
          outputSourcePtsSec = sourcePtsAtMasterPts(speedEngine, clip.id, estimate.masterPtsSec);
          outputToDecodedVideoErrorMs = Math.abs(outputSourcePtsSec - frame.decodedVideoSourcePtsSec) * 1000;
          outputTimestampErrors.push(outputToDecodedVideoErrorMs);
        }
      }
      return {
        performanceTimeMs: frame.performanceTimeMs,
        requestedMasterPtsSec: frame.requestedMasterPtsSec,
        committedMasterPtsSec: frame.committedMasterPtsSec,
        expectedSourcePtsAtCommitSec: frame.expectedSourcePtsAtCommitSec,
        decodedVideoSourcePtsSec: frame.decodedVideoSourcePtsSec,
        frameMarkerVerified,
        frameCommitStatus: frame.commitStatus,
        frameRenderMs: frame.renderMs,
        pcmMarkerSourcePtsSec,
        pcmToDecodedVideoErrorMs,
        decodedVideoToMasterSourceErrorMs,
        outputTimestampStatus: outputStatus,
        ...(outputReason ? { outputTimestampReason: outputReason } : {}),
        outputMasterPtsSec,
        outputSourcePtsSec,
        outputToDecodedVideoErrorMs,
      };
    };

    if (options.seekAfterMs !== undefined && options.seekToClipOffset !== undefined && schedule) {
      await new Promise<void>((resolve) => page.setTimeout(resolve, options.seekAfterMs));
      const target = CLIP_START_TIME + options.seekToClipOffset;
      clock.seek(target);
      graph.seekTo(target);
      frameScheduler.invalidate();
      timestampAnchor = { contextTimeSec: context.currentTime, masterPtsSec: clock.currentTime, masterRate: clock.rate };
      seekRequestedAtMs = performance.now();
      didSeek = true;
    } else if (options.freezeFrames?.length) {
      await new Promise<void>((resolve) => page.setTimeout(resolve, 350));
    } else {
      await new Promise<void>((resolve) => page.setTimeout(resolve, WARMUP_MS));
    }

    while (samples.length < requestedSamplesPerCase) {
      if (performance.now() - startedAt > MAX_CASE_CAPTURE_MS) throw new Error(`A01 ${options.id} did not collect its requested frame samples within the per-case budget`);
      const sample = await takeSample();
      samples.push(sample);
    }

    const seekVerificationSamples: PlaybackAvSample[] = [];
    if (didSeek && seekRequestedAtMs !== null) {
      const seekVerificationStartedAt = performance.now();
      while (performance.now() - seekVerificationStartedAt < 1_000 &&
          (seekVerification.pcmMarkerVerified !== true || seekVerification.videoMarkerVerified !== true)) {
        if (performance.now() - startedAt > MAX_CASE_CAPTURE_MS) break;
        const observation = await takeSample();
        seekVerificationSamples.push(observation);
      }
    }

    let freezeFrameProbes: FreezeFrameProbe[] | null = null;
    if (freezeSourcePts !== null) {
      clock.pause();
      freezeFrameProbes = [];
      const probes = [
        { phase: "before" as const, offset: 0.2 },
        { phase: "during" as const, offset: 0.45 },
        { phase: "after" as const, offset: 0.65 },
      ];
      for (const probe of probes) {
        const requestedMasterPtsSec = CLIP_START_TIME + probe.offset;
        clock.seek(requestedMasterPtsSec);
        frameScheduler.invalidate();
        const frame = await renderOneFrame(requestedMasterPtsSec);
        const expectedSourcePtsSec = sourcePtsAtMasterPts(speedEngine, clip.id, requestedMasterPtsSec);
        freezeFrameProbes.push({
          phase: probe.phase,
          requestedMasterPtsSec,
          expectedSourcePtsSec,
          decodedVideoSourcePtsSec: frame.decodedVideoSourcePtsSec,
          commitStatus: frame.commitStatus,
          verified: frame.commitStatus === "committed" && frame.decodedVideoSourcePtsSec !== null &&
            Math.abs(frame.decodedVideoSourcePtsSec - expectedSourcePtsSec) <= VIDEO_MARKER_INTERVAL_SECONDS / 2 + 1e-6,
        });
      }
    }
    const freezeVerified = freezeSourcePts === null || (
      Math.abs(freezeSourcePts.before - 5.8) < 1e-6 &&
      Math.abs(freezeSourcePts.during - 3.5) < 1e-6 &&
      Math.abs(freezeSourcePts.after - 5.65) < 1e-6 &&
      freezeFrameProbes?.length === 3 && freezeFrameProbes.every((probe) => probe.verified)
    );
    const frameMarkersVerified = samples.length === requestedSamplesPerCase &&
      samples.every((sample) => sample.frameMarkerVerified && sample.frameCommitStatus === "committed") &&
      (seekVerification.videoMarkerVerified !== false) &&
      (options.seekAfterMs === undefined || (seekVerification.pcmMarkerVerified === true && seekVerification.videoMarkerVerified === true)) &&
      freezeVerified;
    const scheduledAudio = schedule !== null;
    const outputApiStatus = !scheduledAudio ? "not_applicable" : outputTimestampApiAvailable ? "available" : "unsupported";

    return {
      id: options.id,
      elapsedMs: performance.now() - measurementStartedAt,
      audioPreparationMs,
      videoPreparationMs,
      audioSchedulingStatus: scheduledAudio ? "scheduled" : "unsupported",
      audioSchedulingReason: scheduledAudio ? null : "freeze_audio_undefined",
      audioContextState: context.state,
      baseLatencySeconds: typeof context.baseLatency === "number" ? context.baseLatency : null,
      outputLatencySeconds: typeof context.outputLatency === "number" ? context.outputLatency : null,
      playbackRate: options.playbackRate,
      frameSamples: samples.length,
      decodedVideoMarkerSamples: samples.filter((sample) => sample.decodedVideoSourcePtsSec !== null).length,
      frameCommits: samples.filter((sample) => sample.frameCommitStatus === "committed").length,
      frameMarkersVerified,
      decodedVideoToMasterSourcePts: summarizePlaybackAvErrors(videoErrors, scheduledAudio ? "insufficient_samples" : "not_applicable"),
      pcmToDecodedVideoSourcePts: summarizePlaybackAvErrors(pcmErrors, scheduledAudio ? "insufficient_samples" : "not_applicable"),
      outputTimestampToDecodedVideoSourcePts: summarizePlaybackAvErrors(
        outputTimestampErrors,
        !scheduledAudio ? "not_applicable" : outputApiStatus === "unsupported" ? "unsupported" : "insufficient_samples",
      ),
      outputTimestampApiStatus: outputApiStatus,
      seekToPcmMarkerMs,
      seekMarkerVerified: seekVerification.pcmMarkerVerified,
      seekVideoMarkerVerified: seekVerification.videoMarkerVerified,
      seekVerificationSamples,
      freezeSourcePts,
      freezeFrameProbes,
      samples,
    };
  } finally {
    frameScheduler?.invalidate();
    lastGoodFrame.current?.close();
    videoEngine.dispose();
    mediaEngine.disposeExportDecoder(clip.mediaId);
    speedEngine.clear();
    graph.dispose();
    clock.dispose();
    canvas.remove();
    if (context.state !== "closed") await context.close();
  }
}

function decodeBase64Blob(encoded: string, mimeType: string): Blob {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}

/** Run a bounded synthetic AV pass through production decode, commit, clock and audio scheduling paths. */
export async function runPlaybackAvBrowserScenario(
  requestedSamplesPerCase: number,
  videoBase64: string,
  pcmBase64: string,
): Promise<PlaybackAvBrowserResult> {
  if (!Number.isInteger(requestedSamplesPerCase) || requestedSamplesPerCase < 1 || requestedSamplesPerCase > 100) {
    throw new RangeError("A01 supports 1 to 100 requested frame samples per case");
  }
  const videoBlob = decodeBase64Blob(videoBase64, "video/mp4");
  const startedAt = performance.now();
  const cases: CaseOptions[] = [
    { id: "one_x", playbackRate: 1 },
    { id: "two_x", playbackRate: 2 },
    { id: "speed_curve", playbackRate: "curve" },
    { id: "segment_seek", playbackRate: 2, seekAfterMs: 250, seekToClipOffset: 1.1 },
    { id: "reverse", playbackRate: 1, reversed: true },
    { id: "reverse_freeze", playbackRate: 1, reversed: true, freezeFrames: [createFreezeFrame()] },
  ];
  const results: PlaybackAvCaseResult[] = [];
  for (const options of cases) {
    if (performance.now() - startedAt >= MAX_ELAPSED_MS) throw new Error("playback AV scenario exceeded its 30 second capture budget");
    results.push(await runCase(options, requestedSamplesPerCase, videoBlob, pcmBase64, window));
  }
  const durationMs = performance.now() - startedAt;
  if (durationMs > MAX_ELAPSED_MS) throw new Error("playback AV scenario exceeded its 30 second total budget");
  const timestampCases = results.filter((result) => result.audioSchedulingStatus === "scheduled");
  return {
    schema: "reelterminal.performance-playback-av/v1",
    durationMs,
    requestedFrameSamplesPerCase: requestedSamplesPerCase,
    reference: {
      masterPts: "MasterTimelineClock.currentTime (seconds)",
      sourcePts: "clip inPoint + SpeedEngine playback-time mapping (seconds)",
      audioSchedule: "RealtimeAudioGraph and synthetic time-marked PCM",
      videoFrame: "VideoEngine decoded time-coded MP4 frame; shared commit helpers painted the bitmap to a harness-owned canvas",
      decodedVideoTimestamp: "source PTS is reconstructed from synthetic video pixel bins; native VideoFrame timestamp is unsupported",
      markerQuantization: {
        videoBinMs: VIDEO_MARKER_INTERVAL_SECONDS * 1000,
        videoHalfBinUncertaintyMs: VIDEO_MARKER_INTERVAL_SECONDS * 500,
        pcmBinMs: 250,
        pcmHalfBinUncertaintyMs: 125,
        combinedHalfBinUncertaintyMs: VIDEO_MARKER_INTERVAL_SECONDS * 500 + 125,
      },
      outputTimestamp: "AudioContext.getOutputTimestamp mapped back to master and source PTS; estimate only",
      actualPresented: "unsupported",
      actualAudibleSync: "unsupported",
    },
    outputTimestampApiStatus: timestampCases.some((result) => result.outputTimestampApiStatus === "available")
      ? "available"
      : "unsupported",
    cases: results,
  };
}
