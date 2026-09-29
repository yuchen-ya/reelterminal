import { app } from "electron";
import path from "node:path";
import {
  createAgentAccessPreferenceStore,
  type AgentAccessPreferenceStore,
} from "./access-preference";

let store: AgentAccessPreferenceStore | null = null;

export function getAgentAccessPreferenceStore(): AgentAccessPreferenceStore {
  store ??= createAgentAccessPreferenceStore(
    path.join(app.getPath("userData"), "agent-work-mode.json"),
  );
  return store;
}
