import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReviewNode } from "@reelterminal/core/review/types";
import { ReviewNodeSidebar } from "./ReviewNodeSidebar";

afterEach(cleanup);
it("copies a task from its menu without selecting it", () => {
  const node: ReviewNode = { id: crypto.randomUUID(), workspaceId: crypto.randomUUID(), name: "动作检查",
    pinned: false, revision: 0, createdAt: 1, updatedAt: 1 };
  const onSelectNode = vi.fn();
  const onCopyInstructions = vi.fn(async () => {});
  render(<ReviewNodeSidebar open onToggleOpen={vi.fn()} nodes={[node]} selectedId={null}
    onSelectNode={onSelectNode} onUpdateNode={vi.fn()} onRenameNode={vi.fn()} onPurgeNode={vi.fn()} onCopyInstructions={onCopyInstructions}
    directory={{ groups: [], canUndo: false, canRedo: false }} view="recent" onSelectView={vi.fn()}
    query="" onQueryChange={vi.fn()} groupId="" onSelectGroup={vi.fn()}
    onCreateNode={vi.fn()} onCreateGroup={vi.fn()} onRenameGroup={vi.fn()} onRemoveGroup={vi.fn()}
    onDirectoryHistory={vi.fn()} busy={false} />);
  fireEvent.contextMenu(screen.getByText("动作检查"));
  fireEvent.click(screen.getByRole("menuitem", { name: /Copy Agent instructions for 动作检查/ }));
  expect(onCopyInstructions).toHaveBeenCalledWith(node);
  expect(onSelectNode).not.toHaveBeenCalled();
});

it("does not submit a task while its directory is unavailable", () => {
  const onCreateNode = vi.fn().mockResolvedValue(undefined);
  const props = { open: true, onToggleOpen: vi.fn(), nodes: [], selectedId: null,
    onSelectNode: vi.fn(), onUpdateNode: vi.fn(), onRenameNode: vi.fn(), onPurgeNode: vi.fn(),
    directory: { groups: [], canUndo: false, canRedo: false }, view: "recent" as const, onSelectView: vi.fn(),
    query: "", onQueryChange: vi.fn(), groupId: "", onSelectGroup: vi.fn(), onCreateNode,
    onCreateGroup: vi.fn(), onRenameGroup: vi.fn(), onRemoveGroup: vi.fn(), onDirectoryHistory: vi.fn() };
  const { rerender } = render(<ReviewNodeSidebar {...props} busy />);
  fireEvent.click(screen.getByTestId("review-new-task"));
  const create = screen.getByTestId("review-create-node") as HTMLButtonElement;
  const form = create.closest("form")!;
  fireEvent.change(form.querySelector("input")!, { target: { value: "Task" } });
  expect(create.disabled).toBe(true);
  fireEvent.submit(form);
  expect(onCreateNode).not.toHaveBeenCalled();
  rerender(<ReviewNodeSidebar {...props} busy={false} />);
  expect(create.disabled).toBe(false);
  fireEvent.submit(form);
  expect(onCreateNode).toHaveBeenCalledWith("Task");
});
