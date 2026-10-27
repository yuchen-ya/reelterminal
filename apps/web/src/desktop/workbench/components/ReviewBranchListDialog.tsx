import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import { reviewService } from "../../../services/review-workspace/service";
import { wbButton } from "../wb-button";

/** Explicitly opened metadata browser. Opening a branch comparison leaves the GUI node selected. */
export function ReviewBranchListDialog({ target, onCompare, onClose }: {
  target: ReviewContext["target"]; onCompare: (branchId: string) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [branches, setBranches] = useState<readonly ReviewNode[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const matches: ReviewNode[] = [];
      let cursor: string | undefined;
      do {
        const page = await reviewService.listNodes(target, { view: "all", cursor, limit: 500 });
        if (cancelled) return;
        matches.push(...page.nodes.filter(node => node.branch?.sourceNodeId === target.nodeId && !node.trashedAt));
        cursor = page.cursor;
      } while (cursor);
      setBranches(matches);
    };
    void load().catch(problem => { if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem)); });
    return () => { cancelled = true; };
  }, [target]);
  return <ToolcraftDialog isOpen onOpenChange={open => { if (!open) onClose(); }} width={560} purpose="review-branches">
    <ToolcraftDialogHeader title={t("review.branch.listTitle", "Task branches")} onOpenChange={open => { if (!open) onClose(); }} />
    <div className="max-h-[60vh] space-y-2 overflow-auto p-4" data-testid="review-branch-list">
      {error && <p role="alert" className="text-xs text-status-error">{error}</p>}
      {branches?.length === 0 && <p className="text-xs text-fg-3">{t("review.branch.empty", "No task branches yet. An Agent creates one when it starts a concrete edit.")}</p>}
      {branches?.map(branch => <button key={branch.id} type="button" className={`${wbButton.secondary} flex w-full justify-between`} onClick={() => onCompare(branch.id)} data-testid={`review-branch-compare-${branch.id}`}>
        <span>{branch.name}</span><span className="text-fg-3">r{branch.branch!.sourceNodeRevision} → r{branch.revision}</span>
      </button>)}
      {!branches && !error && <p className="text-xs text-fg-3">{t("review.loading")}</p>}
    </div>
  </ToolcraftDialog>;
}
