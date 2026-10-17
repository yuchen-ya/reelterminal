import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTextClipWithSubjectMask } from "./frame-compositor";
import { titleEngine, type TextClip } from "@reelterminal/core";

afterEach(() => {
  vi.restoreAllMocks();
});

// The comparison/behind-subject composite path must forward the project
// layout size to the shared title renderer, or 4K-project text renders 4x
// too large on a downscaled preview canvas (same contract as the direct
// renderTextClipToCanvas path and the export renderer).
describe("frame compositor text layout scaling", () => {
  it("forwards the project layout size through the subject-mask path", async () => {
    const renderedCanvas = document.createElement("canvas");
    const renderText = vi.spyOn(titleEngine, "renderText").mockReturnValue({
      canvas: renderedCanvas,
      width: 960,
      height: 540,
      textMetrics: { width: 100, height: 40, lines: [] },
    });
    const clip: TextClip = {
      id: "compositor-text",
      trackId: "text-track",
      startTime: 0,
      duration: 5,
      text: "Comparison title",
      style: {
        fontFamily: "Inter",
        fontSize: 164,
        fontWeight: 700,
        fontStyle: "normal",
        color: "#ffffff",
        textAlign: "center",
        verticalAlign: "middle",
        lineHeight: 1.2,
        letterSpacing: 0,
      },
      transform: {
        position: { x: 0.5, y: 0.5 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      keyframes: [],
    };

    await renderTextClipWithSubjectMask(
      { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D,
      clip,
      960,
      540,
      1.25,
      null,
      false,
      "test:compositor",
      { width: 3840, height: 2160 },
    );

    expect(renderText).toHaveBeenCalledWith(
      clip,
      960,
      540,
      1.25,
      { width: 3840, height: 2160 },
    );
  });
});
