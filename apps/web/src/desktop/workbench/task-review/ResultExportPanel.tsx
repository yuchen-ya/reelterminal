import { t } from "../../../i18n";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  TaskCommit,
  TaskReviewSnapshot,
  TaskSourceFile,
} from "../../../../../desktop/src/shared/task-review";
import type {
  TaskExportPreviewInput,
  TaskExportReviewStatus,
  TaskOriginalExportItem,
  TaskOriginalExportRecord,
  TaskDerivedOutput,
} from "../../../../../desktop/src/shared/task-review-export";
import { isCurrentTaskUnit } from "../../../../../desktop/src/shared/task-review";
import { selectTaskDecisionHistory } from "../../../../../desktop/src/shared/task-review-selectors";
import { wbButton } from "../wb-button";
import { errorMessage } from "./bridge";
import { REVIEW_PURPOSE } from "./queries";
import { sourceTitle, unitTitle } from "./display";

/**
 * Original-file export panel for the task-review workbench.
 *
 * The reviewer filters by review status, checks original files across sources,
 * picks an external destination (plus an optional category folder per entry),
 * previews what the service would copy, then executes. Source files are never
 * moved or rewritten; the service copies originals and writes a manifest.
 *
 * Integration contract (the controller stays the only writer):
 * - `snapshot` is the live task snapshot; this panel never applies returned
 *   snapshots itself. `onPreview`/`onExecute` mirror
 *   `TaskReviewExportBridge` exactly and must be queued through the same
 *   serialized mutation queue as other task mutations, applying the returned
 *   snapshot on success. The panel passes the commit envelope
 *   (root/taskId/expectedRevision) it saw at click time; a queue wrapper may
 *   re-stamp it against the snapshot at execution time (the bridge retries a
 *   revision conflict once).
 * - `onChooseDestination` is wired by the host to
 *   `window.reelterminal.fs.showOpenDialog({ directory: true, filters: [] })`;
 *   `null` means the dialog was cancelled and keeps the current choice.
 * - The panel is collapsed by default; the host scene opens it on demand via
 *   `open`/`onOpenChange` (or `defaultOpen`).
 */

const STATUS_ORDER: readonly TaskExportReviewStatus[] = [
  "kept",
  "rework",
  "discarded",
  "pending",
  "recheck",
];

export const exportStatusLabels: Record<TaskExportReviewStatus, string> = {
  get kept() { return t("Keep"); },
  get rework() { return t("Rework"); },
  get discarded() { return t("Discard"); },
  get pending() { return t("Pending"); },
  get recheck() { return t("Needs recheck"); },
};

const RECEIPT_STATUS_TEXT: Record<TaskOriginalExportRecord["status"], string> = {
  get planned() { return t("Not run"); },
  get running() { return t("reviewUi.running"); },
  get complete() { return t("All succeeded"); },
  get partial() { return t("Partially succeeded"); },
  get failed() { return t("All failed"); },
};

export interface ResultExportFileRow {
  entryId: string;
  sourceVersionId: string;
  relativePath: string;
  fileStatus: TaskSourceFile["status"];
  fileError?: string;
  distribution: Record<TaskExportReviewStatus, number>;
  mixed: boolean;
  allKept: boolean;
  matchedUnitCount: number;
  totalUnitCount: number;
}

const emptyDistribution = (): Record<TaskExportReviewStatus, number> => ({
  kept: 0,
  rework: 0,
  discarded: 0,
  pending: 0,
  recheck: 0,
});

/**
 * Live projection of exportable originals with their unit status spread.
 * Mirrors the service derivation (applied decision, else recheck when only a
 * stale-policy history exists, else pending); the preview returned by the
 * service stays the authority for what will actually be copied.
 */
