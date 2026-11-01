import { LocalizedMessage } from "../../../i18n/LocalizedMessage";
import { getAppLocale } from "../../../i18n";
import { useTranslation } from "react-i18next";
import { t as translate } from "../../../i18n";
/**
 * Local batch creation from the project media library (no Agent required).
 *
 * The dialog freezes one submission identity per selected-media fingerprint.
 * A failed retry with the same selection reuses batchId/itemIds; changing the
 * selection discards the frozen identity and mints a new one.
 */
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  Check,
  Film,
  Image as ImageIcon,
  Loader2,
  Plus,
  Search,
} from "lucide-react";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import type {
  CreateWorkbenchBatchInput,
  CreateWorkbenchBatchResult,
  WorkbenchMediaAsset,
} from "../types";
import { wbButton } from "../wb-button";

export interface CreateWorkbenchBatchDialogProps {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly assets: readonly WorkbenchMediaAsset[];
  readonly onCreate: (
    input: CreateWorkbenchBatchInput,
  ) => Promise<CreateWorkbenchBatchResult>;
  /** Real host navigation to the media/assets panel. */
  readonly onOpenMediaLibrary: () => void;
}

interface FrozenSubmission {
  readonly fingerprint: string;
  readonly batchId: string;
  readonly itemIds: readonly string[];
}

function fingerprintOf(ids: readonly string[]): string {
  return [...ids].sort().join("|");
}

function newSubmission(ids: readonly string[]): FrozenSubmission {
  return {
    fingerprint: fingerprintOf(ids),
    batchId: `wb-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`,
    itemIds: ids.map(() => `wb-item-${crypto.randomUUID()}`),
  };
}

function usageLabel(usage: WorkbenchMediaAsset["usage"]): string | null {
  if (usage === "pending") return translate("In the workbench · Pending");
  if (usage === "processed") return translate("Reviewed");
  return null;
}

