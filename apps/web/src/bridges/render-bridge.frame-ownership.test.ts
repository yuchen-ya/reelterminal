import { describe, expect, it, vi } from "vitest";
import type { Clip, FrameRenderOptions, MediaItem, Project, RenderedFrame } from "@reelterminal/core";
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

  it("does not paint a computed frame until the caller explicitly presents it", async () => {
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
    const drawImage = vi.fn();
    bridge.setCanvas({
      width: 10,
      height: 10,
      getContext: () => ({
        clearRect: vi.fn(),
        drawImage,
      }),
    } as unknown as HTMLCanvasElement);
    const returnedFrame = await bridge.renderFrame(1);
    expect(returnedFrame).toBe(frame);
    expect(drawImage).not.toHaveBeenCalled();
    bridge.presentFrame(returnedFrame!);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    returnedFrame?.image.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("forwards a snapshot, raster size and decode policy without reading mutable stores", async () => {
    const bridge = new RenderBridge();
    const renderFrame = vi.fn().mockResolvedValue(null);
    Object.assign(bridge, { initialized: true, videoEngine: { renderFrame } });
    const project = { id: "requested-project" } as Project;
    const decodeSourceFrame = vi.fn();

    await bridge.renderFrame(2, { project, width: 320, height: 180, realtime: false, decodeSourceFrame });

    expect(renderFrame).toHaveBeenCalledWith(project, 2, 320, 180, { realtime: false, decodeSourceFrame });
  });

  it("stops superseded source work before the core can fall back to another decoder", async () => {
    const bridge = new RenderBridge();
    let current = true;
    const close = vi.fn();
    const defaultDecode = vi.fn();
    const decodeSourceFrame = vi.fn(async () => {
      current = false;
      return { close } as unknown as ImageBitmap;
    });
    const renderFrame = vi.fn(async (
      _project: Project, _time: number, _width: number, _height: number,
      options: FrameRenderOptions,
    ) => {
      const frame = await options.decodeSourceFrame!({} as Clip, {} as MediaItem, 0, 10, 10);
      if (!frame) defaultDecode();
      return null;
    });
    Object.assign(bridge, { initialized: true, videoEngine: { renderFrame } });

    expect(await bridge.renderFrame(1, {
      isCurrent: () => current,
      decodeSourceFrame,
    })).toBeNull();

    expect(close).toHaveBeenCalledOnce();
    expect(defaultDecode).not.toHaveBeenCalled();
    expect(bridge.getRenderStats().renderErrors).toBe(0);
    await bridge.renderFrame(2, { isCurrent: () => current, decodeSourceFrame });
    expect(renderFrame).toHaveBeenCalledOnce();
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
