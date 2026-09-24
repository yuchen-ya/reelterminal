import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Film,
  Music,
  Pencil,
  Plus,
  Search,
  Trash2,
  Zap,
  FolderPlus,
} from "@/icons/lucide-compat";
import { mediaDisplayName, type WorkAsset } from "@reelterminal/core";
import { ToolcraftText as Text } from "@reelterminal/ui";
import {
  ToolcraftContextMenu as ContextMenu,
  type ToolcraftContextMenuOption as ContextMenuOption,
} from "@reelterminal/ui";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { toast } from "../../../stores/notification-store";

const formatSeconds = (seconds: number): string => {
  const rounded = Math.round(seconds * 100) / 100;
  return `${rounded}s`;
};

const formatDate = (timestamp: number): string => {
  try {
    return new Date(timestamp).toLocaleDateString();
  } catch {
    return "";
  }
};

const AUDIO_FILE_EXTENSIONS = /\.(mp3|wav|aac|flac|m4a|ogg)$/i;

/**
 * "2V+1A"-style summary of the member layout: the count of DISTINCT lanes per
 * track type, in the order the asset's members first introduce them.
 * Instantiation restores members by relative time and track relationships —
 * the vertical order of freshly created lanes may differ from the source
 * (see multiRestoreNote copy).
 */
const laneSummaryLabel = (asset: WorkAsset): string => {
  const counts = new Map<string, number>();
  const seenLanes = new Set<string>();
  for (const member of asset.members ?? []) {
    const laneKey = `${member.lane.trackType}:${member.lane.laneOffset}`;
    if (seenLanes.has(laneKey)) continue;
    seenLanes.add(laneKey);
    const type = member.lane.trackType;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => `${count}${type[0].toUpperCase()}`)
    .join("+");
};

