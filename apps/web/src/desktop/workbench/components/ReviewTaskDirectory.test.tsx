import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewTaskDirectory } from "./ReviewTaskDirectory";

afterEach(cleanup);

it("keeps creation in the open manager and waits for the directory to be available", () => {
  const onCreateNode = vi.fn().mockResolvedValue(undefined);
  const props = { nodes: [], selectedId: null,
    onSelectNode: vi.fn(), onUpdateNode: vi.fn(), onRenameNode: vi.fn(), onPurgeNode: vi.fn(),
    directory: { groups: [], canUndo: false, canRedo: false }, view: "recent" as const, onSelectView: vi.fn(),
    query: "", onQueryChange: vi.fn(), groupId: "", onSelectGroup: vi.fn(), onCreateNode,
    onCreateGroup: vi.fn(), onRenameGroup: vi.fn(), onRemoveGroup: vi.fn(), onDirectoryHistory: vi.fn() };
  const { rerender } = render(<ReviewTaskDirectory {...props} busy />);
  fireEvent.click(screen.getByTestId("review-new-task"));
  const create = screen.getByTestId("review-create-node") as HTMLButtonElement;
  const form = create.closest("form")!;
  fireEvent.change(form.querySelector("input")!, { target: { value: "Task" } });
  expect(create.disabled).toBe(true);
  fireEvent.submit(form);
  expect(onCreateNode).not.toHaveBeenCalled();
  rerender(<ReviewTaskDirectory {...props} busy={false} />);
  fireEvent.submit(form);
  expect(onCreateNode).toHaveBeenCalledWith("Task");
});
