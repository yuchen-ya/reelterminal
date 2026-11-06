import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskOriginalExportRecord, TaskReviewExportBridge } from "../../../../../desktop/src/shared/task-review-export";
import { createFakeTaskReviewBridge } from "./testing";
import { useTaskReviewController } from "./useTaskReviewController";

afterEach(cleanup);

const record = (): TaskOriginalExportRecord => ({
  id: "export-fixed", taskId: "task-1", createdAt: 1, previewRevision: 1, purpose: "review", goal: "goal", policyRevision: 1,
  statuses: ["kept"], sourceEntryIds: ["entry-1"], destination: "external", outputDirectory: "external/result", manifestPath: "external/result/manifest.json",
  manifestStatus: "not-created", items: [], status: "planned",
});

describe("original-file export queue", () => {
  it("serializes preview after edits, applies snapshots, and retries execute with the same fixed export ID", async () => {
    const bridge = createFakeTaskReviewBridge();
    const preview = vi.fn<TaskReviewExportBridge["preview"]>(async (input) => {
      const planned = { ...record(), previewRevision: input.expectedRevision };
      bridge.mutateState((state) => { state.revision++; state.originalExports = [planned]; });
      return { snapshot: bridge.snapshotState(), preview: planned };
    });
    let conflicted = false;
    const execute = vi.fn<TaskReviewExportBridge["execute"]>(async () => {
      if (!conflicted) {
        conflicted = true;
        bridge.mutateState((state) => { state.revision++; });
        throw new Error("Revision conflict");
      }
      const receipt = { ...record(), status: "partial" as const, completedAt: 2, manifestStatus: "written" as const };
      bridge.mutateState((state) => { state.revision++; state.originalExports = [receipt]; });
      return { snapshot: bridge.snapshotState(), receipt };
    });
    const hook = renderHook(() => useTaskReviewController("task-root", bridge, null, { preview, execute }));
    await waitFor(() => expect(hook.result.current.snapshot?.taskId).toBe("task-1"));
    const input = { root: "task-root", taskId: "task-1", expectedRevision: 0, purpose: "review", statuses: ["kept" as const], sourceEntryIds: ["entry-1"], destination: "external" };
    await act(async () => {
      const goal = hook.result.current.setGoal("goal");
      const exported = hook.result.current.previewOriginalExport(input);
      await goal;
      expect((await exported).preview.id).toBe("export-fixed");
    });
    expect(preview).toHaveBeenCalledWith({ ...input, expectedRevision: 1 });
    expect(hook.result.current.snapshot?.originalExports?.[0]?.status).toBe("planned");
    await act(async () => {
      const result = await hook.result.current.executeOriginalExport({ root: "task-root", taskId: "task-1", expectedRevision: 2, exportId: "export-fixed" });
      expect(result.receipt.status).toBe("partial");
    });
    expect(execute.mock.calls.map(([input]) => [input.exportId, input.expectedRevision])).toEqual([["export-fixed", 2], ["export-fixed", 3]]);
    expect(hook.result.current.snapshot?.originalExports?.[0]?.status).toBe("partial");
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("does not replan or retry when service rejects relevant changed export inputs", async () => {
    const bridge = createFakeTaskReviewBridge();
    const preview = vi.fn<TaskReviewExportBridge["preview"]>();
    const execute = vi.fn<TaskReviewExportBridge["execute"]>().mockRejectedValue(new Error("Export inputs changed; refresh preview"));
    const hook = renderHook(() => useTaskReviewController("task-root", bridge, null, { preview, execute }));
    await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
    await act(async () => {
      await expect(hook.result.current.executeOriginalExport({ root: "task-root", taskId: "task-1", expectedRevision: 0, exportId: "export-fixed" })).rejects.toThrow("refresh preview");
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(preview).not.toHaveBeenCalled();
    expect(hook.result.current.busy).toBe(false);
  });
});
