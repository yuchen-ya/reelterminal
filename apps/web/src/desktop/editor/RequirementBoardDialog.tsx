import { adoptReviewCandidate } from "../../services/production-review";
import { useTimelineStore } from "../../stores/timeline-store";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from "react";
import { useStore, type StoreApi } from "zustand";
import { Plus, Trash2 } from "@/icons/lucide-compat";
import type { ProjectRequirementStatus, RequirementReference } from "@reelterminal/core";
import { useTranslation } from "react-i18next";
import { getActiveProjectRuntimeStore, type ProjectState } from "../../stores/project-store";
import { previewSession } from "../../services/preview-session";
import { useUIStore } from "../../stores/ui-store";
import { useAgentReferencesStore } from "../../stores/agent-references-store";
import { getAgentReferenceTargetsForProject } from "../../stores/agent-reference-targets";
import { locateRequirementReference } from "../../services/requirement-board";
export const REQUIREMENT_BOARD_MODAL_ID = "requirement-board";
const STATUS_ORDER: readonly ProjectRequirementStatus[] = ["review", "blocked", "in_progress", "ready", "draft", "done"];
const INSTRUCTIONS = ["planFirst", "execute", "inspectOnly"] as const;
const fieldClass = "w-full rounded-md border border-border bg-bg-2 px-3 py-2 text-xs text-fg outline-none focus:border-accent";
export function RequirementBoardDialog({
  store,
  active = true,
  onClose
}: {
  store?: StoreApi<ProjectState>;
  active?: boolean;
  onClose?: () => void;
} = {}): JSX.Element {
  const {
    t
  } = useTranslation();
  const runtime = store ?? getActiveProjectRuntimeStore();
  const state = useStore(runtime);
  const project = state.project;
  const add = state.addProjectRequirement;
  const update = state.updateProjectRequirement;
  const remove = state.removeProjectRequirement;
  const modalData = useUIStore(ui => ui.modalData);
  const openRequest = useUIStore(ui => ui.boardOpenRequest);
  const lastRequest = useRef(0);
  const preview = useSyncExternalStore(previewSession.subscribe, previewSession.getSnapshot);
  const [view, setView] = useState<"list" | "new" | "detail">("list");
  const [showDone, setShowDone] = useState(false);
  const references = useAgentReferencesStore(state => state.references);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instruction, setInstruction] = useState<(typeof INSTRUCTIONS)[number]>("planFirst");
  const [criteria, setCriteria] = useState("");
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [markerIds, setMarkerIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!active || lastRequest.current === openRequest) return;
    lastRequest.current = openRequest;
    if (modalData?.projectId && modalData.projectId !== project.id) return;
    if (Array.isArray(modalData?.referenceIds)) {
      setReferenceIds(modalData.referenceIds.filter((id): id is string => typeof id === "string"));
      setView("new");
    }
  }, [active, openRequest, modalData, project.id]);
  const requirements = useMemo(() => [...(project.requirements?.items ?? [])].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || b.updatedAt - a.updatedAt), [project.requirements]);
  const targets = useMemo(() => getAgentReferenceTargetsForProject(project), [project]);
  const markers = project.markers?.items ?? [];
  const selected = requirements.find(item => item.id === selectedId);
  const availableReferences = Object.values(references).map(reference => ({
    ...reference,
    ref: `A${reference.number}`
  }));
  const isLive = (reference: RequirementReference) => targets.some(target => target.kind === reference.kind && target.entityId === reference.entityId);
  const createRequirement = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const number = runtime.getState().project.requirements?.nextNumber ?? 1;
      const result = await add({
        title,
        description,
        instruction: t(`requirementBoard.instructions.${instruction}`),
        markerIds,
        references: availableReferences.filter(reference => referenceIds.includes(reference.entityId) && isLive(reference)).map(({
          ref,
          kind,
          entityId,
          label,
          timing
        }) => ({
          ref,
          kind,
          entityId,
          label,
          timing
        })),
        acceptanceCriteria: criteria.split("\n").map(line => line.trim()).filter(Boolean),
        status: "ready"
      });
      if (result.success) {
        setView("detail");
        setSelectedId(runtime.getState().project.requirements?.items.find(item => item.number === number)?.id ?? null);
        setTitle("");
        setDescription("");
        setCriteria("");
        setReferenceIds([]);
        setMarkerIds([]);
      } else setError(result.error?.message ?? t("requirementBoard.saveFailed"));
    } finally {
      setBusy(false);
    }
  };
  const referenceButton = (reference: RequirementReference) => <button key={`${reference.kind}:${reference.entityId}`} type="button" disabled={preview.active || !isLive(reference)} onClick={() => locateRequirementReference(reference, project)} className="rounded border border-border bg-bg-2 px-2 py-1 text-xs text-accent disabled:text-status-warning" title={t(isLive(reference) ? "requirementBoard.locate" : "requirementBoard.missingReference")}>
      {reference.ref} · {reference.label}
      {!isLive(reference) ? ` · ${t("requirementBoard.missingReference")}` : ""}
    </button>;
  return <section aria-label={t("requirementBoard.title")} data-testid="inspector-board" className="flex h-full min-h-0 flex-col text-fg">
      <header className="flex shrink-0 items-center justify-between border-b border-border p-3">
        <h2 className="text-xs font-medium">{t("requirementBoard.title")}</h2>
        <div className="flex items-center gap-1">
        {view === "list" ? <button type="button" className="rounded border border-border px-2 py-1 text-xs text-fg-2 hover:bg-hover" onClick={() => {
        setSelectedId(null);
        setView("new");
      }}>{t("requirementBoard.new")}</button> : <button type="button" className="rounded px-2 py-1 text-xs text-fg-2 hover:bg-hover" onClick={() => setView("list")}>{t("requirementBoard.backToList")}</button>}
        {onClose ? <button type="button" aria-label={t("desktopInspector.close")} data-testid="close-board" onClick={onClose} className="h-6 w-6 rounded text-fg-3 hover:bg-hover hover:text-fg">×</button> : null}</div>
      </header>
      {preview.active ? <p className="shrink-0 border-b border-border px-3 py-2 text-[11px] leading-relaxed text-fg-2">{t("requirementBoard.editingTargetHint")}</p> : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain custom-scrollbar">
          <section hidden={view !== "list"} className="p-3">
            <div className="space-y-2">
              {requirements.some(item => item.status === "done") ? <button type="button" aria-expanded={showDone} onClick={() => setShowDone(!showDone)} className="text-xs text-fg-3 hover:text-fg">{t("requirementBoard.completed", {
              count: requirements.filter(item => item.status === "done").length
            })}</button> : null}
              {requirements.filter(item => showDone || item.status !== "done").map(item => <button key={item.id} onClick={() => {
            setSelectedId(item.id);
            setView("detail");
          }} className={`block w-full rounded-lg border p-3 text-left hover:bg-hover ${selectedId === item.id ? "border-accent bg-accent-soft" : "border-border bg-bg-2"}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-accent">
                        Q{item.number}
                      </span>
                      <strong className="flex-1 truncate text-sm">
                        {item.title}
                      </strong>
                      <span className={`text-xs ${item.status === "blocked" ? "text-status-warning" : "text-fg-2"}`}>
                        {t(`requirementBoard.status.${item.status}`)}
                      </span>
                    </div>
                    {!!item.references?.length && <p className="mt-2 truncate text-xs text-fg-2">
                        {item.references.map(reference => `${reference.ref} ${reference.label}`).join(" · ")}
                      </p>}
                    {item.agentNote && <p className="mt-2 line-clamp-2 text-xs text-fg-2">
                        {item.agentNote}
                      </p>}
                  </button>)}
              {requirements.filter(item => showDone || item.status !== "done").length === 0 && <p className="py-12 text-center text-sm text-fg-2">
                  {t("requirementBoard.empty")}
                </p>}
            </div>
          </section>
          <aside hidden={view === "list"} className="p-3">
            {selected ? <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <strong className="text-sm">
                    Q{selected.number} · {t("requirementBoard.taskDetails")}
                  </strong>
                  <button onClick={() => {
              setSelectedId(null);
              setView("new");
            }} className="text-xs text-accent">
                    {t("requirementBoard.new")}
                  </button>
                </div>
                <label className="block space-y-1.5 text-xs text-fg-2">
                  <span>{t("requirementBoard.editTitle")}</span>
                  <input key={`${selected.id}-title`} aria-label={t("requirementBoard.editTitle")} defaultValue={selected.title} className={fieldClass} onBlur={async event => {
              const title = event.target.value.trim();
              if (!title) {
                event.target.value = selected.title;
                return;
              }
              if (title === selected.title) return;
              const result = await update(selected.id, {
                title
              });
              if (!result.success) setError(result.error?.message ?? t("requirementBoard.saveFailed"));
            }} />
                </label>
                <label className="block space-y-1.5 text-xs text-fg-2">
                  <span>{t("requirementBoard.descriptionLabel")}</span>
                  <textarea key={`${selected.id}-description`} aria-label={t("requirementBoard.details")} defaultValue={selected.description} rows={4} className={fieldClass} onBlur={async event => {
              if (event.target.value === selected.description) return;
              const result = await update(selected.id, {
                description: event.target.value
              });
              if (!result.success) setError(result.error?.message ?? t("requirementBoard.saveFailed"));
            }} />
                </label>
                <p className="text-xs text-fg-2">
                  {t("requirementBoard.autoSaveHint")}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {selected.references?.map(referenceButton)}
                </div>
                {selected.markerIds.length > 0 && <p className="text-xs text-status-warning">
                    {selected.markerIds.map(id => {
              const marker = markers.find(entry => entry.id === id);
              return marker ? `R${marker.number}` : t("requirementBoard.missingReference");
            }).join(" · ")}
                  </p>}
                <p className="text-xs text-fg-2">{selected.instruction}</p>
                {!!selected.acceptanceCriteria?.length && <div>
                    <h3 className="mb-2 text-xs font-semibold">
                      {t("requirementBoard.acceptance")}
                    </h3>
                    <ul className="list-inside list-disc space-y-1 text-xs text-fg-2">
                      {selected.acceptanceCriteria.map((line, index) => <li key={index}>{line}</li>)}
                    </ul>
                  </div>}
                  {selected.reviewRange && <div className="space-y-2 rounded border border-border p-3 text-xs">
                    <p>
                      {t("production.timelineFrames")}: [
                      {selected.reviewRange.startFrame},{" "}
                      {selected.reviewRange.endFrame}) /{" "}
                      {selected.reviewRange.frameRate} fps
                    </p>
                    {selected.reviewRange.evidence && <p>{t("production.evidenceFrame")}: {selected.reviewRange.evidence.timelineFrame} · r{selected.reviewRange.evidence.sourceRevision} · {selected.reviewRange.evidence.timeSec.toFixed(6)}s</p>}
                  {selected.reviewRange.screenshot && <img alt={t("production.previewScreenshot")} src={selected.reviewRange.screenshot} className="max-h-48 w-full object-contain" />}
                    <button disabled={preview.active} onClick={() => {
              useTimelineStore.getState().seekTo(selected.reviewRange!.startFrame / selected.reviewRange!.frameRate);
            }}>
                      {t("production.locate")}
                    </button>
                  </div>}
                {selected.agentNote && <p className="whitespace-pre-wrap rounded border-l-2 border-accent bg-bg-2 p-3 text-xs">
                    {selected.agentNote}
                  </p>}
                <div className="flex flex-wrap gap-1.5">
                  {selected.resultMediaIds?.map(id => {
              const media = project.mediaLibrary.items.find(item => item.id === id);
              return <div key={id} className="flex items-center gap-2">
                        {referenceButton({
                  ref: t("requirementBoard.result"),
                  kind: "media",
                  entityId: id,
                  label: media?.name ?? id,
                  timing: {
                    startSeconds: null,
                    endSeconds: null
                  }
                })}
                        {media?.type === "video" && selected.reviewRange && <button className="rounded border border-border p-1 text-xs" onClick={async () => {
                  const review = selected.reviewRange!;
                  const startSec = review.startFrame / review.frameRate;
                  const mapping = review.mappings.find(entry => entry.timelineStartSec === startSec && entry.timelineEndSec >= review.endFrame / review.frameRate);
                  if (!mapping) {
                    setError(t("production.compareSingle"));
                    return;
                  }
                  const result = await runtime.getState().executeAction({
                    type: "reference/setComparison",
                    id: crypto.randomUUID(),
                    timestamp: Date.now(),
                    params: {
                      config: {
                        referenceMediaId: media.id,
                        refStartSec: mapping.sourceStartSec,
                        refEndSec: mapping.sourceEndSec,
                        timelineStartSec: mapping.timelineStartSec,
                        rate: (mapping.sourceEndSec - mapping.sourceStartSec) / (mapping.timelineEndSec - mapping.timelineStartSec),
                        audioSide: "timeline",
                        layout: "side-by-side"
                      }
                    }
                  });
                  if (!result.success) {
                    setError(result.error?.message ?? t("production.failed"));
                    return;
                  }
                  useTimelineStore.getState().seekTo(startSec);
                }}>
                            {t("production.compare")}
                          </button>}
                        {media?.type === "video" && selected.reviewRange && <button className="rounded border border-border p-1 text-xs" disabled={busy || preview.active} onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await adoptReviewCandidate(selected.id, media.id, t("production.adopt"), runtime);
                  } catch (failure) {
                    setError(failure instanceof Error ? failure.message : String(failure));
                  } finally {
                    setBusy(false);
                  }
                }}>
                            {t("production.adopt")}
                          </button>}
                      </div>;
            })}
                </div>
                <select aria-label={t("requirementBoard.taskStatus")} value={selected.status} className={fieldClass} onChange={async event => {
            const result = await update(selected.id, {
              status: event.target.value as ProjectRequirementStatus
            });
            if (!result.success) setError(result.error?.message ?? t("requirementBoard.saveFailed"));
          }}>
                  {STATUS_ORDER.map(status => <option key={status} value={status}>
                      {t(`requirementBoard.status.${status}`)}
                    </option>)}
                </select>
                {selected.status === "review" && <button className="w-full rounded bg-accent px-3 py-2 text-xs font-medium text-accent-fg" onClick={async () => {
            const result = await update(selected.id, {
              status: "done"
            });
            if (!result.success) setError(result.error?.message ?? t("requirementBoard.saveFailed"));
          }}>
                    {t("requirementBoard.accept")}
                  </button>}
                <button aria-label={t("requirementBoard.remove")} className="flex items-center gap-1 text-xs text-fg-2 hover:text-status-error" onClick={async () => {
            const result = await remove(selected.id);
            if (result.success) setSelectedId(null);else setError(result.error?.message ?? t("requirementBoard.saveFailed"));
          }}>
                  <Trash2 size={13} />
                  {t("requirementBoard.remove")}
                </button>
              </div> : <form className="space-y-3" onSubmit={event => {
          event.preventDefault();
          void createRequirement();
        }}>
                <h3 className="text-sm font-semibold">
                  {t("requirementBoard.new")}
                </h3>
                <input aria-label={t("requirementBoard.new")} value={title} onChange={event => setTitle(event.target.value)} placeholder={t("requirementBoard.titlePlaceholder")} className={fieldClass} />
                <textarea value={description} onChange={event => setDescription(event.target.value)} placeholder={t("requirementBoard.descriptionPlaceholder")} rows={4} className={fieldClass} />
                <details>
                  <summary className="cursor-pointer text-xs text-fg-2">
                    {t("requirementBoard.details")}
                  </summary>
                  <div className="mt-3 space-y-3">
                <fieldset>
                  <legend className="mb-2 text-xs text-fg-2">
                    {t("requirementBoard.oneTimeInstruction")}
                  </legend>
                  <div className="flex flex-wrap gap-1">
                    {INSTRUCTIONS.map(key => <label key={key} className={`cursor-pointer rounded-md border px-2 py-1.5 text-xs ${instruction === key ? "border-accent bg-accent-soft text-accent" : "border-border text-fg-2"}`}>
                        <input className="sr-only" type="radio" name="instruction" checked={instruction === key} onChange={() => setInstruction(key)} />
                        {t(`requirementBoard.instructionLabels.${key}`)}
                      </label>)}
                  </div>
                </fieldset>
                <div>
                  <h4 className="mb-2 text-xs text-fg-2">
                    {t("requirementBoard.agentReferences")}
                  </h4>
                  {availableReferences.length === 0 && <p className="text-xs text-fg-2">
                      {t("requirementBoard.referenceHint")}
                    </p>}
                  <div className="flex flex-wrap gap-1">
                    {availableReferences.map(reference => <label key={reference.number} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-fg-2">
                        <input type="checkbox" disabled={preview.active || !isLive(reference)} checked={referenceIds.includes(reference.entityId)} onChange={event => setReferenceIds(ids => event.target.checked ? [...ids, reference.entityId] : ids.filter(id => id !== reference.entityId))} />
                        {reference.ref} · {reference.label}
                      </label>)}
                  </div>
                </div>


                    <textarea aria-label={t("requirementBoard.acceptance")} value={criteria} onChange={event => setCriteria(event.target.value)} placeholder={t("requirementBoard.acceptance")} rows={3} className={fieldClass} />
                    {markers.map(marker => <label key={marker.id} className="flex items-center gap-2 text-xs text-fg-2">
                        <input type="checkbox" checked={markerIds.includes(marker.id)} onChange={event => setMarkerIds(ids => event.target.checked ? [...ids, marker.id] : ids.filter(id => id !== marker.id))} />
                        R{marker.number} · {marker.label}
                      </label>)}
                  </div>
                </details>
                <button type="submit" disabled={busy || !title.trim()} className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-accent-fg disabled:opacity-40">
                  <Plus size={14} />
                  {t("requirementBoard.publish")}
                </button>
              </form>}
            {error && <p role="alert" className="mt-3 text-xs text-status-error">
                {error}
              </p>}
          </aside>
        </div>
      </section>;
}
