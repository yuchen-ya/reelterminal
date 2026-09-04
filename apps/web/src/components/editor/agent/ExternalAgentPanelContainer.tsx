import { useEffect, useMemo, type JSX } from "react";
import { useTranslation } from "react-i18next";
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
  readonly hideHeader?: ExternalAgentPanelProps["hideHeader"];
}

export function ExternalAgentPanelContainer({
  onClose,
  hideHeader,
}: ExternalAgentPanelContainerProps): JSX.Element {
  const { t } = useTranslation();
  const state = useExternalConversationStore((value) => value.state);
  const busy = useExternalConversationStore((value) => value.busy);
  const sending = useExternalConversationStore((value) => value.sending);
  const cancelling = useExternalConversationStore((value) => value.cancelling);
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

  return (
    <ExternalAgentPanel
      viewModel={viewModel}
      references={references}
      onClose={onClose}
      hideHeader={hideHeader}
      onConnect={busy ? undefined : () => void connect().catch(() => undefined)}
      onDisconnect={busy ? undefined : () => void detach().catch(() => undefined)}
      onSend={(text) => prompt(text)}
      onApprove={busy ? undefined : (requestId) =>
        void resolveApproval(requestId, "approved").catch(() => undefined)}
      onDeny={busy ? undefined : (requestId) =>
        void resolveApproval(requestId, "denied").catch(() => undefined)}
      onCancel={cancelling ? undefined : () => void cancel().catch(() => undefined)}
      sending={sending}
      cancelling={cancelling}
    />
  );
}

export default ExternalAgentPanelContainer;
