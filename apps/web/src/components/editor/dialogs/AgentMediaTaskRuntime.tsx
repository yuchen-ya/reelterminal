/**
 * Null-rendering installer for the agent media task runtime. Mounting it
 * once in the editor arms the receipt correlator, the desktop recommended
 * root source, and restart recovery for the whole session — independent of
 * whether the task dialog happens to be open, so a receipt that arrives
 * while the dialog is closed still advances its task.
 */
import React, { useEffect } from "react";
import { installAgentTaskRuntime } from "../../../services/agent-media-tasks/agent-task-runtime";

export const AgentMediaTaskRuntime: React.FC = () => {
  useEffect(() => installAgentTaskRuntime(), []);
  return null;
};

export default AgentMediaTaskRuntime;
