import type { JSX } from "react";
import type React from "react";
import { ArrowDownUp, Edit2, Flag, Sparkles } from "lucide-react";
import type { WorkbenchCellProposal } from "@reelterminal/core";
import type { WorkbenchItemView } from "../../types";

type WorkbenchDataPayload = NonNullable<WorkbenchItemView["dataPayload"]>;
type WorkbenchDataRow = WorkbenchDataPayload["rows"][number];

export interface DataCleaningTableProps {
  readonly columns: WorkbenchDataPayload["columns"];
  readonly pageRows: readonly WorkbenchDataRow[];
  readonly proposalsMap: ReadonlyMap<string, WorkbenchCellProposal>;
  readonly selectedCellSet: ReadonlySet<string>;
  readonly activeReworkKeys: ReadonlySet<string>;
  readonly sortCol: string | null;
  readonly sortAsc: boolean;
  readonly setSortCol: (col: string | null) => void;
  readonly setSortAsc: (asc: boolean) => void;
  readonly setPageIndex: (idx: number) => void;
  readonly selectRow: (rowId: string, e: React.MouseEvent) => void;
  readonly selectColumn: (columnId: string) => void;
  readonly toggleCell: (cellKey: string, e: React.MouseEvent) => void;
  readonly startManualCellEdit: (
    rowId: string,
    columnId: string,
    currentVal: string | null,
  ) => void;
  readonly commitManualCellEdit: (
    rowId: string,
    columnId: string,
    currentVal: string | null,
    setAsNull?: boolean,
  ) => void;
  readonly editingCellKey: string | null;
  readonly setEditingCellKey: (k: string | null) => void;
  readonly editValue: string;
  readonly setEditValue: (v: string) => void;
  readonly cellKeyOf: (rowId: string, columnId: string) => string;
}

