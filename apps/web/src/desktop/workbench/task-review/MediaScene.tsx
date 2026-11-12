import { useTranslation } from "react-i18next";
import { t } from "../../../i18n";
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import type { TaskReviewSnapshot, TaskDecisionStatus } from "../../../../../desktop/src/shared/task-review";
import { isCurrentTaskUnit } from "../../../../../desktop/src/shared/task-review";
import { isTaskCriteriaBasisCurrent, resolveUnitCriteriaBasis } from "../../../../../desktop/src/shared/task-review-context";
import type { TaskMediaOpenResult, TaskMediaPrompts, TaskMediaUnit, TaskRegionCandidate } from "../../../../../desktop/src/shared/task-review-media";
import { wbButton, segmentedItem } from "../wb-button";
import { FeedbackEditor } from "./FeedbackEditor";
import { sourceTitle, unitTitle, sourcePath, statusLabels } from "./display";
import { unitDecisionState } from "./queries";
import type { DraftEntry } from "./useTaskDrafts";
import type { TaskReviewController } from "./useTaskReviewController";
import { normalizedMediaPoint, promptTokens, readMediaView } from "./media-view";
import { useSceneScroll, viewKey } from "./view-state";

type Phase = "opening" | "idle" | "segmenting" | "candidate" | "cancelled" | "capturing" | "accepting" | "error";
type MediaOperations = Pick<TaskReviewController, "openMedia" | "captureMediaFrame" | "segmentMedia" | "cancelMedia" | "acceptMediaRegion" | "decide">;

