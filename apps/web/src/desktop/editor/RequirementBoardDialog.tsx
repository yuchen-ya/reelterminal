import { useEffect, useMemo, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { MessageSquare, Plus, Trash2, X } from "@/icons/lucide-compat";
import type { ProjectRequirementStatus } from "@reelterminal/core";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";

export const REQUIREMENT_BOARD_MODAL_ID = "requirement-board";

const STATUS_ORDER: readonly ProjectRequirementStatus[] = [
  "ready",
  "in_progress",
  "blocked",
  "done",
  "draft",
];

const INSTRUCTIONS = ["planFirst", "execute", "inspectOnly"] as const;

export function RequirementBoardDialog(): JSX.Element | null {
  const { t } = useTranslation();
  const open = useUIStore((state) => state.activeModal === REQUIREMENT_BOARD_MODAL_ID);
  const close = useUIStore((state) => state.closeModal);
  const project = useProjectStore((state) => state.project);
  const add = useProjectStore((state) => state.addProjectRequirement);
  const update = useProjectStore((state) => state.updateProjectRequirement);
  const remove = useProjectStore((state) => state.removeProjectRequirement);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instruction, setInstruction] = useState("");
  const [markerIds, setMarkerIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, open]);

  const requirements = useMemo(
    () => [...(project.requirements?.items ?? [])].sort((a, b) => b.updatedAt - a.updatedAt),
    [project.requirements],
  );
  const markers = useMemo(
    () => [...(project.markers?.items ?? [])].sort((a, b) => a.number - b.number),
    [project.markers],
  );

  if (!open || typeof document === "undefined") return null;

  const createRequirement = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const result = await add({
        title,
        description,
        instruction,
        markerIds,
        status: "ready",
      });
      if (result.success) {
        setTitle("");
        setDescription("");
        setInstruction("");
        setMarkerIds([]);
      }
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-black/50 p-5" onClick={close}>
      <div role="dialog" aria-modal="true" aria-label={t("requirementBoard.title")} className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-bg-1 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <MessageSquare size={16} className="text-accent" aria-hidden />
          <h2 className="flex-1 text-sm font-bold text-fg">{t("requirementBoard.title")}</h2>
          <button type="button" aria-label={t("common.close")} onClick={close} className="grid h-7 w-7 place-items-center rounded text-fg-muted hover:bg-hover hover:text-fg"><X size={15} /></button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,0.8fr)_minmax(340px,1.2fr)] overflow-hidden">
          <section className="overflow-y-auto border-r border-border p-4">
            <h3 className="text-xs font-semibold text-fg">{t("requirementBoard.new")}</h3>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("requirementBoard.titlePlaceholder")} className="mt-3 w-full rounded-md border border-border bg-bg-2 px-3 py-2 text-xs text-fg outline-none focus:border-accent" />
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("requirementBoard.descriptionPlaceholder")} rows={5} className="mt-2 w-full resize-y rounded-md border border-border bg-bg-2 px-3 py-2 text-xs text-fg outline-none focus:border-accent" />
            <p className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">{t("requirementBoard.oneTimeInstruction")}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {INSTRUCTIONS.map((key) => (
                <button key={key} type="button" onClick={() => setInstruction(t(`requirementBoard.instructions.${key}`))} className="rounded-md border border-border bg-bg-2 px-2 py-1 text-[10px] text-fg-2 hover:border-accent hover:text-fg">{t(`requirementBoard.instructionLabels.${key}`)}</button>
              ))}
            </div>
            <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={t("requirementBoard.instructionPlaceholder")} rows={3} className="mt-2 w-full resize-y rounded-md border border-border bg-bg-2 px-3 py-2 text-xs text-fg outline-none focus:border-accent" />
            {markers.length > 0 ? <>
              <p className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">{t("requirementBoard.references")}</p>
              <div className="mt-1.5 max-h-28 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                {markers.map((marker) => <label key={marker.id} className="flex items-center gap-2 text-[11px] text-fg-2"><input type="checkbox" checked={markerIds.includes(marker.id)} onChange={(event) => setMarkerIds((current) => event.target.checked ? [...current, marker.id] : current.filter((id) => id !== marker.id))} /><span className="font-mono text-status-warning">R{marker.number}</span><span className="truncate">{marker.label ?? t("requirementBoard.unnamedReference")}</span></label>)}
              </div>
            </> : null}
            <button type="button" disabled={busy || !title.trim()} onClick={() => void createRequirement()} className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-accent-fg disabled:opacity-50"><Plus size={14} />{t("requirementBoard.publish")}</button>
          </section>
          <section className="overflow-y-auto p-4">
            <div className="flex items-center justify-between"><h3 className="text-xs font-semibold text-fg">{t("requirementBoard.items")}</h3><span className="text-[10px] text-fg-muted">{t("requirementBoard.pullHint")}</span></div>
            {requirements.length === 0 ? <p className="mt-8 text-center text-xs text-fg-muted">{t("requirementBoard.empty")}</p> : <ul className="mt-3 space-y-2">{requirements.map((item) => (
              <li key={item.id} className="rounded-lg border border-border bg-bg-2/60 p-3">
                <div className="flex items-center gap-2"><span className="font-mono text-[11px] font-bold text-accent">Q{item.number}</span><strong className="min-w-0 flex-1 truncate text-xs text-fg">{item.title}</strong><select value={item.status} onChange={(event) => void update(item.id, { status: event.target.value as ProjectRequirementStatus })} className="rounded border border-border bg-bg-1 px-1.5 py-1 text-[10px] text-fg-2">{STATUS_ORDER.map((status) => <option key={status} value={status}>{t(`requirementBoard.status.${status}`)}</option>)}</select><button type="button" aria-label={t("requirementBoard.remove")} onClick={() => void remove(item.id)} className="text-fg-muted hover:text-status-error"><Trash2 size={13} /></button></div>
                {item.description ? <p className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-fg-2">{item.description}</p> : null}
                {item.instruction ? <p className="mt-2 rounded bg-bg-3 px-2 py-1.5 text-[10px] text-fg-muted">{item.instruction}</p> : null}
                {item.markerIds.length > 0 ? <p className="mt-2 text-[10px] text-status-warning">{item.markerIds.map((id) => { const marker = markers.find((entry) => entry.id === id); return marker ? `R${marker.number}` : id; }).join(" · ")}</p> : null}
                {item.agentNote ? <p className="mt-2 border-l-2 border-accent pl-2 text-[10px] text-fg-2">{item.agentNote}</p> : null}
              </li>
            ))}</ul>}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