export function exportFileRows(
  snapshot: TaskReviewSnapshot,
  statuses: readonly TaskExportReviewStatus[],
): ResultExportFileRow[] {
  const filter = new Set(statuses);
  return snapshot.sourceFiles
    .filter((file) => file.currentVersionId)
    .map((file): ResultExportFileRow => {
      const sourceVersionId = file.currentVersionId!;
      const distribution = emptyDistribution();
      let matchedUnitCount = 0;
      let totalUnitCount = 0;
      for (const unit of snapshot.units) {
        if (unit.sourceVersionId !== sourceVersionId || !isCurrentTaskUnit(snapshot, unit)) continue;
        totalUnitCount++;
        const history = selectTaskDecisionHistory(snapshot, {
          unitId: unit.id,
          sourceVersionId,
          purpose: REVIEW_PURPOSE,
        });
        const status: TaskExportReviewStatus =
          history.current?.status ?? (history.needsRecheck ? "recheck" : "pending");
        distribution[status]++;
        if (filter.has(status)) matchedUnitCount++;
      }
      const present = STATUS_ORDER.filter((status) => distribution[status] > 0);
      return {
        entryId: file.entryId,
        sourceVersionId,
        relativePath: file.relativePath,
        fileStatus: file.status,
        ...(file.error ? { fileError: file.error } : {}),
        distribution,
        mixed: present.length > 1,
        allKept: totalUnitCount > 0 && distribution.kept === totalUnitCount,
        matchedUnitCount,
        totalUnitCount,
      };
    })
    .sort(
      (a, b) =>
        a.relativePath.localeCompare(b.relativePath) ||
        a.entryId.localeCompare(b.entryId),
    );
}

const distributionSummary = (
  distribution: Record<TaskExportReviewStatus, number>,
): string =>
  STATUS_ORDER.filter((status) => distribution[status] > 0)
    .map((status) => `${exportStatusLabels[status]} ${distribution[status]}`)
    .join(" · ");

const copiedCount = (record: TaskOriginalExportRecord): number =>
  record.items.filter((item) => item.status === "copied").length;

/** Conditions the preview was computed from; any change makes it stale. */
interface PreviewBasis {
  statuses: TaskExportReviewStatus[];
  sourceEntryIds: string[];
  destination: string;
  classifications: { entryId: string; category: string }[];
  derivedOutputs: TaskDerivedOutput[];
}

export interface ResultExportPanelProps {
  snapshot: TaskReviewSnapshot;
  onPreview: (
    input: TaskExportPreviewInput,
  ) => Promise<{
    snapshot: TaskReviewSnapshot;
    preview: TaskOriginalExportRecord;
  }>;
  onExecute: (
    input: TaskCommit & { exportId: string },
  ) => Promise<{
    snapshot: TaskReviewSnapshot;
    receipt: TaskOriginalExportRecord;
  }>;
  onChooseDestination: () => Promise<string | null>;
  busy?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ResultExportPanel({
  snapshot,
  onPreview,
  onExecute,
  onChooseDestination,
  busy = false,
  open,
  defaultOpen = false,
  onOpenChange,
}: ResultExportPanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultOpen);
  const isOpen = open ?? expanded;
  const [statuses, setStatuses] = useState<readonly TaskExportReviewStatus[]>([
    "kept",
  ]);
  const [selectedEntryIds, setSelectedEntryIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [derivedOutputs, setDerivedOutputs] = useState<TaskDerivedOutput[]>([]);
  const [destination, setDestination] = useState<string | null>(null);
  const [categories, setCategories] = useState<Record<string, string>>({});
  const [bulkCategory, setBulkCategory] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    record: TaskOriginalExportRecord;
    basis: PreviewBasis;
  } | null>(null);
  const [localReceipt, setLocalReceipt] =
    useState<TaskOriginalExportRecord | null>(null);

