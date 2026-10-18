import { cloneElement, type ReactElement, type ReactNode } from "react";
import { addLibraryInstruction } from "../../services/material-library/instructions";
import { buildMaterialRecord } from "@reelterminal/core";
import { MaterialLibraryService, setMaterialLibraryServiceForTests } from "../../services/material-library/library-service";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectStore } from "../../stores/project-store";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { useUIStore } from "../../stores/ui-store";
import { CollaborationBoardPanel } from "./CollaborationBoardPanel";
import type { MediaItem } from "@reelterminal/core";

// State/history contracts run without Radix's layout and focus scheduling in JSDOM.
// Real portal placement, hover, dismissal and focus are exercised in desktop E2E.
vi.mock("@reelterminal/ui", async importOriginal => {
  const actual = await importOriginal<typeof import("@reelterminal/ui")>();
  return {
    ...actual,
    ToolcraftPopover: ({ children, content, isOpen, onOpenChange, label }: {
      children: ReactElement<{ onClick?: () => void }>; content: ReactNode;
      isOpen: boolean; onOpenChange: (open: boolean) => void; label: string;
    }) => <>{cloneElement(children, { onClick: () => onOpenChange(!isOpen) })}{isOpen && <div role="dialog" aria-label={label}>{content}</div>}</>,
    Tooltip: ({ children }: { children: ReactNode }) => <actual.Tooltip open={false}>{children}</actual.Tooltip>,
  };
});

const createStore = () => createProjectStore({ initialProject: createEmptyProject("Board"), isForeground: false });
beforeEach(() => {
  useUIStore.setState({ boardOpenRequest: 0, modalData: null });
  const records = new Map<string, unknown>();
  setMaterialLibraryServiceForTests(new MaterialLibraryService({
    loadAllMaterials: async () => [...records.values()], loadJournal: async () => [], loadBlob: async () => null,
    commit: async change => { for (const record of change.materialUpserts ?? []) records.set(record.id, record); for (const id of change.materialDeletes ?? []) records.delete(id); },
  }));
});

describe("collaboration board", () => {
  it("has one empty-state entry and adds a built-in directly without writing to the library", async () => {
    const store = createStore();
    render(<CollaborationBoardPanel store={store} active onClose={() => {}} />);
    expect(screen.getAllByRole("button", { name: "Add instruction" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "New instruction" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add instruction" }));
    fireEvent.click(screen.getByRole("button", { name: "Guide me visually" }));
    await waitFor(() => expect(store.getState().project.collaborationInstructions?.items).toHaveLength(1));
    expect(screen.queryByRole("textbox", { name: "Title" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Guide me visually" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Unpublished draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(store.getState().project.collaborationInstructions?.items[0].title).toBe("Guide me visually");
    fireEvent.click(screen.getByRole("switch", { name: "Enable Guide me visually" }));
    await waitFor(() => expect(store.getState().project.collaborationInstructions?.items[0].enabled).toBe(false));
    await act(() => store.getState().undo());
    expect(store.getState().project.collaborationInstructions?.items[0].enabled).toBe(true);
  });

  it("preserves chip colors while reordering and supports removal with undo", async () => {
    const store = createStore();
    for (const title of ["First", "Second"]) await addLibraryInstruction(store, buildMaterialRecord({ kind: "instruction", actor: "user", title, prompt: `${title} instruction` }));
    render(<CollaborationBoardPanel store={store} active onClose={() => {}} />);
    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });
    const firstColor = first.closest("[data-instruction-id]")!.getAttribute("style");
    expect(firstColor).not.toBe(second.closest("[data-instruction-id]")!.getAttribute("style"));
    fireEvent.dragStart(first.closest("[data-instruction-id]")!, { dataTransfer: { setData: () => {} } });
    fireEvent.dragOver(second.closest("[data-instruction-id]")!);
    fireEvent.drop(second.closest("[data-instruction-id]")!);
    await waitFor(() => expect(store.getState().project.collaborationInstructions?.items.map(item => item.title)).toEqual(["Second", "First"]));
    expect(first.closest("[data-instruction-id]")!.getAttribute("style")).toBe(firstColor);
    await act(() => store.getState().undo());
    expect(store.getState().project.collaborationInstructions?.items.map(item => item.title)).toEqual(["First", "Second"]);
    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: "Delete instruction" }));
    await waitFor(() => expect(store.getState().project.collaborationInstructions?.items).toHaveLength(1));
    await act(() => store.getState().undo());
    expect(store.getState().project.collaborationInstructions?.items).toHaveLength(2);
  });

  it("routes task requests and pending reviews to the original task page", async () => {
    const store = createStore();
    await store.getState().addProjectRequirement({ title: "Review opening", status: "review" });
    render(<CollaborationBoardPanel store={store} active onClose={() => {}} />);
    expect(screen.getByRole("tab", { name: "Tasks" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: /Q1 Review opening/ })).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Collaboration instructions" }));
    act(() => useUIStore.setState({ boardOpenRequest: 1, modalData: { projectId: store.getState().project.id, referenceIds: [] } }));
    expect(screen.getByRole("tab", { name: "Tasks" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByPlaceholderText("Describe the outcome in one line")).toBeVisible();
  });

  it("does not publish incomplete tool presets", () => {
    const store = createStore();
    render(<CollaborationBoardPanel store={store} active onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add instruction" }));
    fireEvent.click(screen.getByRole("button", { name: /Prefer a specific tool/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add to project" }));
    expect(screen.getByRole("alert")).toHaveTextContent("placeholders");
    expect(store.getState().project.collaborationInstructions).toBeUndefined();
  });

  it("keeps stable asset references and does not resurrect an instruction removed during editing", async () => {
    const store = createStore();
    store.setState(state => ({ project: {
      ...state.project,
      mediaLibrary: { items: [{ id: "reference-media", name: "Motion reference", type: "video" } as MediaItem] },
    } }));
    render(<CollaborationBoardPanel store={store} active onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add instruction" }));
    fireEvent.click(screen.getByRole("button", { name: "New instruction" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Explain visually" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Detailed instruction" }), { target: { value: "Use the reference's visual continuity." } });
    fireEvent.click(screen.getByText(/Reference assets and ranges/));
    fireEvent.click(screen.getByRole("checkbox", { name: "Motion reference" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Start (seconds)" }), { target: { value: "94" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "End (seconds)" }), { target: { value: "106" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to project" }));
    await waitFor(() => expect(store.getState().project.collaborationInstructions?.items).toHaveLength(1));
    expect(store.getState().project.collaborationInstructions?.items[0].references?.[0]).toMatchObject({
      entityId: "reference-media", kind: "media", timing: { startSeconds: 94, endSeconds: 106 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Explain visually" }));
    await act(() => store.getState().undo());
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("has changed"));
    expect(store.getState().project.collaborationInstructions).toBeUndefined();
  });
});
