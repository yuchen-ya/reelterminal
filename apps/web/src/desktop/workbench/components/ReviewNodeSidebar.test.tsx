import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReviewNode } from "@reelterminal/core/review/types";
import { ReviewNodeSidebar } from "./ReviewNodeSidebar";

afterEach(cleanup);
it("copies the hovered task without selecting it", () => {
  const node: ReviewNode = { id: crypto.randomUUID(), workspaceId: crypto.randomUUID(), name: "动作检查",
    pinned: false, revision: 0, createdAt: 1, updatedAt: 1 };
  const onSelectNode = vi.fn();
  const onCopyInstructions = vi.fn(async () => {});
  render(<ReviewNodeSidebar open onToggleOpen={vi.fn()} nodes={[node]} selectedId={null}
    onSelectNode={onSelectNode} onCopyInstructions={onCopyInstructions}
    directory={{ groups: [], canUndo: false, canRedo: false }} view="recent" onSelectView={vi.fn()}
    query="" onQueryChange={vi.fn()} groupId="" onSelectGroup={vi.fn()}
    onCreateNode={vi.fn()} onCreateGroup={vi.fn()} onRenameGroup={vi.fn()} onRemoveGroup={vi.fn()}
    onDirectoryHistory={vi.fn()} busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: /Copy Agent instructions for 动作检查/ }));
  expect(onCopyInstructions).toHaveBeenCalledWith(node);
  expect(onSelectNode).not.toHaveBeenCalled();
});
