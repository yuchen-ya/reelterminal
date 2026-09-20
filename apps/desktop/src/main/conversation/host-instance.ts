import { app, BrowserWindow } from "electron";
import path from "node:path";
import { CHANNELS } from "../../shared/channels";
import { readEnvAlias } from "../../shared/env-alias";
import {
  canonicalEndpointPath,
  resolveEndpointReadPath,
  type EndpointPathResolution,
} from "../../shared/endpoint-paths";
import {
  createConversationHost,
  type ConversationHost,
} from "./conversation-host";
import { createConversationVisualStateStore } from "./visual-state-store";
import { getAgentModePreferenceStore } from "../live/work-mode-instance";
import { agentWorkspaceRoot } from "../live/host-instance";
import {
  createCodexOnboardingHost,
  type CodexOnboardingHost,
} from "./codex-onboarding";

let host: ConversationHost | null = null;
let unsubscribeWorkMode: (() => void) | null = null;
let onboardingHost: CodexOnboardingHost | null = null;

/**
 * The descriptor path this process PUBLISHES to the adapter (and the
 * default the adapter is handed): an explicit absolute override wins,
 * otherwise the canonical ~/.reelterminal path. No legacy discovery here —
 * writes never go to the legacy directory.
 */
export function conversationEndpointFilePath(): string {
  const override = readEnvAlias(
    process.env,
    "REELTERMINAL_CONVERSATION_ENDPOINT_FILE",
    "OPENREEL_CONVERSATION_ENDPOINT_FILE",
  );
  return override && path.isAbsolute(override)
    ? override
    : canonicalEndpointPath(app.getPath("home"), "conversation-endpoint");
}

/**
 * Read-side resolution for the conversation panel: override → canonical →
 * legacy compat discovery (owned descriptors only). A foreign product at
 * the legacy path surfaces as `conflict` instead of a silent choice.
 */
export function conversationEndpointReadFilePath(): EndpointPathResolution {
  return resolveEndpointReadPath("conversation-endpoint", {
    env: process.env,
    home: app.getPath("home"),
  });
}

export function conversationVisualStateRoot(): string {
  const override = readEnvAlias(
    process.env,
    "REELTERMINAL_CONVERSATION_VISUAL_STATE_ROOT",
    "OPENREEL_CONVERSATION_VISUAL_STATE_ROOT",
  );
  return override && path.isAbsolute(override)
    ? override
    : canonicalEndpointPath(app.getPath("home"), "conversation-visual-state");
}

export function liveMcpConnectorPath(): string {
  const override = readEnvAlias(
    process.env,
    "REELTERMINAL_LIVE_MCP_CONNECTOR",
    "OPENREEL_LIVE_MCP_CONNECTOR",
  );
  return override && path.isAbsolute(override)
    ? override
    : path.join(__dirname, "../live-mcp/index.js");
}

function emitToEditor(payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    const contents = win.webContents;
    if (
      !contents.isDestroyed() &&
      contents.getURL().startsWith("app://reelterminal/")
    ) {
      contents.send(CHANNELS.conversationEvent, payload);
    }
  }
}

export function getConversationHost(): ConversationHost {
  if (!host) {
    const preferences = getAgentModePreferenceStore();
    host = createConversationHost({
      descriptorFilePath: conversationEndpointFilePath(),
      resolveReadDescriptorPath: conversationEndpointReadFilePath,
      emitEvent: emitToEditor,
      getWorkMode: () => preferences.get().workMode,
      visualStateStore: createConversationVisualStateStore(
        conversationVisualStateRoot(),
      ),
    });
    const current = host;
    unsubscribeWorkMode = preferences.subscribe(() => {
      void current.workModeChanged().catch(() => undefined);
    });
  }
  return host;
}

export function getCodexOnboardingHost(): CodexOnboardingHost {
  if (!onboardingHost) {
    const configuredWorkspace = readEnvAlias(
      process.env,
      "REELTERMINAL_AGENT_WORKSPACE_ROOT",
      "OPENREEL_AGENT_WORKSPACE_ROOT",
    );
    const workspace = configuredWorkspace && path.isAbsolute(configuredWorkspace)
      ? configuredWorkspace
      : agentWorkspaceRoot();
    onboardingHost = createCodexOnboardingHost({
      descriptorFilePath: conversationEndpointFilePath(),
      resolveReadDescriptorPath: conversationEndpointReadFilePath,
      visualStateRoot: conversationVisualStateRoot(),
      liveMcpConnector: liveMcpConnectorPath(),
      newThreadCwd: workspace,
    });
  }
  return onboardingHost;
}

export async function disposeConversationHost(): Promise<void> {
  const current = host;
  host = null;
  unsubscribeWorkMode?.();
  unsubscribeWorkMode = null;
  const currentOnboarding = onboardingHost;
  onboardingHost = null;
  await Promise.all([
    current?.dispose().catch(() => undefined),
    currentOnboarding?.dispose().catch(() => undefined),
  ]);
}
