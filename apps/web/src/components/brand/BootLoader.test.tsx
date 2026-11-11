import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { BootLoader } from "./BootLoader";

describe("BootLoader", () => {
  it("renders the animated mark, wordmark and message as a status", () => {
    const { container } = render(<BootLoader message="Loading editor…" />);
    const status = screen.getByRole("status");
    expect(status.className).toContain("rt-boot");
    expect(status.className).not.toContain("rt-boot--standalone");
    expect(container.querySelectorAll("svg rect").length).toBe(3);
    // The sweeping playhead and the terminal bar are one element.
    expect(container.querySelector(".rt-boot__playhead")).toBeNull();
    expect(container.querySelector(".rt-boot__cursor")).not.toBeNull();
    expect(screen.getByText("Loading editor…")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("supports the standalone pre-theme variant without a message", () => {
    render(<BootLoader standalone />);
    expect(screen.getByRole("status").className).toContain("rt-boot--standalone");
  });
});
