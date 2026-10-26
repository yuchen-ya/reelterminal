import { MessageChannelMain, type WebContents, type MessagePortMain } from "electron";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ExportJob, type ExportArgs } from "../sidecar/export-job";
import { CHANNELS } from "../../shared/channels";
import { CfrWriter } from "../sidecar/cfr";
import { selectEncoder, probeEncoders } from "../sidecar/encoder-probe";
import type { ExportCodec, EncodeMode } from "../sidecar/encode-args";
import type { PerfSink } from "@reelterminal/core";
import {
  adaptPerfSinkForExport,
  beginExportPerformanceSpan,
  endExportPerformanceSpan,
  markExportPerformance,
  withExportPerformance,
  withExportPerformanceSpan,
  type ExportPerformanceSink,
  type ExportPerformanceSpan,
} from "@reelterminal/runtime-chromium";

export interface ExportStartArgs {
  width: number;
  height: number;
  frameRate: number;
  codec: string;
  format: string;
  bitrateKbps: number;
  outputPath: string;
  totalFrames: number;
  audioSampleRate: number;
  audioChannels: number;
  encodeMode?: "fast" | "balanced" | "smallest";
  quality?: number;
  proresProfile?: "proxy" | "lt" | "standard" | "hq" | "4444" | "4444xq";
}

// The renderer sends this payload straight through ipcMain.handle, so it needs
// the same runtime validation the shared handle()+zod IPC helpers apply. The
// codec set mirrors sidecar/encode-args ExportCodec; dimensions, frame rate and
// audio fields keep their full downstream support range (fractional frame rates
// included) with no extra upper bounds.
export const exportStartArgsSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frameRate: z.number().finite().positive(),
  codec: z.enum(["h264", "h265", "hevc", "av1", "prores", "vp9"]),
  format: z.string().min(1),
  bitrateKbps: z.number().int().positive(),
  outputPath: z.string().min(1),
  totalFrames: z.number().int().positive(),
  audioSampleRate: z.number().int().positive(),
  audioChannels: z.number().int().positive(),
  encodeMode: z.enum(["fast", "balanced", "smallest"]).optional(),
  quality: z.number().min(0).max(100).optional(),
  proresProfile: z.enum(["proxy", "lt", "standard", "hq", "4444", "4444xq"]).optional(),
});

const MAX_INITIAL_CREDITS = 10;
const MAX_IN_FLIGHT_FRAME_BYTES = 128 * 1024 * 1024;

interface JobEntry {
  job: ExportJob | null;
  cfr: CfrWriter | null;
  port: MessagePortMain;
  exportArgs: ExportArgs;
  audioWavPath: string;
  started: boolean;
  cancelled: boolean;
  cleanup: Promise<void> | null;
  audioQueue: Promise<void>;
  audioSpan: ExportPerformanceSpan | null;
  queueSpan: ExportPerformanceSpan | null;
  performanceSink?: ExportPerformanceSink;
  queue: Promise<void>;
}

const jobs = new Map<string, JobEntry>();

export function initialFrameCredits(args: Pick<ExportArgs, "width" | "height">): number {
  const frameBytes = Math.max(1, args.width * args.height * 4);
  return Math.max(
    1,
    Math.min(MAX_INITIAL_CREDITS, Math.floor(MAX_IN_FLIGHT_FRAME_BYTES / frameBytes)),
  );
}

export function resolveExportArgs(
  args: ExportStartArgs,
  platform: NodeJS.Platform,
  encoders: string[],
  audioWavPath: string,
): ExportArgs {
  const mode: EncodeMode = args.encodeMode ?? "balanced";
  const encoder = selectEncoder(args.codec, platform, encoders, mode) ?? "libx264";
  const codec = (args.codec === "h265" ? "hevc" : args.codec) as ExportCodec;
  return {
    width: args.width,
    height: args.height,
    frameRate: args.frameRate,
    codec,
    encoder,
    mode,
    quality: args.quality ?? 80,
    bitrateKbps: args.bitrateKbps,
    outputPath: args.outputPath,
    audioWavPath,
    format: args.format,
    proresProfile: args.proresProfile,
  };
}

