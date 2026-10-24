import type { ReviewExportStatus } from "@reelterminal/core/review/export";
import { reviewError, reviewService } from "./service";

function native() {
  const bridge = window.reelterminal?.reviewExport;
  if (!bridge) throw reviewError("UNSUPPORTED", "Native review export is unavailable");
  return bridge;
}
export function exportValue<T>(reply: { ok: true; value: T } | { ok: false; error: { code: string; reason: string; message: string } }): T {
  if (!reply.ok) throw Object.assign(reviewError(reply.error.code, reply.error.message), { details: { reason: reply.error.reason } });
  return reply.value;
}
export type ReviewExportRequest = Omit<Parameters<typeof reviewService.freezeExport>[0], "mode"> & { mode: "original" | "adopted" | "node-package" | "version" };
export async function prepareReviewExport(input: ReviewExportRequest): Promise<ReviewExportStatus> {
  if (input.mode === "node-package") {
    if (input.scope !== "node") throw reviewError("INVALID_PARAMS", "A node package always includes the entire node and retained history");
    const archive = await reviewService.archiveNode(input.target, input.expectedNodeRevision);
    return exportValue(await native().prepare({ exportId: input.exportId, nodeId: archive.node.id, nodeRevision: archive.node.revision,
      name: archive.node.name, mode: "node-package", scope: "node", archive: JSON.stringify(archive),
      entries: archive.resources.filter(resource => !resource.unavailableReason).map(resource => ({ resourceId: resource.id, fileName: resource.originalFileName })),
    }));
  }
  const plan = await reviewService.freezeExport({ ...input, mode: input.mode });
  return exportValue(await native().prepare(plan));
}
export async function reviewExportStatus(exportId: string, nodeId: string): Promise<ReviewExportStatus> {
  return exportValue(await native().status({ exportId, nodeId }));
}
export async function cancelReviewExport(exportId: string, nodeId: string): Promise<ReviewExportStatus> {
  return exportValue(await native().cancel({ exportId, nodeId }));
}
export async function copyReviewExport(exportId: string, nodeId: string, directory: string, source: "user" | "agent") {
  return exportValue(await native().copy({ exportId, nodeId, directory, source }));
}
