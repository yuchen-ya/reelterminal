import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIO_LIMITS, analyzeLocalAudio, analyzeSilence, audioAnalysisPreflight } from "./audio-analysis";
import { resolveToolFfmpeg } from "./media/ffmpeg-bin";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("./media/ffmpeg-bin", () => ({ resolveToolFfmpeg: vi.fn() }));

const explicitBinaries = {
  ffmpeg: "C:\\Program Files\\Audio Tools\\ffmpeg.exe",
  ffprobe: "C:\\Program Files\\Audio Tools\\ffprobe.exe",
};

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.finish(null, "SIGKILL"));
    return true;
  });

  finish(code: number | null, signal: NodeJS.Signals | null = null) {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

type SpawnMode = "success" | "hold" | "overflow";
let mode: SpawnMode = "success";
const children: FakeChild[] = [];
const spawnMock = vi.mocked(spawn);
const resolveMock = vi.mocked(resolveToolFfmpeg);

function flushPromises() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

describe("audio analysis subprocesses", () => {
  beforeEach(() => {
    mode = "success";
    children.length = 0;
    resolveMock.mockReset();
    resolveMock.mockResolvedValue(explicitBinaries);
    spawnMock.mockReset();
    spawnMock.mockImplementation(((_exe: string, args: readonly string[], _options: Record<string, unknown>) => {
      const child = new FakeChild();
      children.push(child);
      if (mode === "success") {
        queueMicrotask(() => {
          if (args.includes("-filters")) child.stdout.write("loudnorm available");
          else if (args.includes("-show_entries")) child.stdout.write('{"streams":[{"sample_rate":"8000","channels":2}]}');
          else if (args.includes("-af")) child.stderr.write('{"input_i":"-18","input_tp":"-1","input_lra":"2"}');
          else if (args.includes("f32le")) child.stdout.write(Buffer.alloc(8000 * 8));
          else child.stdout.write("ffprobe version fixture");
          child.finish(0);
        });
      } else if (mode === "overflow") {
        queueMicrotask(() => child.stdout.write(Buffer.alloc(AUDIO_LIMITS.maxProcessOutputBytes + 1)));
      }
      return child as unknown as ReturnType<typeof spawn>;
    }) as typeof spawn);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves explicit FFmpeg tools and starts them without a shell or visible window", async () => {
    expect(await audioAnalysisPreflight()).toMatchObject({ available: true });
    const result = await analyzeLocalAudio("fixture.wav", { startSec: 0, endSec: 1 }, new AbortController().signal);

    expect(result.durationSec).toBe(1);
    expect(resolveMock).toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(explicitBinaries.ffmpeg, expect.any(Array), expect.objectContaining({ shell: false, windowsHide: true }));
    expect(spawnMock).toHaveBeenCalledWith(explicitBinaries.ffprobe, expect.arrayContaining(["-show_entries", "stream=sample_rate,channels,channel_layout"]), expect.objectContaining({ shell: false, windowsHide: true }));
  });

  it("keeps the process concurrency limit", async () => {
    mode = "hold";
    const requests = Array.from({ length: 4 }, () => analyzeSilence("fixture.wav", { startSec: 0, endSec: 1 }, undefined, new AbortController().signal));
    await flushPromises();
    expect(children).toHaveLength(4);

    await expect(analyzeSilence("fixture.wav", { startSec: 0, endSec: 1 }, undefined, new AbortController().signal)).rejects.toThrow("process limit");
    for (const child of children) child.finish(0);
    await Promise.all(requests);
  });

  it("kills an active process and reports cancellation", async () => {
    mode = "hold";
    const controller = new AbortController();
    const request = analyzeSilence("fixture.wav", { startSec: 0, endSec: 1 }, undefined, controller.signal);
    await flushPromises();
    expect(children).toHaveLength(1);

    controller.abort();
    await expect(request).rejects.toThrow("Cancelled");
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("keeps the process deadline", async () => {
    mode = "hold";
    vi.useFakeTimers();
    const request = analyzeSilence("fixture.wav", { startSec: 0, endSec: 1 }, undefined, new AbortController().signal);
    await flushPromises();
    expect(children).toHaveLength(1);

    const rejected = expect(request).rejects.toThrow(/deadline|timed out/i);
    await vi.advanceTimersByTimeAsync(AUDIO_LIMITS.timeoutMs);
    await rejected;
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("kills output that exceeds the process cap", async () => {
    mode = "overflow";
    const request = analyzeSilence("fixture.wav", { startSec: 0, endSec: 1 }, undefined, new AbortController().signal);
    await flushPromises();

    await expect(request).rejects.toThrow(/output.*(resource limit|cap)/i);
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
