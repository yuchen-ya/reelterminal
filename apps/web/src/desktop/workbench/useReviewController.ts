import { saveModelObservation } from "../../services/review-workspace/model-feedback";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MediaItem, WorkbenchHandoff, WorkbenchProjectState } from "@reelterminal/core";
import { emptyWorkbenchState } from "@reelterminal/core";
import type { FileResource, ReviewContext } from "@reelterminal/core/review/types";
import { FACADE_ERROR_CODES } from "@reelterminal/agent-facade/errors";
import { reviewService, type ReviewItemSummary, type ReviewOverview, type ReviewReadScope } from "../../services/review-workspace/service";
import { reviewError } from "../../services/review-workspace/guards";
import { manualReviewSteps } from "../../services/review-workspace/manual-steps";
import { prepareReviewBlob } from "../../services/review-workspace/files";
import { createWorkbenchCommands, type WorkbenchMutationOutcome, type WorkbenchSlice } from "../../stores/project/workbench-slice";
import { useWorkbenchUiStore } from "../../stores/workbench-ui-store";
import { reviewSeenKey, useReviewSeenStore } from "../../stores/review-seen-store";
import { toItemView, useWorkbenchControllerSource } from "./useWorkbenchController";
import type { WorkbenchItemView, WorkbenchMutationResult } from "./types";

type Target = ReviewContext["target"];
type LoadedItem = Awaited<ReturnType<typeof reviewService.getItem>>;
const EMPTY = emptyWorkbenchState();

function commandReadScope(name: keyof WorkbenchSlice, args: unknown[]): ReviewReadScope | undefined {
  switch (name) {
    case "decideWorkbenchItems": return { itemIds: (args[1] as { itemId: string }[]).map(entry => entry.itemId) };
    case "revertWorkbenchItems": return { itemIds: args[0] as string[] };
    case "saveWorkbenchFeedback":
    case "markWorkbenchDataRework": return { itemIds: [(args[0] as { itemId: string }).itemId] };
    case "saveWorkbenchTextRevision":
    case "saveWorkbenchDataPatches":
    case "commitWorkbenchImageRepair":
    case "setWorkbenchAnnotations":
    case "saveWorkbenchIssueFeedback":
    case "clearWorkbenchDataRework":
    case "setWorkbenchUserTags":
    case "dismissWorkbenchDuplicate": return { itemIds: [args[0] as string] };
    case "ingestWorkbenchBatch":
    case "publishWorkbenchHandoff":
    case "ackWorkbenchHandoff":
    case "ingestWorkbenchRework": return undefined;
  }
}

function outcome(error: unknown): Extract<WorkbenchMutationResult, { ok: false }> {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && (FACADE_ERROR_CODES as readonly string[]).includes(code)) return { ok: false, code, message: (error as Error).message };
  if (error instanceof DOMException && error.name === "QuotaExceededError") return { ok: false, code: "ACTION_FAILED", message: "存储空间不足，审阅修改未提交" };
  throw error;
}

function summaryView(summary: ReviewItemSummary): WorkbenchItemView {
  const { videoPayload, ...metadata } = summary;
  return { ...metadata, groupMode: summary.groupMode ?? summary.lineage?.groupMode,
    compareWithItemId: summary.compareWithItemId ?? videoPayload?.compareWithItemId,
    detailsLoaded: false, subtitle: summary.subtitle ?? "", userCategoryTags: summary.userTags, feedbacks: [] };
}

function mediaView(resource: FileResource): MediaItem {
  const facts = resource.metadata;
  if (!facts) throw reviewError("INVALID_PARAMS", "Review media has no inspected metadata");
  return { id: resource.id, name: resource.originalFileName, type: facts.type, fileHandle: null, blob: null,
    metadata: { duration: facts.durationSec, width: facts.width, height: facts.height, frameRate: facts.frameRate, codec: facts.codec, sampleRate: 0, channels: 0, fileSize: resource.size },
    thumbnailUrl: facts.type === "image" ? `app://reelterminal/review-media/${resource.id}` : null, waveformData: null, contentUrl: `app://reelterminal/review-media/${resource.id}`, contentHash: resource.sha256 };
}

async function openReviewMedia(id: string) {
  const [resource] = await reviewService.getResources([id]);
  if (resource.storage.kind === "unavailable") throw reviewError("NOT_FOUND", resource.storage.reason);
  const native = window.reelterminal?.reviewFiles;
  if (!native) throw reviewError("UNSUPPORTED", "Native review media access is unavailable");
  const result = await native.resolve(id);
  if (!result.ok) throw reviewError(result.error.code, result.error.message);
  return { url: `app://reelterminal/review-media/${id}`, release: () => {} };
}

