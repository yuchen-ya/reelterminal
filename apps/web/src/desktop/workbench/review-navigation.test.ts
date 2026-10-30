import { afterEach, expect, it, vi } from "vitest";
import type { ReviewContext } from "@reelterminal/core/review/types";
import { reviewService } from "../../services/review-workspace/service";
import { useWorkbenchUiStore } from "../../stores/workbench-ui-store";
import { reviewItemFromProcess } from "./review-navigation";

afterEach(() => { vi.restoreAllMocks(); useWorkbenchUiStore.getState().resetProjectScopedState(); });

it("does not let a delayed process-item read change another tab's group, page or view", async () => {
  const target: ReviewContext["target"] = { kind: "review", nodeId: "a", instanceId: "instance", reviewWorkspaceId: "workspace" };
  let release!: (value: Awaited<ReturnType<typeof reviewService.getItem>>) => void;
  vi.spyOn(reviewService, "getItem").mockReturnValue(new Promise(resolve => { release = resolve; }));
  const ui = useWorkbenchUiStore.getState();
  ui.resetProjectScopedState();
  ui.activateScope("review:a");
  ui.setReviewView("process");
  const pending = reviewItemFromProcess(target, "a-item");
  ui.activateScope("review:b");
  ui.setActiveBatchId("b-group");
  ui.setCursor("b-group", "b-item");
  ui.setReviewPage("b-page", [undefined]);
  ui.setReviewView("process");
  release({ item: { id: "a-item", batchId: "a-group" } } as Awaited<ReturnType<typeof reviewService.getItem>>);
  await pending;
  expect(useWorkbenchUiStore.getState()).toMatchObject({ activeBatchId: "b-group", cursorByBatch: { "b-group": "b-item" }, reviewPageCursor: "b-page", reviewView: "process" });
});
