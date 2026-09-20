import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversationDisplayState } from "@reelterminal/agent-facade/conversation-state";
import { ExternalAgentPanelContainer } from "./ExternalAgentPanelContainer";

/**
 * Mirrors the preload-injected desktop conversation API closely enough for
 * the container's capability detection and connection-guide flow. This is a
 * desktop-shaped mock for the desktop branch, not a fake browser API.
 */
function mockDesktopConversation() {
  const conversation = {
    getState: vi.fn(async () => ({
      sequence: 0,
      adapter: {
        availability: "missing" as const,
        agentLabel: null,
        adapterName: null,
        sessionId: null,
        capabilityLevel: null,
        message: null,
      },
      conversation: createConversationDisplayState(),
    })),
    attach: vi.fn(),
    prompt: vi.fn(),
    resolveApproval: vi.fn(),
    cancel: vi.fn(),
    detach: vi.fn(),
    onEvent: vi.fn(() => () => undefined),
    inspectSetup: vi.fn(async () => ({
      codex: { state: "ready" as const, code: "codex-ready" },
      authentication: { state: "ready" as const, code: "auth-ready" },
      liveConnector: { state: "ready" as const, code: "connector-ready" },
      externalAdapter: { state: "missing" as const, code: "adapter-missing" },
      threads: [],
      managedSessionId: null,
    })),
    startSetup: vi.fn(),
  };
  (window as { reelterminal?: unknown }).reelterminal = {
    platform: "desktop",
    conversation,
  };
  return conversation;
}

describe("ExternalAgentPanelContainer", () => {
  afterEach(() => {
    delete (window as { reelterminal?: unknown }).reelterminal;
    vi.restoreAllMocks();
  });

  it("explains the desktop requirement instead of checking forever when the browser has no conversation API", async () => {
    render(<ExternalAgentPanelContainer />);

    const notice = await screen.findByTestId("desktop-required-notice");
    expect(notice).toHaveTextContent(
      /Agent sessions run in the ReelTerminal desktop app/,
    );
    expect(screen.queryByText(/Checking this computer/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("keeps the desktop connection flow when the conversation API exists", async () => {
    const conversation = mockDesktopConversation();
    render(<ExternalAgentPanelContainer />);

    expect(
      await screen.findByText(/Codex is installed and its App Server is responding/),
    ).toBeInTheDocument();
    expect(conversation.getState).toHaveBeenCalledOnce();
    expect(conversation.inspectSetup).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("desktop-required-notice")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
  });
});
