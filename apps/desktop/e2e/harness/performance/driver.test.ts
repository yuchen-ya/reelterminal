import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ARTIFACTS_DIR } from "../paths";
import type { CaptureReport } from "../../../../web/src/performance";
import type { PerfStopReply } from "../../../src/shared/performance-contract";
import { acquirePerformanceLock, captureComplete, markerMatches, type RendererWindowEvidence } from "./driver";

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
