import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateEngine, type Template } from "@reelterminal/core";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { TemplatesTab } from "./TemplatesTab";

const service = vi.hoisted(() => ({ listProjectTemplates: vi.fn(), loadProjectTemplate: vi.fn(), createProjectFromTemplate: vi.fn(),
  deleteProjectTemplate: vi.fn(), inspectProjectTemplate: vi.fn(), saveProjectTemplate: vi.fn(), updateProjectTemplate: vi.fn() }));
vi.mock("../../../services/project-templates", () => service);

let template: Template;
let summary: Record<string, unknown>;
const previousBridge = window.reelterminal;
beforeEach(() => {
  vi.clearAllMocks();
  const project = createEmptyProject("Source");
  template = { ...new TemplateEngine().createFromProject(project, { name: "My template", description: "Product announcement",
    category: "custom", tags: ["brand"], placeholders: [] }), projectSnapshot: project };
  summary = { id: template.id, name: template.name, description: template.description, tags: template.tags,
    thumbnailUrl: template.thumbnailUrl, createdAt: template.createdAt, modifiedAt: template.modifiedAt,
    version: template.version, hasSnapshot: true, duration: template.timeline.duration };
  service.listProjectTemplates.mockResolvedValue([summary]);
  service.loadProjectTemplate.mockResolvedValue(template);
  service.inspectProjectTemplate.mockResolvedValue([]);
  service.createProjectFromTemplate.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); window.reelterminal = previousBridge; vi.restoreAllMocks(); });

describe("personal template browser", () => {
  it("searches descriptions and tags, then requires an explicit new-project action", async () => {
    window.reelterminal = { platform: "desktop" } as NonNullable<Window["reelterminal"]>;
    const hash = window.location.hash;
    render(<TemplatesTab />);
    await screen.findByRole("button", { name: template.name });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "brand" } });
    fireEvent.click(screen.getByRole("button", { name: template.name }));
    await screen.findByText("Dependencies available");
    expect(service.createProjectFromTemplate).not.toHaveBeenCalled();
    expect(screen.getByText("Static cover preview")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /replace/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("New project name"), { target: { value: "New edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project from template" }));
    await waitFor(() => expect(service.createProjectFromTemplate).toHaveBeenCalledWith(template.id, "New edit", {}));
    expect(window.location.hash).toBe(hash);
  });

  it("blocks missing dependencies and displays old-format limitations", async () => {
    service.listProjectTemplates.mockResolvedValue([{ ...summary, hasSnapshot: false }]);
    service.loadProjectTemplate.mockResolvedValue({ ...template, projectSnapshot: undefined });
    service.inspectProjectTemplate.mockResolvedValue(["missing-media"]);
    render(<TemplatesTab />);
    fireEvent.click(await screen.findByRole("button", { name: template.name }));
    await screen.findByText(/Missing dependencies: missing-media/);
    expect(screen.getByText(/Legacy template: the old format/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create project from template" })).toBeDisabled();
  });

  it("preserves the template on delete cancellation and removes it on confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<TemplatesTab />);
    fireEvent.click(await screen.findByRole("button", { name: template.name }));
    await screen.findByText("Dependencies available");
    fireEvent.click(screen.getByRole("button", { name: "Delete template" }));
    expect(service.deleteProjectTemplate).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    service.deleteProjectTemplate.mockResolvedValue(undefined);
    service.listProjectTemplates.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "Delete template" }));
    await screen.findByText(/No saved project templates/);
    expect(service.deleteProjectTemplate).toHaveBeenCalledWith(template.id);
  });

  it("keeps the latest chosen template when detail loads resolve out of order", async () => {
    const secondSummary = { ...summary, id: "template-b", name: "Second template" };
    const secondDetail = { ...template, id: "template-b", name: "Second template" };
    service.listProjectTemplates.mockResolvedValue([summary, secondSummary]);
    service.inspectProjectTemplate.mockResolvedValue([]);
    const pending: Array<(value: Template | null) => void> = [];
    service.loadProjectTemplate.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    render(<TemplatesTab />);
    fireEvent.click(await screen.findByRole("button", { name: template.name }));
    fireEvent.click(screen.getByRole("button", { name: "Second template" }));
    expect(pending.length).toBe(2);
    pending[1](secondDetail);
    await waitFor(() => expect(screen.getByRole("heading", { level: 3, name: "Second template" })).toBeInTheDocument());
    pending[0](template);
    await waitFor(() => expect(screen.getByRole("heading", { level: 3, name: "Second template" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { level: 3, name: template.name })).not.toBeInTheDocument();
  });
});
