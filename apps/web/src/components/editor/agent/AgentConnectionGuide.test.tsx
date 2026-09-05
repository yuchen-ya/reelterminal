import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("keeps connect disabled and gives a repair action when Codex is unavailable", () => {
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

    expect(screen.getByText("Install the Codex app or CLI, then check again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Check connection requirements again" }));
    expect(onRefresh).toHaveBeenCalledOnce();
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
});
