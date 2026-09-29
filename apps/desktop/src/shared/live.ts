/**
 * Compatibility names for desktop code. The canonical JSON-safe contract
 * lives in @reelterminal/agent-facade/desktop-protocol and is shared with the
 * renderer.
 */
export {
  LIVE_ACTIVITY_TIMEOUT_MS,
  LIVE_HEARTBEAT_INTERVAL_MS,
} from "@reelterminal/agent-facade/desktop-protocol";
export type {
  DesktopCollabStatus as LiveCollabStatus,
  DesktopCollabSetAccessArgs as LiveCollabSetAccessArgs,
  DesktopLiveBridgeError as LiveBridgeError,
  DesktopLiveBridgeKind as LiveBridgeKind,
  DesktopLiveBridgeReply as LiveBridgeReply,
  DesktopLiveBridgeRequest as LiveBridgeRequest,
  DesktopLiveEvent as LiveEvent,
} from "@reelterminal/agent-facade/desktop-protocol";
export type {
  AgentAccessMode,
  LiveMediaImportRequest,
  LiveMediaImportResult,
} from "@reelterminal/agent-facade";
