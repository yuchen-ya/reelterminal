import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TemplateEngine } from "@reelterminal/core";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { createProjectStore, activateProjectStore, useProjectStore } from "../../../stores/project-store";
import { TemplatesTab } from "./TemplatesTab";

const service = vi.hoisted(() => ({ listProjectTemplates: vi.fn(), loadProjectTemplate: vi.fn(), inspectProjectTemplate: vi.fn(async () => []), createProjectFromTemplate: vi.fn() }));
vi.mock("../../../services/project-templates", () => service);
afterEach(() => cleanup());

it("browsing and leaving a template never modifies current content, redo or history ownership", async () => {
  const project = createEmptyProject("Template content");
  const template = { ...new TemplateEngine().createFromProject(project, { name: "Local fixture", description: "", category: "custom", tags: [], placeholders: [] }), projectSnapshot: project };
  service.listProjectTemplates.mockResolvedValue([{ id: template.id, name: template.name, description: template.description,
    tags: template.tags, thumbnailUrl: template.thumbnailUrl, createdAt: template.createdAt, modifiedAt: template.modifiedAt,
    version: template.version, hasSnapshot: true, duration: template.timeline.duration }]);
  service.loadProjectTemplate.mockResolvedValue(template);
  activateProjectStore(createProjectStore());
  useProjectStore.getState().createNewProject("Current work");
  await useProjectStore.getState().addTrack("audio");
  await useProjectStore.getState().undo();
  const before = useProjectStore.getState();
  const redo = before.actionHistory.getRedoEntries();
  render(<TemplatesTab />);
  fireEvent.click(await screen.findByRole("button", { name: "Local fixture" }));
  await screen.findByText("Dependencies available");
  fireEvent.click(screen.getByRole("button", { name: "Back to project templates" }));
  expect(service.createProjectFromTemplate).not.toHaveBeenCalled();
  expect(useProjectStore.getState().project).toBe(before.project);
  expect(useProjectStore.getState().actionHistory).toBe(before.actionHistory);
  expect(useProjectStore.getState().actionHistory.getRedoEntries()).toEqual(redo);
  expect(useProjectStore.getState().redoJournal).toBe(before.redoJournal);
});
