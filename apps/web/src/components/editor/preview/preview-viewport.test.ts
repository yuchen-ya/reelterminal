import { describe, expect, it } from "vitest";
import { computePreviewFrameSize, previewFrameOverflows } from "./preview-viewport";

describe("preview viewport geometry", () => {
  const project = { width: 1920, height: 1080 };

  it("fits one frame to the observed content box without subtracting padding again", () => {
    const frame = computePreviewFrameSize({
      viewport: { width: 1000, height: 700 },
      project,
      zoom: { mode: "fit" },
    });
    expect(frame.width).toBeCloseTo(1000);
    expect(frame.height).toBeCloseTo(562.5);
  });

  it("uses the project pixel size for fixed zoom", () => {
    expect(computePreviewFrameSize({
      viewport: { width: 1000, height: 700 },
      project,
      zoom: { mode: "percent", value: 100 },
    })).toEqual({ width: 1920, height: 1080 });
  });

  it("fits two side-by-side frames while preserving each frame's aspect ratio", () => {
    const frame = computePreviewFrameSize({
      viewport: { width: 1000, height: 700 },
      project,
      zoom: { mode: "fit" },
      columns: 2,
    });
    expect(frame.width).toBeCloseTo(1000);
    expect(frame.height).toBeCloseTo(281.25);
  });

  it("reports fixed zoom overflow so the player can enable scrolling", () => {
    const frame = computePreviewFrameSize({
      viewport: { width: 1000, height: 700 },
      project,
      zoom: { mode: "percent", value: 150 },
    });
    expect(previewFrameOverflows(frame, { width: 1000, height: 700 })).toBe(true);
    expect(previewFrameOverflows({ width: 800, height: 450 }, { width: 1000, height: 700 })).toBe(false);
  });
});
