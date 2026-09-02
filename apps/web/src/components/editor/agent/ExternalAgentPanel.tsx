import type { JSX, ReactNode } from "react";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftButton as Button } from "@openreel/ui";
import { ToolcraftIconButton as IconButton } from "@openreel/ui";
import { ToolcraftText as Text } from "@openreel/ui";
import {
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock,
  Copy,
  Hash,
  Loader2,
  MessageSquare,
  Power,
  ShieldCheck,
  Send,
  X,
} from "@/icons/lucide-compat";
import type {
  AgentApprovalRequest,
  AgentActivity,
  AgentCapabilityAvailability,
  AgentConversationViewModel,
  AgentConnectionView,
  AgentMessage,
  AgentReferenceChip,
  AgentThinkingSummary,
  AgentToolCall,
  AgentToolCallStatus,
} from "./AgentViewModel";

export interface ExternalAgentPanelProps {
  readonly viewModel?: AgentConversationViewModel;
  /** Pure display input; no store or transport is read by this component. */
  readonly connection?: AgentConnectionView;
  readonly messages?: readonly AgentMessage[];
  readonly thinkingSummary?: AgentThinkingSummary | null;
  readonly toolCalls?: readonly AgentToolCall[];
  readonly approvals?: readonly AgentApprovalRequest[];
  readonly references?: readonly AgentReferenceChip[];
  readonly capabilities?: AgentCapabilityAvailability;
  readonly onClose?: () => void;
  readonly onConnect?: () => void;
  /** Disconnects only this ReelTerminal view; it does not end the external session. */
  readonly onDisconnect?: () => void;
  readonly onCancel?: () => void;
  readonly onSend?: (text: string) => void | Promise<void>;
  readonly onApprove?: (approvalId: string) => void;
  readonly onDeny?: (approvalId: string) => void;
  readonly onCopyReferences?: () => void;
  readonly onReferenceClick?: (reference: AgentReferenceChip) => void;
  readonly cancelling?: boolean;
  readonly copyingReferences?: boolean;
  readonly sending?: boolean;
}

const DEFAULT_CONNECTION: AgentConnectionView = { state: "disconnected" };
const DEFAULT_CAPABILITIES: AgentCapabilityAvailability = {
  basic: false,
  streaming: false,
  full: false,
};

function formatTiming(reference: AgentReferenceChip): string | null {
  if (reference.startSeconds == null || reference.endSeconds == null) return null;
  return `${reference.startSeconds.toFixed(2)}s–${reference.endSeconds.toFixed(2)}s`;
}

function connectionStatusKey(state: AgentConnectionView["state"]): string {
  switch (state) {
    case "connected":
      return "externalAgent.connectionConnected";
    case "connecting":
      return "externalAgent.connectionConnecting";
    case "unsupported":
      return "externalAgent.connectionUnsupported";
    case "error":
      return "externalAgent.connectionError";
    case "disabled":
      return "externalAgent.statusDisabled";
    case "disconnected":
      return "externalAgent.connectionDisconnected";
  }
}

function statusIcon(status: AgentToolCallStatus): JSX.Element {
  switch (status) {
    case "completed":
      return <CircleCheck size={14} aria-hidden className="text-status-success" />;
    case "failed":
      return <CircleAlert size={14} aria-hidden className="text-status-error" />;
    case "running":
      return <Loader2 size={14} aria-hidden className="animate-spin text-accent" />;
    case "cancelled":
      return <X size={14} aria-hidden className="text-fg-muted" />;
    case "pending":
      return <Clock size={14} aria-hidden className="text-status-warning" />;
  }
}

function statusLabelKey(status: AgentToolCallStatus): string {
  switch (status) {
    case "completed":
      return "externalAgent.toolStatusCompleted";
    case "failed":
      return "externalAgent.toolStatusFailed";
    case "running":
      return "externalAgent.toolStatusRunning";
    case "cancelled":
      return "externalAgent.toolStatusCancelled";
    case "pending":
      return "externalAgent.toolStatusPending";
  }
}

