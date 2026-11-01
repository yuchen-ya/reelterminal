import { getAppLocale } from "../../../i18n";
import { useTranslation } from "react-i18next";
import { t as translate } from "../../../i18n";
/**
 * Handoff publication dialog for the AI material workbench.
 *
 * Migrated from the prototype's HandoffModal onto the host ToolcraftDialog.
 * Kept: the KPI strip, the publish-preview table of decided entries, the
 * exclusion notice and the published-snapshot history with real delivery
 * states.
 *
 * Publish is a real controller mutation over a checked subset of decided
 * entries (default: all decided). Publishing an unchanged snapshot replays the
 * existing handoff identity (no duplicate); changing feedback/decisions
 * publishes a new snapshot linked by supersedes. Real failures are surfaced
 * verbatim; nothing is faked.
 */
import { useCallback, useEffect, useState } from "react";
import {
  CircleCheck,
  Clock,
  Copy,
  Download,
  Send,
  ShieldCheck,
} from "lucide-react";
import type { WorkbenchDecision, WorkbenchDecisionStatus, WorkbenchHandoff } from "@reelterminal/core";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import type {
  WorkbenchBatchView,
  WorkbenchItemView,
  WorkbenchMutationResult,
} from "../types";
import { wbButton } from "../wb-button";

export interface HandoffDialogProps {
  readonly preparing?: boolean;
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly batch: WorkbenchBatchView;
  readonly batchItems: readonly WorkbenchItemView[];
  /** Real published snapshots (append-only); newest first. */
  readonly handoffs: readonly WorkbenchHandoff[];
  /**
   * Controller publish. `itemIds` selects a subset of DECIDED entries;
   * an unchanged snapshot replays the existing handoff, a feedback change
   * publishes a new one, and a real failure is returned for display.
   */
  readonly onPublishHandoff: (
    itemIds?: readonly string[],
  ) => Promise<WorkbenchMutationResult>;
}

const STATUS_LABELS: Record<WorkbenchDecision, string> = {
  get kept() { return translate("Keep"); },
  get modified() { return translate("Modified"); },
  get rework() { return translate("Needs rework"); },
  get discarded() { return translate("Discarded"); },
};

const STATUS_CLASS: Record<WorkbenchDecision, string> = {
  kept: "text-accent",
  modified: "text-status-info",
  rework: "text-status-warning",
  discarded: "text-status-error",
};

type DecidedItem = WorkbenchItemView & { readonly status: WorkbenchDecision };

function isDecidedStatus(status: WorkbenchDecisionStatus): status is WorkbenchDecision {
  return status !== "pending";
}

function formatPublishedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString(getAppLocale());
}