  const rows = useMemo(
    () => exportFileRows(snapshot, statuses),
    [snapshot, statuses],
  );
  const canonicalStatuses = STATUS_ORDER.filter((status) =>
    statuses.includes(status),
  );
  const missingSelectedIds = [...selectedEntryIds].filter(
    (entryId) => !rows.some((row) => row.entryId === entryId),
  );
  const derivedRows = snapshot.units.filter((unit) => (unit.kind === "video-frame" || unit.kind === "region") && isCurrentTaskUnit(snapshot, unit)).map((unit) => {
    const history = selectTaskDecisionHistory(snapshot, { unitId: unit.id, sourceVersionId: unit.sourceVersionId, purpose: REVIEW_PURPOSE });
    const status: TaskExportReviewStatus = history.current?.status ?? (history.needsRecheck ? "recheck" : "pending");
    const source = snapshot.sources.find((item) => item.id === unit.sourceVersionId)!;
    return { unit, status, source };
  }).filter((row) => statuses.includes(row.status));
  const selectedSourceEntries = useMemo(() => new Set([
    ...selectedEntryIds,
    ...derivedOutputs.flatMap((output) => {
      const unit = snapshot.units.find((item) => item.id === output.unitId);
      const source = snapshot.sources.find((item) => item.id === unit?.sourceVersionId);
      return source ? [source.entryId] : [];
    }),
  ]), [derivedOutputs, selectedEntryIds, snapshot.sources, snapshot.units]);
  const classifications = useMemo(
    () =>
      [...selectedSourceEntries]
        .map((entryId) => ({
          entryId,
          category: (categories[entryId] ?? "").trim(),
        }))
        .filter((item) => item.category.length > 0)
        .sort((a, b) => a.entryId.localeCompare(b.entryId)),
    [categories, selectedSourceEntries],
  );
  const basis: PreviewBasis = {
    statuses: canonicalStatuses,
    sourceEntryIds: [...selectedEntryIds].sort(),
    destination: destination ?? "",
    classifications,
    derivedOutputs,
  };
  const previewStale =
    preview !== null && JSON.stringify(preview.basis) !== JSON.stringify(basis);

  const previewFinished = Boolean(preview && (
    (localReceipt?.id === preview.record.id && localReceipt.completedAt !== undefined) ||
    snapshot.originalExports?.some((record) => record.id === preview.record.id && record.completedAt !== undefined)
  ));

  const canPreview =
    (!previewFinished || previewStale) &&
    canonicalStatuses.length > 0 &&
    (selectedEntryIds.size > 0 || derivedOutputs.length > 0) &&
    destination !== null &&
    !previewing &&
    !executing &&
    !busy;

  /**
   * Most recent finished receipt: the snapshot's persisted records (restore
   * path) are display-only history; the live selection above never derives
   * from them. A receipt obtained locally this session wins ties by id.
   */
  const lastReceipt = useMemo<TaskOriginalExportRecord | null>(() => {
    const byId = new Map<string, TaskOriginalExportRecord>();
    for (const record of snapshot.originalExports ?? [])
      if (record.completedAt) byId.set(record.id, record);
    if (localReceipt?.completedAt) byId.set(localReceipt.id, localReceipt);
    return (
      [...byId.values()].sort(
        (a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0),
      )[0] ?? null
    );
  }, [localReceipt, snapshot.originalExports]);

  const previewMatchedUnits = preview
    ? preview.record.items.reduce(
      (sum, item) => sum + item.matchedUnitIds.length,
      0,
    )
    : 0;
  const previewUnavailableCount = preview
    ? preview.record.items.filter((item) => item.status === "unavailable")
      .length
    : 0;
  // Any commit after the reservation may be relevant; the service re-validates
  // at execute time, so this is a hint, never an automatic invalidation.
  const revisionMoved =
    preview !== null && snapshot.revision > preview.record.previewRevision + 1;


  const toggleOpen = () => {
    if (open === undefined) setExpanded(!isOpen);
    onOpenChange?.(!isOpen);
  };
  const toggleStatus = (status: TaskExportReviewStatus, checked: boolean) => {
    setStatuses((current) => {
      const next = new Set(current);
      if (checked) next.add(status);
      else next.delete(status);
      return STATUS_ORDER.filter((item) => next.has(item));
    });
  };
  const toggleEntry = (entryId: string, checked: boolean) => {
    setSelectedEntryIds((current) => {
      const next = new Set(current);
      if (checked) next.add(entryId);
      else next.delete(entryId);
      return next;
    });
  };
  const chooseDestination = async () => {
    if (choosing) return;
    setChoosing(true);
    try {
      // null = dialog cancelled: keep the current destination and selection.
      const picked = await onChooseDestination();
      if (picked !== null) setDestination(picked);
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setChoosing(false);
    }
  };
  const applyBulkCategory = () => {
    const category = bulkCategory.trim();
    setCategories((current) => {
      const next = { ...current };
      for (const entryId of selectedSourceEntries) {
        if (category) next[entryId] = category;
        else delete next[entryId];
      }
      return next;
    });
  };
  const runPreview = async () => {
    if (!canPreview || destination === null) return;
    setPreviewing(true);
    setError(null);
    try {
      const input: TaskExportPreviewInput = {
        root: snapshot.root,
        taskId: snapshot.taskId,
        expectedRevision: snapshot.revision,
        purpose: REVIEW_PURPOSE,
        statuses: canonicalStatuses,
        // Always explicit: an unchecked selection must never degrade to
        // "every source" on the service side.
        sourceEntryIds: [...selectedEntryIds].sort(),
        ...(derivedOutputs.length ? { derivedOutputs } : {}),
        destination,
        ...(classifications.length > 0 ? { classifications } : {}),
      };
      const result = await onPreview(input);
      setPreview({ record: result.preview, basis });
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setPreviewing(false);
    }
  };
  const runExecute = async () => {
    if (!preview || previewFinished || previewStale || previewing || executing || busy) return;
    setExecuting(true);
    setError(null);
    try {
      const result = await onExecute({
        root: snapshot.root,
        taskId: snapshot.taskId,
        expectedRevision: snapshot.revision,
        exportId: preview.record.id,
      });
      setLocalReceipt(result.receipt);
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setExecuting(false);
    }
  };

