import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, openSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveFfmpegPath } from "./ffmpeg-path";
import { videoEncodeArgs, type EncodeMode, type ExportCodec } from "./encode-args";
import {
  beginExportPerformanceSpan,
  endExportPerformanceSpan,
  markExportPerformance,
  type ExportPerformanceSink,
  type ExportPerformanceSpan,
} from "@reelterminal/runtime-chromium";

export interface ExportArgs {
  width: number;
  height: number;
  frameRate: number;
  codec: ExportCodec;
  encoder: string;
  mode: EncodeMode;
  quality: number;
  bitrateKbps: number;
  outputPath: string;
  audioWavPath: string;
  format: string;
  proresProfile?: "proxy" | "lt" | "standard" | "hq" | "4444" | "4444xq";
}

export function parseProgressBlock(block: string): { frame: number; done: boolean } | null {
  const matches = [...block.matchAll(/frame=(\d+)/g)];
  if (matches.length === 0) return null;
  return { frame: Number(matches[matches.length - 1][1]), done: /progress=end/.test(block) };
}

export function buildFfmpegArgs(a: ExportArgs): string[] {
  return [
    "-y",
    "-f", "rawvideo",
    "-pix_fmt", "rgba",
    "-s", `${a.width}x${a.height}`,
    "-r", String(a.frameRate),
    "-i", "pipe:0",
    "-i", a.audioWavPath,
    ...videoEncodeArgs({
      codec: a.codec,
      encoder: a.encoder,
      mode: a.mode,
      quality: a.quality,
      bitrateKbps: a.bitrateKbps,
      width: a.width,
      height: a.height,
      frameRate: a.frameRate,
      proresProfile: a.proresProfile,
    }),
    "-c:a", "aac",
    "-progress", "pipe:2",
    a.outputPath,
  ];
}

export class ExportJob {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private progressBuf = "";
  private stderrTail = "";
  private finished = false;
  private cancelRequested = false;
  private settled = false;
  private temporaryOutput: string | null = null;
  private processError: Error | null = null;
  private cleanupError: Error | null = null;
  private resolveStopped!: () => void;
  private readonly stopped = new Promise<void>((resolve) => { this.resolveStopped = resolve; });
  private encodeSpan: ExportPerformanceSpan | null = null;
  private finalizeSpan: ExportPerformanceSpan | null = null;

  constructor(
    private readonly args: ExportArgs,
    private readonly onFrame: (frame: number) => void,
    private readonly onDone: () => void,
    private readonly onError: (msg: string) => void,
    private readonly performanceSink?: ExportPerformanceSink,
  ) {}

