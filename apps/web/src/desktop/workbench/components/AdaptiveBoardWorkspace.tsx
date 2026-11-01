import { useTranslation } from "react-i18next";
import type { JSX, MouseEvent as ReactMouseEvent } from "react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  Check,
  Database,
  FileText,
  Film,
  Grid,
  ImageOff,
  Maximize2,
} from "lucide-react";
import type { WorkbenchDecision } from "@reelterminal/core";
import type {
  SelectModifiers,
  WorkbenchController,
  WorkbenchItemView,
  WorkbenchMutationResult,
} from "../types";
import { CollectionActions } from "./CollectionActions";
import { CollectionImage } from "./CollectionImage";
import { getWorkbenchStatusView } from "./lineage-tree-utils";

const ReviewMarkdown = lazy(() => import("./ReviewMarkdown"));

export interface AdaptiveBoardWorkspaceProps {
  readonly boardId?: string;
  readonly boardTitle: string;
  readonly items: readonly WorkbenchItemView[];
  readonly allItems?: readonly WorkbenchItemView[];
  readonly currentItem: WorkbenchItemView | null;
  readonly selectedIds: readonly string[];
  readonly onSelectItem: (itemId: string, modifiers?: SelectModifiers) => void;
  readonly onOpenChildItem: (itemId: string) => void;
  readonly onCommitDecision: (
    decision: WorkbenchDecision,
    targetIds?: readonly string[],
  ) => Promise<WorkbenchMutationResult>;
  readonly onSelectAll?: () => void;
  readonly onClearSelection?: () => void;
  readonly onOpenBatch?: () => void;
  readonly ensureItemsLoaded?: WorkbenchController["ensureItemsLoaded"];
  readonly openMediaUrl?: WorkbenchController["openMediaUrl"];
}

type ColumnCount = "auto" | 2 | 3 | 4;

