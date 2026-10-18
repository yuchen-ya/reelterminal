import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MaterialRecord } from "@reelterminal/core";
import { getMaterialLibraryService } from "../../../services/material-library/library-service";
import { useMaterialLibraryStore } from "../../../stores/material-library-store";
import { InstructionFields } from "./InstructionFields";

export const INSTRUCTION_PRESETS = ["visual", "explain", "sample", "compare", "preserve", "review", "resources", "tool", "skill"] as const;

export function InstructionLibraryPicker({ onSelect }: { onSelect?: (record: MaterialRecord) => void }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<readonly MaterialRecord[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<{ title: string; description: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void getMaterialLibraryService().list({ kind: "instruction", query, page: 1, pageSize: 100 }).then(result => {
      if (active && result.ok) setItems(result.value.items);
    }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [query, draft]);
  async function save() {
    if (!draft || busy) return;
    if (!draft.title.trim() || !draft.description.trim()) {
      setError(t("collaborationInstructions.required")); return;
    }
    if (/【[^】]+】/.test(draft.description)) {
      setError(t("collaborationInstructions.placeholder")); return;
    }
    setBusy(true); setError("");
    try {
      const result = await getMaterialLibraryService().create({ kind: "instruction", title: draft.title.trim(), prompt: draft.description.trim() }, "user");
      if (!result.ok) { setError(result.message); return; }
      setDraft(null);
      await useMaterialLibraryStore.getState().refresh();
      onSelect?.(result.value.material);
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  const button = "rounded border border-border px-2 py-1.5 text-xs hover:bg-hover";
  return <div className="space-y-3">
    {draft ? <><InstructionFields {...draft} onChange={setDraft} /><button className={button} disabled={busy} onClick={() => void save()}>{t("collaborationInstructions.saveLibrary")}</button> <button className={button} disabled={busy} onClick={() => setDraft(null)}>{t("collaborationInstructions.cancel")}</button></> : <>
      <div className="flex gap-2"><input aria-label={t("material.instructionSearch")} placeholder={t("material.instructionSearch")} className="min-w-0 flex-1 rounded border border-border bg-bg p-2 text-xs" value={query} onChange={e => setQuery(e.target.value)} /><button className={button} onClick={() => setDraft({ title: "", description: "" })}>{t("collaborationInstructions.writeOwn")}</button></div>
      <div className="flex flex-wrap gap-2">{items.map(item => <button key={item.id} className={button} title={item.kind === "instruction" ? item.prompt : item.title} onClick={() => onSelect ? onSelect(item) : useMaterialLibraryStore.getState().openDetail(item.id)}>{item.title}</button>)}</div>
      <details><summary className="cursor-pointer text-xs text-fg-2">{t("material.builtinInstructions")}</summary><div className="mt-2 flex flex-wrap gap-2">{INSTRUCTION_PRESETS.map(id => <button key={id} className={button} onClick={() => setDraft({ title: t(`collaborationInstructions.presets.${id}.title`), description: t(`collaborationInstructions.presets.${id}.description`) })}>{t(`collaborationInstructions.presets.${id}.title`)}</button>)}</div></details>
    </>}
    {error && <p role="alert" className="text-xs text-status-error">{error}</p>}
  </div>;
}
