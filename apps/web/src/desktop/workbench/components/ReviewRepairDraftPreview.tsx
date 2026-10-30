import { useSyncExternalStore } from "react";
import type { ReviewContext } from "@reelterminal/core/review/types";
import { getRepairDraftPreviews, subscribeRepairDraftPreviews } from "../../../services/review-workspace/repair-drafts";

/** Preview candidates are distinct from the saved image and never enter its version selector. */
export function ReviewRepairDraftPreview({ target }: { target: ReviewContext["target"] }) {
  const previews = useSyncExternalStore(subscribeRepairDraftPreviews, getRepairDraftPreviews);
  const matching = previews.filter(preview => preview.target.reviewWorkspaceId === target.reviewWorkspaceId
    && preview.target.instanceId === target.instanceId && preview.target.nodeId === target.nodeId);
  if (!matching.length) return null;
  return <div className="flex h-40 shrink-0 gap-3 overflow-x-auto border-b border-border bg-bg-2 p-3" data-testid="review-repair-draft-previews">
    {matching.map(preview => <figure key={preview.draftId} className="flex min-w-64 max-w-lg items-start gap-3" data-testid="review-repair-draft-preview" data-draft-id={preview.draftId}>
      <img src={`app://reelterminal/review-media/${preview.image.resourceId}`} alt="未保存的修复草稿局部预览" className="max-h-36 max-w-64 object-contain" />
      <figcaption className="text-xs text-fg-2">
        <strong className="block text-accent">草稿预览 · 未保存</strong>
        <span className="block">基于 v{preview.itemVersion} · 预览 r{preview.inspectedRevision}</span>
        {preview.draftRevision !== preview.inspectedRevision && <span className="block text-accent">草稿 r{preview.draftRevision} 有新操作，等待 inspect 更新</span>}
        <span className="block">区域 {preview.region.x},{preview.region.y} · {preview.region.width}×{preview.region.height}</span>
        <code className="mt-1 block break-all text-[10px] text-fg-3">{preview.itemId}</code>
        <span className="mt-1 block text-fg-3">inspect 导出的实际 PNG。commit 后生成一个正式版本。</span>
      </figcaption>
    </figure>)}
  </div>;
}
