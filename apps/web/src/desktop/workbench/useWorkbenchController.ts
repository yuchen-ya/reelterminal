import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MediaItem,
  WorkbenchBatch,
  WorkbenchDecision,
  WorkbenchFeedback,
  WorkbenchHandoff,
  WorkbenchItem,
  WorkbenchProjectState,
  WorkbenchProvenanceTag,
} from "@reelterminal/core";
import { emptyWorkbenchState, workbenchBatchItems } from "@reelterminal/core";
import { useProjectStore } from "../../stores/project-store";
import {
  applyWorkbenchSelection,
  useWorkbenchUiStore,
} from "../../stores/workbench-ui-store";
import { loadMediaBlob } from "../../services/media-storage";
import {
  feedbackIdFor,
  feedbackTargetKey,
  findExistingIssueFeedback,
  pickLatestFeedback,
} from "./feedback-identity";
import { buildTextRangeComments } from "./text-range-comments";
import {
  filterVisibleWorkbenchItems,
  resolveVisibleWorkbenchCursor,
} from "./visible-scope";
import type {
  CreateWorkbenchBatchInput,
  CreateWorkbenchBatchResult,
  DataPatchInput,
  DataReworkCell,
  FeedbackDraftInput,
  MediaLoadStatus,
  RangeCommentInput,
  SelectModifiers,
  WorkbenchBatchView,
  WorkbenchController,
  WorkbenchItemView,
  WorkbenchMediaAsset,
  WorkbenchMediaRef,
  WorkbenchMutationResult,
  ImagePayloadView,
} from "./types";

const ERROR = (code: string, message: string): WorkbenchMutationResult => ({
  ok: false,
  code,
  message,
});

function mediaRefFor(
  mediaItem: MediaItem | undefined,
  url: string | null,
  status: MediaLoadStatus,
  error?: string,
): WorkbenchMediaRef {
  return {
    mediaId: mediaItem?.id ?? "",
    url,
    status: mediaItem ? status : "unavailable",
    ...(error ? { error } : {}),
    thumbnailUrl: mediaItem?.thumbnailUrl ?? null,
    displayName: mediaItem?.displayName ?? mediaItem?.name ?? "",
  };
}

function targetSummary(feedback: WorkbenchFeedback): string {
  const target = feedback.target;
  if (!target) return "整条条目";
  switch (target.kind) {
    case "model-view":
      return `模型观察 ${target.observationId.slice(0, 8)}`;
    case "pixel-region":
      return `图上区域 #${target.annotationId.slice(0, 6)} (${Math.round(target.x * 100)}%, ${Math.round(target.y * 100)}%)`;
    case "text-range":
      return `字符区间 [${target.startOffset}, ${target.endOffset}) v${target.version}`;
    case "data-cell":
      return `单元格 ${target.rowId} · ${target.columnId}${target.proposalId ? " (提议)" : ""}`;
    case "video-marker":
      return `播放时间 ${target.startPtsSec.toFixed(3)}s${target.endPtsSec !== undefined ? ` ~ ${target.endPtsSec.toFixed(3)}s` : ""}${target.hasFrameMapping ? "" : " (无源帧映射，外部处理时间可能偏移)"}`;
    default:
      return "整条条目";
  }
}

function toFeedbackView(feedback: WorkbenchFeedback): import("./types").FeedbackView {
  return {
    id: feedback.id,
    text: feedback.text,
    referencedTagIds: [...(feedback.referencedTagIds ?? [])],
    targetSummary: targetSummary(feedback),
    ...(feedback.target ? { target: feedback.target } : {}),
    itemVersion: feedback.itemVersion,
    wantsRework: feedback.intent === "rework",
    ...(feedback.clearedBy ? { clearedBy: feedback.clearedBy } : {}),
    ...(feedback.clearedAt !== undefined ? { clearedAt: feedback.clearedAt } : {}),
    isDraft: feedback.state === "draft",
    updatedAt: feedback.updatedAt,
  };
}

