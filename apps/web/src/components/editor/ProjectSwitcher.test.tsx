import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Project names are user data, not i18n catalog keys. The trigger button once
 * rendered `t(project.name)`, so a project literally named "Horizontal" picked
 * up the zh dictionary entry and displayed as "水平". These tests pin that
 * names render verbatim while the surrounding chrome stays translated, using
 * the real app i18n instance and resources.
 */

const stubs = vi.hoisted(() => ({
  createNewProject: vi.fn(),
  recoverFromAutoSave: vi.fn(),
  renameProject: vi.fn(),
  initialize: vi.fn(),
  checkForRecovery: vi.fn(),
}));

vi.mock("../../stores/project-store", () => ({
  useProjectStore: () => ({
    project: { id: "project-1", name: "Horizontal" },
    createNewProject: stubs.createNewProject,
    recoverFromAutoSave: stubs.recoverFromAutoSave,
    renameProject: stubs.renameProject,
  }),
}));

vi.mock("../../services/auto-save", () => ({
  autoSaveManager: {
    initialize: stubs.initialize,
    checkForRecovery: stubs.checkForRecovery,
  },
}));

import i18n, { changeAppLanguage } from "../../i18n";
import { ProjectSwitcher } from "./ProjectSwitcher";

function aSave(overrides: Partial<{ id: string; projectId: string; projectName: string }>) {
  return {
    id: overrides.id ?? "save-1",
    projectId: overrides.projectId ?? "project-2",
    projectName: overrides.projectName ?? "Horizontal",
    timestamp: Date.now(),
    slot: 1,
    isRecovery: false,
  };
}

async function renderIn(locale: "en" | "zh-CN") {
  await act(async () => {
    await changeAppLanguage(locale);
  });
  return render(<ProjectSwitcher />);
}

beforeEach(() => {
  stubs.initialize.mockResolvedValue(undefined);
  stubs.checkForRecovery.mockResolvedValue([
    aSave({ projectName: "Flip Horizontal" }),
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  return act(async () => {
    await changeAppLanguage("en");
  });
});

describe("ProjectSwitcher project-name rendering", () => {
  it("shows the trigger name verbatim in zh, even when the dictionary has that key", async () => {
    // Guard the premise: the zh resources really do map "Horizontal" to
    // "水平", so rendering it raw is the only thing keeping the name intact.
    expect(i18n.t("Horizontal", { lng: "zh-CN" })).toBe("水平");

    await renderIn("zh-CN");

    const trigger = screen.getByRole("button", { name: "Horizontal" });
    expect(trigger).toHaveTextContent("Horizontal");
    expect(trigger).not.toHaveTextContent("水平");
  });

  it("keeps the translated chrome around an untranslated project name", async () => {
    await renderIn("zh-CN");
    fireEvent.click(screen.getByRole("button", { name: "Horizontal" }));

    expect(await screen.findByText("当前项目")).toBeInTheDocument();
    expect(screen.getByText("新建项目")).toBeInTheDocument();
    // The current project's own name in the dropdown stays verbatim too
    // (trigger label + "Current Project" card both show it).
    expect(screen.getAllByText("Horizontal").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("水平")).toBeNull();
  });

  it("renders recent-project entry names verbatim in zh", async () => {
    stubs.checkForRecovery.mockResolvedValue([
      aSave({ projectName: "Flip Horizontal" }),
    ]);
    await renderIn("zh-CN");
    fireEvent.click(screen.getByRole("button", { name: "Horizontal" }));

    await waitFor(() =>
      expect(screen.getByText("最近的项目")).toBeInTheDocument(),
    );
    const entry = screen.getByText("Flip Horizontal");
    expect(entry).toBeInTheDocument();
    expect(entry).not.toHaveTextContent("水平翻转");
  });

  it("still shows arbitrary names as-is in the default English UI", async () => {
    await renderIn("en");
    expect(screen.getByRole("button", { name: "Horizontal" })).toBeInTheDocument();
  });
});