export function MediaScene({ snapshot, unit, operations, draft, onUpdateDraft, onOpenUnit, onDecide, onUndo, onRedo, onReportError, busy }: {
  snapshot: TaskReviewSnapshot;
  unit: TaskMediaUnit;
  operations: MediaOperations;
  draft: DraftEntry | undefined;
  onUpdateDraft: (patch: { text?: string; selectionStart?: number; selectionEnd?: number }) => void;
  onOpenUnit: (unitId: string) => void;
  onDecide: (status: TaskDecisionStatus) => void;
  onUndo: () => void;
  onRedo: () => void;
  onReportError?: (message: string) => void;
  busy: boolean;
}) {
  useTranslation();
  const storageKey = `${viewKey(snapshot.root, snapshot.taskId)}:media:${unit.id}`;
  const scroll = useSceneScroll<HTMLDivElement>(`${storageKey}:scroll`);
  const [view, setView] = useState(() => readMediaView(storageKey, {
    prompts: unit.kind === "region" ? unit.prompts : { points: [] }, mode: "positive", zoom: 1, label: unit.kind === "region" ? unit.label : "", previewResult: unit.kind === "region",
  }));
  const viewRef = useRef(view);
  viewRef.current = view;
  const [opened, setOpened] = useState<{ base: TaskMediaOpenResult; mask?: string; cutout?: string } | null>(null);
  const [candidate, setCandidate] = useState<TaskRegionCandidate | null>(null);
  const [phase, setPhase] = useState<Phase>("opening");
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [fitScale, setFitScale] = useState(1);
  const [dragBox, setDragBox] = useState<TaskMediaPrompts["box"]>();
  const boxStart = useRef<{ x: number; y: number } | null>(null);
  const pane = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const active = useRef(true);
  const latestGeneration = useRef<string | null>(null);
  const refinement = useRef(crypto.randomUUID());
  const pendingTimer = useRef<number | undefined>(undefined);
  const stale = !isCurrentTaskUnit(snapshot, unit);
  const decision = unitDecisionState(snapshot, unit.id);
  const source = snapshot.sources.find((item) => item.id === unit.sourceVersionId)!;
  const { root, taskId } = snapshot;
  const { openMedia, captureMediaFrame, segmentMedia, cancelMedia, acceptMediaRegion } = operations;

  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify(view)); }, [storageKey, view]);
  const cancelCandidate = useCallback(() => {
    window.clearTimeout(pendingTimer.current);
    const generationId = latestGeneration.current;
    const sessionId = refinement.current;
    latestGeneration.current = null;
    if (generationId) void cancelMedia({ root, taskId, generationId }).catch((problem) => {
      if (active.current && latestGeneration.current === null && refinement.current === sessionId) setError(String(problem));
    });
  }, [cancelMedia, root, taskId]);

  useEffect(() => {
    let currentRequest = true;
    active.current = true;
    setPhase("opening");
    setOpened(null);
    setCandidate(null);
    setError(null);
    const OPEN_TIMEOUT_MS = 30_000;
    const timeoutId = window.setTimeout(() => {
      if (active.current && currentRequest) {
        setError(t("Frame read timed out. Read the frame again."));
        setPhase("error");
      }
    }, OPEN_TIMEOUT_MS);
    void (async () => {
      try {
        const current = await openMedia({ root, taskId, sourceVersionId: unit.sourceVersionId, unitId: unit.id });
        const base = unit.kind === "region"
          ? await openMedia({ root, taskId, sourceVersionId: unit.sourceVersionId, unitId: unit.parentUnitId }) : current;
        if (!active.current || !currentRequest) return;
        window.clearTimeout(timeoutId);
        setOpened({ base, ...(unit.kind === "region" ? { mask: current.maskUrl, cutout: current.cutoutUrl ?? current.url } : {}) });
        setPhase("idle");
      } catch (problem) {
        window.clearTimeout(timeoutId);
        if (active.current && currentRequest) {
          setError(String(problem));
          setPhase("error");
        }
      }
    })();
    return () => {
      active.current = false;
      currentRequest = false;
      window.clearTimeout(timeoutId);
      video.current?.pause();
      cancelCandidate();
      refinement.current = crypto.randomUUID();
    };
  }, [root, taskId, unit.id, unit.sourceVersionId, unit.kind, unit.kind === "region" ? unit.parentUnitId : null, openMedia, cancelCandidate, loadAttempt]);

  useEffect(() => {
    const element = video.current;
    return () => {
      if (!element) return;
      element.pause();
      localStorage.setItem(storageKey, JSON.stringify({ ...viewRef.current, videoTimeSec: element.currentTime }));
    };
  }, [opened?.base.url, opened?.base.unit.kind, storageKey]);

  useEffect(() => {
    if (!opened || !pane.current) return;
    const resize = () => {
      const bounds = pane.current!.getBoundingClientRect();
      setFitScale(Math.min(1, (bounds.width || opened.base.width) / opened.base.width, (bounds.height || opened.base.height) / opened.base.height));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(pane.current);
    return () => observer.disconnect();
  }, [opened]);

  const requestMask = useCallback(async () => {
    if (!opened || stale || view.previewResult || opened.base.unit.kind === "video" || !promptTokens(view.prompts)) return;
    cancelCandidate();
    const generationId = crypto.randomUUID();
    latestGeneration.current = generationId;
    setPhase("segmenting"); setError(null); setCandidate(null);
    const base = opened.base;
    try {
      const result = await segmentMedia({
        root,
        taskId,
        sourceVersionId: unit.sourceVersionId,
        unitId: base.unit.id,
        generationId,
        refinementId: refinement.current,
        prompts: view.prompts
      });
      if (!active.current || latestGeneration.current !== generationId) return;
      if (result.generationId !== generationId || result.unitId !== base.unit.id || result.sourceVersionId !== unit.sourceVersionId ||
        result.width !== base.width || result.height !== base.height || (base.asset && result.pixelRevision !== base.asset.pixelRevision)) throw new Error(t("This candidate does not belong to the current frame. Try again."));
      setCandidate(result); setPhase("candidate");
    } catch (problem) {
      if (active.current && latestGeneration.current === generationId) {
        setError(String(problem));
        setPhase("error");
      }
    }
  }, [opened, stale, view.prompts, view.previewResult, cancelCandidate, segmentMedia, root, taskId, unit.sourceVersionId]);

  useEffect(() => {
    if (!edit) return;
    pendingTimer.current = window.setTimeout(() => void requestMask(), 150);
    return () => window.clearTimeout(pendingTimer.current);
  }, [edit, requestMask]);
  useEffect(() => {
    if (stale) {
      cancelCandidate();
      video.current?.pause();
      setCandidate(null);
      setPhase("cancelled");
    }
  }, [stale, cancelCandidate]);

  const changePrompts = (prompts: TaskMediaPrompts, resetPrior = false) => {
    const limit = opened?.base.promptTokenLimit;
    if (limit !== undefined && promptTokens(prompts) > limit) {
      setError(t("Prompt limit: {{v0}}; a box uses 2 tokens. Undo some prompts and try again.", { v0: limit }));
      return;
    }
    cancelCandidate(); setCandidate(null); setError(null); setPhase("idle");
    if (resetPrior) refinement.current = crypto.randomUUID();
    setView((current) => ({ ...current, prompts }));
    setEdit((value) => value + 1);
  };
  const pointerPoint = (event: PointerEvent<HTMLDivElement>) => normalizedMediaPoint(event.clientX, event.clientY, picture.current!.getBoundingClientRect());
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (stale || busy || view.previewResult || phase === "accepting" || !opened || opened.base.unit.kind === "video" || (event.button !== 0 && event.button !== 2)) return;
    event.preventDefault();
    const point = pointerPoint(event);
    if (view.mode === "box" && event.button === 0) {
      boxStart.current = point;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragBox({ left: point.x, top: point.y, right: point.x, bottom: point.y });
    } else changePrompts({ ...view.prompts, points: [...view.prompts.points, { ...point, foreground: event.button !== 2 && view.mode === "positive" }] });
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = boxStart.current;
    if (!start) return;
    const end = pointerPoint(event);
    setDragBox({ left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), right: Math.max(start.x, end.x), bottom: Math.max(start.y, end.y) });
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = boxStart.current;
    if (!start) return;
    const end = pointerPoint(event);
    const completed = { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), right: Math.max(start.x, end.x), bottom: Math.max(start.y, end.y) };
    boxStart.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragBox(undefined);
    if (completed.left < completed.right && completed.top < completed.bottom) changePrompts({ ...view.prompts, box: completed }, true);
  };
  const capture = async () => {
    if (!video.current) return;
    video.current.pause();
    const timeSec = video.current.currentTime;
    const generationId = crypto.randomUUID();
    cancelCandidate(); latestGeneration.current = generationId;
    setPhase("capturing"); setError(null);
    try {
      const result = await captureMediaFrame({ sourceVersionId: unit.sourceVersionId, unitId: unit.id, generationId, selection: { timeSec } });
      if (active.current && latestGeneration.current === generationId) onOpenUnit(result.unitId);
    } catch (problem) {
      if (active.current && latestGeneration.current === generationId) {
        setPhase("error");
        setError(String(problem));
      }
    }
  };
  const accept = async (keep: boolean) => {
    if (!opened || !candidate || phase !== "candidate" || !view.label.trim() || stale) return;
    setPhase("accepting"); setError(null);
    let savedUnitId: string | null = null;
    try {
      const result = await acceptMediaRegion({
        sourceVersionId: unit.sourceVersionId,
        unitId: opened.base.unit.id,
        generationId: candidate.generationId,
        label: view.label.trim(),
        ...(unit.kind === "region" ? { supersedesUnitId: unit.id } : {})
      });
      savedUnitId = result.unitId;
      if (keep) {
        const target = { unitId: result.unitId, sourceVersionId: unit.sourceVersionId, purpose: "review" };
        const saved = result.snapshot.units.find((item) => item.id === target.unitId && item.sourceVersionId === target.sourceVersionId);
        if (!saved) throw new Error(t("The saved result contains no matching new region"));
        const reviewed = { ...snapshot, units: [...snapshot.units, saved] };
        const basis = snapshot.contextHistory ? resolveUnitCriteriaBasis(reviewed, snapshot.contextHistory, target).basis : null;
        // Explicit human approval binds the returned region, never its parent
        // or whichever scene happens to be selected when the save finishes.
        const decision = await operations.decide({ ...target, status: "kept", note: draft?.text ?? "" }, (base) => {
          const current = base.units.find((item) => item.id === target.unitId && item.sourceVersionId === target.sourceVersionId);
          if (base.taskId !== taskId || base.policyRevision !== snapshot.policyRevision || !current || !isCurrentTaskUnit(base, current)) throw new Error(t("The task, source or criteria changed. Confirm the new region again."));
          if (basis ? !base.contextHistory || !isTaskCriteriaBasisCurrent(base, base.contextHistory, basis)
            : base.contextHistory && resolveUnitCriteriaBasis(base, base.contextHistory, target).basis.criteriaVersionIds.length > 0) throw new Error(t("The criteria applicable to the new region changed. Confirm again."));
        });
        if (!decision.ok) throw new Error(decision.error!);
      }
      if (active.current) onOpenUnit(result.unitId);
    } catch (problem) {
      if (savedUnitId) {
        const message = t("Region saved, decision incomplete ({{v0}} · {{v1}}): {{v2}}", { v0: sourceTitle(source.relativePath), v1: view.label.trim(), v2: String(problem) });
        onReportError?.(message);
        if (active.current) { setError(message); setPhase("error"); onOpenUnit(savedUnitId); }
        return;
      }
      if (active.current) {
        setError(String(problem));
        setPhase("error");
      }
    }
  };
  const differentPrompts = unit.kind === "region" && JSON.stringify(view.prompts) !== JSON.stringify(unit.prompts);
  const hasUnacceptedRegion = Boolean(candidate || phase === "segmenting" || (unit.kind === "region" ? differentPrompts : promptTokens(view.prompts) > 0));
  const overlay = candidate?.url ?? (edit === 0 && !differentPrompts ? opened?.mask : undefined);
  const box = dragBox ?? view.prompts.box;
  const mediaLoadError = () => {
    cancelCandidate();
    setCandidate(null);
    setPhase("error");
    setError(t("Frame load failed. Read the frame again."));
  };

  return (
    <div {...scroll} className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="task-review-media-scene" data-unit-kind={unit.kind}>
      <div className="mx-auto flex max-w-7xl flex-col gap-3">
        <header className="flex flex-wrap items-center gap-2">
          <strong title={sourcePath(root, source.relativePath)}>{sourceTitle(source.relativePath)} · {unitTitle(unit)}</strong>
          <span className="text-fg-3">{t("Human review · Local segmentation tool")}</span>
          <span className={`ml-auto rounded border px-1.5 py-0.5 ${decision.status === "kept" ? "border-emerald-300/60 text-emerald-300" : decision.status === "rework" ? "border-amber-200/60 text-amber-200" : decision.status === "discarded" ? "border-zinc-500/70 text-zinc-400" : "border-white/45 text-fg"}`} data-testid="task-review-media-status">{decision.status ? statusLabels[decision.status] : t("Pending")}</span>
        </header>
        {stale && <p className="text-status-error">{t("This frame or region is stale. The old draft is preserved for reference; open the current version before deciding.")}</p>}
        {error && <div role="alert" className="flex items-center gap-2 text-status-error" data-testid="task-review-media-error">
          <span>{error}</span>{phase === "error" && !candidate && <button type="button" className={wbButton.secondary} onClick={() => setLoadAttempt((value) => value + 1)}>{t("Read frame again")}</button>}
        </div>}
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
          <section className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {unit.kind === "region" && <button
                type="button"
                className={wbButton.secondary}
                data-testid="task-review-region-view-toggle"
                onClick={() => setView((current) => ({ ...current, previewResult: !current.previewResult }))}>{view.previewResult ? t("Refine region") : t("View transparent cutout")}</button>}
              {!view.previewResult && opened && opened.base.unit.kind !== "video" && <>
              {([["positive", t("Include point")], ["negative", t("Exclude point")], ["box", t("reviewUi.box")]] as const).map(([mode, title]) => <button
                key={mode}
                type="button"
                className={segmentedItem(view.mode === mode)}
                disabled={stale || phase === "accepting" || view.previewResult || opened?.base.unit.kind === "video"}
                onClick={() => setView((current) => ({ ...current, mode }))}>{title}</button>)}
              <button
                type="button"
                className={wbButton.ghost}
                disabled={!view.prompts.points.length || stale || phase === "accepting" || view.previewResult}
                onClick={() => changePrompts({ ...view.prompts, points: view.prompts.points.slice(0, -1) }, true)}>{t("Undo point")}</button>
              <button type="button" className={wbButton.ghost} disabled={stale || phase === "accepting" || view.previewResult} onClick={() => changePrompts({ points: [] }, true)}>{t("Clear")}</button>
              <label className="ml-auto flex items-center gap-1">{t("Zoom")}<input
                aria-label={t("Frame zoom")}
                type="range"
                min="0.25"
                max="4"
                step="0.25"
                value={view.zoom}
                onChange={(event) => setView((current) => ({ ...current, zoom: Number(event.target.value) }))} /></label>
              </>}
            </div>
            <div
              ref={pane}
              className="overflow-auto rounded border border-border bg-black/40"
              style={{ height: candidate && !view.previewResult ? "min(48vh,560px)" : "min(65vh,720px)" }}
              data-testid="task-review-media-viewport">
              {!opened ? <div className="p-4 text-fg-3"><p>{phase === "error" ? t("Frame unavailable") : t("Reading frame…")}</p></div> : opened.base.unit.kind === "video" ? (
                <video
                  ref={video}
                  src={opened.base.url}
                  controls
                  className="h-full w-full object-contain"
                  data-testid="task-review-media-video"
                  onError={mediaLoadError}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onLoadedMetadata={(event) => { if (viewRef.current.videoTimeSec !== undefined) event.currentTarget.currentTime = Math.min(viewRef.current.videoTimeSec, opened.base.source.durationSec); }}
                  onTimeUpdate={(event) => {
                    const videoTimeSec = event.currentTarget.currentTime;
                    setView((current) => ({ ...current, videoTimeSec }));
                  }} />
              ) : view.previewResult && opened.cutout ? (
                <div className="p-3" style={{ backgroundImage: "repeating-conic-gradient(#404448 0% 25%, #272b2f 0% 50%)", backgroundSize: "20px 20px" }}>
                  <img
                    src={opened.cutout}
                    alt={t("Transparent cutout {{v0}}", { v0: unitTitle(unit) })}
                    className="block max-h-[60vh] max-w-full object-contain"
                    onError={mediaLoadError}
                    data-testid="task-review-region-cutout" />
                </div>
              ) : (
                <div
                  ref={picture}
                  className="relative touch-none select-none"
                  style={{ width: opened.base.width * fitScale * view.zoom, height: opened.base.height * fitScale * view.zoom }}
                  data-testid="task-review-media-picture"
                  onPointerDown={pointerDown}
                  onPointerMove={pointerMove}
                  onPointerUp={pointerUp}
                  onPointerCancel={() => {
                    boxStart.current = null;
                    setDragBox(undefined);
                  }}
                  onContextMenu={(event) => event.preventDefault()}>
                  <img src={opened.base.url} alt={sourceTitle(source.relativePath)} className="pointer-events-none block h-full w-full" draggable={false} onError={mediaLoadError} />
                  {overlay && <div
                    className="pointer-events-none absolute inset-0 bg-accent opacity-60"
                    data-testid="task-review-media-mask"
                    style={{ maskImage: `url("${overlay}")`, maskMode: "luminance", maskSize: "100% 100%", maskRepeat: "no-repeat" }} />}
                  {view.prompts.points.map((point, index) => <span
                    key={index}
                    className={`pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white ${point.foreground ? "bg-accent" : "bg-status-error"}`}
                    style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                    data-testid="task-review-media-point" />)}
                  {box && <div
                    className="pointer-events-none absolute border-2 border-accent"
                    style={{
                      left: `${box.left * 100}%`,
                      top: `${box.top * 100}%`,
                      width: `${(box.right - box.left) * 100}%`,
                      height: `${(box.bottom - box.top) * 100}%`
                    }} />}
                </div>
              )}
            </div>
            {opened?.base.unit.kind === "video" ? <button
              type="button"
              className={`${wbButton.primary} self-start`}
              disabled={busy || stale || phase === "capturing"}
              data-testid="task-review-freeze-frame"
              onClick={() => void capture()}>{t("Freeze the current frame and select a region")}</button> : view.previewResult ? <p className="text-fg-3">{t("Transparent PNG result; refine it by adding points or drawing a new box.")}</p> : <div className="flex flex-wrap items-center gap-2">
              <span className="text-fg-3">{t("Prompts ")}{promptTokens(view.prompts)}{opened?.base.promptTokenLimit ? `/${opened.base.promptTokenLimit}` : ""} {t(" · A box uses 2 tokens")}</span>
              <button
                type="button"
                className={wbButton.secondary}
                disabled={!opened || stale || view.previewResult || !promptTokens(view.prompts) || phase === "segmenting"}
                aria-label={t("Recompute region")}
                data-testid="task-review-media-segment"
                onClick={() => void requestMask()}>{phase === "segmenting" ? t("Computing region…") : t("Recompute region")}</button>
              {(phase === "segmenting" || phase === "capturing") && <button
                type="button"
                className={wbButton.ghost}
                data-testid="task-review-media-cancel"
                onClick={() => {
                  cancelCandidate();
                  setPhase("cancelled");
                }}>{t("Cancel")}</button>}
              {phase === "cancelled" && <span className="text-fg-3">{t("Cancelled; prompts are preserved")}</span>}
            </div>}
            {unit.kind === "video-frame" && <p className="text-fg-3">{t("reviewUi.freezeFrame")}{unit.frameIndex === undefined ? "" : ` #${unit.frameIndex}`} {t(" · PTS ")}{unit.ptsTimeSec.toFixed(3)}s</p>}
            {candidate && !view.previewResult && <div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2">{t("Region label")}<input
              className="rounded border border-border bg-bg-2 px-2 py-1"
              aria-label={t("Region label")}
              maxLength={200}
              value={view.label}
              onChange={(event) => setView((current) => ({ ...current, label: event.target.value }))} /></label><button
                type="button"
                className={wbButton.primary}
                aria-label={t("Save and keep this region")}
                disabled={busy || stale || phase !== "candidate" || !view.label.trim()}
                data-testid="task-review-media-accept-keep"
                onClick={() => void accept(true)}>{t("Save and keep this region")}</button>
              <button
                type="button"
                className={wbButton.secondary}
                aria-label={t("Save region only")}
                disabled={busy || stale || phase !== "candidate" || !view.label.trim()}
                data-testid="task-review-media-accept"
                onClick={() => void accept(false)}>{t("Save region only")}</button>
              <span className="basis-full text-fg-3">{t("Saving alone does not change the decision; keeping applies only to this new region")}</span></div>}
          </section>
          <section className="flex min-w-0 flex-col gap-3">
            <FeedbackEditor
              unit={unit}
              root={root}
              taskId={taskId}
              agent={null}
              agentState={null}
              draft={draft}
              onUpdateDraft={onUpdateDraft}
              inputTestId="task-review-unit-note"
              disabled={stale}
              policyRevision={snapshot.policyRevision}
              showSuggestions={false} />
            <p className="text-fg-3" data-testid="task-review-media-decision-scope">{unit.kind === "region" ? t("Decision applies only to the accepted region: {{v0}}", { v0: unit.label }) : unit.kind === "image" ? t("Decision applies to the entire image. Accept a region first to decide locally.") : unit.kind === "video-frame" ? t("Decision applies to this entire frame. Accept a region first to decide locally.") : t("Decision applies to the whole video. Frames and regions are decided separately.")}</p>
            {hasUnacceptedRegion && <div className="flex flex-col gap-2 text-fg-3" role="status" data-testid="task-review-media-unaccepted-region">
              <p>{t("Region prompts or candidates are not accepted yet. Accept the region before making a human decision.")}</p>
              {unit.kind === "region" && <button type="button" className={`${wbButton.ghost} self-start`} onClick={() => {
                cancelCandidate();
                refinement.current = crypto.randomUUID();
                setCandidate(null); setEdit(0); setPhase("idle");
                setView((current) => ({ ...current, prompts: unit.prompts, label: unit.label }));
              }}>{t("Discard these refinements")}</button>}
            </div>}
            <div className="flex flex-wrap items-center gap-2">{(Object.keys(statusLabels) as TaskDecisionStatus[]).map((status) => <button
              key={status}
              type="button"
              className={wbButton.secondary}
              disabled={busy || stale || !opened || hasUnacceptedRegion}
              data-testid={`task-review-decide-${status}`}
              onClick={() => onDecide(status)}>{statusLabels[status]}</button>)}
              {decision.canUndo && <button type="button" className={wbButton.ghost} disabled={busy || stale} data-testid="task-review-undo-decision" onClick={onUndo}>{t("Undo decision")}</button>}
              {decision.canRedo && <button type="button" className={wbButton.ghost} disabled={busy || stale || hasUnacceptedRegion} data-testid="task-review-redo-decision" onClick={onRedo}>{t("Redo decision")}</button>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
