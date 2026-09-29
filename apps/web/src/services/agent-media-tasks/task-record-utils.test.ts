import { describe, expect, it } from "vitest";
import {
  pickTaskArtifactFromScan,
  taskHasRequirementText,
  taskOutputDirectory,
} from "./task-record-utils";

describe("stored task helpers", () => {
  it("records an output directory using the workspace path separator", () => {
    expect(taskOutputDirectory("C:\\media-root\\", "amt_1")).toBe(
      "C:\\media-root\\jobs\\amt_1\\output",
    );
    expect(taskOutputDirectory("/home/u/media-root", "amt_1")).toBe(
      "/home/u/media-root/jobs/amt_1/output",
    );
  });

  it("recognizes stored music requirements without confusing an empty task", () => {
    expect(taskHasRequirementText("  instrumental, calm  ")).toBe(true);
    expect(taskHasRequirementText(undefined, { styleHint: "soft piano" })).toBe(true);
    expect(taskHasRequirementText(" ", { targetDurationSeconds: 0 })).toBe(false);
  });

  it("selects a scan result for manual import and reports an empty scan", () => {
    expect(pickTaskArtifactFromScan({ files: [{ path: "/jobs/voice.wav" }] })).toEqual({
      ok: true,
      path: "/jobs/voice.wav",
    });
    expect(pickTaskArtifactFromScan({ files: [] })).toMatchObject({
      ok: false,
      code: "NO_ARTIFACT_FILE",
    });
  });
});
