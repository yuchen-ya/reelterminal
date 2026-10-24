import type { ReviewContext } from "@reelterminal/core/review/types";
import { exportValue } from "./export";
import { reviewError, reviewService } from "./service";

function native() {
  const bridge = window.reelterminal?.reviewPackage;
  if (!bridge) throw reviewError("UNSUPPORTED", "Native node package service is unavailable");
  return bridge;
}
export async function inspectReviewPackage(target: ReviewContext["target"], directory: string, source: "user" | "agent") {
  await reviewService.directory.get(target);
  return exportValue(await native().inspect({ directory, source }));
}
export async function restoreReviewPackage(input: { target: ReviewContext["target"]; expectedWorkspaceRevision: number; requestId: string; packageId: string; digest: string }, source: "user" | "agent") {
  const prior = await reviewService.restorationReceipt(input);
  if (prior) { await native().release(input.packageId); return prior; }
  const directory = await reviewService.directory.get(input.target);
  if (directory.revision !== input.expectedWorkspaceRevision) throw reviewError("CONFLICT", "Review directory changed after the restore preview");
  const prepared = exportValue(await native().prepare({ packageId: input.packageId, restoreId: input.requestId, digest: input.digest, source }));
  const result = await reviewService.restoreNode({ target: input.target, expectedWorkspaceRevision: input.expectedWorkspaceRevision,
    requestId: input.requestId, actor: source === "user" ? "human" : "agent", archive: prepared.archive, resources: prepared.resources, packageDigest: input.digest });
  await native().release(input.packageId);
  return result;
}
