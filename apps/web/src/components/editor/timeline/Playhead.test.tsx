import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Playhead } from "./Playhead";

// Regression tests for the dark-theme invisibility bug: the playhead handle
// and line were hardcoded to #1d1d1f, which vanishes on the near-black dark
// timeline. They must instead derive from theme tokens so contrast holds in
// every theme, zoom level, and scroll position.

const renderPlayhead = (
  props: Partial<React.ComponentProps<typeof Playhead>> = {},
) =>
  render(
    <Playhead
      position={5}
      pixelsPerSecond={50}
      scrollX={0}
      headerOffset={170}
      {...props}
    />,
  );

describe("Playhead visibility", () => {
  it("colors the drag handle with the theme accent token, not a hardcoded dark color", () => {
    const { getByTestId, container } = renderPlayhead();
    const handle = getByTestId("playhead-handle");
    expect(handle.style.backgroundColor).toBe("var(--accent)");
    expect(handle.style.boxShadow).toContain("--accent-glow");
    expect(container.innerHTML).not.toContain("#1d1d1f");
  });

  it("colors the vertical line with the theme accent token", () => {
    const { getByTestId } = renderPlayhead();
    const line = getByTestId("playhead-line");
    expect(line.style.backgroundColor).toBe("var(--accent)");
    expect(Number(line.style.width.replace("px", ""))).toBeGreaterThanOrEqual(2);
  });

  it("keeps the pentagon handle shape anchored to the ruler top", () => {
    const { getByTestId } = renderPlayhead();
    const handle = getByTestId("playhead-handle");
    expect(handle.style.top).toBe("0px");
    expect(handle.style.clipPath).toContain("polygon");
  });

  it.each([10, 50, 500])(
    "renders handle and line at zoom level pixelsPerSecond=%i",
    (pixelsPerSecond) => {
      const { getByTestId } = renderPlayhead({ pixelsPerSecond });
      expect(getByTestId("playhead-handle")).toBeTruthy();
      expect(getByTestId("playhead-line")).toBeTruthy();
    },
  );

  it("stays rendered while the playhead is scrolled inside the viewport", () => {
    const { getByTestId } = renderPlayhead({ position: 5, scrollX: 120 });
    expect(getByTestId("playhead")).toBeTruthy();
  });

  it("stays on top of timeline content and ignores pointer events", () => {
    const { getByTestId } = renderPlayhead();
    const wrapper = getByTestId("playhead");
    expect(wrapper.className).toContain("z-50");
    expect(wrapper.className).toContain("pointer-events-none");
  });

  it("renders nothing when scrolled out of view", () => {
    const { container } = renderPlayhead({ position: 0.5, scrollX: 500 });
    expect(container.innerHTML).toBe("");
  });
});
