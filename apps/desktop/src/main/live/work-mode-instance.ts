import { app } from "electron";
import path from "node:path";
import {
  createAgentModePreferenceStore,
  type AgentModePreferenceStore,
} from "./work-mode-preference";

let store: AgentModePreferenceStore | null = null;

export function getAgentModePreferenceStore(): AgentModePreferenceStore {
  store ??= createAgentModePreferenceStore(
    path.join(app.getPath("userData"), "agent-work-mode.json"),
  );
  return store;
}
