import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  createNewProject: vi.fn(),
  listRecentProjects: vi.fn(),
  openProject: vi.fn(),
  openRecentProject: vi.fn(),
}));

vi.mock("../../stores/project-store", () => ({
  useProjectStore: () => ({
    project: { id: "project-1", name: "Horizontal" },
    createNewProject: stubs.createNewProject,
  }),
}));

vi.mock("../../desktop/start/desktop-project-actions", () => ({
  listRecentProjects: stubs.listRecentProjects,
  openProject: stubs.openProject,
  openRecentProject: stubs.openRecentProject,
}));

import i18n, { changeAppLanguage } from "../../i18n";
import { ProjectSwitcher } from "./ProjectSwitcher";

async function renderIn(locale: "en" | "zh-CN") {
  await act(async () => {
    await changeAppLanguage(locale);
  });
  return render(<ProjectSwitcher />);
}

beforeEach(() => {
  stubs.listRecentProjects.mockResolvedValue([
    { id: "project-2", name: "Flip Horizontal", lastOpened: Date.now() },
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  return act(async () => {
    await changeAppLanguage("en");
  });
});

describe("ProjectSwitcher", () => {
  it("shows project names verbatim in zh, even when the dictionary has that key", async () => {
    expect(i18n.t("Horizontal", { lng: "zh-CN" })).toBe("水平");
    await renderIn("zh-CN");

    const trigger = screen.getByRole("button", { name: "Horizontal" });
    expect(trigger).toHaveTextContent("Horizontal");
    expect(trigger).not.toHaveTextContent("水平");
  });

  it("offers new, open, and recent projects without repeating the current project", async () => {
    await renderIn("zh-CN");
    fireEvent.click(screen.getByRole("button", { name: "Horizontal" }));

    expect(await screen.findByText("新建项目")).toBeInTheDocument();
    expect(screen.getByText("打开项目")).toBeInTheDocument();
    expect(screen.getByText("最近的项目")).toBeInTheDocument();
    expect(await screen.findByText("Flip Horizontal")).toBeInTheDocument();
    expect(screen.queryByText("当前项目")).toBeNull();
    expect(screen.getAllByText("Horizontal")).toHaveLength(1);
    expect(screen.queryByText("水平")).toBeNull();
  });

  it("opens a recent project by its project-manager id", async () => {
    stubs.openRecentProject.mockResolvedValue(true);
    await renderIn("en");
    fireEvent.click(screen.getByRole("button", { name: "Horizontal" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Flip Horizontal" }));

    await waitFor(() => expect(stubs.openRecentProject).toHaveBeenCalledWith("project-2"));
  });

  it("still shows arbitrary names as-is in the default English UI", async () => {
    await renderIn("en");
    expect(screen.getByRole("button", { name: "Horizontal" })).toBeInTheDocument();
  });
});
