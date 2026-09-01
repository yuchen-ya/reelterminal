import type { JSX } from "react";
import { useEffect } from "react";
import { ToolcraftIconButton as IconButton } from "@openreel/ui";
import { Bot, MessageSquare, Power, XCircle } from "@/icons/lucide-compat";
import { useCollabStore, installCollabEventListener, type CollabMode } from "../../stores/collab-store";
import { useChatStore } from "../../stores/chat-store";
import { useUIStore } from "../../stores/ui-store";

const MODES: ReadonlyArray<{ id: CollabMode; label: string }> = [
  { id: "observe", label: "Observe" },
  { id: "assist", label: "Assist" },
  { id: "autonomous", label: "Autonomous" },
];

/**
 * Live collaboration strip (ADR 0004 Decisions 6+7): agent-session toggle,
 * writer/status readout, mode selector, current agent action, and turn cancel.
 * Mounted above the timeline on the desktop Edit page.
 */
export function CollabStatusBar(): JSX.Element {
  const enabled = useCollabStore((s) => s.enabled);
  const externalConnected = useCollabStore((s) => s.externalConnected);
  const writer = useCollabStore((s) => s.writer);
  const mode = useCollabStore((s) => s.mode);
  const currentAction = useCollabStore((s) => s.currentAction);
  const enable = useCollabStore((s) => s.enable);
  const disable = useCollabStore((s) => s.disable);
  const setMode = useCollabStore((s) => s.setMode);

  const chatStatus = useChatStore((s) => s.status);
  const stopChat = useChatStore((s) => s.stop);
  const chatOpen = useUIStore((s) => s.panels.agentChat.visible);
  const togglePanel = useUIStore((s) => s.togglePanel);

  useEffect(() => {
    void useCollabStore.getState().refresh();
    return installCollabEventListener();
  }, []);

  const chatRunning =
    chatStatus === "running" || chatStatus === "awaiting_confirm";

  const statusText = !enabled
    ? "Disabled"
    : externalConnected
      ? "External agent connected"
      : writer === "embedded"
        ? "Ready · writer: embedded"
        : "Ready";

  return (
    <div className="flex h-full items-center gap-3 border-b border-border bg-bg-1 px-3 text-[11px] text-fg-2">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Agent Session"
        onClick={() => void (enabled ? disable() : enable())}
        className={`flex items-center gap-1.5 rounded-[7px] px-2 py-1 font-medium transition-colors ${
          enabled
            ? "bg-accent-soft text-accent"
            : "bg-bg-2 text-fg-2 hover:bg-bg-3 hover:text-fg"
        }`}
      >
        <Power size={11} aria-hidden />
        Agent Session
      </button>

      <span className="flex items-center gap-1.5 text-fg-muted">
        <span
          className={`h-1.5 w-1.5 rounded-full ${enabled ? "bg-status-success" : "bg-fg-muted"}`}
        />
        {statusText}
      </span>

      <div
        role="radiogroup"
        aria-label="Agent mode"
        className="flex items-center gap-0.5 rounded-[7px] bg-bg-2 p-0.5"
      >
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            disabled={!enabled}
            onClick={() => void setMode(m.id)}
            className={`rounded-[5px] px-2 py-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              mode === m.id
                ? "bg-bg-elev text-fg"
                : "text-fg-muted hover:text-fg"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {(chatRunning || currentAction) && (
        <span className="flex min-w-0 items-center gap-1.5 text-accent">
          <Bot size={11} aria-hidden className="shrink-0" />
          <span className="truncate">
            {currentAction
              ? `Agent: ${currentAction}`
              : chatRunning
                ? "Agent working…"
                : ""}
          </span>
        </span>
      )}

      {chatRunning && (
        <button
          type="button"
          onClick={stopChat}
          className="flex items-center gap-1 rounded-[7px] bg-bg-2 px-2 py-1 text-fg-2 transition-colors hover:bg-bg-3 hover:text-fg"
        >
          <XCircle size={11} aria-hidden />
          Cancel
        </button>
      )}

      <div className="ml-auto flex items-center">
        <IconButton
          label={chatOpen ? "Close agent chat" : "Open agent chat"}
          icon={<MessageSquare size={13} aria-hidden />}
          variant="ghost"
          size="sm"
          aria-pressed={chatOpen}
          onClick={() => togglePanel("agentChat")}
          className={`grid h-7 w-7 place-items-center rounded-md transition-colors ${
            chatOpen
              ? "bg-accent-soft text-accent"
              : "text-fg-2 hover:bg-hover hover:text-fg"
          }`}
        />
      </div>
    </div>
  );
}

export default CollabStatusBar;
