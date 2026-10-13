import { describe, expect, it } from "vitest";
import { createActionWindowArtifactParts } from "./action-window-artifacts";

describe("action window artifact parts", () => {
  it("keeps each ordered JSON part within its byte limit and returns file references", () => {
    const windows = [
      { operation: 1, events: ["a".repeat(45)] },
      { operation: 2, events: ["b".repeat(45)] },
      { operation: 3, events: ["c".repeat(45)] },
    ];
    const bundle = createActionWindowArtifactParts(windows, "t03-run", 180);

    expect(bundle.parts.length).toBeGreaterThan(1);
    expect(bundle.parts.every((part) => Buffer.byteLength(part.content) <= 180)).toBe(true);
    expect(bundle.descriptor.artifacts).toEqual(bundle.parts.map(({ reference }) => reference));
    expect(bundle.parts.map(({ reference }) => reference.artifact)).toEqual([
      "t03-run.action-windows-0001.json",
      "t03-run.action-windows-0002.json",
      "t03-run.action-windows-0003.json",
    ]);
    expect(bundle.parts.map(({ reference }) => reference.window_start)).toEqual([0, 1, 2]);
    expect(bundle.parts.flatMap((part) => JSON.parse(part.content).action_windows)).toEqual(windows);
  });

  it("fails explicitly when one window cannot fit in a part", () => {
    expect(() => createActionWindowArtifactParts([{ report: "x".repeat(200) }], "t03-run", 100))
      .toThrow(/action window 0 requires .* exceeding the 100-byte part limit/);
  });
});
