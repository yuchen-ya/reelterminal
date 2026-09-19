export type ConversationSetupProvider = "codex" | "external";

export type ConversationSetupCheckState = "ready" | "missing" | "error";

export interface ConversationSetupCheck {
  readonly state: ConversationSetupCheckState;
  /** Stable UI-facing code. No command output, paths, or credentials. */
  readonly code: string;
  /**
   * Optional sanitized, path-free diagnostic summary for error checks (for
   * example the first App Server stderr line, redacted by the client).
   */
  readonly detail?: string | null;
}

export interface CodexConversationThreadSummary {
  readonly id: string;
  readonly title: string;
  readonly preview: string | null;
  readonly updatedAt: number | null;
  readonly active: boolean;
}

export interface ConversationSetupState {
  readonly codex: ConversationSetupCheck;
  readonly authentication: ConversationSetupCheck;
  readonly liveConnector: ConversationSetupCheck;
  readonly externalAdapter: ConversationSetupCheck;
  readonly threads: readonly CodexConversationThreadSummary[];
  readonly managedSessionId: string | null;
}

export interface ConversationSetupStartArgs {
  readonly provider: ConversationSetupProvider;
  readonly threadId?: string;
  readonly createThread?: boolean;
}
