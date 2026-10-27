import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VideoCanvasStage, type VideoCanvasStageProps } from "./VideoCanvasStage";

afterEach(cleanup);
it("previews the selected drawing tool, including an arrowhead while dragging backwards", () => {
  const noop = vi.fn();
  const props: VideoCanvasStageProps = {
    stageRef: { current: null }, videoRef: { current: null }, videoUrl: "blob:video",
    mediaStatus: "ready", videoReady: true, videoTime: 0, videoSize: { w: 100, h: 100 },
    svgViewBox: "0 0 100 100", activeMarker: null, activeAnnotations: [], selectedAnchorId: null,
    anchors: [], isDrawing: true, draftStart: { x: 0.8, y: 0.7 }, draftCurrent: { x: 0.2, y: 0.3 },
    videoErrorMsg: null, drawTool: "arrow", onPointerDown: noop, onPointerMove: noop, onPointerUp: noop,
    onLoadedMetadata: noop, onDurationChange: noop, onTimeUpdate: noop, onSeeked: noop,
    onPlay: noop, onPause: noop, onEnded: noop, onError: noop,
  };
  const { rerender } = render(<VideoCanvasStage {...props} />);
  const arrow = screen.getByTestId("video-draft-arrow");
  expect(arrow.tagName).toBe("line");
  expect(arrow).toHaveAttribute("x1", "80");
  expect(arrow).toHaveAttribute("x2", "20");
  expect(arrow).toHaveAttribute("marker-end", "url(#vfw-arrowhead)");
  expect(screen.queryByTestId("video-draft-box")).toBeNull();
  rerender(<VideoCanvasStage {...props} drawTool="box" />);
  expect(screen.getByTestId("video-draft-box").tagName).toBe("rect");
  expect(screen.queryByTestId("video-draft-arrow")).toBeNull();
});
