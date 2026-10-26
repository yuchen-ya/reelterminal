import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataCleaningWorkspace } from "./DataCleaningWorkspace";
import type {
  DataPatchInput,
  DataReworkCell,
  FeedbackView,
  WorkbenchItemView,
} from "../types";

afterEach(cleanup);

function dataItem(overrides: Partial<WorkbenchItemView> = {}): WorkbenchItemView {
  return {
    id: "d1",
    batchId: "b1",
    orderIndex: 0,
    title: "数据表",
    subtitle: "",
    type: "data",
    version: 1,
    status: "pending",
    hasManualRevision: false,
    provenanceTags: [],
    userCategoryTags: [],
    feedbacks: [],
    dataPayload: {
      datasetId: "ds-1",
      columns: [{ columnId: "c1", title: "列一" }],
      rows: [
        { rowId: "r1", cells: { c1: "旧值" } },
        { rowId: "r2", cells: { c1: "乙" } },
      ],
      proposals: [
        {
          proposalId: "p1",
          rowId: "r1",
          columnId: "c1",
          originalValue: "旧值",
          proposedValue: "新值",
          reason: "清理",
          provenanceTagId: "t1",
          status: "proposed",
        },
      ],
    },
    ...overrides,
  };
}

function reworkFeedback(version = 1): FeedbackView {
  return {
    id: `fb-d1-v${version}-cell`,
    text: "返工",
    referencedTagIds: [],
    targetSummary: "",
    target: { kind: "data-cell", rowId: "r2", columnId: "c1" },
    itemVersion: version,
    wantsRework: true,
    isDraft: false,
    updatedAt: 1,
  };
}

const noopUpdate = async (
  _itemId: string,
  _patches: readonly DataPatchInput[],
  _markDecision?: "modified",
  _expectedVersion?: number,
) => ({ ok: true as const });
const noopMark = async (
  _itemId: string,
  _itemVersion: number,
  _cells: readonly DataReworkCell[],
  _reason?: string,
) => ({ ok: true as const });
const noopClear = async (
  _itemId: string,
  _itemVersion: number,
  _cells: readonly DataReworkCell[],
) => ({ ok: true as const });

