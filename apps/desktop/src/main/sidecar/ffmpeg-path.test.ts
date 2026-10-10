import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ app: { isPackaged: true }, exists: vi.fn() }));
vi.mock("electron", () => ({ app: mocks.app }));
vi.mock("node:fs", () => ({ existsSync: mocks.exists }));
import { resolveFfmpegPath } from "./ffmpeg-path";

describe("user-provided FFmpeg", () => {
  beforeEach(() => {
    mocks.app.isPackaged = true;
    mocks.exists.mockReturnValue(true);
    vi.unstubAllEnvs();
    // A machine-level REELTERMINAL_FFMPEG_PATH must not leak into the
    // assertions; "" is falsy in the resolver, i.e. treated as unset.
    vi.stubEnv("REELTERMINAL_FFMPEG_PATH", "");
  });

  it("uses PATH in distributed apps even if local binaries are present", () => {
    expect(resolveFfmpegPath()).toBe("ffmpeg");
  });

  it("uses an explicit path and supports a local development fetch", () => {
    vi.stubEnv("REELTERMINAL_FFMPEG_PATH", "C:/tools/ffmpeg.exe");
    expect(resolveFfmpegPath()).toBe("C:/tools/ffmpeg.exe");
    vi.stubEnv("REELTERMINAL_FFMPEG_PATH", "");
    mocks.app.isPackaged = false;
    expect(resolveFfmpegPath()).not.toBe("ffmpeg");
    mocks.exists.mockReturnValue(false);
    expect(resolveFfmpegPath()).toBe("ffmpeg");
  });
});
