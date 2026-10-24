import type { ReviewBackupPlan } from "@reelterminal/core/review/export";
import type { ReviewNode } from "@reelterminal/core/review/types";
import { prepareReviewExport, reviewExportStatus, cancelReviewExport, exportValue } from "./export";
import { reviewService } from "./service";
import { reviewError, type ReviewTarget } from "./guards";

async function allNodes(target: ReviewTarget): Promise<ReviewNode[]> {
  const nodes: ReviewNode[] = [];
  let cursor: string | undefined;
  do {
    const page = await reviewService.listNodes(target, { view: "all", limit: 500, cursor });
    nodes.push(...page.nodes); cursor = page.cursor;
  } while (cursor);
  return nodes.sort((left, right) => left.id.localeCompare(right.id));
}
const metadata = (nodes: readonly ReviewNode[]) => nodes.map(({ history: _history, ...node }) => node);

export async function prepareReviewBackup(target: ReviewTarget, signal: AbortSignal, progress: (done: number, total: number) => void): Promise<ReviewBackupPlan> {
  const directory = await reviewService.directory.get(target);
  const nodes = metadata(await allNodes(target));
  if (!nodes.length) throw reviewError("NOT_FOUND", "There are no review nodes to back up");
  const packages: ReviewBackupPlan["nodes"][number][] = [];
  progress(0, nodes.length);
  for (const node of nodes) {
    signal.throwIfAborted();
    const nodeTarget = { ...target, nodeId: node.id };
    const exportId = crypto.randomUUID();
    let status = await prepareReviewExport({ target: nodeTarget, expectedNodeRevision: node.revision, exportId, mode: "node-package", scope: "node" });
    while (status.state === "queued" || status.state === "preparing") {
      if (signal.aborted) { await cancelReviewExport(exportId, node.id); signal.throwIfAborted(); }
      await new Promise(resolve => setTimeout(resolve, 200));
      status = await reviewExportStatus(exportId, node.id);
    }
    if (status.state !== "ready") throw reviewError("ACTION_FAILED", status.error?.message ?? "A node package could not be prepared");
    packages.push({ exportId, node }); progress(packages.length, nodes.length);
  }
  signal.throwIfAborted();
  if ((await reviewService.directory.get(target)).revision !== directory.revision || JSON.stringify(metadata(await allNodes(target))) !== JSON.stringify(nodes)) throw reviewError("CONFLICT", "Review content or directory changed during backup preparation; prepare again");
  return { workspaceId: target.reviewWorkspaceId, revision: directory.revision, groups: directory.groups, nodes: packages };
}

export async function copyReviewBackup(plan: ReviewBackupPlan, directory: string) {
  return exportValue(await window.reelterminal!.reviewExport!.backup({ plan, directory, source: "user" }));
}
