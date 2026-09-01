import { create } from "zustand";
import {
  runTurn,
  toAnthropicTools,
  toOpenAITools,
  buildSystemPrompt,
} from "@openreel/agent";
import type {
  AgentEvent,
  ConfirmDecision,
  ToolCall,
  ToolResult,
  LoopMessage,
  RunTurnResult,
} from "@openreel/agent";
import { isSessionUnlocked, getSecret } from "../services/secure-storage";
import { getLiveEditorHost, runExclusive } from "../services/agent/host-singleton";
import { makeBYOKClient } from "../services/agent/llm-transport";
import { defaultModelFor, modelsFor } from "../services/agent/models";
import {
  facadeAnthropicTools,
  facadeOpenAITools,
  facadeChatExecutor,
  facadeGating,
  LIVE_COLLAB_SYSTEM_PROMPT,
} from "../services/agent/facade-chat";
import { getLiveEditorContext } from "./editor-context-store";
import { useSettingsStore } from "./settings-store";
import { useProjectStore, getProjectRevision } from "./project-store";

export type ChatStatus = "idle" | "running" | "awaiting_confirm" | "error";

export type ToolCallStatus = "running" | "done" | "error" | "rejected";

/** Per-tool-call metadata, extracted from ToolResult.data when present. */
export interface ToolCallMeta {
  readonly revision?: number;
  readonly affectedIds?: string[];
}

export interface ToolCallView {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly status: ToolCallStatus;
  readonly result?: ToolResult;
  readonly meta?: ToolCallMeta;
}

/** Send-time snapshot (ADR 0004 Decision 8: mutual legibility metadata). */
export interface ChatMessageMeta {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly contextRevision: number;
  readonly selection: {
    readonly clipIds: string[];
    readonly textIds: string[];
  };
  /** Undo-stack size recorded when this turn committed. */
  readonly undoCheckpoint?: number;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly toolCalls: ToolCallView[];
  readonly meta?: ChatMessageMeta;
}

interface PendingConfirm {
  readonly call: ToolCall;
  readonly resolve: (decision: ConfirmDecision) => void;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

interface ChatState {
  messages: ChatMessage[];
  status: ChatStatus;
  conversation: LoopMessage[];
  pendingConfirm: PendingConfirm | null;
  error: string | null;
  abortController: AbortController | null;
  lastTurnCommitted: boolean;
  lastTurnUndoSize: number | null;
  /** Undo-stack size captured before the running turn (multi-group undo base). */
  turnStartUndoSize: number | null;
  usage: TokenUsage;

