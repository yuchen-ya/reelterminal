import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDuration } from "../../utils/format";
import { useTranslation } from "react-i18next";
import {
  Image as ImageIcon, Film, Music, Plus, Upload, Trash2,
  Square, Circle, Triangle, Star, ArrowRight, Hexagon, FileCode, AlertTriangle,
  RefreshCw, Palette, Video, BookMarked, Search, Pencil, FolderPlus,
  Type, Shapes, Wand2, LayoutTemplate, Zap, Shuffle,
} from "@/icons/lucide-compat";
import {
  BACKGROUND_PRESETS,
  generateBackgroundBlob,
  type BackgroundPreset,
} from "../../services/background-generator";
import type { ShapeType } from "@reelterminal/core";
import {
  mediaDisplayName,
  validateSvgContent,
  type SvgValidationErrorCode,
} from "@reelterminal/core";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import { useTimelineStore } from "../../stores/timeline-store";
import type { MediaItem } from "@reelterminal/core";
import { AspectRatioMatchDialog } from "./dialogs/AspectRatioMatchDialog";
import { EditingToolsTab } from "./EditingToolsTab";
import { RecipesTab } from "./panels/RecipesTab";
import { TemplatesTab } from "./panels/TemplatesTab";
import {
  EffectsPanel,
  TransitionsPanel,
} from "./panels/EffectsTransitionsPanel";
import { TextPresetsPanel } from "./panels/TextPresetsPanel";
import {
  DEFAULT_TITLE_STYLE,
  TEXT_STYLE_PRESETS,
} from "./panels/text-style-presets";
import { toast } from "../../stores/notification-store";
import { saveFileHandle, saveDirectoryHandle } from "../../services/media-storage";
import { ToolcraftButton as Button } from "@reelterminal/ui";
import { ToolcraftIconButton as IconButton } from "@reelterminal/ui";
import { ToolcraftSelectableCard as SelectableCard } from "@reelterminal/ui";
import { ToolcraftText as Text } from "@reelterminal/ui";
import { ToolcraftContextMenu as ContextMenu, type ToolcraftContextMenuOption as ContextMenuOption } from "@reelterminal/ui";
import { StickerPickerPanel } from "./inspector/StickerPickerPanel";
import { Hash } from "@/icons/lucide-compat";
import { AgentReferenceBadge } from "./timeline/AgentReferenceBadge";
import { ProjectMarkerBadgeStack } from "./ProjectMarkerBadge";
import { useProjectMarkerMenuItems } from "./project-marker-menu";
import { findMarkersForEntity } from "../../stores/project/project-marker-selectors";
import { markAgentReferenceForMedia } from "../../stores/editor-context-store";
import { MaterialLibraryPanel } from "./material/MaterialLibraryPanel";
import { saveProjectMediaToLibrary } from "../../services/material-library/project-save";
import { WorkAssetsTab } from "./panels/WorkAssetsTab";

// Maps shared SVG validation error codes to localized copy so every
// rejection category (active content, external references, size limits,
// malformed markup) gets an explicit, user-visible message.
const SVG_IMPORT_ERROR_MESSAGE_KEYS: Record<SvgValidationErrorCode, string> = {
  empty: "assets.svgImport.empty",
  tooLarge: "assets.svgImport.tooLarge",
  tooComplex: "assets.svgImport.tooComplex",
  noSvgRoot: "assets.svgImport.noSvgRoot",
  script: "assets.svgImport.script",
  foreignObject: "assets.svgImport.foreignObject",
  eventHandler: "assets.svgImport.eventHandler",
  unsafeProtocol: "assets.svgImport.unsafeProtocol",
  externalResource: "assets.svgImport.externalResource",
};

/**
 * Media Item Thumbnail Component
 * Shows thumbnail with metadata below (not overlaid)
 */
type MediaViewMode = "large" | "small" | "list";
type AssetsTab =
  | "media"
  | "work"
  | "library"
  | "text"
  | "graphics"
  | "effects"
  | "transitions"
  | "tools"
  | "recipes"
  | "templates";

const ASSETS_TABS: ReadonlyArray<{
  value: AssetsTab;
  labelKey: string;
  descriptionKey: string;
}> = [
  {
    value: "media",
    labelKey: "assets.tabs.media",
    descriptionKey: "assets.descriptions.media",
  },
  {
    value: "work",
    labelKey: "assets.tabs.work",
    descriptionKey: "assets.descriptions.work",
  },
  {
    value: "library",
    labelKey: "assets.tabs.library",
    descriptionKey: "assets.descriptions.library",
  },
  {
    value: "text",
    labelKey: "assets.tabs.text",
    descriptionKey: "assets.descriptions.text",
  },
  {
    value: "graphics",
    labelKey: "assets.tabs.graphics",
    descriptionKey: "assets.descriptions.graphics",
  },
  {
    value: "effects",
    labelKey: "assets.tabs.effects",
    descriptionKey: "assets.descriptions.effects",
  },
  {
    value: "transitions",
    labelKey: "assets.tabs.transitions",
    descriptionKey: "assets.descriptions.transitions",
  },
  {
    value: "tools",
    labelKey: "assets.tabs.tools",
    descriptionKey: "assets.descriptions.tools",
  },
  {
    value: "recipes",
    labelKey: "assets.tabs.recipes",
    descriptionKey: "assets.descriptions.recipes",
  },
  {
    value: "templates",
    labelKey: "assets.tabs.templates",
    descriptionKey: "assets.descriptions.templates",
  },
] as const;

// Shared with the text presets panel; re-exported for existing consumers.
export { DEFAULT_TITLE_STYLE, TEXT_STYLE_PRESETS };

const TAB_ICONS: Record<AssetsTab, React.ElementType> = {
  media: Video,
  work: FolderPlus,
  library: BookMarked,
  text: Type,
  graphics: Shapes,
  effects: Zap,
  transitions: Shuffle,
  tools: Wand2,
  recipes: Wand2,
  templates: LayoutTemplate,
};

const PanelIconButton: React.FC<{
  label: string;
  icon: React.ComponentProps<typeof IconButton>["icon"];
  onClick: (event: React.MouseEvent) => void;
  className?: string;
}> = ({ label, icon, onClick, className }) => (
  <IconButton
    label={label}
    icon={icon}
    variant="ghost"
    size="sm"
    onClick={onClick}
    className={className}
  />
);

const PanelButton: React.FC<{
  label: string;
  onClick: (event: React.MouseEvent) => void;
  className?: string;
  isDisabled?: boolean;
  children?: React.ReactNode;
}> = ({ label, onClick, className, isDisabled, children }) => (
  <button
    type="button"
    aria-label={label}
    onClick={onClick}
    disabled={isDisabled}
    className={className}
  >
    {children ?? label}
  </button>
);






