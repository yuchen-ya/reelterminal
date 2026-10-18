import { NODE_PALETTE } from "./node-palette";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { useStore, type StoreApi } from "zustand";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, X, GripVertical } from "@/icons/lucide-compat";
import { COLLABORATION_INSTRUCTION_LIMITS as limits, type CollaborationInstruction, type RequirementReference } from "@reelterminal/core";
import type { ProjectState } from "../../stores/project-store";
import { getAgentReferenceTargetsForProject } from "../../stores/agent-reference-targets";
import { useAgentReferencesStore } from "../../stores/agent-references-store";
import { InstructionFields } from "../../components/editor/material/InstructionFields";
import { InstructionSelector, type InstructionChoice } from "../../components/editor/material/InstructionSelector";
import { useMaterialLibraryStore } from "../../stores/material-library-store";
import { ToolcraftPopover, ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@reelterminal/ui";
import { getMaterialLibraryService } from "../../services/material-library/library-service";

const fieldClass = "mt-1.5 w-full rounded-lg border border-border bg-bg-2 px-3 py-2.5 text-[13px] text-fg outline-none focus:border-accent";
const buttonClass = "rounded-lg px-3 py-2 text-xs transition-colors hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

export function CollaborationInstructionsPanel({ store, active = true }: { store: StoreApi<ProjectState>; active?: boolean }) {
  const { t } = useTranslation();
  const project = useStore(store, state => state.project);
  const references = useAgentReferencesStore(state => state.references);
  const items = project.collaborationInstructions?.items ?? [];
  // Creation order assigns distinct nearby colors; sorting and renaming never recolor chips.
  const colors = new Map([...items]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((item, index) => [item.id, NODE_PALETTE[index % NODE_PALETTE.length]]));
  const targets = getAgentReferenceTargetsForProject(project);
  const [view, setView] = useState<"list" | "presets" | "edit">("list");
  const [draft, setDraft] = useState<CollaborationInstruction | null>(null);
  const [original, setOriginal] = useState<CollaborationInstruction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  useEffect(() => { if (!saved) return; const timer = setTimeout(() => setSaved(false), 1800); return () => clearTimeout(timer); }, [saved]);
  const label = (key: string) => t(`collaborationInstructions.${key}`);
  const isLive = (ref: RequirementReference) => targets.some(target => target.kind === ref.kind && target.entityId === ref.entityId);

  function edit(item?: CollaborationInstruction, choice?: InstructionChoice) {
    const now = Date.now();
    setOriginal(item ?? null);
    setDraft(item ? structuredClone(item) : {
      id: crypto.randomUUID(), title: choice?.title ?? "",
      description: choice?.description ?? "",
      enabled: true, references: [], ...(choice?.presetId ? { presetId: choice.presetId } : {}), createdAt: now, updatedAt: now,
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
    finally { setBusy(false); }
  }

  function save() {
    if (!draft) return;
    const title = draft.title.trim(), description = draft.description.trim();
    if (!title || !description) { setError(label("required")); return; }
    if (/【[^】]+】/.test(description)) { setError(label("placeholder")); return; }
    void commit({ ...draft, title, description }, original);
  }

  function choose(choice: InstructionChoice) {
    if (/【[^】]+】/.test(choice.description)) { edit(undefined, choice); return; }
    const now = Date.now();
    void commit({ ...choice, id: crypto.randomUUID(), enabled: true, references: [], createdAt: now, updatedAt: now }, null);
  }

  function manageLibrary() {
    setView("list");
    void useMaterialLibraryStore.getState().setFilters({ kind: "instruction", query: "", status: "all", tag: null });
    window.dispatchEvent(new Event("reelterminal:open-instruction-library"));
  }

  const editor = draft && (
    <form onSubmit={event => { event.preventDefault(); save(); }}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-xs font-semibold">{original ? label("editTitle") : label("writeOwn")}</h3>
        <button type="button" disabled={busy} aria-label={t("Close dialog")} onClick={() => setView("list")} className="rounded p-1 text-fg-3 hover:bg-hover"><X size={14} /></button>
      </div>
      <fieldset disabled={busy} className="max-h-[min(440px,60vh)] overflow-y-auto p-4 custom-scrollbar">
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
      {error && <p role="alert" className="px-4 pb-2 text-xs text-status-error">{error}</p>}
      <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        {original && <button type="button" disabled={busy} aria-label={label("delete")} onClick={() => void commit(original, original, true)} className="mr-auto rounded p-2 text-fg-3 hover:bg-hover hover:text-status-error"><Trash2 size={14} /></button>}
        <button type="button" disabled={busy} onClick={() => setView("list")} className={`${buttonClass} text-fg-2`}>{label("cancel")}</button>
        <button type="submit" disabled={busy} className={`${buttonClass} bg-accent font-medium text-accent-fg disabled:opacity-50`}>{original ? label("save") : label("addToProject")}</button>
      </div>
    </form>
  );
  const popoverClass = "!w-[360px] max-w-[calc(100vw-24px)] border-border bg-bg text-fg shadow-xl";

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={label("title")}>
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-2 pt-3">
        <span role="status" className="text-[11px] text-fg-3">{saved ? label("saved") : ""}</span>
        <ToolcraftPopover
          label={view === "presets" ? label("addInstruction") : label("writeOwn")}
          alignment="end" className={popoverClass}
          isOpen={active && (view === "presets" || (view === "edit" && (!original || !items.some(item => item.id === original.id))))}
          onOpenChange={open => { if (!busy) { setError(""); setView(open ? "presets" : "list"); } }}
          content={view === "presets" ? <>
            <InstructionSelector items={items} busy={busy} onSelect={choose} onCreate={() => edit()} onManage={manageLibrary} />
            {error && <p role="alert" className="px-3 pb-3 text-xs text-status-error">{error}</p>}
          </> : (!original || !items.some(item => item.id === original.id)) ? editor : null}
        >
          <button disabled={busy} className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-bg-2 px-2.5 text-xs font-medium text-fg hover:border-accent hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
            <Plus size={14} />{label("addInstruction")}
          </button>
        </ToolcraftPopover>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 custom-scrollbar">
        {!items.length && <p className="py-3 text-xs text-fg-3">{label("emptyHint")}</p>}
        <TooltipProvider delayDuration={450}>
          <div className="flex flex-wrap gap-2" aria-label={label("title")}>
            {items.map((item, index) => (
              <ContextMenu key={item.id}>
                <ContextMenuTrigger asChild>
                  <div
                    data-instruction-id={item.id}
                    style={{
                      backgroundColor: `${colors.get(item.id)}${item.enabled ? "14" : "08"}`,
                      borderColor: dropId === item.id ? colors.get(item.id) : `${colors.get(item.id)}${item.enabled ? "66" : "30"}`,
                    }}
                    draggable={!busy && view === "list"}
                    onDragStart={event => { event.dataTransfer.setData("text/plain", item.id); setDragId(item.id); }}
                    onDragEnd={() => { setDragId(null); setDropId(null); }}
                    onDragOver={event => { if (dragId) { event.preventDefault(); setDropId(item.id); } }}
                    onDrop={event => { event.preventDefault(); if (dragId) void reorder(dragId, item.id); }}
                    className={`group relative flex h-8 max-w-full items-center rounded-md border bg-bg-2 transition-colors ${dropId === item.id ? "border-accent ring-1 ring-accent" : "border-border hover:border-border-strong"} ${dragId === item.id ? "opacity-40" : ""} ${item.enabled ? "text-fg" : "text-fg-3 bg-bg"}`}
                  >
                    {dropId === item.id && dragId !== item.id && <span
                      aria-hidden
                      className={`pointer-events-none absolute -bottom-1 -top-1 w-0.5 rounded bg-accent ${items.findIndex(entry => entry.id === dragId) < index ? "-right-1.5" : "-left-1.5"}`}
                    />}
                    <span className="cursor-grab pl-1 text-fg-3 opacity-0 group-hover:opacity-100" aria-hidden><GripVertical size={10} /></span>
                    <button role="switch" aria-checked={item.enabled} aria-label={t("collaborationInstructions.toggle", { title: item.title })} disabled={busy} onClick={() => void commit({ ...item, enabled: !item.enabled }, item)} className="flex h-7 w-5 shrink-0 items-center justify-center rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                      <span style={{ backgroundColor: item.enabled ? colors.get(item.id) : undefined, borderColor: colors.get(item.id), opacity: item.enabled ? 1 : 0.5 }} className="h-1.5 w-1.5 rounded-full border" />
                    </button>
                    <Tooltip open={view === "list" && !dragId && hoverId === item.id} onOpenChange={open => setHoverId(open ? item.id : null)}>
                      <ToolcraftPopover
                        label={label("editTitle")} alignment="end" className={popoverClass}
                        isOpen={active && view === "edit" && original?.id === item.id}
                        onOpenChange={open => { if (!busy) { if (open) edit(item); else setView("list"); } }}
                        content={editor}
                      >
                        <TooltipTrigger asChild>
                          <button aria-label={item.title} className="h-7 min-w-0 max-w-52 truncate rounded pr-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent"
                            onKeyDown={event => {
                              if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                                event.preventDefault();
                                const target = items[index + (event.key === "ArrowLeft" ? -1 : 1)];
                                if (target) void reorder(item.id, target.id);
                              }
                            }}
                          >{item.title}</button>
                        </TooltipTrigger>
                      </ToolcraftPopover>
                      {createPortal(<TooltipContent side="bottom" align="end" className="max-w-72 whitespace-pre-wrap text-xs leading-relaxed">
                        <p className="font-medium">{item.title}</p><p className="mt-1 text-fg-2">{item.description}</p>
                      </TooltipContent>, document.body)}
                    </Tooltip>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="min-w-40">
                  <ContextMenuItem onSelect={() => edit(item)}>{label("details")}</ContextMenuItem>
                  <ContextMenuItem disabled={busy} onSelect={() => void commit({ ...item, enabled: !item.enabled }, item)}>{label(item.enabled ? "disable" : "enable")}</ContextMenuItem>
                  <ContextMenuItem disabled={busy || index === 0} onSelect={() => void reorder(item.id, items[index - 1]!.id)}>{label("moveEarlier")}</ContextMenuItem>
                  <ContextMenuItem disabled={busy || index === items.length - 1} onSelect={() => void reorder(item.id, items[index + 1]!.id)}>{label("moveLater")}</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem disabled={busy} onSelect={() => void saveLibrary(item)}>{label("saveLibrary")}</ContextMenuItem>
                  <ContextMenuItem disabled={busy} className="text-status-error" onSelect={() => void commit(item, item, true)}>{label("delete")}</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        </TooltipProvider>
        {error && view === "list" && <p role="alert" className="mt-3 text-xs text-status-error">{error}</p>}
      </div>
    </section>
  );
}