export async function startExport(
  wc: WebContents,
  args: ExportStartArgs,
  perfSink?: PerfSink,
): Promise<{ jobId: string }> {
  const parsed = exportStartArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`[ipc] invalid payload for ${CHANNELS.exportStart}: ${parsed.error.message}`);
  }
  const jobId = randomUUID();
  let runId = `main-export-${jobId}`;
  try {
    const suppliedRunId = perfSink?.runId;
    if (typeof suppliedRunId === "string" && suppliedRunId.length > 0) runId = suppliedRunId;
  } catch {
    // A malformed collector identity must not interfere with export startup.
  }
  const performanceSink = adaptPerfSinkForExport(perfSink, { runId, operationId: jobId });
  markExportPerformance(performanceSink, "submit");
  const encoders = await probeEncoders();
  const audioWavPath = path.join(os.tmpdir(), `reelterminal-${jobId}.wav`);
  const exportArgs = resolveExportArgs(parsed.data, process.platform, encoders, audioWavPath);

  const { port1, port2 } = new MessageChannelMain();
  const entry: JobEntry = {
    job: null,
    cfr: null,
    port: port1,
    exportArgs,
    audioWavPath,
    started: false,
    cancelled: false,
    cleanup: null,
    audioQueue: Promise.resolve(),
    audioSpan: null,
    queueSpan: beginExportPerformanceSpan(performanceSink, "queue"),
    performanceSink,
    queue: Promise.resolve(),
  };

  // The renderer streams frames concurrently (credit window), but CfrWriter is
  // stateful and must process pushes strictly in arrival order. EventEmitter
  // fires this listener synchronously per message, so chaining each frame onto a
  // per-job queue keeps exactly one push (and one ffmpeg stdin write) in flight —
  // preventing the frame-duplication race (inflated duration / looping frames)
  // and the stdin listener pile-up. "finish" is chained after all frames so
  // endInput() cannot close stdin while frames are still queued.
  port1.on("message", (e) => {
    const msg = e.data as
      | { type?: string; ts?: number; buffer?: ArrayBuffer }
      | null;
    if (!msg || typeof msg.type !== "string") return;
    if (entry.cancelled) return;
    if (msg.type === "frame" && msg.buffer) {
      const buffer = msg.buffer;
      const ts = msg.ts ?? 0;
      markExportPerformance(performanceSink, "render");
      const queueSpan = beginExportPerformanceSpan(performanceSink, "queue");
      entry.queue = entry.queue
        .then(async () => {
          endExportPerformanceSpan(performanceSink, queueSpan, "ok");
          if (!entry.cfr || entry.cancelled) return;
          await entry.cfr.push(new Uint8Array(buffer), ts);
          port1.postMessage({ type: "credit", credits: 1 });
        })
        .catch((err) => {
          endExportPerformanceSpan(performanceSink, queueSpan, "error");
          port1.postMessage({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        });
    } else if (msg.type === "finish") {
      entry.queue = entry.queue.then(() => {
        entry.job?.endInput();
      });
    }
  });
  port1.start();

  wc.postMessage(CHANNELS.exportPortHandoff, { jobId }, [port2]);
  jobs.set(jobId, entry);
  return { jobId };
}

export async function writeAudioWav(args: { jobId: string; wav: ArrayBuffer }): Promise<void> {
  const entry = jobs.get(args.jobId);
  if (!entry) throw new Error(`unknown export job ${args.jobId}`);
  if (entry.started || entry.cancelled) return;
  entry.audioQueue = entry.audioQueue.then(() =>
    withExportPerformanceSpan(entry.performanceSink, "audio", () =>
      fs.writeFile(entry.audioWavPath, Buffer.from(args.wav)),
    ),
  );
  await entry.audioQueue;
  startNativeExportJob(args.jobId, entry);
}

export async function writeAudioChunk(args: {
  jobId: string;
  chunk: ArrayBuffer;
  position: number;
}): Promise<void> {
  const entry = jobs.get(args.jobId);
  if (!entry) throw new Error(`unknown export job ${args.jobId}`);
  if (entry.cancelled) return;
  if (entry.started) throw new Error(`audio already finalized for export job ${args.jobId}`);

  entry.audioSpan ??= beginExportPerformanceSpan(entry.performanceSink, "audio");
  entry.audioQueue = entry.audioQueue.then(() =>
    withExportPerformanceSpan(entry.performanceSink, "write", () =>
      writeFileChunk(entry.audioWavPath, args.chunk, args.position),
    ),
  );
  await entry.audioQueue;
}

export async function finishAudio(args: { jobId: string }): Promise<void> {
  const entry = jobs.get(args.jobId);
  if (!entry) throw new Error(`unknown export job ${args.jobId}`);
  if (entry.cancelled) return;
  try {
    await entry.audioQueue;
    endExportPerformanceSpan(entry.performanceSink, entry.audioSpan, "ok");
    entry.audioSpan = null;
  } catch (error) {
    endExportPerformanceSpan(entry.performanceSink, entry.audioSpan, "error");
    entry.audioSpan = null;
    throw error;
  }
  startNativeExportJob(args.jobId, entry);
}

async function writeFileChunk(
  filePath: string,
  chunk: ArrayBuffer,
  position: number,
): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r+");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    handle = await fs.open(filePath, "w+");
  }
  try {
    await handle.write(Buffer.from(chunk), 0, chunk.byteLength, position);
  } finally {
    await handle.close();
  }
}