export function toItemView(
  item: WorkbenchItem,
  mediaLookup: (mediaId: string) => MediaItem | undefined,
  feedbackForItem: readonly WorkbenchFeedback[],
  currentMedia: { mediaId: string; ref: WorkbenchMediaRef } | null,
  currentRepair: { mediaId: string; ref: WorkbenchMediaRef } | null,
): WorkbenchItemView {
  const feedback = pickLatestFeedback(feedbackForItem);
  const feedbackViews = [...feedbackForItem]
    .sort(
      (a, b) =>
        a.updatedAt - b.updatedAt ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    )
    .map(toFeedbackView);
  const content = item.content;
  const textPayload =
    content.type === "text"
      ? {
          entryId: content.entryId,
          title: content.title,
          speakerOrContext: content.speakerOrContext,
          originalText: content.versions[0].text,
          currentText: content.versions[content.versions.length - 1].text,
          originalVersion: content.versions[0].version,
          currentVersion: content.versions[content.versions.length - 1].version,
          ...(content.duplicateProposal
            ? { duplicateProposal: { ...content.duplicateProposal } }
            : {}),
          rangeComments: buildTextRangeComments(content, feedbackForItem),
        }
      : undefined;
  const dataPayload =
    content.type === "data"
      ? {
          datasetId: content.datasetId,
          columns: [...content.columns],
          rows: content.rows.map((row) => ({ rowId: row.rowId, cells: { ...row.cells } })),
          proposals: [...content.proposals],
        }
      : undefined;
  const imagePayload: ImagePayloadView | undefined = (() => {
    if (content.type !== "image") return undefined;
    const repairRevision = [...item.revisions]
      .reverse()
      .find((revision) => revision.kind === "image-repair" && revision.mediaId && revision.producedVersion === item.version);
    const repair = repairRevision?.mediaId
      ? {
          revisionId: repairRevision.id,
          mediaId: repairRevision.mediaId,
          producedVersion: repairRevision.producedVersion,
          ...(repairRevision.base ? { base: repairRevision.base } : {}),
        }
      : undefined;
    const repairMedia = repair
      ? currentRepair && currentRepair.mediaId === repair.mediaId
        ? currentRepair.ref
        : mediaRefFor(mediaLookup(repair.mediaId), null, "loading")
      : undefined;
    return {
      originalMedia:
        currentMedia && currentMedia.mediaId === content.mediaId
          ? currentMedia.ref
          : mediaRefFor(mediaLookup(content.mediaId), null, "loading"),
      ...(repairMedia ? { repairMedia } : {}),
      ...(repair ? { repair } : {}),
      initialDisplayMode:
        repair && repairMedia?.status !== "error" ? "repaired" : "original",
      ...(content.naturalWidth !== undefined ? { naturalWidth: content.naturalWidth } : {}),
      ...(content.naturalHeight !== undefined ? { naturalHeight: content.naturalHeight } : {}),
      annotations: [...content.annotations],
      strokes: [...content.strokes],
    };
  })();
  const groupMode = item.groupMode ?? item.lineage?.groupMode;
  const compareWithItemId = item.compareWithItemId ?? item.videoPayload?.compareWithItemId;
  const videoPayload =
    content.type === "video"
      ? {
          media:
            currentMedia && currentMedia.mediaId === content.mediaId
              ? currentMedia.ref
              : mediaRefFor(mediaLookup(content.mediaId), null, "loading"),
          ...(content.durationSec !== undefined ? { durationSec: content.durationSec } : {}),
          ...(content.resolution !== undefined ? { resolution: content.resolution } : {}),
          markers: [...content.markers],
          ...(compareWithItemId !== undefined ? { compareWithItemId } : {}),
        }
      : undefined;
  return {
    id: item.id,
    detailsLoaded: true,
    batchId: item.batchId,
    orderIndex: item.orderIndex,
    title: item.title,
    subtitle: item.subtitle ?? "",
    type: item.type,
    version: item.version,
    status: item.status,
    hasManualRevision: item.revisions.length > 0,
    provenanceTags: item.provenanceTags,
    userCategoryTags: [...item.userTags],
    ...(item.agentGuidance ? { agentGuidance: item.agentGuidance } : {}),
    ...(item.lineage ? { lineage: item.lineage } : {}),
    ...(item.reworkOrigin ? { reworkOrigin: item.reworkOrigin } : {}),
    ...(feedback
      ? { feedback: toFeedbackView(feedback) }
      : {}),
    feedbacks: feedbackViews,
    ...(textPayload ? { textPayload } : {}),
    ...(dataPayload ? { dataPayload } : {}),
    ...(imagePayload ? { imagePayload } : {}),
    ...(videoPayload ? { videoPayload } : {}),
    ...(content.type === "model3d" ? { modelPayload: { resourceId: content.resourceId } } : {}),
    ...(groupMode !== undefined ? { groupMode } : {}),
    ...(compareWithItemId !== undefined ? { compareWithItemId } : {}),
  };
}

/**
 * Combines persisted workbench state (project store, real actions) with
 * display state (workbench UI store). The controller is the ONLY writer
 * bridge: components call these callbacks, mutations commit through the
 * project store, and auto-advance happens strictly after success.
 */
export interface WorkbenchControllerSource {
  readonly scopeId: string;
  readonly workbench: WorkbenchProjectState;
  readonly mediaItems: readonly MediaItem[];
  readonly getWorkbench: () => WorkbenchProjectState;
  readonly commands: () => import("../../stores/project/workbench-slice").WorkbenchSlice;
  readonly openMedia: (mediaId: string) => Promise<{ url: string; release: () => void } | null>;
  readonly importRepair: (file: File) => Promise<WorkbenchMutationResult & { mediaId?: string }>;
  readonly undo: () => Promise<WorkbenchMutationResult>;
  readonly redo: () => Promise<WorkbenchMutationResult>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly summaries?: readonly WorkbenchItemView[];
  readonly batchViews?: readonly WorkbenchBatchView[];
  readonly managesBatchSelection?: boolean;
}

