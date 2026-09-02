import { useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "../../../stores/notification-store";
import { useCollabStore } from "../../../stores/collab-store";
import { useAgentReferencesStore } from "../../../stores/agent-references-store";
import {
  installExternalConversationEventListener,
  useExternalConversationStore,
} from "../../../stores/external-conversation-store";
import { conversationViewModelFromProtocol } from "./AgentViewModel";
import {
  ExternalAgentPanel,
  type ExternalAgentPanelProps,
} from "./ExternalAgentPanel";

export interface ExternalAgentPanelContainerProps {
  readonly onClose?: ExternalAgentPanelProps["onClose"];
}

export function ExternalAgentPanelContainer({
  onClose,
}: ExternalAgentPanelContainerProps): JSX.Element {
  const { t } = useTranslation();
  const state = useExternalConversationStore((value) => value.state);
  const busy = useExternalConversationStore((value) => value.busy);
  const error = useExternalConversationStore((value) => value.error);
  const initialize = useExternalConversationStore((value) => value.initialize);
  const attach = useExternalConversationStore((value) => value.attach);
  const prompt = useExternalConversationStore((value) => value.prompt);
  const resolveApproval = useExternalConversationStore(
    (value) => value.resolveApproval,
  );
  const cancel = useExternalConversationStore((value) => value.cancel);
  const detach = useExternalConversationStore((value) => value.detach);
  const collabEnabled = useCollabStore((value) => value.enabled);
  const enableCollab = useCollabStore((value) => value.enable);
  const referencesByNumber = useAgentReferencesStore((value) => value.references);
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    const off = installExternalConversationEventListener();
    void initialize().catch(() => undefined);
    return off;
  }, [initialize]);

  const viewModel = useMemo(() => {
    const projected = conversationViewModelFromProtocol(state.conversation);
    const localizedDetail = error
      ? t("externalAgent.connectionFailed")
      : state.adapter.availability === "missing"
        ? t("externalAgent.adapterMissing")
        : state.adapter.availability === "invalid"
          ? t("externalAgent.adapterInvalid")
          : state.conversation.lastError
            ? t(`externalAgent.error.${state.conversation.lastError.code}`)
            : undefined;
    return {
      ...projected,
      connection: {
        ...projected.connection,
        agentName: projected.connection.agentName ?? state.adapter.agentLabel ?? undefined,
        detail:
          localizedDetail ?? projected.connection.detail ?? undefined,
      },
      capabilities: {
        ...projected.capabilities,
        level: state.adapter.capabilityLevel ?? undefined,
      },
    };
  }, [error, state, t]);

  const references = useMemo(
    () =>
      Object.values(referencesByNumber)
        .sort((a, b) => a.number - b.number)
        .map((reference) => ({
          number: reference.number,
          label: reference.label,
          kind: reference.kind,
          stale: reference.stale,
          startSeconds: reference.timing.startSeconds,
          endSeconds: reference.timing.endSeconds,
        })),
    [referencesByNumber],
  );

  const connect = async (): Promise<void> => {
    if (!collabEnabled) await enableCollab();
    await attach();
  };

  const copyReferences = async (): Promise<void> => {
    if (references.length === 0) return;
    setCopying(true);
    try {
      const text = references
        .map((reference) => {
          const timing =
            reference.startSeconds == null || reference.endSeconds == null
              ? ""
              : ` ${reference.startSeconds.toFixed(2)}s–${reference.endSeconds.toFixed(2)}s`;
          return `#${reference.number} [${reference.kind ?? "item"}] ${reference.label}${timing}${reference.stale ? ` (${t("externalAgent.staleReference")})` : ""}`;
        })
        .join("\n");
      await navigator.clipboard.writeText(text);
      toast.success(t("externalAgent.referencesCopied"));
    } catch {
      toast.error(t("externalAgent.copyFailed"));
    } finally {
      setCopying(false);
    }
  };

  return (
    <ExternalAgentPanel
      viewModel={viewModel}
      references={references}
      onClose={onClose}
      onConnect={busy ? undefined : () => void connect().catch(() => undefined)}
      onDisconnect={busy ? undefined : () => void detach().catch(() => undefined)}
      onSend={(text) => prompt(text)}
      onApprove={busy ? undefined : (requestId) =>
        void resolveApproval(requestId, "approved").catch(() => undefined)}
      onDeny={busy ? undefined : (requestId) =>
        void resolveApproval(requestId, "denied").catch(() => undefined)}
      onCancel={() => void cancel().catch(() => undefined)}
      onCopyReferences={() => void copyReferences()}
      sending={busy}
      cancelling={busy}
      copyingReferences={copying}
    />
  );
}

export default ExternalAgentPanelContainer;