export function HandoffDialog({
  isOpen,
  onOpenChange,
  batch,
  batchItems,
  handoffs,
  onPublishHandoff,
  preparing = false,
}: HandoffDialogProps) {
  const { t } = useTranslation();
  const [checkedOverride, setCheckedOverride] = useState<ReadonlySet<string> | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [jsonCopied, setJsonCopied] = useState(false);

  const decidedItems = batchItems.filter(
    (item): item is DecidedItem => isDecidedStatus(item.status),
  );
  const pendingItems = batchItems.filter((item) => !isDecidedStatus(item.status));
  // Draft feedback never enters a published handoff — counted across the
  // whole batch and called out explicitly.
  const draftFeedbackCount = batchItems.filter((item) => item.feedback?.isDraft).length;

  // null = "all decided checked" (default); a set is an explicit override.
  const effectiveChecked: ReadonlySet<string> =
    checkedOverride ?? new Set(decidedItems.map((item) => item.id));
  const checkedCount = decidedItems.filter((item) => effectiveChecked.has(item.id)).length;

  useEffect(() => {
    if (isOpen) {
      setCheckedOverride(null);
      setPublishError(null);
      setJsonCopied(false);
    }
  }, [isOpen]);

  const counts = {
    kept: decidedItems.filter((i) => i.status === "kept").length,
    modified: decidedItems.filter((i) => i.status === "modified").length,
    rework: decidedItems.filter((i) => i.status === "rework").length,
    discarded: decidedItems.filter((i) => i.status === "discarded").length,
  };

  // Tag display names resolve from the batch's own provenance tags.
  const tagNameById = new Map<string, string>();
  for (const item of batchItems) {
    for (const tag of item.provenanceTags) tagNameById.set(tag.id, tag.shortName);
  }

  const toggleItem = (itemId: string) => {
    const next = new Set(
      decidedItems.filter((i) => effectiveChecked.has(i.id)).map((i) => i.id),
    );
    if (next.has(itemId)) next.delete(itemId);
    else next.add(itemId);
    setCheckedOverride(next);
  };

  const allChecked = checkedCount === decidedItems.length && decidedItems.length > 0;
  const toggleAll = () => {
    setCheckedOverride(allChecked ? new Set<string>() : null);
  };

  const handlePublish = useCallback(async () => {
    if (preparing) return;
    const ids = decidedItems
      .filter((item) => effectiveChecked.has(item.id))
      .map((item) => item.id);
    if (ids.length === 0) return;
    setPublishError(null);
    setPublishing(true);
    try {
      const result = await onPublishHandoff(ids);
      if (!result.ok) setPublishError(result.message);
    } finally {
      setPublishing(false);
    }
  }, [decidedItems, effectiveChecked, onPublishHandoff, preparing]);

  const latestHandoff = handoffs.find((handoff) => !handoff.historicalOnly) ?? null;

  const handleCopyJson = () => {
    const data = latestHandoff ?? {
      batchId: batch.id,
      batchName: batch.name,
      decidedItemsCount: decidedItems.length,
      items: decidedItems.map((item) => ({
        id: item.id,
        version: item.version,
        status: item.status,
        feedback: item.feedback?.text,
      })),
    };
    void navigator.clipboard?.writeText(JSON.stringify(data, null, 2));
    setJsonCopied(true);
    setTimeout(() => setJsonCopied(false), 2000);
  };

  const handleExportJson = () => {
    const data = latestHandoff ?? {
      batchId: batch.id,
      batchName: batch.name,
      decidedItemsCount: decidedItems.length,
      items: decidedItems,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `handoff-${batch.name || "snapshot"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <ToolcraftDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      width={880}
      purpose="workbench-handoff-publish"
    >
      <ToolcraftDialogHeader
        title={t("Publish this batch’s review results")}
        subtitle={
          <>{t("{{v0}} · Publish only reviewed items in this batch. Switch batches to publish others. Pending items ({{v1}}) and draft feedback ({{v2}}) are excluded.", { v0: batch.name, v1: pendingItems.length, v2: draftFeedbackCount })}</>
        }
        onOpenChange={onOpenChange}
      />

      <div
        className="max-h-[64vh] overflow-y-auto px-5 py-4 space-y-4 text-xs"
        data-workbench-modal="true"
        data-workbench-scope="true"
        data-testid="workbench-handoff-dialog"
      >
        {preparing && <p role="status" className="text-xs text-fg-2">{t("Loading the complete publication preview…")}</p>}
        {publishError && (
          <div className="px-3.5 py-2 rounded-[6px] border border-status-error/40 bg-bg-2 flex items-start justify-between gap-2">
            <span className="text-xs text-status-error break-all">{t("Publication failed: {{v0}}", { v0: publishError })}</span>
            <button
              type="button"
              onClick={() => setPublishError(null)}
              className="text-fg-3 hover:text-fg shrink-0"
            >
              ×
            </button>
          </div>
        )}

        {/* Summary KPI strip */}
        <div className="grid grid-cols-5 gap-2.5">
          <div className="p-3 rounded-[6px] bg-bg-2 border border-border">
            <div className="text-[11px] text-fg-2">{t("Total returned this round")}</div>
            <div className="text-lg font-bold font-mono tabular-nums [font-family:var(--wb-font-num)] text-fg mt-0.5">
              {decidedItems.length}{" "}
              <span className="text-xs font-normal text-fg-3">/ {batchItems.length}</span>
            </div>
          </div>
          <div className="p-3 rounded-[6px] bg-bg-2 border border-border">
            <div className="text-[11px] text-accent">
              {t("Kept")}
            </div>
            <div className="text-lg font-bold font-mono tabular-nums [font-family:var(--wb-font-num)] text-accent mt-0.5">
              {counts.kept}
            </div>
          </div>
          <div className="p-3 rounded-[6px] bg-bg-2 border border-border">
            <div className="text-[11px] text-status-info">
              {t("Modified")}
            </div>
            <div className="text-lg font-bold font-mono tabular-nums [font-family:var(--wb-font-num)] text-status-info mt-0.5">
              {counts.modified}
            </div>
          </div>
          <div className="p-3 rounded-[6px] bg-bg-2 border border-border">
            <div className="text-[11px] text-status-warning">
              {t("Needs rework")}
            </div>
            <div className="text-lg font-bold font-mono tabular-nums [font-family:var(--wb-font-num)] text-status-warning mt-0.5">
              {counts.rework}
            </div>
          </div>
          <div className="p-3 rounded-[6px] bg-bg-2 border border-border">
            <div className="text-[11px] text-status-error">
              {t("Discarded")}
            </div>
            <div className="text-lg font-bold font-mono tabular-nums [font-family:var(--wb-font-num)] text-status-error mt-0.5">
              {counts.discarded}
            </div>
          </div>
        </div>

        {/* Pending & draft exclusion notice */}
        <div className="px-3.5 py-2 rounded-[6px] bg-bg-2 border border-border flex items-center justify-between gap-3 text-xs text-fg-2">
          <span>
            {t("Still pending:")}<strong className="text-fg tabular-nums">{pendingItems.length}</strong>{" "}
            {t("items remain in the pending queue. You may return the processed subset first;")}{draftFeedbackCount > 0 && (
              <>
                {t("also,")}<strong className="text-status-warning tabular-nums">{draftFeedbackCount}</strong>{" "}
                {t("drafts will not be published;")}</>
            )}
            {t("Unconfirmed draft feedback stays local.")}</span>

        </div>

        {/* Table of decided entries to publish (subset selectable) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-fg">
              {t("Items in this publication")}<span className="sr-only">{t("(immutable handoff snapshot)")}</span> ({checkedCount}/{decidedItems.length} {t(" items)")}</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopyJson}
                className={wbButton.ghost}
                data-testid="workbench-handoff-copy-json"
                title={t("Copy snapshot JSON")}
              >
                <Copy className="h-3 w-3" />
                {jsonCopied ? t("material.copied") : t("Copy JSON")}
              </button>
              <button
                type="button"
                onClick={handleExportJson}
                className={wbButton.ghost}
                data-testid="workbench-handoff-export-json"
                title={t("Export snapshot JSON file")}
              >
                <Download className="h-3 w-3" />
                {t("Export JSON")}</button>
              {decidedItems.length > 0 && (
                <label className="flex items-center gap-1.5 text-[11px] text-fg-2 cursor-pointer select-none ml-1">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={toggleAll}
                    className="accent-accent"
                  />
                  {t("Select all decided items")}</label>
              )}
            </div>
          </div>
          {decidedItems.length === 0 ? (
            <div className="p-5 rounded-[6px] bg-bg-2 border border-border text-center text-xs text-fg-3">{t("This batch has no processed items yet. Keep, modify, mark for rework or discard at least one item before publishing a handoff snapshot.")}</div>
          ) : (
            <div className="rounded-[6px] border border-border bg-bg-2 overflow-hidden">
              <table className="w-full text-left text-xs border-collapse select-text">
                <thead>
                  <tr className="bg-bg-1 border-b border-border text-fg-2 text-[11px]">
                    <th className="py-2 px-3 w-8 select-none">{t("Release")}</th>
                    <th className="py-2 px-3">{t("Item and version")}</th>
                    <th className="py-2 px-3">{t("Review result")}</th>
                    <th className="py-2 px-3">{t("Anchor coordinates / revision scope")}</th>
                    <th className="py-2 px-3">{t("Feedback and @source references")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {decidedItems.map((item) => (
                    <tr key={item.id} className="hover:bg-bg-3/50 transition-colors">
                      <td className="py-2 px-3 align-top">
                        <input
                          type="checkbox"
                          checked={effectiveChecked.has(item.id)}
                          onChange={() => toggleItem(item.id)}
                          aria-label={t("Select {{v0}} for publication", { v0: item.title })}
                          className="accent-accent"
                        />
                      </td>
                      <td className="py-2 px-3 font-medium text-fg">
                        <div>{item.title}</div>
                        <div className="font-mono tabular-nums text-[10px] text-fg-3">{t("Version v{{v0}} {{v1}}", { v0: item.version, v1: item.reworkOrigin && t(" · Rework from v{{v0}}", { v0: item.reworkOrigin.previousVersion }) })}</div>
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap align-top">
                        <span className={`font-semibold ${STATUS_CLASS[item.status]}`}>
                          {STATUS_LABELS[item.status]}
                        </span>
                        {item.hasManualRevision && item.status === "rework" && (
                          <div className="text-[10px] text-status-info">{t("Includes a human revision layer")}</div>
                        )}
                      </td>
                      <td className="py-2 px-3 font-mono text-[11px] text-fg-2 align-top">
                        {item.feedback?.targetSummary || t("Entire item v{{v0}}", { v0: item.version })}
                      </td>
                      <td className="py-2 px-3 text-fg-2 max-w-xs align-top">
                        <div className="truncate">{item.feedback?.text || "—"}</div>
                        {item.feedback?.isDraft && (
                          <div className="text-[10px] text-status-warning mt-0.5">{t("Feedback is a draft and will not be published with this snapshot")}</div>
                        )}
                        {(item.feedback?.referencedTagIds.length ?? 0) > 0 && (
                          <div className="text-[10px] font-mono text-accent mt-0.5">{t("References:{{v0}} {{v1}}", { v0: " ", v1: item.feedback?.referencedTagIds
                              .map((id) => `@${tagNameById.get(id) ?? id}`)
                              .join(" ") })}</div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Published snapshots — real delivery states only */}
        {handoffs.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-border">
            <div className="text-xs font-semibold text-fg">{t("Publication history and Agent receipt status")}</div>
            {handoffs.map((handoff, index) => (
              <div
                key={handoff.handoffId}
                className="p-3 rounded-[6px] bg-bg-2 border border-border space-y-1"
              >
                <div className="flex items-center gap-2 text-xs flex-wrap">
                  <span className="font-semibold text-fg">{t("Publication {{v0}}", { v0: handoffs.length - index })}</span>
                  {handoff.supersedesHandoffId && <span className="text-status-warning">{t("Previous handoff results updated")}</span>}
                </div>
                <div className="flex items-center gap-2 text-xs flex-wrap select-none">
                  <span className="text-fg-2 tabular-nums">{t("Published {{v0}} · Includes{{v1}} {{v2}} decisions", { v0: formatPublishedAt(handoff.publishedAt), v1: " ", v2: handoff.items.length })}</span>
                  <span className="text-fg-3">·</span>
                  {handoff.historicalOnly && <span className="text-fg-3">{t("Historical snapshot (cannot resume external tasks)")}</span>}
                  {!handoff.historicalOnly && handoff.deliveryState === "published_waiting" && (
                    <span className="text-status-warning flex items-center gap-1 font-medium">
                      <Clock className="w-3.5 h-3.5" />
                      {t("Published; waiting for the Agent to read")}</span>
                  )}
                  {!handoff.historicalOnly && handoff.deliveryState === "agent_acked" && (
                    <span className="text-status-info flex items-center gap-1 font-medium">
                      <ShieldCheck className="w-3.5 h-3.5" />
                      {t("Agent acknowledged receipt")}</span>
                  )}
                  {!handoff.historicalOnly && handoff.deliveryState === "rework_returned" && (
                    <span className="text-accent flex items-center gap-1 font-medium">
                      <CircleCheck className="w-3.5 h-3.5" />
                      {t("Rework results returned to the pending queue")}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-5 py-3 bg-bg-1 border-t border-border flex items-center justify-between gap-3">
        <div className="text-xs text-fg-2 min-w-0 truncate select-none">
          {latestHandoff
            ? t("Latest snapshot status: {{v0}}", { v0: latestHandoff.deliveryState === "published_waiting"
                  ? t("Returned; waiting to be read")
                  : latestHandoff.deliveryState === "agent_acked"
                    ? t("Agent reported receipt")
                    : t("Rework returned") })
            : t("Current status: saved locally (no snapshot published yet)")}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className={wbButton.secondary}
          >{t("Close window")}</button>
          <button
            type="button"
            onClick={() => void handlePublish()}
            disabled={preparing || decidedItems.length === 0 || checkedCount === 0 || publishing}
            className={wbButton.primary}
          >
            <Send className="w-3.5 h-3.5" />
            {publishing
              ? t("Publishing…")
              : latestHandoff
                ? t("Update handoff results ({{v0}} items)", { v0: checkedCount })
                : t("Publish handoff results ({{v0}} items)", { v0: checkedCount })}
          </button>
        </div>
      </div>
    </ToolcraftDialog>
  );
}
