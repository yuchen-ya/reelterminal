/**
 * Compatibility names for desktop code. The canonical JSON-safe contract
 * lives in @openreel/agent-facade/desktop-protocol and is shared with the
 * renderer.
 */
export {
  LIVE_ACTIVITY_TIMEOUT_MS,
  LIVE_HEARTBEAT_INTERVAL_MS,
} from "@openreel/agent-facade/desktop-protocol";
export type {
  DesktopCollabStatus as LiveCollabStatus,
  DesktopCollabSetAccessArgs as LiveCollabSetAccessArgs,
  DesktopCollabSetWorkModeArgs as LiveCollabSetWorkModeArgs,
  DesktopLiveBridgeError as LiveBridgeError,
  DesktopLiveBridgeKind as LiveBridgeKind,
  DesktopLiveBridgeReply as LiveBridgeReply,
  DesktopLiveBridgeRequest as LiveBridgeRequest,
  DesktopLiveEvent as LiveEvent,
} from "@openreel/agent-facade/desktop-protocol";
export type {
  AgentAccessMode,
  AgentWorkMode,
  LiveMediaImportRequest,
  LiveMediaImportResult,
} from "@openreel/agent-facade";
