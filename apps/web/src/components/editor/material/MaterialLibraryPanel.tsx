/**
 * The user-level material library panel (the "Library" tab in the assets
 * panel). Independent of the current project: collect first (everything
 * lands in the inbox), organize later (filter, tag, batch), and attach to
 * the open project on demand. The agent's batch operations are visible and
 * one-click undoable from the journal menu.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Bot,
  BookMarked,
  FileVideo,
  Hash,
  Link2,
  Music,
  Plus,
  Scissors,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  SlidersHorizontal,
  CheckSquare,
  X,
  History,
} from "lucide-react";
import type { MaterialJournalEntry, MaterialKind, MaterialRecord } from "@reelterminal/core";
import { latestMaterialJournalEntry } from "@reelterminal/core";
import { ToolcraftEmptyState, ToolcraftPopover as Popover, ToolcraftDropdownMenu as DropdownMenu } from "@reelterminal/ui";
import { AssetSearch, AssetViewToggle, type AssetView } from "../asset-browser-controls";
import {
  getMaterialLibraryService,
  type MaterialServiceResult,
} from "../../../services/material-library/library-service";
import { saveLocalFileToLibrary } from "../../../services/material-library/project-save";
import { attachMaterialToProject } from "../../../services/material-library/attach";
import { useMaterialLibraryStore } from "../../../stores/material-library-store";
import { useProjectStore } from "../../../stores/project-store";
import { toast } from "../../../stores/notification-store";
import { InstructionLibraryPicker } from "./InstructionLibraryPicker";
import { addLibraryInstruction } from "../../../services/material-library/instructions";
import { MaterialDetailDialog } from "./MaterialDetailDialog";

const KIND_CHIPS: ReadonlyArray<{ value: MaterialKind | "all"; labelKey: string }> = [
  { value: "all", labelKey: "material.filter.all" },
  { value: "media", labelKey: "material.kind.media" },
  { value: "segment", labelKey: "material.kind.segment" },
  { value: "link", labelKey: "material.kind.link" },
  { value: "method", labelKey: "material.kind.method" },
  { value: "instruction", labelKey: "material.kind.instruction" },
];

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function RecordIcon({ record }: { readonly record: MaterialRecord }) {
  if (record.kind === "link") return <Link2 size={15} aria-hidden />;
  if (record.kind === "instruction") return <SlidersHorizontal size={15} aria-hidden />;
  if (record.kind === "method") return <Sparkles size={15} aria-hidden />;
  if (record.kind === "segment") return <Scissors size={15} aria-hidden />;
  if (record.mediaType === "audio") return <Music size={15} aria-hidden />;
  return <FileVideo size={15} aria-hidden />;
}

export function MaterialLibraryPanel() {
  const { t } = useTranslation();
  const store = useMaterialLibraryStore();
  const hasOpenProject = useProjectStore((s) => s.hasOpenProject);
  const [search, setSearch] = useState(store.filters.query);
  const [view, setView] = useState<AssetView>("list");
  const [selecting, setSelecting] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);
  const [batchTag, setBatchTag] = useState("");
  const [addLinkOpen, setAddLinkOpen] = useState(false);
  const [addLinkValue, setAddLinkValue] = useState("");
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [addMethodOpen, setAddMethodOpen] = useState(false);
  const [addMethodValue, setAddMethodValue] = useState({ skillName: "", prompt: "", steps: "" });
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchDebounce = useRef<number | null>(null);

  useEffect(() => {
    void store.refresh();
    void store.refreshJournal();
    // Agent-side library mutations (live bridge) nudge the panel so batch
    // results are visible the moment they commit.
    const onChanged = () => {
      void useMaterialLibraryStore.getState().refresh();
      void useMaterialLibraryStore.getState().refreshJournal();
    };
    window.addEventListener("reelterminal:material-library-changed", onChanged);
    return () => {
      window.removeEventListener("reelterminal:material-library-changed", onChanged);
      if (searchDebounce.current !== null) window.clearTimeout(searchDebounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSearchChange = (value: string) => {
    setSearch(value);
    if (searchDebounce.current !== null) {
      window.clearTimeout(searchDebounce.current);
    }
    searchDebounce.current = window.setTimeout(() => {
      void useMaterialLibraryStore.getState().setFilters({ query: value });
    }, 250);
  };

  const undoLatest = async (entry?: MaterialJournalEntry) => {
    const service = getMaterialLibraryService();
    const result = await service.undo(entry?.id, "user");
    if (!result.ok) {
      toast.error(t("material.undoFailed"), result.message);
      return;
    }
    // Restored records whose library blob bytes are gone (historical
    // data) must not read as an unqualified success.
    const missingCount = result.value.blobMissingIds.length;
    if (missingCount > 0) {
      toast.warning(
        t("material.undone"),
        t("material.undoneBlobMissing", { count: missingCount }),
      );
    } else {
      toast.success(
        t("material.undone"),
        t("material.undoneDetail", {
          restored: result.value.restored.length,
          removed: result.value.removed.length,
        }),
      );
    }
    await useMaterialLibraryStore.getState().refresh();
    await useMaterialLibraryStore.getState().refreshJournal();
  };

  const onFilesPicked = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    let saved = 0;
    for (const file of Array.from(files)) {
      const result = await saveLocalFileToLibrary(file);
      if (result.ok) saved += 1;
      else toast.error(t("material.addFailed"), result.error?.message ?? "failed");
    }
    setBusy(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (saved > 0) {
      toast.success(t("material.added"), t("material.addedCount", { count: saved }));
      await store.refresh();
      await store.refreshJournal();
    }
  };

  const createLink = async () => {
    setBusy(true);
    const result = await getMaterialLibraryService().create(
      { kind: "link", url: addLinkValue.trim() },
      "user",
    );
    setBusy(false);
    if (!result.ok) {
      toast.error(t("material.addFailed"), result.message);
      return;
    }
    setAddLinkOpen(false);
    setAddLinkValue("");
    toast.success(t("material.added"), result.value.material.title);
    await store.refresh();
    await store.refreshJournal();
  };

  const createMethod = async () => {
    setBusy(true);
    const result = await getMaterialLibraryService().create(
      {
        kind: "method",
        prompt: addMethodValue.prompt,
        ...(addMethodValue.skillName.trim()
          ? { skillName: addMethodValue.skillName.trim() }
          : {}),
        steps: addMethodValue.steps
          .split("\n")
          .map((step) => step.trim())
          .filter(Boolean),
      },
      "user",
    );
    setBusy(false);
    if (!result.ok) {
      toast.error(t("material.addFailed"), result.message);
      return;
    }
    setAddMethodOpen(false);
    setAddMethodValue({ skillName: "", prompt: "", steps: "" });
    toast.success(t("material.added"), result.value.material.title);
    await store.refresh();
    await store.refreshJournal();
  };

  const batchAddTags = async () => {
    const tags = batchTag.split(",").map((tag) => tag.trim()).filter(Boolean);
    if (tags.length === 0 || store.selectedIds.length === 0) return;
    setBusy(true);
    const result = await getMaterialLibraryService().addTags(
      store.selectedIds,
      tags,
      "user",
      "batch tag",
    );
    setBusy(false);
    reportMutation(result, t("material.batchTagged", { count: store.selectedIds.length }));
  };

  const batchSetStatus = async (status: "inbox" | "organized") => {
    if (store.selectedIds.length === 0) return;
    setBusy(true);
    const result = await getMaterialLibraryService().batchUpdate(
      store.selectedIds.map((id) => ({ id, patch: { organizeStatus: status } })),
      "user",
      status === "organized" ? "mark organized" : "move to inbox",
    );
    setBusy(false);
    reportMutation(result, t("material.batchStatus", { count: store.selectedIds.length }));
  };

  const batchRemove = async () => {
    if (store.selectedIds.length === 0) return;
    if (!window.confirm(t("material.batchRemoveConfirm", { count: store.selectedIds.length }))) {
      return;
    }
    setBusy(true);
    const service = getMaterialLibraryService();
    let removed = 0;
    const failures: string[] = [];
    for (const id of store.selectedIds) {
      const result = await service.remove(id, { force: true }, "user");
      if (result.ok) removed += 1;
      else failures.push(result.message);
    }
    setBusy(false);
    if (failures.length > 0) toast.error(t("material.removeFailed"), failures[0]);
    if (removed > 0) {
      toast.success(t("material.removed"), t("material.removedCount", { count: removed }));
    }
    await store.refresh();
    await store.refreshJournal();
  };

  const reportMutation = (
    result: MaterialServiceResult<unknown>,
    successTitle: string,
  ) => {
    if (!result.ok) {
      toast.error(t("material.updateFailed"), result.message);
      return;
    }
    toast.success(successTitle, "");
    void store.refresh();
    void store.refreshJournal();
    void store.clearSelection();
  };

  const attachRecords = async (records: readonly MaterialRecord[]) => {
    const attachable = records.filter(
      (item) =>
        item.kind === "media" || item.kind === "segment" || item.kind === "instruction",
    );
    if (attachable.length === 0) return;
    setBusy(true);
    let attached = 0;
    for (const record of attachable) {
      if (record.kind === "instruction") {
        try { await addLibraryInstruction(useProjectStore, record); attached += 1; }
        catch (error) { toast.error(t("material.attachFailed"), String(error)); }
        continue;
      }
      const result = await attachMaterialToProject({
        materialId: record.id,
        actor: "user",
      });
      if (result.ok) attached += 1;
      else toast.error(t("material.attachFailed"), result.message);
    }
    setBusy(false);
    if (attached > 0) {
      toast.success(
        t("material.attached"),
        t("material.attachedCount", { count: attached }),
      );
    }
    await store.refresh();
    void store.clearSelection();
  };

  const latestAgentEntry = useMemo(
    () => {
      const latest = latestMaterialJournalEntry(store.journal.filter(entry => entry.actor === "agent"));
      // Legacy rows remain selectable in the history menu. An automatic
      // "latest agent batch" shortcut must never guess their true order.
      return latest.entry?.order && "sequence" in latest.entry.order ? latest.entry : null;
    },
    [store.journal],
  );

  const statusChips: ReadonlyArray<{ value: "all" | "inbox" | "organized"; labelKey: string }> = [
    { value: "all", labelKey: "material.filter.all" },
    { value: "inbox", labelKey: "material.status.inbox" },
    { value: "organized", labelKey: "material.status.organized" },
  ];

  // An empty list with active filters means "nothing matches", not "first
  // use" — and a load failure must never render the welcome copy either.
  const hasActiveFilters =
    store.filters.kind !== "all" ||
    store.filters.status !== "all" ||
    store.filters.tag !== null ||
    store.filters.query.trim() !== "";

  return (
    <div className="asset-browser" data-live-editor-target-id="material-library-panel" data-view={view}>
      <div className="asset-browser-header">
        <div className="asset-browser-title">{t("assets.tabs.library")}<span className="asset-browser-count">{store.totalCount}</span></div>
        <div className="asset-browser-toolbar">
          <DropdownMenu alignment="start" size="sm" button={{ label: t("assetBrowser.add"), icon: <Plus size={14} />,
            variant: "ghost", isDisabled: busy, className: "asset-browser-button asset-browser-button-primary" }} items={[
              { label: t("material.addMedia"), icon: <FileVideo size={14} />, onClick: () => fileInputRef.current?.click() },
              { label: t("material.addLink"), icon: <Link2 size={14} />, onClick: () => setAddLinkOpen(true) },
              { label: t("material.kind.instruction"), icon: <SlidersHorizontal size={14} />, onClick: () => setInstructionsOpen(true) },
              { label: t("material.addMethod"), icon: <Sparkles size={14} />, onClick: () => setAddMethodOpen(true) },
            ]} />
          <button type="button" aria-label={t("assetBrowser.select")} title={t("assetBrowser.select")}
            aria-pressed={selecting} className="asset-browser-button asset-browser-button-icon"
            onClick={() => { setSelecting(!selecting); store.clearSelection(); }}><CheckSquare size={14} aria-hidden /></button>
        {latestAgentEntry && <button type="button" onClick={() => undoLatest(latestAgentEntry)} title={latestAgentEntry.label}
          aria-label={t("material.undoAgentBatch")} className="asset-browser-button asset-browser-button-icon">
          <Undo2 size={12} aria-hidden />
        </button>}
          <div className="flex-1" />
          <AssetViewToggle value={view} onChange={setView} />
          <Popover alignment="end" label={t("material.history")} isOpen={journalOpen} onOpenChange={setJournalOpen} content={

              <div className="max-h-72 w-72 overflow-auto rounded-[11px] border border-border bg-bg-1 p-1.5 shadow-xl">
                {store.journal.length === 0 ? (
                  <div className="px-2 py-3 text-center text-[12px] text-fg-3">
                    {t("material.historyEmpty")}
                  </div>
                ) : (
                  store.journal.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex items-start gap-2 rounded-[8px] px-2 py-1.5 hover:bg-bg-2"
                    >
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span
                          className={`truncate text-[12px] ${entry.undone ? "text-fg-3 line-through" : "text-fg-2"}`}
                        >
                          {entry.actor === "agent" ? <Bot size={11} className="mr-1 inline" aria-hidden /> : null}
                          {entry.label}
                        </span>
                        <span className="text-[10px] text-fg-3">
                          {formatTime(entry.at)} · {t(`material.actor.${entry.actor}`)}
                          {entry.undone ? ` · ${t("material.undoneState")}` : ""}
                        </span>
                      </div>
                      {!entry.undone ? (
                        <button
                          type="button"
                          onClick={() => undoLatest(entry)}
                          className="shrink-0 rounded-[7px] border border-border px-2 py-1 text-[10px] font-medium text-fg-2 hover:border-accent"
                        >
                          <Undo2 size={11} aria-hidden />
                        </button>
                      ) : null}
                    </div>
                  ))
                )}
              </div>

          }><button type="button" aria-label={t("material.history")} title={t("material.history")}
            className="asset-browser-button asset-browser-button-icon"><History size={14} aria-hidden /></button></Popover>
        </div>
        <input ref={fileInputRef} type="file" multiple accept="video/*,audio/*,image/*" className="hidden"
          aria-label={t("material.addMedia")} onChange={(event) => void onFilesPicked(event.target.files)} />

        <div className="asset-browser-search-row">
          <AssetSearch value={search} onChange={onSearchChange} label={t("assetBrowser.searchLibrary")} />
          <Popover alignment="end" label={t("assetBrowser.filters")} content={
            <div className="asset-filter-panel">
              <label>{t("assetBrowser.status")}
                <select aria-label={t("assetBrowser.status")} value={store.filters.status} onChange={(event) => store.setFilters({ status: event.target.value as typeof store.filters.status })}>
                  {statusChips.map((chip) => <option key={chip.value} value={chip.value}>{t(chip.labelKey)}</option>)}
                </select>
              </label>
              <label>{t("material.tags")}<select aria-label={t("material.tags")} value={store.filters.tag ?? ""} onChange={(event) => store.setFilters({ tag: event.target.value || null })}>
                <option value="">{t("material.allTags")}</option>{store.allTags.map((tag) => <option key={tag} value={tag}>#{tag}</option>)}
              </select></label>
              <label>{t("assetBrowser.sort")}<select aria-label={t("assetBrowser.sort")} value={store.sort} onChange={(event) => store.setSort(event.target.value as typeof store.sort)}>
                <option value="updated">{t("assetBrowser.recent")}</option><option value="title">{t("assetBrowser.nameAsc")}</option>
              </select></label>
              <button type="button" className="asset-browser-button" onClick={() => store.setFilters({ status: "all", tag: null })}>{t("assetBrowser.resetFilters")}</button>
            </div>
          }><button type="button" aria-label={t("assetBrowser.filters")} title={t("assetBrowser.filters")}
            className="asset-browser-button asset-browser-button-icon"><SlidersHorizontal size={14} aria-hidden />
            {(store.filters.status !== "all" || store.filters.tag) && <span className="h-1 w-1 rounded-full bg-accent" />}
          </button></Popover>
        </div>
        <div className="asset-browser-tabs" role="group" aria-label={t("assetBrowser.categories")}>
          {KIND_CHIPS.map((chip) => <button key={chip.value} type="button" aria-pressed={store.filters.kind === chip.value}
            onClick={() => store.setFilters({ kind: chip.value })}>{t(chip.labelKey)}</button>)}
        </div>
      </div>
      {store.selectedIds.length > 0 && <div className="asset-batch-bar">
        <span>{t("material.selected", { count: store.selectedIds.length })}</span>
        {hasOpenProject && <button type="button" disabled={busy || !store.items.some((item) => store.selectedIds.includes(item.id) && (item.kind === "media" || item.kind === "segment" || item.kind === "instruction"))}
          aria-label={t("material.attachToProject")} title={t("material.attachToProject")} className="asset-browser-button asset-browser-button-icon"
          onClick={() => void attachRecords(store.items.filter((item) => store.selectedIds.includes(item.id)))}><Plus size={14} aria-hidden /></button>}
        <DropdownMenu alignment="start" size="sm" button={{ label: t("assetBrowser.organize"), variant: "ghost", isDisabled: busy, className: "asset-browser-button" }} items={[
          { label: t("material.markOrganized"), onClick: () => void batchSetStatus("organized") },
          { label: t("material.moveToInbox"), onClick: () => void batchSetStatus("inbox") },
          { label: t("assetBrowser.selectAll"), onClick: store.selectAllVisible },
          { type: "divider" }, { label: t("material.remove"), icon: <Trash2 size={14} />, onClick: () => void batchRemove() },
        ]} />
        <Popover alignment="end" label={t("material.addTags")} content={<form className="asset-filter-panel" onSubmit={(event) => { event.preventDefault(); void batchAddTags(); }}>
          <label>{t("material.tags")}<input value={batchTag} placeholder={t("material.batchTagPlaceholder")} onChange={(event) => setBatchTag(event.target.value)} /></label>
          <button disabled={busy} className="asset-browser-button asset-browser-button-primary">{t("material.addTags")}</button>
        </form>}><button type="button" aria-label={t("material.addTags")} title={t("material.addTags")} className="asset-browser-button asset-browser-button-icon"><Hash size={14} aria-hidden /></button></Popover>
        <div className="flex-1" /><button type="button" aria-label={t("Clear")} className="asset-browser-button asset-browser-button-icon"
          onClick={() => { store.clearSelection(); setSelecting(false); }}><X size={14} aria-hidden /></button>
      </div>}

      {/* list */}
      <div className="asset-browser-content custom-scrollbar">
        {store.error ? (
          <div className="rounded-[9px] border border-status-danger/40 bg-status-danger/10 px-3 py-2 text-[12px] text-status-danger">
            {store.error}
          </div>
        ) : null}
        {!store.loading && !store.error && store.items.length === 0 ? (
          hasActiveFilters ? (
            <ToolcraftEmptyState
              icon={<Search size={26} aria-hidden />}
              title={t("material.noResults")}
            />
          ) : (
            <ToolcraftEmptyState
              icon={<BookMarked size={26} aria-hidden />}
              title={t("material.emptyTitle")}
              description={t("material.emptyDetail")}
            />
          )
        ) : (
          <div className={view === "grid" ? "asset-browser-grid asset-library-grid" : "asset-material-list"}>
            {store.items.map((record) => {
              const selected = store.selectedIds.includes(record.id);
              const fileStatus = record.kind === "media" || record.kind === "segment" ? store.fileStatuses[record.id] : undefined;
              const attachable = record.kind === "media" || record.kind === "segment" || record.kind === "instruction";
              return (
                <article key={record.id} data-material-id={record.id} data-selected={selected} className="asset-material-card">
                  {(selecting || store.selectedIds.length > 0) && <input type="checkbox" checked={selected}
                    aria-label={t("assetBrowser.selectItem", { name: record.title })} onChange={() => store.toggleSelected(record.id)} className="asset-material-check" />}
                  <button type="button" className="asset-material-open" aria-label={t("assetBrowser.previewItem", { name: record.title })}
                    onClick={() => store.openDetail(record.id)}>
                    <div className="asset-material-preview">
                      {record.kind === "media" && record.thumbnailDataUrl ? <img src={record.thumbnailDataUrl} alt="" /> : <RecordIcon record={record} />}
                    </div>
                    <div className="asset-material-copy">
                      <div className="asset-material-title" title={record.title}>{record.title}</div>
                      <div className="asset-material-meta">
                        <span>{t(`material.kind.${record.kind}`)}{record.tags.length > 0 ? ` · ${record.tags.map((tag) => `#${tag}`).join(" ")}` : ""}</span>
                        {record.updatedBy === "agent" && <Bot size={11} aria-label={t("material.agentBadge")} className="shrink-0 text-accent" />}
                      </div>
                      {(record.organizeStatus === "inbox" || fileStatus === "missing" || fileStatus === "unknown") && <div className="asset-material-meta">
                        {record.organizeStatus === "inbox" && <span className="text-status-warning">{t("material.status.inbox")}</span>}
                        {fileStatus === "missing" && <span className="text-status-danger">{t("material.fileMissing")}</span>}
                        {fileStatus === "unknown" && <span>{t("material.fileUnknown")}</span>}
                      </div>}
                    </div>
                  </button>
                  {hasOpenProject && attachable && !selecting && <button type="button" disabled={busy || fileStatus === "missing"}
                    aria-label={t("assetBrowser.useItem", { name: record.title })} title={t("material.attachToProject")}
                    onClick={() => void attachRecords([record])} className="asset-material-add asset-browser-button asset-browser-button-icon"><Plus size={14} aria-hidden /></button>}
                </article>
              );
            })}
            {store.page < store.totalPages ? (
              <button
                type="button"
                disabled={store.loading}
                onClick={() => void store.loadMore()}
                className="mt-1 rounded-[9px] border border-border bg-bg py-2 text-[12px] font-medium text-fg-2 hover:border-border-strong disabled:opacity-50"
              >
                {store.loading ? t("material.loading") : t("material.loadMore", { remaining: store.total - store.items.length })}
              </button>
            ) : null}
          </div>
        )}
      </div>

      {/* add link dialog */}
      {addLinkOpen ? (
        <SimplePromptDialog
          title={t("material.addLink")}
          placeholder="https://example.com/tutorial"
          value={addLinkValue}
          confirmLabel={t("material.save")}
          onChange={setAddLinkValue}
          onCancel={() => setAddLinkOpen(false)}
          onConfirm={() => void createLink()}
        />
      ) : null}

      {instructionsOpen && createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"><section role="dialog" aria-label={t("material.kind.instruction")} className="max-h-[80vh] w-[480px] overflow-auto rounded border border-border bg-bg p-4"><div className="mb-3 flex justify-between"><h3>{t("material.kind.instruction")}</h3><button aria-label={t("Close dialog")} onClick={() => setInstructionsOpen(false)}>×</button></div><InstructionLibraryPicker onSelect={record => { setInstructionsOpen(false); store.openDetail(record.id); }} /></section></div>, document.body)}
      {/* add method dialog */}
      {addMethodOpen ? createPortal(
        <div className="reelterminal-desktop fixed inset-0 z-[var(--z-dialog)]" onClick={() => setAddMethodOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("material.addMethod")}
            className="absolute left-1/2 top-1/2 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-[14px] border border-border bg-bg-1 p-4 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 text-[14px] font-bold text-fg">
              {t("material.addMethod")}
            </div>
            <div className="flex flex-col gap-2.5">
              <input
                value={addMethodValue.skillName}
                placeholder={t("material.skillNamePlaceholder")}
                onChange={(event) =>
                  setAddMethodValue({ ...addMethodValue, skillName: event.target.value })
                }
                className="rounded-[9px] border border-border bg-bg px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
              />
              <textarea
                value={addMethodValue.prompt}
                rows={5}
                placeholder={t("material.promptPlaceholder")}
                onChange={(event) =>
                  setAddMethodValue({ ...addMethodValue, prompt: event.target.value })
                }
                className="resize-y rounded-[9px] border border-border bg-bg px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
              />
              <textarea
                value={addMethodValue.steps}
                rows={3}
                placeholder={t("material.stepsPlaceholder")}
                onChange={(event) =>
                  setAddMethodValue({ ...addMethodValue, steps: event.target.value })
                }
                className="resize-y rounded-[9px] border border-border bg-bg px-3 py-2 text-[12px] text-fg outline-none focus:border-accent"
              />
              <div className="text-[11px] text-fg-3">{t("material.methodHint")}</div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAddMethodOpen(false)}
                className="rounded-[9px] border border-border bg-bg px-3 py-2 text-[12px] font-medium text-fg-2"
              >
                {t("Cancel")}
              </button>
              <button
                type="button"
                disabled={!addMethodValue.prompt.trim()}
                onClick={() => void createMethod()}
                className="rounded-[9px] bg-accent px-3 py-2 text-[12px] font-semibold text-bg disabled:opacity-50"
              >
                {t("material.save")}
              </button>
            </div>
          </div>
        </div>, document.body,
      ) : null}

      <MaterialDetailDialog />
    </div>
  );
}

function SimplePromptDialog(props: {
  readonly title: string;
  readonly placeholder: string;
  readonly value: string;
  readonly confirmLabel: string;
  readonly onChange: (value: string) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return createPortal(
    <div className="reelterminal-desktop fixed inset-0 z-[var(--z-dialog)]" onClick={props.onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        className="absolute left-1/2 top-1/2 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-[14px] border border-border bg-bg-1 p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 text-[14px] font-bold text-fg">{props.title}</div>
        <input
          ref={inputRef}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") props.onConfirm();
          }}
          className="w-full rounded-[9px] border border-border bg-bg px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={props.onCancel}
            className="rounded-[9px] border border-border bg-bg px-3 py-2 text-[12px] font-medium text-fg-2"
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            onClick={props.onConfirm}
            className="rounded-[9px] bg-accent px-3 py-2 text-[12px] font-semibold text-bg"
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>, document.body,
  );
}
