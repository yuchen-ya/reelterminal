/**
 * Data cleaning table workspace (migrated from the AI-material workbench
 * prototype).
 *
 * The dataset is never overwritten wholesale: every write is an explicit
 * cell patch list (rowId/columnId/value plus proposalId+outcome) submitted
 * through onUpdateDataCells. Sorting and filtering are view-layer only —
 * patches always address stable rowId/columnId coordinates. Cell selection
 * starts empty and batch buttons always show the number of cells they act on.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type React from "react";
import {
  CheckCircle2,
  Filter,
  Flag,
  X,
  XCircle,
} from "lucide-react";
import type { WorkbenchCellProposal } from "@reelterminal/core";
import type {
  DataPatchInput,
  DataReworkCell,
  WorkbenchItemView,
  WorkbenchMutationResult,
} from "../types";
import { DataCleaningTable } from "./data/DataCleaningTable";

export interface DataCleaningWorkspaceProps {
  readonly currentItem: WorkbenchItemView;
  readonly onUpdateDataCells: (
    itemId: string,
    patches: readonly DataPatchInput[],
    markDecision?: "modified",
    expectedVersion?: number,
  ) => Promise<WorkbenchMutationResult>;
  readonly onMarkDataRework: (
    itemId: string,
    itemVersion: number,
    cells: readonly DataReworkCell[],
    reason?: string,
  ) => Promise<WorkbenchMutationResult>;
  readonly onClearDataRework: (
    itemId: string,
    itemVersion: number,
    cells: readonly DataReworkCell[],
  ) => Promise<WorkbenchMutationResult>;
}

// Length-prefix the row id so `(a-b, c)` and `(a, b-c)` never collide; this is
// a local selection key only — submitted patches use stable rowId/columnId.
const cellKeyOf = (rowId: string, columnId: string): string =>
  `${rowId.length}:${rowId}:${columnId}`;

function cellCoordinatesFromKey(
  key: string,
): { readonly rowId: string; readonly columnId: string } | null {
  const lengthEnd = key.indexOf(":");
  if (lengthEnd < 0) return null;
  const rowLength = Number(key.slice(0, lengthEnd));
  const rowStart = lengthEnd + 1;
  if (!Number.isInteger(rowLength) || rowLength < 0) return null;
  const rowId = key.slice(rowStart, rowStart + rowLength);
  if (key[rowStart + rowLength] !== ":") return null;
  return { rowId, columnId: key.slice(rowStart + rowLength + 1) };
}

const MAX_VISIBLE_ROWS = 50;
const MAX_VISIBLE_CELLS = 1_000;

export function DataCleaningWorkspace({
  currentItem,
  onUpdateDataCells,
  onMarkDataRework,
  onClearDataRework,
}: DataCleaningWorkspaceProps): JSX.Element {
  const payload = currentItem.dataPayload;
  const [selectedCellKeys, setSelectedCellKeys] = useState<readonly string[]>([]);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [onlyProposalsFilter, setOnlyProposalsFilter] = useState<boolean>(false);
  const [onlyReworkFilter, setOnlyReworkFilter] = useState<boolean>(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [editingCellKey, setEditingCellKey] = useState<string | null>(null);
  const [editingVersion, setEditingVersion] = useState<number | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [scopeNotice, setScopeNotice] = useState<string | null>(null);

  // Display state is scoped to this item version. Switching A/B (even with the
  // same row/column ids) or a version bump resets selections/drafts so an old
  // edit can never be written to a different item/version.
  const scopeRef = useRef({ id: currentItem.id, version: currentItem.version });
  const editingRef = useRef(editingCellKey);
  editingRef.current = editingCellKey;
  useEffect(() => {
    const previous = scopeRef.current;
    if (previous.id === currentItem.id && previous.version === currentItem.version) return;
    const discarded = editingRef.current !== null;
    scopeRef.current = { id: currentItem.id, version: currentItem.version };
    setSelectedCellKeys([]);
    setEditingCellKey(null);
    setEditingVersion(null);
    setEditValue("");
    setMutationError(null);
    setOnlyProposalsFilter(false);
    setOnlyReworkFilter(false);
    setPageIndex(0);
    if (previous.id === currentItem.id && discarded) {
      setScopeNotice(
        `条目已更新到 v${currentItem.version}：未保存的单元格编辑草稿已丢弃，请基于最新内容重试。`,
      );
    } else {
      setScopeNotice(null);
    }
  }, [currentItem.id, currentItem.version]);

  const proposalsMap = useMemo(() => {
    const map = new Map<string, WorkbenchCellProposal>();
    if (payload) {
      payload.proposals.forEach((p) => {
        map.set(cellKeyOf(p.rowId, p.columnId), p);
      });
    }
    return map;
  }, [payload]);

  // Keep selection resolution proportional to the number of selected cells.
  // A rows×columns coordinate Map duplicates the full table in memory.
  const rowIds = useMemo(
    () => new Set(payload?.rows.map((row) => row.rowId) ?? []),
    [payload],
  );
  const columnIds = useMemo(
    () => new Set(payload?.columns.map((column) => column.columnId) ?? []),
    [payload],
  );
  const selectedCellSet = useMemo(() => new Set(selectedCellKeys), [selectedCellKeys]);

  /** Active rework badges for THIS item version (new versions expire them). */
  const activeReworkKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const feedback of currentItem.feedbacks) {
      if (
        !feedback.wantsRework ||
        feedback.isDraft ||
        feedback.clearedAt !== undefined ||
        feedback.itemVersion !== currentItem.version ||
        feedback.target?.kind !== "data-cell"
      ) {
        continue;
      }
      keys.add(cellKeyOf(feedback.target.rowId, feedback.target.columnId));
    }
    return keys;
  }, [currentItem.feedbacks, currentItem.version]);

  const selectedReworkCells = useMemo(
    () => selectedCellKeys.filter((key) => activeReworkKeys.has(key)),
    [selectedCellKeys, activeReworkKeys],
  );

  const selectedDraftCells = useMemo<DataReworkCell[]>(
    () =>
      selectedCellKeys.flatMap((key) => {
        const cell = cellCoordinatesFromKey(key);
        if (!cell || !rowIds.has(cell.rowId) || !columnIds.has(cell.columnId)) return [];
        const proposal = proposalsMap.get(key);
        return [
          {
            ...cell,
            ...(proposal?.status === "proposed" ? { proposalId: proposal.proposalId } : {}),
          },
        ];
      }),
    [selectedCellKeys, rowIds, columnIds, proposalsMap],
  );

  const visibleRows = useMemo(() => {
    if (!payload) return [];
    let list = [...payload.rows];
    if (onlyProposalsFilter) {
      list = list.filter((row) =>
        payload.columns.some(
          (col) => proposalsMap.get(cellKeyOf(row.rowId, col.columnId))?.status === "proposed",
        ),
      );
    }
    if (onlyReworkFilter) {
      list = list.filter((row) =>
        payload.columns.some((col) =>
          activeReworkKeys.has(cellKeyOf(row.rowId, col.columnId)),
        ),
      );
    }
    if (sortCol) {
      list.sort((a, b) => {
        const va = a.cells[sortCol] ?? "";
        const vb = b.cells[sortCol] ?? "";
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      });
    }
    return list;
  }, [payload, onlyProposalsFilter, onlyReworkFilter, activeReworkKeys, sortCol, sortAsc, proposalsMap]);

  const rowsPerPage = Math.max(
    1,
    Math.min(MAX_VISIBLE_ROWS, Math.floor(MAX_VISIBLE_CELLS / Math.max(1, payload?.columns.length ?? 1))),
  );
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / rowsPerPage));
  const currentPageIndex = Math.min(pageIndex, pageCount - 1);
  const firstVisibleRow = currentPageIndex * rowsPerPage;
  const pageRows = visibleRows.slice(firstVisibleRow, firstVisibleRow + rowsPerPage);

  const runMutation = async (
    label: string,
    action: () => Promise<WorkbenchMutationResult>,
  ): Promise<boolean> => {
    try {
      const result = await action();
      if (result.ok) return true;
      setMutationError(`${label}失败：${result.message}`);
      return false;
    } catch (error) {
      setMutationError(`${label}失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  if (!payload) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg text-xs text-fg-3">
        数据内容未提供
      </div>
    );
  }

  const pendingProposals = payload.proposals.filter((p) => p.status === "proposed");

  // Toggle cell selection
  const toggleCell = (cellKey: string, e: React.MouseEvent): void => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      setSelectedCellKeys((prev) =>
        prev.includes(cellKey) ? prev.filter((k) => k !== cellKey) : [...prev, cellKey],
      );
    } else {
      setSelectedCellKeys([cellKey]);
    }
  };

  // Select an entire row by stable rowId
  const selectRow = (rowId: string, e: React.MouseEvent): void => {
    const rowCellKeys = payload.columns.map((c) => cellKeyOf(rowId, c.columnId));
    if (e.ctrlKey || e.metaKey) {
      setSelectedCellKeys((prev) => Array.from(new Set([...prev, ...rowCellKeys])));
    } else {
      setSelectedCellKeys(rowCellKeys);
    }
  };

  // Select an entire column by stable columnId across visible rows
  const selectColumn = (columnId: string): void => {
    setSelectedCellKeys(visibleRows.map((r) => cellKeyOf(r.rowId, columnId)));
  };

  // Count how many selected cells have pending proposals
  const selectedPendingProposals = selectedCellKeys
    .map((k) => proposalsMap.get(k))
    .filter((p): p is WorkbenchCellProposal => !!p && p.status === "proposed");

  // Batch Accept Selected Proposals (strictly stable rowId/columnId patches)
  const handleBatchAcceptProposals = (): void => {
    if (selectedPendingProposals.length === 0) return;
    const patches: DataPatchInput[] = selectedPendingProposals.map((p) => ({
      rowId: p.rowId,
      columnId: p.columnId,
      value: p.proposedValue,
      proposalId: p.proposalId,
      proposalOutcome: "accepted",
    }));
    void runMutation(`确认 ${patches.length} 项单元格清洗提议`, () =>
      onUpdateDataCells(currentItem.id, patches, "modified", currentItem.version),
    );
  };

  // Batch Reject Selected Proposals. A reject changes the proposal status but
  // NEVER the cell value: value is omitted so a human-edited value is preserved
  // instead of being reset to proposal.originalValue.
  const handleBatchRejectProposals = (): void => {
    if (selectedPendingProposals.length === 0) return;
    const patches: DataPatchInput[] = selectedPendingProposals.map((p) => ({
      rowId: p.rowId,
      columnId: p.columnId,
      proposalId: p.proposalId,
      proposalOutcome: "rejected",
    }));
    void runMutation(`拒绝 ${patches.length} 项清洗提议`, () =>
      onUpdateDataCells(currentItem.id, patches, undefined, currentItem.version),
    );
  };

  // Explicit rework marking: confirmed per-cell feedback + item rework in ONE
  // commit. Selection never derives rework from notes or text keywords.
  const handleMarkRework = (): void => {
    if (selectedDraftCells.length === 0) return;
    void runMutation(`标记 ${selectedDraftCells.length} 格返工`, async () => {
      const result = await onMarkDataRework(
        currentItem.id,
        currentItem.version,
        selectedDraftCells,
      );
      if (result.ok) setScopeNotice(null);
      return result;
    });
  };

  const handleClearRework = (): void => {
    const cells: DataReworkCell[] = selectedReworkCells.flatMap((key) => {
      const cell = cellCoordinatesFromKey(key);
      return cell && rowIds.has(cell.rowId) && columnIds.has(cell.columnId) ? [cell] : [];
    });
    if (cells.length === 0) return;
    void runMutation(`取消 ${cells.length} 格返工标记`, () =>
      onClearDataRework(currentItem.id, currentItem.version, cells),
    );
  };

  const startManualCellEdit = (
    rowId: string,
    columnId: string,
    currentVal: string | null,
  ): void => {
    setEditingCellKey(cellKeyOf(rowId, columnId));
    setEditingVersion(currentItem.version);
    setEditValue(currentVal === null ? "" : currentVal);
  };

  const commitManualCellEdit = (
    rowId: string,
    columnId: string,
    currentVal: string | null,
    setAsNull = false,
  ): void => {
    const baseVersion = editingVersion;
    setEditingCellKey(null);
    setEditingVersion(null);
    if (baseVersion !== null && baseVersion !== currentItem.version) {
      // The item moved while the draft was open: drop it explicitly.
      setScopeNotice(
        `条目已更新到 v${currentItem.version}：基于 v${baseVersion} 的编辑未写入，请重试。`,
      );
      return;
    }
    const finalValue: string | null = setAsNull ? null : editValue;
    const proposal = proposalsMap.get(cellKeyOf(rowId, columnId));
    // A manual edit that changes nothing (and resolves no proposal) is not
    // worth a patch/revision entry.
    if (!proposal && (finalValue ?? null) === (currentVal ?? null)) return;
    const patch: DataPatchInput = {
      rowId,
      columnId,
      value: finalValue,
      ...(proposal
        ? { proposalId: proposal.proposalId, proposalOutcome: "modified" as const }
        : {}),
    };
    void runMutation(
      `手动修改单元格 [${rowId}:${columnId}] -> ${finalValue === null ? "NULL(缺失)" : `"${finalValue}"`}`,
      () =>
        onUpdateDataCells(
          currentItem.id,
          [patch],
          "modified",
          currentItem.version,
        ),
    );
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg">
      {/* Top Ergonomic Table Control Bar */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 overflow-x-auto border-b border-border bg-bg-1 px-2.5">
        <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          <span
            className="max-w-[140px] truncate font-mono text-xs font-semibold text-fg"
            title={payload.datasetId}
          >
            {payload.datasetId}
          </span>
          <span className="text-fg-3">·</span>
          <button
            type="button"
            onClick={() => {
              setOnlyProposalsFilter(!onlyProposalsFilter);
              setPageIndex(0);
            }}
            className={`inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] border px-2 text-[11px] transition-colors ${
              onlyProposalsFilter
                ? "border-status-warning/40 bg-status-warning/15 text-status-warning"
                : "border-border bg-bg-2 text-fg-2 hover:text-fg"
            }`}
          >
            <Filter className="h-3 w-3" />
            <span>待确认 ({pendingProposals.length})</span>
            <span className="sr-only">仅看含待确认建议行</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setOnlyReworkFilter(!onlyReworkFilter);
              setPageIndex(0);
            }}
            className={`inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] border px-2 text-[11px] transition-colors ${
              onlyReworkFilter
                ? "border-status-warning/40 bg-status-warning/15 text-status-warning"
                : "border-border bg-bg-2 text-fg-2 hover:text-fg"
            }`}
          >
            <Flag className="h-3 w-3" />
            <span>返工行 ({activeReworkKeys.size})</span>
            <span className="sr-only">仅看返工标记行</span>
          </button>
          <button
            type="button"
            onClick={() =>
              setSelectedCellKeys(
                pendingProposals.map((p) => cellKeyOf(p.rowId, p.columnId)),
              )
            }
            className="inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-[5px] border border-border bg-bg-2 px-2 text-[11px] text-fg-2 transition-colors hover:text-fg"
          >
            <span>全选建议 ({pendingProposals.length})</span>
            <span className="sr-only">全选待清洗建议项</span>
          </button>
        </div>

        {/* Explicit Batch Scope Action Buttons (always shows scope count; disabled if 0) */}
        <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          <span className="mr-1 font-mono text-[11px] tabular-nums text-fg-3 whitespace-nowrap">
            已选 {selectedCellKeys.length} 格
            <span className="sr-only">
              {" "}
              ({selectedPendingProposals.length} 项待确认提议 ·{" "}
              {selectedReworkCells.length} 格返工)
            </span>
          </span>
          <button
            type="button"
            onClick={handleMarkRework}
            disabled={selectedDraftCells.length === 0}
            className="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] border border-status-warning/50 bg-status-warning/15 px-2 text-[11px] font-semibold text-status-warning transition-colors hover:bg-status-warning/25 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="workbench-data-mark-rework"
          >
            <Flag className="h-3 w-3" />
            标记返工 ({selectedDraftCells.length} 格)
          </button>
          <button
            type="button"
            onClick={handleClearRework}
            disabled={selectedReworkCells.length === 0}
            className="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] border border-border-strong bg-bg-2 px-2 text-[11px] font-medium text-fg-2 transition-colors hover:text-fg disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="workbench-data-clear-rework"
          >
            <XCircle className="h-3 w-3" />
            取消返工 ({selectedReworkCells.length} 格)
          </button>
          <button
            type="button"
            onClick={handleBatchAcceptProposals}
            disabled={selectedPendingProposals.length === 0}
            className="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] bg-accent px-2 text-[11px] font-semibold text-accent-fg transition-colors hover:brightness-110 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40"
          >
            <CheckCircle2 className="h-3 w-3" />
            确认建议 ({selectedPendingProposals.length} 项)
          </button>
          <button
            type="button"
            onClick={handleBatchRejectProposals}
            disabled={selectedPendingProposals.length === 0}
            className="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] border border-border-strong bg-bg-2 px-2 text-[11px] font-medium text-fg-2 transition-colors hover:text-fg disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40"
          >
            <XCircle className="h-3 w-3" />
            拒绝建议 ({selectedPendingProposals.length} 项)
          </button>
        </div>
      </div>

      {/* Mutation error strip (controller failures are never silent) */}
      {scopeNotice && (
        <div
          className="flex shrink-0 items-center justify-between gap-3 border-b border-status-warning/40 bg-status-warning/10 px-3 py-1.5 text-xs text-status-warning"
          data-testid="workbench-data-scope-notice"
        >
          <span className="truncate">{scopeNotice}</span>
          <button
            type="button"
            onClick={() => setScopeNotice(null)}
            className="shrink-0 hover:text-fg"
            title="关闭提示"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {mutationError && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-status-error/40 bg-status-error/10 px-3 py-1.5 text-xs text-status-error">
          <span className="truncate">{mutationError}</span>
          <button
            type="button"
            onClick={() => setMutationError(null)}
            className="shrink-0 hover:text-fg"
            title="关闭错误提示"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Main Table Area */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex-1 min-h-0 overflow-auto">
          <DataCleaningTable
            columns={payload.columns}
            pageRows={pageRows}
            proposalsMap={proposalsMap}
            selectedCellSet={selectedCellSet}
            activeReworkKeys={activeReworkKeys}
            sortCol={sortCol}
            sortAsc={sortAsc}
            setSortCol={setSortCol}
            setSortAsc={setSortAsc}
            setPageIndex={setPageIndex}
            selectRow={selectRow}
            selectColumn={selectColumn}
            toggleCell={toggleCell}
            startManualCellEdit={startManualCellEdit}
            commitManualCellEdit={commitManualCellEdit}
            editingCellKey={editingCellKey}
            setEditingCellKey={setEditingCellKey}
            editValue={editValue}
            setEditValue={setEditValue}
            cellKeyOf={cellKeyOf}
          />
        </div>

        {/* Selected Proposal Inspection Strip */}
        {selectedPendingProposals.length > 0 && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-status-warning/35 bg-bg-1 px-3 py-1.5 text-xs">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 font-medium text-status-warning">
                选中包含 {selectedPendingProposals.length} 项清洗提议：
              </span>
              <span className="truncate font-mono text-[11px] text-fg-2">
                {selectedPendingProposals
                  .map(
                    (p) =>
                      `[${cellKeyOf(p.rowId, p.columnId)}] "${p.originalValue}" → "${p.proposedValue}" (${p.reason})`,
                  )
                  .join(" · ")}
              </span>
            </div>
            <button
              type="button"
              onClick={handleBatchAcceptProposals}
              className="inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-[4px] bg-accent px-2.5 text-[11px] font-semibold text-accent-fg transition-colors hover:brightness-110"
            >
              立即确认这 {selectedPendingProposals.length} 项清洗
            </button>
          </div>
        )}

        {/* Bottom-Pinned Pagination Bar */}
        <div
          className="flex h-9 shrink-0 items-center justify-between border-t border-border bg-bg-1 px-3 text-xs text-fg-2"
          data-testid="workbench-data-pagination"
        >
          <span>
            {visibleRows.length === 0
              ? "无匹配行"
              : `显示第 ${firstVisibleRow + 1}–${Math.min(firstVisibleRow + pageRows.length, visibleRows.length)} 行，共 ${visibleRows.length} 行`}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPageIndex(0)}
              disabled={currentPageIndex === 0}
              className="inline-flex h-6 items-center rounded-[4px] border border-border px-2 text-xs hover:bg-bg-2 disabled:pointer-events-none disabled:opacity-40"
            >
              首页
            </button>
            <button
              type="button"
              onClick={() => setPageIndex(currentPageIndex - 1)}
              disabled={currentPageIndex === 0}
              className="inline-flex h-6 items-center rounded-[4px] border border-border px-2 text-xs hover:bg-bg-2 disabled:pointer-events-none disabled:opacity-40"
            >
              上一页
            </button>
            <span className="min-w-16 text-center font-mono tabular-nums">
              {currentPageIndex + 1} / {pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPageIndex(currentPageIndex + 1)}
              disabled={currentPageIndex >= pageCount - 1}
              className="inline-flex h-6 items-center rounded-[4px] border border-border px-2 text-xs hover:bg-bg-2 disabled:pointer-events-none disabled:opacity-40"
            >
              下一页
            </button>
            <button
              type="button"
              onClick={() => setPageIndex(pageCount - 1)}
              disabled={currentPageIndex >= pageCount - 1}
              className="inline-flex h-6 items-center rounded-[4px] border border-border px-2 text-xs hover:bg-bg-2 disabled:pointer-events-none disabled:opacity-40"
            >
              末页
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
