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
  if (usage === "pending") return "已在工作台 · 待处理";
  if (usage === "processed") return "已审阅";
  return null;
}

export function CreateWorkbenchBatchDialog({
  isOpen,
  onOpenChange,
  assets,
  onCreate,
  onOpenMediaLibrary,
}: CreateWorkbenchBatchDialogProps): JSX.Element {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [submission, setSubmission] = useState<FrozenSubmission | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName(`素材审阅 ${new Date().toLocaleString()}`);
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
      <ToolcraftDialogHeader title="从项目素材创建批次" />
      <div className="flex max-h-[78vh] min-h-0 flex-col" data-testid="create-workbench-batch-dialog">
        <div className="grid shrink-0 gap-2 border-b border-border p-4 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-fg-2">
            <span>批次名</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
              data-testid="create-batch-name"
            />
          </label>
          <label className="space-y-1 text-xs text-fg-2">
            <span>描述（可选）</span>
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="例如：第三轮本地素材审阅"
              className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
              data-testid="create-batch-description"
            />
          </label>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          <div className="flex min-w-[180px] flex-1 items-center gap-1.5 rounded-lg border border-border bg-bg px-2 py-1">
            <Search className="h-3.5 w-3.5 text-fg-3" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索项目素材"
              className="w-full bg-transparent text-xs text-fg placeholder:text-fg-3 focus:outline-none"
              data-testid="create-batch-search"
            />
          </div>
          <button
            type="button"
            onClick={toggleAllFiltered}
            disabled={filtered.length === 0}
            className="rounded-md border border-border bg-bg-2 px-2.5 py-1 text-xs text-fg-2 transition-colors hover:text-fg disabled:opacity-40"
          >
            {allFilteredSelected ? "取消全选" : "全选当前结果"}
          </button>
          <span className="font-mono text-[11px] text-fg-3">
            已选 {selected.length} / {assets.length}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {assets.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-bg-2 p-8 text-center">
              <ImageIcon className="h-5 w-5 text-fg-3" />
              <div className="text-sm text-fg">项目素材库没有图片/视频</div>
              <p className="max-w-md text-xs text-fg-3">
                请先在宿主素材面板导入 PNG/JPG 或 MP4。文字/数据仍由 Agent ingest
                或后续粘贴入口提供，不能从媒体创建。
              </p>
              <button
                type="button"
                onClick={onOpenMediaLibrary}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground"
                data-testid="create-batch-open-media"
              >
                打开宿主素材面板
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-xs text-fg-3">没有匹配的素材</div>
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
                    className={`flex min-w-0 flex-col overflow-hidden rounded-xl border text-left transition-colors ${
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
                      <div className="flex flex-wrap items-center gap-1 font-mono text-[10px] text-fg-3">
                        <span>{asset.type === "image" ? "图片" : "视频"}</span>
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
            {error}
          </div>
        )}

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3">
          <div className="text-[11px] text-fg-3">
            文字/数据不能由媒体创建；同一素材可再次建批，已审阅状态只作提示。
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-md border border-border bg-bg-2 px-3 py-1.5 text-xs text-fg-2 hover:text-fg"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={selected.length === 0 || busy}
              className="flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent-strong disabled:opacity-40"
              data-testid="create-batch-submit"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              创建批次并开始审阅（{selected.length}）
            </button>
          </div>
        </div>
      </div>
    </ToolcraftDialog>
  );
}
