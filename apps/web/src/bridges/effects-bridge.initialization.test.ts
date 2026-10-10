import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EffectsBridge,
  disposeEffectsBridge,
  getEffectsBridge,
  getEffectsBridgeAsync,
  setBackgroundInitRetryDelayForTests,
} from "./effects-bridge";

afterEach(() => {
  disposeEffectsBridge();
  setBackgroundInitRetryDelayForTests();
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
    // A window far longer than any test run keeps the suppression assertion
    // deterministic: with the production 1s window a slow runner could let
    // the backoff expire mid-test and legitimately start a second init.
    setBackgroundInitRetryDelayForTests(60_000);
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

  it("does not return an orphan initialized across a concurrent dispose", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const initialize = vi
      .spyOn(EffectsBridge.prototype, "initialize")
      .mockImplementation(async function (this: EffectsBridge) {
        await gate;
        (this as unknown as { initialized: boolean }).initialized = true;
      });
    const dispose = vi.spyOn(EffectsBridge.prototype, "dispose");

    const inFlight = getEffectsBridgeAsync();
    disposeEffectsBridge();
    release();

    // The orphan is torn down and a fresh, current bridge replaces it.
    const bridge = await inFlight;
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(bridge.isInitialized()).toBe(true);
    expect(bridge).toBe(getEffectsBridge());
  });
});
