import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileImage,
  Film,
  Image as ImageIcon,
  MessageSquare,
  Minus,
  Plus,
  RotateCcw,
  Search,
  Undo2,
  X,
  ZoomIn,
} from "lucide-react";
import type { TaskDecisionStatus, TaskReviewSnapshot, TaskUnitTarget } from "../../../../../desktop/src/shared/task-review";
import { isCurrentTaskUnit, isTextTaskUnit } from "../../../../../desktop/src/shared/task-review";
import type { TaskMediaTarget, TaskMediaUnit } from "../../../../../desktop/src/shared/task-review-media";
import { wbButton } from "../wb-button";
import { sourceTitle, statusLabels } from "./display";
import { REVIEW_PURPOSE, unitDecisionState } from "./queries";
import type { MutationResult } from "./useTaskReviewController";
import { useSceneScroll, viewKey } from "./view-state";

export const MEDIA_DECISION_BATCH_LIMIT = 1000;
const THUMBNAIL_CONCURRENCY = 4;

export interface MediaThumbnailResult {
  url: string;
  width: number;
  height: number;
}

export interface MediaDecisionBatchInput {
  targets: TaskUnitTarget[];
  purpose: string;
  status: TaskDecisionStatus;
  note: string;
  pendingOnly?: boolean;
}

export interface MediaOverviewOperations {
  thumbnailMedia(target: TaskMediaTarget): Promise<MediaThumbnailResult>;
  decideBatch(input: MediaDecisionBatchInput): Promise<MutationResult & { batchId?: string }>;
  undoDecisionBatch(batchId: string): Promise<MutationResult>;
  redoDecisionBatch(batchId: string): Promise<MutationResult>;
}

export interface MediaOverviewToolRequest {
  sequence: number;
  action: "inspect";
  unitId?: string;
}

interface MediaRow {
  unit: TaskMediaUnit;
  displayOrdinal: number;
  sourceName: string;
  sourcePath: string;
  status: TaskDecisionStatus | null;
  needsRecheck: boolean;
  note: string;
}

type ThumbnailState = {
  status: "queued" | "loading" | "loaded" | "ready" | "error";
  url?: string;
  width?: number;
  height?: number;
  error?: string;
};

type Filter = "all" | "pending" | TaskDecisionStatus;

export function isImageDominantTask(snapshot: TaskReviewSnapshot): boolean {
  let images = 0;
  let text = 0;
  for (const unit of snapshot.units) {
    if (!isCurrentTaskUnit(snapshot, unit)) continue;
    if (isTextTaskUnit(unit)) text++;
    else if (unit.kind !== "video") images++;
  }
  return images > 0 && images >= text;
}

const mediaFilenameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function mediaRows(snapshot: TaskReviewSnapshot): MediaRow[] {
  return snapshot.units
    .filter((unit): unit is TaskMediaUnit => !isTextTaskUnit(unit) && isCurrentTaskUnit(snapshot, unit))
    .map((unit) => {
      const decision = unitDecisionState(snapshot, unit.id, REVIEW_PURPOSE);
      const source = snapshot.sources.find((item) => item.id === unit.sourceVersionId);
      return {
        unit,
        sourceName: sourceTitle(source?.relativePath ?? unit.id),
        sourcePath: source?.relativePath ?? unit.id,
        status: decision.status,
        needsRecheck: decision.needsRecheck,
        note: decision.note ?? "",
      };
    })
    .sort((a, b) => mediaFilenameCollator.compare(a.sourceName, b.sourceName)
      || mediaFilenameCollator.compare(a.sourcePath, b.sourcePath)
      || a.sourceName.localeCompare(b.sourceName)
      || a.sourcePath.localeCompare(b.sourcePath)
      || a.unit.ordinal - b.unit.ordinal
      || a.unit.id.localeCompare(b.unit.id))
    .map((row, index) => ({ ...row, displayOrdinal: index + 1 }));
}

function recentNotesStorageKey(root: string, taskId: string): string {
  return `task-review-recent-notes:${JSON.stringify([root, taskId])}`;
}

function storedRecentNotes(root: string, taskId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(recentNotesStorageKey(root, taskId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 8);
  } catch {
    return [];
  }
}

function rememberRecentNote(root: string, taskId: string, note: string): void {
  const text = note.trim();
  if (!text) return;
  const next = [text, ...storedRecentNotes(root, taskId).filter((item) => item !== text)].slice(0, 8);
  try { localStorage.setItem(recentNotesStorageKey(root, taskId), JSON.stringify(next)); } catch { /* A full/disabled store must not block decisions. */ }
}

/**
 * Read-only, visible-thumbnail loader. IntersectionObserver is the only
 * automatic entry point; inspector opens and explicit retries are the others.
 * At most four bridge calls are in flight, including while a large grid scrolls.
 */
