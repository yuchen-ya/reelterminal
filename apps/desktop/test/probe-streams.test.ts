import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { parseAudioStreams, probeAudioStreams } from "../src/main/sidecar/probe-streams";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../src/main/sidecar/ffmpeg-path", () => ({
  resolveFfmpegPath: () => "/fake/sidecar/ffmpeg",
}));

const SAMPLE = `
Input #0, mov,mp4,m4a, from 'in.mp4':
  Duration: 00:00:42.00, start: 0.000000, bitrate: 1200 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 30 fps
  Stream #0:1[0x2](eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s
  Stream #0:2(jpn): Audio: ac3, 48000 Hz, 5.1, 384 kb/s
  Stream #0:3: Audio: mp3, 44100 Hz, mono, 96 kb/s
`;

describe("parseAudioStreams", () => {
  it("extracts only audio streams with index/codec/channels/sampleRate/language", () => {
    const streams = parseAudioStreams(SAMPLE);
    expect(streams).toEqual([
      { index: 1, codec: "aac", channels: 2, sampleRate: 48000, language: "eng" },
      { index: 2, codec: "ac3", channels: 6, sampleRate: 48000, language: "jpn" },
      { index: 3, codec: "mp3", channels: 1, sampleRate: 44100 },
    ]);
  });

  it("maps explicit 'N channels' layout", () => {
    const s = parseAudioStreams("  Stream #0:1: Audio: pcm_s16le, 48000 Hz, 8 channels, s16\n");
    expect(s[0]).toMatchObject({ index: 1, codec: "pcm_s16le", channels: 8, sampleRate: 48000 });
  });

  it("returns [] when there are no audio streams", () => {
    expect(parseAudioStreams("  Stream #0:0: Video: h264, yuv420p, 1920x1080\n")).toEqual([]);
  });
});

function fakeProc() {
  const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  proc.stderr = new EventEmitter();
  vi.mocked(spawn).mockReturnValue(proc as never);
  return proc;
}

describe("probeAudioStreams", () => {
  afterEach(() => vi.mocked(spawn).mockReset());

  it("rejects when the ffmpeg sidecar cannot be spawned", async () => {
    const proc = fakeProc();
    const pending = probeAudioStreams("/tmp/in.mp4");
    const assertion = expect(pending).rejects.toThrow(/ffmpeg sidecar/i);
    proc.emit("error", new Error("spawn ENOENT"));
    await assertion;
  });

  it("does not resolve with [] on spawn failure (would mimic a silent media file)", async () => {
    const proc = fakeProc();
    let resolved: unknown = null;
    const pending = probeAudioStreams("/tmp/in.mp4").then((streams) => {
      resolved = streams;
    });
    proc.emit("error", new Error("spawn ENOENT"));
    await pending.catch(() => {});
    expect(resolved).toBeNull();
  });

  it("resolves with parsed streams once ffmpeg actually ran", async () => {
    const proc = fakeProc();
    const pending = probeAudioStreams("/tmp/in.mp4");
    proc.stderr.emit(
      "data",
      Buffer.from("  Stream #0:1: Audio: aac, 48000 Hz, stereo, fltp, 128 kb/s\n"),
    );
    proc.emit("close", 1);
    await expect(pending).resolves.toEqual([
      { index: 1, codec: "aac", channels: 2, sampleRate: 48000 },
    ]);
  });

  it("resolves with [] only when ffmpeg ran and reported no audio streams", async () => {
    const proc = fakeProc();
    const pending = probeAudioStreams("/tmp/silent.mp4");
    proc.stderr.emit(
      "data",
      Buffer.from("  Stream #0:0: Video: h264, yuv420p, 1920x1080\n"),
    );
    proc.emit("close", 1);
    await expect(pending).resolves.toEqual([]);
  });
});
