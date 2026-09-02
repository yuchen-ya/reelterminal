import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExternalAgentPanel } from "./ExternalAgentPanel";

describe("ExternalAgentPanel", () => {
  it("renders an injected conversation without owning its data source", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const onCancel = vi.fn();
    const onReferenceClick = vi.fn();

    render(
      <ExternalAgentPanel
        connection={{ state: "connected", agentName: "Remote editor" }}
        capabilities={{ basic: true, streaming: true, full: false }}
        messages={[
          { id: "u1", role: "user", text: "Add a title" },
          { id: "a1", role: "agent", text: "I can do that", streaming: true },
        ]}
        thinkingSummary={{ text: "Preparing a title overlay" }}
        toolCalls={[
          { id: "tool-1", title: "Add title", status: "running", detail: "Editing timeline" },
          { id: "tool-2", title: "Save project", status: "completed" },
        ]}
        approvals={[{
          id: "approval-1",
          title: "Apply the title overlay?",
          description: "The change will update the open project.",
          status: "pending",
        }]}
        references={[{ number: 7, label: "Interview.mov", kind: "video" }]}
        onApprove={onApprove}
        onDeny={onDeny}
        onCancel={onCancel}
        onReferenceClick={onReferenceClick}
      />,
    );

    expect(screen.getByText(/Remote editor/)).toBeInTheDocument();
    expect(screen.getByText("Add a title")).toBeInTheDocument();
    expect(screen.getByText("I can do that")).toBeInTheDocument();
    expect(screen.getByText("Add title")).toBeInTheDocument();
    expect(screen.getByText("Apply the title overlay?")).toBeInTheDocument();
    expect(screen.getByText("Interview.mov")).toBeInTheDocument();
    expect(screen.getByText(/Full conversation features/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: /Reference #7/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onApprove).toHaveBeenCalledWith("approval-1");
    expect(onDeny).toHaveBeenCalledWith("approval-1");
    expect(onReferenceClick).toHaveBeenCalledWith({ number: 7, label: "Interview.mov", kind: "video" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps thinking details collapsed until requested", () => {
    render(
      <ExternalAgentPanel
        capabilities={{ basic: true, streaming: true, full: true }}
        thinkingSummary={{ text: "A private, agent-curated summary" }}
      />,
    );

    expect(screen.queryByText("A private, agent-curated summary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Thinking summary/ }));
    expect(screen.getByText("A private, agent-curated summary")).toBeInTheDocument();
  });

  it("sends composer text to the injected external-session callback", async () => {
    const onSend = vi.fn(async () => undefined);
    render(
      <ExternalAgentPanel
        connection={{ state: "connected", agentName: "Remote editor" }}
        capabilities={{ basic: true, streaming: true, full: true }}
        onSend={onSend}
      />,
    );

    const composer = screen.getByRole("textbox", {
      name: "Message the external Agent",
    });
    fireEvent.change(composer, { target: { value: "Join #2 and #3" } });
    await act(async () => {
      fireEvent.keyDown(composer, { key: "Enter" });
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledWith("Join #2 and #3");
    expect(composer).toHaveValue("");
  });

  it("offers a view-only disconnect without closing the panel", () => {
    const onDisconnect = vi.fn();
    const onClose = vi.fn();
    render(
      <ExternalAgentPanel
        connection={{ state: "connected" }}
        capabilities={{ basic: true, streaming: true, full: true }}
        onDisconnect={onDisconnect}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Disconnect view" }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/Only hides this ReelTerminal view/)).toBeInTheDocument();
  });
});
