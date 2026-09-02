/**
 * Pure, ephemeral display state for the external conversation client.
 *
 * This is intentionally a projection of protocol events, not a conversation
 * store. It has no persistence API, no serialization hook, and no prompt
 * text field. The owning agent remains the source of truth for history; a UI
 * may render this bounded buffer while the attachment is open and discard it
 * on disconnect.
 */
import type {
  ExternalAgentInfo,
  ExternalConversationDisplayState,
  ExternalConversationCapabilitySupport,
  ExternalConversationEvent,
  ExternalConversationOwnership,
} from "./conversation-protocol";
import {
  normalizeExternalConversationCapabilities,
  projectExternalAgentSessionUpdate,
} from "./conversation-protocol";

export const DEFAULT_CONVERSATION_DISPLAY_LIMIT = 200;

export function createConversationDisplayState(): ExternalConversationDisplayState {
  return {
    lifecycle: "idle",
    connectionId: null,
    sessionId: null,
    agent: null,
    capabilities: normalizeExternalConversationCapabilities(undefined),
    ownership: null,
    fallback: null,
    lastError: null,
    updates: [],
    lastEventSequence: 0,
  };
}

export interface ConversationStatePatch {
  readonly agent?: ExternalAgentInfo | null;
  readonly capabilities?: ExternalConversationCapabilitySupport;
  readonly ownership?: ExternalConversationOwnership | null;
  readonly fallback?: ExternalConversationDisplayState["fallback"];
}

/**
 * Apply one bridge event. Callers pass a bounded `limit`; the reducer never
 * mutates its input and always keeps the newest display events.
 */
export function reduceConversationDisplayState(
  previous: ExternalConversationDisplayState,
  event: ExternalConversationEvent,
  limit = DEFAULT_CONVERSATION_DISPLAY_LIMIT,
  patch: ConversationStatePatch = {},
): ExternalConversationDisplayState {
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : DEFAULT_CONVERSATION_DISPLAY_LIMIT;
  const base = {
    ...previous,
    lastEventSequence: Math.max(previous.lastEventSequence, event.sequence),
  };

  if (event.type === "session_update") {
    // Keep the reducer safe for direct callers too; the bridge normally
    // projects before constructing this event.
    const update = projectExternalAgentSessionUpdate(event.update);
    if (!update) {
      return {
        ...base,
        updates: previous.updates,
      };
    }
    const safeEvent: ExternalConversationEvent = { ...event, update };
    const updates = [...previous.updates, safeEvent];
    return {
      ...base,
      updates: updates.slice(-safeLimit),
      lastError: null,
    };
  }

  if (event.type === "prompt") {
    // The prompt text is intentionally absent from this event/state. The
    // external agent will echo it through a user_message update if its ACP
    // implementation supports replay/display updates.
    return {
      ...base,
      updates: previous.updates,
    };
  }

  return {
    ...base,
    lifecycle: event.state,
    connectionId: event.connectionId,
    sessionId: event.sessionId,
    capabilities:
      patch.capabilities ??
      (event.capabilities === undefined ? previous.capabilities : event.capabilities),
    ownership: patch.ownership === undefined ? previous.ownership : patch.ownership,
    agent: patch.agent === undefined ? previous.agent : patch.agent,
    fallback: patch.fallback === undefined ? previous.fallback : patch.fallback,
    lastError: event.error ?? null,
    updates: previous.updates,
  };
}
