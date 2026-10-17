import { describe, expect, it } from "vitest";

import { buildAnalysisProgressPlan } from "./analysis-progress";

describe("analysis progress plan", () => {
  it("allocates disjoint, ordered ranges for every requested combination", () => {
    const combinations = [
      ["speechActivity"],
      ["speechActivity", "beatGrid"],
      ["silence", "speechActivity"],
      ["audioSummary", "silence", "beatGrid", "speechActivity"],
      ["videoReview", "audioSummary", "silence", "beatGrid", "speechActivity", "sceneCuts"],
      ["sceneCuts", "blackFrames"],
    ] as const;
    for (const types of combinations) {
      const plan = buildAnalysisProgressPlan(types);
      let previousEnd = 0.1;
      for (const stage of ["videoReview", "audioSummary", "silence", "beatGrid", "speechActivity", "candidates"] as const) {
        const range = plan.range(stage);
        if (!range) continue;
        expect(range.start).toBeGreaterThanOrEqual(previousEnd - 1e-9);
        expect(range.start).toBeLessThan(range.end);
        expect(plan.percent(stage, 0)).toBeCloseTo(range.start, 9);
        expect(plan.percent(stage, 1)).toBeCloseTo(range.end, 9);
        previousEnd = range.end;
      }
      expect(previousEnd).toBeCloseTo(0.98, 9);
    }
  });

  it("keeps progress monotonic when beatGrid is followed by speechActivity", () => {
    const plan = buildAnalysisProgressPlan(["beatGrid", "speechActivity"]);
    expect(plan.percent("beatGrid", 1)).toBeLessThanOrEqual(plan.percent("speechActivity", 0));
    expect(plan.percent("speechActivity", 1)).toBe(0.98);
  });
});
