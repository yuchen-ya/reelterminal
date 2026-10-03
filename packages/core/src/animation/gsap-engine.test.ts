import { describe, expect, it } from "vitest";
import { GSAPAnimationEngine } from "./gsap-engine";

describe("motion path editing", () => {
  it("samples an enabled clip path and releases it on disposal", () => {
    const engine = new GSAPAnimationEngine();
    engine.setMotionPath("clip", {
      enabled: true,
      pathType: "linear",
      points: [{ x: 0, y: 0, time: 0 }, { x: 100, y: 50, time: 1 }],
      showPath: true,
      autoOrient: false,
      alignOrigin: [0.5, 0.5],
    });

    expect(engine.samplePositionAtTime("clip", 5, 10)).toEqual({ x: 50, y: 25 });
    engine.dispose();
    expect(engine.samplePositionAtTime("clip", 5, 10)).toBeNull();
  });
});
