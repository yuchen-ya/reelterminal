import type { ExternalConversationDisplayState } from "@openreel/agent-facade";

export type ConversationAdapterAvailability =
  | "missing"
  | "available"
  | "invalid";

export type ConversationCapabilityLevel =
  | "basic"
  | "streaming"
  | "observable";

export interface ConversationAdapterSummary {
  readonly availability: ConversationAdapterAvailability;
  readonly agentLabel: string | null;
  readonly adapterName: string | null;
  readonly sessionId: string | null;
  readonly capabilityLevel: ConversationCapabilityLevel | null;
  /** Safe, bounded diagnostic. Never contains an endpoint, token, or response body. */
  readonly message: string | null;
}

export interface DesktopConversationState {
  readonly adapter: ConversationAdapterSummary;
  readonly conversation: ExternalConversationDisplayState;
}

export type DesktopConversationEvent = {
  readonly type: "state";
  readonly state: DesktopConversationState;
};

export interface ConversationPromptArgs {
  readonly text: string;
}
