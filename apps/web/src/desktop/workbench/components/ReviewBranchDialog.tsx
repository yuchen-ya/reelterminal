import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import type { ReviewContext } from "@reelterminal/core/review/types";
import type { ReviewBranchComparison, ReviewBranchSelection } from "../../../services/review-workspace/branches";
import { ReviewComparison, type ComparisonSelection } from "./ReviewComparison";
import { wbButton } from "../wb-button";

export interface ReviewBranchDialogProps {
  target: ReviewContext["target"];
  load: () => Promise<ReviewBranchComparison>;
  adopt: (input: { expectedNodeRevision: number; requestId: string; selections: readonly ReviewBranchSelection[] }) => Promise<unknown>;
  onClose: () => void;
}

export function ReviewBranchDialog({ target, load, adopt, onClose }: ReviewBranchDialogProps) {
  const { t } = useTranslation();
  const [comparison, setComparison] = useState<ReviewBranchComparison>();
  const [selected, setSelected] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setComparison(undefined);
    setError(undefined);
    setSelected([]);
    void load().then(value => {
      if (cancelled) return;
      setComparison(value);
      setActiveId(value.items.find(item => item.state === "changed" || item.state === "added")?.resultItemId ?? value.items[0]?.resultItemId);
    }).catch(problem => { if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem)); });
    return () => { cancelled = true; };
  }, [load, generation]);
  const active = comparison?.items.find(item => item.resultItemId === activeId);
  const pair = useMemo<{ left?: ComparisonSelection; right?: ComparisonSelection }>(() => {
    if (!active || !comparison) return {};
    const left: ComparisonSelection | undefined = active.sourceItemId && active.sourceVersion ? {
      target: { ...target, nodeId: comparison.source.id }, reference: { nodeId: comparison.source.id, itemId: active.sourceItemId, version: active.sourceVersion, role: "source" }, side: "input", index: 0,
    } : undefined;
    const right: ComparisonSelection = { target, idMap: comparison.idMap, taskId: comparison.branch.branch!.taskId,
      reference: { nodeId: comparison.branch.id, itemId: active.resultItemId, version: active.resultVersion, role: "result" }, side: "output", index: 0 };
    return { left, right };
  }, [active, comparison, target]);
  const submit = async () => {
    if (!comparison || !selected.length) return;
    setBusy(true);
    setError(undefined);
    try {
      await adopt({ expectedNodeRevision: comparison.branch.revision, requestId: crypto.randomUUID(),
        selections: comparison.items.filter(item => selected.includes(item.resultItemId)).map(({ resultItemId, resultVersion }) => ({ resultItemId, resultVersion })) });
      setGeneration(value => value + 1);
    } catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { setBusy(false); }
  };
  return <ToolcraftDialog isOpen onOpenChange={open => { if (!open && !busy) onClose(); }} width={1050} purpose="review-branch">
    <ToolcraftDialogHeader title={t("review.branch.compareTitle", "Compare and adopt branch results")} onOpenChange={open => { if (!open && !busy) onClose(); }} />
    <div className="space-y-3 p-4" data-testid="review-branch-dialog" data-workbench-modal="true">
      {error && <p role="alert" className="text-xs text-status-error">{error}</p>}
      {comparison ? <>
        <p className="text-xs text-fg-2">{comparison.source.name} → {comparison.branch.name} · {t("review.branch.baseRevision", "Starting revision")} {comparison.branch.branch!.sourceNodeRevision}</p>
        <p className="text-xs text-fg-3">{t("review.branch.adoptHint", "Select content results to adopt. Source decisions and feedback are preserved; source changes are checked again when adopting.")}</p>
        <div className="grid min-h-0 grid-cols-[240px_minmax(0,1fr)] gap-3">
          <div className="max-h-[55vh] overflow-auto rounded border border-border p-2">
            {comparison.items.map(item => <div key={item.resultItemId} className="mb-1 flex items-start gap-2 text-xs">
              <input type="checkbox" aria-label={`${t("review.branch.select", "Select")} ${item.title}`} disabled={busy || (item.state !== "changed" && item.state !== "added")}
                checked={selected.includes(item.resultItemId)} onChange={event => setSelected(values => event.target.checked ? [...values, item.resultItemId] : values.filter(id => id !== item.resultItemId))} />
              <button type="button" className={`min-w-0 flex-1 rounded p-1 text-left ${activeId === item.resultItemId ? "bg-bg-3" : "hover:bg-bg-2"}`}
                data-testid={`review-branch-result-${item.resultItemId}`} onClick={() => setActiveId(item.resultItemId)}>
                <span className="block truncate text-fg">{item.title} · v{item.resultVersion}</span>
                <span className={item.state === "conflict" ? "text-status-error" : "text-fg-3"}>{t(`review.branch.state.${item.state}`, item.state)}</span>
                {item.conflict && <span className="block text-status-error">{item.conflict}</span>}
              </button>
            </div>)}
          </div>
          <div className="max-h-[55vh] overflow-auto"><ReviewComparison target={target} {...pair} /></div>
        </div>
      </> : !error && <p className="text-xs text-fg-3">{t("review.branch.loading", "Loading branch comparison…")}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={wbButton.secondary} disabled={busy} onClick={() => setGeneration(value => value + 1)}>{t("review.branch.refresh", "Refresh comparison")}</button>
        <button type="button" className={wbButton.primary} disabled={busy || !selected.length} data-testid="review-branch-adopt" onClick={() => void submit()}>{t("review.branch.adoptSelected", "Adopt selected results")}</button>
      </div>
    </div>
  </ToolcraftDialog>;
}