  const receiptItemText = (item: TaskOriginalExportItem): string =>
    item.status === "copied"
      ? t("Copied")
      : item.status === "unavailable"
        ? t("Cannot copy: {{reason}}", { reason: item.error ?? "" })
        : t("Failed: {{reason}}", { reason: item.error ?? "" });
  const outputLabels = { original: t("Original"), frame: t("Frozen frame"), mask: t("Mask"), cutout: t("Transparent cutout") };
  const toggleDerived = (output: TaskDerivedOutput, checked: boolean) => {
    setDerivedOutputs((current) => checked
      ? [...current.filter((item) => item.unitId !== output.unitId || item.kind !== output.kind), output]
      : current.filter((item) => item.unitId !== output.unitId || item.kind !== output.kind));
  };

  return (
    <section
      className="flex flex-col gap-1.5 rounded border border-border p-2 text-xs"
      data-testid="task-result-export-panel"
      data-open={isOpen}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={wbButton.ghost}
          aria-expanded={isOpen}
          data-testid="task-result-export-toggle"
          onClick={toggleOpen}
        >
          {isOpen ? "▾" : "▸"} {t("Export review results (originals / cutouts / frames)")}
        </button>
        {lastReceipt && (
          <span className="truncate text-fg-3">
            {t("Latest receipt: {{status}} ({{copied}}/{{total}} copied)", {
              status: t(RECEIPT_STATUS_TEXT[lastReceipt.status]),
              copied: copiedCount(lastReceipt),
              total: lastReceipt.items.length,
            })}
          </span>
        )}
      </div>
      {isOpen && (
        <div className="flex flex-col gap-2">
          {error && (
            <p
              role="alert"
              className="rounded border border-status-error/40 p-2 text-status-error"
              data-testid="task-result-export-error"
            >
              {error}
              <button
                type="button"
                className={`${wbButton.ghost} ml-2`}
                onClick={() => setError(null)}
              >
                {t("Got it")}
              </button>
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-fg-3">{t("reviewUi.Filter_by_review_status_331")}</span>
            {STATUS_ORDER.map((status) => (
              <label key={status} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  data-testid={`task-result-export-status-${status}`}
                  checked={statuses.includes(status)}
                  onChange={(event) =>
                    toggleStatus(status, event.target.checked)
                  }
                />
                {t(exportStatusLabels[status])}
              </label>
            ))}
            {canonicalStatuses.length === 0 && (
              <span className="text-status-error">
                {t("Select at least one status")}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <strong>{t("Select source files to copy")}</strong>
              <button
                type="button"
                className={wbButton.ghost}
                data-testid="task-result-export-select-all"
                title={t("Select every file with matching items under the current filter")}
                onClick={() =>
                  setSelectedEntryIds(
                    new Set(
                      rows
                        .filter((row) => row.matchedUnitCount > 0)
                        .map((row) => row.entryId),
                    ),
                  )
                }
              >
                {t("Select all current results")}
              </button>
              <button
                type="button"
                className={wbButton.ghost}
                data-testid="task-result-export-clear-selection"
                disabled={selectedEntryIds.size === 0 && derivedOutputs.length === 0}
                onClick={() => {
                  setSelectedEntryIds(new Set());
                  setDerivedOutputs([]);
                }}
              >
                {t("Clear")}
              </button>
              <span className="text-fg-3">
                {t("{{count}} files selected", { count: selectedEntryIds.size })}
              </span>
              {missingSelectedIds.length > 0 && (
                <span className="text-status-error">
                  {t(
                    "{{count}} selected files are no longer in the parsed results; the service will validate them during execution",
                    { count: missingSelectedIds.length },
                  )}
                </span>
              )}
            </div>
            <ul
              className="flex max-h-56 flex-col gap-0.5 overflow-y-auto"
              data-testid="task-result-export-files"
            >
              {rows.map((row) => (
                <li
                  key={row.entryId}
                  className="flex flex-wrap items-center gap-2 rounded px-1 py-1 hover:bg-bg-2"
                  data-testid="task-result-export-file"
                  data-entry-id={row.entryId}
                  data-file-status={row.fileStatus}
                  data-mixed={row.mixed}
                >
                  <input
                    type="checkbox"
                    aria-label={t("Select source file {{path}}", {
                      path: row.relativePath,
                    })}
                    checked={selectedEntryIds.has(row.entryId)}
                    onChange={(event) =>
                      toggleEntry(row.entryId, event.target.checked)
                    }
                  />
                  <span
                    className="min-w-0 flex-1 truncate"
                    title={row.fileError ?? row.relativePath}
                  >
                    {sourceTitle(row.relativePath)}
                  </span>
                  <span className="shrink-0 text-fg-3">
                    {distributionSummary(row.distribution) || t("No parsed items")}
                  </span>
                  {row.mixed ? (
                    <span
                      className="shrink-0 rounded bg-status-warning/15 px-1 py-0.5 text-status-warning"
                      data-testid="task-result-export-mixed"
                      title={t(
                        "This file contains items with different statuses and will not be treated as entirely approved",
                      )}
                    >
                      {t("Mixed")}
                    </span>
                  ) : row.allKept ? (
                    <span className="shrink-0 text-fg-3">{t("All kept")}</span>
                  ) : null}
                  <span
                    className={
                      row.matchedUnitCount > 0
                        ? "shrink-0 text-accent"
                        : "shrink-0 text-fg-3"
                    }
                  >
                    {t("{{count}} matches", { count: row.matchedUnitCount })}
                  </span>
                  {row.fileStatus !== "available" && (
                    <span
                      className="shrink-0 text-status-error"
                      title={row.fileError}
                    >
                      {row.fileStatus === "missing"
                        ? t("File missing")
                        : t("Cannot parse")}
                    </span>
                  )}
                  {selectedEntryIds.has(row.entryId) && (
                    <input
                      className="w-28 rounded border border-border bg-bg-2 px-1 py-0.5"
                      aria-label={t("Category for {{path}}", {
                        path: row.relativePath,
                      })}
                      placeholder={t("Category (optional)")}
                      value={categories[row.entryId] ?? ""}
                      onChange={(event) =>
                        setCategories((current) => ({
                          ...current,
                          [row.entryId]: event.target.value,
                        }))
                      }
                    />
                  )}
                </li>
              ))}
              {!rows.length && (
                <li className="p-3 text-center text-fg-3">
                  {t("The task has no parsed source files")}
                </li>
              )}
            </ul>
          </div>
          {(derivedRows.length > 0 || derivedOutputs.length > 0) && <section className="flex flex-col gap-2 border-t border-border pt-2" data-testid="task-result-export-derived">
            <strong>{t("Frame and region results · Selected ")}{derivedOutputs.length} {t(" items")}</strong>
            {derivedOutputs.some((output) => !derivedRows.some((row) => row.unit.id === output.unitId)) && <p className="text-status-warning">{t("Some selected results no longer match the filter or version and will be revalidated during preview.")}</p>}
            {derivedRows.map(({ unit, status, source }) => <div key={unit.id} className="flex flex-wrap items-center gap-3" data-testid="task-result-export-derived-row" data-unit-id={unit.id}>
              <span className="min-w-0 max-w-80 truncate" title={source.relativePath}>{sourceTitle(source.relativePath)} · {unitTitle(unit)}</span>
              <span className="text-fg-3">{exportStatusLabels[status]}</span>
              {(unit.kind === "region" ? ["cutout", "mask"] as const : ["frame"] as const).map((kind) => <label key={kind} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  data-testid="task-result-export-derived-select"
                  data-output-kind={kind}
                  aria-label={t("Export {{v0}} {{v1}}", { v0: outputLabels[kind], v1: unitTitle(unit) })}
                  checked={derivedOutputs.some((output) => output.unitId === unit.id && output.kind === kind)}
                  onChange={(event) => toggleDerived({ unitId: unit.id, kind }, event.target.checked)} />
                {outputLabels[kind]} {t(" PNG")}</label>)}
            </div>)}
          </section>}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-fg-3">
              {t("Category (optional; copy into a subfolder with this name at the destination)")}
            </span>
            <input
              className="w-36 rounded border border-border bg-bg-2 px-1 py-0.5"
              aria-label={t("Shared category name")}
              placeholder={t("One safe folder name")}
              value={bulkCategory}
              onChange={(event) => setBulkCategory(event.target.value)}
            />
            <button
              type="button"
              className={wbButton.secondary}
              data-testid="task-result-export-apply-category"
              disabled={selectedSourceEntries.size === 0}
              title={t(
                "Set one category for selected files; override individual rows or leave blank to clear",
              )}
              onClick={applyBulkCategory}
            >
              {t("Apply to selected")}
            </button>
            <span className="text-fg-3">
              {t("Copy originals or generated results without moving or modifying source files")}
            </span>
          </div>
          <div
            className="flex items-center gap-2"
            data-testid="task-result-export-destination"
          >
            <span className="text-fg-3">{t("Export destination")}</span>
            <span
              className="min-w-0 flex-1 truncate"
              title={destination ?? undefined}
              data-testid="task-result-export-destination-path"
            >
              {destination ?? t("Not selected (must be outside the task folder)")}
            </span>
            <button
              type="button"
              className={wbButton.secondary}
              data-testid="task-result-export-choose-destination"
              disabled={choosing || executing}
              onClick={() => void chooseDestination()}
            >
              {choosing ? t("Selecting…") : t("Choose directory…")}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={wbButton.primary}
              data-testid="task-result-export-preview-button"
              disabled={!canPreview}
              onClick={() => void runPreview()}
            >
              {previewing ? t("Previewing…") : t("Preview export")}
            </button>
            {canonicalStatuses.length > 0 &&
              selectedEntryIds.size === 0 && derivedOutputs.length === 0 && (
                <span className="text-fg-3">
                  {t("Select at least one source file first; all files are never exported by default")}
                </span>
              )}
          </div>
          {preview && (
            <div
              className="flex flex-col gap-1 rounded border border-border p-2"
              data-testid="task-result-export-preview"
              data-stale={previewStale}
            >
              <div className="flex flex-wrap items-center gap-2">
                <strong>
                  {t(
                    "Preview: copy {{files}} files · {{units}} matching items · {{unavailable}} unavailable",
                    {
                      files: preview.record.items.length,
                      units: previewMatchedUnits,
                      unavailable: previewUnavailableCount,
                    },
                  )}
                </strong>
                {previewStale ? (
                  <span
                    className="text-status-error"
                    data-testid="task-result-export-preview-stale"
                  >
                    {t("Export conditions changed. Preview again before executing.")}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={wbButton.primary}
                    data-testid="task-result-export-execute-button"
                    disabled={previewFinished || executing || previewing || busy}
                    onClick={() => void runExecute()}
                  >
                    {previewFinished ? t("Executed. Change your selection to preview again.") : executing
                      ? t("Exporting…")
                      : t("Execute export (copy {{count}} files)", {
                        count: preview.record.items.length,
                      })}
                  </button>
                )}
              </div>
              <span
                className="truncate text-fg-3"
                title={preview.record.outputDirectory}
              >
                {t("Output directory: {{path}}", {
                  path: preview.record.outputDirectory,
                })}
              </span>
              {revisionMoved && lastReceipt?.id !== preview.record.id && (
                <span
                  role="status"
                  className="text-fg-3"
                  data-testid="task-result-export-preview-revision-note"
                >
                  {t(
                    "Review changed after preview. The service will validate current state and require a new preview if relevant sources or decisions changed.",
                  )}
                </span>
              )}
              <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
                {preview.record.items.map((item) => (
                  <li
                    key={`${item.outputKind ?? "original"}:${item.artifactUnitId ?? item.entryId}`}
                    className="flex flex-wrap items-center gap-2"
                    data-testid="task-result-export-preview-item"
                    data-item-status={item.status}
                    data-output-kind={item.outputKind ?? "original"}
                  >
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={item.error ?? item.relativePath}
                    >
                      {outputLabels[item.outputKind ?? "original"]} · {item.label ?? sourceTitle(item.relativePath)}
                      {item.category
                        ? ` → ${item.category}/${sourceTitle(item.relativeOutputPath)}`
                        : ""}
                    </span>
                    <span className="shrink-0 text-fg-3">
                      {t("{{count}} matching items", {
                        count: item.matchedUnitIds.length,
                      })}
                    </span>
                    <span className="shrink-0 text-fg-3">
                      {distributionSummary(item.distribution)}
                    </span>
                    {item.mixed ? (
                      <span className="shrink-0 text-status-warning">
                        {t("Mixed")}
                      </span>
                    ) : item.allKept ? (
                      <span className="shrink-0 text-fg-3">
                        {t("All kept")}
                      </span>
                    ) : null}
                    {item.status === "unavailable" && (
                      <span
                        className="shrink-0 text-status-error"
                        title={item.error}
                      >
                        {t("Cannot copy: {{reason}}", {
                          reason: item.error ?? "",
                        })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {lastReceipt && (
            <div
              className="flex flex-col gap-1 rounded border border-border p-2"
              data-testid="task-result-export-receipt"
              data-status={lastReceipt.status}
            >
              <div className="flex flex-wrap items-center gap-2">
                <strong>{t("Latest export receipt")}</strong>
                {window.reelterminal?.fs?.revealInFolder && <button
                  type="button"
                  className={wbButton.secondary}
                  data-testid="task-result-export-reveal"
                  onClick={() => void window.reelterminal!.fs.revealInFolder(lastReceipt.manifestStatus === "written" ? lastReceipt.manifestPath : lastReceipt.outputDirectory).catch((problem) => setError(errorMessage(problem)))}>{t("reviewUi.Show_in_folder_374")}</button>}
                <span
                  className={
                    lastReceipt.status === "complete"
                      ? "text-accent"
                      : lastReceipt.status === "partial"
                        ? "text-status-warning"
                        : "text-status-error"
                  }
                  data-testid="task-result-export-receipt-status"
                >
                  {t(RECEIPT_STATUS_TEXT[lastReceipt.status])}
                  {t(" ({{copied}}/{{total}} files copied)", {
                    copied: copiedCount(lastReceipt),
                    total: lastReceipt.items.length,
                  })}
                </span>
                <span className="min-w-0 flex-1 truncate text-fg-3">
                  {t("Manifest: {{path}}", {
                    path:
                      lastReceipt.manifestStatus === "written"
                        ? lastReceipt.manifestPath
                        : t("Not written"),
                  })}
                </span>
              </div>
              {lastReceipt.error && (
                <span
                  className="text-status-error"
                  title={lastReceipt.error}
                  data-testid="task-result-export-receipt-error"
                >
                  {lastReceipt.error}
                </span>
              )}
              <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
                {lastReceipt.items.map((item) => (
                  <li
                    key={`${item.outputKind ?? "original"}:${item.artifactUnitId ?? item.entryId}`}
                    className="flex items-center gap-2"
                    data-testid="task-result-export-receipt-item"
                    data-item-status={item.status}
                    data-output-kind={item.outputKind ?? "original"}
                  >
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={item.error ?? item.relativePath}
                    >
                      {outputLabels[item.outputKind ?? "original"]} · {item.label ?? sourceTitle(item.relativePath)}
                    </span>
                    <span
                      className={
                        item.status === "copied"
                          ? "shrink-0 text-accent"
                          : "shrink-0 text-status-error"
                      }
                    >
                      {receiptItemText(item)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
