import { afterEach, describe, expect, it, vi } from "vitest";
import { PausedVideoFrameReader, PAUSED_VIDEO_FRAME_TIMEOUT_MS } from "./paused-video-frame";

function decoder() {
  const video = new EventTarget() as HTMLVideoElement;
  let time = 0;
  Object.assign(video, { readyState: 2, videoWidth: 160, videoHeight: 90, seeking: false });
  const seek = vi.fn((target: number) => {
    time = target;
    Object.assign(video, { seeking: true });
  });
  Object.defineProperty(video, "currentTime", { get: () => time, set: seek });
  const reader = new PausedVideoFrameReader(video);
  const ready = () => {
    Object.assign(video, { seeking: false });
    video.dispatchEvent(new Event("seeked"));
  };
  return { video, reader, seek, ready };
}

afterEach(() => vi.useRealTimers());

describe("paused video readiness", () => {
  it("completes the owning render on seeked and reuses the paused target without another seek or callback wait", async () => {
    const { reader, seek, ready } = decoder();
    const recover = vi.fn();
    const pending = reader.seek(1 / 60, recover);
    ready();
    expect(await pending).toBe("ready");
    expect(await reader.seek(1 / 60, recover)).toBe("cached");
    expect(seek).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
    reader.dispose();
  });

  it("does not accept an old drawable frame while a new seek is still pending", async () => {
    const { video, reader, ready } = decoder();
    let settled = false;
    const pending = reader.seek(2, vi.fn()).then(result => { settled = true; return result; });
    video.dispatchEvent(new Event("loadeddata"));
    await Promise.resolve();
    expect(settled).toBe(false);
    ready();
    expect(await pending).toBe("ready");
    reader.dispose();
  });

  it("uses one deadline and requests a single recovery only after a timed-out decoder becomes ready", async () => {
    vi.useFakeTimers();
    const { video, reader, ready } = decoder();
    const recover = vi.fn();
    const pending = reader.seek(2, recover);
    await vi.advanceTimersByTimeAsync(PAUSED_VIDEO_FRAME_TIMEOUT_MS);
    expect(await pending).toBe("timeout");
    ready();
    video.dispatchEvent(new Event("loadeddata"));
    expect(recover).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    reader.dispose();
  });

  it("cancels pending work and late recovery on release or a replacement target", async () => {
    vi.useFakeTimers();
    const { reader, ready } = decoder();
    const recover = vi.fn();
    const old = reader.seek(1, recover);
    await vi.advanceTimersByTimeAsync(PAUSED_VIDEO_FRAME_TIMEOUT_MS);
    expect(await old).toBe("timeout");
    const next = reader.seek(2, recover);
    reader.dispose();
    ready();
    expect(await next).toBe("cancelled");
    expect(recover).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
