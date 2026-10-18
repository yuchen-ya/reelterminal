import { useState, useSyncExternalStore } from "react";
import { useStore, type StoreApi } from "zustand";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Plus, SlidersHorizontal, Trash2 } from "@/icons/lucide-compat";
import { COLLABORATION_INSTRUCTION_LIMITS as limits, type CollaborationInstruction, type RequirementReference } from "@reelterminal/core";
import type { ProjectState } from "../../stores/project-store";
import { getAgentReferenceTargetsForProject } from "../../stores/agent-reference-targets";
import { useAgentReferencesStore } from "../../stores/agent-references-store";
import { locateRequirementReference } from "../../services/requirement-board";
import { previewSession } from "../../services/preview-session";

const PRESETS = ["visual", "explain", "sample", "compare", "preserve", "review", "resources", "tool", "skill"] as const;
const fieldClass = "mt-1.5 w-full rounded-lg border border-border bg-bg-2 px-3 py-2.5 text-[13px] text-fg outline-none focus:border-accent";
const buttonClass = "rounded-lg px-3 py-2 text-xs transition-colors hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

export function CollaborationInstructionsPanel({ store }: { store: StoreApi<ProjectState> }) {
  const { t } = useTranslation();
  const project = useStore(store, state => state.project);
  const references = useAgentReferencesStore(state => state.references);
  const preview = useSyncExternalStore(previewSession.subscribe, previewSession.getSnapshot);
  const items = project.collaborationInstructions?.items ?? [];
  const targets = getAgentReferenceTargetsForProject(project);
  const [view, setView] = useState<"list" | "presets" | "edit">("list");
  const [draft, setDraft] = useState<CollaborationInstruction | null>(null);
  const [original, setOriginal] = useState<CollaborationInstruction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const label = (key: string) => t(`collaborationInstructions.${key}`);
  const isLive = (ref: RequirementReference) => targets.some(target => target.kind === ref.kind && target.entityId === ref.entityId);

  function edit(item?: CollaborationInstruction, presetId?: string) {
    const now = Date.now();
    setOriginal(item ?? null);
    setDraft(item ? structuredClone(item) : {
      id: crypto.randomUUID(), title: presetId ? label(`presets.${presetId}.title`) : "",
      description: presetId ? label(`presets.${presetId}.description`) : "",
      enabled: true, references: [], ...(presetId ? { presetId } : {}), createdAt: now, updatedAt: now,
    });
    setError("");
    setView("edit");
  }

  async function commit(item: CollaborationInstruction, before: CollaborationInstruction | null, remove = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const submit = () => {
        const state = store.getState();
        const current = state.project.collaborationInstructions?.items ?? [];
        const existing = current.find(entry => entry.id === item.id);
        // A draft must not overwrite an undo or another edit made while the form was open.
        if (JSON.stringify(existing ?? null) !== JSON.stringify(before)) {
          return { success: false, error: { message: label("conflict") } };
        }
        if (!existing && current.length >= limits.items) {
          return { success: false, error: { message: label("limit") } };
        }
        const updated = { ...item, updatedAt: Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1) };
        const next = remove ? current.filter(entry => entry.id !== item.id)
          : existing ? current.map(entry => entry.id === item.id ? updated : entry) : [...current, updated];
        return state.executeActionBatch([{
          type: "project/setCollaborationInstructions", id: crypto.randomUUID(), timestamp: Date.now(),
          params: { instructions: { items: next } },
        }], { groupLabel: label("historyLabel"), historyOwner: "human" }).result;
      };
      const queue = store.getState().submitWorkspaceMutation;
      const result = await (queue ? queue(submit) : submit());
      if (!result.success) { setError(result.error?.message ?? label("saveFailed")); return; }
      setSaved(true);
      setView("list");
      setDraft(null);
      setOriginal(null);
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!draft) return;
    const title = draft.title.trim(), description = draft.description.trim();
    if (!title || !description) { setError(label("required")); return; }
    if (/【[^】]+】/.test(description)) { setError(label("placeholder")); return; }
    void commit({ ...draft, title, description }, original);
  }

  return <section className="flex h-full min-h-0 flex-col" aria-label={label("title")}>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 custom-scrollbar">
      {view === "list" && (items.length === 0 ? <div className="px-1 py-4 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-accent-soft text-accent"><SlidersHorizontal size={22} aria-hidden /></div>
        <h3 className="text-sm font-medium text-fg">{label("emptyTitle")}</h3>
        <p className="mt-3 text-xs leading-relaxed text-fg-2">{label("emptyDescription")}</p>
        <button className={`${buttonClass} mt-4 w-full bg-accent font-medium text-accent-fg hover:bg-accent-strong`} onClick={() => setView("presets")}>{label("fromPresets")}</button>
        <button className={`${buttonClass} mt-2 w-full border border-border bg-bg-2 text-fg-2`} onClick={() => edit()}>{label("writeOwn")}</button>
      </div> : <>
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-xs text-fg-2">{t("collaborationInstructions.enabledCount", { count: items.filter(item => item.enabled).length })}</p>
          <button className={`${buttonClass} flex shrink-0 items-center gap-1 border border-border`} onClick={() => setView("presets")}><Plus size={13} aria-hidden />{label("add")}</button>
        </div>
        <div className="space-y-3">{items.map(item => <article key={item.id} className={`rounded-xl border border-border p-3.5 ${item.enabled ? "bg-bg-2" : "bg-bg-1"}`}>
          <div className="flex items-start justify-between gap-3">
            <button className={`min-w-0 flex-1 break-words text-left text-[13px] font-medium leading-relaxed hover:text-accent ${item.enabled ? "text-fg" : "text-fg-3"}`} onClick={() => edit(item)}>{item.title}</button>
            <button role="switch" aria-checked={item.enabled} aria-label={t("collaborationInstructions.toggle", { title: item.title })} disabled={busy} onClick={() => void commit({ ...item, enabled: !item.enabled }, item)} className={`relative mt-1 h-[18px] w-8 shrink-0 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 ${item.enabled ? "bg-accent" : "bg-hover"}`}><span className={`absolute top-[3px] h-3 w-3 rounded-full transition-transform ${item.enabled ? "left-[17px] bg-accent-fg" : "left-[3px] bg-fg-3"}`} /></button>
          </div>
          <p className="mt-2 line-clamp-2 break-words text-xs leading-relaxed text-fg-2">{item.description}</p>
          {!!item.references?.length && <div className="mt-2.5 flex flex-wrap gap-1.5">{item.references.map(ref => <button key={`${ref.kind}:${ref.entityId}`} disabled={preview.active || !isLive(ref)} onClick={() => locateRequirementReference(ref, project)} className="max-w-full truncate rounded-md border border-border px-2 py-1 text-[11px] text-fg-2 hover:text-accent disabled:text-status-warning" title={ref.label}>{ref.ref ? `${ref.ref} · ` : ""}{ref.label}{!isLive(ref) ? ` · ${label("missingReference")}` : ""}</button>)}</div>}
        </article>)}</div>
      </>)}
      {view === "presets" && <>
        <div className="flex justify-between gap-2"><button className={buttonClass} onClick={() => setView("list")}><ArrowLeft size={13} className="mr-1 inline" />{label("back")}</button><button className={`${buttonClass} text-accent`} onClick={() => edit()}>{label("writeOwn")}</button></div>
        <h3 className="mt-5 text-sm font-medium">{label("fromPresets")}</h3><p className="mb-3 mt-2 text-xs leading-relaxed text-fg-2">{label("presetHint")}</p>
        {PRESETS.map(id => <button key={id} onClick={() => edit(undefined, id)} className="block w-full border-b border-border py-4 text-left hover:text-accent"><strong className="text-[13px] font-medium">{label(`presets.${id}.title`)}</strong><p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-fg-2">{label(`presets.${id}.description`)}</p></button>)}
      </>}
      {view === "edit" && draft && <form id={`instruction-form-${project.id}`} onSubmit={event => { event.preventDefault(); save(); }}>
        <fieldset disabled={busy}>
          <button type="button" className={`${buttonClass} mb-4`} onClick={() => setView("list")}><ArrowLeft size={13} className="mr-1 inline" />{label("back")}</button>
          <label className="block text-xs text-fg-2">{label("fieldTitle")}<input autoFocus value={draft.title} maxLength={limits.title} onChange={event => setDraft({ ...draft, title: event.target.value })} className={fieldClass} /></label>
          <label className="mt-5 block text-xs text-fg-2">{label("description")}<textarea value={draft.description} maxLength={limits.description} rows={7} onChange={event => setDraft({ ...draft, description: event.target.value })} className={`${fieldClass} resize-y leading-relaxed`} /></label>
          <details className="mt-5 text-xs text-fg-2"><summary className="py-1">{label("references")} ({draft.references?.length ?? 0})</summary>
            <div className="mt-2 space-y-2">
              {targets.map(target => {
                const selected = draft.references?.find(ref => ref.entityId === target.entityId && ref.kind === target.kind);
                return <div key={`${target.kind}:${target.entityId}`} className="rounded-lg border border-border p-2">
                  <label className="flex items-start gap-2"><input type="checkbox" className="mt-1 accent-accent" checked={!!selected} onChange={event => {
                    const refs = draft.references ?? [];
                    const marked = Object.values(references).find(ref => ref.entityId === target.entityId && ref.kind === target.kind);
                    setDraft({ ...draft, references: event.target.checked ? [...refs, { kind: target.kind, entityId: target.entityId, label: target.label, timing: target.timing, ref: marked ? `A${marked.number}` : "" }] : refs.filter(ref => ref !== selected) });
                  }} /><span className="min-w-0 break-words">{target.label}</span></label>
                  {selected && <div className="mt-2 grid grid-cols-2 gap-2">{(["startSeconds", "endSeconds"] as const).map(key => <label key={key}>{label(key)}<input type="number" min="0" step="any" value={selected.timing[key] ?? ""} className={`${fieldClass} px-2 py-1`} onChange={event => setDraft({ ...draft, references: draft.references?.map(ref => ref === selected ? { ...ref, timing: { ...ref.timing, [key]: event.target.value === "" ? null : Number(event.target.value) } } : ref) })} /></label>)}</div>}
                </div>;
              })}
              {draft.references?.filter(ref => !isLive(ref)).map(ref => <div key={`${ref.kind}:${ref.entityId}`} className="flex items-center gap-2 text-status-warning"><span className="min-w-0 break-words">{ref.label} · {label("missingReference")}</span><button type="button" aria-label={`${label("removeReference")} ${ref.label}`} onClick={() => setDraft({ ...draft, references: draft.references?.filter(item => item !== ref) })}><Trash2 size={13} /></button></div>)}
              {!targets.length && !draft.references?.length && <p>{label("noReferences")}</p>}
            </div>
          </details>
        </fieldset>
      </form>}
    </div>
    {error && <p role="alert" className="shrink-0 px-4 py-2 text-xs leading-relaxed text-status-error">{error}</p>}
    {view === "edit" && <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-3">
      <button type="submit" form={`instruction-form-${project.id}`} disabled={busy} className={`${buttonClass} bg-accent font-medium text-accent-fg hover:bg-accent-strong disabled:opacity-50`}>{original ? label("save") : label("addToProject")}</button>
      <button type="button" disabled={busy} className={`${buttonClass} border border-border text-fg-2`} onClick={() => setView("list")}>{label("cancel")}</button>
      {original && <button type="button" disabled={busy} aria-label={label("delete")} title={label("delete")} onClick={() => void commit(original, original, true)} className={`${buttonClass} ml-auto text-fg-3 hover:text-status-error`}><Trash2 size={14} /></button>}
    </div>}
    <p role="status" className="shrink-0 border-t border-border px-4 py-3 text-[11px] leading-relaxed text-fg-3">{saved ? label("saved") : label("scope")}</p>
  </section>;
}
