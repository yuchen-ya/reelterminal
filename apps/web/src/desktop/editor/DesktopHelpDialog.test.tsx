import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopHelpDialog } from "./DesktopHelpDialog";

afterEach(cleanup);

it("offers Quick Start before a project is open and searches the shipped manual", () => {
  render(<DesktopHelpDialog open onOpenChange={vi.fn()} canTour={false} />);
  expect(screen.getByRole("heading", { name: "Quick Start" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Interface tour" })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Search tools, steps, or shortcuts" }), { target: { value: "export" } });
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  expect(screen.getByRole("heading", { name: "Export" })).toBeInTheDocument();
  expect(screen.getByText(/Desktop opens the settings dialog directly/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "xyz-no-topic" } });
  expect(screen.getByText("No topics found. Try a shorter keyword.")).toBeInTheDocument();
});
