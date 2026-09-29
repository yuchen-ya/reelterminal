/** Desktop command authorization; agents own their collaboration preferences. */
export type AgentAccessMode = "read-only" | "write";
export interface AgentAccessPreference { readonly access: AgentAccessMode; }
export const DEFAULT_AGENT_ACCESS_MODE: AgentAccessMode = "write";
export function isAgentAccessMode(value: unknown): value is AgentAccessMode {
  return value === "read-only" || value === "write";
}
/** Migrate old combined modes without widening an explicit read-only grant. */
export function normalizeAgentAccessPreference(value: unknown): AgentAccessPreference {
  if (value === "observe") return { access: "read-only" };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (isAgentAccessMode(record.access)) return { access: record.access };
    if (record.mode === "observe") return { access: "read-only" };
  }
  return { access: DEFAULT_AGENT_ACCESS_MODE };
}