const WorkAssetRow: React.FC<{
  asset: WorkAsset;
  missingSource: boolean;
  /** Missing media references across the anchor + all members (multi). */
  missingMediaCount: number;
  sourceName: string | null;
  thumbnailUrl: string | null;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => void;
  onAddToTimeline: () => void;
  onDragStart: (e: React.DragEvent) => void;
}> = ({
  asset,
  missingSource,
  missingMediaCount,
  sourceName,
  thumbnailUrl,
  onRename,
  onDelete,
  onAddToTimeline,
  onDragStart,
}) => {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const startRename = useCallback(() => {
    setNameDraft(asset.name);
    setIsRenaming(true);
  }, [asset.name]);

  const commitRename = useCallback(
    (viaBlur: boolean) => {
      const trimmed = nameDraft.trim();
      if (!trimmed || trimmed === asset.name) {
        if (!trimmed) {
          toast.error(t("workAssets.renameEmpty"));
        }
        if (viaBlur) {
          setIsRenaming(false);
          setNameDraft("");
        }
        return;
      }
      setIsRenaming(false);
      setNameDraft("");
      void onRename(trimmed);
    },
    [asset.name, nameDraft, onRename, t],
  );

  const renameKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitRename(false);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setIsRenaming(false);
        setNameDraft("");
      }
    },
    [commitRename],
  );

  const handleCardKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "F2" && !isRenaming) {
        event.preventDefault();
        event.stopPropagation();
        startRename();
      }
    },
    [isRenaming, startRename],
  );

  const contextMenuItems: ContextMenuOption[] = [
    {
      label: t("workAssets.renameAction"),
      icon: <Pencil size={14} aria-hidden />,
      onClick: startRename,
    },
    {
      label: t("workAssets.deleteAction"),
      icon: <Trash2 size={14} aria-hidden />,
      onClick: onDelete,
    },
  ];

  const snapshot = asset.clipSnapshot;
  const speed = snapshot?.speed;
  const effectCount =
    (snapshot?.effects.length ?? 0) + (snapshot?.audioEffects.length ?? 0);
  const isMulti = asset.kind === "multi";
  const memberCount = asset.members?.length ?? 0;
  const laneSummary = isMulti ? laneSummaryLabel(asset) : null;
  const SourceIcon =
    missingSource || !sourceName
      ? AlertTriangle
      : AUDIO_FILE_EXTENSIONS.test(sourceName)
        ? Music
        : Film;

  const renameInput = (
    <input
      autoFocus
      aria-label={t("workAssets.renameAriaLabel")}
      maxLength={200}
      value={nameDraft}
      onChange={(event) => setNameDraft(event.currentTarget.value)}
      onBlur={() => commitRename(true)}
      onKeyDown={renameKeyDown}
      className="w-full min-w-0 rounded-md border border-accent bg-bg-1 px-1.5 py-0.5 text-[12px] font-medium text-fg outline-none"
    />
  );

  return (
    <ContextMenu items={contextMenuItems} menuWidth={200} size="sm">
      <div
        tabIndex={0}
        draggable={!missingSource}
        onDragStart={missingSource ? undefined : onDragStart}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (!missingSource) onAddToTimeline();
        }}
        onKeyDown={handleCardKeyDown}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        data-work-asset-id={asset.id}
        className={`relative flex items-center gap-3 px-2 py-2 rounded-lg border-2 cursor-pointer transition-all group ${
          missingSource
            ? "border-yellow-500/60 bg-yellow-500/5"
            : "border-border hover:border-border-strong"
        }`}
      >
        <div className="w-9 h-9 rounded-md bg-bg-2 flex items-center justify-center flex-shrink-0 overflow-hidden">
          {thumbnailUrl && !missingSource ? (
            <img
              src={thumbnailUrl}
              alt=""
              draggable={false}
              className="w-full h-full object-cover"
            />
          ) : (
            <SourceIcon
              size={16}
              className={missingSource ? "text-yellow-500" : "text-primary/50"}
            />
          )}
        </div>

        <div className="flex-1 min-w-0">
          {isRenaming ? (
            renameInput
          ) : (
            <div
              className="text-[12px] truncate font-medium text-fg-2"
              title={`${asset.name}\nID: ${asset.id}`}
              onDoubleClick={(e) => {
                e.stopPropagation();
                startRename();
              }}
            >
              {asset.name}
            </div>
          )}
          {isMulti && (
            <div
              className="mt-0.5 inline-flex items-center gap-1 rounded bg-bg-2 px-1.5 py-0.5 text-[10px] font-medium text-fg-2 w-fit"
              title={t("workAssets.multiRestoreNote")}
            >
              <span className="tabular-nums">
                {t("workAssets.memberBadge", { count: memberCount })}
              </span>
              {laneSummary && <span className="text-fg-muted">· {laneSummary}</span>}
            </div>
          )}
          <div className="flex items-center gap-1.5 text-[10px] text-fg-muted flex-wrap">
            <span className="truncate max-w-[45%]" title={sourceName ?? undefined}>
              {missingSource
                ? t("workAssets.sourceMissingShort")
                : (sourceName ?? asset.sourceMediaId)}
            </span>
            <span>•</span>
            <span className="tabular-nums">
              {formatSeconds(asset.sourceRange.inSec)}–
              {formatSeconds(asset.sourceRange.outSec)}
            </span>
            {speed !== undefined && speed !== 1 && (
              <>
                <span>•</span>
                <span className="tabular-nums">×{speed}</span>
              </>
            )}
            {effectCount > 0 && (
              <>
                <span>•</span>
                <span className="inline-flex items-center gap-0.5">
                  <Zap size={9} aria-hidden />
                  {effectCount}
                </span>
              </>
            )}
            <span>•</span>
            <span>{formatDate(asset.createdAt)}</span>
          </div>
          {missingSource && (
            <div className="flex items-center gap-1 mt-0.5 text-[10px] text-yellow-500">
              <AlertTriangle size={10} aria-hidden />
              {isMulti && missingMediaCount > 0
                ? t("workAssets.missingMembersSource", {
                    count: missingMediaCount,
                  })
                : t("workAssets.missingSource")}
            </div>
          )}
        </div>

        {isHovered && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              aria-label={t("workAssets.addToTimeline")}
              title={
                missingSource
                  ? t("workAssets.missingSource")
                  : isMulti
                    ? t("workAssets.multiRestoreNote")
                    : t("workAssets.addToTimeline")
              }
              disabled={missingSource}
              onClick={(e) => {
                e.stopPropagation();
                onAddToTimeline();
              }}
              className="p-1.5 rounded bg-primary/20 hover:bg-primary/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus size={12} className="text-primary" />
            </button>
            <button
              type="button"
              aria-label={t("workAssets.deleteAction")}
              title={t("workAssets.deleteAction")}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="p-1.5 rounded bg-red-500/20 hover:bg-red-500/40 transition-colors"
            >
              <Trash2 size={12} className="text-red-400" />
            </button>
          </div>
        )}
      </div>
    </ContextMenu>
  );
};

