import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
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
import { AgentConnectionGuide } from "./AgentConnectionGuide";
import type {
  OpenReelConversationSetupProvider,
  OpenReelConversationSetupState,
} from "../../../types/global";

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
  // Capability, not platform sniffing: the desktop preload injects
  // window.reelterminal.conversation; a plain browser never has it. Without it
  // there is nothing to listen to, initialize, or inspect, so the panel skips
  // those calls and the guide explains the desktop requirement instead of
  // spinning in its "checking" state forever.
  const conversationApiAvailable =
    typeof window !== "undefined" && Boolean(window.reelterminal?.conversation);
  const [setup, setSetup] = useState<OpenReelConversationSetupState | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupFailed, setSetupFailed] = useState(false);
  const [provider, setProvider] = useState<OpenReelConversationSetupProvider>("codex");
  const [selectedThread, setSelectedThread] = useState("new");
  const setupInitialized = useRef(false);

  const applySetup = useCallback((next: OpenReelConversationSetupState) => {
    setSetup(next);
    setSelectedThread((current) => {
      if (current !== "new" && next.threads.some((thread) => thread.id === current)) {
        return current;
      }
      if (next.managedSessionId && next.threads.some((thread) => thread.id === next.managedSessionId)) {
        return next.managedSessionId;
      }
      return next.threads[0]?.id ?? "new";
    });
    if (!setupInitialized.current) {
      setupInitialized.current = true;
      if (next.externalAdapter.state === "ready" && !next.managedSessionId) {
        setProvider("external");
      }
    }
  }, []);

  const refreshSetup = useCallback(async () => {
    const api = window.reelterminal?.conversation;
    if (!api?.inspectSetup) return;
    setSetupBusy(true);
    setSetupFailed(false);
    try {
      applySetup(await api.inspectSetup());
    } catch {
      setSetupFailed(true);
    } finally {
      setSetupBusy(false);
    }
  }, [applySetup]);

  useEffect(() => {
    if (!conversationApiAvailable) return undefined;
    const off = installExternalConversationEventListener();
    void initialize().catch(() => undefined);
    return off;
  }, [conversationApiAvailable, initialize]);

  useEffect(() => {
    if (!conversationApiAvailable) return;
    void refreshSetup();
  }, [conversationApiAvailable, refreshSetup]);

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
    const api = window.reelterminal?.conversation;
    if (!api?.startSetup) return;
    setSetupBusy(true);
    setSetupFailed(false);
    try {
      if (!useCollabStore.getState().enabled) {
        await enableCollab();
      }
      if (!useCollabStore.getState().enabled) {
        throw new Error("Agent Session did not start");
      }
      const next = await api.startSetup(
        provider === "external"
          ? { provider }
          : selectedThread === "new"
            ? { provider, createThread: true }
            : { provider, threadId: selectedThread },
      );
      applySetup(next);
      await attach();
    } catch {
      setSetupFailed(true);
    } finally {
      setSetupBusy(false);
    }
  };

  return (
    <ExternalAgentPanel
      viewModel={viewModel}
      references={references}
      onClose={onClose}
      hideHeader={hideHeader}
      connectionGuide={
        <AgentConnectionGuide
          provider={provider}
          setup={setup}
          selectedThread={selectedThread}
          collabEnabled={collabEnabled}
          busy={setupBusy || busy}
          error={setupFailed}
          desktopUnavailable={!conversationApiAvailable}
          onProviderChange={setProvider}
          onSelectThread={setSelectedThread}
          onRefresh={() => void refreshSetup()}
          onConnect={() => void connect()}
        />
      }
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
