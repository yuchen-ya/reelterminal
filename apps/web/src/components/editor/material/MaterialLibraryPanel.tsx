/**
 * The user-level material library panel (the "Library" tab in the assets
 * panel). Independent of the current project: collect first (everything
 * lands in the inbox), organize later (filter, tag, batch), and attach to
 * the open project on demand. The agent's batch operations are visible and
 * one-click undoable from the journal menu.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  BookMarked,
  ChevronDown,
  FileVideo,
  FolderOpen,
  Hash,
  Inbox,
  Link2,
  ListChecks,
  Music,
  Plus,
  Scissors,
  Search,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";
import type { MaterialJournalEntry, MaterialKind, MaterialRecord } from "@openreel/core";
import { ToolcraftEmptyState } from "@openreel/ui";
import {
  getMaterialLibraryService,
  type MaterialServiceResult,
} from "../../../services/material-library/library-service";
import { saveLocalFileToLibrary } from "../../../services/material-library/project-save";
import { attachMaterialToProject } from "../../../services/material-library/attach";
import { useMaterialLibraryStore } from "../../../stores/material-library-store";
import { useProjectStore } from "../../../stores/project-store";
import { toast } from "../../../stores/notification-store";
import { MaterialDetailDialog } from "./MaterialDetailDialog";

const KIND_CHIPS: ReadonlyArray<{ value: MaterialKind | "all"; labelKey: string }> = [
  { value: "all", labelKey: "material.filter.all" },
  { value: "media", labelKey: "material.kind.media" },
  { value: "segment", labelKey: "material.kind.segment" },
  { value: "link", labelKey: "material.kind.link" },
  { value: "method", labelKey: "material.kind.method" },
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
  if (record.kind === "method") return <Sparkles size={15} aria-hidden />;
  if (record.kind === "segment") return <Scissors size={15} aria-hidden />;
  if (record.mediaType === "audio") return <Music size={15} aria-hidden />;
  return <FileVideo size={15} aria-hidden />;
}

export function MaterialLibraryPanel() {
  const { t } = useTranslation();
  const store = useMaterialLibraryStore();
  const hasOpenProject = useProjectStore((s) => s.hasOpenProject);
  const [search, setSearch] = useState("");
  const [journalOpen, setJournalOpen] = useState(false);
  const [batchTag, setBatchTag] = useState("");
  const [addLinkOpen, setAddLinkOpen] = useState(false);
  const [addLinkValue, setAddLinkValue] = useState("");
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
    window.addEventListener("openreel:material-library-changed", onChanged);
    return () =>
      window.removeEventListener("openreel:material-library-changed", onChanged);
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
    toast.success(
      t("material.undone"),
      t("material.undoneDetail", {
        restored: result.value.restored.length,
        removed: result.value.removed.length,
      }),
    );
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

  const attachSelected = async () => {
    const attachable = store.items.filter(
      (item) =>
        store.selectedIds.includes(item.id) &&
        (item.kind === "media" || item.kind === "segment"),
    );
    if (attachable.length === 0) return;
    setBusy(true);
    let attached = 0;
    for (const record of attachable) {
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
    () => store.journal.find((entry) => entry.actor === "agent" && !entry.undone) ?? null,
    [store.journal],
  );

  const statusChips: ReadonlyArray<{ value: "all" | "inbox" | "organized"; labelKey: string }> = [
    { value: "all", labelKey: "material.filter.all" },
    { value: "inbox", labelKey: "material.status.inbox" },
    { value: "organized", labelKey: "material.status.organized" },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-live-editor-target-id="material-library-panel">
      {/* header */}
      <div className="flex flex-col gap-2.5 px-4 pt-[18px] shrink-0">
        <div className="flex items-center justify-between">
          <div className="font-bold text-[18px] text-fg">{t("material.title")}</div>
          <div className="relative flex items-center gap-1.5">
            {latestAgentEntry ? (
              <button
                type="button"
                onClick={() => undoLatest(latestAgentEntry)}
                title={latestAgentEntry.label}
                className="flex items-center gap-1 rounded-[9px] border border-border bg-bg px-2 py-1.5 text-[11px] font-medium text-fg-2 hover:border-accent"
              >
                <Undo2 size={12} aria-hidden />
                {t("material.undoAgentBatch")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setJournalOpen((open) => !open)}
              className="flex items-center gap-1 rounded-[9px] border border-border bg-bg px-2 py-1.5 text-[11px] font-medium text-fg-2 hover:border-border-strong"
            >
              <ListChecks size={12} aria-hidden />
              {t("material.history")}
              <ChevronDown size={11} aria-hidden />
            </button>
            {journalOpen ? (
              <div className="absolute right-0 top-9 z-20 max-h-72 w-80 overflow-auto rounded-[11px] border border-border bg-bg-1 p-1.5 shadow-xl">
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
            ) : null}
          </div>
        </div>

        {/* add buttons */}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-[9px] border border-border bg-bg p-2 text-[12px] font-medium text-fg-2 hover:border-border-strong disabled:opacity-50"
          >
            <Plus size={13} aria-hidden />
            {t("material.addMedia")}
          </button>
          <button
            type="button"
            onClick={() => setAddLinkOpen(true)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-[9px] border border-border bg-bg p-2 text-[12px] font-medium text-fg-2 hover:border-border-strong"
          >
            <Link2 size={13} aria-hidden />
            {t("material.addLink")}
          </button>
          <button
            type="button"
            onClick={() => setAddMethodOpen(true)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-[9px] border border-border bg-bg p-2 text-[12px] font-medium text-fg-2 hover:border-border-strong"
          >
            <Sparkles size={13} aria-hidden />
            {t("material.addMethod")}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="video/*,audio/*,image/*"
            className="hidden"
            onChange={(event) => void onFilesPicked(event.target.files)}
          />
        </div>

        {/* search */}
        <div className="flex items-center gap-2 rounded-[9px] border border-border bg-bg px-2.5 py-1.5">
          <Search size={13} className="shrink-0 text-fg-3" aria-hidden />
          <input
            value={search}
            placeholder={t("material.searchPlaceholder")}
            onChange={(event) => onSearchChange(event.target.value)}
            className="w-full bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-3"
          />
        </div>

        {/* filters */}
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {KIND_CHIPS.map((chip) => (
              <button
                key={chip.value}
                type="button"
                onClick={() => void store.setFilters({ kind: chip.value })}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                  store.filters.kind === chip.value
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-border bg-bg text-fg-3 hover:border-border-strong"
                }`}
              >
                {t(chip.labelKey)}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            {statusChips.map((chip) => (
              <button
                key={chip.value}
                type="button"
                onClick={() => void store.setFilters({ status: chip.value })}
                className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                  store.filters.status === chip.value
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-border bg-bg text-fg-3 hover:border-border-strong"
                }`}
              >
                {chip.value === "inbox" ? <Inbox size={10} aria-hidden /> : null}
                {t(chip.labelKey)}
                {chip.value === "inbox" && store.inboxCount > 0 ? (
                  <span className="rounded-full bg-status-warning/20 px-1.5 text-[10px] text-status-warning">
                    {store.inboxCount}
                  </span>
                ) : null}
              </button>
            ))}
            {store.allTags.length > 0 ? (
              <select
                value={store.filters.tag ?? ""}
                onChange={(event) =>
                  void store.setFilters({ tag: event.target.value || null })
                }
                className="ml-auto rounded-full border border-border bg-bg px-2 py-1 text-[11px] text-fg-3 outline-none"
              >
                <option value="">{t("material.allTags")}</option>
                {store.allTags.map((tag) => (
                  <option key={tag} value={tag}>
                    #{tag}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </div>
      </div>

      {/* batch bar */}
      {store.selectedIds.length > 0 ? (
        <div className="mx-4 mt-2.5 flex flex-wrap items-center gap-1.5 rounded-[10px] border border-accent/40 bg-accent/5 px-2.5 py-2 shrink-0">
          <span className="text-[11px] font-semibold text-accent">
            {t("material.selected", { count: store.selectedIds.length })}
          </span>
          <input
            value={batchTag}
            placeholder={t("material.batchTagPlaceholder")}
            onChange={(event) => setBatchTag(event.target.value)}
            className="w-36 rounded-[8px] border border-border bg-bg px-2 py-1 text-[11px] text-fg outline-none focus:border-accent"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void batchAddTags()}
            className="flex items-center gap-1 rounded-[8px] border border-border bg-bg px-2 py-1 text-[11px] font-medium text-fg-2 hover:border-accent"
          >
            <Hash size={11} aria-hidden />
            {t("material.addTags")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void batchSetStatus("organized")}
            className="rounded-[8px] border border-border bg-bg px-2 py-1 text-[11px] font-medium text-fg-2 hover:border-accent"
          >
            {t("material.markOrganized")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void batchSetStatus("inbox")}
            className="rounded-[8px] border border-border bg-bg px-2 py-1 text-[11px] font-medium text-fg-2 hover:border-border-strong"
          >
            {t("material.moveToInbox")}
          </button>
          {hasOpenProject ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void attachSelected()}
              className="flex items-center gap-1 rounded-[8px] border border-border bg-bg px-2 py-1 text-[11px] font-medium text-fg-2 hover:border-accent"
            >
              <FolderOpen size={11} aria-hidden />
              {t("material.attachToProject")}
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void batchRemove()}
            className="ml-auto flex items-center gap-1 rounded-[8px] border border-status-danger/40 px-2 py-1 text-[11px] font-medium text-status-danger hover:bg-status-danger/10"
          >
            <Trash2 size={11} aria-hidden />
            {t("material.remove")}
          </button>
          <button
            type="button"
            onClick={() => store.clearSelection()}
            className="rounded-[8px] px-2 py-1 text-[11px] text-fg-3 hover:text-fg"
          >
            {t("Clear")}
          </button>
        </div>
      ) : null}

      {/* list */}
      <div className="mt-2.5 min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {store.error ? (
          <div className="rounded-[9px] border border-status-danger/40 bg-status-danger/10 px-3 py-2 text-[12px] text-status-danger">
            {store.error}
          </div>
        ) : null}
        {!store.loading && store.items.length === 0 ? (
          <ToolcraftEmptyState
            icon={<BookMarked size={26} aria-hidden />}
            title={t("material.emptyTitle")}
            description={t("material.emptyDetail")}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            {store.items.map((record) => {
              const selected = store.selectedIds.includes(record.id);
              const fileStatus =
                record.kind === "media" || record.kind === "segment"
                  ? store.fileStatuses[record.id]
                  : undefined;
              return (
                <div
                  key={record.id}
                  data-material-id={record.id}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-[10px] border p-2 ${
                    selected
                      ? "border-accent bg-accent/5"
                      : "border-border bg-bg hover:border-border-strong"
                  }`}
                  onClick={() => store.openDetail(record.id)}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => store.toggleSelected(record.id)}
                    className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
                  />
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-border bg-bg-2 text-fg-3">
                    {record.kind === "media" && record.thumbnailDataUrl ? (
                      <img
                        src={record.thumbnailDataUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <RecordIcon record={record} />
                    )}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[12.5px] font-medium text-fg">
                        {record.title}
                      </span>
                      <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] text-fg-3">
                        {t(`material.kind.${record.kind}`)}
                      </span>
                      {record.organizeStatus === "inbox" ? (
                        <span className="shrink-0 rounded-full border border-status-warning/40 px-1.5 py-px text-[10px] text-status-warning">
                          {t("material.status.inbox")}
                        </span>
                      ) : null}
                      {record.updatedBy === "agent" ? (
                        <span className="flex shrink-0 items-center gap-0.5 rounded-full border border-accent/40 px-1.5 py-px text-[10px] text-accent">
                          <Bot size={9} aria-hidden />
                          {t("material.agentBadge")}
                        </span>
                      ) : null}
                      {fileStatus === "missing" ? (
                        <span className="shrink-0 rounded-full border border-status-danger/40 bg-status-danger/10 px-1.5 py-px text-[10px] text-status-danger">
                          {t("material.fileMissing")}
                        </span>
                      ) : null}
                      {fileStatus === "unknown" ? (
                        <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] text-fg-3">
                          {t("material.fileUnknown")}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10.5px] text-fg-3">
                      {record.tags.length > 0 ? (
                        <span className="truncate">
                          {record.tags.map((tag) => `#${tag}`).join(" ")}
                        </span>
                      ) : null}
                      <span className="ml-auto shrink-0">{formatTime(record.updatedAt)}</span>
                    </div>
                  </div>
                </div>
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

      {/* add method dialog */}
      {addMethodOpen ? (
        <div className="fixed inset-0 z-50" onClick={() => setAddMethodOpen(false)}>
          <div
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
        </div>
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
  return (
    <div className="fixed inset-0 z-50" onClick={props.onCancel}>
      <div
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
    </div>
  );
}
