/** Compatibility helpers for the stored task auto-confirm field. */

export interface AgentTaskCapabilityBits {
  readonly formalReply?: "supported" | "unsupported" | "unknown";
}

export type AgentTaskAutoConfirmDecision =
  | { readonly mode: "receipt" }
  | { readonly mode: "manual-only"; readonly reason: string };

export const MANUAL_CONFIRM_NOTICE =
  "该任务创建时无法自动确认结果，请在查看产物后手动确认或标记失败。";

/** Preserve the historical capability decision when reading or creating records in tests. */
export function decideTaskAutoConfirmation(
  capabilities: AgentTaskCapabilityBits | null | undefined,
): AgentTaskAutoConfirmDecision {
  return capabilities?.formalReply === "unsupported"
    ? { mode: "manual-only", reason: MANUAL_CONFIRM_NOTICE }
    : { mode: "receipt" };
}

export function isManualConfirmOnly(
  decision: AgentTaskAutoConfirmDecision,
): boolean {
  return decision.mode === "manual-only";
}
