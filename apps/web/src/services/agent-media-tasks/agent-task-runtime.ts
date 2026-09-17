/**
 * App-level runtime for the agent media task ledger. One installation per
 * renderer session, independent of which panels are open:
 *
 *  - installs the real recommended-root source for task submissions
 *    (desktop media-roots channel), so the precast artifact directory
 *    matches what the external Agent is told;
 *  - subscribes the receipt correlator to the conversation display stream,
 *    so a RESULT/ERROR receipt advances its task the moment it arrives;
 *  - runs restart recovery once, then keeps reconciling awaiting-import
 *    targets against the real project index as the ledger changes.
 */

import { useProjectStore } from "../../stores/project-store";
import { useExternalConversationStore } from "../../stores/external-conversation-store";
import {
  subscribeAgentMediaTasks,
  getAgentMediaTaskService,
} from "./agent-media-task-service";
import { createReceiptCorrelator } from "./receipt-correlator";
import type { ReceiptCorrelator, ConversationEventLike } from "./receipt-correlator";
import {
  recoverInterruptedTasks,
  reconcileAwaitingImportTargets,
  type AgentTaskRuntimeDeps,
} from "./task-import";
import { createDesktopRecommendedRootResolver } from "./desktop-channel";
import { setRecommendedRootResolver } from "../../components/editor/dialogs/agent-media-task-submit";

function conversationUpdates(): readonly ConversationEventLike[] {
  const updates =
    useExternalConversationStore.getState().state.conversation.updates;
  return updates as readonly ConversationEventLike[];
}

function runtimeDeps(): AgentTaskRuntimeDeps {
  return {
    service: getAgentMediaTaskService(),
    getCurrentProjectId: () => {
      const state = useProjectStore.getState();
      return state.hasOpenProject ? state.project.id : null;
    },
  };
}

let installed = false;
let correlator: ReceiptCorrelator | null = null;

/** Test seam: force re-installation on the next call. */
export function resetAgentTaskRuntimeForTests(): void {
  installed = false;
  correlator = null;
}

/**
 * Install everything once. Idempotent; returns a teardown that also clears
 * the installation (used by tests, and harmless in app code).
 */
export function installAgentTaskRuntime(): () => void {
  const desktopResolver = createDesktopRecommendedRootResolver();
  if (desktopResolver) setRecommendedRootResolver(desktopResolver);

  if (installed && correlator) return () => undefined;
  installed = true;

  const deps = runtimeDeps();
  const watcher = createReceiptCorrelator({
    ...deps,
    getUpdates: conversationUpdates,
  });
  correlator = watcher;
  watcher.start();

  const unsubscribeStore = useExternalConversationStore.subscribe(() => {
    void watcher.poll().catch(() => undefined);
  });

  const unsubscribeLedger = subscribeAgentMediaTasks(() => {
    void reconcileAwaitingImportTargets(deps).catch(() => undefined);
  });

  // Only records created before this moment belong to a previous session;
  // recovery must never touch a task the running session just submitted.
  const createdBefore = new Date().toISOString();
  void recoverInterruptedTasks(deps, createdBefore)
    .then(() => reconcileAwaitingImportTargets(deps))
    .catch(() => undefined);

  return () => {
    unsubscribeStore();
    unsubscribeLedger();
    installed = false;
    correlator = null;
  };
}
