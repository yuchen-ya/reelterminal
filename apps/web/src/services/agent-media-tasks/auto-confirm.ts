/** Compatibility helpers for the stored task auto-confirm field. */

export interface AgentTaskCapabilityBits {
  readonly formalReply?: "supported" | "unsupported" | "unknown";
}

export type AgentTaskAutoConfirmDecision =
  | { readonly mode: "receipt" }
  | { readonly mode: "manual-only"; readonly reason: string };

export const MANUAL_CONFIRM_NOTICE =
  "Automatic confirmation was unavailable when this task was created. Inspect its output, then confirm it manually or mark it failed.";

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