export function AdaptiveBoardWorkspace({
  boardTitle,
  items,
  allItems = items,
  currentItem,
  selectedIds,
  onSelectItem,
  onOpenChildItem,
  onCommitDecision,
  onSelectAll,
  onClearSelection,
  onOpenBatch,
  ensureItemsLoaded,
  openMediaUrl,
}: AdaptiveBoardWorkspaceProps): JSX.Element {
  const { t } = useTranslation();
  const defaultCols: ColumnCount = items.length === 2 ? 2 : items.length >= 3 ? 3 : "auto";
  const [columns, setColumns] = useState<ColumnCount>(defaultCols);
  const [previewMode, setPreviewMode] = useState<"fit" | "actual" | "pixel">("fit");
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
    () => allItems.filter((i) => i.status === "pending").map((i) => i.id),
    [allItems],
  );


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
      <div className="flex min-h-8 shrink-0 flex-wrap items-center justify-between gap-2 py-1 border-b border-border bg-bg-1 px-2.5 text-xs select-none">
        <div className="flex min-w-0 items-center gap-2">
          {onOpenBatch && <button className="shrink-0 text-fg-3 hover:text-fg" onClick={onOpenBatch}>{t("This batch")}</button>}
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
                title={t("{{v0}} columns per row", { v0: col })}
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
          <span className="shrink-0 font-mono text-[11px] text-fg-3">{t("Total: {{v0}} · Results: {{v1}} · Pending: {{v2}}", { v0: allItems.length, v1: items.length, v2: pendingInBoard.length })}</span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <select aria-label={t("Image preview mode")} value={previewMode} onChange={event => setPreviewMode(event.target.value as typeof previewMode)} className="rounded border border-border bg-bg-2 px-2 py-1">
            <option value="fit">{t("Fit entire image")}</option><option value="actual">{t("Actual pixels")}</option><option value="pixel">{t("Pixel preview")}</option>
          </select>
          <span className="h-3.5 w-px bg-border" />

          <button
            type="button"
            onClick={() => void onCommitDecision("kept", pendingInBoard)}
            disabled={pendingInBoard.length === 0}
            className="inline-flex h-6 items-center rounded-[5px] border border-accent/50 bg-accent/15 px-2 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
            title={t("Keep only pending items in this group")}
            data-testid="board-keep-all"
          >{t("Keep pending items in this group ({{v0}})", { v0: pendingInBoard.length })}</button>
          <button
            type="button"
            onClick={() => void onCommitDecision("discarded", pendingInBoard)}
            disabled={pendingInBoard.length === 0}
            className="inline-flex h-6 items-center rounded-[5px] border border-status-error/40 bg-status-error/15 px-2 text-[11px] font-medium text-status-error transition-colors hover:bg-status-error/25 disabled:opacity-40"
            title={t("Discard only pending items in this group (including filtered-out items)")}
            data-testid="board-discard-all"
          >{t("Discard pending items in this group ({{v0}})", { v0: pendingInBoard.length })}</button>
          <CollectionActions scope={{ title: boardTitle, items: allItems, folder: true }} />
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-3 py-1.5 text-xs">
        <button onClick={onSelectAll} disabled={!items.length}>{t("Select all results ({{v0}})", { v0: items.length })}</button>
        <span>{t("Selected: {{v0}}", { v0: selectedInBoard.length })}</span>
        {selectedInBoard.length > 0 && <button onClick={onClearSelection}>{t("Clear selection")}</button>}
      </div>

      {/* Contact-sheet / Adaptive Board Canvas */}
      <div className="flex-1 overflow-auto bg-stage-bg p-3">
        {items.length === 0 && <p className="p-6 text-center text-xs text-fg-3">{t("No items match these filters. Choose All to view this group.")}</p>}
        <div data-board-grid className={`grid gap-x-4 gap-y-3 ${gridClass}`}>
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
              <CollectionActions key={item.id} scope={{ title: item.title, items: [item], folder: false, rootItemId: item.id, placementGroupId: item.placement ? item.placement.groupId : item.lineage?.upstreamGroupId ?? null }}>
              <div
                tabIndex={0}
                data-board-card
                onKeyDown={event => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter") { event.preventDefault(); onOpenChildItem(item.id); return; }
                  const columnCount = columns === "auto" ? 1 : columns;
                  const offset = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columnCount, ArrowDown: columnCount } as Record<string, number>)[event.key];
                  if (offset === undefined) return;
                  event.preventDefault();
                  const cards = Array.from(event.currentTarget.closest("[data-board-grid]")!.querySelectorAll<HTMLElement>("[data-board-card]"));
                  cards[cards.indexOf(event.currentTarget) + offset]?.focus();
                }}
                onClick={(e) => handleCardClick(item, e)}
                onDoubleClick={() => onOpenChildItem(item.id)}
                data-testid={`board-card-${item.id}`}
                className={`group flex flex-col rounded-md transition-all select-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
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
                      <span className="shrink-0 rounded bg-status-warning/15 px-1 font-mono text-[10px] text-status-warning">{t("{{v0}} marks", { v0: annCount + markerCount })}</span>
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
                      title={t("Keep this item")}
                    >{t("Keep")}</button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onCommitDecision("discarded", [item.id]);
                      }}
                      className="rounded px-1.5 py-0.5 text-[10px] text-fg-3 hover:bg-status-error/20 hover:text-status-error"
                      title={t("Discard this item")}
                    >{t("Discard")}</button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenChildItem(item.id);
                      }}
                      className="rounded p-0.5 text-fg-3 hover:bg-bg-3 hover:text-fg"
                      title={t("Open the item for repair or annotation (or double-click its card)")}
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
                      <CollectionImage src={imgSrc} title={item.title} mode={previewMode} />
                    ) : (
                      <div className="flex h-40 w-full flex-col items-center justify-center gap-1 rounded border border-border/40 bg-bg-1/50 text-fg-3">
                        <ImageOff className="h-4 w-4" />
                        <span className="text-[11px]">
                          {!item.detailsLoaded ? t("Loading image…") : t("Image not ready")}
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
                        {item.textPayload?.speakerOrContext ?? t("Text corpus")}
                      </span>
                      <span>{t("Double-click to read")}</span>
                    </div>
                    <div className="review-markdown-summary max-h-52 overflow-hidden text-xs">
                      <Suspense fallback={<span>{t("Loading text…")}</span>}>
                        <ReviewMarkdown source={item.textPayload?.currentText ?? item.textPayload?.originalText ?? ""} />
                      </Suspense>
                    </div>
                  </div>
                ) : item.type === "data" ? (
                  <div className="flex flex-1 flex-col overflow-hidden rounded border border-border/60 bg-bg-1 p-2 text-xs">
                    <div className="mb-1.5 flex items-center justify-between text-[11px] text-fg-3">
                      <span className="flex items-center gap-1">
                        <Database className="h-3 w-3 text-status-warning" />
                        {item.dataPayload
                          ? t("{{v0}} rows × {{v1}} columns", { v0: item.dataPayload.rows.length, v1: item.dataPayload.columns.length })
                          : t("review.kind.data")}
                      </span>
                      {item.dataPayload && item.dataPayload.proposals.length > 0 && (
                        <span className="text-status-warning">{t("Suggestions: {{v0}}", { v0: item.dataPayload.proposals.filter((p) => p.status === "proposed").length })}</span>
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
                        {!item.detailsLoaded ? t("Loading table…") : t("No table content")}
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
                          {!item.detailsLoaded ? t("Loading video…") : t("Double-click to review the video")}
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex h-36 items-center justify-center rounded border border-border/50 bg-bg-1 text-xs text-fg-2">{t("Double-click to view the 3D model ({{v0}})", { v0: item.title })}</div>
                )}
              </div>
              </CollectionActions>
            );
          })}
        </div>
      </div>
    </div>
  );
}
export default AdaptiveBoardWorkspace;
