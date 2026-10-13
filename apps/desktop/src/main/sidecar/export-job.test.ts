import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => mockSpawn.mockReset());

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
