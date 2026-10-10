import "../../test/install-local-storage-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ProjectLibraryData } from "./project-library-service";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  rename: vi.fn(),
  copy: vi.fn(),
  move: vi.fn(),
  restore: vi.fn(),
  saveFolder: vi.fn(),
  deleteFolder: vi.fn(),
  recycle: vi.fn(),
  preview: vi.fn(),
  purge: vi.fn(),
}));
vi.mock("./project-library-service", () => ({
  loadProjectLibrary: mocks.load,
  projectLibraryActions: mocks,
  recycleLibraryProjects: mocks.recycle,
  previewLibraryPurge: mocks.preview,
  purgeLibraryProjects: mocks.purge,
}));
import { ProjectLibrary } from "./ProjectLibrary";

function fixture(): ProjectLibraryData {
  return {
    projects: [
      {
        id: "a",
        name: "Alpha",
        createdAt: 2,
        modifiedAt: 3,
        defaultWorkspaceId: "wa",
        duration: 12,
        width: 1920,
        height: 1080,
        engineeringBytes: 100,
        folderId: "work",
      },
      {
        id: "b",
        name: "Beta",
        createdAt: 3,
        modifiedAt: 2,
        defaultWorkspaceId: "wb",
        duration: 10,
        width: 1080,
        height: 1920,
        engineeringBytes: 200,
      },
      {
        id: "c",
        name: "Archived",
        createdAt: 1,
        modifiedAt: 1,
        defaultWorkspaceId: "wc",
        duration: 0,
        width: 1920,
        height: 1080,
        engineeringBytes: 300,
        recycledAt: 4,
      },
    ],
    folders: [{ id: "work", name: "Work" }],
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  mocks.load.mockResolvedValue(fixture());
  mocks.preview.mockResolvedValue(1024);
  mocks.purge.mockResolvedValue({ reclaimedBytes: 1024, incomplete: false });
});
afterEach(cleanup);

describe("ProjectLibrary", () => {
  it("opens only the project button and confirms a rename without opening the editor", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    render(<ProjectLibrary onOpen={open} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Actions for Alpha" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(mocks.rename).toHaveBeenCalledWith("a", "Renamed"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));
    expect(open).toHaveBeenCalledWith("a");
  });

  it("selects only the current filtered results, preserves selection across layout/sort, and clears it on filter changes", async () => {
    render(<ProjectLibrary onOpen={vi.fn()} />);
    await screen.findByRole("button", { name: "Open Alpha" });
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Alpha" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all results" }),
    );
    expect(screen.getByText("Selected 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Sort projects" }), {
      target: { value: "name" },
    });
    expect(screen.getByText("Selected 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.recycle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(mocks.recycle).toHaveBeenCalledWith(["a"]));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all results" }),
    );
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    expect(screen.getByText("Selected 0")).toBeInTheDocument();
  });

  it("persists list/grid and sorting preferences and moves the selected project to a folder", async () => {
    const view = render(<ProjectLibrary onOpen={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Grid view" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Sort projects" }), {
      target: { value: "engineeringBytes" },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Actions for Beta" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Actions for Beta" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to folder" }));
    fireEvent.change(
      screen.getByRole("combobox", { name: "Destination folder" }),
      { target: { value: "work" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(mocks.move).toHaveBeenCalledWith(["b"], "work"));
    view.unmount();
    render(<ProjectLibrary onOpen={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Grid view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "Sort projects" })).toHaveValue(
      "engineeringBytes",
    );
  });

  it("offers restore and permanent delete only in the recycle bin and previews reclaimed cache bytes", async () => {
    render(<ProjectLibrary onOpen={vi.fn()} />);
    await screen.findByRole("button", { name: "Open Alpha" });
    fireEvent.change(screen.getByRole("combobox", { name: "Project folder" }), {
      target: { value: "trash" },
    });
    expect(
      screen.queryByRole("button", { name: "Open Alpha" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Archived" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Restore" }));
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith(["c"]));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Actions for Archived" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Archived" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Delete permanently" }),
    );
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByText(/1.0 KB/)).toBeInTheDocument();
    expect(mocks.purge).not.toHaveBeenCalled();
    fireEvent.click(within(modal).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(mocks.purge).toHaveBeenCalledWith(["c"]));
  });

  it("shows load errors with retry and leaves failed mutations reviewable", async () => {
    mocks.load.mockRejectedValueOnce(new Error("disk unavailable"));
    render(<ProjectLibrary onOpen={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "disk unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "Open Alpha" });
    mocks.recycle.mockRejectedValue(new Error("export running"));
    fireEvent.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "export running",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Alpha" }),
    ).toBeInTheDocument();
  });
});
