import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DragEvent } from "react";
import type { ReviewExportStatus } from "@reelterminal/core/review/export";
import { prepareReviewExport } from "../../services/review-workspace/export";
import { useCollectionExport, type CollectionExportTarget } from "./useCollectionExport";
import type { CollectionScope } from "./components/CollectionActions";
import type { WorkbenchItemView } from "./types";

vi.mock("../../services/review-workspace/export", () => ({
  prepareReviewExport: vi.fn(), reviewExportStatus: vi.fn(),
  cancelReviewExport: vi.fn(), copyReviewExport: vi.fn(),
}));
const originalBridge = window.reelterminal;
afterEach(() => {
  cleanup(); vi.resetAllMocks();
  Object.defineProperty(window, "reelterminal", { configurable: true, value: originalBridge });
});

it("requires a prepared export for the same node revision before native drag and ignores obsolete preparation", async () => {
  const startDrag = vi.fn(async () => {});
  Object.defineProperty(window, "reelterminal", { configurable: true, value: { reviewExport: { startDrag } } });
  const source: CollectionExportTarget = {
    target: { kind: "review", reviewWorkspaceId: crypto.randomUUID(), nodeId: crypto.randomUUID(), instanceId: crypto.randomUUID() }, revision: 1,
  };
  const scope: CollectionScope = { title: "分组", folder: true, items: [{ id: crypto.randomUUID(), version: 1 } as WorkbenchItemView] };
  const requests: Array<{ input: Parameters<typeof prepareReviewExport>[0]; resolve: (status: ReviewExportStatus) => void }> = [];
  vi.mocked(prepareReviewExport).mockImplementation(input => new Promise(resolve => requests.push({ input, resolve })));
  const { result, rerender } = renderHook(({ target }) => useCollectionExport(target), { initialProps: { target: source } });
  const event = { preventDefault: vi.fn() } as unknown as DragEvent;
  act(() => result.current.drag(event, scope));
  expect(startDrag).not.toHaveBeenCalled();
  expect(requests[0].input).toMatchObject({ target: source.target, expectedNodeRevision: 1, mode: "current", scope: "selected", itemIds: [scope.items[0].id], name: "分组" });
  rerender({ target: { ...source, revision: 2 } });
  act(() => result.current.drag(event, scope));
  const ready = (index: number): ReviewExportStatus => ({ exportId: requests[index].input.exportId, nodeId: source.target.nodeId!, nodeRevision: index + 1, state: "ready", totalFiles: 1, completedFiles: 1 });
  await act(async () => requests[1].resolve(ready(1)));
  await act(async () => requests[0].resolve(ready(0)));
  act(() => result.current.drag(event, scope));
  await waitFor(() => expect(startDrag).toHaveBeenCalledWith(requests[1].input.exportId, true));
  expect(startDrag).toHaveBeenCalledTimes(1);
});
