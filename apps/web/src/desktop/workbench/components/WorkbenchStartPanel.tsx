import { useTranslation } from "react-i18next";
import type { JSX } from "react";
import { Check, ClipboardCopy, Plus } from "lucide-react";

export interface WorkbenchStartPanelProps {
  onCopy: () => void;
  copyState: "idle" | "copied" | "failed";
  onOpenDocs: () => void;
  onCreateBatch: () => void;
}

export function WorkbenchStartPanel({
  onCopy,
  copyState,
  onOpenDocs,
  onCreateBatch,
}: WorkbenchStartPanelProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      className="flex h-full items-center justify-center overflow-y-auto bg-stage-bg p-6"
      data-testid="workbench-start-panel"
    >
      <div className="w-full max-w-xl space-y-4 rounded-2xl border border-border bg-bg-1 p-5">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-fg">{t("Import a batch of media or ask an Agent to submit content for review")}</h2>
          <p className="text-xs leading-relaxed text-fg-2">{t("This workbench shows review batches received by the project. Pending items appear in the left queue, the viewer and issues occupy the center, and item details and decisions appear below.")}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onCreateBatch}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent-strong"
            data-testid="workbench-create-batch"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("Create a batch from project media")}</button>
          <button
            type="button"
            onClick={onCopy}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-2 px-3.5 py-1.5 text-xs font-medium text-fg-2 transition-colors hover:text-fg"
            data-testid="workbench-copy-ingest"
          >
            {copyState === "copied" ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <ClipboardCopy className="h-3.5 w-3.5" />
            )}
            {copyState === "copied" ? t("Connection instructions copied") : t("Copy connection instructions")}
          </button>
          <button
            type="button"
            onClick={onOpenDocs}
            className="rounded-lg border border-border bg-bg-2 px-3 py-1.5 text-xs text-fg-2 transition-colors hover:text-fg"
            data-testid="workbench-ingest-help"
          >{t("View connection commands")}</button>
          {copyState === "failed" && (
            <span className="text-[11px] text-status-warning">{t("Copy failed. Check that the project workspace is ready and try again.")}</span>
          )}
        </div>

        <details className="rounded-xl border border-border bg-bg px-3 py-2" data-testid="workbench-ingest-help-panel">
          <summary className="cursor-pointer text-[11px] font-medium text-fg-2">{t("Agent connection instructions (requires project Agent access; does not enable editing or send messages)")}</summary>
          <p className="mt-2 text-xs leading-relaxed text-fg-2">{t("Copy the connection instructions and run their start command, then use the returned capability cards to choose tools, describe and call. Existing project batches use video.legacy-workbench.")}</p>
        </details>

        <p className="text-[11px] leading-relaxed text-fg-3">{t("Demo media is not written to production projects. Visual acceptance uses isolated test projects and real import/ingest paths.")}</p>
      </div>
    </div>
  );
}
