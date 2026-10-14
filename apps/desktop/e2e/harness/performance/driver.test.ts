import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ARTIFACTS_DIR } from "../paths";
import type { CaptureReport } from "../../../../web/src/performance";
import type { PerfStopReply } from "../../../src/shared/performance-contract";
import type { Page } from "playwright-core";
import { acquirePerformanceLock, captureComplete, markerMatches, unexpectedPointerMoves, dragTo, type DragTiming, type RendererWindowEvidence } from "./driver";

async function expectMissing(filePath: string): Promise<void> {
  await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

function report(status: "complete" | "incomplete", drops: Partial<CaptureReport["drops"]> = {}): CaptureReport {
  return {
    status,
    drops: {
      eventsDropped: 0,
      criticalEndpointsDropped: 0,
      samplesDropped: 0,
      labelsDropped: 0,
      truncatedFields: 0,
      ...drops,
    },
  } as CaptureReport;
}

function mainReply(status: "complete" | "incomplete", eventsDropped = 0): PerfStopReply {
  return {
    ok: true,
    mainCapture: { status, eventsDropped },
  } as PerfStopReply;
}

function windowEvidence(overrides: Partial<RendererWindowEvidence> = {}): RendererWindowEvidence {
  return {
    report: report("complete"),
    firstInputUs: null,
    intervalsMs: [],
    hiddenDuringAction: false,
    main: mainReply("complete"),
    ...overrides,
  };
}

describe("performance driver helpers", () => {
  it("optional drag timing preserves the same browser calls, pointer stimulus and eight rAF waits", async () => {
    let lastCalls: string[] = [];
    const run = async (timing?: DragTiming, hitState: "good" | "transient" | "blocked" = "good") => {
      const calls: string[] = [];
      lastCalls = calls;
      let hitReads = 0;
      const target = {
        page: () => page,
        scrollIntoViewIfNeeded: async () => { calls.push("scrollIntoView"); },
        boundingBox: async () => { calls.push("box"); return { x: 100, y: 20, width: 100, height: 32 }; },
        getAttribute: async () => "clip",
        evaluate: async () => { calls.push("style"); return { transform: "", width: "100px" }; },
      };
      const page = {
        locator: () => ({ first: () => target }),
        getByTestId: () => ({ evaluate: async () => { calls.push("scrollLeft"); } }),
        evaluate: async (fn: Function) => {
          const source = fn.toString(); calls.push(source);
          if (source.includes("requestAnimationFrame")) {
            // Execute the serialized callback in a browser-like realm. Node
            // imports rewritten by Vite must never leak into page.evaluate.
            return runInNewContext(`(${source})()`, {
              performance: { now: () => 0 },
              requestAnimationFrame: (callback: () => void) => callback(),
            });
          }
          if (source.includes("elementFromPoint")) {
            hitReads++;
            return hitState === "good" || (hitState === "transient" && hitReads > 1) ? "clip" : "other";
          }
          if (source.includes("return evidence.points")) return Array.from({ length: 7 }, (_, index) => ({ x: 150 + index * 4, y: 28 }));
        },
        mouse: {
          move: async (x: number, y: number) => { calls.push(`move:${x},${y}`); },
          down: async () => { calls.push("down"); },
          up: async () => { calls.push("up"); },
        },
        screenshot: async () => { calls.push("diagnostic"); throw new Error("diagnostic unavailable"); },
        waitForFunction: async (fn: Function, _args: unknown, options: { timeout: number }) => {
          if (fn.toString().includes("elementFromPoint")) {
            calls.push("wait:hit");
            expect(options.timeout).toBe(5000);
            if (hitState === "blocked") throw new Error("input target never became actionable");
          } else calls.push("verify");
        },
      };
      await dragTo(page as unknown as Page, "clip", 24, 5000, false, timing);
      return calls;
    };
    const timing: DragTiming = { geometry_ms: 0, input_driver_ms: 0, verification_ms: 0, raf_wait_ms: 0, raf_browser_ms: 0, raf_max_browser_ms: 0, raf_count: 0 };
    expect(await run(timing)).toEqual(await run());
    expect(timing.raf_count).toBe(8);
    expect(Object.values(timing).every(value => Number.isFinite(value) && value >= 0)).toBe(true);
    const transientCalls = await run(undefined, "transient");
    expect(transientCalls.indexOf("wait:hit")).toBeLessThan(transientCalls.indexOf("down"));
    await expect(run(undefined, "blocked")).rejects.toThrow("input target never became actionable");
    expect(lastCalls).not.toContain("down");
    expect(lastCalls).toContain("diagnostic");
  });
  it("rejects unplanned pointer coordinates while allowing browser pixel rounding", () => {
    const planned = [{ x: 100.4, y: 30.2 }, { x: 110.8, y: 30.2 }];
    expect(unexpectedPointerMoves([{ x: 100, y: 30 }, { x: 111, y: 30 }], planned)).toEqual([]);
    expect(unexpectedPointerMoves([{ x: 80, y: 30 }, { x: 110, y: 50 }], planned)).toHaveLength(2);
  });
  it("accepts the target marker within tolerance and rejects wrong or stale pixels", () => {
    const target = [200, 60, 80] as const;
    expect(markerMatches([208, 52, 80, 255], target)).toBe(true);
    expect(markerMatches([209, 60, 80, 255], target)).toBe(false);
    expect(markerMatches([34, 102, 167, 255], target)).toBe(false);
    expect(markerMatches([200, 60], target)).toBe(false);
    expect(markerMatches([200, 60, 80], [200, 60])).toBe(false);
  });

  it("accepts a complete visible capture with no dropped events", () => {
    expect(captureComplete(windowEvidence())).toBe(true);
  });

  it("rejects a capture that was hidden during the action", () => {
    expect(captureComplete(windowEvidence({ hiddenDuringAction: true }))).toBe(false);
  });

  it("rejects incomplete main and renderer captures", () => {
    expect(captureComplete(windowEvidence({ main: mainReply("incomplete") }))).toBe(false);
    expect(captureComplete(windowEvidence({ report: report("incomplete") }))).toBe(false);
  });

  it("rejects renderer event and semantic endpoint drops even if status is complete", () => {
    expect(captureComplete(windowEvidence({
      report: report("complete", { eventsDropped: 1 }),
    }))).toBe(false);
    expect(captureComplete(windowEvidence({
      report: report("complete", { criticalEndpointsDropped: 1 }),
    }))).toBe(false);
  });

  it("rejects main-process event drops even if status is complete", () => {
    expect(captureComplete(windowEvidence({ main: mainReply("complete", 1) }))).toBe(false);
  });

  it("exclusively locks performance runs and removes the lock on release", async () => {
    const lockPath = path.join(ARTIFACTS_DIR, "performance.lock");
    await expectMissing(lockPath);

    let release = await acquirePerformanceLock();
    try {
      expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual({ pid: process.pid });

      const concurrent = await Promise.allSettled([acquirePerformanceLock()]);
      expect(concurrent[0]?.status).toBe("rejected");
      if (concurrent[0]?.status === "fulfilled") await concurrent[0].value();

      await release();
      release = async () => {};
      await expectMissing(lockPath);

      const reacquired = await acquirePerformanceLock();
      await reacquired();
      await expectMissing(lockPath);
    } finally {
      await release();
    }
  });
});