export function DataCleaningTable({
  columns,
  pageRows,
  proposalsMap,
  selectedCellSet,
  activeReworkKeys,
  sortCol,
  sortAsc,
  setSortCol,
  setSortAsc,
  setPageIndex,
  selectRow,
  selectColumn,
  toggleCell,
  startManualCellEdit,
  commitManualCellEdit,
  editingCellKey,
  setEditingCellKey,
  editValue,
  setEditValue,
  cellKeyOf,
}: DataCleaningTableProps): JSX.Element {
  return (
    <div className="w-full overflow-auto">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="sticky top-0 z-10 border-b border-border bg-bg-2 text-fg-2 shadow-sm">
            <th className="w-28 border-r border-border px-3 py-2 font-mono text-[11px]">
              稳定 rowId
            </th>
            {columns.map((col) => (
              <th
                key={col.columnId}
                className="border-r border-border px-3 py-2 font-semibold last:border-r-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => selectColumn(col.columnId)}
                    className="text-left transition-colors hover:text-fg"
                    title="点击选中整列"
                  >
                    {col.title}
                    <span className="ml-1.5 font-mono text-[10px] text-fg-3">
                      ({col.columnId})
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPageIndex(0);
                      if (sortCol === col.columnId) {
                        setSortAsc(!sortAsc);
                      } else {
                        setSortCol(col.columnId);
                        setSortAsc(true);
                      }
                    }}
                    className={`rounded p-1 hover:bg-bg-3 ${
                      sortCol === col.columnId ? "text-accent" : "text-fg-3"
                    }`}
                    title="按此列排序（不改变稳定 rowId/columnId 定位）"
                  >
                    <ArrowDownUp className="h-3 w-3" />
                  </button>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {pageRows.map((row) => (
            <tr key={row.rowId} className="transition-colors hover:bg-bg-2">
              {/* Stable rowId gutter */}
              <td
                onClick={(e) => selectRow(row.rowId, e)}
                className="cursor-pointer border-r border-border bg-bg px-3 py-2 font-mono text-[11px] text-fg-3 hover:text-fg"
                title="点击选中整行（支持 Ctrl 多选）"
              >
                {row.rowId}
              </td>

              {columns.map((col) => {
                const cellKey = cellKeyOf(row.rowId, col.columnId);
                const val = row.cells[col.columnId];
                const prop = proposalsMap.get(cellKey);
                const isSelected = selectedCellSet.has(cellKey);
                const isEditing = editingCellKey === cellKey;
                const hasRework = activeReworkKeys.has(cellKey);

                return (
                  <td
                    key={col.columnId}
                    onClick={(e) => toggleCell(cellKey, e)}
                    onDoubleClick={() =>
                      startManualCellEdit(row.rowId, col.columnId, val)
                    }
                    className={`group relative cursor-pointer border-r border-border px-3 py-1.5 align-top transition-colors last:border-r-0 ${
                      col.monospace ? "font-mono tabular-nums" : ""
                    } ${
                      isSelected
                        ? "bg-accent/10 ring-1 ring-inset ring-accent"
                        : hasRework
                          ? "bg-status-warning/10"
                          : prop?.status === "proposed"
                            ? "bg-status-warning/10"
                            : prop?.status === "accepted"
                              ? "bg-accent/5"
                              : ""
                    }`}
                  >
                    {isEditing ? (
                      <div
                        className="flex items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") {
                              commitManualCellEdit(row.rowId, col.columnId, val);
                            }
                            if (e.key === "Escape") setEditingCellKey(null);
                          }}
                          autoFocus
                          className="w-full rounded border border-status-info bg-bg px-1.5 py-0.5 text-xs text-fg focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            commitManualCellEdit(row.rowId, col.columnId, val)
                          }
                          className="rounded bg-status-info px-1.5 py-0.5 text-[10px] font-semibold text-bg transition-opacity hover:opacity-90"
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            commitManualCellEdit(row.rowId, col.columnId, val, true)
                          }
                          className="rounded bg-bg-3 px-1.5 py-0.5 text-[10px] text-fg-2"
                          title="设为显式 NULL (缺失值)"
                        >
                          NULL
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-0.5">
                        {/* Current Value vs Semantic NULL / Empty String */}
                        <div className="flex items-center justify-between gap-2">
                          {val === null ? (
                            <span className="font-mono text-[11px] italic text-status-error/80">
                              NULL (未记录/缺失)
                            </span>
                          ) : val === "" ? (
                            <span className="font-mono text-[11px] italic text-fg-3">
                              "" (空字符串)
                            </span>
                          ) : (
                            <span className="text-fg">{val}</span>
                          )}

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              startManualCellEdit(row.rowId, col.columnId, val);
                            }}
                            className="p-0.5 text-fg-3 opacity-0 transition-opacity hover:text-fg focus:opacity-100 group-hover:opacity-100"
                            title="直接修改单元格值"
                          >
                            <Edit2 className="h-3 w-3" />
                          </button>
                        </div>

                        {hasRework && (
                          <div
                            className="flex items-center gap-1 text-[10px] font-semibold text-status-warning"
                            data-testid="workbench-data-rework-badge"
                          >
                            <Flag className="h-3 w-3" />
                            返工待处理（人工标记）
                          </div>
                        )}

                        {/* Agent Cleaning Proposal Inline Comparison */}
                        {prop && (
                          <div className="flex items-center justify-between gap-1.5 border-t border-border pt-0.5 text-[11px]">
                            {prop.status === "proposed" ? (
                              <>
                                <div className="flex min-w-0 items-center gap-1 text-status-warning">
                                  <Sparkles className="h-3 w-3 shrink-0" />
                                  <span className="line-through text-fg-3">
                                    {prop.originalValue ?? "NULL"}
                                  </span>
                                  <span>→</span>
                                  <span className="font-semibold text-status-warning">
                                    {prop.proposedValue ?? "NULL"}
                                  </span>
                                </div>
                                <span className="text-[10px] text-fg-3">待确认</span>
                              </>
                            ) : prop.status === "accepted" ? (
                              <span className="text-[10px] text-accent">
                                ✓ 已确认清洗 (原值: {prop.originalValue})
                              </span>
                            ) : prop.status === "rejected" ? (
                              <span className="text-[10px] text-fg-3">
                                ✕ 已拒绝建议 ({prop.proposedValue})
                              </span>
                            ) : (
                              <span className="text-[10px] text-status-info">
                                ✎ 人工改值 (原值: {prop.originalValue})
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
