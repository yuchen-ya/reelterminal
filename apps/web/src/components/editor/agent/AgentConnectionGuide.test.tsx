import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OpenReelConversationSetupCheck } from "../../../types/global";
import { AgentConnectionGuide } from "./AgentConnectionGuide";

const readySetup = {
  codex: { state: "ready" as const, code: "codex-ready" },
  authentication: { state: "ready" as const, code: "auth-ready" },
  liveConnector: { state: "ready" as const, code: "connector-ready" },
  externalAdapter: { state: "missing" as const, code: "adapter-missing" },
  threads: [{
    id: "thr_1",
    title: "Launch video polish",
    preview: "Tighten the opening sequence",
    updatedAt: 1_725_000_000,
    active: true,
  }],
  managedSessionId: null,
};

describe("AgentConnectionGuide", () => {
  it("shows verified prerequisites and lets the user choose a real Codex conversation", () => {
    const onSelectThread = vi.fn();
    const onConnect = vi.fn();
    render(
      <AgentConnectionGuide
        provider="codex"
        setup={readySetup}
        selectedThread="thr_1"
        collabEnabled
        busy={false}
        error={false}
        onProviderChange={vi.fn()}
        onSelectThread={onSelectThread}
        onRefresh={vi.fn()}
        onConnect={onConnect}
      />,
    );

    expect(screen.getByText("Codex is installed and its App Server is responding.")).toBeInTheDocument();
    expect(screen.getByText("Launch video polish")).toBeInTheDocument();
    expect(screen.getByText("Tighten the opening sequence")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /New Codex conversation/ }));
    expect(onSelectThread).toHaveBeenCalledWith("new");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it("keeps connect disabled and gives a repair action when Codex is missing", () => {
    const onRefresh = vi.fn();
    render(
      <AgentConnectionGuide
        provider="codex"
        setup={{
          ...readySetup,
          codex: { state: "missing", code: "codex-missing" },
          authentication: { state: "missing", code: "auth-unknown" },
          threads: [],
        }}
        selectedThread="new"
        collabEnabled={false}
        busy={false}
        error
        onProviderChange={vi.fn()}
        onSelectThread={vi.fn()}
        onRefresh={onRefresh}
        onConnect={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "Codex was not found. Install the Codex CLI (winget install OpenAI.Codex or npm i -g @openai/codex), or point OPENREEL_CODEX_COMMAND at the command, then check again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Check connection requirements again" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("maps each new Codex failure class to its repair guidance and appends sanitized detail", () => {
    const baseSetup = {
      ...readySetup,
      authentication: { state: "missing" as const, code: "auth-unknown" },
      threads: [],
    };
    const renderWithCodexCheck = (
      codexCheck: OpenReelConversationSetupCheck,
    ) =>
      render(
        <AgentConnectionGuide
          provider="codex"
          setup={{ ...baseSetup, codex: codexCheck }}
          selectedThread="new"
          collabEnabled
          busy={false}
          error={false}
          onProviderChange={vi.fn()}
          onSelectThread={vi.fn()}
          onRefresh={vi.fn()}
          onConnect={vi.fn()}
        />,
      );

    // Installed but the App Server cannot launch: upgrade guidance plus the
    // sanitized stderr summary keeps the failure diagnosable.
    const launchFailed = renderWithCodexCheck({
      state: "error",
      code: "codex-launch-failed",
      detail: "unexpected argument '--stdio' found",
    });
    expect(
      launchFailed.getByText(
        "Codex was found, but ReelTerminal could not launch its App Server. Upgrade the Codex CLI to the latest version (npm i -g @openai/codex), then check again. (unexpected argument '--stdio' found)",
      ),
    ).toBeInTheDocument();
    launchFailed.unmount();

    // Launched but protocol-incompatible: its own guidance, no detail.
    const protocolError = renderWithCodexCheck({
      state: "error",
      code: "codex-protocol-error",
    });
    expect(
      protocolError.getByText(
        "Codex started, but the App Server protocol is incompatible. Upgrade the Codex CLI to the latest version, then check again.",
      ),
    ).toBeInTheDocument();
    protocolError.unmount();

    // Unknown codes still get the generic unavailable fallback.
    const fallback = renderWithCodexCheck({
      state: "error",
      code: "codex-something-new",
    });
    expect(
      fallback.getByText(
        "Codex failed to start or communicate for an unknown reason. Upgrade the Codex CLI, then check again.",
      ),
    ).toBeInTheDocument();
  });

  it("prioritizes a compatible adapter without asking ReelTerminal to create a session", () => {
    const onProviderChange = vi.fn();
    render(
      <AgentConnectionGuide
        provider="external"
        setup={{
          ...readySetup,
          externalAdapter: { state: "ready", code: "adapter-ready" },
        }}
        selectedThread="new"
        collabEnabled
        busy={false}
        error={false}
        onProviderChange={onProviderChange}
        onSelectThread={vi.fn()}
        onRefresh={vi.fn()}
        onConnect={vi.fn()}
      />,
    );

    expect(screen.getByText(/running external Agent session was found/)).toBeInTheDocument();
    expect(screen.queryByText("New Codex conversation")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    expect(onProviderChange).toHaveBeenCalledWith("codex");
  });

  it("explains the desktop requirement instead of checking forever when no desktop conversation API exists", () => {
    render(
      <AgentConnectionGuide
        provider="codex"
        setup={null}
        selectedThread="new"
        collabEnabled={false}
        busy={false}
        error={false}
        desktopUnavailable
        onProviderChange={vi.fn()}
        onSelectThread={vi.fn()}
        onRefresh={vi.fn()}
        onConnect={vi.fn()}
      />,
    );

    expect(screen.getByTestId("desktop-required-notice")).toBeInTheDocument();
    expect(screen.getByText(/Agent sessions run in the ReelTerminal desktop app/)).toBeInTheDocument();
    expect(screen.queryByText(/Checking this computer/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Check connection requirements again" }),
    ).toBeDisabled();
    expect(screen.queryByRole("tab", { name: "Codex" })).not.toBeInTheDocument();
  });

  it("keeps the real requirement checks when the desktop conversation API is available", () => {
    render(
      <AgentConnectionGuide
        provider="codex"
        setup={readySetup}
        selectedThread="thr_1"
        collabEnabled
        busy={false}
        error={false}
        onProviderChange={vi.fn()}
        onSelectThread={vi.fn()}
        onRefresh={vi.fn()}
        onConnect={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("desktop-required-notice")).not.toBeInTheDocument();
    expect(screen.getByText("Codex is installed and its App Server is responding.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
  });
});
