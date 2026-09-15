import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  Check,
  CircleAlert,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Terminal,
} from "@/icons/lucide-compat";
import { ToolcraftButton as Button } from "@openreel/ui";
import type {
  OpenReelCodexThreadSummary,
  OpenReelConversationSetupProvider,
  OpenReelConversationSetupState,
} from "../../../types/global";

export interface AgentConnectionGuideProps {
  readonly provider: OpenReelConversationSetupProvider;
  readonly setup: OpenReelConversationSetupState | null;
  readonly selectedThread: string;
  readonly collabEnabled: boolean;
  readonly busy: boolean;
  readonly error: boolean;
  /**
   * True when the host exposes no desktop conversation API at all (the web
   * build). The requirements cannot even be inspected there, so the guide
   * states the desktop requirement instead of checking forever.
   */
  readonly desktopUnavailable?: boolean;
  readonly onProviderChange: (provider: OpenReelConversationSetupProvider) => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly onRefresh: () => void;
  readonly onConnect: () => void;
}

function CheckRow({
  state,
  title,
  detail,
}: {
  readonly state: "ready" | "missing" | "error" | "checking";
  readonly title: string;
  readonly detail: string;
}): JSX.Element {
  const good = state === "ready";
  const checking = state === "checking";
  return (
    <div className="relative flex gap-2.5 pb-3 last:pb-0">
      <span
        className={`relative z-10 mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border ${
          good
            ? "border-status-success/50 bg-status-success/15 text-status-success"
            : checking
              ? "border-accent/40 bg-accent-soft text-accent"
              : "border-status-warning/40 bg-status-warning/10 text-status-warning"
        }`}
      >
        {good ? <Check size={11} aria-hidden /> : checking ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <CircleAlert size={11} aria-hidden />}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-fg">{title}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">{detail}</p>
      </div>
    </div>
  );
}

function formatRecency(timestamp: number | null, language: string): string | null {
  if (timestamp === null) return null;
  const millis = timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
  try {
    return new Intl.DateTimeFormat(language, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(millis));
  } catch {
    return null;
  }
}

function ThreadOption({
  thread,
  selected,
  language,
  onSelect,
}: {
  readonly thread: OpenReelCodexThreadSummary;
  readonly selected: boolean;
  readonly language: string;
  readonly onSelect: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const recency = formatRecency(thread.updatedAt, language);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`w-full rounded-md border px-2.5 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
        selected
          ? "border-accent/55 bg-accent-soft"
          : "border-border bg-bg-1/60 hover:border-border-strong hover:bg-bg-2"
      }`}
    >
      <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
          {thread.title}
        </span>
        {thread.active ? (
          <span className="shrink-0 rounded-full bg-status-success/12 px-1.5 py-0.5 text-[10px] font-medium text-status-success">
            {t("externalAgent.setup.threadActive")}
          </span>
        ) : null}
        {recency ? <span className="shrink-0 font-mono text-[10px] text-fg-muted">{recency}</span> : null}
      </span>
      {thread.preview ? (
        <span className="mt-1 block truncate text-[11px] text-fg-muted">{thread.preview}</span>
      ) : null}
    </button>
  );
}

