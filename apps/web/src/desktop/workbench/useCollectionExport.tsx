import { LocalizedMessage } from "../../i18n/LocalizedMessage";
import { t as translate } from "../../i18n";
import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { ReviewContext } from "@reelterminal/core/review/types";
import type { ReviewExportStatus } from "@reelterminal/core/review/export";
import { cancelReviewExport, copyReviewExport, prepareReviewExport, reviewExportStatus } from "../../services/review-workspace/export";
import type { CollectionScope } from "./components/CollectionActions";
import { wbButton } from "./wb-button";

export interface CollectionExportTarget { target: ReviewContext["target"]; revision: number }
interface DragJob { key: string; exportId: string; name: string; folder: boolean; status?: ReviewExportStatus; error?: string }

export function useCollectionExport(source?: CollectionExportTarget) {
  const [job, setJob] = useState<DragJob | null>(null);
  const current = useRef<DragJob | null>(null);
  const [visible, setVisible] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const publish = (next: DragJob) => { current.current = next; setJob(next); };
  const keyFor = (scope: CollectionScope) => JSON.stringify([source?.target, source?.revision, scope.folder, scope.title, scope.items.map(item => [item.id, item.version])]);
  useEffect(() => { current.current = null; setJob(null); setVisible(false); setNotice(null); }, [source?.target.reviewWorkspaceId, source?.target.nodeId, source?.target.instanceId, source?.revision]);
  useEffect(() => {
    if (!job?.status || job.error || !["queued", "preparing"].includes(job.status.state)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void reviewExportStatus(job.status!.exportId, job.status!.nodeId).then(status => {
        if (!cancelled && current.current?.exportId === job.exportId) publish({ ...job, status });
      }).catch(error => {
        if (!cancelled && current.current?.exportId === job.exportId) publish({ ...job, error: String(error) });
      });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [job]);
  const prepare = (scope: CollectionScope) => {
    if (!source || !scope.items.length) return;
    const key = keyFor(scope);
    if (current.current?.key === key && !current.current.error && current.current.status?.state !== "failed" && current.current.status?.state !== "cancelled") return;
    const next: DragJob = { key, exportId: crypto.randomUUID(), name: scope.title, folder: scope.folder };
    publish(next); setNotice(null);
    void prepareReviewExport({ target: source.target, expectedNodeRevision: source.revision,
      exportId: next.exportId, mode: "current", scope: "selected", name: scope.title.slice(0, 200), itemIds: scope.items.map(item => item.id),
    }).then(async status => {
      if (current.current?.exportId === next.exportId) publish({ ...next, status });
      else if (status.state === "queued" || status.state === "preparing") await cancelReviewExport(status.exportId, status.nodeId);
    }).catch(error => {
      if (current.current?.exportId === next.exportId) {
        publish({ ...next, error: String(error) });
        setVisible(true);
      }
    });
  };
  const start = (event: DragEvent, ready: DragJob) => {
    event.preventDefault();
    if (ready.status?.state !== "ready") return;
    void window.reelterminal!.reviewExport!.startDrag(ready.status.exportId, ready.folder)
      .then(() => setNotice(translate("Handed to the system for dragging. Release at the destination; receipt depends on the destination application.")))
      .catch(error => {
        if (current.current?.exportId === ready.exportId) publish({ ...ready, error: String(error) });
      });
  };
  const drag = (event: DragEvent, scope: CollectionScope) => {
    event.preventDefault(); setVisible(true);
    if (current.current?.key === keyFor(scope) && current.current.status?.state === "ready") start(event, current.current);
    else prepare(scope);
  };
  const status = job?.status;
  const statusText = status?.state === "ready" ? translate("Ready to drag out") : status?.state === "failed" ? translate("review.export.state.failed") : status?.state === "cancelled" ? translate("review.export.state.cancelled") : translate("Preparing; drag out again when ready");
  const feedback = visible && job ? <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-bg-1 px-3 py-2 text-xs" role="status" data-testid="collection-drag-status">
    <span>{translate("{{v0}} · Current saved version · {{v1}}{{v2}}", { v0: job.name, v1: statusText, v2: status ? `（${status.completedFiles}/${status.totalFiles}）` : "" })}</span>
    {(job.error || status?.error) && <span role="alert" className="text-status-error">{job.error ?? status?.error?.message}</span>}
    {status?.state === "ready" && <>
      <button className={`${wbButton.secondary} cursor-grab`} draggable onDragStart={event => start(event, job)}>{job.folder ? translate("review.export.dragFolder") : translate("review.export.dragFiles")}</button>
      <button className={wbButton.secondary} onClick={() => {
        void window.reelterminal!.fs.showOpenDialog({ directory: true, filters: [] }).then(async directory => {
          if (directory) { const result = await copyReviewExport(status.exportId, status.nodeId, directory, "user"); setNotice(translate("Saved to {{v0}}", { v0: result.directory })); }
        }).catch(error => publish({ ...job, error: String(error) }));
      }}>{translate("Save to…")}</button>
    </>}
    {notice && <span><LocalizedMessage>{notice}</LocalizedMessage></span>}
    <button className={wbButton.ghost} onClick={() => setVisible(false)}>{translate("common.close")}</button>
  </div> : null;
  return { prepare, drag, feedback };
}
