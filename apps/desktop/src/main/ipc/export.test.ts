import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(() => true), cancel: vi.fn(), postMessage: vi.fn(),
  done: null as (() => void) | null, audioPaths: [] as string[],
}));
vi.mock("electron", () => ({
  MessageChannelMain: class {
    port1 = Object.assign(new EventEmitter(), { start() {}, postMessage: mocks.postMessage });
    port2 = {};
  },
}));
vi.mock("../sidecar/encoder-probe", () => ({ probeEncoders: async () => ["libx264"], selectEncoder: () => "libx264" }));
vi.mock("../sidecar/export-job", () => ({
  ExportJob: class {
    constructor(args: { audioWavPath: string }, _onFrame: unknown, onDone: () => void) {
      mocks.audioPaths.push(args.audioWavPath);
      mocks.done = onDone;
    }
    start = mocks.start;
    cancel = mocks.cancel;
  },
}));
import { cancelAllExports, cancelExport, startExport, writeAudioWav } from "./export";

async function startJob(outputPath: string) {
  return startExport({ postMessage() {} } as unknown as WebContents, {
    width: 64, height: 64, frameRate: 30, codec: "h264", format: "mp4",
    bitrateKbps: 100, outputPath,
    totalFrames: 30, audioSampleRate: 48000, audioChannels: 2,
  });
}

afterEach(async () => {
  await cancelAllExports();
  for (const file of mocks.audioPaths) rmSync(file, { force: true });
  mocks.audioPaths.length = 0;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

it("keeps a committed success when cancellation arrives during audio cleanup", async () => {
  const { jobId } = await startJob("unused.mp4");
  await writeAudioWav({ jobId, wav: new ArrayBuffer(44) });
  let release!: () => void;
  const cleanup = vi.spyOn(fs, "rm").mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  mocks.done!();
  const cancelling = cancelExport({ jobId });
  expect(mocks.cancel).not.toHaveBeenCalled();
  release();
  await cancelling;
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(mocks.postMessage.mock.calls.filter(([message]) => message.type === "done")).toHaveLength(1);
});

it("does not start a native process after cancellation races an in-flight audio write", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "reelterminal-ipc-"));
  try {
    const { jobId } = await startJob(path.join(directory, "output.mp4"));
    const writing = writeAudioWav({ jobId, wav: new ArrayBuffer(44) });
    await cancelExport({ jobId });
    await writing;
    expect(mocks.start).not.toHaveBeenCalled();
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each(["single", "all"])("waits for the native process to stop before cleaning audio (%s cancellation)", async (scope) => {
  const { jobId } = await startJob("unused.mp4");
  await writeAudioWav({ jobId, wav: new ArrayBuffer(44) });
  const audioPath = mocks.audioPaths[0];
  let stop!: () => void;
  mocks.cancel.mockReturnValue(new Promise<void>((resolve) => { stop = resolve; }));
  const cancelling = scope === "single" ? cancelExport({ jobId }) : cancelAllExports();
  expect(existsSync(audioPath)).toBe(true);
  stop();
  await cancelling;
  expect(existsSync(audioPath)).toBe(false);
});

const validArgs = {
  width: 64, height: 64, frameRate: 30, codec: "h264", format: "mp4",
  bitrateKbps: 100, outputPath: "unused.mp4",
  totalFrames: 30, audioSampleRate: 48000, audioChannels: 2,
};

it("rejects malformed export start payloads with an explicit IPC error", async () => {
  const wc = { postMessage() {} } as unknown as WebContents;
  const malformed: unknown[] = [
    { ...validArgs, width: Number.NaN },
    { ...validArgs, height: 0 },
    { ...validArgs, frameRate: Number.POSITIVE_INFINITY },
    { ...validArgs, totalFrames: -1 },
    { ...validArgs, codec: "mpeg2" },
    { ...validArgs, encodeMode: "instant" },
    { ...validArgs, proresProfile: "422" },
    { ...validArgs, quality: 140 },
    { ...validArgs, outputPath: "" },
    { totalFrames: 30 },
  ];
  for (const payload of malformed) {
    await expect(startExport(wc, payload as never)).rejects.toThrow(/\[ipc\] invalid payload for reelterminal:export:start/);
  }
  expect(mocks.postMessage).not.toHaveBeenCalled();
});

it("keeps accepting fractional frame rates and optional encoder knobs", async () => {
  const { jobId } = await startExport({ postMessage() {} } as unknown as WebContents, {
    ...validArgs,
    frameRate: 29.97,
    codec: "h265",
    encodeMode: "smallest",
    quality: 92,
  });
  expect(jobId).toBeTruthy();
});