export function AgentConnectionGuide({
  provider,
  setup,
  selectedThread,
  collabEnabled,
  busy,
  error,
  desktopUnavailable = false,
  onProviderChange,
  onSelectThread,
  onRefresh,
  onConnect,
}: AgentConnectionGuideProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const checking = setup === null;
  const codexReady = setup?.codex.state === "ready";
  const authReady = setup?.authentication.state === "ready";
  const connectorReady = setup?.liveConnector.state === "ready";
  const adapterReady = setup?.externalAdapter.state === "ready";
  const codexCanConnect = Boolean(codexReady && authReady && connectorReady && selectedThread);
  const canConnect = provider === "codex" ? codexCanConnect : Boolean(adapterReady);

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-bg-2/55"
      aria-label={t("externalAgent.setup.title")}
    >
      <div className="border-b border-border bg-bg-2/80 px-3 py-3">
        <div className="flex items-start gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-accent/30 bg-accent-soft text-accent shadow-[inset_0_0_12px_rgba(124,92,255,0.08)]">
            <Link2 size={16} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-semibold text-fg">{t("externalAgent.setup.title")}</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">
              {t("externalAgent.setup.description")}
            </p>
          </div>
          <button
            type="button"
            aria-label={t("externalAgent.setup.refresh")}
            onClick={onRefresh}
            disabled={busy || desktopUnavailable}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
          >
            <RefreshCw size={13} aria-hidden className={busy ? "animate-spin" : undefined} />
          </button>
        </div>

        {desktopUnavailable ? null : (
          <div className="mt-3 grid grid-cols-2 gap-1 rounded-md bg-bg-1 p-1" role="tablist">
            {(["codex", "external"] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={provider === option}
                onClick={() => onProviderChange(option)}
                className={`flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-[11px] font-medium transition-colors ${
                  provider === option ? "bg-bg-elev text-fg shadow-sm" : "text-fg-muted hover:text-fg"
                }`}
              >
                {option === "codex" ? <Bot size={12} aria-hidden /> : <Terminal size={12} aria-hidden />}
                {t(`externalAgent.setup.provider.${option}`)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {desktopUnavailable ? (
          <div
            role="note"
            data-testid="desktop-required-notice"
            className="rounded-md border border-status-warning/30 bg-status-warning/8 px-2.5 py-2.5"
          >
            <p className="text-xs font-medium text-fg">
              {t("externalAgent.setup.desktopUnavailableTitle")}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
              {t("externalAgent.setup.desktopUnavailableDetail")}
            </p>
          </div>
        ) : (
          <div className="relative before:absolute before:bottom-4 before:left-[9px] before:top-2 before:w-px before:bg-border">
          <CheckRow
            state={collabEnabled ? "ready" : "missing"}
            title={t("externalAgent.setup.sessionTitle")}
            detail={t(collabEnabled ? "externalAgent.setup.sessionReady" : "externalAgent.setup.sessionMissing")}
          />
          {provider === "codex" ? (
            <>
              <CheckRow
                state={checking ? "checking" : setup.codex.state}
                title={t("externalAgent.setup.codexTitle")}
                detail={t(
                  checking
                    ? "externalAgent.setup.checking"
                    : setup.codex.state === "ready"
                      ? "externalAgent.setup.codexReady"
                      : setup.codex.code === "codex-missing"
                        ? "externalAgent.setup.codexMissing"
                        : "externalAgent.setup.codexUnavailable",
                )}
              />
              <CheckRow
                state={checking ? "checking" : setup.authentication.state}
                title={t("externalAgent.setup.authTitle")}
                detail={t(
                  checking
                    ? "externalAgent.setup.checking"
                    : setup.authentication.state === "ready"
                      ? "externalAgent.setup.authReady"
                      : setup.authentication.code === "auth-required"
                        ? "externalAgent.setup.authRequired"
                        : "externalAgent.setup.authUnknown",
                )}
              />
              <CheckRow
                state={checking ? "checking" : setup.liveConnector.state}
                title={t("externalAgent.setup.connectorTitle")}
                detail={t(
                  checking
                    ? "externalAgent.setup.checking"
                    : setup.liveConnector.state === "ready"
                      ? "externalAgent.setup.connectorReady"
                      : "externalAgent.setup.connectorMissing",
                )}
              />
            </>
          ) : (
            <CheckRow
              state={checking ? "checking" : setup.externalAdapter.state}
              title={t("externalAgent.setup.adapterTitle")}
              detail={t(
                checking
                  ? "externalAgent.setup.checking"
                  : setup.externalAdapter.state === "ready"
                    ? "externalAgent.setup.adapterReady"
                    : setup.externalAdapter.code === "adapter-missing"
                      ? "externalAgent.setup.adapterMissing"
                      : "externalAgent.setup.adapterInvalid",
              )}
            />
          )}
          </div>
        )}

        {provider === "codex" && codexReady && authReady ? (
          <div className="mt-1 border-t border-border pt-3">
            <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-fg-muted">
              {t("externalAgent.setup.chooseThread")}
            </p>
            <div className="max-h-48 space-y-1.5 overflow-y-auto pr-0.5" role="radiogroup" aria-label={t("externalAgent.setup.chooseThread")}>
              {setup.threads.map((thread) => (
                <ThreadOption
                  key={thread.id}
                  thread={thread}
                  selected={selectedThread === thread.id}
                  language={i18n.language}
                  onSelect={() => onSelectThread(thread.id)}
                />
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={selectedThread === "new"}
                onClick={() => onSelectThread("new")}
                className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                  selectedThread === "new" ? "border-accent/55 bg-accent-soft" : "border-border bg-bg-1/60 hover:bg-bg-2"
                }`}
              >
                <span className="grid h-6 w-6 place-items-center rounded bg-bg-3 text-accent"><Plus size={12} aria-hidden /></span>
                <span>
                  <span className="block text-xs font-medium text-fg">{t("externalAgent.setup.newThread")}</span>
                  <span className="mt-0.5 block text-[10px] text-fg-muted">{t("externalAgent.setup.newThreadHint")}</span>
                </span>
              </button>
            </div>
          </div>
        ) : null}

        {error ? (
          <div role="alert" className="mt-3 rounded-md border border-status-error/30 bg-status-error/8 px-2.5 py-2 text-[11px] leading-relaxed text-status-error">
            {t("externalAgent.setup.connectFailed")}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-bg-2/90 px-3 py-2.5 shadow-[0_-8px_20px_rgba(0,0,0,0.08)]">
          <p className="text-[10px] leading-relaxed text-fg-muted">
            {t(provider === "codex" ? "externalAgent.setup.codexOwnership" : "externalAgent.setup.externalOwnership")}
          </p>
          <Button
            label={busy ? t("externalAgent.setup.connecting") : t("externalAgent.setup.connect")}
            icon={busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Link2 size={12} aria-hidden />}
            variant="primary"
            size="sm"
            isDisabled={!canConnect || busy}
            onClick={onConnect}
            className="shrink-0"
          />
      </div>
    </section>
  );
}
