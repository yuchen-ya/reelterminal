import { describe, expect, it } from "vitest";
import { beginPerfOperation, endPerfOperation, getPerfSink, NOOP_SINK } from "@reelterminal/core";
import { CaptureController } from "./capture-controller";
import {
  installProductPerformanceCaptureBridge,
  parseProductCaptureStartRequest,
  PRODUCT_PERFORMANCE_CAPTURE_GLOBAL,
} from "./product-capture-bridge";

describe("product performance capture bridge", () => {
  it("starts and stops the controller from the product module realm", () => {
    const target = {} as Window;
    const controller = new CaptureController();
    const api = installProductPerformanceCaptureBridge(target, controller);

    expect(Object.getOwnPropertyDescriptor(target, PRODUCT_PERFORMANCE_CAPTURE_GLOBAL)).toMatchObject({
      enumerable: false,
      writable: false,
    });
    expect(api.activeRunId).toBeNull();

    const handle = api.start({ mode: "counts", runId: "product-run" });
    expect(handle.runId).toBe("product-run");
    expect(api.activeRunId).toBe("product-run");
    expect(getPerfSink().enabled).toBe(true);
    expect(api.committedFrameCount).toBe(0);
    expect(api.completedGestureFrameCount).toBe(0);
    const operation = beginPerfOperation("product.test.operation");
    expect(api.pendingSpanCount).toBe(1);
    endPerfOperation(operation, "ok");
    expect(api.pendingSpanCount).toBe(0);

    const report = api.stop();
    expect(report.runId).toBe("product-run");
    expect(api.activeRunId).toBeNull();
    expect(api.lastReport).toBe(report);
    expect(getPerfSink()).toBe(NOOP_SINK);
  });

  it("rejects non-serializable or unknown options before starting capture", () => {
    const api = installProductPerformanceCaptureBridge({} as Window, new CaptureController());

    expect(() => api.start({ mode: "light", visibilityCheck: () => true })).toThrow("unknown fields");
    expect(() => api.start({ mode: "off" })).toThrow("mode is invalid");
    expect(() => api.start({ mode: "light", runId: "C:\\private\\project" })).toThrow("runId is invalid");
    expect(api.activeRunId).toBeNull();
    expect(getPerfSink()).toBe(NOOP_SINK);
  });

  it("accepts bounded sample controls used by calibrated performance probes", () => {
    expect(parseProductCaptureStartRequest({
      mode: "light",
      budgets: {
        captureSeconds: 30,
        inputSampleEveryN: 1,
        frameSampleEveryN: 1,
        memorySampleIntervalSeconds: 0,
      },
    })).toEqual({
      mode: "light",
      budgets: {
        captureSeconds: 30,
        inputSampleEveryN: 1,
        frameSampleEveryN: 1,
        memorySampleIntervalSeconds: 0,
      },
    });
    expect(() => parseProductCaptureStartRequest({ mode: "trace", budgets: { captureSeconds: 121 } })).toThrow();
    expect(() => parseProductCaptureStartRequest({ mode: "light", budgets: { inputSampleEveryN: 0 } })).toThrow();
  });
});
