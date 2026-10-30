import path from "node:path";
import { encodeAgentTarget, type AgentTarget } from "../../shared/agent-target";

/** Commands contain paths, never the live endpoint's credentials. */
export function agentStartupInfo(input: {
  platform: NodeJS.Platform;
  packaged: boolean;
  appPath: string;
  executablePath: string;
  workspaceRoot: string;
  target?: AgentTarget;
}): { cliCommand: string; shell: string; workspaceRoot: string; startCommand?: string } {
  const paths = input.platform === "win32" ? path.win32 : path.posix;
  const quote = (value: string) => input.platform === "win32"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
  let cliCommand: string;
  if (input.packaged && input.platform === "win32") {
    cliCommand = `& ${quote(paths.join(paths.dirname(input.executablePath), "reelctl.cmd"))}`;
  } else {
    const entry = quote(paths.join(input.appPath, "dist", "reelctl", "index.js"));
    cliCommand = input.packaged
      ? `ELECTRON_RUN_AS_NODE=1 ${quote(input.executablePath)} ${entry}`
      : `node ${entry}`;
  }
  return {
    cliCommand,
    shell: input.platform === "win32" ? "PowerShell" : "POSIX shell (sh/bash/zsh)",
    workspaceRoot: input.workspaceRoot,
    ...(input.target ? { startCommand: `${cliCommand} start --target ${encodeAgentTarget(input.target)}` } : {}),
  };
}
