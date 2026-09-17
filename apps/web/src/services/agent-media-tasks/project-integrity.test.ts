import { describe, expect, it } from "vitest";
import { checkTargetProjectAvailability } from "./project-integrity";

describe("checkTargetProjectAvailability", () => {
  it("passes when the target project is still in the index", () => {
    expect(checkTargetProjectAvailability("proj-1", ["proj-1", "proj-2"])).toEqual({
      ok: true,
      projectId: "proj-1",
    });
    expect(checkTargetProjectAvailability("proj-2", new Set(["proj-1", "proj-2"]))).toEqual({
      ok: true,
      projectId: "proj-2",
    });
  });

  it("fails with TARGET_PROJECT_MISSING when the project was deleted", () => {
    const check = checkTargetProjectAvailability("proj-gone", ["proj-1"]);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("TARGET_PROJECT_MISSING");
    expect(check.message).toContain("proj-gone");
    expect(check.message).toContain("不会转投其他项目");
  });

  it("fails on an empty index", () => {
    expect(checkTargetProjectAvailability("proj-1", []).ok).toBe(false);
    expect(checkTargetProjectAvailability("proj-1", new Set()).ok).toBe(false);
  });
});
