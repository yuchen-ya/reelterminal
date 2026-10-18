/**
 * @reelterminal/agent-transport.
 *
 * The `reelterminal-agent` CLI: `run` (JSONL workflow over a fresh
 * AgentFacadeSession), `doctor` (machine-readable environment report). The transport
 * adds no semantics and removes none: facade results pass through verbatim
 * (B.4 envelope), schemas are emitted by the facade, and the transport owns
 * signal lifecycle.
 */
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
export { TRANSPORT_VERSION } from "./version";
export { runCommand } from "./workflow";
export { doctorCommand, type DoctorReport } from "./doctor";
export { verifyBrowserReaper, type ReaperFinding } from "./reaper";
export { redirectConsoleToStderr, log, setLogLevel, type LogLevel } from "./log";
