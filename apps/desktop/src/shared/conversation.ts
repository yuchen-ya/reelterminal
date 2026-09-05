/** Compatibility aliases; the cross-process contract is package-owned. */
export type {
  ConversationAdapterAvailability,
  ConversationCapabilityLevel,
  DesktopConversationAdapterSummary as ConversationAdapterSummary,
  DesktopConversationEvent,
  DesktopConversationState,
} from "@openreel/agent-facade/desktop-protocol";

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
  readonly projectId?: string;
  readonly projectName?: string;
  readonly references?: readonly {
    readonly ref: string;
    readonly number: number;
    readonly kind: "video" | "audio" | "text" | "media";
    readonly entityId: string;
    readonly label: string;
    readonly timing: {
      readonly startSeconds: number | null;
      readonly endSeconds: number | null;
    };
    readonly revisionAtMark: number;
    readonly stale: boolean;
  }[];
  readonly reviewMarkers?: readonly {
    readonly ref: string;
    readonly number: number;
    readonly id: string;
    readonly target: Record<string, unknown>;
    readonly label?: string;
  }[];
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
