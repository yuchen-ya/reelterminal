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
  /** Main-owned snapshot order; renderer ignores older replies/pushes. */
  readonly sequence: number;
  readonly adapter: ConversationAdapterSummary;
  readonly conversation: ExternalConversationDisplayState;
}

export type DesktopConversationEvent = {
  readonly type: "state";
  readonly state: DesktopConversationState;
};

export interface ConversationPromptArgs {
  readonly text: string;
  readonly visualState?: ConversationVisualStateCapture;
}

export type ConversationVisualStateChangedField =
  | "project"
  | "preview"
  | "timeline"
  | "playhead"
  | "selection"
  | "references";

/** Renderer capture before the main process validates and persists its PNG. */
export interface ConversationVisualStateCapture {
  readonly version: 1;
  readonly stateRef: string;
  readonly baseRef?: string;
  readonly kind: "keyframe" | "delta" | "metadata";
  readonly projectRevision: number;
  readonly contextRevision: number;
  readonly playheadSeconds: number;
  readonly selectedClipIds: readonly string[];
  readonly selectedTextIds: readonly string[];
  readonly selectedMediaIds: readonly string[];
  readonly changed: readonly ConversationVisualStateChangedField[];
  /** Raw PNG bytes encoded for contextBridge/IPC; never forwarded to adapters. */
  readonly imagePngBase64?: string;
  readonly imageWidth?: number;
  readonly imageHeight?: number;
  readonly regions?: readonly {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly imageX: number;
    readonly imageY: number;
  }[];
}
