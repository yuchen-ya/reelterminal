import {
  createAgentAccessPreferenceStore,
  type AgentAccessPreferenceStore,
} from "./access-preference";

let store: AgentAccessPreferenceStore | null = null;

export function getAgentAccessPreferenceStore(): AgentAccessPreferenceStore {
  // Access is deliberately scoped to this process and starts read-only.
  store ??= createAgentAccessPreferenceStore();
  return store;
}
