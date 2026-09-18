import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AudioLines, Bot, CircleHelp, FolderOpen, MessageSquare, Power, X } from "@/icons/lucide-compat";
import { useCollabStore, installCollabEventListener, type CollabMode } from "../../stores/collab-store";
import { useUIStore } from "../../stores/ui-store";
import { useAgentReferencesStore } from "../../stores/agent-references-store";
import { AGENT_MEDIA_TASK_MODAL_ID } from "../../components/editor/dialogs/AgentMediaTaskDialog";
import { useTranslation } from "react-i18next";
import { useAnchoredBelowStyle } from "../../utils/anchored-position";
import { AnalysisRecordsPanel } from "./AnalysisRecordsPanel";

/** localStorage flag: first-run Agent Session intro bubble has been dismissed. */
const INTRO_SEEN_KEY = "reelterminal.agentSessionIntroSeen";

function readIntroSeen(): boolean {
  try {
    return window.localStorage.getItem(INTRO_SEEN_KEY) === "1";
  } catch {
    return true; // storage unavailable → don't nag
  }
}

function markIntroSeen(): void {
  try {
    window.localStorage.setItem(INTRO_SEEN_KEY, "1");
  } catch {
    /* non-persistent dismissal is fine */
  }
}

const MODES: ReadonlyArray<{
  id: CollabMode;
  labelKey:
    | "desktop.collaboration.guided"
    | "desktop.collaboration.collaborative"
    | "desktop.collaboration.autonomous";
  descriptionKey:
    | "desktop.collaboration.guidedDescription"
    | "desktop.collaboration.collaborativeDescription"
    | "desktop.collaboration.autonomousDescription";
}> = [
  {
    id: "guided",
    labelKey: "desktop.collaboration.guided",
    descriptionKey: "desktop.collaboration.guidedDescription",
  },
  {
    id: "collaborative",
    labelKey: "desktop.collaboration.collaborative",
    descriptionKey: "desktop.collaboration.collaborativeDescription",
  },
  {
    id: "autonomous",
    labelKey: "desktop.collaboration.autonomous",
    descriptionKey: "desktop.collaboration.autonomousDescription",
  },
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
  const workMode = useCollabStore((s) => s.workMode);
  const access = useCollabStore((s) => s.access);
  const currentAction = useCollabStore((s) => s.currentAction);
  const enable = useCollabStore((s) => s.enable);
  const disable = useCollabStore((s) => s.disable);
  const setWorkMode = useCollabStore((s) => s.setWorkMode);
  const setAccess = useCollabStore((s) => s.setAccess);

  const chatOpen = useUIStore((s) => s.panels.externalAgent.visible);
  const togglePanel = useUIStore((s) => s.togglePanel);
  // The strip hosts the desktop's voiceover/music task trigger since the
  // desktop layout has no mixer panel to carry it.
  const openModal = useUIStore((s) => s.openModal);
  const references = useAgentReferencesStore((s) =>
    Object.values(s.references).sort((a, b) => a.number - b.number),
  );

  const [helpOpen, setHelpOpen] = useState(false);
  const [introSeen, setIntroSeen] = useState(readIntroSeen);

  // Both explanation popups portal to document.body: as in-app absolute
  // layers they were trapped in the desktop shell's single `isolate`
  // stacking context and lost to the timeline toolbar (same z, later DOM).
  // Portaled, they take their z from the --z-popover ladder (index.css).
  const anchorRef = useRef<HTMLDivElement>(null);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const introPanelRef = useRef<HTMLDivElement>(null);
  const helpPanelRef = useRef<HTMLDivElement>(null);
  const introOpen = !enabled && !introSeen;
  const anchorStyle = useAnchoredBelowStyle(anchorRef, helpOpen || introOpen, 6);

  useEffect(() => {
    void useCollabStore.getState().refresh();
    return installCollabEventListener();
  }, []);

  const openWorkspace = () => {
    void window.openreel?.collabControl?.openWorkspace?.();
  };

  const dismissIntro = () => {
    markIntroSeen();
    setIntroSeen(true);
  };

  const closeHelp = (restoreFocus: boolean) => {
    setHelpOpen(false);
    if (restoreFocus) helpButtonRef.current?.focus();
  };

  // Escape and outside-click for the help popover; Escape returns focus to
  // the ⓘ trigger. Clicks inside the anchor container are ignored so the
  // trigger button keeps handling its own toggle.
  useEffect(() => {
    if (!helpOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeHelp(true);
    };
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (helpPanelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      closeHelp(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [helpOpen]);

  // Same dismissal paths for the first-run intro bubble; like the "Got it"
  // button they count as "seen" so the intro does not nag again.
  useEffect(() => {
    if (!introOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      dismissIntro();
    };
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (introPanelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      dismissIntro();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [introOpen]);

  const statusText = !enabled
    ? t("desktop.collaboration.disabled")
    : externalConnected
      ? t("desktop.collaboration.externalConnected")
      : writer === "external"
        ? t("desktop.collaboration.readyExternal")
        : t("desktop.collaboration.ready");

  return (
    <div className="flex h-full items-center gap-3 border-b border-border bg-bg-1 px-3 text-[11px] text-fg-2">
      <div className="relative flex items-center gap-1" ref={anchorRef}>
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

        <button
          type="button"
          ref={helpButtonRef}
          aria-label={t("desktop.collaboration.helpAria")}
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen((open) => !open)}
          className="flex h-5 w-5 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <CircleHelp size={12} aria-hidden />
        </button>

        {introOpen &&
          createPortal(
            <div
              ref={introPanelRef}
              role="status"
              style={anchorStyle}
              className="z-[var(--z-popover)] w-64 rounded-md border border-border bg-bg-elev p-3 text-fg-2 shadow-lg"
            >
              <p className="font-medium text-fg">{t("desktop.collaboration.introTitle")}</p>
              <p className="mt-1 leading-snug">{t("desktop.collaboration.introBody")}</p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setHelpOpen(true);
                    dismissIntro();
                  }}
                  className="rounded-[5px] bg-accent-soft px-2 py-0.5 font-medium text-accent hover:opacity-90"
                >
                  {t("desktop.collaboration.introLearnMore")}
                </button>
                <button
                  type="button"
                  onClick={dismissIntro}
                  className="rounded-[5px] px-2 py-0.5 text-fg-muted hover:text-fg"
                >
                  {t("desktop.collaboration.introDismiss")}
                </button>
              </div>
            </div>,
            document.body,
          )}

        {helpOpen &&
          createPortal(
            <div
              ref={helpPanelRef}
              role="dialog"
              aria-label={t("desktop.collaboration.helpTitle")}
              style={anchorStyle}
              className="z-[var(--z-popover)] w-72 rounded-md border border-border bg-bg-elev p-3 text-fg-2 shadow-lg"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium text-fg">{t("desktop.collaboration.helpTitle")}</p>
                <button
                  type="button"
                  aria-label={t("desktop.collaboration.helpClose")}
                  onClick={() => closeHelp(true)}
                  className="flex h-4 w-4 items-center justify-center rounded text-fg-muted hover:text-fg"
                >
                  <X size={11} aria-hidden />
                </button>
              </div>
              <p className="mt-1.5 leading-snug">{t("desktop.collaboration.helpLine1")}</p>
              <p className="mt-1 leading-snug">{t("desktop.collaboration.helpLine2")}</p>
              <p className="mt-1 leading-snug">{t("desktop.collaboration.helpLine3")}</p>
              <button
                type="button"
                onClick={openWorkspace}
                className="mt-2 flex items-center gap-1.5 rounded-[5px] bg-bg-2 px-2 py-1 font-medium text-fg hover:bg-bg-3"
              >
                <FolderOpen size={12} aria-hidden />
                {t("desktop.collaboration.openWorkspace")}
              </button>
            </div>,
            document.body,
          )}
      </div>

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
            aria-checked={workMode === m.id}
            title={t(m.descriptionKey)}
            onClick={() => void setWorkMode(m.id)}
            className={`rounded-[5px] px-2 py-0.5 transition-colors ${
              workMode === m.id
                ? "bg-bg-elev text-fg"
                : "text-fg-muted hover:text-fg"
            }`}
          >
            {t(m.labelKey)}
          </button>
        ))}
      </div>

      {access === "read-only" && (
        <div className="flex items-center gap-1">
          <span
            className="rounded-[5px] bg-bg-2 px-1.5 py-0.5 text-fg-muted"
            title={t("desktop.collaboration.readOnlyDescription")}
          >
            {t("desktop.collaboration.readOnly")}
          </span>
          <button
            type="button"
            onClick={() => void setAccess("write")}
            className="rounded-[5px] px-1.5 py-0.5 font-medium text-accent hover:bg-accent-soft"
            title={t("desktop.collaboration.restoreWriteDescription")}
          >
            {t("desktop.collaboration.restoreWrite")}
          </button>
        </div>
      )}

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
              A{reference.number}
            </span>
          ))}
        </div>
      )}

      <div className="ml-auto flex items-center">
        <AnalysisRecordsPanel />
        {/* Opens the shared voiceover/music task dialog (mounted on the Edit
            page) via the standard ui-store modal id.
            Label/icon mirror the web mixer entry (`agentMediaTasks.entry`). */}
        <button
          type="button"
          data-testid="collab-agent-media-entry"
          aria-label={t("agentMediaTasks.entry")}
          onClick={() => openModal(AGENT_MEDIA_TASK_MODAL_ID)}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors text-fg-2 hover:bg-hover hover:text-fg"
        >
          <AudioLines size={13} aria-hidden />
          {t("agentMediaTasks.entry")}
        </button>
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
