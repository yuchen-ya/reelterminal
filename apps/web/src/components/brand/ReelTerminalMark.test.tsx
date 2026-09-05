import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { ReelTerminalMark } from "./ReelTerminalMark";

describe("ReelTerminalMark", () => {
  it("renders an svg with the expected viewBox and size", () => {
    const { container } = render(<ReelTerminalMark size={48} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("viewBox")).toBe("12 9.75 40 40");
    expect(svg?.getAttribute("width")).toBe("48");
    expect(svg?.getAttribute("height")).toBe("48");
  });

  it("renders two tracks and one terminal", () => {
    const { container } = render(<ReelTerminalMark />);
    expect(container.querySelectorAll("rect").length).toBe(3);
    expect(container.querySelectorAll("circle").length).toBe(0);
    expect(container.querySelectorAll("line").length).toBe(0);
  });
});
