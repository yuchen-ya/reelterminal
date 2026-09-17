/**
 * Capability gating for automatic task-result confirmation.
 *
 * The completion signal for a task is the receipt line the external Agent
 * writes into its reply (an `agent_message` update). The conversation bridge
 * projects the `agent_message` class only when the agent declared the
 * `formal_reply` capability during initialization — an explicitly
 * unsupported bit removes the normal receipt channel (any stray receipt on
 * another channel is ignored by the correlator), and without a decision a
 * task would silently sit in `submitted` forever.
 *
 * This module turns the session's normalized capability bits into an
 * explicit decision so callers can persist the outcome on the task record
 * and surface it to the user instead of waiting quietly:
 *
 *  - "supported"  → receipts flow, auto-confirm is possible.
 *  - "unknown"    → the agent omitted the bit; the bridge keeps unknown
 *                   tiers display-compatible (they pass through), so the
 *                   receipt path remains viable and we do not degrade UX on
 *                   older agents.
 *  - "unsupported"→ manual-only: the task can still be submitted, but its
 *                   status parks after submission until the user confirms
 *                   or marks the result by hand.
 */

/** Structural subset of the session's normalized capability bits. */
export interface AgentTaskCapabilityBits {
  readonly formalReply?: "supported" | "unsupported" | "unknown";
}

export type AgentTaskAutoConfirmDecision =
  | { readonly mode: "receipt" }
  | { readonly mode: "manual-only"; readonly reason: string };

export const MANUAL_CONFIRM_NOTICE =
  "此会话未声明正式回复能力（formal_reply），任务结果无法自动确认；任务提交后将停留在已提交状态，请在外部会话完成后手动确认或标记失败。";

export function decideTaskAutoConfirmation(
  capabilities: AgentTaskCapabilityBits | null | undefined,
): AgentTaskAutoConfirmDecision {
  if (capabilities?.formalReply === "unsupported") {
    return { mode: "manual-only", reason: MANUAL_CONFIRM_NOTICE };
  }
  return { mode: "receipt" };
}

export function isManualConfirmOnly(
  decision: AgentTaskAutoConfirmDecision,
): boolean {
  return decision.mode === "manual-only";
}