const MediaThumbnail: React.FC<{
  item: MediaItem;
  isSelected: boolean;
  viewMode: MediaViewMode;
  /** True when another project media item resolves to the same display name. */
  hasNameConflict: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onReplace: () => void;
  onRename: (name: string) => Promise<boolean>;
  onDragStart: (e: React.DragEvent) => void;
  onAddToTimeline: () => void;
}> = ({
  item,
  isSelected,
  viewMode,
  hasNameConflict,
  onSelect,
  onDelete,
  onReplace,
  onRename,
  onDragStart,
  onAddToTimeline,
}) => {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const resolvedName = mediaDisplayName(item);
  // Same-name items are distinguished by a short id suffix next to the label;
  // the tooltip always carries the full id and the source filename.
  const nameTitle = item.displayName
    ? `${resolvedName}\n${t("media.sourceFileLabel")}: ${item.sourceFile?.name ?? item.name}\nID: ${item.id}`
    : `${resolvedName}\nID: ${item.id}`;
  const projectMarkers = useProjectStore((state) => state.project.markers);
  const reviewMarkers = findMarkersForEntity(projectMarkers, {
    mediaId: item.id,
  });
  const reviewMarkerMenuItems = useProjectMarkerMenuItems({
    kind: "asset",
    mediaId: item.id,
  });

  const startRename = useCallback(() => {
    setNameDraft(resolvedName);
    setIsRenaming(true);
  }, [resolvedName]);

  const commitRename = useCallback(
    (viaBlur: boolean) => {
      const trimmed = nameDraft.trim();
      if (!trimmed) {
        // Empty names are rejected with an explicit prompt; Enter keeps the
        // editor open, clicking away closes it without applying anything.
        toast.error(t("media.renameEmpty"));
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
    [nameDraft, onRename, t],
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

  const renameInput = (
    <input
      autoFocus
      aria-label={t("media.renameAriaLabel")}
      maxLength={120}
      value={nameDraft}
      onChange={(event) => setNameDraft(event.currentTarget.value)}
      onBlur={() => commitRename(true)}
      onKeyDown={renameKeyDown}
      className="w-full min-w-0 rounded-md border border-accent bg-bg-1 px-1.5 py-0.5 text-[12px] font-medium text-fg outline-none"
    />
  );

  const contextMenuItems: ContextMenuOption[] = [
    {
      label: t("agentReferences.add"),
      icon: <Hash size={14} aria-hidden />,
      onClick: () => markAgentReferenceForMedia(item),
    },
    {
      label: t("media.renameAction"),
      icon: <Pencil size={14} aria-hidden />,
      onClick: startRename,
    },
    {
      label: t("material.saveToLibrary"),
      icon: <BookMarked size={14} aria-hidden />,
      onClick: () => {
        void (async () => {
          const result = await saveProjectMediaToLibrary(item);
          if (result.ok) {
            toast.success(t("material.savedToLibrary"), result.material?.title ?? "");
            window.dispatchEvent(
              new CustomEvent("reelterminal:material-library-changed"),
            );
          } else {
            toast.error(
              t("material.saveToLibraryFailed"),
              result.error?.message ?? "failed",
            );
          }
        })();
      },
    },
    ...reviewMarkerMenuItems,
  ];

  const getIcon = () => {
    switch (item.type) {
      case "video":
        return Film;
      case "audio":
        return Music;
      case "image":
        return ImageIcon;
      default:
        return Film;
    }
  };

  const Icon = getIcon();

  const formatResolution = () => {
    if (item.metadata?.width && item.metadata?.height) {
      return `${item.metadata.width}×${item.metadata.height}`;
    }
    return null;
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return null;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const iconColor = item.type === "audio"
    ? "text-primary/50"
    : item.type === "image"
      ? "text-primary/50"
      : "text-status-info/50";

  const borderClass = item.isPlaceholder
      ? "border-yellow-500 ring-1 ring-yellow-500/50 shadow-[0_0_10px_rgba(234,179,8,0.3)]"
      : isSelected
        ? "border-accent ring-1 ring-accent/40 shadow-sm"
        : "border-border hover:border-border-strong";

  const hoverOverlay = (
    <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px] flex items-center justify-center gap-2 animate-in fade-in duration-200">
      {item.isPlaceholder ? (
        <>
          <PanelIconButton
            label={t("Replace asset")}
            icon={<RefreshCw size={14} className="text-yellow-500" />}
            onClick={(e) => { e.stopPropagation(); onReplace(); }}
            className="p-2 bg-yellow-500/20 rounded-full hover:bg-yellow-500/40 backdrop-blur-sm transition-colors"
          />
          <PanelIconButton
            label={t("Delete")}
            icon={<Trash2 size={14} className="text-red-400" />}
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-2 bg-red-500/20 rounded-full hover:bg-red-500/40 backdrop-blur-sm transition-colors"
          />
        </>
      ) : (
        <>
          <PanelIconButton
            label={t("Add to timeline")}
            icon={<Plus size={14} className="text-primary" />}
            onClick={(e) => { e.stopPropagation(); onAddToTimeline(); }}
            className="p-2 bg-primary/20 rounded-full hover:bg-primary/40 backdrop-blur-sm transition-colors"
          />
          <PanelIconButton
            label={t("Delete")}
            icon={<Trash2 size={14} className="text-red-400" />}
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-2 bg-red-500/20 rounded-full hover:bg-red-500/40 backdrop-blur-sm transition-colors"
          />
        </>
      )}
    </div>
  );

  // --- List view ---
  if (viewMode === "list") {
    return (
      <ContextMenu items={contextMenuItems} menuWidth={220} size="sm">
        <div
          data-live-media-id={item.id}
          tabIndex={0}
          draggable
          onDragStart={onDragStart}
          onClick={onSelect}
          onDoubleClick={(e) => { e.stopPropagation(); onAddToTimeline(); }}
          onKeyDown={handleCardKeyDown}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          className={`relative flex items-center gap-3 px-2 py-1.5 rounded-lg border-2 cursor-pointer transition-all group ${borderClass}`}
        >
        <AgentReferenceBadge kind="media" entityId={item.id} className="left-1 top-1" />
        <ProjectMarkerBadgeStack markers={reviewMarkers} selected={isSelected} />
        {/* Small thumbnail */}
        <div className="w-12 h-8 rounded-md bg-bg-2 relative overflow-hidden flex-shrink-0">
          {item.thumbnailUrl ? (
            <img src={item.thumbnailUrl} alt={resolvedName} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Icon size={14} className={iconColor} />
            </div>
          )}
          {item.isPlaceholder && (
            <div className="absolute inset-0 flex items-center justify-center bg-yellow-500/10">
              <AlertTriangle size={12} className="text-yellow-500/70" />
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          {isRenaming ? (
            renameInput
          ) : (
            <div
              className={`text-[12px] truncate font-medium ${isSelected ? "text-accent" : "text-fg-2"}`}
              title={nameTitle}
              onDoubleClick={(e) => { e.stopPropagation(); startRename(); }}
            >
              {resolvedName}
              {hasNameConflict && (
                <span className="ml-1 text-[9px] font-normal text-fg-muted">{item.id.slice(0, 6)}</span>
              )}
            </div>
          )}
          <div className="flex items-center gap-1.5 text-[9px] text-fg-muted">
            {item.metadata?.duration && <span>{formatDuration(item.metadata.duration)}</span>}
            {item.metadata?.duration && formatResolution() && <span>•</span>}
            {formatResolution() && <span>{formatResolution()}</span>}
            {(item.metadata?.duration || formatResolution()) && formatFileSize(item.metadata?.fileSize) && <span>•</span>}
            {formatFileSize(item.metadata?.fileSize) && <span>{formatFileSize(item.metadata?.fileSize)}</span>}
          </div>
        </div>

        {/* Hover actions */}
        {isHovered && (
          <div className="flex items-center gap-1 flex-shrink-0">
            {item.isPlaceholder ? (
              <>
                <PanelIconButton
                  label={t("Replace asset")}
                  icon={<RefreshCw size={12} className="text-yellow-500" />}
                  onClick={(e) => { e.stopPropagation(); onReplace(); }}
                  className="p-1 bg-yellow-500/20 rounded hover:bg-yellow-500/40 transition-colors"
                />
                <PanelIconButton
                  label={t("Delete")}
                  icon={<Trash2 size={12} className="text-red-400" />}
                  onClick={(e) => { e.stopPropagation(); onDelete(); }}
                  className="p-1 bg-red-500/20 rounded hover:bg-red-500/40 transition-colors"
                />
              </>
            ) : (
              <>
                <PanelIconButton
                  label={t("Add to timeline")}
                  icon={<Plus size={12} className="text-primary" />}
                  onClick={(e) => { e.stopPropagation(); onAddToTimeline(); }}
                  className="p-1 bg-primary/20 rounded hover:bg-primary/40 transition-colors"
                />
                <PanelIconButton
                  label={t("Delete")}
                  icon={<Trash2 size={12} className="text-red-400" />}
                  onClick={(e) => { e.stopPropagation(); onDelete(); }}
                  className="p-1 bg-red-500/20 rounded hover:bg-red-500/40 transition-colors"
                />
              </>
            )}
          </div>
        )}

        {isSelected && (
          <div className="w-2 h-2 bg-accent rounded-full shadow-sm flex-shrink-0" />
        )}
        </div>
      </ContextMenu>
    );
  }

  // --- Grid view (large & small) ---
  const thumbnailIconSize = viewMode === "small" ? 16 : 24;

  return (
    <ContextMenu items={contextMenuItems} menuWidth={220} size="sm">
    <div className="flex flex-col">
      {/* Thumbnail container */}
      <div
        data-live-media-id={item.id}
        tabIndex={0}
        draggable
        onDragStart={onDragStart}
        onClick={onSelect}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onAddToTimeline();
        }}
        onKeyDown={handleCardKeyDown}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className={`h-[78px] bg-bg-2 rounded-lg border relative group cursor-pointer transition-all overflow-hidden ${borderClass}`}
      >
        <AgentReferenceBadge kind="media" entityId={item.id} className="left-1 top-1" />
        <ProjectMarkerBadgeStack markers={reviewMarkers} selected={isSelected} />
        {/* Thumbnail or placeholder */}
        {item.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl}
            alt={resolvedName}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-bg-2">
            <Icon size={thumbnailIconSize} className={iconColor} />
          </div>
        )}

        {/* Audio waveform placeholder */}
        {item.type === "audio" && (
          <div className="absolute top-1/2 left-0 right-0 h-4 flex items-center gap-px px-2 -translate-y-1/2">
            {[...Array(10)].map((_, i) => (
              <div
                key={i}
                className="flex-1 bg-primary/30 rounded-full"
                style={{ height: `${Math.random() * 100}%` }}
              />
            ))}
          </div>
        )}

        {/* Missing Asset Badge */}
        {item.isPlaceholder && (
          <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-yellow-500 rounded text-[8px] text-black font-bold flex items-center gap-1">
            <AlertTriangle size={10} />
            {t("Missing")}</div>
        )}

        {/* Duration badge on thumbnail */}
        {item.metadata?.duration && (
          <div className="absolute bottom-1.5 right-1.5 px-[5px] py-[2px] bg-black/60 rounded text-[10px] font-semibold text-white tabular-nums">
            {formatDuration(item.metadata.duration)}
          </div>
        )}

        {/* Warning icon overlay for placeholders */}
        {item.isPlaceholder && !isHovered && (
          <div className="absolute inset-0 flex items-center justify-center bg-yellow-500/10">
            <AlertTriangle size={viewMode === "small" ? 20 : 32} className="text-yellow-500/50" />
          </div>
        )}

        {/* Hover overlay with actions */}
        {isHovered && hoverOverlay}

        {/* Selection indicator */}
        {isSelected && (
          <div className="absolute top-1 right-1 w-2 h-2 bg-accent rounded-full shadow-sm" />
        )}
      </div>

      {/* Filename below thumbnail */}
      {isRenaming ? (
        <div className="mt-1.5">{renameInput}</div>
      ) : (
        <div
          className="text-[12px] truncate font-medium text-fg-2 mt-1.5"
          title={nameTitle}
          onDoubleClick={startRename}
        >
          {resolvedName}
          {hasNameConflict && (
            <span className="ml-1 text-[9px] font-normal text-fg-muted">{item.id.slice(0, 6)}</span>
          )}
        </div>
      )}
    </div>
    </ContextMenu>
  );
};

const EmptyState: React.FC<{ onImport: () => void }> = ({ onImport }) => {
  const { t } = useTranslation();
  return (
  <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
    <div className="w-16 h-16 rounded-2xl bg-bg-2 border border-border flex items-center justify-center mb-4 shadow-inner">
      <Upload size={24} className="text-fg-muted" />
    </div>
    <Text type="body" color="secondary" weight="bold" display="block" className="mb-2 text-sm text-fg">
      {t("No media imported")}</Text>
    <Text type="supporting" color="secondary" display="block" className="mb-6 text-xs text-fg-3">
      {t("Drag files here or click to import")}</Text>
    <Button
      label={t("Import Media")}
      variant="ghost"
      onClick={onImport}
      className="px-4 py-2 bg-bg-2 hover:bg-bg-3 border border-border text-fg-2 text-xs font-medium rounded-lg transition-all hover:border-accent/50"
    />
  </div>
);
};

const LoadingIndicator: React.FC<{ message: string }> = ({ message }) => (
  <div className="absolute inset-0 bg-bg-1/90 backdrop-blur-sm flex flex-col items-center justify-center z-50">
    <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin mb-3" />
    <Text type="body" color="secondary" display="block" className="text-sm text-fg-2">{message}</Text>
  </div>
);

export const AssetsPanel: React.FC = () => {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTabRaw] = useState<AssetsTab>("media");
  const playheadPosition = useTimelineStore((state) => state.playheadPosition);

  const setActiveTab = useCallback((tab: AssetsTab) => {
    setActiveTabRaw(tab);
  }, []);

  // Live editor control keeps panel ownership local while allowing the
  // renderer bridge to ask the media tab to reveal a selected library item.
  useEffect(() => {
    const handleLiveReveal = (event: Event) => {
      const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
      if (typeof id !== "string" || id.length === 0) return;
      setActiveTabRaw("media");
    };
    window.addEventListener("reelterminal:live-reveal-media", handleLiveReveal);
    return () =>
      window.removeEventListener("reelterminal:live-reveal-media", handleLiveReveal);
  }, []);

  const [isDragOver, setIsDragOver] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState("");
  const [showOnlyMissing, setShowOnlyMissing] = useState(false);
  const [showAspectRatioDialog, setShowAspectRatioDialog] = useState(false);
  const [aspectRatioDialogData, setAspectRatioDialogData] = useState<{
    videoWidth: number;
    videoHeight: number;
    itemToAdd: MediaItem;
  } | null>(null);
  const [sortOrder, setSortOrder] = useState<"none" | "asc" | "desc">("none");
  const [generatingBackground, setGeneratingBackground] = useState<
    string | null
  >(null);
  const [backgroundCategory, setBackgroundCategory] = useState<
    "all" | "solid" | "gradient" | "pattern" | "mesh"
  >("all");

  // Project store
  const {
    project,
    importMedia,
    deleteMedia,
    renameMedia,
    replaceMediaAsset,
    updateSettings,
  } = useProjectStore();
  const mediaItems = project.mediaLibrary.items;

  // UI store
  const { select, isSelected, startDrag, openModal } = useUIStore();

  // Count missing assets
  const missingAssetsCount = mediaItems.filter(
    (item) => item.isPlaceholder,
  ).length;

  // Project media search: matches the user-facing display name, falling back
  // to the source filename for items never renamed (mediaDisplayName resolves
  // displayName ?? name).
  const [mediaSearch, setMediaSearch] = useState("");
  const normalizedMediaSearch = mediaSearch.trim().toLowerCase();

  // Filter media items by the missing-assets toggle and the search box, then optional sort
  const baseFilteredItems = mediaItems.filter((item) =>
    showOnlyMissing ? item.isPlaceholder : true,
  ).filter((item) =>
    normalizedMediaSearch
      ? mediaDisplayName(item).toLowerCase().includes(normalizedMediaSearch)
      : true,
  );
  const filteredItems =
    sortOrder === "none"
      ? baseFilteredItems
      : [...baseFilteredItems].sort((a, b) => {
          const comparison = mediaDisplayName(a).localeCompare(mediaDisplayName(b));
          return sortOrder === "desc" ? -comparison : comparison;
        });

  // Items whose resolved display name collides with another item get a short
  // id suffix so same-named assets stay distinguishable in the panel.
  const duplicateNameIds = useMemo(() => {
    const nameCounts = new Map<string, number>();
    for (const item of mediaItems) {
      const key = mediaDisplayName(item);
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    const ids = new Set<string>();
    for (const item of mediaItems) {
      if ((nameCounts.get(mediaDisplayName(item)) ?? 0) > 1) ids.add(item.id);
    }
    return ids;
  }, [mediaItems]);

  // Handle media rename (display name only; source filename and file untouched)
  const handleRenameMedia = useCallback(
    async (itemId: string, nextName: string): Promise<boolean> => {
      const result = await renameMedia(itemId, nextName);
      if (!result.success) {
        toast.error(t("media.renameFailedTitle"), result.error?.message ?? "");
        return false;
      }
      return true;
    },
    [renameMedia, t],
  );

  // Handle file import with loading state
  const handleFileImport = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;

      setIsImporting(true);
      const fileArray = Array.from(files);

      try {
        for (let i = 0; i < fileArray.length; i++) {
          const file = fileArray[i];
          setImportProgress(
            t("media.importingProgress", {
              name: file.name,
              current: i + 1,
              total: fileArray.length,
            }),
          );

          const result = await importMedia(file);

          // Surface import failures (e.g. the FFmpeg.wasm transcode fallback
          // failing to load its remote core) instead of silently dropping
          // the file. Retry = re-run the import; no automatic retries.
          if (!result.success) {
            toast.error(
              t("media.importFailedTitle"),
              result.error?.message ?? t("media.importFailedDetail"),
            );
          }

          // If it's a video with audio, extract audio to separate track
          if (result.success && file.type.startsWith("video/")) {
            setImportProgress(t("media.extractingAudio", { name: file.name }));
            // Audio extraction is handled by the importMedia function
            // The audio track is created automatically when adding to timeline
          }
        }
      } catch (error) {
        console.error("Import failed:", error);
      } finally {
        setIsImporting(false);
        setImportProgress("");
      }
    },
    [importMedia, t],
  );

  // Handle drag and drop import — capture FileSystemFileHandle for each dropped file
  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);

      // Snapshot dataTransfer synchronously — it becomes inert after the first await.
      const droppedFiles = e.dataTransfer.files;
      const handlePromises =
        "getAsFileSystemHandle" in DataTransferItem.prototype
          ? Array.from(e.dataTransfer.items)
              .filter((item) => item.kind === "file")
              .map(async (item) => {
                try {
                  const handle = await (item as DataTransferItem & { getAsFileSystemHandle(): Promise<FileSystemHandle> }).getAsFileSystemHandle();
                  if (handle.kind === "file") {
                    const fileHandle = handle as FileSystemFileHandle;
                    const file = await fileHandle.getFile();
                    await saveFileHandle(file.name, file.size, fileHandle);
                  }
                } catch {
                  // Ignore — handle capture is best-effort
                }
              })
          : [];

      await Promise.all(handlePromises);
      handleFileImport(droppedFiles);
    },
    [handleFileImport],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  // Handle media item selection
  const handleSelectItem = useCallback(
    (itemId: string) => {
      select({ type: "media", id: itemId });
    },
    [select],
  );

  // Handle media item deletion
  const handleDeleteItem = useCallback(
    async (itemId: string) => {
      await deleteMedia(itemId);
    },
    [deleteMedia],
  );

  // Handle asset replacement
  const handleReplaceAsset = useCallback(
    async (itemId: string) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "video/*,audio/*,image/*";
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) {
          setIsImporting(true);
          setImportProgress(`Replacing asset...`);
          try {
            await replaceMediaAsset(itemId, file);
          } catch (error) {
            console.error("Asset replacement failed:", error);
          } finally {
            setIsImporting(false);
            setImportProgress("");
          }
        }
      };
      input.click();
    },
    [replaceMediaAsset],
  );

  const handleRelinkFromFolder = useCallback(async () => {
    if (!("showDirectoryPicker" in window)) {
      toast.error("Folder picker not supported", "Please relink assets individually using the refresh button on each missing asset.");
      return;
    }
    let dirHandle: FileSystemDirectoryHandle;
    try {
      dirHandle = await (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
    } catch {
      return; // user cancelled
    }

    const { project } = useProjectStore.getState();
    const placeholders = project.mediaLibrary.items.filter((item) => item.isPlaceholder);
    if (placeholders.length === 0) return;

    // Persist the directory handle for future auto-restore
    try { await saveDirectoryHandle(project.id, dirHandle); } catch { /* best-effort */ }

    // Build a name:size → {File, handle} map for reliable matching
    const fileMap = new Map<string, { file: File; handle: FileSystemFileHandle }>();
    const entries = (dirHandle as unknown as { entries: () => AsyncIterableIterator<[string, FileSystemHandle]> }).entries();
    for await (const [, fh] of entries) {
      if ((fh as FileSystemHandle).kind === "file") {
        const fileHandle = fh as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        fileMap.set(`${file.name.toLowerCase()}:${file.size}`, { file, handle: fileHandle });
      }
    }

    setIsImporting(true);
    let linked = 0;
    for (const item of placeholders) {
      // Match on original source file name + size (same strategy as auto-restore)
      const key = item.sourceFile
        ? `${item.sourceFile.name.toLowerCase()}:${item.sourceFile.size}`
        : null;
      const entry = key ? fileMap.get(key) : null;
      if (entry) {
        setImportProgress(`Relinking ${item.name}…`);
        try {
          // Save individual file handle for future auto-restore
          try { await saveFileHandle(entry.file.name, entry.file.size, entry.handle); } catch { /* best-effort */ }
          await replaceMediaAsset(item.id, entry.file, dirHandle.name);
          linked++;
        } catch (err) {
          console.error(`[AssetsPanel] Failed to relink ${item.name}:`, err);
        }
      }
    }
    setIsImporting(false);
    setImportProgress("");

    if (linked > 0) {
      toast.success(`Relinked ${linked} of ${placeholders.length} asset${placeholders.length !== 1 ? "s" : ""}`);
    } else {
      toast.error("No matches found", "None of the files in the selected folder matched the missing assets by filename.");
    }
  }, [replaceMediaAsset]);

  // Handle drag start for timeline placement
  const handleItemDragStart = useCallback(
    (e: React.DragEvent, item: MediaItem) => {
      e.dataTransfer.setData(
        "application/json",
        JSON.stringify({ mediaId: item.id }),
      );
      e.dataTransfer.effectAllowed = "copy";
      startDrag("media", { mediaId: item.id, mediaType: item.type });
    },
    [startDrag],
  );

  const addMediaToTimeline = useCallback(async (item: MediaItem) => {
    const { addClipToNewTrack } = useProjectStore.getState();
    await addClipToNewTrack(item.id, playheadPosition);
  }, [playheadPosition]);

  const handleConfirmAspectRatioMatch = useCallback(async () => {
    if (!aspectRatioDialogData) return;

    await updateSettings({
      width: aspectRatioDialogData.videoWidth,
      height: aspectRatioDialogData.videoHeight,
    });

    const itemToAdd = aspectRatioDialogData.itemToAdd;
    setShowAspectRatioDialog(false);
    setAspectRatioDialogData(null);

    await addMediaToTimeline(itemToAdd);
  }, [aspectRatioDialogData, updateSettings, addMediaToTimeline]);

  const handleCancelAspectRatioMatch = useCallback(async () => {
    if (!aspectRatioDialogData) return;

    const itemToAdd = aspectRatioDialogData.itemToAdd;
    setShowAspectRatioDialog(false);
    setAspectRatioDialogData(null);

    await addMediaToTimeline(itemToAdd);
  }, [aspectRatioDialogData, addMediaToTimeline]);

  const handleAddToTimeline = useCallback(
    async (item: MediaItem) => {
      const { project: currentProject } = useProjectStore.getState();
      const tracks = currentProject.timeline.tracks;
      const hasClips = tracks.some((track) => track.clips.length > 0);

      if (
        !hasClips &&
        item.type === "video" &&
        item.metadata?.width &&
        item.metadata?.height
      ) {
        const videoWidth = item.metadata.width;
        const videoHeight = item.metadata.height;
        const projectWidth = currentProject.settings.width;
        const projectHeight = currentProject.settings.height;

        if (videoWidth !== projectWidth || videoHeight !== projectHeight) {
          setAspectRatioDialogData({ videoWidth, videoHeight, itemToAdd: item });
          setShowAspectRatioDialog(true);
          return;
        }
      }

      await addMediaToTimeline(item);
    },
    [addMediaToTimeline],
  );

  const triggerFileInput = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImportBackground = useCallback(
    async (preset: BackgroundPreset) => {
      setGeneratingBackground(preset.id);
      try {
        const { width, height } = project.settings;
        const blob = await generateBackgroundBlob(preset, width, height);
        const file = new File([blob], `${preset.name}_${width}x${height}.png`, {
          type: "image/png",
        });
        const result = await importMedia(file);
        if (result.success && result.actionId) {
          const { addClipToNewTrack } = useProjectStore.getState();
          await addClipToNewTrack(result.actionId);
        }
      } catch (error) {
        console.error("Failed to generate background:", error);
      } finally {
        setGeneratingBackground(null);
      }
    },
    [importMedia, project.settings],
  );

  const filteredBackgrounds = BACKGROUND_PRESETS.filter(
    (preset) =>
      backgroundCategory === "all" || preset.category === backgroundCategory,
  );

  const renderSectionContent = (tab: AssetsTab): React.ReactNode => {
    switch (tab) {
      case "work":
        return <WorkAssetsTab />;
      case "library":
        return <MaterialLibraryPanel />;
      case "media":
        return (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="px-4 pt-[18px] shrink-0">
              <div className="font-bold text-[18px] text-fg mb-[14px]">{t("Media")}</div>
              <div className="flex gap-2 mb-[18px]">
                <button
                  type="button"
                  aria-label={t("Import media")}
                  onClick={triggerFileInput}
                  className="flex-1 flex items-center justify-center gap-[7px] bg-bg border border-border rounded-[9px] p-[10px] font-medium text-[13px] text-fg-2"
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--fg-3)"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 16V4M7 9l5-5 5 5" />
                    <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
                  </svg>
                  {t("Import")}</button>
                <button
                  type="button"
                  aria-label={t("Record")}
                  onClick={() => openModal("recorder")}
                  className="flex-1 flex items-center justify-center gap-[7px] bg-bg border border-border rounded-[9px] p-[10px] font-medium text-[13px] text-fg-2"
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--fg-3)"
                    strokeWidth="1.9"
                  >
                    <circle cx="12" cy="12" r="8" />
                    <circle cx="12" cy="12" r="3" fill="var(--fg-3)" stroke="none" />
                  </svg>
                  {t("Record")}</button>
                <button
                  type="button"
                  aria-label={t("Sort media")}
                  onClick={() =>
                    setSortOrder((prev) =>
                      prev === "none" ? "asc" : prev === "asc" ? "desc" : "none",
                    )
                  }
                  className="w-[42px] flex items-center justify-center bg-bg border border-border rounded-[9px]"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--fg-3)"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  >
                    <path d="M3 7h13M3 7l3-3M3 7l3 3M21 17H8M21 17l-3-3M21 17l-3 3" />
                  </svg>
                </button>
              </div>

              <div className="flex items-center gap-2 mb-[18px] rounded-[9px] border border-border bg-bg px-2.5 py-1.5">
                <Search size={13} className="shrink-0 text-fg-3" aria-hidden />
                <input
                  value={mediaSearch}
                  placeholder={t("media.searchPlaceholder")}
                  onChange={(event) => setMediaSearch(event.target.value)}
                  className="w-full bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-3"
                />
              </div>
            </div>

            {missingAssetsCount > 0 && (
              <div className="px-4 pb-3 space-y-2">
                <PanelButton
                  label={t("Show Only Missing Assets")}
                  onClick={() => setShowOnlyMissing(!showOnlyMissing)}
                  className={`w-full px-3 py-2 rounded-lg border text-xs font-medium transition-all flex items-center justify-between ${
                    showOnlyMissing
                      ? "bg-yellow-500/10 border-yellow-500 text-yellow-500"
                      : "bg-background-tertiary border-border text-text-secondary hover:border-yellow-500/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={14} />
                    <span>{t("Show Only Missing Assets")}</span>
                  </div>
                  <div className="px-2 py-0.5 rounded-full bg-yellow-500 text-black text-[10px] font-bold">
                    {missingAssetsCount}
                  </div>
                </PanelButton>
                <PanelButton
                  label={t("Relink from Folder")}
                  onClick={handleRelinkFromFolder}
                  className="w-full px-3 py-2 rounded-lg border border-yellow-500/40 bg-yellow-500/5 text-yellow-500 text-xs font-medium transition-all hover:bg-yellow-500/15 flex items-center gap-2"
                >
                  <RefreshCw size={14} />
                  <span>{t("Relink from Folder…")}</span>
                </PanelButton>
              </div>
            )}

            <div
              className={`min-h-0 flex-1 overflow-y-auto overscroll-contain custom-scrollbar ${isDragOver ? "bg-accent-soft" : ""}`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
            >
              <div className="px-4 pb-[18px] relative">
                {filteredItems.length > 0 && (
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[13px] font-semibold text-fg-2">{t("Project Media")}</span>
                    <span className="text-[12px] font-medium text-fg-muted">{filteredItems.length}</span>
                  </div>
                )}
                {filteredItems.length === 0 ? (
                  <EmptyState onImport={triggerFileInput} />
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    {filteredItems.map((item) => (
                      <MediaThumbnail
                        key={item.id}
                        item={item}
                        isSelected={isSelected(item.id)}
                        viewMode="large"
                        hasNameConflict={duplicateNameIds.has(item.id)}
                        onSelect={() => handleSelectItem(item.id)}
                        onDelete={() => handleDeleteItem(item.id)}
                        onReplace={() => handleReplaceAsset(item.id)}
                        onRename={(name) => handleRenameMedia(item.id, name)}
                        onDragStart={(e) => handleItemDragStart(e, item)}
                        onAddToTimeline={() => handleAddToTimeline(item)}
                      />
                    ))}
                    <div className="flex flex-col">
                      <PanelButton
                        label={t("Add media")}
                        onClick={triggerFileInput}
                        className="h-[78px] bg-bg-2 rounded-lg border border-dashed border-border hover:border-accent/50 hover:bg-accent-soft relative flex items-center justify-center cursor-pointer transition-all overflow-hidden group"
                      >
                        <div className="flex flex-col items-center gap-1.5">
                          <Upload size={20} className="text-fg-muted group-hover:text-accent transition-colors" />
                          <span className="text-[10px] text-fg-muted group-hover:text-accent transition-colors font-medium">{t("Add media")}</span>
                        </div>
                      </PanelButton>
                    </div>
                  </div>
                )}

                {isDragOver && (
                  <div className="absolute inset-4 border-2 border-dashed border-accent rounded-xl flex items-center justify-center bg-accent-soft pointer-events-none z-50 backdrop-blur-sm">
                    <div className="text-accent text-sm font-bold bg-bg-1 px-4 py-2 rounded-full shadow-lg">
                      {t("Drop files to import")}</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      case "graphics":
        return (
          <div className="flex min-h-0 flex-1 flex-col border-t border-border/70">
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="px-4 py-4">
                <div className="mb-6">
                  <div className="flex items-center justify-between mb-3">
                    <Text type="label" color="secondary" weight="bold" display="block" className="flex items-center gap-1.5 text-xs">
                      <Palette size={12} />
                      {t("Backgrounds")}</Text>
                  </div>
                  <div className="flex gap-1.5 mb-3 flex-wrap">
                    {(["all", "solid", "gradient", "mesh", "pattern"] as const).map(
                      (cat) => (
                        <SelectableCard
                          key={cat}
                          label={cat.charAt(0).toUpperCase() + cat.slice(1)}
                          isSelected={backgroundCategory === cat}
                          onChange={() => setBackgroundCategory(cat)}
                          onClick={() => setBackgroundCategory(cat)}
                          padding={1}
                          variant={backgroundCategory === cat ? "green" : "muted"}
                          className={`px-2.5 py-1 text-[10px] rounded-md transition-all ${
                            backgroundCategory === cat
                              ? "bg-primary text-white"
                              : "bg-background-tertiary text-text-muted hover:text-text-secondary"
                          }`}
                        >
                          {cat.charAt(0).toUpperCase() + cat.slice(1)}
                        </SelectableCard>
                      ),
                    )}
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {filteredBackgrounds.map((preset) => (
                      <PanelButton
                        key={preset.id}
                        label={t(preset.name)}
                        onClick={() => handleImportBackground(preset)}
                        isDisabled={generatingBackground !== null}
                        className="aspect-square rounded-lg border border-border hover:border-primary/50 transition-all overflow-hidden relative group disabled:opacity-50"
                      >
                        <span className="absolute inset-0" style={{ background: preset.thumbnail }} />
                        {generatingBackground === preset.id && (
                          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          </div>
                        )}
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100">
                          <Plus size={16} className="text-white" />
                        </div>
                        <span className="absolute bottom-0 left-0 right-0 text-[8px] text-white bg-black/60 py-0.5 px-1 truncate opacity-0 group-hover:opacity-100 transition-opacity">
                          {preset.name}
                        </span>
                      </PanelButton>
                    ))}
                  </div>
                </div>

                <div className="mb-6">
                  <Text type="label" color="secondary" weight="bold" display="block" className="mb-3 text-xs">
                    {t("Shapes")}</Text>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      {
                        type: "rectangle" as ShapeType,
                        icon: Square,
                        label: t("Rectangle"),
                      },
                      { type: "circle" as ShapeType, icon: Circle, label: t("Circle") },
                      {
                        type: "triangle" as ShapeType,
                        icon: Triangle,
                        label: t("Triangle"),
                      },
                      { type: "star" as ShapeType, icon: Star, label: t("Star") },
                      {
                        type: "arrow" as ShapeType,
                        icon: ArrowRight,
                        label: t("Arrow"),
                      },
                      {
                        type: "polygon" as ShapeType,
                        icon: Hexagon,
                        label: t("Polygon"),
                      },
                    ].map((shape) => (
                      <PanelButton
                        key={shape.type}
                        label={t(shape.label)}
                        onClick={async () => {
                          const state = useProjectStore.getState();
                          const { createShapeClip, addTrack } = state;
                          const tracksBefore = state.project.timeline.tracks;
                          await addTrack("graphics", 0);
                          const tracksAfter =
                            useProjectStore.getState().project.timeline.tracks;
                          const newGraphicsTrack = tracksAfter.find(
                            (t) =>
                              t.type === "graphics" &&
                              !tracksBefore.some((bt) => bt.id === t.id),
                          );
                          if (newGraphicsTrack) {
                            const created = createShapeClip(
                              newGraphicsTrack.id,
                              playheadPosition,
                              shape.type,
                            );
                            if (created) {
                              select({
                                type: "shape-clip",
                                id: created.id,
                                trackId: newGraphicsTrack.id,
                              });
                            }
                          }
                        }}
                        className="aspect-square bg-background-tertiary rounded-lg border border-border hover:border-primary/50 hover:bg-primary/5 transition-all flex flex-col items-center justify-center gap-1 group"
                      >
                        <shape.icon
                          size={20}
                          className="text-text-secondary group-hover:text-primary transition-colors"
                        />
                        <span className="text-[9px] text-text-muted group-hover:text-text-secondary">
                          {t(shape.label)}
                        </span>
                      </PanelButton>
                    ))}
                  </div>
                </div>

                <div className="mb-6">
                  <Text type="label" color="secondary" weight="bold" display="block" className="mb-3 text-xs">
                    {t("3D Objects")}</Text>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      { type: "mesh-cube" as ShapeType, label: t("Cube"), icon: "□" },
                      { type: "mesh-sphere" as ShapeType, label: t("Sphere"), icon: "○" },
                      { type: "mesh-torus" as ShapeType, label: t("Torus"), icon: "◯" },
                      { type: "mesh-cone" as ShapeType, label: t("Cone"), icon: "△" },
                      { type: "mesh-cylinder" as ShapeType, label: t("Cylinder"), icon: "▯" },
                      { type: "mesh-icosahedron" as ShapeType, label: t("Icosahedron"), icon: "◆" },
                    ]).map((mesh) => (
                      <PanelButton
                        key={mesh.type}
                        label={t(mesh.label)}
                        onClick={async () => {
                          const state = useProjectStore.getState();
                          const { createShapeClip, addTrack, updateClipRotate3D } = state;
                          const tracksBefore = state.project.timeline.tracks;
                          await addTrack("graphics", 0);
                          const tracksAfter =
                            useProjectStore.getState().project.timeline.tracks;
                          const newGraphicsTrack = tracksAfter.find(
                            (t) =>
                              t.type === "graphics" &&
                              !tracksBefore.some((bt) => bt.id === t.id),
                          );
                          if (newGraphicsTrack) {
                            const created = createShapeClip(
                              newGraphicsTrack.id,
                              playheadPosition,
                              mesh.type,
                            );
                            // Nudge the rotation so the 3D depth is
                            // visible from the get-go (otherwise a
                            // head-on cube looks like a flat square).
                            if (created) {
                              updateClipRotate3D(created.id, {
                                x: -18,
                                y: 28,
                                z: 0,
                              });
                              select({
                                type: "shape-clip",
                                id: created.id,
                                trackId: newGraphicsTrack.id,
                              });
                            }
                          }
                        }}
                        className="aspect-square bg-background-tertiary rounded-lg border border-border hover:border-primary/50 hover:bg-primary/5 transition-all flex flex-col items-center justify-center gap-1 group"
                      >
                        <span className="text-2xl text-text-secondary group-hover:text-primary transition-colors leading-none">
                          {mesh.icon}
                        </span>
                        <span className="text-[9px] text-text-muted group-hover:text-text-secondary">
                          {t(mesh.label)}
                        </span>
                      </PanelButton>
                    ))}
                  </div>
                </div>

                <div className="mb-6">
                  <Text type="label" color="secondary" weight="bold" display="block" className="mb-3 text-xs">
                    {t("SVG Import")}</Text>
                  <PanelButton
                    label={t("Import SVG File")}
                    onClick={() => {
                      const input = document.createElement("input");
                      input.type = "file";
                      input.accept = ".svg";
                      input.onchange = async (e) => {
                        const file = (e.target as HTMLInputElement).files?.[0];
                        if (file) {
                          const content = await file.text();
                          // Reject before any track is created so a failed
                          // import never leaves a half-imported graphics
                          // track behind.
                          const validation = validateSvgContent(content);
                          if (!validation.ok) {
                            toast.error(
                              t("assets.svgImport.rejected"),
                              t(
                                SVG_IMPORT_ERROR_MESSAGE_KEYS[validation.code],
                              ),
                            );
                            return;
                          }
                          const state = useProjectStore.getState();
                          const { importSVG, addTrack } = state;
                          const tracksBefore = state.project.timeline.tracks;
                          await addTrack("graphics", 0);
                          const tracksAfter =
                            useProjectStore.getState().project.timeline.tracks;
                          const newGraphicsTrack = tracksAfter.find(
                            (t) =>
                              t.type === "graphics" &&
                              !tracksBefore.some((bt) => bt.id === t.id),
                          );
                          if (newGraphicsTrack) {
                            const created = importSVG(
                              content,
                              newGraphicsTrack.id,
                              playheadPosition,
                            );
                            if (created) {
                              select({
                                type: "shape-clip",
                                id: created.id,
                                trackId: newGraphicsTrack.id,
                              });
                            } else {
                              toast.error(
                                t("assets.svgImport.rejected"),
                                t("assets.svgImport.failed"),
                              );
                            }
                          }
                        }
                      };
                      input.click();
                    }}
                    className="w-full py-3 bg-background-tertiary rounded-lg border border-border hover:border-primary/50 hover:bg-primary/5 transition-all flex items-center justify-center gap-2 group"
                  >
                    <FileCode
                      size={16}
                      className="text-text-secondary group-hover:text-primary transition-colors"
                    />
                    <span className="text-xs text-text-secondary group-hover:text-text-primary">
                      {t("Import SVG File")}</span>
                  </PanelButton>
                </div>

                <div className="mb-6">
                  <StickerPickerPanel />
                </div>
              </div>
            </div>
          </div>
        );
      case "text":
        return (
          <div className="flex min-h-0 flex-1 flex-col border-t border-border/70">
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="min-w-0 px-4 py-4 space-y-3">
                <PanelButton
                  label={t("Add Title")}
                  onClick={async () => {
                    const state = useProjectStore.getState();
                    const { createTextClip, addTrack } = state;
                    const tracksBefore = state.project.timeline.tracks;
                    await addTrack("text", 0);
                    const tracksAfter =
                      useProjectStore.getState().project.timeline.tracks;
                    const newTextTrack = tracksAfter.find(
                      (t) =>
                        t.type === "text" &&
                        !tracksBefore.some((bt) => bt.id === t.id),
                    );
                    if (newTextTrack) {
                      const created = createTextClip(
                        newTextTrack.id,
                        playheadPosition,
                        // Canvas-visible sample copy, not an internal id:
                        // localize so zh users see a Chinese starter title.
                        t("New Title"),
                        5,
                        DEFAULT_TITLE_STYLE,
                      );
                      if (created) {
                        select({
                          type: "text-clip",
                          id: created.id,
                          trackId: newTextTrack.id,
                        });
                      }
                    }
                  }}
                  className="flex min-h-[72px] w-full min-w-0 flex-col items-center justify-center rounded-lg border border-border bg-background-tertiary px-3 py-3 text-center transition-all hover:border-primary/50 hover:bg-primary/5"
                >
                  <span className="block max-w-full truncate text-base font-bold leading-tight text-text-primary">
                    {t("Add Title")}</span>
                  <Text
                    type="supporting"
                    color="secondary"
                    display="block"
                    maxLines={1}
                    className="mt-1 max-w-full text-[11px] leading-tight"
                  >
                    {t("Click to add text to timeline")}</Text>
                </PanelButton>
                {/* Merged built-in + custom text presets (custom ones are
                    user-level, cross-project, managed in place). */}
                <TextPresetsPanel />
              </div>
            </div>
          </div>
        );
      case "effects":
        return (
          <div className="flex min-h-0 flex-1 flex-col border-t border-border/70 bg-bg-1">
            <EffectsPanel />
          </div>
        );
      case "transitions":
        return (
          <div className="flex min-h-0 flex-1 flex-col border-t border-border/70 bg-bg-1">
            <TransitionsPanel />
          </div>
        );
      case "tools":
        return (
          <div className="flex min-h-0 flex-1 flex-col border-t border-border/70 bg-background-secondary content-area-fix">
            <EditingToolsTab />
          </div>
        );
      case "recipes":
        return (
          <div className="flex min-h-0 flex-1 flex-col border-t border-border/70 bg-background-secondary content-area-fix">
            <RecipesTab />
          </div>
        );
      case "templates":
        return (
          <div className="flex min-h-0 flex-1 flex-col border-t border-border/70 bg-background-secondary content-area-fix">
            <TemplatesTab />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div
      data-tour="assets"
      className="w-full h-full bg-bg-1 overflow-hidden flex flex-row relative"
    >
      {/* ── Vertical tool rail (icon + label, left) ───────────── */}
      <div className="flex flex-col items-center gap-1 px-0 py-[14px] border-r border-border bg-bg-1 overflow-y-auto scrollbar-none shrink-0 w-[92px]">
        {ASSETS_TABS.map((tab) => {
          const Icon = TAB_ICONS[tab.value];
          const isActive = activeTab === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              aria-label={t(tab.labelKey)}
              aria-pressed={isActive}
              title={t(tab.labelKey)}
              onClick={() => setActiveTab(tab.value)}
              className={`group flex h-16 w-[68px] shrink-0 flex-col items-center justify-center gap-1 rounded-[10px] px-1 py-2 text-[10px] leading-tight tracking-tight transition-colors ${
                isActive
                  ? "bg-selected text-accent font-semibold"
                  : "text-fg-muted font-medium"
              }`}
            >
              <Icon size={20} strokeWidth={isActive ? 1.8 : 1.7} />
              <span className="block max-w-full text-center leading-[11px]">
                {t(tab.labelKey)}
              </span>
            </button>
          );
        })}
      </div>

      {/* ── Body: section content fills the remaining space ──── */}
      <div className="flex-1 flex flex-col min-w-0 h-full bg-bg-1 relative">
        {isImporting && (
          <LoadingIndicator message={importProgress || t("media.importing")} />
        )}

        <input
          ref={fileInputRef}
          type="file"
          aria-label={t("Import media")}
          accept="video/*,audio/*,image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            handleFileImport(event.target.files);
            event.target.value = "";
          }}
        />

        {/* Dynamic Section Content */}
        <div className="flex-1 min-h-0 relative flex flex-col overflow-hidden">
          {activeTab !== "media" && (
            <div className="min-w-0 px-4 pt-[18px] pb-0 shrink-0">
              <div
                className="truncate font-bold text-[18px] text-fg"
                title={t(ASSETS_TABS.find((tab) => tab.value === activeTab)?.labelKey ?? "")}
              >
                {t(ASSETS_TABS.find((tab) => tab.value === activeTab)?.labelKey ?? "")}
              </div>
            </div>
          )}
          {renderSectionContent(activeTab)}
        </div>
      </div>

      {aspectRatioDialogData && (
        <AspectRatioMatchDialog
          isOpen={showAspectRatioDialog}
          videoWidth={aspectRatioDialogData.videoWidth}
          videoHeight={aspectRatioDialogData.videoHeight}
          currentWidth={project.settings.width}
          currentHeight={project.settings.height}
          onConfirm={handleConfirmAspectRatioMatch}
          onCancel={handleCancelAspectRatioMatch}
        />
      )}

    </div>
  );
};

export default AssetsPanel;
