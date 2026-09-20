import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const extractAudioWav = vi.fn();
vi.mock("@reelterminal/core/media", () => ({
  extractAudioWav: (...args: unknown[]) => extractAudioWav(...args),
}));

import { loadAudioBuffer } from "./load-audio-buffer";

function fakeBlob(bytes = 8): Blob {
  return { arrayBuffer: async () => new ArrayBuffer(bytes) } as Blob;
}

function fakeContext() {
  const buffer = { duration: 1 } as AudioBuffer;
  const decodeAudioData = vi.fn().mockResolvedValue(buffer);
  return {
    buffer,
    decodeAudioData,
    ctx: { decodeAudioData } as unknown as AudioContext,
  };
}

function noAudioStreamError(): Error {
  const error = new Error("media has no matching audio stream");
  error.name = "NoAudioStreamError";
  return error;
}

describe("loadAudioBuffer", () => {
  beforeEach(() => extractAudioWav.mockReset());
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decodes the extracted wav on the happy path", async () => {
    const { ctx, decodeAudioData, buffer } = fakeContext();
    extractAudioWav.mockResolvedValue(fakeBlob(16));
    const result = await loadAudioBuffer(ctx, fakeBlob());
    expect(result).toBe(buffer);
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
  });

  it("returns null without touching decodeAudioData again when NoAudioStreamError is respected", async () => {
    const { ctx, decodeAudioData } = fakeContext();
    extractAudioWav.mockRejectedValue(noAudioStreamError());
    const result = await loadAudioBuffer(ctx, fakeBlob(), {
      audioTrackIndex: 0,
      respectNoAudioStream: true,
    });
    expect(result).toBeNull();
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it("falls back to decoding the source blob when extraction fails for other reasons", async () => {
    const { ctx, decodeAudioData, buffer } = fakeContext();
    extractAudioWav.mockRejectedValue(
      Object.assign(new Error("failed to run ffmpeg sidecar"), {
        name: "FFmpegProbeError",
      }),
    );
    const result = await loadAudioBuffer(ctx, fakeBlob(), {
      audioTrackIndex: 0,
      respectNoAudioStream: true,
    });
    expect(result).toBe(buffer);
    // one call from the failed extract attempt is not possible here (extract
    // rejected before decoding), so the single call must be the fallback
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
  });

  it("keeps the legacy fallback for analysis callers when NoAudioStreamError is not respected", async () => {
    const { ctx, decodeAudioData, buffer } = fakeContext();
    extractAudioWav.mockRejectedValue(noAudioStreamError());
    const result = await loadAudioBuffer(ctx, fakeBlob());
    expect(result).toBe(buffer);
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
  });

  it("cannot fall back for non-zero audio track indexes and warns instead of staying silent", async () => {
    const { ctx, decodeAudioData } = fakeContext();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    extractAudioWav.mockRejectedValue(new Error("sidecar unavailable"));
    const result = await loadAudioBuffer(ctx, fakeBlob(), {
      audioTrackIndex: 1,
      respectNoAudioStream: true,
    });
    expect(result).toBeNull();
    expect(decodeAudioData).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("warns with the extraction error when the fallback decode also fails", async () => {
    const { ctx, decodeAudioData } = fakeContext();
    const sidecarError = new Error("failed to run ffmpeg sidecar");
    extractAudioWav.mockRejectedValue(sidecarError);
    decodeAudioData.mockRejectedValue(new Error("EncodingError"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await loadAudioBuffer(ctx, fakeBlob(), {
      audioTrackIndex: 0,
      respectNoAudioStream: true,
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[audio]"),
      sidecarError,
    );
  });
});
