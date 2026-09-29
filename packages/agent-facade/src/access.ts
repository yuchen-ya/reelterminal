/** Desktop command authorization; agents own their collaboration preferences. */
export type AgentAccessMode = "read-only" | "write";
export interface AgentAccessPreference { readonly access: AgentAccessMode; }
/** A fresh desktop process always starts with read-only Agent access. */
export const DEFAULT_AGENT_ACCESS_MODE: AgentAccessMode = "read-only";
export function isAgentAccessMode(value: unknown): value is AgentAccessMode {
  return value === "read-only" || value === "write";
}
/** Normalize legacy values without restoring a write grant from old settings. */
export function normalizeAgentAccessPreference(value: unknown): AgentAccessPreference {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (isAgentAccessMode(record.access)) return { access: record.access };
  }
  return { access: DEFAULT_AGENT_ACCESS_MODE };
}
