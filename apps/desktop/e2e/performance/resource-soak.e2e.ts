import { describe, test } from "vitest";
import { acquirePerformanceLock, type PerformanceRunOptions } from "../harness/performance/driver";
import { runResourceSoakScenario } from "../harness/performance/resource-soak";

const raw = process.env.REELTERMINAL_RESOURCE_SOAK_OPTIONS;
const options = raw ? JSON.parse(raw) as PerformanceRunOptions : null;
(options ? describe : describe.skip)("resource soak (explicit opt-in, serial)", () => {
  test("fixed resources return after editing and history preview", async () => {
    const release = await acquirePerformanceLock();
    try {
      for (const scenario of options!.scenarios) {
        if (scenario !== "R01" && scenario !== "R02") throw new Error("resource soak requires R01 or R02");
        await runResourceSoakScenario(scenario, options!, 0);
      }
    } finally { await release(); }
  }, options ? options.scenarios.length * (options.runTimeoutSeconds + 120) * 1000 : 600_000);
});