function startNativeExportJob(jobId: string, entry: JobEntry): void {
  if (entry.started || entry.cancelled) return;
  endExportPerformanceSpan(entry.performanceSink, entry.queueSpan, "ok");
  entry.queueSpan = null;
  withExportPerformance(entry.performanceSink, "prepare", () => {
    entry.job = new ExportJob(
      entry.exportArgs,
      (frame) => entry.port.postMessage({ type: "progress", frame }),
      () => {
        void cleanupJob(jobId, "ok").then(
          () => entry.port.postMessage({ type: "done" }),
          (error: Error) => entry.port.postMessage({ type: "error", message: error.message }),
        );
      },
      (msg) => {
        if (entry.cancelled) return; // cancelExport owns cleanup after close.
        void cleanupJob(jobId, "error").then(
          () => entry.port.postMessage({ type: "error", message: msg }),
          (error: Error) => entry.port.postMessage({ type: "error", message: `${msg}; ${error.message}` }),
        );
      },
      entry.performanceSink,
    );
    entry.cfr = new CfrWriter(entry.exportArgs.frameRate, async (f) => {
      await entry.job!.writeFrame(f);
    });
    if (!entry.job.start()) return;
    entry.started = true;
    entry.port.postMessage({ type: "credit", credits: initialFrameCredits(entry.exportArgs) });
  });
}

export async function cancelAllExports(): Promise<void> {
  const results = await Promise.allSettled([...jobs.keys()].map((jobId) => cancelExport({ jobId })));
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length > 0) throw new AggregateError(errors, "Could not cancel native exports");
}

function cleanupJob(jobId: string, outcome: "ok" | "error" | "cancelled"): Promise<void> {
  const entry = jobs.get(jobId);
  if (!entry) return Promise.resolve();
  if (entry.cleanup) return entry.cleanup;
  endExportPerformanceSpan(entry.performanceSink, entry.audioSpan, outcome);
  endExportPerformanceSpan(entry.performanceSink, entry.queueSpan, outcome);
  entry.cleanup = fs.rm(entry.audioWavPath, { force: true }).finally(() => {
    jobs.delete(jobId);
  });
  return entry.cleanup;
}

export async function cancelExport(args: { jobId: string }): Promise<void> {
  const entry = jobs.get(args.jobId);
  if (!entry) return;
  if (entry.cleanup) return entry.cleanup;
  entry.cancelled = true;
  markExportPerformance(entry.performanceSink, "cancel");
  endExportPerformanceSpan(entry.performanceSink, entry.audioSpan, "cancelled");
  endExportPerformanceSpan(entry.performanceSink, entry.queueSpan, "cancelled");
  const stopped = entry.job?.cancel();
  try {
    await entry.audioQueue;
  } finally {
    await stopped;
    await cleanupJob(args.jobId, "cancelled");
  }
}