function useMediaThumbnails(snapshot: TaskReviewSnapshot, rows: MediaRow[], operations: MediaOverviewOperations) {
  const [cache, setCache] = useState<Record<string, ThumbnailState>>({});
  const cacheRef = useRef<Record<string, ThumbnailState>>({});
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const operationsRef = useRef(operations);
  operationsRef.current = operations;
  const nodes = useRef(new Map<string, HTMLElement>());
  const observer = useRef<IntersectionObserver | null>(null);
  const queue = useRef<string[]>([]);
  const started = useRef(new Set<string>());
  const active = useRef(0);
  const generation = useRef(0);
  const scope = `${snapshot.root}\n${snapshot.taskId}`;
  const scopeRef = useRef(scope);

  const update = useCallback((unitId: string, value: ThumbnailState | undefined) => {
    const next = { ...cacheRef.current };
    if (value) next[unitId] = value;
    else delete next[unitId];
    cacheRef.current = next;
    setCache(next);
  }, []);

  const pump = useCallback(() => {
    const requestGeneration = generation.current;
    while (active.current < THUMBNAIL_CONCURRENCY && queue.current.length) {
      const unitId = queue.current.shift()!;
      const row = rowsRef.current.find((item) => item.unit.id === unitId);
      if (!row || row.unit.kind === "video") { started.current.delete(unitId); continue; }
      active.current++;
      update(unitId, { status: "loading" });
      void operationsRef.current.thumbnailMedia({
        root: snapshot.root,
        taskId: snapshot.taskId,
        sourceVersionId: row.unit.sourceVersionId,
        unitId: row.unit.id,
      }).then((result) => {
        if (generation.current !== requestGeneration) return;
        if (!result.url || !(result.width > 0) || !(result.height > 0)) throw new Error("Invalid thumbnail response");
        update(unitId, { status: "loaded", url: result.url, width: result.width, height: result.height });
      }).catch((problem: unknown) => {
        if (generation.current !== requestGeneration) return;
        started.current.delete(unitId);
        update(unitId, { status: "error", error: problem instanceof Error ? problem.message : String(problem) });
      }).finally(() => {
        if (generation.current !== requestGeneration) return;
        active.current--;
        pump();
      });
    }
  }, [snapshot.root, snapshot.taskId, update]);

  const ensure = useCallback((unitId: string, force = false) => {
    const row = rowsRef.current.find((item) => item.unit.id === unitId);
    if (!row || row.unit.kind === "video") return;
    const current = cacheRef.current[unitId];
    if (!force && (started.current.has(unitId) || current?.status === "loaded" || current?.status === "ready")) return;
    if (force) {
      queue.current = queue.current.filter((id) => id !== unitId);
      started.current.delete(unitId);
    }
    if (started.current.has(unitId)) return;
    started.current.add(unitId);
    queue.current.push(unitId);
    update(unitId, { status: "queued" });
    pump();
  }, [pump, update]);

  useEffect(() => {
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    generation.current++;
    active.current = 0;
    queue.current = [];
    started.current.clear();
    cacheRef.current = {};
    setCache({});
  }, [scope]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    observer.current = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const unitId = (entry.target as HTMLElement).dataset.mediaUnitId;
        if (unitId) ensure(unitId);
        observer.current?.unobserve(entry.target);
      }
    }, { rootMargin: "120px", threshold: 0.01 });
    for (const element of nodes.current.values()) observer.current.observe(element);
    return () => { observer.current?.disconnect(); observer.current = null; };
  }, [ensure]);

  useEffect(() => () => { generation.current++; observer.current?.disconnect(); }, []);

  const observe = useCallback((unitId: string, element: HTMLElement | null) => {
    const previous = nodes.current.get(unitId);
    if (previous) observer.current?.unobserve(previous);
    if (!element) { nodes.current.delete(unitId); return; }
    nodes.current.set(unitId, element);
    observer.current?.observe(element);
  }, []);

  const markReady = useCallback((unitId: string, url: string) => {
    const current = cacheRef.current[unitId];
    if (current?.url === url) update(unitId, { ...current, status: "ready", error: undefined });
  }, [update]);

  const markError = useCallback((unitId: string, message: string) => {
    const current = cacheRef.current[unitId];
    started.current.delete(unitId);
    update(unitId, { ...current, status: "error", error: message });
  }, [update]);

  return { cache, ensure, observe, markReady, markError };
}