/**
 * "Work assets" tab: project-scoped reusable clip captures. Distinct from the
 * Library tab, which holds the user's cross-project material library — work
 * assets live inside this project and are saved with it.
 */
export const WorkAssetsTab: React.FC = () => {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");

  const workAssets = useProjectStore((state) => state.project.workAssets);
  const mediaItems = useProjectStore(
    (state) => state.project.mediaLibrary.items,
  );

  const normalizedSearch = search.trim().toLowerCase();

  const sortedAssets = useMemo(() => {
    const items = [...(workAssets ?? [])];
    // Explicit ordering: the restore path may reorder the underlying array,
    // so the list never depends on it. Newest capture first, stable tiebreak
    // on the stable id.
    items.sort((a, b) =>
      b.createdAt === a.createdAt
        ? a.id.localeCompare(b.id)
        : b.createdAt - a.createdAt,
    );
    return items;
  }, [workAssets]);

  const filteredAssets = useMemo(
    () =>
      normalizedSearch
        ? sortedAssets.filter((asset) =>
            asset.name.toLowerCase().includes(normalizedSearch),
          )
        : sortedAssets,
    [sortedAssets, normalizedSearch],
  );

  const mediaNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of mediaItems) {
      map.set(item.id, mediaDisplayName(item));
    }
    return map;
  }, [mediaItems]);

  /**
   * Missing-source state per asset. kind "single" only has the anchor media;
   * kind "multi" turns yellow when the ANCHOR or ANY member's media is gone
   * (instantiate is all-or-nothing, so a partial layout can never land).
   * missingMediaCount tallies the missing references anchor-first; the multi
   * anchor is also a member, so a missing anchor is counted in both terms.
   */
  const missingByAssetId = useMemo(() => {
    const liveIds = new Set(mediaItems.map((item) => item.id));
    const map = new Map<
      string,
      { missingSource: boolean; missingMediaCount: number }
    >();
    for (const asset of sortedAssets) {
      const anchorMissing = !liveIds.has(asset.sourceMediaId);
      const memberMissing = (asset.members ?? []).filter(
        (member) => !liveIds.has(member.mediaId),
      ).length;
      map.set(asset.id, {
        missingSource: anchorMissing || memberMissing > 0,
        missingMediaCount: (anchorMissing ? 1 : 0) + memberMissing,
      });
    }
    return map;
  }, [sortedAssets, mediaItems]);

  /**
   * Best available preview per asset: the anchor media's filmstrip frame
   * nearest the captured in-point, falling back to the media thumbnail. Audio
   * and missing media stay icon-only.
   */
  const thumbnailByAssetId = useMemo(() => {
    const map = new Map<string, string | null>();
    const mediaById = new Map(mediaItems.map((item) => [item.id, item]));
    for (const asset of sortedAssets) {
      const media = mediaById.get(asset.sourceMediaId);
      if (!media) {
        map.set(asset.id, null);
        continue;
      }
      const strip = media.filmstripThumbnails;
      if (strip && strip.length > 0) {
        const inSec = asset.sourceRange.inSec;
        let best = strip[0];
        for (const frame of strip) {
          if (
            Math.abs(frame.timestamp - inSec) < Math.abs(best.timestamp - inSec)
          ) {
            best = frame;
          }
        }
        map.set(asset.id, best.url);
        continue;
      }
      map.set(asset.id, media.thumbnailUrl);
    }
    return map;
  }, [sortedAssets, mediaItems]);

  const handleRename = useCallback(
    async (assetId: string, nextName: string): Promise<boolean> => {
      const { renameWorkAsset } = useProjectStore.getState();
      const result = await renameWorkAsset(assetId, nextName);
      if (!result.success) {
        toast.error(t("workAssets.renameFailed"), result.error?.message ?? "");
        return false;
      }
      toast.success(t("workAssets.renamed"));
      return true;
    },
    [t],
  );

  const handleDelete = useCallback(
    async (asset: WorkAsset) => {
      if (
        !window.confirm(t("workAssets.deleteConfirm", { name: asset.name }))
      ) {
        return;
      }
      const { deleteWorkAsset } = useProjectStore.getState();
      const result = await deleteWorkAsset(asset.id);
      if (!result.success) {
        toast.error(t("workAssets.deleteFailed"), result.error?.message ?? "");
        return;
      }
      toast.success(t("workAssets.deleted"));
    },
    [t],
  );

  const handleAddToTimeline = useCallback(
    async (asset: WorkAsset) => {
      const { instantiateWorkAsset } = useProjectStore.getState();
      const result = await instantiateWorkAsset(asset.id);
      if (!result.ok) {
        toast.error(
          t("workAssets.addFailed"),
          result.code === "MEDIA_NOT_FOUND"
            ? t("workAssets.missingSource")
            : result.message,
        );
        return;
      }
      toast.success(t("workAssets.added"), asset.name);
    },
    [t],
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent, asset: WorkAsset) => {
      e.dataTransfer.setData(
        "application/json",
        JSON.stringify({ workAssetId: asset.id }),
      );
      e.dataTransfer.effectAllowed = "copy";
      useUIStore.getState().startDrag("workAsset", { workAssetId: asset.id });
    },
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 pt-[18px] shrink-0">
        <Text
          type="supporting"
          color="secondary"
          display="block"
          className="mb-3 text-[11px] text-fg-3"
        >
          {t("assets.descriptions.work")}
        </Text>
        <div className="flex items-center gap-2 mb-[14px] rounded-[9px] border border-border bg-bg px-2.5 py-1.5">
          <Search size={13} className="shrink-0 text-fg-3" aria-hidden />
          <input
            value={search}
            aria-label={t("workAssets.searchPlaceholder")}
            placeholder={t("workAssets.searchPlaceholder")}
            onChange={(event) => setSearch(event.target.value)}
            className="w-full bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-3"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain custom-scrollbar">
        <div className="px-4 pb-[18px]">
          {sortedAssets.length > 0 && (
            <div className="flex items-center justify-between mb-3">
              <span className="text-[13px] font-semibold text-fg-2">
                {t("workAssets.listTitle")}
              </span>
              <span className="text-[12px] font-medium text-fg-muted">
                {filteredAssets.length}
              </span>
            </div>
          )}
          {sortedAssets.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-8 text-center">
              <div className="w-16 h-16 rounded-2xl bg-bg-2 border border-border flex items-center justify-center mb-4 shadow-inner">
                <FolderPlus size={24} className="text-fg-muted" />
              </div>
              <Text
                type="body"
                color="secondary"
                weight="bold"
                display="block"
                className="mb-2 text-sm text-fg"
              >
                {t("workAssets.emptyTitle")}
              </Text>
              <Text
                type="supporting"
                color="secondary"
                display="block"
                className="text-xs text-fg-3"
              >
                {t("workAssets.emptyDetail")}
              </Text>
            </div>
          ) : filteredAssets.length === 0 ? (
            <div className="p-6 text-center text-xs text-fg-muted">
              {t("workAssets.noResults")}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filteredAssets.map((asset) => (
                <WorkAssetRow
                  key={asset.id}
                  asset={asset}
                  missingSource={missingByAssetId.get(asset.id)?.missingSource ?? false}
                  missingMediaCount={
                    missingByAssetId.get(asset.id)?.missingMediaCount ?? 0
                  }
                  sourceName={mediaNamesById.get(asset.sourceMediaId) ?? null}
                  thumbnailUrl={thumbnailByAssetId.get(asset.id) ?? null}
                  onRename={(name) => handleRename(asset.id, name)}
                  onDelete={() => void handleDelete(asset)}
                  onAddToTimeline={() => void handleAddToTimeline(asset)}
                  onDragStart={(e) => handleDragStart(e, asset)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default WorkAssetsTab;
