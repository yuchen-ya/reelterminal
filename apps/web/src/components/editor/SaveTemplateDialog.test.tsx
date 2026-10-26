import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TemplateEngine } from "@reelterminal/core";
import { getActiveProjectRuntimeStore } from "../../stores/project-store";
import { SaveTemplateDialog } from "./SaveTemplateDialog";
const service = vi.hoisted(() => ({ saveProjectTemplate: vi.fn(), updateProjectTemplate: vi.fn() }));
vi.mock("../../services/project-templates", () => service);
beforeEach(() => { vi.clearAllMocks(); getActiveProjectRuntimeStore().getState().createNewProject("Current project"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("saves the current editable project locally without cloud requests", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  service.saveProjectTemplate.mockResolvedValue({});
  const close = vi.fn();
  render(<SaveTemplateDialog isOpen onClose={close} />);
  fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "Saved template" } });
  fireEvent.change(screen.getByLabelText("Tags (comma-separated)"), { target: { value: "demo, brand" } });
  fireEvent.click(screen.getByRole("button", { name: "Save template" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(service.saveProjectTemplate).toHaveBeenCalledWith(getActiveProjectRuntimeStore().getState().getFullProject(), expect.objectContaining({ name: "Saved template", tags: ["demo", " brand"] }));
  expect(fetch).not.toHaveBeenCalled();
  expect(service.updateProjectTemplate).not.toHaveBeenCalled();
});

it("edits template metadata without replacing it with the current project", async () => {
  const template = new TemplateEngine().createFromProject(getActiveProjectRuntimeStore().getState().getFullProject(), {
    name: "Old name", description: "Keep content", category: "custom", placeholders: [], tags: [],
  });
  render(<SaveTemplateDialog isOpen template={template} onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "New name" } });
  fireEvent.click(screen.getByRole("button", { name: "Save template" }));
  await waitFor(() => expect(service.updateProjectTemplate).toHaveBeenCalledWith(template.id, expect.objectContaining({ name: "New name" })));
  expect(service.saveProjectTemplate).not.toHaveBeenCalled();
});
