import type { JSX } from "react";
import { useEffect } from "react";
import { Bot, MessageSquare, Power } from "@/icons/lucide-compat";
import { useCollabStore, installCollabEventListener, type CollabMode } from "../../stores/collab-store";
import { useUIStore } from "../../stores/ui-store";
import { useAgentReferencesStore } from "../../stores/agent-references-store";
import { useTranslation } from "react-i18next";

const MODES: ReadonlyArray<{
  id: CollabMode;
  labelKey: "desktop.collaboration.observe" | "desktop.collaboration.assist" | "desktop.collaboration.autonomous";
}> = [
  { id: "observe", labelKey: "desktop.collaboration.observe" },
  { id: "assist", labelKey: "desktop.collaboration.assist" },
  { id: "autonomous", labelKey: "desktop.collaboration.autonomous" },
];

/**
 * Live collaboration strip (ADR 0004 Decisions 6+7): agent-session toggle,
 * writer/status readout, mode selector, current agent action, and turn cancel.
 * Mounted above the timeline on the desktop Edit page.
 */
export function CollabStatusBar(): JSX.Element {
  const { t } = useTranslation();
  const enabled = useCollabStore((s) => s.enabled);
  const externalConnected = useCollabStore((s) => s.externalConnected);
  const writer = useCollabStore((s) => s.writer);
  const mode = useCollabStore((s) => s.mode);
  const currentAction = useCollabStore((s) => s.currentAction);
  const enable = useCollabStore((s) => s.enable);
  const disable = useCollabStore((s) => s.disable);
  const setMode = useCollabStore((s) => s.setMode);

  const chatOpen = useUIStore((s) => s.panels.externalAgent.visible);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const references = useAgentReferencesStore((s) =>
    Object.values(s.references).sort((a, b) => a.number - b.number),
  );

  useEffect(() => {
    void useCollabStore.getState().refresh();
    return installCollabEventListener();
  }, []);

  const statusText = !enabled
    ? t("desktop.collaboration.disabled")
    : externalConnected
      ? t("desktop.collaboration.externalConnected")
      : writer === "external"
        ? t("desktop.collaboration.readyExternal")
        : t("desktop.collaboration.ready");

  return (
    <div className="flex h-full items-center gap-3 border-b border-border bg-bg-1 px-3 text-[11px] text-fg-2">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={t("desktop.collaboration.agentSession")}
        onClick={() => void (enabled ? disable() : enable())}
        className={`flex items-center gap-1.5 rounded-[7px] px-2 py-1 font-medium transition-colors ${
          enabled
            ? "bg-accent-soft text-accent"
            : "bg-bg-2 text-fg-2 hover:bg-bg-3 hover:text-fg"
        }`}
      >
        <Power size={11} aria-hidden />
        {t("desktop.collaboration.agentSession")}
      </button>

      <span className="flex items-center gap-1.5 text-fg-muted">
        <span
          className={`h-1.5 w-1.5 rounded-full ${enabled ? "bg-status-success" : "bg-fg-muted"}`}
        />
        {statusText}
      </span>

      <div
        role="radiogroup"
        aria-label={t("desktop.collaboration.agentMode")}
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
            {t(m.labelKey)}
          </button>
        ))}
      </div>

      {currentAction && (
        <span className="flex min-w-0 items-center gap-1.5 text-accent">
          <Bot size={11} aria-hidden className="shrink-0" />
          <span className="truncate">
            {t("desktop.collaboration.agentAction", { action: currentAction })}
          </span>
        </span>
      )}

      {references.length > 0 && (
        <div
          className="flex min-w-0 items-center gap-1 border-l border-border pl-2"
          aria-label={t("agentReferences.ariaLabel")}
          title={t("agentReferences.sessionHint")}
        >
          {references.map((reference) => (
            <span
              key={reference.number}
              className={`rounded-[4px] px-1.5 py-0.5 text-[9px] font-bold leading-none tabular-nums ${
                reference.stale
                  ? "bg-bg-3 text-fg-muted line-through"
                  : "bg-violet-500/90 text-white"
              }`}
              aria-label={t("agentReferences.referenceLabel", {
                number: reference.number,
                state: reference.stale ? t("agentReferences.staleSuffix") : "",
              })}
            >
              #{reference.number}
            </span>
          ))}
        </div>
      )}

      <div className="ml-auto flex items-center">
        <button
          type="button"
          aria-label={t(chatOpen ? "externalAgent.closePanel" : "externalAgent.openPanel")}
          aria-pressed={chatOpen}
          onClick={() => togglePanel("externalAgent")}
          className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors ${
            chatOpen
              ? "bg-accent-soft text-accent"
              : "text-fg-2 hover:bg-hover hover:text-fg"
          }`}
        >
          <MessageSquare size={13} aria-hidden />
          {t("externalAgent.title")}
        </button>
      </div>
    </div>
  );
}

export default CollabStatusBar;
