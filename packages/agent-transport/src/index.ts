/**
 * @reelterminal/agent-transport — ADR 0003 slice 2b/2c.
 *
 * The `reelterminal-agent` CLI: `serve` (MCP stdio server, one process == one
 * AgentFacadeSession), `run` (B.6 executable JSONL workflow over a fresh
 * session), `doctor` (machine-readable environment report). The transport
 * adds no semantics and removes none: facade results pass through verbatim
 * (B.4 envelope), schemas are the facade's emission verbatim (Decision 4),
 * and the transport owns signal lifecycle via Decision 7.
 */
export { TOOLS, TOOL_NAMES, TOOL_TO_VERB, VERB_TO_TOOL, type McpTool, type ToolName } from "./tools";
export { PATH_FIELDS, findRelativePathViolations, relativePathMessage, type PathViolation } from "./paths";
export { createTransportSession, isTerminalJobState, type TransportSession } from "./session";
export {
  canonicalizeRoot,
  mergeEnvRoots,
  mergeEnvLogLevel,
  parseArgv,
  resolveConfig,
  ConfigRefusal,
  type RawRoots,
  type TransportConfig,
} from "./config";
export {
  parseWorkflowLines,
  staticValidate,
  executeWorkflow,
  resolvePointer,
  parseRefText,
  isRefObject,
  STEP_ID_PATTERN,
  MAX_AWAIT_TIMEOUT_MS,
  DEFAULT_POLL_MS,
  MIN_POLL_MS,
  MAX_POLL_MS,
  type WorkflowStep,
  type StaticError,
  type RunLine,
} from "./workflow";
export { serveCommand, TRANSPORT_VERSION } from "./serve";
export { runCommand } from "./workflow";
export { doctorCommand, type DoctorReport } from "./doctor";
export { verifyBrowserReaper, type ReaperFinding } from "./reaper";
export { redirectConsoleToStderr, log, setLogLevel, type LogLevel } from "./log";
