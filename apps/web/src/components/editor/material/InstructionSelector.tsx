import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search, Check, ArrowUpRight } from "@/icons/lucide-compat";
import type { CollaborationInstruction, MaterialRecord } from "@reelterminal/core";
import { getMaterialLibraryService } from "../../../services/material-library/library-service";
import { INSTRUCTION_PRESETS } from "./InstructionLibraryPicker";

export interface InstructionChoice {
  title: string;
  description: string;
  presetId?: string;
}

export function InstructionSelector({ items, busy, onSelect, onCreate, onManage }: {
  items: readonly CollaborationInstruction[];
  busy: boolean;
  onSelect: (choice: InstructionChoice) => void;
  onCreate: () => void;
  onManage: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<readonly MaterialRecord[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void getMaterialLibraryService().list({ kind: "instruction", query, page: 1, pageSize: 100 })
      .then(result => {
        if (!active) return;
        if (result.ok) setRecords(result.value.items);
        else setError(result.message);
      })
      .catch(error => { if (active) setError(String(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [query]);

  const builtins = INSTRUCTION_PRESETS.map(presetId => ({
    presetId,
    title: t(`collaborationInstructions.presets.${presetId}.title`),
    description: t(`collaborationInstructions.presets.${presetId}.description`),
  })).filter(choice => `${choice.title} ${choice.description}`.toLowerCase().includes(query.trim().toLowerCase()));

  function row(choice: InstructionChoice, key: string) {
    const added = items.some(item => item.description === choice.description);
    return <button
      key={key}
      type="button"
      disabled={busy || added}
      onClick={() => onSelect(choice)}
      className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:opacity-50"
      title={choice.description}
      aria-label={choice.title}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-fg">{choice.title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-fg-3">{choice.description}</span>
      </span>
      {added ? <Check size={14} className="shrink-0 text-accent" /> : <Plus size={14} className="shrink-0 text-fg-3" />}
    </button>;
  }

  return <div className="flex flex-col">
    <label className="flex items-center gap-2 border-b border-border px-3 py-3">
      <Search size={15} className="shrink-0 text-fg-3" />
      <input autoFocus value={query} onChange={event => setQuery(event.target.value)}
        aria-label={t("material.instructionSearch")} placeholder={t("material.instructionSearch")}
        className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none" />
    </label>
    <div className="max-h-[min(340px,45vh)] overflow-y-auto p-1.5 custom-scrollbar">
      {loading && <p className="px-3 py-2 text-xs text-fg-3">{t("material.loadingPreview")}</p>}
      {records.length > 0 && <p className="px-3 pb-1 pt-2 text-[10px] text-fg-3">{t("collaborationInstructions.personal")}</p>}
      {records.map(record => record.kind === "instruction" && row({ title: record.title, description: record.prompt }, record.id))}
      {builtins.length > 0 && <p className="px-3 pb-1 pt-2 text-[10px] text-fg-3">{t("material.builtinInstructions")}</p>}
      {builtins.map(choice => row(choice, choice.presetId))}
      {!loading && !records.length && !builtins.length && <p className="px-3 py-6 text-center text-xs text-fg-3">{t("collaborationInstructions.noMatches")}</p>}
      {error && <p role="alert" className="px-3 py-2 text-xs text-status-error">{error}</p>}
    </div>
    <div className="flex items-center justify-between gap-2 border-t border-border p-2">
      <button disabled={busy} onClick={onCreate} className="flex items-center gap-1.5 rounded px-2 py-2 text-xs text-fg hover:bg-hover"><Plus size={13} />{t("collaborationInstructions.writeOwn")}</button>
      <button disabled={busy} onClick={onManage} className="flex items-center gap-1 rounded px-2 py-2 text-xs text-fg-2 hover:bg-hover">{t("collaborationInstructions.manageLibrary")}<ArrowUpRight size={13} /></button>
    </div>
  </div>;
}
