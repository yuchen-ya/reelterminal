import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReviewBranchComparison } from "../../../services/review-workspace/branches";
import { ReviewBranchDialog } from "./ReviewBranchDialog";

vi.mock("./ReviewComparison", () => ({ ReviewComparison: ({ left, right }: { left?: { target: { nodeId: string } }; right?: { target: { nodeId: string } } }) =>
  <div data-testid="branch-comparison-targets">{left?.target.nodeId}/{right?.target.nodeId}</div> }));
afterEach(cleanup);

it("adopts only explicitly selected exact results and keeps comparison targets independent", async () => {
  const workspaceId = crypto.randomUUID();
  const sourceId = crypto.randomUUID();
  const branchId = crypto.randomUUID();
  const resultItemId = crypto.randomUUID();
  const conflictId = crypto.randomUUID();
  const metadata = { workspaceId, name: "Source", pinned: false, revision: 8, createdAt: 1, updatedAt: 1 };
  const comparison: ReviewBranchComparison = { source: { ...metadata, id: sourceId },
    branch: { ...metadata, id: branchId, name: "Task", revision: 3, branch: { taskId: crypto.randomUUID(), sourceNodeId: sourceId, sourceNodeRevision: 2 } }, idMap: [],
    items: [{ resultItemId, resultVersion: 2, sourceItemId: crypto.randomUUID(), sourceVersion: 1, baseVersion: 1, title: "Safe result", state: "changed" },
      { resultItemId: conflictId, resultVersion: 2, title: "Conflicted result", state: "conflict", conflict: "Source feedback changed" }] };
  const load = vi.fn(async () => comparison);
  const adopt = vi.fn(async () => {});
  render(<ReviewBranchDialog target={{ kind: "review", reviewWorkspaceId: workspaceId, instanceId: crypto.randomUUID(), nodeId: branchId }} load={load} adopt={adopt} onClose={vi.fn()} />);
  await screen.findByText("Safe result · v2");
  expect(screen.getByTestId("branch-comparison-targets").textContent).toBe(`${sourceId}/${branchId}`);
  expect((screen.getByRole("checkbox", { name: "Select Conflicted result" }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByTestId("review-branch-adopt") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Safe result" }));
  fireEvent.click(screen.getByTestId("review-branch-adopt"));
  await waitFor(() => expect(adopt).toHaveBeenCalledTimes(1));
  expect(adopt.mock.calls[0]).toEqual([{ expectedNodeRevision: 3, requestId: expect.any(String), selections: [{ resultItemId, resultVersion: 2 }] }]);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});