function SectionHeading({
  icon,
  children,
  count,
  action,
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly count?: number;
  readonly action?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="text-accent">{icon}</span>
      <Text type="body" color="primary" className="text-xs font-medium">
        {children}
      </Text>
      {count !== undefined ? (
        <span className="rounded-full bg-bg-3 px-1.5 py-0.5 text-[9px] tabular-nums text-fg-muted">
          {count}
        </span>
      ) : null}
      {action}
    </div>
  );
}

function CapabilityNotice({
  capabilities,
}: {
  readonly capabilities: AgentCapabilityAvailability;
}): JSX.Element | null {
  const { t } = useTranslation();
  const noticeKey = !capabilities.basic
    ? "externalAgent.capabilityBasicUnavailable"
    : !capabilities.streaming
      ? "externalAgent.capabilityStreamingUnavailable"
      : !capabilities.full
        ? "externalAgent.capabilityFullUnavailable"
        : null;
  if (!noticeKey) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-status-warning/30 bg-status-warning/8 px-3 py-2.5">
      <CircleAlert size={14} aria-hidden className="mt-0.5 shrink-0 text-status-warning" />
      <div className="min-w-0">
        <Text type="body" color="primary" className="text-[11px] font-medium">
          {t("externalAgent.capabilityTitle")}
        </Text>
        <Text type="supporting" color="secondary" className="mt-0.5 text-[10px] leading-relaxed">
          {t(noticeKey)}
        </Text>
      </div>
    </div>
  );
}

