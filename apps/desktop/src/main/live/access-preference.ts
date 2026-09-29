import {
  DEFAULT_AGENT_ACCESS_MODE,
  isAgentAccessMode,
  type AgentAccessPreference,
} from "@reelterminal/agent-facade";

export interface AgentAccessPreferenceStore {
  get(): AgentAccessPreference;
  set(preference: AgentAccessPreference): void;
  subscribe(listener: (preference: AgentAccessPreference) => void): () => void;
}

/**
 * Per-process source of truth for Agent access. Write authorization must be
 * granted again after every desktop restart, so access grants have no file
 * backing and cannot outlive this process.
 */
export function createAgentAccessPreferenceStore(): AgentAccessPreferenceStore {
  let current: AgentAccessPreference = { access: DEFAULT_AGENT_ACCESS_MODE };
  const listeners = new Set<(preference: AgentAccessPreference) => void>();

  return {
    get: () => ({ ...current }),
    set: (preference) => {
      const normalized: AgentAccessPreference = {
        access: isAgentAccessMode(preference?.access)
          ? preference.access
          : DEFAULT_AGENT_ACCESS_MODE,
      };
      if (normalized.access === current.access) return;
      current = normalized;
      for (const listener of listeners) listener({ ...current });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
