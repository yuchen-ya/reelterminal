import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ARTIFACTS_DIR } from "../paths";
import { acquirePerformanceLock, markerMatches } from "./driver";

async function expectMissing(filePath: string): Promise<void> {
  await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
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
