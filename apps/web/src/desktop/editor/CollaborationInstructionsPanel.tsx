import { useEffect, useState } from "react";
import { useStore, type StoreApi } from "zustand";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Plus, Trash2 } from "@/icons/lucide-compat";
import { COLLABORATION_INSTRUCTION_LIMITS as limits, type CollaborationInstruction, type RequirementReference } from "@reelterminal/core";
import type { ProjectState } from "../../stores/project-store";
import { getAgentReferenceTargetsForProject } from "../../stores/agent-reference-targets";
import { useAgentReferencesStore } from "../../stores/agent-references-store";
import { InstructionFields } from "../../components/editor/material/InstructionFields";
import { InstructionLibraryPicker } from "../../components/editor/material/InstructionLibraryPicker";
import { getMaterialLibraryService } from "../../services/material-library/library-service";

const fieldClass = "mt-1.5 w-full rounded-lg border border-border bg-bg-2 px-3 py-2.5 text-[13px] text-fg outline-none focus:border-accent";
const buttonClass = "rounded-lg px-3 py-2 text-xs transition-colors hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

export function CollaborationInstructionsPanel({ store }: { store: StoreApi<ProjectState> }) {
  const { t } = useTranslation();
  const project = useStore(store, state => state.project);
  const references = useAgentReferencesStore(state => state.references);
  const items = project.collaborationInstructions?.items ?? [];
  const targets = getAgentReferenceTargetsForProject(project);
  const [view, setView] = useState<"list" | "presets" | "edit">("list");
  const [draft, setDraft] = useState<CollaborationInstruction | null>(null);
  const [original, setOriginal] = useState<CollaborationInstruction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  useEffect(() => { if (!saved) return; const timer = setTimeout(() => setSaved(false), 1800); return () => clearTimeout(timer); }, [saved]);
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
      const targetProjectId = project.id;
      const submit = () => {
        const state = store.getState();
        if (state.project.id !== targetProjectId) return { success: false, error: { message: label("conflict") } };
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
    } catch (error) { setError(String(error)); } finally {
      setBusy(false);
    }
  }

  async function reorder(id: string, target: string) {
    if (busy || id === target) return;
    const expected = items.map(item => item.id).join();
    const projectId = project.id;
    setBusy(true);
    try {
      const submit = () => {
        const state = store.getState();
        const current = state.project.collaborationInstructions?.items ?? [];
        if (state.project.id !== projectId || current.map(item => item.id).join() !== expected) throw new Error(label("conflict"));
        const from = current.findIndex(item => item.id === id), to = current.findIndex(item => item.id === target);
        if (from < 0 || to < 0) return;
        const next = [...current]; next.splice(to, 0, next.splice(from, 1)[0]!);
        const result = state.executeActionBatch([{ type: "project/setCollaborationInstructions", id: crypto.randomUUID(), timestamp: Date.now(), params: { instructions: { items: next } } }], { groupLabel: label("historyLabel"), historyOwner: "human" }).result;
        if (!result.success) throw new Error(result.error?.message ?? label("saveFailed"));
      };
      await (store.getState().submitWorkspaceMutation?.(submit) ?? submit());
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); setDragId(null); setDropId(null); }
  }

  async function saveLibrary(item: CollaborationInstruction) {
    setBusy(true);
    try {
      const result = await getMaterialLibraryService().create({ kind: "instruction", title: item.title, prompt: item.description }, "user");
      if (!result.ok) setError(result.message); else setSaved(true);
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); setMenuId(null); }
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

      {!items.length && view === "list" && <div className="space-y-2 text-xs text-fg-3"><p>{label("emptyTitle")}</p><button className={buttonClass} onClick={() => setView("presets")}>{label("fromPresets")}</button><button className={buttonClass} onClick={() => edit()}>{label("writeOwn")}</button></div>}
      <div className="mb-3 flex flex-wrap gap-2">{items.map((item, index) => <div key={item.id} draggable={!busy} onDragStart={() => setDragId(item.id)} onDragEnd={() => { setDragId(null); setDropId(null); }} onDragOver={event => { event.preventDefault(); setDropId(item.id); }} onDrop={event => { event.preventDefault(); if (dragId) void reorder(dragId, item.id); }} onContextMenu={event => { event.preventDefault(); setMenuId(item.id); }} onKeyDown={event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); setMenuId(item.id); } }} className={`group relative flex max-w-full items-center gap-1 rounded border px-2 py-1 text-xs ${dropId === item.id ? "border-accent ring-1 ring-accent" : "border-border"} ${item.enabled ? "text-fg bg-bg-2" : "text-fg-3"}`}>
        <button role="switch" aria-checked={item.enabled} aria-label={t("collaborationInstructions.toggle", { title: item.title })} disabled={busy} onClick={() => void commit({ ...item, enabled: !item.enabled }, item)} className={item.enabled ? "text-accent" : "text-fg-3"}>{item.enabled ? "●" : "○"}</button>
        <button className="max-w-48 truncate text-left" onClick={() => edit(item)} onKeyDown={event => { if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { event.preventDefault(); const target = items[index + (event.key === "ArrowLeft" ? -1 : 1)]; if (target) void reorder(item.id, target.id); } }} aria-describedby={`instruction-tip-${item.id}`}>{item.title}</button>
        <div role="tooltip" id={`instruction-tip-${item.id}`} className="pointer-events-none absolute left-0 top-full z-30 hidden w-64 max-w-[70vw] whitespace-pre-wrap rounded border border-border bg-bg p-3 shadow-lg group-hover:block group-focus-within:block"><strong>{item.title}</strong><p className="mt-1">{item.description}</p>{item.references?.map(ref => <p key={`${ref.kind}:${ref.entityId}`}>{ref.label}{!isLive(ref) ? ` · ${label("missingReference")}` : ""}</p>)}</div>
        {menuId === item.id && <div role="menu" className="absolute left-0 top-full z-40 flex min-w-32 flex-col rounded border border-border bg-bg p-1 shadow-lg" onKeyDown={event => { if (event.key === "Escape") setMenuId(null); }}>
          <button role="menuitem" className={buttonClass} onClick={() => { setMenuId(null); edit(item); }}>{label("details")}</button>
          <button role="menuitem" className={buttonClass} disabled={busy || index === 0} onClick={() => { setMenuId(null); void reorder(item.id, items[index - 1]!.id); }}>{label("moveEarlier")}</button>
          <button role="menuitem" className={buttonClass} disabled={busy || index === items.length - 1} onClick={() => { setMenuId(null); void reorder(item.id, items[index + 1]!.id); }}>{label("moveLater")}</button>
          <button role="menuitem" className={buttonClass} disabled={busy} onClick={() => void saveLibrary(item)}>{label("saveLibrary")}</button>
          <button role="menuitem" className={buttonClass} disabled={busy} onClick={() => { setMenuId(null); void commit(item, item, true); }}>{label("delete")}</button>
          <button role="menuitem" className={buttonClass} onClick={() => setMenuId(null)}>{label("cancel")}</button>
        </div>}
      </div>)}<button className="rounded border border-dashed border-border px-2 py-1 text-fg-3 hover:text-accent" onClick={() => setView(view === "presets" ? "list" : "presets")} aria-label={label("add")}><Plus size={14} /></button></div>
      {view === "presets" && <InstructionLibraryPicker onSelect={record => { if (record.kind === "instruction") { edit(); setDraft({ id: crypto.randomUUID(), title: record.title, description: record.prompt, references: [], enabled: true, createdAt: Date.now(), updatedAt: Date.now() }); } }} />}
      {view === "edit" && draft && <form id={`instruction-form-${project.id}`} onSubmit={event => { event.preventDefault(); save(); }}>
        <fieldset disabled={busy}>
          <button type="button" className={`${buttonClass} mb-4`} onClick={() => setView("list")}><ArrowLeft size={13} className="mr-1 inline" />{label("back")}</button>
          <InstructionFields title={draft.title} description={draft.description} onChange={value => setDraft({ ...draft, ...value })} />
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
    {saved && <p role="status" className="px-4 py-1 text-xs text-fg-3">{label("saved")}</p>}
  </section>;
}