  send: (text: string) => Promise<void>;
  resolveConfirm: (decision: ConfirmDecision) => void;
  stop: () => void;
  undoLastTurn: () => Promise<void>;
  clearError: () => void;
  reset: () => void;
}

const genId = (): string =>
  (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto
    ?.randomUUID?.() ?? `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const isDesktop = (): boolean =>
  typeof window !== "undefined" && window.openreel?.platform === "desktop";

// Monotonic turn id: a completion whose seq is stale (reset/superseded) must not
// write back into the store.
let activeSeq = 0;

function undoStackSize(): number | null {
  try {
    return useProjectStore.getState().actionExecutor.getHistory().getUndoStackSize();
  } catch {
    return null;
  }
}

/**
 * Desktop + live facade bridge ⇒ the chat runs against the 15-verb facade
 * session in the main process (ADR 0004 Decision 8). Web keeps the registry
 * tool surface.
 */
const useFacadeTools = (): boolean =>
  isDesktop() && typeof window.openreel?.facade?.call === "function";

/** Pulls { revision?, affectedIds? } out of a ToolResult data payload. */
function extractToolCallMeta(data: unknown): ToolCallMeta | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  const revision =
    typeof record.revision === "number" && Number.isFinite(record.revision)
      ? record.revision
      : undefined;
  const affectedIds = Array.isArray(record.affectedIds)
    ? record.affectedIds.filter((id): id is string => typeof id === "string")
    : undefined;
  if (revision === undefined && affectedIds === undefined) return undefined;
  return {
    ...(revision !== undefined ? { revision } : {}),
    ...(affectedIds !== undefined ? { affectedIds } : {}),
  };
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  status: "idle",
  conversation: [],
  pendingConfirm: null,
  error: null,
  abortController: null,
  lastTurnCommitted: false,
  lastTurnUndoSize: null,
  turnStartUndoSize: null,
  usage: { inputTokens: 0, outputTokens: 0 },

  send: async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const current = get();
    if (current.status === "running" || current.status === "awaiting_confirm") {
      return;
    }
    if (!useProjectStore.getState().hasOpenProject) {
      set({ error: "Open or create a project before chatting." });
      return;
    }

    const provider = useSettingsStore.getState().defaultLlmProvider;
    const storedModel = useSettingsStore.getState().llmModel;
    const model = modelsFor(provider).some((m) => m.id === storedModel)
      ? storedModel
      : defaultModelFor(provider);

    if (!isDesktop() && !isSessionUnlocked()) {
      set({ error: "Unlock secure storage to use your API key." });
      return;
    }
    let apiKey = "";
    try {
      apiKey = isDesktop() ? "" : ((await getSecret(provider)) ?? "");
    } catch {
      set({ error: "Unlock secure storage to use your API key." });
      return;
    }
    if (!isDesktop() && !apiKey) {
      set({
        error: `No ${provider} API key configured. Add it in Settings → API Keys.`,
      });
      return;
    }

    const userMessage: ChatMessage = {
      id: genId(),
      role: "user",
      text: trimmed,
      toolCalls: [],
    };
    const assistantMessage: ChatMessage = {
      id: genId(),
      role: "assistant",
      text: "",
      toolCalls: [],
    };
    const assistantId = assistantMessage.id;
    const controller = new AbortController();
    const seq = ++activeSeq;

    // Mutual-legibility metadata: the project/context state the user saw when
    // they sent this message (Decision 8).
    let sendMeta: ChatMessageMeta | undefined;
    try {
      const ctx = getLiveEditorContext();
      sendMeta = {
        projectId: useProjectStore.getState().project.id,
        projectRevision: getProjectRevision(),
        contextRevision: ctx.contextRevision,
        selection: {
          clipIds: [...ctx.selectedClipIds],
          textIds: [...ctx.selectedTextIds],
        },
      };
    } catch {
      sendMeta = undefined;
    }

    set((state) => ({
      messages: [
        ...state.messages,
        sendMeta ? { ...userMessage, meta: sendMeta } : userMessage,
        assistantMessage,
      ],
      conversation: [...state.conversation, { role: "user", content: trimmed }],
      status: "running",
      error: null,
      abortController: controller,
      pendingConfirm: null,
      turnStartUndoSize: undoStackSize(),
    }));

    const updateAssistant = (fn: (m: ChatMessage) => ChatMessage): void => {
      if (activeSeq !== seq) return;
      set((state) => ({
        messages: state.messages.map((m) => (m.id === assistantId ? fn(m) : m)),
      }));
    };

    const onEvent = (event: AgentEvent): void => {
      switch (event.type) {
        case "text_delta":
        case "turn_complete":
          updateAssistant((m) => ({ ...m, text: event.text || m.text }));
          break;
        case "tool_call":
          updateAssistant((m) => ({
            ...m,
            toolCalls: [
              ...m.toolCalls,
              {
                id: event.call.id,
                name: event.call.name,
                args: event.call.args,
                status: "running",
              },
            ],
          }));
          break;
        case "tool_result":
          updateAssistant((m) => ({
            ...m,
            toolCalls: m.toolCalls.map((tc) =>
              tc.id === event.call.id
                ? {
                    ...tc,
                    result: event.result,
                    status: event.result.ok
                      ? "done"
                      : event.result.error?.code === "REJECTED"
                        ? "rejected"
                        : "error",
                    meta:
                      extractToolCallMeta(event.result.data) ?? tc.meta,
                  }
                : tc,
            ),
          }));
          break;
        case "error":
          if (activeSeq === seq) set({ error: event.error.message });
          break;
        case "awaiting_confirmation":
          break;
      }
    };

    const host = getLiveEditorHost();
    const llm = makeBYOKClient({
      provider,
      model,
      apiKey,
      signal: controller.signal,
    });
    // Desktop: run the turn against the main-process live facade session
    // (same 15-verb contract as external agents). Web: registry tools.
    const facade = useFacadeTools();
    const tools = facade
      ? provider === "anthropic"
        ? facadeAnthropicTools()
        : facadeOpenAITools()
      : provider === "anthropic"
        ? toAnthropicTools()
        : toOpenAITools();
    const system = facade
      ? LIVE_COLLAB_SYSTEM_PROMPT
      : buildSystemPrompt(host);
    const autoConfirm = useSettingsStore.getState().agentAutoConfirm;
    const dryRun = useSettingsStore.getState().agentDryRun;

    const run = (): Promise<RunTurnResult> =>
      runTurn({
        host,
        llm,
        tools,
        system,
        ...(facade
          ? { executor: facadeChatExecutor, gating: facadeGating }
          : {}),
        messages: get().conversation,
        dryRun,
        confirmGate: autoConfirm
          ? () => "approve_for_turn"
          : (call) =>
              new Promise<ConfirmDecision>((resolve) => {
                set({ status: "awaiting_confirm", pendingConfirm: { call, resolve } });
              }),
        onEvent,
        turnLabel: "AI edit",
      });

    // The registry path mutates the store directly, so it serializes against
    // other agent entry points via runExclusive. The facade path must NOT
    // hold that lock: its edit.apply calls round-trip main → live bridge →
    // back into this renderer, where the bridge takes runExclusive itself —
    // holding it here would deadlock the turn. Per-batch serialization still
    // happens inside the bridge.
    const result = facade ? await run() : await runExclusive(run);

    // A reset() (or a newer turn) during the run supersedes this completion.
    if (activeSeq !== seq) return;
    const wasAborted = controller.signal.aborted;
    const undoCheckpoint = result.committed ? undoStackSize() : null;
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === assistantId
          ? {
              ...m,
              meta: {
                ...(sendMeta ?? {
                  projectId: "",
                  projectRevision: 0,
                  contextRevision: 0,
                  selection: { clipIds: [], textIds: [] },
                }),
                ...(undoCheckpoint !== null ? { undoCheckpoint } : {}),
              },
            }
          : m,
      ),
      conversation: result.messages,
      status: wasAborted
        ? "idle"
        : result.stoppedReason === "error"
          ? "error"
          : "idle",
      lastTurnCommitted: result.committed,
      lastTurnUndoSize: undoCheckpoint,
      abortController: null,
      pendingConfirm: null,
      usage: {
        inputTokens: state.usage.inputTokens + result.usage.inputTokens,
        outputTokens: state.usage.outputTokens + result.usage.outputTokens,
      },
      error: wasAborted
        ? null
        : result.stoppedReason === "error"
          ? (state.error ?? "The AI turn failed.")
          : state.error,
    }));
  },

  resolveConfirm: (decision: ConfirmDecision) => {
    const pending = get().pendingConfirm;
    if (!pending) return;
    set({ pendingConfirm: null, status: "running" });
    pending.resolve(decision);
  },

  stop: () => {
    const { abortController, pendingConfirm } = get();
    pendingConfirm?.resolve("reject");
    abortController?.abort();
    set({ pendingConfirm: null });
  },

  undoLastTurn: async () => {
    if (!get().lastTurnCommitted) return;
    // If the project's undo stack moved since the turn committed, a later edit
    // is on top — undoing it would hit the wrong action, so just drop the
    // affordance rather than clobber the user's edit.
    const checkpoint = get().lastTurnUndoSize;
    if (checkpoint !== null && undoStackSize() !== checkpoint) {
      set({ lastTurnCommitted: false, lastTurnUndoSize: null });
      return;
    }
    const startSize = get().turnStartUndoSize;
    if (startSize === null) {
      // No pre-turn baseline (legacy state): one undo, as before.
      await useProjectStore.getState().undo();
    } else {
      // A facade-path turn may span several history groups (one per
      // edit.apply). Undo group-by-group until the stack is back to the
      // pre-turn size; bounded so a stuck stack can't loop forever.
      const MAX_UNDOS = 50;
      for (let i = 0; i < MAX_UNDOS; i++) {
        const size = undoStackSize();
        if (size === null || size <= startSize) break;
        const result = await useProjectStore.getState().undo();
        if (!result.success) break;
      }
    }
    set({
      lastTurnCommitted: false,
      lastTurnUndoSize: null,
      turnStartUndoSize: null,
    });
  },

  clearError: () => set({ error: null }),

  reset: () => {
    get().pendingConfirm?.resolve("reject");
    get().abortController?.abort();
    // Supersede any in-flight turn so its completion can't write back.
    activeSeq++;
    set({
      messages: [],
      conversation: [],
      status: "idle",
      pendingConfirm: null,
      error: null,
      abortController: null,
      lastTurnCommitted: false,
      lastTurnUndoSize: null,
      turnStartUndoSize: null,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  },
}));