function NoteInput({ id, value, recentNotes, disabled, onChange, onReuse, compact = false }: {
  id: string;
  value: string;
  recentNotes: string[];
  disabled: boolean;
  onChange: (value: string) => void;
  onReuse: (note: string) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <label htmlFor={id} className="font-medium text-fg-2">{t("Review note")}</label>
        <button
          type="button"
          className={wbButton.ghost}
          disabled={disabled || !recentNotes.length}
          data-testid={`${id}-reuse-last`}
          title={t("Only fills the note draft; it never submits a decision")}
          onClick={() => recentNotes[0] && onReuse(recentNotes[0])}
        >
          <MessageSquare className="h-3.5 w-3.5" />{t("Reuse last note")}
        </button>
        {recentNotes.length > 0 && (
          <details className="relative">
            <summary className="cursor-pointer rounded px-2 py-1 text-fg-3 hover:bg-bg-2 hover:text-fg" data-testid={`${id}-recent-menu`}>{t("Recent notes")}</summary>
            <div className="absolute left-0 top-7 z-30 flex max-h-48 w-72 flex-col gap-1 overflow-y-auto rounded border border-border bg-bg-1 p-1.5 shadow-xl">
              {recentNotes.map((note, index) => (
                <button key={`${index}:${note}`} type="button" className="rounded px-2 py-1.5 text-left text-fg-2 hover:bg-bg-2" onClick={() => onReuse(note)}>
                  <span className="line-clamp-2">{note}</span>
                </button>
              ))}
            </div>
          </details>
        )}
      </div>
      <textarea
        id={id}
        aria-label={t("Review note")}
        className={`w-full resize-y rounded border border-border bg-bg-2 p-2 leading-relaxed text-fg ${compact ? "min-h-14" : "min-h-20"}`}
        placeholder={t("Describe what must change. Reusing a note does not make a decision.")}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        data-testid={id}
      />
    </div>
  );
}