export function CreateWorkbenchBatchDialog({
  isOpen,
  onOpenChange,
  assets,
  onCreate,
  onOpenMediaLibrary,
}: CreateWorkbenchBatchDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [submission, setSubmission] = useState<FrozenSubmission | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName(translate("Media review {{v0}}", { v0: new Date().toLocaleString(getAppLocale()) }));
    setDescription("");
    setSearch("");
    setSelected([]);
    setSubmission(null);
    setBusy(false);
    setError(null);
  }, [isOpen]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? assets.filter((asset) => asset.name.toLowerCase().includes(query))
      : assets;
  }, [assets, search]);

  const toggle = (id: string): void => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((candidate) => candidate !== id) : [...prev, id],
    );
    setError(null);
  };

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((asset) => selected.includes(asset.id));

  const toggleAllFiltered = (): void => {
    setSelected((prev) => {
      const filteredIds = filtered.map((asset) => asset.id);
      return allFilteredSelected
        ? prev.filter((id) => !filteredIds.includes(id))
        : [...new Set([...prev, ...filteredIds])];
    });
    setError(null);
  };

  const submit = async (): Promise<void> => {
    if (!selected.length || busy) return;
    const fingerprint = fingerprintOf(selected);
    // Same selection → reuse the frozen ids even after a failed attempt.
    const frozen =
      submission && submission.fingerprint === fingerprint
        ? submission
        : newSubmission(selected);
    setSubmission(frozen);
    setBusy(true);
    setError(null);
    try {
      const result = await onCreate({
        name,
        ...(description.trim() ? { description: description.trim() } : {}),
        mediaIds: selected,
        batchId: frozen.batchId,
        itemIds: frozen.itemIds,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ToolcraftDialog isOpen={isOpen} onOpenChange={onOpenChange} width="72rem">
      <ToolcraftDialogHeader title={t("Create a batch from project media")} />
      <div
        className="flex max-h-[78vh] min-h-0 flex-col text-xs"
        data-testid="create-workbench-batch-dialog"
        data-workbench-modal="true"
        data-workbench-scope="true"
      >
        <div className="grid shrink-0 gap-2.5 border-b border-border bg-bg-1 p-4 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-fg-2">
            <span>{t("review.batchName")}</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded-[6px] border border-border bg-bg-2 px-2.5 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
              data-testid="create-batch-name"
            />
          </label>
          <label className="space-y-1 text-xs text-fg-2">
            <span>{t("personalTemplates.description")}</span>
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("For example: Local media review, round 3")}
              className="w-full rounded-[6px] border border-border bg-bg-2 px-2.5 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
              data-testid="create-batch-description"
            />
          </label>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-bg-1 px-4 py-2">
          <div className="flex min-w-[180px] flex-1 items-center gap-1.5 rounded-[6px] border border-border bg-bg-2 px-2.5 py-1">
            <Search className="h-3.5 w-3.5 text-fg-3" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("projectAssets.search")}
              className="w-full bg-transparent text-xs text-fg placeholder:text-fg-3 focus:outline-none"
              data-testid="create-batch-search"
            />
          </div>
          <button
            type="button"
            onClick={toggleAllFiltered}
            disabled={filtered.length === 0}
            className={wbButton.secondary}
          >
            {allFilteredSelected ? t("Deselect all") : t("projectLibrary.selectAll")}
          </button>
          <span className="font-mono tabular-nums text-[11px] text-fg-3">{t("Selected {{v0}} / {{v1}}", { v0: selected.length, v1: assets.length })}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {assets.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-[6px] border border-border bg-bg-2 p-8 text-center">
              <ImageIcon className="h-5 w-5 text-fg-3" />
              <div className="text-sm font-medium text-fg">{t("No images or videos in project media")}</div>
              <p className="max-w-md text-xs text-fg-3">{t("Import PNG/JPG or MP4 files into the project media panel first. Text and tables must be ingested by an Agent or pasted; they cannot be created from media.")}</p>
              <button
                type="button"
                onClick={onOpenMediaLibrary}
                className={wbButton.primary}
                data-testid="create-batch-open-media"
              >{t("Open project media")}</button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-xs text-fg-3">{t("No matching media")}</div>
          ) : (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
              {filtered.map((asset) => {
                const active = selected.includes(asset.id);
                const usage = usageLabel(asset.usage);
                return (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => toggle(asset.id)}
                    data-testid="create-batch-media-card"
                    data-media-id={asset.id}
                    className={`flex min-w-0 flex-col overflow-hidden rounded-[6px] border text-left transition-colors ${
                      active
                        ? "border-accent bg-accent-soft"
                        : "border-border bg-bg-2 hover:border-border-strong"
                    }`}
                  >
                    <div className="relative flex h-24 items-center justify-center bg-stage-bg">
                      {asset.type === "image" && asset.thumbnailUrl ? (
                        <img
                          src={asset.thumbnailUrl}
                          alt={asset.name}
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <Film className="h-6 w-6 text-fg-3" />
                      )}
                      <span
                        className={`absolute top-1 left-1 flex h-4 w-4 items-center justify-center rounded-full border ${
                          active
                            ? "border-accent bg-accent text-accent-foreground"
                            : "border-border-strong bg-bg/80 text-transparent"
                        }`}
                      >
                        <Check className="h-2.5 w-2.5" />
                      </span>
                    </div>
                    <div className="min-w-0 space-y-0.5 p-2">
                      <div className="truncate text-xs font-medium text-fg" title={asset.name}>
                        {asset.name}
                      </div>
                      <div className="flex flex-wrap items-center gap-1 font-mono tabular-nums text-[10px] text-fg-3">
                        <span>{asset.type === "image" ? t("review.kind.image") : t("review.kind.video")}</span>
                        {asset.width && asset.height && (
                          <span>
                            {asset.width}×{asset.height}
                          </span>
                        )}
                        {asset.durationSec !== undefined && (
                          <span>{asset.durationSec.toFixed(1)}s</span>
                        )}
                      </div>
                      {usage && (
                        <span
                          className={`inline-block rounded px-1 py-0.5 text-[10px] ${
                            asset.usage === "pending"
                              ? "bg-status-warning/15 text-status-warning"
                              : "bg-status-info/15 text-status-info"
                          }`}
                          data-testid={`media-usage-${asset.usage}`}
                        >
                          {usage}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {error && (
          <div className="shrink-0 border-t border-status-error/40 bg-status-error/10 px-4 py-2 text-xs text-status-error">
            <LocalizedMessage>{error}</LocalizedMessage>
          </div>
        )}

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-bg-1 px-4 py-3">
          <div className="text-[11px] text-fg-3">{t("Text and tables cannot be created from media. Media may be included in another batch; reviewed status is only a hint.")}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className={wbButton.secondary}
            >{t("review.cancel")}</button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={selected.length === 0 || busy}
              className={wbButton.primary}
              data-testid="create-batch-submit"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              {t("Create batch and start review (")}{selected.length}）
            </button>
          </div>
        </div>
      </div>
    </ToolcraftDialog>
  );
}
