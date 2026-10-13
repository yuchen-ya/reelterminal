import { describe, test } from "vitest";
import { acquirePerformanceLock, type PerformanceRunOptions } from "../harness/performance/driver";
import { runPlaybackAvScenario } from "../harness/performance/playback-av";

const enabled = process.env.REELTERMINAL_PLAYBACK_AV_E2E === "1";
const rawOptions = process.env.REELTERMINAL_PERFORMANCE_OPTIONS;
const options = rawOptions ? JSON.parse(rawOptions) as PerformanceRunOptions : null;

(enabled ? describe : describe.skip)("A01 synthetic playback AV (explicit opt-in, serial)", () => {
  test("writes verified production decode, commit, scheduling, and timestamp evidence", async () => {
    if (!options?.scenarios.includes("A01")) {
      throw new Error("Set REELTERMINAL_PERFORMANCE_OPTIONS to validated options selecting A01");
    }
    const release = await acquirePerformanceLock();
    try {
      for (let repeat = 0; repeat < options.repeats; repeat++) {
        await runPlaybackAvScenario(options, repeat);
      }
    } finally {
      await release();
    }
  }, options ? options.repeats * (options.runTimeoutSeconds + 120) * 1000 : 600_000);
});