describe("DataCleaningWorkspace scope and rework", () => {
  it("isolates selection/drafts between items with identical cell keys", async () => {
    const onUpdate = vi.fn(noopUpdate);
    const { rerender } = render(
      <DataCleaningWorkspace
        currentItem={dataItem()}
        onUpdateDataCells={onUpdate}
        onMarkDataRework={noopMark}
        onClearDataRework={noopClear}
      />,
    );
    fireEvent.click(screen.getAllByText("旧值")[0]);
    fireEvent.click(screen.getAllByText("乙")[0], { ctrlKey: true });
    expect(screen.getByText(/已选 2 格/)).toBeInTheDocument();

    // Switch to B: the same row/column ids must start with an empty selection.
    rerender(
      <DataCleaningWorkspace
        currentItem={dataItem({ id: "d2", title: "数据表 B" })}
        onUpdateDataCells={onUpdate}
        onMarkDataRework={noopMark}
        onClearDataRework={noopClear}
      />,
    );
    await waitFor(() => expect(screen.getByText(/已选 0 格/)).toBeInTheDocument());
  });

  it("drops an open edit draft when the item version changes and says so", async () => {
    const onUpdate = vi.fn(noopUpdate);
    const { rerender } = render(
      <DataCleaningWorkspace
        currentItem={dataItem()}
        onUpdateDataCells={onUpdate}
        onMarkDataRework={noopMark}
        onClearDataRework={noopClear}
      />,
    );
    fireEvent.doubleClick(screen.getAllByText("旧值")[0]);
    const input = screen.getByDisplayValue("旧值");
    fireEvent.change(input, { target: { value: "未保存的草稿" } });

    rerender(
      <DataCleaningWorkspace
        currentItem={dataItem({ version: 2 })}
        onUpdateDataCells={onUpdate}
        onMarkDataRework={noopMark}
        onClearDataRework={noopClear}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("workbench-data-scope-notice")).toHaveTextContent(
        "未保存的单元格编辑草稿已丢弃",
      ),
    );
    expect(screen.queryByDisplayValue("未保存的草稿")).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("rejects a proposal without a value patch and marks selected rework cells explicitly", async () => {
    const onUpdate = vi.fn(noopUpdate);
    const onMark = vi.fn(noopMark);
    render(
      <DataCleaningWorkspace
        currentItem={dataItem()}
        onUpdateDataCells={onUpdate}
        onMarkDataRework={onMark}
        onClearDataRework={noopClear}
      />,
    );
    // Select the proposal cell, then reject it.
    fireEvent.click(screen.getAllByText("旧值")[0]);
    fireEvent.click(screen.getByRole("button", { name: /拒绝建议/ }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    const rejectPatches = onUpdate.mock.calls[0][1];
    expect(rejectPatches).toEqual([
      { rowId: "r1", columnId: "c1", proposalId: "p1", proposalOutcome: "rejected" },
    ]);
    expect(rejectPatches[0]).not.toHaveProperty("value");
    expect(onUpdate.mock.calls[0][2]).toBeUndefined();

    // Mark two cells rework: the payload carries stable coordinates and the
    // one pending proposal id, not free text.
    fireEvent.click(screen.getAllByText("旧值")[0]);
    fireEvent.click(screen.getAllByText("乙")[0], { ctrlKey: true });
    fireEvent.click(screen.getByTestId("workbench-data-mark-rework"));
    await waitFor(() => expect(onMark).toHaveBeenCalledTimes(1));
    expect(onMark.mock.calls[0][0]).toBe("d1");
    expect(onMark.mock.calls[0][1]).toBe(1);
    expect(onMark.mock.calls[0][2]).toEqual([
      { rowId: "r1", columnId: "c1", proposalId: "p1" },
      { rowId: "r2", columnId: "c1" },
    ]);
  });

  it("shows a badge only for active rework of the current version", () => {
    const { rerender } = render(
      <DataCleaningWorkspace
        currentItem={dataItem({ feedbacks: [reworkFeedback(1)] })}
        onUpdateDataCells={noopUpdate}
        onMarkDataRework={noopMark}
        onClearDataRework={noopClear}
      />,
    );
    expect(screen.getAllByTestId("workbench-data-rework-badge")).toHaveLength(1);

    // A new item version expires the old-version badge but keeps the record.
    rerender(
      <DataCleaningWorkspace
        currentItem={dataItem({ version: 2, feedbacks: [reworkFeedback(1)] })}
        onUpdateDataCells={noopUpdate}
        onMarkDataRework={noopMark}
        onClearDataRework={noopClear}
      />,
    );
    expect(screen.queryAllByTestId("workbench-data-rework-badge")).toHaveLength(0);

    // An unrelated note never becomes a badge.
    rerender(
      <DataCleaningWorkspace
        currentItem={dataItem({
          feedbacks: [{ ...reworkFeedback(1), wantsRework: false }],
        })}
        onUpdateDataCells={noopUpdate}
        onMarkDataRework={noopMark}
        onClearDataRework={noopClear}
      />,
    );
    expect(screen.queryAllByTestId("workbench-data-rework-badge")).toHaveLength(0);
  });

  // The large jsdom fixture checks reachability, not browser timing.
  it("keeps all 1,000 rows reachable while rendering only one bounded page", () => {
    const columns = Array.from({ length: 20 }, (_, index) => ({
      columnId: `c${index}`,
      title: `列 ${index}`,
    }));
    const rows = Array.from({ length: 1_000 }, (_, rowIndex) => ({
      rowId: `row-${rowIndex}`,
      cells: Object.fromEntries(columns.map((column) => [column.columnId, `v${rowIndex}`])),
    }));
    render(
      <DataCleaningWorkspace
        currentItem={dataItem({ dataPayload: { datasetId: "large", columns, rows, proposals: [] } })}
        onUpdateDataCells={noopUpdate}
        onMarkDataRework={noopMark}
        onClearDataRework={noopClear}
      />,
    );

    // 50 rows × 20 data columns = at most 1,000 mounted data cells.
    expect(screen.getAllByRole("row")).toHaveLength(51);
    expect(screen.getAllByRole("cell")).toHaveLength(1_050);
    expect(screen.getByTestId("workbench-data-pagination")).toHaveTextContent(
      "显示第 1–50 行，共 1000 行",
    );

    // Column selection retains its full filtered-dataset behavior across pages.
    fireEvent.click(screen.getByRole("button", { name: /列 0/ }));
    expect(screen.getByText(/已选 1000 格/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "末页" }));
    expect(screen.getAllByRole("row")).toHaveLength(51);
    expect(screen.getByText("row-999")).toBeInTheDocument();
    expect(screen.getByTestId("workbench-data-pagination")).toHaveTextContent(
      "显示第 951–1000 行，共 1000 行",
    );
  }, 30_000);
});
