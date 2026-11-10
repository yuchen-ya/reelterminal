import { useTranslation } from "react-i18next";
import { wbButton } from "../wb-button";
import { FeedbackEditor } from "./FeedbackEditor";
import type { ComponentProps } from "react";
import type { TaskTextReviewUnit } from "../../../../../desktop/src/shared/task-review";
import { useSceneScroll, viewKey } from "./view-state";

export function EditScene({ onBackToReview, ...props }: ComponentProps<typeof FeedbackEditor> & {
  unit: TaskTextReviewUnit;
  onBackToReview: () => void;
}) {
  const { t } = useTranslation();
  const scroll = useSceneScroll<HTMLDivElement>(`${viewKey(props.root, props.taskId)}:edit:${props.unit.id}`);
  return (
    <div {...scroll} className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="task-review-edit-scene">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <strong>{t("Detailed edit · Item #{{no}}", { no: props.unit.ordinal })}</strong>
          <button type="button" className={wbButton.secondary} onClick={onBackToReview}>{t("Return to item review")}</button>
        </div>
        <div className="rounded border border-border bg-bg-2 p-3">
          {props.disabled && <p className="mb-2 text-status-error" role="status">{t("The source version is stale or unavailable. The old draft is preserved for reference; review the current version.")}</p>}
          <p className="mb-1 text-fg-3">{t("Source text (read-only; suggestions never replace it)")}</p>
          <p className="whitespace-pre-wrap break-words leading-relaxed" data-testid="task-review-edit-original">{props.unit.text}</p>
        </div>
        <FeedbackEditor {...props} />
      </div>
    </div>
  );
}
