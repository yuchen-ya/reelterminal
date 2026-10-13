import { describe, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquirePerformanceLock, runPerformanceScenario, type PerformanceRunOptions } from "../harness/performance/driver";
import { combineColdPerformanceResults } from "../harness/performance/result";
import { validateResultDocument } from "../../../../scripts/performance/result-contract.mjs";

const rawOptions = process.env.REELTERMINAL_PERFORMANCE_OPTIONS;
const options = rawOptions ? JSON.parse(rawOptions) as PerformanceRunOptions : null;

(options ? describe : describe.skip)("P2 synthetic performance scenarios (opt-in, serial)", () => {
  test("runs requested scenarios with owned profiles and report-only evidence", async () => {
    const release = await acquirePerformanceLock();
    try {
      for (const scenario of options!.scenarios) {
        for (let repeat = 0; repeat < options!.repeats; repeat++) {
          const launches = options!.cache === "warm" ? 1 : options!.coldLaunches;
          const files: string[] = [];
          for (let index = 0; index < launches; index++) {
            const file = await runPerformanceScenario(scenario, options!, repeat, index);
            files.push(file);
            console.info("PERFORMANCE_RESULT", file);
          }
          if (options!.cache !== "warm") {
            const documents = await Promise.all(files.map(async (file) => ({
              ...JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>,
              action_windows: { artifact: path.basename(file), field: "action_windows" },
            })));
            const summary = combineColdPerformanceResults(documents);
            const validation = validateResultDocument(summary);
            if (!validation.valid) throw new Error(`Cold summary invalid: ${validation.errors.join("; ")}`);
            const file = files[0]!.replace(/\.result\.json$/, ".cold-summary.result.json");
            const json = JSON.stringify(summary, null, 2);
            if (Buffer.byteLength(json) > 10 * 1024 * 1024) {
              await writeFile(file.replace(/\.result\.json$/, ".preflight.json"), JSON.stringify({
                schema: "reelterminal.performance-preflight/v1", status: "invalid",
                reason_codes: ["artifact_budget_exceeded"], constituent_artifacts: files.map((file) => path.basename(file)),
              }, null, 2));
              throw new Error("cold summary exceeded 10 MiB budget");
            }
            await writeFile(file, json);
            console.info("PERFORMANCE_COLD_SUMMARY", file);
          }
        }
      }
    } finally {
      await release();
    }
  }, options ? options.scenarios.length * options.repeats * (options.cache === "warm" ? 1 : options.coldLaunches) * (options.runTimeoutSeconds + 120) * 1000 : 600_000);
});