function useWorkbenchMedia(id: string | null, open: WorkbenchControllerSource["openMedia"]): { url: string | null; status: MediaLoadStatus; error?: string } {
  const [state, setState] = useState<{ id: string | null; url: string | null; status: MediaLoadStatus; error?: string }>({ id: null, url: null, status: "unavailable" });
  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | undefined;
    if (!id) { setState({ id, url: null, status: "unavailable" }); return; }
    setState({ id, url: null, status: "loading" });
    open(id).then(media => {
      if (cancelled) { media?.release(); return; }
      if (!media) { setState({ id, url: null, status: "error", error: "媒体原件未找到" }); return; }
      release = media.release;
      setState({ id, url: media.url, status: "ready" });
    }).catch((error: unknown) => {
      if (!cancelled) setState({ id, url: null, status: "error", error: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; release?.(); };
  }, [id, open]);
  return state.id === id ? state : { url: null, status: id ? "loading" : "unavailable" };
}

const projectWorkbench = () => useProjectStore.getState().project.workbench ?? emptyWorkbenchState();
async function projectHistory(direction: "undo" | "redo"): Promise<WorkbenchMutationResult> {
  const result = await useProjectStore.getState()[direction]();
  return result.success ? { ok: true } : ERROR(result.error?.code ?? "HISTORY_FAILED", result.error?.message ?? "历史操作失败");
}
const projectUndo = () => projectHistory("undo");
const projectRedo = () => projectHistory("redo");
async function importProjectRepair(file: File): Promise<WorkbenchMutationResult & { mediaId?: string }> {
  const result = await useProjectStore.getState().importMedia(file);
  if (!result.success) return ERROR(result.error?.code ?? "IMPORT_FAILED", result.error?.message ?? "修补媒体导入失败");
  const media = [...useProjectStore.getState().project.mediaLibrary.items].reverse()
    .find(media => media.name === file.name || media.sourceFile?.name === file.name);
  return media ? { ok: true, mediaId: media.id } : ERROR("IMPORT_FAILED", "修补媒体已导入但无法定位");
}

/** Legacy project host, retained for reviewing data before migration. */
export function useWorkbenchController(): WorkbenchController {
  const project = useProjectStore(state => state.project);
  const canUndo = useProjectStore(state => state.canUndo());
  const canRedo = useProjectStore(state => state.canRedo());
  const openMedia = useCallback(async (id: string) => {
    const blob = await loadMediaBlob(id, project.id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    return { url, release: () => URL.revokeObjectURL(url) };
  }, [project.id]);
  return useWorkbenchControllerSource({ scopeId: project.id, workbench: project.workbench ?? emptyWorkbenchState(),
    mediaItems: project.mediaLibrary.items, getWorkbench: projectWorkbench, commands: useProjectStore.getState,
    openMedia, importRepair: importProjectRepair, undo: projectUndo, redo: projectRedo, canUndo, canRedo });
}

/** Shared interaction logic. Persistence and media access belong to the explicit host. */
export function useWorkbenchControllerSource(source: WorkbenchControllerSource): WorkbenchController {
  const { workbench, mediaItems, getWorkbench, openMedia, importRepair, canUndo, canRedo } = source;
  const storeApi = source.commands;
  const activeBatchId = useWorkbenchUiStore((s) => s.activeBatchId);
  const typeFilter = useWorkbenchUiStore((s) => s.typeFilter);
  const searchQuery = useWorkbenchUiStore((s) => s.searchQuery);
  const autoAdvance = useWorkbenchUiStore((s) => s.autoAdvance);
  const mindMapOpen = useWorkbenchUiStore((s) => s.mindMapModalOpen);
  const cursorByBatch = useWorkbenchUiStore((s) => s.cursorByBatch);
  const selectionByBatch = useWorkbenchUiStore((s) => s.selectionByBatch);
  const ui = useWorkbenchUiStore.getState;

  // Resolve the effective active batch (first batch when none selected).
  const effectiveBatchId = activeBatchId ?? workbench.batches[0]?.id ?? null;
  useEffect(() => {
    if (source.managesBatchSelection) return;
    if (activeBatchId !== null && !workbench.batches.some((b) => b.id === activeBatchId)) {
      ui().setActiveBatchId(workbench.batches[0]?.id ?? null);
    }
  }, [source.managesBatchSelection, activeBatchId, workbench.batches, ui]);

  const mediaById = useMemo(() => new Map(mediaItems.map(item => [item.id, item])), [mediaItems]);
  const mediaLookup = useCallback(
    (mediaId: string): MediaItem | undefined => mediaById.get(mediaId),
    [mediaById],
  );

  const mediaAssets = useMemo<readonly WorkbenchMediaAsset[]>(() => {
    const usage = new Map<string, "pending" | "processed">();
    for (const item of workbench.items) {
      if (item.content.type !== "image" && item.content.type !== "video") continue;
      const mediaId = item.content.mediaId;
      if (item.status === "pending") {
        usage.set(mediaId, "pending");
      } else if (!usage.has(mediaId)) {
        usage.set(mediaId, "processed");
      }
    }
    return mediaItems
      .filter((media) => media.type === "image" || media.type === "video")
      .map((media) => ({
        id: media.id,
        name: media.displayName ?? media.name,
        type: media.type as "image" | "video",
        thumbnailUrl: media.thumbnailUrl,
        ...(media.metadata.width > 0 ? { width: media.metadata.width } : {}),
        ...(media.metadata.height > 0 ? { height: media.metadata.height } : {}),
        ...(media.type === "video" && media.metadata.duration > 0
          ? { durationSec: media.metadata.duration }
          : {}),
        usage: usage.get(media.id) ?? "none",
      }));
  }, [mediaItems, workbench.items]);

  /**
   * Create a workbench batch from project media without an Agent. The dialog
   * freezes batchId/itemIds per media selection; retries reuse them, a changed
   * selection gets fresh ids. Ingest itself is idempotent per (itemId,version).
   */
  const createBatchFromMedia = useCallback(
    async (input: CreateWorkbenchBatchInput): Promise<CreateWorkbenchBatchResult> => {
      const mediaIds = [...new Set(input.mediaIds)];
      if (!mediaIds.length) {
        return { ok: false, code: "INVALID_PARAMS", message: "请至少选择一项图片或视频" };
      }
      if (input.itemIds && input.itemIds.length !== mediaIds.length) {
        return { ok: false, code: "INVALID_PARAMS", message: "提交身份与选材数量不一致" };
      }
      const media = mediaIds.map((id) => mediaLookup(id));
      const missing = mediaIds.filter((_, index) => !media[index]);
      if (missing.length > 0) {
        return { ok: false, code: "NOT_FOUND", message: `素材不存在: ${missing.join(", ")}` };
      }
      const batchId =
        input.batchId ?? `wb-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
      const itemIds =
        input.itemIds ??
        mediaIds.map(() => `wb-item-${crypto.randomUUID()}`);
      const name = input.name.trim() || `素材审阅 ${new Date().toLocaleString()}`;
      const batchTag: import("@reelterminal/core").WorkbenchProvenanceTag = {
        id: `prov-batch-${batchId}`,
        category: "batch",
        shortName: "本地导入",
        verification: "declared",
        detailSummary: "项目素材库",
      };
      const items = mediaIds.map((mediaId, index) => {
        const source = media[index] as MediaItem;
        const title = source.displayName ?? source.name;
        const mediaTag: import("@reelterminal/core").WorkbenchProvenanceTag = {
          id: `prov-media-${mediaId}`,
          category: "source",
          shortName: title,
          verification: "declared",
          upstreamRef: mediaId,
          detailSummary: `项目媒体 ${source.name}`,
        };
        return {
          id: itemIds[index],
          title,
          type: source.type as "image" | "video",
          content:
            source.type === "image"
              ? {
                  type: "image" as const,
                  mediaId,
                  ...(source.metadata.width > 0
                    ? { naturalWidth: source.metadata.width }
                    : {}),
                  ...(source.metadata.height > 0
                    ? { naturalHeight: source.metadata.height }
                    : {}),
                  annotations: [],
                  strokes: [],
                }
              : {
                  type: "video" as const,
                  mediaId,
                  ...(source.metadata.duration > 0
                    ? { durationSec: source.metadata.duration }
                    : {}),
                  ...(source.metadata.width > 0 && source.metadata.height > 0
                    ? { resolution: `${source.metadata.width}x${source.metadata.height}` }
                    : {}),
                  markers: [],
                },
          provenanceTags: [batchTag, mediaTag],
        };
      });
      const result = await storeApi().ingestWorkbenchBatch({
        batchId,
        name,
        ...(input.description ? { description: input.description } : {}),
        items,
      });
      if (!result.ok) return result;
      ui().setActiveBatchId(batchId);
      ui().setCursor(batchId, itemIds[0]);
      ui().setSelection(batchId, [itemIds[0]]);
      return { ok: true, batchId, itemIds };
    },
    [mediaLookup, storeApi, ui],
  );

  const rawBatchItems = useMemo(
    () => (effectiveBatchId ? workbenchBatchItems(workbench, effectiveBatchId) : []),
    [workbench, effectiveBatchId],
  );

  const visibleRawItems = useMemo(
    () => filterVisibleWorkbenchItems<WorkbenchItem | WorkbenchItemView>(source.summaries ?? rawBatchItems, typeFilter, searchQuery),
    [source.summaries, rawBatchItems, typeFilter, searchQuery],
  );

  const visibleIds = useMemo(() => visibleRawItems.map((item) => item.id), [visibleRawItems]);

  // Filter changes drop selections that left the visible scope (no hidden-item
  // multi-select), and move the cursor to the first visible item when needed.
  useEffect(() => {
    if (!effectiveBatchId) return;
    ui().pruneSelection(effectiveBatchId, visibleIds);
  }, [effectiveBatchId, visibleIds, ui]);

  useEffect(() => {
    if (!effectiveBatchId || visibleIds.length === 0) return;
    const cursor = cursorByBatch[effectiveBatchId];
    if (cursor && visibleIds.includes(cursor)) return;
    const next =
      visibleRawItems.find((item) => item.status === "pending") ?? visibleRawItems[0];
    if (next) ui().setCursor(effectiveBatchId, next.id);
  }, [effectiveBatchId, visibleIds, visibleRawItems, cursorByBatch, ui]);

  // Strictly visible: an empty result set yields null instead of a hidden item.
  const currentTargetItem = useMemo(
    () => {
      const cursor = resolveVisibleWorkbenchCursor(
        visibleRawItems,
        effectiveBatchId ? cursorByBatch[effectiveBatchId] : undefined,
      );
      return rawBatchItems.find(item => item.id === cursor?.id) ?? null;
    },
    [rawBatchItems, visibleRawItems, cursorByBatch, effectiveBatchId],
  );

  const currentMediaId = useMemo(() => {
    const target = currentTargetItem;
    if (!target) return null;
    if (target.content.type === "image" || target.content.type === "video") {
      return target.content.mediaId;
    }
    return null;
  }, [currentTargetItem]);

  const currentRepairRevision = useMemo(() => {
    const target = currentTargetItem;
    if (!target || target.content.type !== "image") return null;
    const revision = [...target.revisions]
      .reverse()
      .find((candidate) => candidate.kind === "image-repair" && candidate.mediaId && candidate.producedVersion === target.version);
    return revision?.mediaId
      ? {
          revisionId: revision.id,
          mediaId: revision.mediaId,
          producedVersion: revision.producedVersion,
          ...(revision.base ? { base: revision.base } : {}),
        }
      : null;
  }, [currentTargetItem]);

  const currentRepairMediaId = currentRepairRevision?.mediaId ?? null;

  const { url: mediaUrl, status: mediaStatus, error: mediaError } = useWorkbenchMedia(currentMediaId, openMedia);
  const { url: repairUrl, status: repairStatus, error: repairError } = useWorkbenchMedia(currentRepairMediaId, openMedia);
  const currentMedia = useMemo(
    () =>
      currentMediaId
        ? {
            mediaId: currentMediaId,
            ref: mediaRefFor(
              mediaLookup(currentMediaId),
              mediaUrl,
              mediaStatus,
              mediaError,
            ),
          }
        : null,
    [currentMediaId, mediaLookup, mediaUrl, mediaStatus, mediaError],
  );

  const currentRepair = useMemo(
    () =>
      currentRepairMediaId
        ? {
            mediaId: currentRepairMediaId,
            ref: mediaRefFor(
              mediaLookup(currentRepairMediaId),
              repairUrl,
              repairStatus,
              repairError,
            ),
          }
        : null,
    [currentRepairMediaId, mediaLookup, repairUrl, repairStatus, repairError],
  );

  const feedbackByItem = useMemo(() => {
    const map = new Map<string, WorkbenchFeedback[]>();
    for (const record of workbench.feedback) {
      const list = map.get(record.itemId) ?? [];
      list.push(record);
      map.set(record.itemId, list);
    }
    return map;
  }, [workbench.feedback]);

  const batchItems = useMemo(() => {
    const loaded = rawBatchItems.map(item => toItemView(item, mediaLookup, feedbackByItem.get(item.id) ?? [], null, null));
    const loadedById = new Map(loaded.map(item => [item.id, item]));
    return source.summaries ? source.summaries.map(summary => loadedById.get(summary.id) ?? summary) : loaded;
  }, [source.summaries, mediaLookup, feedbackByItem, rawBatchItems]);
  const visibleItems = useMemo(() => {
    const ids = new Set(visibleIds);
    return batchItems.filter(item => ids.has(item.id));
  }, [batchItems, visibleIds]);
  const pendingItems = useMemo(
    () => visibleItems.filter((item) => item.status === "pending"),
    [visibleItems],
  );

  const selectedIds = useMemo(
    () => (effectiveBatchId ? selectionByBatch[effectiveBatchId] ?? [] : []),
    [selectionByBatch, effectiveBatchId],
  );
  // The view is built from the same visible raw item, so the viewer can never
  // show/act on an item hidden by the current filter/search.
  const currentItem = useMemo(
    () => (currentTargetItem ? toItemView(currentTargetItem, mediaLookup, feedbackByItem.get(currentTargetItem.id) ?? [], currentMedia, currentRepair) : null),
    [currentTargetItem, mediaLookup, feedbackByItem, currentMedia, currentRepair],
  );

  const batches: readonly WorkbenchBatchView[] = useMemo(
    () =>
      source.batchViews ?? workbench.batches.map((batch: WorkbenchBatch) => {
        const items = workbenchBatchItems(workbench, batch.id);
        return {
          id: batch.id,
          name: batch.name,
          ...(batch.description !== undefined ? { description: batch.description } : {}),
          revision: batch.revision,
          totalCount: items.length,
          pendingCount: items.filter((item) => item.status === "pending").length,
        };
      }),
    [source.batchViews, workbench],
  );
  const activeBatch = useMemo(
    () => batches.find((batch) => batch.id === effectiveBatchId) ?? null,
    [batches, effectiveBatchId],
  );

  const provenanceTags: readonly WorkbenchProvenanceTag[] = useMemo(() => {
    const map = new Map<string, WorkbenchProvenanceTag>();
    for (const item of source.summaries ?? rawBatchItems) {
      for (const tag of item.provenanceTags) {
        if (!map.has(tag.id)) map.set(tag.id, tag);
      }
    }
    return [...map.values()];
  }, [source.summaries, rawBatchItems]);

  const handoffs: readonly WorkbenchHandoff[] = useMemo(
    () => workbench.handoffs.filter((handoff) => handoff.batchId === effectiveBatchId),
    [workbench.handoffs, effectiveBatchId],
  );


  // --- selection / navigation -------------------------------------------------

  const selectItem = useCallback(
    (itemId: string, modifiers?: SelectModifiers) => {
      if (!effectiveBatchId) return;
      const { selection, cursor } = applyWorkbenchSelection(
        visibleIds,
        currentItem?.id ?? null,
        selectionByBatch[effectiveBatchId] ?? [],
        itemId,
        modifiers ?? {},
      );
      ui().setSelection(effectiveBatchId, selection);
      ui().setCursor(effectiveBatchId, cursor);
    },
    [effectiveBatchId, visibleIds, currentItem, selectionByBatch, ui],
  );

  const selectAllVisible = useCallback(() => {
    if (!effectiveBatchId) return;
    ui().setSelection(effectiveBatchId, visibleIds);
  }, [effectiveBatchId, visibleIds, ui]);

  const clearSelection = useCallback(() => {
    if (!effectiveBatchId) return;
    ui().setSelection(effectiveBatchId, []);
  }, [effectiveBatchId, ui]);

  const skipNext = useCallback(() => {
    if (!effectiveBatchId || pendingItems.length === 0) return;
    const idx = pendingItems.findIndex((i) => i.id === currentItem?.id);
    const next =
      idx >= 0 && idx + 1 < pendingItems.length ? pendingItems[idx + 1] : pendingItems[0];
    if (next) {
      ui().setCursor(effectiveBatchId, next.id);
      ui().setSelection(effectiveBatchId, [next.id]);
    }
  }, [effectiveBatchId, pendingItems, currentItem, ui]);

  const skipPrev = useCallback(() => {
    if (!effectiveBatchId || pendingItems.length === 0) return;
    const idx = pendingItems.findIndex((i) => i.id === currentItem?.id);
    const prev =
      idx > 0 ? pendingItems[idx - 1] : pendingItems[pendingItems.length - 1];
    if (prev) {
      ui().setCursor(effectiveBatchId, prev.id);
      ui().setSelection(effectiveBatchId, [prev.id]);
    }
  }, [effectiveBatchId, pendingItems, currentItem, ui]);

  // --- decisions ----------------------------------------------------------------

  const advanceAfterDecision = useCallback(
    (decidedIds: readonly string[]) => {
      if (!effectiveBatchId || !autoAdvance) return;
      const decided = new Set(decidedIds);
      const lastOrder = Math.max(
        ...batchItems.filter((i) => decided.has(i.id)).map((i) => i.orderIndex),
        0,
      );
      const next =
        pendingItems.find((i) => !decided.has(i.id) && i.orderIndex > lastOrder) ??
        pendingItems.find((i) => !decided.has(i.id));
      if (next) {
        ui().setCursor(effectiveBatchId, next.id);
        ui().setSelection(effectiveBatchId, [next.id]);
      } else {
        ui().setSelection(effectiveBatchId, []);
      }
    },
    [effectiveBatchId, autoAdvance, batchItems, pendingItems, ui],
  );

  const commitDecision = useCallback(
    async (
      decision: WorkbenchDecision,
      explicitTargetIds?: readonly string[],
    ): Promise<WorkbenchMutationResult> => {
      const targets = explicitTargetIds ?? selectedIds;
      if (targets.length === 0) {
        return ERROR("NO_TARGETS", "未选择条目:批量操作需要明确的作用范围");
      }
      if (!effectiveBatchId) return ERROR("NO_BATCH", "没有活动批次");
      const result = await storeApi().decideWorkbenchItems(
        effectiveBatchId,
        targets.map((itemId) => ({ itemId, decision })),
        "human",
      );
      if (result.ok) advanceAfterDecision(targets);
      return result;
    },
    [selectedIds, effectiveBatchId, storeApi, advanceAfterDecision],
  );

  const commitBranchNod = useCallback(
    async (items: readonly WorkbenchItemView[]): Promise<WorkbenchMutationResult> => {
      if (!effectiveBatchId) return ERROR("NO_BATCH", "没有活动批次");
      const withoutGuidance = items.filter((item) => !item.agentGuidance);
      if (withoutGuidance.length === items.length) {
        return ERROR("NO_GUIDANCE", "所选条目没有 Agent 建议,无法整枝点头");
      }
      const skipped: string[] = [];
      const plainTargets: Array<{ itemId: string; decision: WorkbenchDecision }> = [];
      const dataTargets: Array<{ itemId: string }> = [];
      for (const item of items) {
        const guidance = item.agentGuidance;
        if (!guidance) {
          skipped.push(item.id);
          continue;
        }
        if (guidance.nodDecision === "modified") {
          // A "modified" nod only executes when a real patch exists (pending
          // data proposals on a data item); otherwise it must NOT mark modified.
          if (item.dataPayload?.proposals.some((p) => p.status === "proposed")) {
            dataTargets.push({ itemId: item.id });
          } else {
            skipped.push(item.id);
          }
        } else {
          plainTargets.push({ itemId: item.id, decision: guidance.nodDecision });
        }
      }
      if (plainTargets.length === 0 && dataTargets.length === 0) {
        return ERROR(
          "NO_EXECUTABLE",
          `整枝确认无可执行项:${skipped.length} 项建议为“修改”但不存在可执行 patch,已全部跳过`,
        );
      }
      if (plainTargets.length > 0) {
        const result = await storeApi().decideWorkbenchItems(
          effectiveBatchId,
          plainTargets,
          "human",
        );
        if (!result.ok) return result;
      }
      for (const target of dataTargets) {
        const view = items.find((item) => item.id === target.itemId);
        const proposals = view?.dataPayload?.proposals.filter((p) => p.status === "proposed") ?? [];
        const patches: DataPatchInput[] = proposals.map((proposal) => ({
          rowId: proposal.rowId,
          columnId: proposal.columnId,
          value: proposal.proposedValue,
          proposalId: proposal.proposalId,
          proposalOutcome: "accepted",
        }));
        const result = await storeApi().saveWorkbenchDataPatches(target.itemId, patches);
        if (!result.ok) return result;
      }
      advanceAfterDecision(items.map((item) => item.id));
      if (skipped.length > 0) {
        // Honest partial report: skipped items keep their pending status.
        return { ok: true };
      }
      return { ok: true };
    },
    [effectiveBatchId, storeApi, advanceAfterDecision],
  );

  const retrieveToPending = useCallback(
    async (itemId: string): Promise<WorkbenchMutationResult> => {
      const result = await storeApi().revertWorkbenchItems([itemId]);
      if (result.ok && effectiveBatchId) {
        ui().setCursor(effectiveBatchId, itemId);
        ui().setSelection(effectiveBatchId, [itemId]);
      }
      return result;
    },
    [storeApi, effectiveBatchId, ui],
  );

  const undoLast = source.undo;
  const redoLast = source.redo;

  const addUserTag = useCallback(
    async (itemId: string, tag: string): Promise<WorkbenchMutationResult> => {
      const clean = tag.replace(/^#/, "").trim();
      if (!clean) return ERROR("INVALID_TAG", "标签为空");
      const item = rawBatchItems.find((candidate) => candidate.id === itemId);
      if (!item) return ERROR("NOT_FOUND", "条目不存在");
      if (item.userTags.includes(clean)) return { ok: true };
      return storeApi().setWorkbenchUserTags(itemId, [...item.userTags, clean]);
    },
    [rawBatchItems, storeApi],
  );

  // --- content edits --------------------------------------------------------------

  const saveTextRevision = useCallback(
    async (itemId: string, newText: string): Promise<WorkbenchMutationResult> =>
      storeApi().saveWorkbenchTextRevision(itemId, newText),
    [storeApi],
  );

  const addRangeComment = useCallback(
    async (
      itemId: string,
      comment: RangeCommentInput,
      expectedVersion?: number,
    ): Promise<WorkbenchMutationResult> => {
      const state = getWorkbench();
      const item = state.items.find((candidate) => candidate.id === itemId);
      if (!item || item.content.type !== "text") {
        return ERROR("NOT_FOUND", "文本条目不存在");
      }
      if (expectedVersion !== undefined && item.version !== expectedVersion) {
        return ERROR(
          "CONFLICT",
          `文本已更新到 v${item.version}（选区来自 v${expectedVersion}），请重新选择文本后再批注`,
        );
      }
      const target: import("@reelterminal/core").WorkbenchFeedbackTarget = {
        kind: "text-range",
        entryId: item.content.entryId,
        version: item.version,
        startOffset: comment.startOffset,
        endOffset: comment.endOffset,
      };
      const existing = findExistingIssueFeedback(
        state.feedback,
        itemId,
        item.version,
        target,
      );
      const now = Date.now();
      const feedback: WorkbenchFeedback = {
        id:
          existing?.id ??
          feedbackIdFor(itemId, item.version, feedbackTargetKey(target) ?? "item"),
        itemId,
        itemVersion: item.version,
        text: comment.suggestion,
        referencedTagIds: [...comment.referencedTags],
        target,
        intent: "note",
        state: "confirmed",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      return storeApi().saveWorkbenchFeedback(feedback);
    },
    [storeApi, getWorkbench],
  );

  const confirmDuplicate = useCallback(
    async (itemId: string, action: "discard" | "dismiss_proposal"): Promise<WorkbenchMutationResult> => {
      if (action === "discard") {
        return commitDecision("discarded", [itemId]);
      }
      return storeApi().dismissWorkbenchDuplicate(itemId);
    },
    [commitDecision, storeApi],
  );

  const updateDataCells = useCallback(
    async (
      itemId: string,
      patches: readonly DataPatchInput[],
      markDecision?: "modified",
      expectedVersion?: number,
    ): Promise<WorkbenchMutationResult> => {
      if (patches.length === 0) {
        return ERROR("NO_PATCHES", "没有显式单元格修改(不支持整表覆盖)");
      }
      if (expectedVersion !== undefined) {
        const state = getWorkbench();
        const item = state.items.find((candidate) => candidate.id === itemId);
        if (!item) return ERROR("NOT_FOUND", "数据条目不存在");
        if (item.version !== expectedVersion) {
          return ERROR(
            "CONFLICT",
            `条目已更新到 v${item.version}（编辑基于 v${expectedVersion}），草稿未写入，请基于最新内容重试`,
          );
        }
      }
      // The decision is a separate explicit choice: proposal accept/value
      // edits pass "modified"; a reject/proposal-only change must not append a
      // modified decision by itself.
      return storeApi().saveWorkbenchDataPatches(
        itemId,
        patches,
        expectedVersion,
        markDecision === "modified",
      );
    },
    [storeApi, getWorkbench],
  );

  const markDataRework = useCallback(
    async (
      itemId: string,
      itemVersion: number,
      cells: readonly DataReworkCell[],
      reason?: string,
    ): Promise<WorkbenchMutationResult> => {
      if (cells.length === 0) return ERROR("NO_CELLS", "请先选择要标记返工的单元格");
      return storeApi().markWorkbenchDataRework({
        itemId,
        itemVersion,
        cells,
        ...(reason ? { reason } : {}),
      });
    },
    [storeApi],
  );

  const clearDataRework = useCallback(
    async (
      itemId: string,
      itemVersion: number,
      cells: readonly DataReworkCell[],
    ): Promise<WorkbenchMutationResult> => {
      if (cells.length === 0) return ERROR("NO_CELLS", "请先选择要取消返工的单元格");
      return storeApi().clearWorkbenchDataRework(
        itemId,
        itemVersion,
        cells.map((cell) => ({ rowId: cell.rowId, columnId: cell.columnId })),
      );
    },
    [storeApi],
  );

type IssueFeedbackInput = {
  text: string;
  referencedTagIds: readonly string[];
  markRework: boolean;
  state?: "draft" | "confirmed";
  target?: import("@reelterminal/core").WorkbenchFeedbackTarget;
};

  const buildIssueFeedbackRecord = useCallback(
    (
      item: WorkbenchItem,
      feedback: IssueFeedbackInput,
      allFeedback: readonly WorkbenchFeedback[],
    ): WorkbenchFeedback => {
      const target = feedback.target ?? ({ kind: "whole-item" } as const);
      const existing = findExistingIssueFeedback(
        allFeedback,
        item.id,
        item.version,
        target,
      );
      const key = feedbackTargetKey(target) ?? "item";
      const now = Date.now();
      return {
        id: existing?.id ?? feedbackIdFor(item.id, item.version, key),
        itemId: item.id,
        itemVersion: item.version,
        text: feedback.text,
        referencedTagIds: [...feedback.referencedTagIds],
        target,
        intent: feedback.markRework ? ("rework" as const) : ("note" as const),
        state: feedback.state ?? "confirmed",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
    },
    [],
  );


  const updateImageAnnotations = useCallback(
    async (
      itemId: string,
      annotations: readonly import("@reelterminal/core").WorkbenchSpatialAnnotation[],
      feedback?: IssueFeedbackInput,
      expectedVersion?: number,
    ): Promise<WorkbenchMutationResult> => {
      // Read the CURRENT persisted item: concurrent Agent edits must surface
      // as a conflict, not be overwritten by a stale React snapshot.
      const state = getWorkbench();
      const item = state.items.find((candidate) => candidate.id === itemId);
      if (!item || item.content.type !== "image") {
        return ERROR("NOT_FOUND", "图片条目不存在");
      }
      if (expectedVersion !== undefined && item.version !== expectedVersion) {
        return ERROR(
          "CONFLICT",
          `条目已更新到 v${item.version}（编辑器为 v${expectedVersion}），请查看最新内容后重试`,
        );
      }
      // Geometry-only edits (draw/delete/clear) never create feedback.
      if (!feedback) {
        return storeApi().setWorkbenchAnnotations(itemId, item.version, { annotations });
      }
      return storeApi().saveWorkbenchIssueFeedback(item.id, item.version, {
        annotations,
        feedback: buildIssueFeedbackRecord(item, feedback, state.feedback),
        ...(feedback.markRework ? { decision: "rework" as const } : {}),
      });
    },
    [storeApi, getWorkbench, buildIssueFeedbackRecord],
  );

  const saveImageRepair = useCallback(
    async (
      itemId: string,
      strokes: readonly import("@reelterminal/core").WorkbenchPixelStroke[],
      renderPatchedImage: () => Promise<Blob | null>,
      base?: import("@reelterminal/core").WorkbenchRepairBase,
    ): Promise<WorkbenchMutationResult> => {
      const item = rawBatchItems.find((candidate) => candidate.id === itemId);
      if (!item || item.content.type !== "image") {
        return ERROR("NOT_FOUND", "图片条目不存在");
      }
      if (strokes.length === 0) return ERROR("NO_STROKES", "没有修补笔画");
      const blob = await renderPatchedImage();
      if (!blob) {
        return ERROR("RENDER_FAILED", "无法生成修补图像(原图位图不可用),修补未提交");
      }
      const fileName = `wb-repair-${itemId}-v${item.version}.png`;
      const file = new File([blob], fileName, { type: "image/png" });
      const imported = await importRepair(file);
      if (!imported.ok || !imported.mediaId) return imported;
      return storeApi().commitWorkbenchImageRepair(itemId, imported.mediaId, strokes, base);
    },
    [rawBatchItems, storeApi, importRepair],
  );

  const updateVideoMarkers = useCallback(
    async (
      itemId: string,
      markers: readonly import("@reelterminal/core").WorkbenchVideoMarker[],
      feedback?: IssueFeedbackInput,
      expectedVersion?: number,
    ): Promise<WorkbenchMutationResult> => {
      const state = getWorkbench();
      const item = state.items.find((candidate) => candidate.id === itemId);
      if (!item || item.content.type !== "video") {
        return ERROR("NOT_FOUND", "视频条目不存在");
      }
      if (expectedVersion !== undefined && item.version !== expectedVersion) {
        return ERROR(
          "CONFLICT",
          `条目已更新到 v${item.version}（编辑器为 v${expectedVersion}），请查看最新内容后重试`,
        );
      }
      if (!feedback) {
        return storeApi().setWorkbenchAnnotations(itemId, item.version, { markers });
      }
      return storeApi().saveWorkbenchIssueFeedback(item.id, item.version, {
        markers,
        feedback: buildIssueFeedbackRecord(item, feedback, state.feedback),
        ...(feedback.markRework ? { decision: "rework" as const } : {}),
      });
    },
    [storeApi, getWorkbench, buildIssueFeedbackRecord],
  );

  const saveFeedback = useCallback(
    async (itemId: string, draft: FeedbackDraftInput): Promise<WorkbenchMutationResult> => {
      const state = getWorkbench();
      const item = state.items.find((candidate) => candidate.id === itemId);
      if (!item) return ERROR("NOT_FOUND", "条目不存在");
      const record = buildIssueFeedbackRecord(
        item,
        {
          text: draft.text,
          referencedTagIds: draft.referencedTagIds,
          markRework: false,
          state: draft.confirmed ? "confirmed" : "draft",
          target: { kind: "whole-item" },
        },
        state.feedback,
      );
      return storeApi().saveWorkbenchFeedback(record);
    },
    [storeApi, getWorkbench, buildIssueFeedbackRecord],
  );

  const publishHandoff = useCallback(
    async (itemIds?: readonly string[]): Promise<WorkbenchMutationResult> => {
      if (!effectiveBatchId) return ERROR("NO_BATCH", "没有活动批次");
      return storeApi().publishWorkbenchHandoff(effectiveBatchId, itemIds);
    },
    [effectiveBatchId, storeApi],
  );

  // Keep the UI store's batch pointer in sync on first render, and reset
  // per-project display state when the open project identity changes.
  const projectId = source.scopeId;
  const lastProjectIdRef = useRef(projectId);
  useEffect(() => {
    if (lastProjectIdRef.current !== projectId) {
      lastProjectIdRef.current = projectId;
      ui().resetProjectScopedState();
      return;
    }
    if (!activeBatchId && workbench.batches.length > 0) {
      ui().setActiveBatchId(workbench.batches[0].id);
    }
  }, [projectId, activeBatchId, workbench.batches, ui]);

  return {
    batches,
    mediaAssets,
    createBatchFromMedia,
    activeBatch,
    batchItems,
    visibleItems,
    visibleItemIds: visibleIds,
    pendingItems,
    currentItem,
    selectedIds,
    selectionCount: selectedIds.length,
    provenanceTags,
    handoffs,
    canUndo,
    canRedo,
    typeFilter,
    searchQuery,
    autoAdvance,
    setTypeFilter: (filter) => ui().setTypeFilter(filter),
    setSearchQuery: (query) => ui().setSearchQuery(query),
    setAutoAdvance: (enabled) => ui().setAutoAdvance(enabled),
    setActiveBatchId: (batchId) => ui().setActiveBatchId(batchId),
    openMindMapModal: () => ui().setMindMapModalOpen(true),
    closeMindMapModal: () => ui().setMindMapModalOpen(false),
    isMindMapModalOpen: mindMapOpen,
    selectItem,
    selectAllVisible,
    clearSelection,
    skipNext,
    skipPrev,
    commitDecision,
    commitBranchNod,
    retrieveToPending,
    undoLast,
    redoLast,
    addUserTag,
    saveTextRevision,
    addRangeComment,
    confirmDuplicate,
    updateDataCells,
    markDataRework,
    clearDataRework,
    updateImageAnnotations,
    saveImageRepair,
    updateVideoMarkers,
    saveFeedback,
    openMediaUrl: openMedia,
    publishHandoff,
  };
}