/** A node-bound controller. Lists read summaries; only the selected item reads bodies. */
export function useReviewController(target: Target) {
  const seen = useReviewSeenStore(state => state.seen);
  const markSeen = useReviewSeenStore(state => state.markSeen);
  const [overview, setOverview] = useState<ReviewOverview | null>(null);
  const [page, setPage] = useState<{ items: readonly ReviewItemSummary[]; cursor?: string }>({ items: [] });
  const pageCursor = useWorkbenchUiStore(state => state.reviewPageCursor);
  const previousCursors = useWorkbenchUiStore(state => state.reviewPreviousCursors);
  const [loadedDetail, setLoadedDetail] = useState<{ targetKey: string; snapshot: LoadedItem } | null>(null);
  const [resources, setResources] = useState<readonly FileResource[]>([]);
  const [extraLoaded, setExtraLoaded] = useState<ReadonlyMap<string, LoadedItem>>(new Map());
  const [extraResources, setExtraResources] = useState<ReadonlyMap<string, FileResource>>(new Map());
  const [expanded, setExpanded] = useState<WorkbenchProjectState | null>(null);
  const [handoffs, setHandoffs] = useState<readonly WorkbenchHandoff[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const prepared = useRef(new Map<string, FileResource>());
  const activeBatchId = useWorkbenchUiStore(state => state.activeBatchId);
  const type = useWorkbenchUiStore(state => state.typeFilter);
  const query = useWorkbenchUiStore(state => state.searchQuery);
  const cursors = useWorkbenchUiStore(state => state.cursorByBatch);
  const handoffOpen = useWorkbenchUiStore(state => state.handoffDialogOpen);
  const refresh = useCallback(() => setGeneration(value => value + 1), []);
  const extraLoadScope = useMemo(() => ({ target, revision: overview?.node.revision, items: page.items, activeBatchId, pageCursor, type, query }),
    [target, overview?.node.revision, page.items, activeBatchId, pageCursor, type, query]);
  const extraLoadScopeRef = useRef<object | null>(extraLoadScope);

  // Collection details survive drill-in/back, but never outlive their revision or list scope.
  useEffect(() => {
    extraLoadScopeRef.current = extraLoadScope;
    setExtraLoaded(new Map());
    setExtraResources(new Map());
    return () => { extraLoadScopeRef.current = null; };
  }, [extraLoadScope]);

  useEffect(() => reviewService.subscribe(refresh), [refresh]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const load = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const next = await reviewService.overview(target);
        const batchId = next.batches.some(batch => batch.id === activeBatchId) ? activeBatchId! : next.batches[0]?.id;
        const items = await reviewService.listItems(target, { batchId, type, query, cursor: pageCursor });
        if (items.node.revision !== next.node.revision) continue;
        if (!cancelled) {
          setOverview(next); setPage(items); setLoading(false);
          if (activeBatchId !== batchId) useWorkbenchUiStore.getState().setActiveBatchId(batchId ?? null);
        }
        return;
      }
      throw reviewError("CONFLICT", "审阅内容正在更新，请刷新后重试");
    };
    void load().catch(problem => {
      if (!cancelled) { setError(problem instanceof Error ? problem.message : String(problem)); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [target, activeBatchId, type, query, pageCursor, generation]);

  const batchId = overview?.batches.some(batch => batch.id === activeBatchId) ? activeBatchId : overview?.batches[0]?.id;
  const requestedId = page.items.find(item => item.id === (batchId ? cursors[batchId] : undefined))?.id
    ?? page.items.find(item => item.status === "pending")?.id ?? page.items[0]?.id;
  const targetKey = JSON.stringify([target.instanceId, target.reviewWorkspaceId, target.nodeId]);
  // Keep the visible item's last complete snapshot during a background refresh.
  // Navigation and target changes must never borrow another item's picture.
  const loaded = loadedDetail?.targetKey === targetKey && loadedDetail.snapshot.item.id === requestedId
    ? loadedDetail.snapshot : null;

  useEffect(() => {
    let cancelled = false;
    if (!requestedId || !overview) { setDetailLoading(false); return; }
    setDetailLoading(true);
    const load = async () => {
      const item = await reviewService.getItem(target, requestedId);
      if (item.node.revision !== overview.node.revision) { if (!cancelled) refresh(); return; }
      const ids = item.item.content.type === "image" || item.item.content.type === "video" ? [item.item.content.mediaId] : [];
      const repair = [...item.item.revisions].reverse().find(revision => revision.kind === "image-repair" && revision.mediaId && revision.producedVersion === item.item.version)?.mediaId;
      if (repair) ids.push(repair);
      const media = await reviewService.getResources(ids);
      if (!cancelled) { setLoadedDetail({ targetKey, snapshot: item }); setResources(media); setDetailLoading(false); }
    };
    void load().catch(problem => {
      if (!cancelled) {
        setError(`审阅内容未载入，尚未显示最新版本：${problem instanceof Error ? problem.message : String(problem)}`);
        setDetailLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [target, targetKey, requestedId, overview, refresh]);

  // Opening the handoff dialog explicitly requests its full publication preview.
  useEffect(() => {
    let cancelled = false;
    setExpanded(null);
    setHandoffs([]);
    if (!handoffOpen || !overview) { setPreviewLoading(false); return; }
    setPreviewLoading(true);
    void reviewService.getNode(target).then(snapshot => {
      if (cancelled) return;
      if (snapshot.node.revision !== overview.node.revision) { refresh(); return; }
      setExpanded(snapshot.state);
      setHandoffs(snapshot.state.handoffs);
      setPreviewLoading(false);
    }).catch(problem => {
      if (!cancelled) { setError(problem instanceof Error ? problem.message : String(problem)); setPreviewLoading(false); }
    });
    return () => { cancelled = true; };
  }, [target, handoffOpen, overview, refresh]);

  const state = useMemo<WorkbenchProjectState>(() => expanded ?? { ...EMPTY, batches: overview?.batches ?? [],
    items: [
      ...(loaded ? [loaded.item] : []),
      ...Array.from(extraLoaded.values())
        .filter((e) => e.node.revision === overview?.node.revision && e.item.id !== loaded?.item.id)
        .map((e) => e.item),
    ],
    feedback: [
      ...(loaded?.feedback ?? []),
      ...Array.from(extraLoaded.values())
        .filter((e) => e.node.revision === overview?.node.revision && e.item.id !== loaded?.item.id)
        .flatMap((e) => e.feedback),
    ],
    handoffs }, [overview, expanded, loaded, extraLoaded, handoffs]);
  const getWorkbench = useCallback(() => state, [state]);

  const runCommand = useMemo(() => {
    // Only this callback's own successful commits advance its local guard. An external commit never does.
    let ownRevision = overview?.node.revision;
    return async (name: keyof WorkbenchSlice, args: unknown[]): Promise<WorkbenchMutationOutcome> => {
      const expected = ownRevision;
      if (expected === undefined) return { ok: false, code: "CONFLICT", message: "审阅节点尚未载入" };
      if (loaded && loaded.node.revision !== expected) return { ok: false, code: "CONFLICT", message: "新版本内容尚未载入，请稍后重试" };
      try {
        const readScope = commandReadScope(name, args);
        const snapshot = await reviewService.getNode(target, readScope);
        if (snapshot.node.revision !== expected) throw reviewError("CONFLICT", "审阅节点已更新，请刷新后重试");
        const repairResource = name === "commitWorkbenchImageRepair" ? prepared.current.get(args[1] as string) : undefined;
        const commands = createWorkbenchCommands(() => snapshot.state, async (actions, label, actor) => {
          if (!actions.length) return { ok: true };
          const result = await reviewService.commit({ target, expectedNodeRevision: expected, requestId: crypto.randomUUID(), actor, label,
            request: { label, actions }, readScope, build: () => actions, resources: repairResource ? [repairResource] : [],
            buildSteps: actor === "human" && actions.some(action => action.type === "workbench/content.update")
              ? (before, after) => manualReviewSteps(target.nodeId!, before, after) : undefined });
          ownRevision = result.revision;
          if (repairResource) prepared.current.delete(repairResource.id);
          return { ok: true };
        });
        const command = commands[name] as (...args: unknown[]) => Promise<WorkbenchMutationOutcome>;
        return await command(...args);
      } catch (problem) { refresh(); return outcome(problem); }
    };
  }, [target, overview?.node.revision, loaded, refresh]);

  const commands = useMemo<WorkbenchSlice>(() => ({
    ingestWorkbenchBatch: (...args) => runCommand("ingestWorkbenchBatch", args),
    decideWorkbenchItems: (...args) => runCommand("decideWorkbenchItems", args),
    saveWorkbenchTextRevision: (...args) => runCommand("saveWorkbenchTextRevision", args),
    saveWorkbenchDataPatches: (...args) => runCommand("saveWorkbenchDataPatches", args),
    commitWorkbenchImageRepair: (...args) => runCommand("commitWorkbenchImageRepair", args),
    setWorkbenchAnnotations: (...args) => runCommand("setWorkbenchAnnotations", args),
    saveWorkbenchFeedback: (...args) => runCommand("saveWorkbenchFeedback", args),
    saveWorkbenchIssueFeedback: (...args) => runCommand("saveWorkbenchIssueFeedback", args),
    markWorkbenchDataRework: (...args) => runCommand("markWorkbenchDataRework", args),
    clearWorkbenchDataRework: (...args) => runCommand("clearWorkbenchDataRework", args),
    revertWorkbenchItems: (...args) => runCommand("revertWorkbenchItems", args),
    setWorkbenchUserTags: (...args) => runCommand("setWorkbenchUserTags", args),
    dismissWorkbenchDuplicate: (...args) => runCommand("dismissWorkbenchDuplicate", args),
    publishWorkbenchHandoff: (...args) => runCommand("publishWorkbenchHandoff", args),
    ackWorkbenchHandoff: (...args) => runCommand("ackWorkbenchHandoff", args),
    ingestWorkbenchRework: (...args) => runCommand("ingestWorkbenchRework", args),
  }), [runCommand]);
  const commandSource = useCallback(() => commands, [commands]);

  const history = useCallback(async (direction: "undo" | "redo"): Promise<WorkbenchMutationResult> => {
    if (!overview) return { ok: false, code: "CONFLICT", message: "审阅节点尚未载入" };
    try {
      await reviewService.history({ target, expectedNodeRevision: overview.node.revision, requestId: crypto.randomUUID(), actor: "human", direction });
      return { ok: true };
    } catch (problem) { refresh(); return outcome(problem); }
  }, [target, overview, refresh]);
  const undo = useCallback(() => history("undo"), [history]);
  const redo = useCallback(() => history("redo"), [history]);

  const importRepair = useCallback(async (file: File): Promise<WorkbenchMutationResult & { mediaId?: string }> => {
    try {
      const resourceId = crypto.randomUUID();
      const resource = await prepareReviewBlob(file, file.name, crypto.randomUUID(), resourceId);
      prepared.current.set(resourceId, resource);
      return { ok: true, mediaId: resourceId };
    } catch (problem) { return outcome(problem); }
  }, []);

  const mediaItems = useMemo(() => {
    const merged = new Map<string, FileResource>();
    for (const r of resources) merged.set(r.id, r);
    extraResources.forEach((r, id) => merged.set(id, r));
    return Array.from(merged.values()).map(mediaView);
  }, [resources, extraResources]);

  const ensureItemsLoaded = useCallback(async (itemIds: readonly string[]): Promise<void> => {
    if (!overview) return;
    const rev = overview.node.revision;
    const missing = itemIds.filter(
      (id) =>
        id &&
        !(loaded?.item.id === id && loaded.node.revision === rev) &&
        !(extraLoaded.get(id)?.node.revision === rev),
    );
    if (missing.length === 0) return;
    const fetched = await Promise.all(
      missing.map((id) => reviewService.getItem(target, id).catch(() => null)),
    );
    const valid = fetched.filter((entry): entry is LoadedItem => entry !== null && entry.node.revision === rev);
    if (extraLoadScopeRef.current !== extraLoadScope || valid.length === 0) return;
    const mediaIds = new Set<string>();
    for (const entry of valid) {
      if (entry.item.content.type === "image" || entry.item.content.type === "video") {
        mediaIds.add(entry.item.content.mediaId);
      }
      const repair = [...entry.item.revisions].reverse().find((r) => r.kind === "image-repair" && r.mediaId && r.producedVersion === entry.item.version)?.mediaId;
      if (repair) mediaIds.add(repair);
    }
    const mediaList = mediaIds.size > 0 ? await reviewService.getResources(Array.from(mediaIds)) : [];
    const native = window.reelterminal?.reviewFiles;
    if (native) {
      await Promise.all(
        mediaList
          .filter((r) => r.storage.kind !== "unavailable")
          .map((r) => native.resolve(r.id).catch(() => null)),
      );
    }
    if (extraLoadScopeRef.current !== extraLoadScope) return;
    setExtraLoaded((prev) => {
      const next = new Map(prev);
      for (const entry of valid) next.set(entry.item.id, entry);
      return next;
    });
    if (mediaList.length > 0) {
      setExtraResources((prev) => {
        const next = new Map(prev);
        for (const r of mediaList) next.set(r.id, r);
        return next;
      });
    }
  }, [overview, loaded, extraLoaded, target, extraLoadScope]);
  const summaries = useMemo(() => expanded ? undefined : page.items.map(summaryView), [expanded, page.items]);
  const batchViews = useMemo(() => overview?.batches.map(batch => ({ ...batch,
    isNew: (batch.incomingRevision ?? 0) > (seen[reviewSeenKey(target.nodeId!, "batch", batch.id)] ?? 0),
    totalCount: overview.counts[batch.id]?.total ?? 0, pendingCount: overview.counts[batch.id]?.pending ?? 0,
  })).sort((a, b) => (b.contentUpdatedAt ?? b.createdAt) - (a.contentUpdatedAt ?? a.createdAt)) ?? [], [overview, seen, target.nodeId]);
  const controller = useWorkbenchControllerSource({ scopeId: `review:${target.nodeId}`, workbench: state, mediaItems, getWorkbench,
    commands: commandSource, openMedia: openReviewMedia, importRepair, undo, redo, canUndo: overview?.canUndo ?? false, canRedo: overview?.canRedo ?? false, summaries, batchViews, managesBatchSelection: true });

  const readBatch = (id: string) => {
    const batch = overview?.batches.find(batch => batch.id === id);
    if (batch?.incomingRevision) markSeen(reviewSeenKey(target.nodeId!, "batch", id), batch.incomingRevision);
  };
  const readItem = (id: string) => {
    const item = page.items.find(item => item.id === id) ?? expanded?.items.find(item => item.id === id);
    if (item?.incomingRevision) markSeen(reviewSeenKey(target.nodeId!, "item", id), item.incomingRevision);
  };
  // Only navigation acknowledges updates; background arrivals must keep their NEW badge.
  useEffect(() => { if (activeBatchId) readBatch(activeBatchId); }, [activeBatchId, overview?.node.id]);
  useEffect(() => { if (controller.currentItem) readItem(controller.currentItem.id); }, [controller.currentItem?.id]);
  useEffect(() => {
    if (overview && !batchViews.some(batch => batch.isNew)) markSeen(reviewSeenKey(target.nodeId!, "node"), overview.node.incomingRevision ?? 0);
  }, [overview, batchViews, target.nodeId, markSeen]);
  const withUnread = (item: WorkbenchItemView): WorkbenchItemView => {
    const incoming = page.items.find(row => row.id === item.id)?.incomingRevision ?? expanded?.items.find(row => row.id === item.id)?.incomingRevision ?? 0;
    return { ...item, isNew: incoming > (seen[reviewSeenKey(target.nodeId!, "item", item.id)] ?? 0) };
  };

  const commitBranchNod = useCallback(async (items: readonly WorkbenchItemView[]): Promise<WorkbenchMutationResult> => {
    try {
      const snapshot = await reviewService.getNode(target);
      if (snapshot.node.revision !== overview?.node.revision) throw reviewError("CONFLICT", "审阅节点已更新，请刷新后重试");
      const views = items.map(view => {
        const item = snapshot.state.items.find(item => item.id === view.id);
        if (!item) throw reviewError("NOT_FOUND", "所选条目不属于此节点");
        return toItemView(item, id => mediaItems.find(media => media.id === id), snapshot.state.feedback.filter(feedback => feedback.itemId === item.id), null, null);
      });
      return await controller.commitBranchNod(views);
    } catch (problem) { refresh(); return outcome(problem); }
  }, [target, overview?.node.revision, mediaItems, controller, refresh]);

  return { controller: { ...controller, ensureItemsLoaded, commitBranchNod,
    batchItems: controller.batchItems.map(withUnread), visibleItems: controller.visibleItems.map(withUnread),
    setActiveBatchId: (id: string) => { readBatch(id); controller.setActiveBatchId(id); },
    selectItem: (id: string, modifiers?: import("./types").SelectModifiers) => { readItem(id); controller.selectItem(id, modifiers); },
    focusItem: (id: string) => { readItem(id); controller.focusItem(id); },
    saveModelObservation: async (input: import("../../services/review-workspace/model-feedback").SaveModelObservation): Promise<WorkbenchMutationResult> => {
    try { if (!overview) throw reviewError("CONFLICT", "节点未载入"); await saveModelObservation(target, overview.node.revision, input); return { ok: true }; }
    catch (problem) { refresh(); return outcome(problem); }
  } }, overview, loading: loading || detailLoading || previewLoading, error, refresh, pageNumber: previousCursors.length + 1,
    hasPrevious: previousCursors.length > 0, hasNext: !!page.cursor,
    nextPage: () => { if (page.cursor) useWorkbenchUiStore.getState().setReviewPage(page.cursor, [...previousCursors, pageCursor]); },
    previousPage: () => { useWorkbenchUiStore.getState().setReviewPage(previousCursors.at(-1), previousCursors.slice(0, -1)); },
  };
}
