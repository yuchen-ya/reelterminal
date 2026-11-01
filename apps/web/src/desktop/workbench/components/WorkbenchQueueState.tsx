import { useTranslation } from "react-i18next";
import type { JSX } from "react";

export interface WorkbenchQueueStateProps {
  kind: "filter-empty" | "queue-done";
  processedCount: number;
  onResetFilters: () => void;
  onOpenHandoff: () => void;
  onSwitchToAll: () => void;
}

export function WorkbenchQueueState({
  kind,
  processedCount,
  onResetFilters,
  onOpenHandoff,
  onSwitchToAll,
}: WorkbenchQueueStateProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-stage-bg p-8 text-center">
      {kind === "filter-empty" ? (
        <>
          <p className="text-sm font-semibold text-fg" data-testid="workbench-filter-empty">{t("No items match the current filters")}</p>
          <p className="max-w-md text-xs leading-relaxed text-fg-2">{t("This batch has other content types. Clear the search or change the type filter to continue reviewing.")}</p>
          <button
            type="button"
            onClick={onResetFilters}
            className="rounded-lg border border-border bg-bg-2 px-3.5 py-1.5 text-xs text-fg-2 transition-colors hover:text-fg"
          >{t("assetBrowser.resetFilters")}</button>
        </>
      ) : (
        <>
          <p className="text-sm font-semibold text-fg" data-testid="workbench-queue-done">{t("The current queue is complete")}</p>
          <p className="max-w-md text-xs leading-relaxed text-fg-2">{t("{{v0}} items processed. Publish the review results, or choose All on the left to view and reopen processed items.", { v0: processedCount })}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenHandoff}
              className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent-strong"
            >{t("Review and publish results ({{v0}})", { v0: processedCount })}</button>
            <button
              type="button"
              onClick={onSwitchToAll}
              className="rounded-lg border border-border bg-bg-2 px-3 py-2 text-xs text-fg-2 transition-colors hover:text-fg"
            >{t("View processed items")}</button>
          </div>
        </>
      )}
    </div>
  );
}
