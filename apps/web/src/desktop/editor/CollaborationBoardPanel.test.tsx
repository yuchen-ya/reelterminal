import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createProjectStore } from "../../stores/project-store";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { useUIStore } from "../../stores/ui-store";
import { CollaborationBoardPanel } from "./CollaborationBoardPanel";
import type { MediaItem } from "@reelterminal/core";

const createStore = () => createProjectStore({ initialProject: createEmptyProject("Board"), isForeground: false });
beforeEach(() => useUIStore.setState({ boardOpenRequest: 0, modalData: null }));

describe("collaboration board", () => {
  it("starts empty, saves a preset only explicitly, preserves a draft across tabs and supports disable/delete/undo", async () => {
    const store = createStore();
    render(<CollaborationBoardPanel store={store} active onClose={() => {}} />);
    expect(screen.getByRole("tab", { name: "Collaboration instructions" })).toHaveAttribute("aria-selected", "true");
    expect(store.getState().project.collaborationInstructions).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Add from presets" }));
    fireEvent.click(screen.getByRole("button", { name: /Guide me visually/ }));
    expect(store.getState().project.collaborationInstructions).toBeUndefined();
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Show me a prototype" } });
    fireEvent.click(screen.getByRole("tab", { name: "Tasks" }));
    expect(screen.getByRole("button", { name: "New requirement" })).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Collaboration instructions" }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Show me a prototype");
    fireEvent.click(screen.getByRole("button", { name: "Add to project" }));
    await waitFor(() => expect(store.getState().project.collaborationInstructions?.items).toHaveLength(1));
    const saved = store.getState().project.collaborationInstructions!.items[0];
    expect(saved.presetId).toBe("visual");
    expect(store.getState().project.requirements).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Show me a prototype" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Unpublished draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(store.getState().project.collaborationInstructions?.items[0]).toEqual(saved);
    fireEvent.click(screen.getByRole("switch", { name: "Enable Show me a prototype" }));
    await waitFor(() => expect(store.getState().project.collaborationInstructions?.items[0].enabled).toBe(false));
    await act(() => store.getState().undo());
    expect(store.getState().project.collaborationInstructions?.items[0].enabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show me a prototype" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete instruction" }));
    await waitFor(() => expect(store.getState().project.collaborationInstructions?.items).toEqual([]));
    await act(() => store.getState().undo());
    expect(store.getState().project.collaborationInstructions?.items[0].title).toBe(saved.title);
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
    fireEvent.click(screen.getByRole("button", { name: "Add from presets" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Write your own" }));
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
