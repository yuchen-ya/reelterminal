import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EffectsBridge,
  disposeEffectsBridge,
  getEffectsBridge,
  getEffectsBridgeAsync,
} from "./effects-bridge";

afterEach(() => {
  disposeEffectsBridge();
  vi.restoreAllMocks();
});

describe("EffectsBridge singleton initialization", () => {
  it("coalesces sync and async callers onto one in-flight initialization", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const initialize = vi
      .spyOn(EffectsBridge.prototype, "initialize")
      .mockImplementation(() => pending);

    const first = getEffectsBridge();
    const second = getEffectsBridge();
    const asyncBridge = getEffectsBridgeAsync();

    expect(first).toBe(second);
    expect(initialize).toHaveBeenCalledOnce();
    finish();
    await expect(asyncBridge).resolves.toBe(first);
  });

  it("clears a failed promise so a later call can retry", async () => {
    const initialize = vi
      .spyOn(EffectsBridge.prototype, "initialize")
      .mockRejectedValueOnce(new Error("no renderer"))
      .mockResolvedValueOnce(undefined);

    await expect(getEffectsBridgeAsync()).rejects.toThrow("no renderer");
    await expect(getEffectsBridgeAsync()).resolves.toBeInstanceOf(EffectsBridge);
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it("backs off repeated best-effort sync initialization after a failure", async () => {
    const initialize = vi
      .spyOn(EffectsBridge.prototype, "initialize")
      .mockRejectedValue(new Error("no renderer"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    getEffectsBridge();
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    getEffectsBridge();

    expect(initialize).toHaveBeenCalledOnce();
  });
});