  start(): boolean {
    this.encodeSpan = beginExportPerformanceSpan(this.performanceSink, "encode");
    markExportPerformance(this.performanceSink, "audio", { included: this.args.audioWavPath.length > 0 });
    try {
      // Reserve only our own file, beside the destination for a same-volume
      // rename. Keep the extension so FFmpeg selects the original muxer.
      const temporaryOutput = path.join(
        path.dirname(this.args.outputPath),
        `.reelterminal-export-${randomUUID()}${path.extname(this.args.outputPath)}`,
      );
      const descriptor = openSync(temporaryOutput, "wx");
      this.temporaryOutput = temporaryOutput;
      closeSync(descriptor);
      this.proc = spawn(resolveFfmpegPath(), buildFfmpegArgs({ ...this.args, outputPath: temporaryOutput }));
    } catch (error) {
      this.finish(error instanceof Error ? error.message : String(error));
      return false;
    }
    this.proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.progressBuf += text;
      this.stderrTail = (this.stderrTail + text).slice(-4096);
      const parsed = parseProgressBlock(this.progressBuf);
      if (parsed) {
        markExportPerformance(this.performanceSink, "progress", { currentFrame: parsed.frame });
        this.onFrame(parsed.frame);
      }
      if (this.progressBuf.length > 16384) {
        this.progressBuf = this.progressBuf.slice(-4096);
      }
    });
    // ffmpeg closes its stdin when it exits (an encoder/arg error, or -shortest
    // ending early). Without this handler the next frame write raises EPIPE as an
    // unhandled stream error and crashes the whole main process. Swallow it here;
    // the real outcome (and reason) is reported via the close handler below.
    this.proc.stdin.on("error", () => {
      this.finished = true;
    });
    this.proc.on("error", (e) => {
      this.finished = true;
      this.processError = e;
    });
    this.proc.on("close", (code) => {
      const detail = this.stderrTail.trim();
      this.finish(this.processError?.message ?? (code === 0 ? undefined :
        `ffmpeg exited with code ${code}${detail ? `: ${detail}` : ""}`));
    });
    return true;
  }

  private finish(message?: string): void {
    if (this.settled) return;
    this.finished = true;
    if (this.cancelRequested) message = "Native export cancelled";
    if (this.temporaryOutput) {
      try {
        // This synchronous commit is the cancellation boundary: cancellation
        // observed before close wins; cancellation after commit is a no-op.
        // Never remove the old destination before trying to replace it.
        if (!message) {
          renameSync(this.temporaryOutput, this.args.outputPath);
          this.temporaryOutput = null;
        }
      } catch (error) {
        message = `Could not commit native export: ${error instanceof Error ? error.message : String(error)}`;
      }
      try {
        if (this.temporaryOutput) rmSync(this.temporaryOutput, { force: true });
      } catch (error) {
        const cleanupError = `Could not clean native export temporary file: ${error instanceof Error ? error.message : String(error)}`;
        this.cleanupError = new Error(cleanupError);
        message = message ? `${message}; ${cleanupError}` : cleanupError;
      }
      this.temporaryOutput = null;
    }
    this.settled = true;
    const outcome = this.cancelRequested ? "cancelled" : message ? "error" : "ok";
    endExportPerformanceSpan(this.performanceSink, this.encodeSpan, outcome);
    endExportPerformanceSpan(this.performanceSink, this.finalizeSpan, outcome);
    try {
      if (message) this.onError(message);
      else this.onDone();
    } finally {
      this.resolveStopped();
    }
  }

  async writeFrame(frame: Uint8Array): Promise<void> {
    const span = beginExportPerformanceSpan(this.performanceSink, "write");
    let outcome: "ok" | "error" | "cancelled" = "ok";
    try {
      const proc = this.proc;
      if (!proc) throw new Error("job not started");
      if (this.finished || !proc.stdin.writable) {
        outcome = this.cancelRequested ? "cancelled" : "error";
        return;
      }
      if (proc.stdin.write(frame)) {
        return;
      }
      await new Promise<void>((resolve) => {
        const settle = (settledOutcome: "ok" | "error" | "cancelled"): void => {
          proc.stdin.off("drain", onDrain);
          proc.stdin.off("close", onClose);
          proc.stdin.off("error", onError);
          outcome = settledOutcome;
          resolve();
        };
        const onDrain = (): void => settle("ok");
        const onClose = (): void => settle(this.cancelRequested ? "cancelled" : "error");
        const onError = (): void => settle(this.cancelRequested ? "cancelled" : "error");
        proc.stdin.once("drain", onDrain);
        proc.stdin.once("close", onClose);
        proc.stdin.once("error", onError);
      });
    } catch (error) {
      outcome = "error";
      throw error;
    } finally {
      endExportPerformanceSpan(this.performanceSink, span, outcome);
    }
  }

  endInput(): void {
    this.finalizeSpan = beginExportPerformanceSpan(this.performanceSink, "finalize");
    if (this.proc && this.proc.stdin.writable) {
      this.proc.stdin.end();
    }
  }

  async cancel(): Promise<void> {
    if (!this.settled) {
      this.finished = true;
      this.cancelRequested = true;
      markExportPerformance(this.performanceSink, "cancel");
      this.proc?.kill("SIGKILL");
      if (!this.proc) this.finish("Native export cancelled");
    }
    await this.stopped;
    if (this.cleanupError) throw this.cleanupError;
  }
}
