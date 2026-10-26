import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExternalResourcesTab } from "./ExternalResourcesTab";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("filters the offline directory and exposes only explicit original-site links", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(<ExternalResourcesTab />);
  expect(screen.getAllByText("External resource")).toHaveLength(8);
  fireEvent.click(screen.getByRole("button", { name: "Transitions" }));
  expect(screen.getByText("GL Transitions")).toBeInTheDocument();
  expect(screen.queryByText("RenderComp")).not.toBeInTheDocument();
  const link = screen.getByRole("link");
  expect(link).toHaveAttribute("href", "https://github.com/gl-transitions/gl-transitions");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "css" } });
  expect(screen.getByText("Animista")).toBeInTheDocument();
  expect(screen.queryByText("Google Fonts")).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});