function ConversationMessage({ message }: { readonly message: AgentMessage }): JSX.Element {
  const { t } = useTranslation();
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[92%] rounded-lg border px-3 py-2 ${
          isUser
            ? "border-accent/30 bg-accent/10 text-fg"
            : "border-border bg-bg-2/70 text-fg-2"
        }`}
      >
        <div className="mb-1 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wide text-fg-muted">
          {isUser ? <MessageSquare size={11} aria-hidden /> : <Bot size={11} aria-hidden />}
          {t(isUser ? "externalAgent.userMessage" : "externalAgent.agentMessage")}
          {message.streaming ? (
            <span className="ml-0.5 inline-flex items-center gap-1 normal-case tracking-normal text-accent">
              <Loader2 size={10} aria-hidden className="animate-spin" />
              {t("externalAgent.streaming")}
            </span>
          ) : null}
        </div>
        <p className="whitespace-pre-wrap text-[11px] leading-relaxed">{message.text}</p>
      </div>
    </div>
  );
}

function ToolCallCard({ tool }: { readonly tool: AgentToolCall }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-border bg-bg-2/60 px-2.5 py-2">
      <div className="flex items-center gap-2">
        {statusIcon(tool.status)}
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-fg">
          {tool.title}
        </span>
        <span className="shrink-0 text-[9px] text-fg-muted">
          {t(statusLabelKey(tool.status))}
        </span>
      </div>
      {tool.detail ? (
        <p className="mt-1 whitespace-pre-wrap text-[10px] leading-relaxed text-fg-muted">
          {tool.detail}
        </p>
      ) : null}
    </div>
  );
}

function ApprovalCard({
  approval,
  onApprove,
  onDeny,
}: {
  readonly approval: AgentApprovalRequest;
  readonly onApprove?: (approvalId: string) => void;
  readonly onDeny?: (approvalId: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const pending = approval.status === "pending";
  const statusKey = {
    approved: "externalAgent.approvalStatusApproved",
    denied: "externalAgent.approvalStatusDenied",
    expired: "externalAgent.approvalStatusExpired",
    cancelled: "externalAgent.approvalStatusCancelled",
  } as const;
  return (
    <div className="rounded-lg border border-status-warning/30 bg-status-warning/6 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <ShieldCheck size={15} aria-hidden className="mt-0.5 shrink-0 text-status-warning" />
        <div className="min-w-0 flex-1">
          <Text type="body" color="primary" className="block text-[11px] font-medium">
            {approval.title}
          </Text>
          {approval.description ? (
            <Text type="supporting" color="secondary" className="mt-1 block text-[10px] leading-relaxed">
              {approval.description}
            </Text>
          ) : null}
          {approval.options && approval.options.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {approval.options.map((option) => (
                <span key={option.id} className="rounded border border-border bg-bg-3 px-1.5 py-0.5 text-[9px] text-fg-muted">
                  {option.label}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {!pending ? (
          <span className="text-[9px] text-fg-muted">{t(statusKey[approval.status])}</span>
        ) : null}
      </div>
      {pending ? (
        <div className="mt-2 flex justify-end gap-1.5">
          <Button
            label={t("externalAgent.deny")}
            variant="ghost"
            size="sm"
            onClick={() => onDeny?.(approval.id)}
            isDisabled={!onDeny}
          />
          <Button
            label={t("externalAgent.approve")}
            icon={<Check size={12} aria-hidden />}
            variant="primary"
            size="sm"
            onClick={() => onApprove?.(approval.id)}
            isDisabled={!onApprove}
          />
        </div>
      ) : null}
    </div>
  );
}

function ReferenceChips({
  references,
  onReferenceClick,
}: {
  readonly references: readonly AgentReferenceChip[];
  readonly onReferenceClick?: (reference: AgentReferenceChip) => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      {references.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {references.map((reference) => {
            const timing = formatTiming(reference);
            const label = [reference.label, timing, reference.stale ? t("externalAgent.staleReference") : null]
              .filter(Boolean)
              .join(" · ");
            return (
              <button
                key={reference.number}
                type="button"
                className={`inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-left text-[10px] transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                  reference.stale
                    ? "border-border bg-bg-3 text-fg-muted line-through"
                    : "border-violet-500/30 bg-violet-500/10 text-fg hover:bg-violet-500/20"
                }`}
                aria-label={t("agentReferences.referenceLabel", {
                  number: reference.number,
                  state: reference.stale ? t("agentReferences.staleSuffix") : "",
                })}
                onClick={() => onReferenceClick?.(reference)}
                disabled={!onReferenceClick}
              >
                <span className="rounded bg-violet-500 px-1 font-bold text-white">#{reference.number}</span>
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <Text type="supporting" color="secondary" className="text-[10px] leading-relaxed">
        {t("externalAgent.referenceInsertionHint")}
      </Text>
    </div>
  );
}

function legacyActivitiesFromProps(
  messages: readonly AgentMessage[],
  thinkingSummary: AgentThinkingSummary | null,
  toolCalls: readonly AgentToolCall[],
  approvals: readonly AgentApprovalRequest[],
): AgentActivity[] {
  let sequence = 0;
  const activities: AgentActivity[] = messages.map((message) => ({
    type: message.role === "user" ? "user_message" : "agent_message",
    id: message.id,
    sequence: sequence++,
    text: message.text,
    ...(message.role === "agent" && message.streaming !== undefined
      ? { streaming: message.streaming }
      : {}),
  }));
  if (thinkingSummary?.text) {
    activities.push({
      type: "reasoning_summary",
      id: "thinking",
      sequence: sequence++,
      text: thinkingSummary.text,
    });
  }
  activities.push(
    ...toolCalls.map((tool) => ({
      type: "tool" as const,
      id: tool.id,
      sequence: sequence++,
      phase: "update" as const,
      title: tool.title,
      status: tool.status,
      detail: tool.detail,
    })),
    ...approvals.map((approval) => ({
      type: "approval" as const,
      id: approval.id,
      sequence: sequence++,
      phase: "request" as const,
      title: approval.title,
      description: approval.description,
      options: approval.options,
      status: approval.status,
    })),
  );
  return activities;
}

function formatByteCount(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ReasoningSummaryActivity({ text }: { readonly text: string }): JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-bg-2/45">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-medium text-fg-2 focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronDown size={13} aria-hidden className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
        {t("externalAgent.thinkingTitle")}
        <span className="text-[9px] font-normal text-fg-muted">
          · {t("externalAgent.agentProvidedSummary")}
        </span>
        <span className="ml-auto text-[9px] text-fg-muted">
          {expanded ? t("externalAgent.collapse") : t("externalAgent.expand")}
        </span>
      </button>
      {expanded ? (
        <div className="border-t border-border px-3 py-2.5 text-[10px] leading-relaxed text-fg-muted">
          {text}
        </div>
      ) : null}
    </div>
  );
}

function WorkLog({
  activities,
  onApprove,
  onDeny,
}: {
  readonly activities: readonly AgentActivity[];
  readonly onApprove?: (approvalId: string) => void;
  readonly onDeny?: (approvalId: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <section className="space-y-2" aria-label={t("externalAgent.workLog")}>
      <SectionHeading icon={<Clock size={13} aria-hidden />} count={activities.length}>
        {t("externalAgent.workLog")}
      </SectionHeading>
      {activities.length > 0 ? (
        <ol className="space-y-2">
          {activities.map((activity) => {
            const itemKey = `${activity.type}:${activity.id}`;
            switch (activity.type) {
              case "user_message":
                return (
                  <li key={itemKey}>
                    <ConversationMessage message={{ id: activity.id, role: "user", text: activity.text }} />
                  </li>
                );
              case "agent_message":
                return (
                  <li key={itemKey}>
                    <ConversationMessage
                      message={{
                        id: activity.id,
                        role: "agent",
                        text: activity.text,
                        streaming: activity.streaming,
                      }}
                    />
                  </li>
                );
              case "reasoning_summary":
                return (
                  <li key={itemKey}>
                    <ReasoningSummaryActivity text={activity.text} />
                  </li>
                );
              case "tool":
                return (
                  <li key={itemKey}>
                    <div className="space-y-1">
                      <span className="text-[9px] uppercase tracking-wide text-fg-muted">
                        {t(`externalAgent.toolEvent${activity.phase[0].toUpperCase()}${activity.phase.slice(1)}`)}
                      </span>
                      <ToolCallCard
                        tool={{
                          id: activity.id,
                          title: activity.title || t("externalAgent.unnamedTool"),
                          status: activity.status,
                          detail: activity.detail,
                        }}
                      />
                    </div>
                  </li>
                );
              case "approval":
                return (
                  <li
                    key={itemKey}
                    data-pending-approval={activity.status === "pending" ? "true" : undefined}
                  >
                    <div className="space-y-1">
                      <span className="text-[9px] uppercase tracking-wide text-fg-muted">
                        {t(activity.phase === "request" ? "externalAgent.approvalRequested" : "externalAgent.approvalResolved")}
                      </span>
                      <ApprovalCard
                        approval={{
                          id: activity.id,
                          title: activity.title || t("externalAgent.approvalTitle"),
                          description: activity.description,
                          options: activity.options,
                          status: activity.status,
                        }}
                        onApprove={onApprove}
                        onDeny={onDeny}
                      />
                    </div>
                  </li>
                );
              case "subtask":
                return (
                  <li key={itemKey}>
                    <div className="rounded-md border border-border bg-bg-2/60 px-2.5 py-2">
                      <div className="flex items-center gap-2">
                        <Clock size={14} aria-hidden className="text-fg-muted" />
                        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-fg">
                          {activity.title || t("externalAgent.subtaskTitle")}
                        </span>
                        <span className="shrink-0 text-[9px] text-fg-muted">
                          {t(`externalAgent.subtaskStatus${activity.status[0].toUpperCase()}${activity.status.slice(1)}`)}
                        </span>
                      </div>
                      {activity.detail ? <p className="mt-1 whitespace-pre-wrap text-[10px] leading-relaxed text-fg-muted">{activity.detail}</p> : null}
                    </div>
                  </li>
                );
              case "artifact":
                return (
                  <li key={itemKey}>
                    <div className="rounded-md border border-border bg-bg-2/60 px-2.5 py-2">
                      <div className="flex items-center gap-2">
                        <Check size={14} aria-hidden className="text-accent" />
                        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-fg">{activity.label || t("externalAgent.artifactTitle")}</span>
                        <span className="shrink-0 text-[9px] text-fg-muted">
                          {t(`externalAgent.artifactStatus${activity.status[0].toUpperCase()}${activity.status.slice(1)}`)}
                        </span>
                      </div>
                      {activity.sizeBytes !== undefined ? (
                        <p className="mt-1 text-[10px] text-fg-muted">{formatByteCount(activity.sizeBytes)}</p>
                      ) : null}
                    </div>
                  </li>
                );
              case "plan":
                return (
                  <li key={itemKey}>
                    <div className="rounded-md border border-border bg-bg-2/60 px-2.5 py-2">
                      <div className="mb-1 text-[10px] font-medium text-fg">{t("externalAgent.planTitle")}</div>
                      {activity.entries.length > 0 ? (
                        <ol className="list-decimal space-y-1 pl-4 text-[10px] leading-relaxed text-fg-muted">
                          {activity.entries.map((entry, index) => <li key={`${itemKey}:${index}`}>{entry.content}</li>)}
                        </ol>
                      ) : <span className="text-[10px] text-fg-muted">{t("externalAgent.planEmpty")}</span>}
                    </div>
                  </li>
                );
              case "usage":
                return (
                  <li key={itemKey}>
                    <div className="rounded-md border border-border bg-bg-2/60 px-2.5 py-2 text-[10px] text-fg-muted">
                      <div className="mb-1 font-medium text-fg">{t("externalAgent.usageTitle")}</div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {activity.inputTokens !== undefined ? <span>{t("externalAgent.usageInput", { count: activity.inputTokens })}</span> : null}
                        {activity.outputTokens !== undefined ? <span>{t("externalAgent.usageOutput", { count: activity.outputTokens })}</span> : null}
                        {activity.totalTokens !== undefined ? <span>{t("externalAgent.usageTotal", { count: activity.totalTokens })}</span> : null}
                      </div>
                    </div>
                  </li>
                );
              case "state":
                return (
                  <li key={itemKey}>
                    <div className="rounded-md border border-border bg-bg-2/60 px-2.5 py-2">
                      <div className="flex items-center gap-2 text-[10px] text-fg-muted">
                        <CircleCheck size={14} aria-hidden className="text-accent" />
                        <span className="font-medium text-fg">{t("externalAgent.stateTitle")}</span>
                        <span>{t(`externalAgent.state${activity.state[0].toUpperCase()}${activity.state.slice(1)}`)}</span>
                      </div>
                      {activity.detail ? <p className="mt-1 whitespace-pre-wrap text-[10px] leading-relaxed text-fg-muted">{activity.detail}</p> : null}
                    </div>
                  </li>
                );
            }
          })}
        </ol>
      ) : (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center">
          <MessageSquare size={17} aria-hidden className="mx-auto mb-1.5 text-fg-muted" />
          <Text type="supporting" color="secondary" className="text-[11px] leading-relaxed">
            {t("externalAgent.conversationEmpty")}
          </Text>
        </div>
      )}
    </section>
  );
}

/**
 * Presentational shell for an externally owned Agent conversation.
 *
 * The panel intentionally has no store, transport, IPC, clipboard, or
 * persistence dependency. A host injects an ephemeral view model and action
 * callbacks; the external Agent remains the owner of conversation history.
 */
export function ExternalAgentPanel({
  viewModel,
  connection: connectionProp = DEFAULT_CONNECTION,
  messages: messagesProp = [],
  thinkingSummary: thinkingSummaryProp = null,
  toolCalls: toolCallsProp = [],
  approvals: approvalsProp = [],
  references: referencesProp = [],
  capabilities: capabilitiesProp = DEFAULT_CAPABILITIES,
  onClose,
  onConnect,
  onDisconnect,
  onCancel,
  onSend,
  onApprove,
  onDeny,
  onCopyReferences,
  onReferenceClick,
  cancelling = false,
  copyingReferences = false,
  sending = false,
}: ExternalAgentPanelProps): JSX.Element {
  const { t } = useTranslation();
  const connection = viewModel?.connection ?? connectionProp;
  const messages = viewModel?.messages ?? messagesProp;
  const thinkingSummary = viewModel?.thinkingSummary ?? thinkingSummaryProp;
  const toolCalls = viewModel?.toolCalls ?? toolCallsProp;
  const approvals = viewModel?.approvals ?? approvalsProp;
  const activities = viewModel?.activities ?? legacyActivitiesFromProps(messages, thinkingSummary, toolCalls, approvals);
  const references = referencesProp;
  const capabilities = viewModel?.capabilities ?? capabilitiesProp;
  const [draft, setDraft] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottom = useRef(true);
  const statusKey = connectionStatusKey(connection.state);
  const hasStreamingMessage = messages.some((message) => message.streaming);
  const hasRunningTool = toolCalls.some((tool) => tool.status === "running");
  const hasRunningActivity = activities.some(
    (activity) =>
      (activity.type === "state" && activity.state === "working") ||
      (activity.type === "subtask" && activity.status === "running"),
  );
  const canCancel = Boolean(
    onCancel &&
      (connection.state === "connecting" ||
        hasStreamingMessage ||
        hasRunningTool ||
        hasRunningActivity),
  );
  const sortedReferences = useMemo(
    () => [...references].sort((a, b) => a.number - b.number),
    [references],
  );
  const insertReference = (reference: AgentReferenceChip): void => {
    setDraft((current) => {
      const trimmed = current.trimEnd();
      return `${trimmed}${trimmed ? " " : ""}#${reference.number} `;
    });
    onReferenceClick?.(reference);
  };
  const send = async (): Promise<void> => {
    const value = draft.trim();
    if (!value || !onSend || sending || connection.state !== "connected") return;
    shouldStickToBottom.current = true;
    await onSend(value);
    setDraft("");
  };
  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!shouldStickToBottom.current || !panel) return;
    panel.scrollTop = panel.scrollHeight;

    // A decision request takes priority over a later passive state update.
    // Keep the complete approval card visible instead of landing on its buttons.
    const pendingApproval = panel.querySelector<HTMLElement>(
      '[data-pending-approval="true"]',
    );
    if (!pendingApproval) return;
    const approvalTop = pendingApproval.getBoundingClientRect().top;
    const panelTop = panel.getBoundingClientRect().top;
    if (approvalTop < panelTop + 8) {
      panel.scrollTop = Math.max(0, panel.scrollTop + approvalTop - panelTop - 8);
    }
  }, [activities, connection.state]);
  const handlePanelScroll = (): void => {
    const panel = panelRef.current;
    if (!panel) return;
    shouldStickToBottom.current = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 48;
  };

  return (
    <div className="flex h-full flex-col bg-bg-1">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Bot size={15} className="shrink-0 text-accent" aria-hidden />
        <span className="text-[13px] font-medium text-fg">{t("externalAgent.title")}</span>
        {connection.agentName ? (
          <span className="max-w-[150px] truncate text-[10px] text-fg-muted">· {connection.agentName}</span>
        ) : null}
        {onClose ? (
          <IconButton
            label={t("common.close")}
            icon={<X size={14} aria-hidden />}
            size="sm"
            variant="ghost"
            onClick={onClose}
            className="ml-auto grid h-7 w-7 place-items-center rounded-md text-fg-2 hover:bg-hover hover:text-fg"
          />
        ) : null}
      </header>

      <div
        ref={panelRef}
        onScroll={handlePanelScroll}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
      >
        <section className="rounded-lg border border-border bg-bg-2/60 p-3">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                connection.state === "connected"
                  ? "bg-status-success"
                  : connection.state === "error" || connection.state === "unsupported"
                    ? "bg-status-error"
                    : connection.state === "connecting"
                      ? "bg-status-warning"
                      : "bg-fg-muted"
              }`}
            />
            <Text type="body" color="primary" className="text-xs font-medium">
              {t(statusKey)}
            </Text>
          </div>
          {connection.detail ? (
            <Text type="supporting" color="secondary" className="mt-1 text-[10px] leading-relaxed">
              {connection.detail}
            </Text>
          ) : null}
          {connection.fallback === "mcp-only" ? (
            <Text type="supporting" color="secondary" className="mt-1 text-[10px] leading-relaxed">
              {t("externalAgent.fallbackMcpOnly")}
            </Text>
          ) : null}
          {onConnect && (connection.state === "disconnected" || connection.state === "error") ? (
            <Button
              label={t("externalAgent.connect")}
              icon={<Power size={13} aria-hidden />}
              variant="primary"
              size="sm"
              onClick={onConnect}
              className="mt-3"
            />
          ) : null}
          {onDisconnect && connection.state === "connected" ? (
            <div className="mt-3 space-y-1.5">
              <Button
                label={t("externalAgent.disconnectView")}
                variant="secondary"
                size="sm"
                onClick={onDisconnect}
                className="shrink-0"
              />
              <Text type="supporting" color="secondary" className="block text-[9px] leading-relaxed">
                {t("externalAgent.disconnectViewHint")}
              </Text>
            </div>
          ) : null}
        </section>

        <CapabilityNotice capabilities={capabilities} />

        <WorkLog activities={activities} onApprove={onApprove} onDeny={onDeny} />
      </div>

      <footer className="space-y-2 border-t border-border bg-bg-1 px-3 py-2.5">
        <section className="space-y-1.5">
          <SectionHeading
            icon={<Hash size={13} aria-hidden />}
            count={sortedReferences.length}
            action={sortedReferences.length > 0 && onCopyReferences ? (
              <Button
                label={t("externalAgent.copyReferences")}
                icon={<Copy size={12} aria-hidden />}
                variant="ghost"
                size="sm"
                isLoading={copyingReferences}
                onClick={onCopyReferences}
                className="ml-auto"
              />
            ) : undefined}
          >
            {t("externalAgent.referencesTitle")}
          </SectionHeading>
          <div className="max-h-24 overflow-y-auto pr-1">
            <ReferenceChips references={sortedReferences} onReferenceClick={insertReference} />
          </div>
        </section>

        {canCancel ? (
          <Button
            label={cancelling ? t("externalAgent.cancelling") : t("externalAgent.cancel")}
            icon={<X size={13} aria-hidden />}
            variant="secondary"
            size="sm"
            isLoading={cancelling}
            onClick={onCancel}
            className="w-full"
          />
        ) : null}
        <div className="relative rounded-lg border border-border bg-bg-2/70 focus-within:border-accent/60 focus-within:ring-1 focus-within:ring-accent/20">
          <textarea
            value={draft}
            rows={3}
            maxLength={32_000}
            disabled={connection.state !== "connected" || !onSend}
            aria-label={t("externalAgent.composerLabel")}
            placeholder={
              connection.state === "connected"
                ? t("externalAgent.composerPlaceholder")
                : t("externalAgent.composerDisconnected")
            }
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={handleComposerKeyDown}
            className="block min-h-[66px] w-full resize-none bg-transparent px-2.5 pb-8 pt-2 text-[11px] leading-relaxed text-fg outline-none placeholder:text-fg-muted disabled:cursor-not-allowed disabled:opacity-60"
          />
          <div className="absolute inset-x-2 bottom-1.5 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[9px] text-fg-muted">
              {t("externalAgent.composerHint")}
            </span>
            <IconButton
              label={t("externalAgent.send")}
              icon={sending ? <Loader2 size={13} aria-hidden className="animate-spin" /> : <Send size={13} aria-hidden />}
              size="sm"
              variant="primary"
              onClick={() => void send()}
              isDisabled={!draft.trim() || !onSend || sending || connection.state !== "connected"}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md"
            />
          </div>
        </div>
        <p className="text-[9px] leading-relaxed text-fg-muted">
          {t("externalAgent.connectorNote")}
        </p>
      </footer>
    </div>
  );
}

export default ExternalAgentPanel;
