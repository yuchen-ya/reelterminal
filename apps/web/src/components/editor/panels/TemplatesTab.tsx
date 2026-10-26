import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, FileStack, Pencil, Plus, Trash2 } from "lucide-react";
import type { Template, TemplateReplacements } from "@reelterminal/core";
import { useProjectStore } from "../../../stores/project-store";
import { useRouter } from "../../../hooks/use-router";
import { listProjectTemplates, loadProjectTemplate, createProjectFromTemplate, deleteProjectTemplate, inspectProjectTemplate, type ProjectTemplateSummary } from "../../../services/project-templates";
import { SaveTemplateDialog } from "../SaveTemplateDialog";
import { TemplateVariablesPanel } from "../inspector/TemplateVariablesPanel";
import { AssetSearch } from "../asset-browser-controls";

function cover(template: Pick<Template, "thumbnailUrl">): string | null {
  return template.thumbnailUrl?.match(/^data:image\/(png|jpeg|webp);base64,/) ? template.thumbnailUrl : null;
}

export function TemplatesTab({ onTemplateApplied }: { onTemplateApplied?: () => void }) {
  const { t } = useTranslation();
  const { navigate } = useRouter();
  const project = useProjectStore((state) => state.project);
  const canSave = useProjectStore((state) => state.hasOpenProject && !state.readOnlyPreview);
  const [templates, setTemplates] = useState<ProjectTemplateSummary[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [values, setValues] = useState<TemplateReplacements>({});
  const [missing, setMissing] = useState<string[] | null>(null);
  const [dependencyError, setDependencyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveDialog, setSaveDialog] = useState<"new" | Template | null>(null);
  // Detail loads are async; only the most recent choose (or the project-id
  // reset below) may still apply its result, so a slow stale load cannot
  // resurrect a selection the user has already moved past.
  const chooseToken = useRef(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTemplates(await listProjectTemplates());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { chooseToken.current++; setSelected(null); setSaveDialog(null); }, [project.id]);
  // Legacy (v1) templates resolve source media from the active project's
  // library, so the audit tracks that library's identity; snapshot (v2)
  // templates are self-contained, and unrelated project commits must not
  // re-run the full snapshot clone plus dependency scan.
  const legacySourceItems = selected && !selected.projectSnapshot ? project.mediaLibrary.items : null;
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setMissing(null);
    setDependencyError(null);
    void inspectProjectTemplate(selected, values, project).then((items) => {
      if (!cancelled) setMissing(items);
    }, (cause: unknown) => {
      if (!cancelled) setDependencyError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- audit inputs are [selected, values, project identity, legacySourceItems]
  }, [selected, values, project.id, legacySourceItems]);

  const choose = async (summary: ProjectTemplateSummary) => {
    const request = ++chooseToken.current;
    setError(null);
    try {
      const detail = await loadProjectTemplate(summary.id);
      if (request !== chooseToken.current) return;
      if (!detail) throw new Error(t("personalTemplates.notFound"));
      setSelected(detail);
      setName(detail.name);
      setValues({});
      setMissing(null);
    } catch (cause) {
      if (request === chooseToken.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const create = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await createProjectFromTemplate(selected.id, name, values);
      setSelected(null);
      onTemplateApplied?.();
      if (window.reelterminal?.platform !== "desktop") navigate("editor");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!selected || !window.confirm(t("personalTemplates.deleteConfirm", { name: selected.name }))) return;
    setBusy(true);
    try {
      await deleteProjectTemplate(selected.id);
      setSelected(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  const search = query.trim().toLocaleLowerCase();
  const filtered = templates.filter((template) => [template.name, template.description, ...template.tags].join(" ").toLocaleLowerCase().includes(search));

  return <section className="flex-1 min-h-0 h-full overflow-y-auto p-4 space-y-4">
    {error && <p role="alert" className="text-xs text-status-error">{error}</p>}
    {selected ? <>
      <button type="button" disabled={busy} className="asset-browser-button" onClick={() => setSelected(null)}><ArrowLeft size={14} />{t("personalTemplates.back")}</button>
      <div className="aspect-video rounded-lg border border-border bg-background-secondary flex items-center justify-center overflow-hidden">
        {cover(selected) ? <img src={cover(selected)!} alt={selected.name} className="w-full h-full object-contain" /> : <span className="text-xs text-text-muted">{t("personalTemplates.noCover")}</span>}
      </div>
      <p className="text-[10px] text-text-muted">{t("personalTemplates.coverPreview")}</p>
      <h3 className="font-medium text-text-primary">{selected.name}</h3>
      <p className="text-xs whitespace-pre-wrap text-text-muted">{selected.description}</p>
      <p className="text-xs text-text-muted">{selected.settings.width} × {selected.settings.height} · {selected.settings.frameRate} fps · {selected.timeline.duration.toFixed(1)} s</p>
      <p className="text-xs text-text-muted">{selected.tags.map((tag) => `#${tag}`).join(" ")}</p>
      {!selected.projectSnapshot && <p className="text-xs leading-5 text-status-warning">{t("personalTemplates.legacy")}</p>}
      <div className="flex gap-2">
        <button type="button" className="asset-browser-button" disabled={busy} onClick={() => setSaveDialog(selected)}><Pencil size={13} />{t("personalTemplates.edit")}</button>
        <button type="button" className="asset-browser-button" disabled={busy} onClick={() => void remove()}><Trash2 size={13} />{t("personalTemplates.delete")}</button>
      </div>
      {!selected.projectSnapshot && selected.placeholders.length > 0 && <TemplateVariablesPanel template={selected} values={values} onChange={setValues} />}
      <p className="text-xs leading-5 text-text-muted">{t("personalTemplates.newNotice")}</p>
      {dependencyError ? <p role="alert" className="text-xs text-status-warning">{dependencyError}</p>
        : missing === null ? <p className="text-xs text-text-muted">{t("personalTemplates.checking")}</p>
        : <p className={`text-xs ${missing.length ? "text-status-warning" : "text-text-muted"}`}>{missing.length
          ? t("personalTemplates.missingDependencies", { items: missing.join(", ") }) : t("personalTemplates.ready")}</p>}
      <label className="block text-xs">{t("personalTemplates.projectName")}<input value={name} onChange={(event) => setName(event.target.value)} disabled={busy}
        className="mt-1 w-full rounded-lg border border-border bg-background-secondary px-3 py-2 text-sm" /></label>
      <button type="button" onClick={() => void create()} disabled={busy || !name.trim() || missing === null || missing.length > 0 || !!dependencyError}
        className="asset-browser-button w-full bg-primary text-white disabled:opacity-50">{t(busy ? "personalTemplates.creating" : "personalTemplates.create")}</button>
    </> : <>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t("personalTemplates.title")}</h3>
        {canSave && <button type="button" className="asset-browser-button" onClick={() => setSaveDialog("new")}><Plus size={14} />{t("personalTemplates.saveCurrent")}</button>}
      </div>
      <p className="text-xs leading-5 text-text-muted">{t("personalTemplates.intro")}</p>
      <AssetSearch value={query} onChange={setQuery} label={t("personalTemplates.search")} />
      {loading ? <p className="text-xs text-text-muted">{t("Loading templates...")}</p> : filtered.length === 0 ? <p className="text-xs text-text-muted py-8 text-center">{t(query ? "personalTemplates.noResults" : "personalTemplates.empty")}</p> :
        <div className="grid grid-cols-2 gap-3">{filtered.map((template) => <button type="button" key={template.id} aria-label={template.name}
          onClick={() => void choose(template)} className="h-auto min-w-0 flex flex-col items-stretch rounded-lg border border-border bg-background-secondary p-3 text-left hover:border-primary">
          <span className="aspect-video w-full flex items-center justify-center overflow-hidden rounded bg-background-tertiary mb-2">
            {cover(template) ? <img src={cover(template)!} alt="" className="w-full h-full object-cover" /> : <FileStack size={22} className="text-text-muted" />}
          </span>
          <span className="truncate text-xs font-medium">{template.name}</span>
          <span className="text-[10px] text-text-muted mt-1">{template.duration.toFixed(1)} s · {t(template.hasSnapshot ? "personalTemplates.local" : "personalTemplates.legacyLabel")}</span>
        </button>)}</div>}
      {error && <button type="button" className="asset-browser-button" onClick={() => void refresh()}>{t("templates.retry")}</button>}
    </>}
    {saveDialog && <SaveTemplateDialog isOpen template={saveDialog === "new" ? undefined : saveDialog} onClose={() => setSaveDialog(null)}
      onSaved={() => { setSelected(null); void refresh(); }} />}
  </section>;
}
