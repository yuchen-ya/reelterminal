/**
 * Absolute-path boundary tests: the explicit
 * per-verb path-field map, rejection wording, and `~` refusal. The
 * workflow `$ref`-fed relative path rejection is pinned end-to-end in
 * run-cli.test.ts; here the boundary itself is exercised in isolation.
 */
import { describe, expect, it } from "vitest";
import {
  PATH_FIELDS,
  findRelativePathViolations,
  relativePathMessage,
} from "../src/paths";

describe("PATH_FIELDS: the explicit per-verb path-field map", () => {
  it("covers media.import.path, verify.artifact.path + compare.referencePath, project.open/save path", () => {
    expect(PATH_FIELDS).toEqual({
      "media.import": ["path"],
      "verify.artifact": ["path", "compare.referencePath"],
      "project.open": ["path"],
      "project.save": ["path"],
    });
  });

  it("non-path verbs have no path fields", () => {
    expect(PATH_FIELDS["edit.apply"]).toBeUndefined();
    expect(PATH_FIELDS["timeline.get"]).toBeUndefined();
  });
});

describe("findRelativePathViolations", () => {
  it("accepts absolute path values untouched", () => {
    expect(findRelativePathViolations("media.import", { path: "/media/input.mp4" })).toEqual([]);
    expect(
      findRelativePathViolations("verify.artifact", {
        path: "/artifacts/out.mp4",
        compare: { referencePath: "/artifacts/ref.png", timeSec: 0, mode: "similar" },
      }),
    ).toEqual([]);
  });

  it("rejects literal relative values with the field named", () => {
    const violations = findRelativePathViolations("media.import", { path: "relative/input.mp4" });
    expect(violations).toHaveLength(1);
    expect(violations[0].field).toBe("path");
  });

  it("rejects relative values nested under compare.referencePath", () => {
    const violations = findRelativePathViolations("verify.artifact", {
      path: "/artifacts/out.mp4",
      compare: { referencePath: "rel/ref.png", timeSec: 0, mode: "similar" },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].field).toBe("compare.referencePath");
  });

  it("rejects `~` and `~/...` without expanding it", () => {
    for (const bad of ["~", "~/Movies/input.mp4"]) {
      const violations = findRelativePathViolations("project.open", { path: bad });
      expect(violations).toHaveLength(1);
    }
  });

  it("ignores absent optional path fields", () => {
    expect(findRelativePathViolations("verify.artifact", { path: "/a/out.mp4" })).toEqual([]);
    expect(findRelativePathViolations("project.save", {})).toEqual([]);
  });

  it("flags non-string path values (they would fail the facade anyway)", () => {
    const violations = findRelativePathViolations("media.import", { path: 42 });
    expect(violations).toHaveLength(1);
  });
});

describe("relativePathMessage wording", () => {
  it("names the verb, field, the offending value, the cwd rule and the `~` rule", () => {
    const message = relativePathMessage("media.import", {
      field: "path",
      value: "relative/input.mp4",
    });
    expect(message).toContain("media.import");
    expect(message).toContain("params.path");
    expect(message).toContain('"relative/input.mp4"');
    expect(message).toContain("absolute");
    expect(message).toContain("never");
    expect(message).toContain("cwd");
    expect(message).toContain("'~'");
  });
});
