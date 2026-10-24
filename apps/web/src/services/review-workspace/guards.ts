import type { WorkspaceTarget } from "@reelterminal/core/review/types";
import { stableStringify } from "../workspace-record-transforms";
import { reviewRuntimeInstanceId } from "./context";

export type ReviewTarget = Extract<WorkspaceTarget, { kind: "review" }>;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function reviewError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
export function sameReviewValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}
export function targetGuard(target: ReviewTarget, nodeRequired: boolean): void {
  if (!target || target.kind !== "review" || !UUID.test(target.reviewWorkspaceId) ||
      (nodeRequired && (!target.nodeId || !UUID.test(target.nodeId)))) throw reviewError("INVALID_PARAMS", "An explicit review workspace and node target are required");
  if (target.instanceId !== reviewRuntimeInstanceId()) throw reviewError("CONFLICT", "Review runtime changed; discover the review target again");
}
export async function requestDigest(request: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(request)));
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("");
}
