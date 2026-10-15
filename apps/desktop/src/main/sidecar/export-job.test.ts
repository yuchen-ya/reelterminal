import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportPerformanceCapture } from "@reelterminal/runtime-chromium";
import { ExportJob, type ExportArgs } from "./export-job";

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));
vi.mock("./ffmpeg-path", () => ({ resolveFfmpegPath: () => "fake-ffmpeg" }));

function fakeProcess() {
  const stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: vi.fn(() => false),
    end: vi.fn(),
  });
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stderr: new EventEmitter(),
    stdout: new EventEmitter(),
    kill: vi.fn(),
  });
  return { proc, stdin };
}

const args: ExportArgs = {
  width: 2,
  height: 2,
  frameRate: 1,
  codec: "h264",
  encoder: "libx264",
  mode: "fast",
  quality: 80,
  bitrateKbps: 100,
  outputPath: "output.mp4",
  audioWavPath: "audio.wav",
  format: "mp4",
};

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "reelterminal-job-"));
  args.outputPath = path.join(directory, "output.mp4");
});
afterEach(() => {
  mockSpawn.mockReset();
  rmSync(directory, { recursive: true, force: true });
});

function startFakeJob() {
  const { proc } = fakeProcess();
  mockSpawn.mockReturnValue(proc);
  const done = vi.fn();
  const error = vi.fn();
  const job = new ExportJob(args, () => undefined, done, error);
  job.start();
  const output = mockSpawn.mock.calls[0][1].at(-1) as string;
  return { job, proc, output, done, error };
}

describe("ExportJob output commit", () => {
  it("cancels before a successful close without committing, and waits for close before cleanup", async () => {
    writeFileSync(args.outputPath, "old video");
    const { job, proc, output, done, error } = startFakeJob();
    writeFileSync(output, "new video");
    const cancelled = job.cancel();
    expect(readFileSync(output, "utf8")).toBe("new video");
    expect(readFileSync(args.outputPath, "utf8")).toBe("old video");
    proc.emit("close", 0);
    await cancelled;
    expect(done).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(readFileSync(args.outputPath, "utf8")).toBe("old video");
    expect(readdirSync(directory)).toEqual(["output.mp4"]);
  });

  it("keeps an already committed success when cancellation arrives later", async () => {
    const { job, proc, output, done, error } = startFakeJob();
    writeFileSync(output, "new video");
    proc.emit("close", 0);
    await job.cancel();
    expect(done).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
    expect(readFileSync(args.outputPath, "utf8")).toBe("new video");
  });

  it("reports a commit failure without removing the destination or reporting success", () => {
    mkdirSync(args.outputPath);
    writeFileSync(path.join(args.outputPath, "keep"), "old video");
    const { proc, output, done, error } = startFakeJob();
    writeFileSync(output, "new video");
    proc.emit("close", 0);
    expect(done).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(args.outputPath, "keep"), "utf8")).toBe("old video");
    expect(readdirSync(directory)).toEqual(["output.mp4"]);
  });

  it("reports spawn error followed by close only once", () => {
    const { proc, done, error } = startFakeJob();
    proc.emit("error", new Error("spawn failed"));
    proc.emit("close", -2);
    expect(done).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("discards partially written output after an encoder exits unsuccessfully", () => {
    writeFileSync(args.outputPath, "old video");
    const { proc, output, done, error } = startFakeJob();
    writeFileSync(output, "partial video");
    proc.emit("close", 1);
    expect(done).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(readFileSync(args.outputPath, "utf8")).toBe("old video");
    expect(readdirSync(directory)).toEqual(["output.mp4"]);
  });

  it("keeps concurrent jobs for one destination isolated when one is cancelled", async () => {
    const first = startFakeJob();
    // startFakeJob reads the latest spawn call for each job.
    mockSpawn.mockClear();
    const second = startFakeJob();
    expect(first.output).not.toBe(second.output);
    writeFileSync(first.output, "first video");
    writeFileSync(second.output, "second video");
    first.proc.emit("close", 0);
    const cancelled = second.job.cancel();
    second.proc.emit("close", 1);
    await cancelled;
    expect(first.done).toHaveBeenCalledTimes(1);
    expect(second.done).not.toHaveBeenCalled();
    expect(readFileSync(args.outputPath, "utf8")).toBe("first video");
    expect(readdirSync(directory)).toEqual(["output.mp4"]);
  });
});

describe("ExportJob frame-write telemetry", () => {
  it("keeps the existing non-rejecting close/error behavior but records a failed drain wait and removes listeners", async () => {
    const { proc, stdin } = fakeProcess();
    mockSpawn.mockReturnValue(proc);
    let tick = 0;
    const capture = new ExportPerformanceCapture({
      enabled: true,
      supportedPhases: ["encode", "write"],
      nowUs: () => ++tick,
    });
    const job = new ExportJob(args, () => undefined, () => undefined, () => undefined, capture);
    job.start();

    const baseline = {
      drain: stdin.listenerCount("drain"),
      close: stdin.listenerCount("close"),
      error: stdin.listenerCount("error"),
    };
    const pending = job.writeFrame(new Uint8Array([1, 2, 3]));
    expect(stdin.listenerCount("drain")).toBe(baseline.drain + 1);
    expect(stdin.listenerCount("close")).toBe(baseline.close + 1);
    expect(stdin.listenerCount("error")).toBe(baseline.error + 1);

    stdin.emit("error", new Error("EPIPE"));
    await expect(pending).resolves.toBeUndefined();
    expect({
      drain: stdin.listenerCount("drain"),
      close: stdin.listenerCount("close"),
      error: stdin.listenerCount("error"),
    }).toEqual(baseline);
    expect(capture.report().events).toContainEqual(expect.objectContaining({
      kind: "span_end",
      phase: "write",
      outcome: "error",
    }));
  });
});
