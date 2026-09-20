/**
 * Material detail dialog: view + edit everything the human owns, preview the
 * resource, save a segment, attach to the current project, inspect usages
 * and provenance, and remove the entry.
 *
 * Separation guarantees surfaced here: userNotes ("Your notes") and aiSummary
 * ("AI summary") are distinct fields; agent edits never touch the former and
 * every agent-written record carries a visible badge.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  Clock,
  FileVideo,
  FolderOpen,
  Link2,
  Scissors,
  Trash2,
} from "lucide-react";
import type { MaterialRecord, MaterialUpdatePatch } from "@reelterminal/core";
import {
  ToolcraftDialog,
  ToolcraftDialogHeader,
  ToolcraftLayout,
  ToolcraftLayoutContent,
  ToolcraftLayoutFooter,
} from "@reelterminal/ui";
import { getMaterialLibraryService } from "../../../services/material-library/library-service";
import { attachMaterialToProject } from "../../../services/material-library/attach";
import { useMaterialLibraryStore } from "../../../stores/material-library-store";
import { useProjectStore } from "../../../stores/project-store";
import { toast } from "../../../stores/notification-store";
import { MaterialPreview } from "./MaterialPreview";
import { MaterialSegmentDialog } from "./MaterialSegmentDialog";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function MaterialDetailDialog() {
  const { t } = useTranslation();
  const detailMaterialId = useMaterialLibraryStore((s) => s.detailMaterialId);
  const openDetail = useMaterialLibraryStore((s) => s.openDetail);
  const openSegmentDialog = useMaterialLibraryStore((s) => s.openSegmentDialog);
  const refresh = useMaterialLibraryStore((s) => s.refresh);
  const refreshJournal = useMaterialLibraryStore((s) => s.refreshJournal);
  const hasOpenProject = useProjectStore((s) => s.hasOpenProject);

  const [record, setRecord] = useState<MaterialRecord | null>(null);
  const [draft, setDraft] = useState<{
    title: string;
    tags: string;
    userNotes: string;
    aiSummary: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveSegmentOpen, setSaveSegmentOpen] = useState(false);

  const load = useCallback(async (id: string) => {
    const result = await getMaterialLibraryService().get(id);
    if (!result.ok) {
      setRecord(null);
      return;
    }
    setRecord(result.value);
    setDraft({
      title: result.value.title,
      tags: result.value.tags.join(", "),
      userNotes: result.value.userNotes,
      aiSummary: result.value.aiSummary,
    });
  }, []);

  useEffect(() => {
    if (detailMaterialId) {
      void load(detailMaterialId);
    } else {
      setRecord(null);
      setDraft(null);
    }
  }, [detailMaterialId, load]);

  const isOpen = detailMaterialId !== null && record !== null;

  const save = async () => {
    if (!record || !draft) return;
    setBusy(true);
    const patch: MaterialUpdatePatch = {
      title: draft.title.trim() || record.title,
      tags: draft.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      userNotes: draft.userNotes,
      aiSummary: draft.aiSummary,
    };
    const result = await getMaterialLibraryService().update(
      record.id,
      patch,
      "user",
      record.revision,
    );
    setBusy(false);
    if (!result.ok) {
      if (result.code === "CONFLICT") {
        toast.warning(
          t("material.conflictTitle"),
          t("material.conflictDetail"),
        );
      } else {
        toast.error(t("material.saveFailed"), result.message);
      }
      await load(record.id);
      return;
    }
    await load(record.id);
    await refresh();
    toast.success(t("material.saved"), result.value.material.title);
  };

  const attach = async () => {
    if (!record) return;
    setBusy(true);
    const result = await attachMaterialToProject({
      materialId: record.id,
      actor: "user",
    });
    setBusy(false);
    if (!result.ok) {
      toast.error(t("material.attachFailed"), result.message);
      return;
    }
    await load(record.id);
    await refresh();
    toast.success(
      t("material.attached"),
      t("material.attachedDetail", { name: result.value.projectName }),
    );
  };

  const remove = async () => {
    if (!record) return;
    const currentUsageCount = record.usages.filter(
      (usage) => usage.status === "current",
    ).length;
    const referenced = currentUsageCount > 0;
    if (
      referenced &&
      !window.confirm(
        t("material.removeReferencedConfirm", { count: currentUsageCount }),
      )
    ) {
      return;
    }
    if (
      !referenced &&
      !window.confirm(t("material.removeConfirm", { title: record.title }))
    ) {
      return;
    }
    setBusy(true);
    const result = await getMaterialLibraryService().remove(
      record.id,
      { force: referenced },
      "user",
    );
    setBusy(false);
    if (!result.ok) {
      toast.error(t("material.removeFailed"), result.message);
      return;
    }
    openDetail(null);
    await refresh();
    await refreshJournal();
  };

  const durationSec = useMemo(() => {
    if (!record) return null;
    if (record.kind === "media" && record.metadata.durationSec) {
      return record.metadata.durationSec;
    }
    if (record.kind === "segment") return record.endSec - record.startSec;
    return null;
  }, [record]);

  return (
    <>
      <ToolcraftDialog
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (!open) openDetail(null);
        }}
        width={620}
      >
        {record && draft ? (
          <>
            <ToolcraftDialogHeader
              title={record.title}
              subtitle={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-border px-2 py-0.5 text-[11px]">
                    {t(`material.kind.${record.kind}`)}
                  </span>
                  {record.updatedBy === "agent" ? (
                    <span className="flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
                      <Bot size={11} aria-hidden />
                      {t("material.agentEdited")}
                      {record.lastAgentEditAt
                        ? ` · ${formatDate(record.lastAgentEditAt)}`
                        : ""}
                    </span>
                  ) : null}
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${
                      record.organizeStatus === "organized"
                        ? "border-status-success/40 text-status-success"
                        : "border-status-warning/40 text-status-warning"
                    }`}
                  >
                    {t(`material.status.${record.organizeStatus}`)}
                  </span>
                </span>
              }
              onOpenChange={() => openDetail(null)}
            />
            <ToolcraftLayout>
              <ToolcraftLayoutContent className="flex flex-col gap-4">
                <MaterialPreview record={record} />

                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-fg-2">
                    {t("material.title")}
                  </span>
                  <input
                    value={draft.title}
                    onChange={(event) =>
                      setDraft({ ...draft, title: event.target.value })
                    }
                    className="rounded-[9px] border border-border bg-bg px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-fg-2">
                    {t("material.tags")}
                  </span>
                  <input
                    value={draft.tags}
                    placeholder={t("material.tagsPlaceholder")}
                    onChange={(event) =>
                      setDraft({ ...draft, tags: event.target.value })
                    }
                    className="rounded-[9px] border border-border bg-bg px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
                  />
                  {record.tags.length > 0 ? (
                    <span className="flex flex-wrap gap-1.5">
                      {record.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full border border-border bg-bg px-2 py-0.5 text-[11px] text-fg-3"
                        >
                          {tag}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-fg-2">
                    {t("material.userNotes")}
                  </span>
                  <textarea
                    value={draft.userNotes}
                    rows={3}
                    placeholder={t("material.userNotesPlaceholder")}
                    onChange={(event) =>
                      setDraft({ ...draft, userNotes: event.target.value })
                    }
                    className="resize-y rounded-[9px] border border-border bg-bg px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-1.5 text-[12px] font-medium text-fg-2">
                    <Bot size={12} aria-hidden />
                    {t("material.aiSummary")}
                  </span>
                  <textarea
                    value={draft.aiSummary}
                    rows={3}
                    placeholder={t("material.aiSummaryPlaceholder")}
                    onChange={(event) =>
                      setDraft({ ...draft, aiSummary: event.target.value })
                    }
                    className="resize-y rounded-[9px] border border-border bg-bg px-3 py-2 text-[13px] text-fg-2 outline-none focus:border-accent"
                  />
                  <span className="text-[11px] text-fg-3">
                    {t("material.aiSummaryHint")}
                  </span>
                </label>

                <div className="rounded-[9px] border border-border bg-bg p-3 text-[12px] text-fg-3">
                  <div className="mb-1.5 font-medium text-fg-2">
                    {t("material.sourceInfo")}
                  </div>
                  {record.kind === "media" ? (
                    <div className="flex items-start gap-2 break-all">
                      <FileVideo size={13} className="mt-0.5 shrink-0" aria-hidden />
                      <span>
                        {record.fileRef.type === "path"
                          ? record.fileRef.path
                          : `${t("material.storedCopy")}: ${record.fileRef.fileName}`}
                        {record.fileRef.sizeBytes
                          ? ` · ${(record.fileRef.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                          : ""}
                      </span>
                    </div>
                  ) : null}
                  {record.kind === "segment" ? (
                    <div className="flex items-center gap-2">
                      <Scissors size={13} aria-hidden />
                      <span>
                        {t("material.segmentOf", {
                          start: record.startSec.toFixed(2),
                          end: record.endSec.toFixed(2),
                          parent: record.parentMaterialId,
                        })}
                      </span>
                    </div>
                  ) : null}
                  {record.kind === "link" ? (
                    <div className="flex items-start gap-2 break-all">
                      <Link2 size={13} className="mt-0.5 shrink-0" aria-hidden />
                      <span>{record.url}</span>
                    </div>
                  ) : null}
                  {durationSec ? (
                    <div className="mt-1 flex items-center gap-2">
                      <Clock size={13} aria-hidden />
                      <span>
                        {t("material.duration", {
                          seconds: durationSec.toFixed(1),
                        })}
                      </span>
                    </div>
                  ) : null}
                  <div className="mt-1">
                    {t("material.createdAddedBy", {
                      actor: record.source.addedBy,
                      date: formatDate(record.source.addedAt),
                    })}
                  </div>
                </div>

                {record.usages.length > 0 ? (
                  <div className="rounded-[9px] border border-border bg-bg p-3 text-[12px] text-fg-3">
                    <div className="mb-1.5 font-medium text-fg-2">
                      {t("material.usages", { count: record.usages.length })}
                    </div>
                    <ul className="flex flex-col gap-1">
                      {record.usages.map((usage, index) => (
                        <li key={`${usage.projectId}-${usage.mediaIdInProject ?? index}`} className="flex flex-wrap items-center gap-1.5">
                          <FolderOpen size={12} aria-hidden />
                          <span className="text-fg-2">
                            {usage.projectName ?? usage.projectId}
                          </span>
                          <span
                            className={`rounded-full border px-1.5 py-0.5 text-[10px] ${
                              usage.status === "historical"
                                ? "border-border text-fg-4"
                                : "border-status-success/40 text-status-success"
                            }`}
                          >
                            {usage.status === "historical"
                              ? t(
                                  usage.historicalReason
                                    ? `material.usage.${usage.historicalReason}`
                                    : "material.usage.historical",
                                )
                              : t("material.usage.current")}
                          </span>
                          {usage.startSec !== undefined && usage.endSec !== undefined ? (
                            <span>
                              · {usage.startSec.toFixed(2)}–{usage.endSec.toFixed(2)}s
                            </span>
                          ) : null}
                          <span>· {formatDate(usage.attachedAt)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </ToolcraftLayoutContent>
              <ToolcraftLayoutFooter className="flex flex-wrap items-center gap-2">
                {(record.kind === "media" || record.kind === "segment") && hasOpenProject ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={attach}
                    className="flex items-center gap-1.5 rounded-[9px] bg-accent px-3 py-2 text-[12px] font-semibold text-bg disabled:opacity-50"
                  >
                    <FolderOpen size={13} aria-hidden />
                    {record.kind === "segment"
                      ? t("material.attachSegment")
                      : t("material.attachMedia")}
                  </button>
                ) : null}
                {record.kind === "media" && record.mediaType !== "image" ? (
                  <button
                    type="button"
                    onClick={() => setSaveSegmentOpen(true)}
                    className="flex items-center gap-1.5 rounded-[9px] border border-border bg-bg px-3 py-2 text-[12px] font-medium text-fg-2 hover:border-border-strong"
                  >
                    <Scissors size={13} aria-hidden />
                    {t("material.saveSegment")}
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={remove}
                  className="ml-auto flex items-center gap-1.5 rounded-[9px] border border-status-danger/40 px-3 py-2 text-[12px] font-medium text-status-danger hover:bg-status-danger/10"
                >
                  <Trash2 size={13} aria-hidden />
                  {t("material.remove")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={save}
                  className="rounded-[9px] border border-border bg-bg px-3 py-2 text-[12px] font-medium text-fg hover:border-accent disabled:opacity-50"
                >
                  {t("material.save")}
                </button>
              </ToolcraftLayoutFooter>
            </ToolcraftLayout>
          </>
        ) : null}
      </ToolcraftDialog>
      {saveSegmentOpen && record ? (
        <MaterialSegmentDialog
          parentMaterialId={record.id}
          onClose={() => setSaveSegmentOpen(false)}
          onCreated={async (segmentId) => {
            setSaveSegmentOpen(false);
            openSegmentDialog(null);
            await refresh();
            openDetail(segmentId);
          }}
        />
      ) : null}
    </>
  );
}
