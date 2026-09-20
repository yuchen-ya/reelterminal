/**
 * Connection-setup wiring for the agent-media-task dialog.
 *
 * The dialog renders the same AgentConnectionGuide the Agent panel uses, so
 * "no Agent yet" is answered in place instead of sending the user hunting
 * for another panel. This hook mirrors the panel container's setup flow
 * (inspect → connect → attach) against the desktop conversation API; the
 * state event listener installs harmlessly alongside the panel's own.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useCollabStore } from "../../../stores/collab-store";
import {
  installExternalConversationEventListener,
  useExternalConversationStore,
} from "../../../stores/external-conversation-store";
import type {
  OpenReelConversationSetupProvider,
  OpenReelConversationSetupState,
} from "../../../types/global";

export interface AgentConnectionSetup {
  /** True when the host exposes the desktop conversation API at all. */
  readonly conversationApiAvailable: boolean;
  /** Conversation lifecycle readiness from the shared store. */
  readonly ready: boolean;
  readonly setup: OpenReelConversationSetupState | null;
  readonly provider: OpenReelConversationSetupProvider;
  readonly selectedThread: string;
  readonly collabEnabled: boolean;
  readonly busy: boolean;
  readonly failed: boolean;
  readonly refresh: () => Promise<void>;
  readonly connect: () => Promise<void>;
  readonly onProviderChange: (provider: OpenReelConversationSetupProvider) => void;
  readonly onSelectThread: (threadId: string) => void;
}

export function useAgentConnectionSetup(): AgentConnectionSetup {
  const conversationApiAvailable =
    typeof window !== "undefined" && Boolean(window.reelterminal?.conversation);
  const ready = useExternalConversationStore(
    (value) => value.state.conversation.lifecycle === "ready",
  );
  const initialize = useExternalConversationStore((value) => value.initialize);
  const attach = useExternalConversationStore((value) => value.attach);
  const collabEnabled = useCollabStore((value) => value.enabled);
  const enableCollab = useCollabStore((value) => value.enable);

  const [setup, setSetup] = useState<OpenReelConversationSetupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [provider, setProvider] = useState<OpenReelConversationSetupProvider>("codex");
  const [selectedThread, setSelectedThread] = useState("new");
  const setupInitialized = useRef(false);

  const applySetup = useCallback((next: OpenReelConversationSetupState) => {
    setSetup(next);
    setSelectedThread((current) => {
      if (current !== "new" && next.threads.some((thread) => thread.id === current)) {
        return current;
      }
      if (
        next.managedSessionId &&
        next.threads.some((thread) => thread.id === next.managedSessionId)
      ) {
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

  const refresh = useCallback(async () => {
    const api = window.reelterminal?.conversation;
    if (!api?.inspectSetup) return;
    setBusy(true);
    setFailed(false);
    try {
      applySetup(await api.inspectSetup());
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [applySetup]);

  const connect = useCallback(async () => {
    const api = window.reelterminal?.conversation;
    if (!api?.startSetup) return;
    setBusy(true);
    setFailed(false);
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
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [applySetup, attach, enableCollab, provider, selectedThread]);

  useEffect(() => {
    if (!conversationApiAvailable) return undefined;
    const off = installExternalConversationEventListener();
    void initialize().catch(() => undefined);
    return off;
  }, [conversationApiAvailable, initialize]);

  useEffect(() => {
    if (!conversationApiAvailable || ready) return;
    void refresh();
  }, [conversationApiAvailable, ready, refresh]);

  return {
    conversationApiAvailable,
    ready,
    setup,
    provider,
    selectedThread,
    collabEnabled,
    busy,
    failed,
    refresh,
    connect,
    onProviderChange: setProvider,
    onSelectThread: setSelectedThread,
  };
}
