import type { JSX } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { InspectorTabErrorBoundary } from "./InspectorTabErrorBoundary";

function Boom(): JSX.Element {
  throw new Error("boom");
}

describe("InspectorTabErrorBoundary", () => {
  it("renders a fallback when a child throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <InspectorTabErrorBoundary>
        <Boom />
      </InspectorTabErrorBoundary>,
    );
    expect(screen.getByText(/hit an error/i)).toBeInTheDocument();
    // The inspector has no tabs anymore; recovery is the clip-reselect remount.
    expect(screen.getByText(/select another clip and back/i)).toBeInTheDocument();
    spy.mockRestore();
  });

  it("renders children when they do not throw", () => {
    render(
      <InspectorTabErrorBoundary>
        <div>ok</div>
      </InspectorTabErrorBoundary>,
    );
    expect(screen.getByText("ok")).toBeInTheDocument();
  });

  it("clears the error when remounted with a new key (the clip-reselect path)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <InspectorTabErrorBoundary key="clip-1">
        <Boom />
      </InspectorTabErrorBoundary>,
    );
    expect(screen.getByText(/hit an error/i)).toBeInTheDocument();

    // InspectorPanel mounts the boundary with key={clipId}; a new key is a
    // fresh instance, so the fallback must not leak into the next clip.
    rerender(
      <InspectorTabErrorBoundary key="clip-2">
        <div>ok</div>
      </InspectorTabErrorBoundary>,
    );
    expect(screen.getByText("ok")).toBeInTheDocument();
    expect(screen.queryByText(/hit an error/i)).not.toBeInTheDocument();
    spy.mockRestore();
  });
});
