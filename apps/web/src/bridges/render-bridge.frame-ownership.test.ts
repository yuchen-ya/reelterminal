import { describe, expect, it, vi } from "vitest";
import type { RenderedFrame } from "@reelterminal/core";
import { RenderBridge } from "./render-bridge";

describe("RenderBridge frame ownership", () => {
  it("returns a caller-owned frame without closing it", async () => {
    const bridge = new RenderBridge();
    const close = vi.fn();
    const frame = {
      image: { close },
      timestamp: 1,
      width: 10,
      height: 10,
    } as unknown as RenderedFrame;
    const renderFrame = vi.fn().mockResolvedValue(frame);
    Object.assign(bridge, {
      initialized: true,
      videoEngine: { renderFrame },
    });

    const returnedFrame = await bridge.renderFrame(1);

    expect(returnedFrame).toBe(frame);
    expect(close).not.toHaveBeenCalled();
    returnedFrame?.image.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a produced frame when drawing fails before ownership reaches the caller", async () => {
    const bridge = new RenderBridge();
    const close = vi.fn();
    const frame = {
      image: { close },
      timestamp: 1,
      width: 10,
      height: 10,
    } as unknown as RenderedFrame;
    Object.assign(bridge, {
      initialized: true,
      videoEngine: { renderFrame: vi.fn().mockResolvedValue(frame) },
    });
    bridge.setCanvas({
      width: 10,
      height: 10,
      getContext: () => ({
        clearRect: vi.fn(),
        drawImage: () => {
          throw new Error("canvas draw failed");
        },
      }),
    } as unknown as HTMLCanvasElement);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const returnedFrame = await bridge.renderFrame(1);

    expect(returnedFrame).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a rendered frame when the debounced caller discards it", async () => {
    const bridge = new RenderBridge();
    const close = vi.fn();
    const frame = {
      image: { close },
      timestamp: 1,
      width: 10,
      height: 10,
    } as unknown as RenderedFrame;
    const renderFrame = vi
      .spyOn(bridge, "renderFrame")
      .mockResolvedValue(frame);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    bridge.renderFrameDebounced(1);

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(renderFrame).toHaveBeenCalledWith(1);
  });
});
