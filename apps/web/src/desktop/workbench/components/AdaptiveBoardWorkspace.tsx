import type { JSX, MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Database,
  FileText,
  Film,
  Grid,
  ImageOff,
  Maximize2,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { WorkbenchDecision } from "@reelterminal/core";
import type {
  SelectModifiers,
  WorkbenchController,
  WorkbenchItemView,
  WorkbenchMutationResult,
} from "../types";
import { getWorkbenchStatusView } from "./lineage-tree-utils";

export interface AdaptiveBoardWorkspaceProps {
  readonly boardId?: string;
  readonly boardTitle: string;
  readonly items: readonly WorkbenchItemView[];
  readonly currentItem: WorkbenchItemView | null;
  readonly selectedIds: readonly string[];
  readonly onSelectItem: (itemId: string, modifiers?: SelectModifiers) => void;
  readonly onOpenChildItem: (itemId: string) => void;
  readonly onCommitDecision: (
    decision: WorkbenchDecision,
    targetIds?: readonly string[],
  ) => Promise<WorkbenchMutationResult>;
  readonly ensureItemsLoaded?: WorkbenchController["ensureItemsLoaded"];
  readonly openMediaUrl?: WorkbenchController["openMediaUrl"];
}

type ColumnCount = "auto" | 2 | 3 | 4;

export function AdaptiveBoardWorkspace({
  boardTitle,
  items,
  currentItem,
  selectedIds,
  onSelectItem,
  onOpenChildItem,
  onCommitDecision,
  ensureItemsLoaded,
  openMediaUrl,
}: AdaptiveBoardWorkspaceProps): JSX.Element {
  const defaultCols: ColumnCount = items.length === 2 ? 2 : items.length >= 3 ? 3 : "auto";
  const [columns, setColumns] = useState<ColumnCount>(defaultCols);
  const [zoom, setZoom] = useState<number>(100);
  const [pixelated, setPixelated] = useState<boolean>(false);
  const [resolvedUrls, setResolvedUrls] = useState<Record<string, string>>({});

  const itemIdsKey = useMemo(() => items.map((i) => i.id).join(","), [items]);

  useEffect(() => {
    if (!ensureItemsLoaded || items.length === 0) return;
    const missingIds = items.filter((i) => !i.detailsLoaded).map((i) => i.id);
    if (missingIds.length > 0) {
      void ensureItemsLoaded(missingIds);
    }
  }, [ensureItemsLoaded, itemIdsKey, items]);

  useEffect(() => {
    if (!openMediaUrl) return;
    let cancelled = false;
    const releases: Array<() => void> = [];
    const mediaIdsToLoad = new Set<string>();

    for (const item of items) {
      const imgMedia = item.imagePayload?.repairMedia ?? item.imagePayload?.originalMedia;
      if (imgMedia?.mediaId && !imgMedia.url && !imgMedia.thumbnailUrl && !resolvedUrls[imgMedia.mediaId]) {
        mediaIdsToLoad.add(imgMedia.mediaId);
      }
      const vidMedia = item.videoPayload?.media;
      if (vidMedia?.mediaId && !vidMedia.url && !resolvedUrls[vidMedia.mediaId]) {
        mediaIdsToLoad.add(vidMedia.mediaId);
      }
    }

    if (mediaIdsToLoad.size === 0) return;

    void Promise.all(
      Array.from(mediaIdsToLoad).map(async (mediaId) => {
        try {
          const handle = await openMediaUrl(mediaId);
          if (!handle) return;
          if (cancelled) {
            handle.release();
            return;
          }
          releases.push(handle.release);
          setResolvedUrls((prev) => ({ ...prev, [mediaId]: handle.url }));
        } catch {
          // Ignore individual media load errors on board preview
        }
      }),
    );

    return () => {
      cancelled = true;
      for (const release of releases) release();
    };
  }, [openMediaUrl, items, itemIdsKey]);

  const boardItemIds = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  const selectedInBoard = useMemo(
    () => selectedIds.filter((id) => boardItemIds.has(id)),
    [selectedIds, boardItemIds],
  );
  const pendingInBoard = useMemo(
    () => items.filter((i) => i.status === "pending").map((i) => i.id),
    [items],
  );

  const actionTargetIds = useMemo(() => {
    if (selectedInBoard.length > 0) return selectedInBoard;
    if (pendingInBoard.length > 0) return pendingInBoard;
    return items.map((i) => i.id);
  }, [selectedInBoard, pendingInBoard, items]);

  const gridClass =
    columns === 2
      ? "grid-cols-1 md:grid-cols-2"
      : columns === 3
        ? "grid-cols-1 md:grid-cols-2 xl:grid-cols-3"
        : columns === 4
          ? "grid-cols-2 md:grid-cols-3 xl:grid-cols-4"
          : "grid-cols-1 md:grid-cols-2 xl:grid-cols-3";

  const handleCardClick = (item: WorkbenchItemView, e: ReactMouseEvent) => {
    onSelectItem(item.id, {
      ctrl: e.ctrlKey,
      meta: e.metaKey,
      shift: e.shiftKey,
    });
  };

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden bg-bg"
      data-testid="adaptive-board-workspace"
    >
      {/* Top compact toolbar */}
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border bg-bg-1 px-2.5 text-xs select-none">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-[5px] border border-border bg-bg-2 p-0.5">
            {([2, 3, 4] as const).map((col) => (
              <button
                key={col}
                type="button"
                onClick={() => setColumns(col)}
                className={`inline-flex h-5 items-center gap-1 rounded-[3px] px-1.5 font-mono text-[11px] transition-colors ${
                  columns === col
                    ? "bg-bg-3 font-semibold text-fg shadow-xs"
                    : "text-fg-3 hover:text-fg-2"
                }`}
                title={`每行 ${col} 列`}
              >
                <Grid className="h-3 w-3" />
                {col}
              </button>
            ))}
          </div>

          <span className="h-3.5 w-px bg-border" />

          <span className="truncate font-semibold text-fg" title={boardTitle}>
            {boardTitle}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-fg-3">
            共 {items.length} 项 · 待审 {pendingInBoard.length}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <label className="flex cursor-pointer items-center gap-1 rounded border border-border bg-bg-2 px-1.5 py-0.5 text-[11px] text-fg-2 hover:text-fg">
            <input
              type="checkbox"
              checked={pixelated}
              onChange={(e) => setPixelated(e.target.checked)}
              className="h-3 w-3 accent-accent"
            />
            像素锐化
          </label>

          <div className="flex h-6 items-center rounded-[5px] border border-border bg-bg-2 px-0.5">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(50, z - 25))}
              disabled={zoom <= 50}
              className="p-0.5 text-fg-3 hover:text-fg disabled:opacity-30"
              title="缩小画板"
            >
              <ZoomOut className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => setZoom(100)}
              className="px-1 font-mono text-[11px] tabular-nums text-fg-2 hover:text-accent"
              title="重置为 100%"
            >
              {zoom}%
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(250, z + 25))}
              disabled={zoom >= 250}
              className="p-0.5 text-fg-3 hover:text-fg disabled:opacity-30"
              title="放大画板"
            >
              <ZoomIn className="h-3 w-3" />
            </button>
            {zoom !== 100 && (
              <button
                type="button"
                onClick={() => setZoom(100)}
                className="p-0.5 text-fg-3 hover:text-accent"
                title="重置缩放"
              >
                <RotateCcw className="h-3 w-3" />
              </button>
            )}
          </div>

          <span className="h-3.5 w-px bg-border" />

          <button
            type="button"
            onClick={() => void onCommitDecision("kept", actionTargetIds)}
            disabled={actionTargetIds.length === 0}
            className="inline-flex h-6 items-center rounded-[5px] border border-accent/50 bg-accent/15 px-2 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
            title="对当前选中或本画板待审子项批量标记保留"
            data-testid="board-keep-all"
          >
            整板保留 ({actionTargetIds.length})
          </button>
          <button
            type="button"
            onClick={() => void onCommitDecision("discarded", actionTargetIds)}
            disabled={actionTargetIds.length === 0}
            className="inline-flex h-6 items-center rounded-[5px] border border-status-error/40 bg-status-error/15 px-2 text-[11px] font-medium text-status-error transition-colors hover:bg-status-error/25 disabled:opacity-40"
            title="对当前选中或本画板待审子项批量标记丢弃"
            data-testid="board-discard-all"
          >
            整板丢弃
          </button>
        </div>
      </div>

      {/* Contact-sheet / Adaptive Board Canvas */}
      <div className="flex-1 overflow-auto bg-[#181b22] p-3">
        <div
          style={
            zoom !== 100
              ? {
                  transform: `scale(${zoom / 100})`,
                  transformOrigin: "top left",
                  width: `${10000 / zoom}%`,
                }
              : undefined
          }
          className={`grid gap-x-4 gap-y-3 ${gridClass}`}
        >
          {items.map((item) => {
            const isSelected = selectedIds.includes(item.id);
            const isCurrent = currentItem?.id === item.id;
            const statusView = getWorkbenchStatusView(item.status);
            const label = item.agentGuidance?.nodeSlotLabel ?? item.title;
            const subtitle = item.subtitle ? ` | ${item.subtitle}` : "";

            const imgMedia =
              item.imagePayload?.repairMedia ?? item.imagePayload?.originalMedia;
            const imgSrc =
              imgMedia?.url ??
              imgMedia?.thumbnailUrl ??
              (imgMedia?.mediaId ? resolvedUrls[imgMedia.mediaId] : null) ??
              null;
            const vidMedia = item.videoPayload?.media;
            const vidSrc =
              vidMedia?.url ??
              (vidMedia?.mediaId ? resolvedUrls[vidMedia.mediaId] : null) ??
              null;
            const annCount = item.imagePayload?.annotations.length ?? 0;
            const markerCount = item.videoPayload?.markers.length ?? 0;

            return (
              <div
                key={item.id}
                onClick={(e) => handleCardClick(item, e)}
                onDoubleClick={() => onOpenChildItem(item.id)}
                data-testid={`board-card-${item.id}`}
                className={`group flex flex-col rounded-md transition-all select-none ${
                  isSelected
                    ? "ring-1 ring-accent bg-white/[0.04]"
                    : isCurrent
                      ? "ring-1 ring-border-strong bg-white/[0.02]"
                      : "hover:bg-white/[0.02]"
                }`}
              >
                {/* Screenshot-2 style compact header line above each slot */}
                <div className="flex h-6 items-center justify-between gap-1.5 px-1.5 text-[11px]">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusView.dotClassName}`}
                      title={statusView.label}
                    />
                    <span
                      className="truncate font-medium text-fg"
                      title={`${label}${subtitle}`}
                    >
                      {label}
                      {subtitle && (
                        <span className="font-mono text-fg-3">{subtitle}</span>
                      )}
                    </span>
                    {item.version > 1 && (
                      <span className="shrink-0 font-mono text-[10px] text-fg-3">
                        v{item.version}
                      </span>
                    )}
                    {(annCount > 0 || markerCount > 0) && (
                      <span className="shrink-0 rounded bg-status-warning/15 px-1 font-mono text-[10px] text-status-warning">
                        {annCount + markerCount} 标
                      </span>
                    )}
                  </div>

                  {/* Quick hover actions */}
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onCommitDecision("kept", [item.id]);
                      }}
                      className="rounded px-1.5 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/20"
                      title="保留此项"
                    >
                      保留
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onCommitDecision("discarded", [item.id]);
                      }}
                      className="rounded px-1.5 py-0.5 text-[10px] text-fg-3 hover:bg-status-error/20 hover:text-status-error"
                      title="丢弃此项"
                    >
                      丢弃
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenChildItem(item.id);
                      }}
                      className="rounded p-0.5 text-fg-3 hover:bg-bg-3 hover:text-fg"
                      title="进入单项精修/标注视图 (或双击卡片)"
                      data-testid={`board-open-item-${item.id}`}
                    >
                      <Maximize2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                {/* Adaptive slot body by content type */}
                {item.type === "image" ? (
                  <div className="relative flex min-h-[160px] flex-1 items-center justify-center overflow-hidden rounded px-1 pb-1.5">
                    {imgSrc ? (
                      <img
                        src={imgSrc}
                        alt={item.title}
                        draggable={false}
                        style={{
                          imageRendering: pixelated ? "pixelated" : "auto",
                        }}
                        className="max-h-[320px] w-auto max-w-full object-contain"
                      />
                    ) : (
                      <div className="flex h-40 w-full flex-col items-center justify-center gap-1 rounded border border-border/40 bg-bg-1/50 text-fg-3">
                        <ImageOff className="h-4 w-4" />
                        <span className="text-[11px]">
                          {!item.detailsLoaded ? "正在载入图像…" : "图像未就绪"}
                        </span>
                      </div>
                    )}
                    {isSelected && (
                      <div className="pointer-events-none absolute right-2 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-fg shadow">
                        <Check className="h-2.5 w-2.5" />
                      </div>
                    )}
                  </div>
                ) : item.type === "text" ? (
                  <div className="flex flex-1 flex-col rounded border border-border/60 bg-bg-1 p-2.5 text-xs">
                    <div className="mb-1 flex items-center justify-between text-[11px] text-fg-3">
                      <span className="flex items-center gap-1">
                        <FileText className="h-3 w-3 text-status-info" />
                        {item.textPayload?.speakerOrContext ?? "文本语料"}
                      </span>
                      <span>双击批注/改文</span>
                    </div>
                    <pre className="max-h-52 flex-1 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-fg-2">
                      {item.textPayload?.currentText ??
                        item.textPayload?.originalText ??
                        (!item.detailsLoaded ? "正在载入文本…" : "无正文")}
                    </pre>
                  </div>
                ) : item.type === "data" ? (
                  <div className="flex flex-1 flex-col overflow-hidden rounded border border-border/60 bg-bg-1 p-2 text-xs">
                    <div className="mb-1.5 flex items-center justify-between text-[11px] text-fg-3">
                      <span className="flex items-center gap-1">
                        <Database className="h-3 w-3 text-status-warning" />
                        {item.dataPayload
                          ? `${item.dataPayload.rows.length} 行 × ${item.dataPayload.columns.length} 列`
                          : "数据表"}
                      </span>
                      {item.dataPayload && item.dataPayload.proposals.length > 0 && (
                        <span className="text-status-warning">
                          {item.dataPayload.proposals.filter((p) => p.status === "proposed").length} 项建议
                        </span>
                      )}
                    </div>
                    {item.dataPayload ? (
                      <div className="max-h-52 overflow-auto">
                        <table className="w-full border-collapse text-[11px]">
                          <thead>
                            <tr>
                              {item.dataPayload.columns.slice(0, 6).map((col) => (
                                <th
                                  key={col.columnId}
                                  className="border border-border bg-bg-2 px-1.5 py-1 text-left font-medium text-fg"
                                >
                                  {col.title}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {item.dataPayload.rows.slice(0, 8).map((row) => (
                              <tr key={row.rowId}>
                                {item.dataPayload!.columns.slice(0, 6).map((col) => (
                                  <td
                                    key={col.columnId}
                                    className="max-w-[140px] truncate border border-border px-1.5 py-0.5 text-fg-2"
                                  >
                                    {row.cells[col.columnId] ?? "∅"}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="py-6 text-center text-[11px] text-fg-3">
                        {!item.detailsLoaded ? "正在载入表格…" : "无表格内容"}
                      </div>
                    )}
                  </div>
                ) : item.type === "video" ? (
                  <div className="relative flex min-h-[160px] flex-1 flex-col items-center justify-center overflow-hidden rounded border border-border/40 bg-black/60 p-1">
                    {vidSrc ? (
                      <video
                        src={vidSrc}
                        controls
                        preload="metadata"
                        className="max-h-[260px] w-full object-contain"
                      />
                    ) : (
                      <div className="flex h-36 w-full flex-col items-center justify-center gap-1 text-fg-3">
                        <Film className="h-4 w-4 text-status-error" />
                        <span className="text-[11px]">
                          {!item.detailsLoaded ? "正在载入视频…" : "双击打开视频审阅"}
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex h-36 items-center justify-center rounded border border-border/50 bg-bg-1 text-xs text-fg-2">
                    双击查看 3D 模型 ({item.title})
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
export default AdaptiveBoardWorkspace;
