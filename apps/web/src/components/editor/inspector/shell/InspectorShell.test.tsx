import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { InspectorClipHeader } from "./InspectorClipHeader";

describe("InspectorClipHeader", () => {
  it("renders name, duration and type", () => {
    render(<InspectorClipHeader name="Scenic Clip" durationSeconds={15} typeLabel="video" />);
    expect(screen.getByText("Scenic Clip")).toBeInTheDocument();
    expect(screen.getByText("15.00s")).toBeInTheDocument();
    expect(screen.getByText("video")).toBeInTheDocument();
  });
});
