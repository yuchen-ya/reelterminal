import { useTranslation } from "react-i18next";
import { useSyncExternalStore } from "react";
import type { ReviewContext } from "@reelterminal/core/review/types";
import { getRepairDraftPreviews, subscribeRepairDraftPreviews } from "../../../services/review-workspace/repair-drafts";

/** Preview candidates are distinct from the saved image and never enter its version selector. */
export function ReviewRepairDraftPreview({ target }: { target: ReviewContext["target"] }) {
  const { t } = useTranslation();
  const previews = useSyncExternalStore(subscribeRepairDraftPreviews, getRepairDraftPreviews);
  const matching = previews.filter(preview => preview.target.reviewWorkspaceId === target.reviewWorkspaceId
    && preview.target.instanceId === target.instanceId && preview.target.nodeId === target.nodeId);
  if (!matching.length) return null;
  return <div className="flex h-40 shrink-0 gap-3 overflow-x-auto border-b border-border bg-bg-2 p-3" data-testid="review-repair-draft-previews">
    {matching.map(preview => <figure key={preview.draftId} className="flex min-w-64 max-w-lg items-start gap-3" data-testid="review-repair-draft-preview" data-draft-id={preview.draftId}>
      <img src={`app://reelterminal/review-media/${preview.image.resourceId}`} alt={t("Local preview of the unsaved repair draft")} className="max-h-36 max-w-64 object-contain" />
      <figcaption className="text-xs text-fg-2">
        <strong className="block text-accent">{t("Draft preview · Unsaved")}</strong>
        <span className="block">{t("Based on v{{v0}} · Preview r{{v1}}", { v0: preview.itemVersion, v1: preview.inspectedRevision })}</span>
        {preview.draftRevision !== preview.inspectedRevision && <span className="block text-accent">{t("Draft r{{v0}} has new operations; waiting for inspect to update", { v0: preview.draftRevision })}</span>}
        <span className="block">{t("Region {{v0}},{{v1}} · {{v2}}×{{v3}}", { v0: preview.region.x, v1: preview.region.y, v2: preview.region.width, v3: preview.region.height })}</span>
        <code className="mt-1 block break-all text-[10px] text-fg-3">{preview.itemId}</code>
        <span className="mt-1 block text-fg-3">{t("The actual PNG exported by inspect. Commit creates a saved version.")}</span>
      </figcaption>
    </figure>)}
  </div>;
}