export function MediaOverview({ snapshot, busy, operations, onOpenUnit, onOpenExport, onOpenTextOverview, toolRequest, renderToolCard, onSelectionIntent }: {
  snapshot: TaskReviewSnapshot;
  busy: boolean;
  operations: MediaOverviewOperations;
  onOpenUnit: (unitId: string) => void;
  onOpenExport: () => void;
  onOpenTextOverview: () => void;
  toolRequest?: MediaOverviewToolRequest | null;
  renderToolCard: (toolBody: ReactNode) => ReactNode;
  onSelectionIntent?: () => void;
}) {
  const { t } = useTranslation();
  const rows = useMemo(() => mediaRows(snapshot), [snapshot]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const rangeAnchor = useRef<string | null>(null);
  const [inspectorId, setInspectorId] = useState<string | null>(null);
  const inspectorIntent = useRef(0);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [batchNote, setBatchNote] = useState("");
  const [batchNoteOpen, setBatchNoteOpen] = useState(false);
  const [inspectorNoteOpen, setInspectorNoteOpen] = useState(false);
  const [reuseNotice, setReuseNotice] = useState(false);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [keepConfirmation, setKeepConfirmation] = useState<{ targets: TaskUnitTarget[]; count: number } | null>(null);
  const [receipt, setReceipt] = useState<{ batchId: string; count: number; status: TaskDecisionStatus; phase: "applied" | "undone" } | null>(null);
  const [recentRevision, setRecentRevision] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null);
  const [transparentBackground, setTransparentBackground] = useState<"checker" | "solid">("checker");
  const scroll = useSceneScroll<HTMLDivElement>(`${viewKey(snapshot.root, snapshot.taskId)}:media-overview`);
  const thumbnails = useMediaThumbnails(snapshot, rows, operations);

  const counts = useMemo(() => ({
    all: rows.length,
    pending: rows.filter((row) => !row.status).length,
    kept: rows.filter((row) => row.status === "kept").length,
    rework: rows.filter((row) => row.status === "rework").length,
    discarded: rows.filter((row) => row.status === "discarded").length,
  }), [rows]);

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return rows.filter((row) => {
      if (filter === "pending" ? row.status !== null : filter !== "all" && row.status !== filter) return false;
      return !needle || row.sourceName.toLocaleLowerCase().includes(needle) || `#${row.displayOrdinal}`.includes(needle);
    });
  }, [rows, filter, query]);

  const recentNotes = useMemo(() => {
    const fromDecisions = [...snapshot.decisions]
      .filter((decision) => decision.purpose === REVIEW_PURPOSE && decision.note.trim())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((decision) => decision.note.trim());
    return [...new Set([...storedRecentNotes(snapshot.root, snapshot.taskId), ...fromDecisions])].slice(0, 8);
  }, [snapshot.root, snapshot.taskId, snapshot.decisions, recentRevision]);

  const selectedTargets = useMemo(() => rows.flatMap((row) => selected.has(row.unit.id)
    ? [{ unitId: row.unit.id, sourceVersionId: row.unit.sourceVersionId }]
    : []), [rows, selected]);
  const pendingTargets = useMemo(() => rows.flatMap((row) => !row.status && row.unit.kind !== "video"
    ? [{ unitId: row.unit.id, sourceVersionId: row.unit.sourceVersionId }]
    : []), [rows]);
  const inspector = rows.find((row) => row.unit.id === inspectorId) ?? null;
  const inspectorThumbnail = inspector ? thumbnails.cache[inspector.unit.id] : undefined;
  const inspectorNote = inspector ? notes[inspector.unit.id] ?? inspector.note : "";
  const interactionBusy = busy || saving;

  const remember = useCallback((note: string) => {
    if (!note.trim()) return;
    rememberRecentNote(snapshot.root, snapshot.taskId, note);
    setRecentRevision((value) => value + 1);
  }, [snapshot.root, snapshot.taskId]);

  const runDecision = useCallback(async (targets: TaskUnitTarget[], status: TaskDecisionStatus, note: string, pendingOnly = false): Promise<boolean> => {
    if (!targets.length || inFlight.current) return false;
    if (targets.length > MEDIA_DECISION_BATCH_LIMIT) {
      setActionError(t("This batch has {{count}} items; the atomic limit is {{limit}}. Narrow the explicit selection instead of splitting it silently.", { count: targets.length, limit: MEDIA_DECISION_BATCH_LIMIT }));
      return false;
    }
    inFlight.current = true;
    setSaving(true);
    setActionError(null);
    try {
      const result = await operations.decideBatch({ targets, purpose: REVIEW_PURPOSE, status, note, pendingOnly });
      if (!result.ok) { setActionError(result.error); return false; }
      if (result.batchId) setReceipt({ batchId: result.batchId, count: targets.length, status, phase: "applied" });
      const decided = new Set(targets.map((target) => target.unitId));
      setSelected((current) => new Set([...current].filter((unitId) => !decided.has(unitId))));
      setBatchNote("");
      setBatchNoteOpen(false);
      setInspectorNoteOpen(false);
      setReuseNotice(false);
      remember(note);
      return true;
    } catch (problem) {
      setActionError(problem instanceof Error ? problem.message : String(problem));
      return false;
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }, [operations, remember, t]);

  const openInspector = useCallback((unitId: string) => {
    inspectorIntent.current++;
    setInspectorId(unitId);
    setZoom(null);
    setInspectorNoteOpen(false);
    setReuseNotice(false);
    thumbnails.ensure(unitId);
  }, [thumbnails.ensure]);

  const closeInspector = useCallback(() => {
    inspectorIntent.current++;
    setInspectorId(null);
  }, []);

  const reuseNote = useCallback((note: string) => {
    if (inspectorId) setNotes((current) => ({ ...current, [inspectorId]: note }));
    else setBatchNote(note);
    setReuseNotice(true);
    setActionError(null);
  }, [inspectorId]);

  const handledToolRequest = useRef(0);
  useEffect(() => {
    if (!toolRequest || handledToolRequest.current === toolRequest.sequence) return;
    handledToolRequest.current = toolRequest.sequence;
    const preferred = rows.find((row) => row.unit.id === toolRequest.unitId && row.unit.kind !== "video")
      ?? rows.find((row) => !row.status && row.unit.kind !== "video")
      ?? rows.find((row) => row.unit.kind !== "video");
    if (preferred) openInspector(preferred.unit.id);
  }, [toolRequest, rows, openInspector]);

  useEffect(() => {
    if (!inspectorId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeInspector();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [inspectorId, closeInspector]);

  const toggleSelected = (unitId: string, checked: boolean, shiftKey: boolean) => {
    onSelectionIntent?.();
    setKeepConfirmation(null);
    setSelected((current) => {
      const next = new Set(current);
      if (shiftKey && rangeAnchor.current) {
        const start = visibleRows.findIndex((row) => row.unit.id === rangeAnchor.current);
        const end = visibleRows.findIndex((row) => row.unit.id === unitId);
        if (start >= 0 && end >= 0) {
          for (const row of visibleRows.slice(Math.min(start, end), Math.max(start, end) + 1)) {
            if (checked) next.add(row.unit.id);
            else next.delete(row.unit.id);
          }
          return next;
        }
      }
      if (checked) next.add(unitId);
      else next.delete(unitId);
      return next;
    });
    if (!shiftKey) rangeAnchor.current = unitId;
  };

  useEffect(() => {
    if (selected.size) return;
    setBatchNote("");
    setBatchNoteOpen(false);
    setReuseNotice(false);
  }, [selected.size]);

  const openPreferredInspector = () => {
    const preferred = rows.find((row) => !row.status && row.unit.kind !== "video")
      ?? rows.find((row) => row.unit.kind !== "video");
    if (preferred) openInspector(preferred.unit.id);
  };

  const decideInspectorAndNext = async (status: TaskDecisionStatus) => {
    if (!inspector || inspector.unit.kind === "video" || inspectorThumbnail?.status !== "ready") return;
    const index = rows.findIndex((row) => row.unit.id === inspector.unit.id);
    const next = rows.slice(index + 1).find((row) => !row.status && row.unit.kind !== "video");
    const intent = inspectorIntent.current;
    const saved = await runDecision([{ unitId: inspector.unit.id, sourceVersionId: inspector.unit.sourceVersionId }], status, status === "rework" ? inspectorNote : "");
    if (!saved || intent !== inspectorIntent.current) return;
    if (next) openInspector(next.unit.id);
    else closeInspector();
  };

  const moveInspector = (direction: -1 | 1) => {
    if (!inspector) return;
    const inspectable = rows.filter((row) => row.unit.kind !== "video");
    const index = inspectable.findIndex((row) => row.unit.id === inspector.unit.id);
    const next = inspectable[index + direction];
    if (next) openInspector(next.unit.id);
  };

  const changeBatchReceipt = async (direction: "undo" | "redo") => {
    if (!receipt || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setActionError(null);
    try {
      const result = await (direction === "undo" ? operations.undoDecisionBatch : operations.redoDecisionBatch)(receipt.batchId);
      if (!result.ok) { setActionError(result.error); return; }
      setReceipt((current) => current ? { ...current, phase: direction === "undo" ? "undone" : "applied" } : null);
    } catch (problem) {
      setActionError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  const inspectorIndex = inspector ? rows.filter((row) => row.unit.kind !== "video").findIndex((row) => row.unit.id === inspector.unit.id) : -1;
  const inspectableCount = rows.filter((row) => row.unit.kind !== "video").length;

  const toolBody = (
    <div className="flex flex-col gap-2.5" data-testid="task-review-media-context-tools">
      {selectedTargets.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="task-review-media-selection-tools">
          <strong className="text-fg-2" data-testid="task-review-media-card-selection-count">{t("{{count}} selected", { count: selectedTargets.length })}</strong>
          <div className="grid grid-cols-3 gap-1.5">
            {(["kept", "rework", "discarded"] as TaskDecisionStatus[]).map((status) => (
              <button
                key={status}
                type="button"
                className={status === "kept" ? wbButton.primary : wbButton.secondary}
                disabled={interactionBusy}
                aria-expanded={status === "rework" ? batchNoteOpen : undefined}
                data-testid={`task-review-media-batch-${status}`}
                onClick={() => {
                  if (status === "rework") {
                    setBatchNoteOpen(true);
                    setReuseNotice(false);
                  } else {
                    void runDecision(selectedTargets, status, "");
                  }
                }}
              >{t(statusLabels[status])}</button>
            ))}
          </div>
          {batchNoteOpen && (
            <div className="flex flex-col gap-2 rounded-lg bg-[#101216] p-2" data-testid="task-review-media-rework-editor">
              <NoteInput
                id="task-review-media-batch-note"
                value={batchNote}
                recentNotes={recentNotes}
                disabled={interactionBusy}
                compact
                onChange={(value) => { setBatchNote(value); setReuseNotice(false); }}
                onReuse={reuseNote}
              />
              {reuseNotice && !inspectorId && <span className="text-[11px] text-fg-3" role="status">{t("Note copied into the draft only. Choose a decision explicitly.")}</span>}
              <div className="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  className={wbButton.ghost}
                  data-testid="task-review-media-cancel-rework"
                  onClick={() => { setBatchNoteOpen(false); setBatchNote(""); setReuseNotice(false); }}
                >{t("Cancel")}</button>
                <button
                  type="button"
                  className={wbButton.primary}
                  disabled={interactionBusy}
                  data-testid="task-review-media-confirm-rework"
                  onClick={() => void runDecision(selectedTargets, "rework", batchNote)}
                >{t("Confirm rework ({{count}})", { count: selectedTargets.length })}</button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1.5" data-testid="task-review-media-default-tools">
          <button type="button" className={wbButton.secondary} disabled={!inspectableCount} onClick={openPreferredInspector} data-testid="task-review-media-open-inspector"><ZoomIn className="h-3.5 w-3.5" />{t("Magnifier")}</button>
          <button
            type="button"
            className={wbButton.secondary}
            disabled={!pendingTargets.length || interactionBusy}
            data-testid="task-review-media-keep-remaining"
            onClick={() => setKeepConfirmation({ targets: pendingTargets, count: pendingTargets.length })}
          >{t("Keep remaining pending ({{count}})", { count: pendingTargets.length })}</button>
          <button type="button" className={wbButton.secondary} onClick={onOpenExport} data-testid="task-review-media-open-export"><Download className="h-3.5 w-3.5" />{t("Export")}</button>
          <button type="button" className={wbButton.ghost} onClick={onOpenTextOverview} data-testid="task-review-media-open-text-overview">{t("Task settings and text review")}</button>
        </div>
      )}

      {keepConfirmation && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-300/50 bg-amber-300/5 p-2" role="alert" data-testid="task-review-media-keep-confirmation">
          <span>{t("Keep exactly {{count}} currently pending images? Already decided items are excluded. This atomic batch can be undone.", { count: keepConfirmation.count })}</span>
          <div className="flex justify-end gap-1.5">
            <button type="button" className={wbButton.ghost} disabled={interactionBusy} onClick={() => setKeepConfirmation(null)}>{t("Cancel")}</button>
            <button type="button" className={wbButton.primary} disabled={interactionBusy} data-testid="task-review-media-confirm-keep-remaining" onClick={() => {
              const confirmation = keepConfirmation;
              setKeepConfirmation(null);
              void runDecision(confirmation.targets, "kept", "", true);
            }}>{t("Confirm keep {{count}} pending", { count: keepConfirmation.count })}</button>
          </div>
        </div>
      )}

      {actionError && (
        <div className="flex items-center gap-2 rounded-lg border border-status-error/60 bg-status-error/5 p-2 text-status-error" role="alert" data-testid="task-review-media-action-error">
          <span className="min-w-0 flex-1">{actionError}</span>
          <button type="button" className={wbButton.ghost} onClick={() => setActionError(null)} aria-label={t("Dismiss error")}><X className="h-4 w-4" /></button>
        </div>
      )}

      {receipt && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-[#101216] p-2 text-fg" role="status" data-testid="task-review-media-batch-receipt">
          <span className="min-w-0 flex-1">{receipt.phase === "undone" ? t("Batch undone ({{count}} items)", { count: receipt.count }) : t("{{count}} items marked {{status}}", { count: receipt.count, status: t(statusLabels[receipt.status]) })}</span>
          <button type="button" className={wbButton.secondary} disabled={interactionBusy} data-testid={receipt.phase === "applied" ? "task-review-media-undo-batch" : "task-review-media-redo-batch"} onClick={() => void changeBatchReceipt(receipt.phase === "applied" ? "undo" : "redo")}>
            {receipt.phase === "applied" ? <Undo2 className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
            {receipt.phase === "applied" ? t("Undo batch") : t("Redo batch")}
          </button>
          <button type="button" className={wbButton.ghost} onClick={() => setReceipt(null)} aria-label={t("Dismiss batch status")}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <div {...scroll} className="min-h-0 min-w-0 flex-1 self-stretch overflow-y-auto text-xs" data-testid="task-review-media-overview">
        <section className="sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b border-border bg-bg px-1 py-1" aria-label={t("Image filters and selection")}>
          {(["all", "pending", "kept", "rework", "discarded"] as Filter[]).map((value) => (
            <button
              key={value}
              type="button"
              className={`${wbButton.segmentedItem(filter === value)} h-6 px-2`}
              aria-pressed={filter === value}
              data-testid={`task-review-media-filter-${value}`}
              onClick={() => setFilter(value)}
            >
              {value === "all" ? t("All") : value === "pending" ? t("Pending") : t(statusLabels[value])} · {counts[value]}
            </button>
          ))}
          <input
            type="checkbox"
            className="ml-1"
            aria-label={t("Select all filtered ({{count}})", { count: visibleRows.length })}
            title={t("Select all filtered ({{count}})", { count: visibleRows.length })}
            checked={visibleRows.length > 0 && visibleRows.every((row) => selected.has(row.unit.id))}
            disabled={!visibleRows.length || interactionBusy}
            data-testid="task-review-media-select-filtered"
            onChange={(event) => {
              onSelectionIntent?.();
              setKeepConfirmation(null);
              if (event.target.checked) {
                setSelected(new Set(visibleRows.map((row) => row.unit.id)));
                rangeAnchor.current = visibleRows.at(-1)?.unit.id ?? null;
              } else {
                setSelected(new Set());
                rangeAnchor.current = null;
              }
            }}
          />
          <span className="shrink-0 text-fg-3" data-testid="task-review-media-selection-count">{t("{{count}} selected", { count: selectedTargets.length })}</span>
          <label className="flex h-6 min-w-36 max-w-56 flex-1 items-center gap-1.5 rounded border border-border bg-bg-2 px-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-fg-3" />
            <input
              className="min-w-0 flex-1 bg-transparent outline-none"
              aria-label={t("Search image filenames")}
              placeholder={t("Search filename or #number")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </section>

        <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-1.5 p-1.5" data-testid="task-review-media-grid">
          {visibleRows.map((row) => {
            const thumbnail = thumbnails.cache[row.unit.id];
            const status = row.status ?? "pending";
            const border = row.status === "kept" ? "border-emerald-300/70" : row.status === "rework" ? "border-amber-200/70" : row.status === "discarded" ? "border-zinc-500/70" : "border-white/45";
            return (
              <li key={row.unit.id} className={`min-w-0 overflow-hidden rounded-md border bg-bg-1 ${border}`} data-testid="task-review-media-card" data-unit-id={row.unit.id} data-status={status}>
                <div className="flex items-center gap-1.5 border-b border-border/60 px-1.5 py-1">
                  <input
                    type="checkbox"
                    aria-label={t("Select image {{name}}", { name: row.sourceName })}
                    checked={selected.has(row.unit.id)}
                    disabled={interactionBusy}
                    onChange={(event) => toggleSelected(row.unit.id, event.target.checked, Boolean((event.nativeEvent as MouseEvent).shiftKey))}
                  />
                  <span className="font-mono text-fg-3">#{row.displayOrdinal}</span>
                  <span className="min-w-0 flex-1 truncate font-medium" title={row.sourceName}>{row.sourceName}</span>
                </div>
                <div ref={(element) => thumbnails.observe(row.unit.id, element)} data-media-unit-id={row.unit.id} className="group relative aspect-[4/3] bg-bg-2" data-testid="task-review-media-thumbnail">
                  <button type="button" className="flex h-full w-full items-center justify-center overflow-hidden" onClick={() => row.unit.kind === "video" ? onOpenUnit(row.unit.id) : openInspector(row.unit.id)} aria-label={t("Inspect {{name}}", { name: row.sourceName })} data-testid="task-review-media-inspect">
                    {row.unit.kind === "video" ? <Film className="h-10 w-10 text-fg-3" /> : thumbnail?.url && thumbnail.status !== "error" ? (
                      <img
                        src={thumbnail.url}
                        alt={row.sourceName}
                        className="h-full w-full object-contain"
                        draggable={false}
                        onLoad={() => thumbnails.markReady(row.unit.id, thumbnail.url!)}
                        onError={() => thumbnails.markError(row.unit.id, t("Image failed to load"))}
                      />
                    ) : thumbnail?.status === "error" ? <FileImage className="h-9 w-9 text-status-error" /> : <ImageIcon className="h-9 w-9 animate-pulse text-fg-3" />}
                  </button>
                  <span className="pointer-events-none absolute right-1.5 top-1.5 rounded bg-bg-1/90 p-1 text-fg-2 opacity-0 shadow transition-opacity group-focus-within:opacity-100 group-hover:opacity-100" aria-hidden="true"><ZoomIn className="h-3.5 w-3.5" /></span>
                  {row.unit.kind !== "video" && thumbnail?.status !== "ready" && <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-bg-1/90 px-1.5 py-0.5 text-[10px] text-fg-3">{thumbnail?.status === "error" ? t("Image not ready") : t("Loading image…")}</span>}
                </div>
                <div className="flex items-center gap-1.5 px-1.5 py-1">
                  <span className={row.status === "kept" ? "text-emerald-300" : row.status === "rework" ? "text-amber-200" : row.status === "discarded" ? "text-zinc-400" : "text-fg"}>
                    {row.status ? t(statusLabels[row.status]) : row.needsRecheck ? t("Needs recheck") : t("Pending")}
                  </span>
                  {thumbnail?.status === "error" && row.unit.kind !== "video" && <button type="button" className="ml-auto text-accent hover:underline" onClick={() => thumbnails.ensure(row.unit.id, true)}>{t("Retry")}</button>}
                </div>
              </li>
            );
          })}
          {!visibleRows.length && <li className="col-span-full rounded border border-border p-8 text-center text-fg-3">{t("No matching media items")}</li>}
        </ul>
      </div>

      {renderToolCard(toolBody)}

      {inspector && (
        <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/70 p-3" role="dialog" aria-modal="true" aria-label={t("Lightweight image inspection")} data-testid="task-review-media-lightbox">
          <div className="flex h-full w-full max-w-[1500px] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-bg-1 shadow-2xl">
            <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
              <strong className="min-w-0 truncate" title={inspector.sourceName}>#{inspector.displayOrdinal} {inspector.sourceName}</strong>
              <span className="text-fg-3">{inspector.status ? t(statusLabels[inspector.status]) : inspector.needsRecheck ? t("Needs recheck") : t("Pending")}</span>
              <span className="text-fg-3">{inspectorIndex + 1}/{inspectableCount}</span>
              <button type="button" className={`${wbButton.ghost} ml-auto`} onClick={() => onOpenUnit(inspector.unit.id)} data-testid="task-review-media-open-detailed-tools"><ExternalLink className="h-3.5 w-3.5" />{t("Detailed media tools")}</button>
              <button type="button" className={wbButton.ghost} onClick={closeInspector} aria-label={t("Close image inspection")} data-testid="task-review-media-close-inspector"><X className="h-4 w-4" /></button>
            </header>
            <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_320px]">
              <section className="flex min-h-0 min-w-0 flex-col border-b border-border lg:border-b-0 lg:border-r">
                <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
                  <button type="button" className={wbButton.ghost} disabled={zoom === null || zoom <= 0.25} onClick={() => setZoom((current) => Math.max(0.25, (current ?? 1) / 2))} aria-label={t("Zoom out")}><Minus className="h-3.5 w-3.5" /></button>
                  <button type="button" className={wbButton.secondary} data-testid="task-review-media-original-pixels" onClick={() => setZoom(1)}>{t("Original pixels (100%)")}</button>
                  <button type="button" className={wbButton.ghost} disabled={zoom !== null && zoom >= 8} onClick={() => setZoom((current) => Math.min(8, (current ?? 1) * 2))} aria-label={t("Zoom in")}><Plus className="h-3.5 w-3.5" /></button>
                  <button type="button" className={wbButton.ghost} onClick={() => setZoom(null)}>{t("Fit to view")}</button>
                  <span className="w-16 text-center font-mono text-fg-3" data-testid="task-review-media-zoom">{zoom === null ? t("Fit") : `${Math.round(zoom * 100)}%`}</span>
                  {inspectorThumbnail?.width && inspectorThumbnail.height && <span className="text-fg-3">{t("{{width}}×{{height}} px", { width: inspectorThumbnail.width, height: inspectorThumbnail.height })}</span>}
                  <button type="button" className={wbButton.secondary} data-testid="task-review-media-transparency-toggle" aria-pressed={transparentBackground === "solid"} onClick={() => setTransparentBackground((current) => current === "checker" ? "solid" : "checker")}>{transparentBackground === "checker" ? t("Solid background") : t("Transparency checkerboard")}</button>
                </div>
                <div
                  className="min-h-0 flex-1 overflow-auto"
                  data-testid="task-review-media-inspector-viewport"
                  data-background={transparentBackground}
                  style={transparentBackground === "checker" ? { backgroundImage: "repeating-conic-gradient(#d1d5db 0% 25%, #6b7280 0% 50%)", backgroundSize: "20px 20px" } : { background: "#17191d" }}
                >
                  {inspectorThumbnail?.url && inspectorThumbnail.status !== "error" ? (
                    <div className={zoom === null ? "flex h-full w-full items-center justify-center p-3" : "inline-block p-3"}>
                      <img
                        key={inspectorThumbnail.url}
                        src={inspectorThumbnail.url}
                        alt={inspector.sourceName}
                        draggable={false}
                        className={zoom === null ? "max-h-full max-w-full object-contain" : "block max-w-none"}
                        style={zoom === null ? undefined : { width: inspectorThumbnail.width! * zoom, height: inspectorThumbnail.height! * zoom }}
                        data-testid="task-review-media-inspector-image"
                        onLoad={() => thumbnails.markReady(inspector.unit.id, inspectorThumbnail.url!)}
                        onError={() => thumbnails.markError(inspector.unit.id, t("Image failed to load"))}
                      />
                    </div>
                  ) : (
                    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-2 bg-bg-2 text-fg-3">
                      {inspectorThumbnail?.status === "error" ? <FileImage className="h-10 w-10 text-status-error" /> : <ImageIcon className="h-10 w-10 animate-pulse" />}
                      <span>{inspectorThumbnail?.status === "error" ? t("Image not ready") : t("Loading image…")}</span>
                      {inspectorThumbnail?.status === "error" && <button type="button" className={wbButton.secondary} onClick={() => thumbnails.ensure(inspector.unit.id, true)}>{t("Retry")}</button>}
                    </div>
                  )}
                </div>
              </section>
              <aside className="flex min-h-0 flex-col gap-2 overflow-y-auto p-3">
                {inspectorThumbnail?.status !== "ready" && <p className="text-amber-200" role="status" data-testid="task-review-media-not-ready">{t("Wait until the image is decoded before confirming a decision.")}</p>}
                {!inspectorNoteOpen ? (
                  <div className="flex flex-col gap-1.5">
                    {(["kept", "rework", "discarded"] as TaskDecisionStatus[]).map((status) => (
                      <button
                        key={status}
                        type="button"
                        className={status === "kept" ? wbButton.primary : wbButton.secondary}
                        disabled={interactionBusy || inspectorThumbnail?.status !== "ready"}
                        aria-expanded={status === "rework" ? inspectorNoteOpen : undefined}
                        data-testid={`task-review-media-${status}-next`}
                        onClick={() => {
                          if (status === "rework") {
                            setInspectorNoteOpen(true);
                            setReuseNotice(false);
                          } else {
                            void decideInspectorAndNext(status);
                          }
                        }}
                      >{status === "kept" ? <Check className="h-3.5 w-3.5" /> : null}{t("{{status}} and next", { status: t(statusLabels[status]) })}</button>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 rounded-lg border border-border bg-bg-2 p-2" data-testid="task-review-media-inspector-rework-editor">
                    <NoteInput id="task-review-media-inspector-note" value={inspectorNote} recentNotes={recentNotes} disabled={interactionBusy} onChange={(value) => { setNotes((current) => ({ ...current, [inspector.unit.id]: value })); setReuseNotice(false); }} onReuse={reuseNote} />
                    {reuseNotice && <span className="text-[11px] text-fg-3" role="status">{t("Note copied into the draft only. Choose a decision explicitly.")}</span>}
                    <div className="flex justify-end gap-1.5">
                      <button type="button" className={wbButton.ghost} data-testid="task-review-media-cancel-rework" onClick={() => { setInspectorNoteOpen(false); setReuseNotice(false); }}>{t("Cancel")}</button>
                      <button
                        type="button"
                        className={wbButton.primary}
                        disabled={interactionBusy || inspectorThumbnail?.status !== "ready"}
                        data-testid="task-review-media-confirm-rework-next"
                        onClick={() => void decideInspectorAndNext("rework")}
                      >{t("Confirm rework and next")}</button>
                    </div>
                  </div>
                )}
                <div className="mt-auto flex items-center justify-between border-t border-border pt-2">
                  <button type="button" className={wbButton.ghost} disabled={inspectorIndex <= 0} onClick={() => moveInspector(-1)}><ChevronLeft className="h-3.5 w-3.5" />{t("Previous image")}</button>
                  <button type="button" className={wbButton.ghost} disabled={inspectorIndex < 0 || inspectorIndex >= inspectableCount - 1} onClick={() => moveInspector(1)}>{t("Next image")}<ChevronRight className="h-3.5 w-3.5" /></button>
                </div>
              </aside>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default MediaOverview;
