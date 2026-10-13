import { describe, expect, it, vi } from "vitest";
import { beginPerfOperation, endPerfOperation, getPerfSink, NOOP_SINK } from "@reelterminal/core";
import { CaptureController } from "./capture-controller";
import {
  installProductPerformanceCaptureBridge,
  parseProductCaptureStartRequest,
  PRODUCT_PERFORMANCE_CAPTURE_GLOBAL,
} from "./product-capture-bridge";
import type { ProductPerformanceResourceSnapshot } from "./resource-snapshot";

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

  it("reads a resource snapshot while capture remains off", async () => {
    const snapshot = {
      schemaVersion: 1,
      capturedAtUs: 42,
      history: {
        actionUndo: 0,
        actionRedo: 0,
        templateUndo: 0,
        templateRedo: 0,
        redoJournal: 0,
        changeJournalEntries: 0,
        changeJournalRevisions: 0,
      },
      workspace: {
        runtimes: 0,
        queuedWrites: 0,
        pendingWrites: 0,
        initializingRuntimeCount: 0,
        editedWorkspaceCount: 0,
        activeWriteDrainCount: 0,
        queuedCommandCount: 0,
        failedWriteCount: 0,
        activeWorkspace: false,
      },
      autoSave: {
        status: "idle",
        automaticSaveRunning: false,
        pendingRevision: false,
        scheduledSave: false,
        queuedSaveOperations: 0,
      },
      fonts: {
        projectLeases: 0,
        leasedFaces: 0,
        projectFaces: 0,
        documentFaces: null,
      },
      media: {
        ownedBlobUrls: 0,
        motionImageBitmapCacheEntries: 0,
        motionVideoElementCacheEntries: 0,
        previewVideoCacheEntries: 0,
        previewImageBitmapCacheEntries: 0,
        allBlobUrls: null,
        decoderContexts: null,
        webWorkers: null,
      },
    } satisfies ProductPerformanceResourceSnapshot;
    const readResources = vi.fn(async () => snapshot);
    const controller = new CaptureController();
    const api = installProductPerformanceCaptureBridge(
      {} as Window,
      controller,
      readResources,
    );

    await expect(api.readResources()).resolves.toBe(snapshot);
    expect(readResources).toHaveBeenCalledOnce();
    expect(api.activeRunId).toBeNull();
    expect(getPerfSink()).toBe(NOOP_SINK);
  });

  it("returns live product resource counts and explicit unavailable values with capture off", async () => {
    const api = installProductPerformanceCaptureBridge({} as Window, new CaptureController());

    const snapshot = await api.readResources();

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.history).toMatchObject({
      actionUndo: expect.any(Number),
      actionRedo: expect.any(Number),
      changeJournalEntries: expect.any(Number),
    });
    expect(snapshot.workspace).toMatchObject({
      queuedWrites: 0,
      pendingWrites: 0,
      runtimes: expect.any(Number),
    });
    expect(snapshot.autoSave.queuedSaveOperations).toBe(0);
    expect(snapshot.media).toMatchObject({
      ownedBlobUrls: expect.any(Number),
      previewVideoCacheEntries: expect.any(Number),
      previewImageBitmapCacheEntries: expect.any(Number),
      decoderContexts: null,
      webWorkers: null,
    });
    expect(api.activeRunId).toBeNull();
    expect(getPerfSink()).toBe(NOOP_SINK);
  });
});
