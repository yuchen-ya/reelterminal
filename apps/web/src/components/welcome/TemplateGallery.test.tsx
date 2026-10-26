import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TemplateGallery } from "./TemplateGallery";
vi.mock("../../services/project-templates", () => ({ listProjectTemplates: async () => [], loadProjectTemplate: async () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("opens the personal template library from welcome without fetching a cloud gallery", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  render(<TemplateGallery />);
  await screen.findByText(/No saved project templates/);
  expect(screen.queryByText("YouTube Intro")).not.toBeInTheDocument();
  expect(screen.queryByText(/Cloud/)).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});
