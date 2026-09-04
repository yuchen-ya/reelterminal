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

  it("clears the composer as soon as delivery starts, before the Agent turn finishes", async () => {
    let finish!: () => void;
    const onSend = vi.fn(
      () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    render(
      <ExternalAgentPanel
        connection={{ state: "connected" }}
        capabilities={{ basic: true, streaming: true, full: true }}
        onSend={onSend}
      />,
    );
    const composer = screen.getByRole("textbox", {
      name: "Message the external Agent",
    });
    fireEvent.change(composer, { target: { value: "A long-running edit" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("A long-running edit");
    expect(composer).toHaveValue("");
    await act(async () => finish());
  });

  it("restores a submitted draft when delivery fails", async () => {
    render(
      <ExternalAgentPanel
        connection={{ state: "connected" }}
        capabilities={{ basic: true, streaming: true, full: true }}
        onSend={() => Promise.reject(new Error("offline"))}
      />,
    );
    const composer = screen.getByRole("textbox", {
      name: "Message the external Agent",
    });
    fireEvent.change(composer, { target: { value: "Retry this" } });
    await act(async () => {
      fireEvent.keyDown(composer, { key: "Enter" });
      await Promise.resolve();
    });
    expect(composer).toHaveValue("Retry this");
  });

  it("keeps cancel available before the first streaming update arrives", () => {
    const onCancel = vi.fn();
    render(
      <ExternalAgentPanel
        connection={{ state: "connected", agentName: "Remote editor" }}
        capabilities={{ basic: true, streaming: true, full: true }}
        sending
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
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

  it("keeps numbered references to one compact row and removes visual-inspection controls", () => {
    render(
      <ExternalAgentPanel
        connection={{ state: "connected", agentName: "Remote editor" }}
        capabilities={{ basic: true, streaming: true, full: true }}
        references={[
          { number: 2, label: "Hero shot", kind: "video", startSeconds: 2, endSeconds: 4.5 },
          { number: 3, label: "Room tone", kind: "audio" },
        ]}
      />,
    );
    expect(screen.getByLabelText("Numbered references")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reference #2/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /inspect visuals/i })).not.toBeInTheDocument();
  });

  it("does not reserve footer space when there are no numbered references", () => {
    render(
      <ExternalAgentPanel
        connection={{ state: "disconnected" }}
        capabilities={{ basic: false, streaming: false, full: false }}
      />,
    );
    expect(screen.queryByLabelText("Numbered references")).not.toBeInTheDocument();
    expect(screen.queryByText(/Add a numbered reference first/)).not.toBeInTheDocument();
  });

  it("shows only the latest cumulative usage in the bottom metrics rail", () => {
    render(
      <ExternalAgentPanel
        viewModel={{
          connection: { state: "connected" },
          capabilities: { basic: true, streaming: true, full: true },
          messages: [],
          thinkingSummary: null,
          toolCalls: [],
          approvals: [],
          activities: [
            { type: "user_message", id: "u1", sequence: 1, text: "Edit this" },
            { type: "usage", id: "usage-1", sequence: 2, inputTokens: 500, outputTokens: 20, totalTokens: 520 },
            { type: "agent_message", id: "a1", sequence: 3, text: "Done" },
            { type: "usage", id: "usage-2", sequence: 4, inputTokens: 1_150, outputTokens: 50, totalTokens: 1_200 },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("session-token-total")).toHaveTextContent(
      "1,200 tokens total",
    );
    expect(screen.queryByText("Usage")).not.toBeInTheDocument();
  });

  it("shows visual artifact metadata and blocks an unsafe preview URL", () => {
    render(
      <ExternalAgentPanel
        capabilities={{ basic: true, streaming: true, full: true }}
        resolveArtifactPreview={() => "/Users/macbuke/private/frame.png"}
        viewModel={{
          connection: { state: "connected" },
          capabilities: { basic: true, streaming: true, full: true },
          messages: [],
          thinkingSummary: null,
          toolCalls: [],
          approvals: [],
          activities: [{
            type: "artifact",
            id: "contact-sheet-1",
            sequence: 1,
            label: "Shot review",
            status: "available",
            kind: "contact_sheet",
            mimeType: "image/png",
            preview: {
              previewId: "opaque-preview-1",
              timecodeSeconds: 2.5,
            },
          }],
        }}
      />,
    );

    expect(screen.getByTestId("visual-artifact-card")).toBeInTheDocument();
    expect(screen.getByText("Contact sheet")).toBeInTheDocument();
    expect(screen.getByText("00:00:02.500")).toBeInTheDocument();
    expect(screen.getByText(/A visual handle is available/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("reports a visual preview load failure without exposing a path", () => {
    render(
      <ExternalAgentPanel
        capabilities={{ basic: true, streaming: true, full: true }}
        resolveArtifactPreview={() => "data:image/png;base64,AAAA"}
        viewModel={{
          connection: { state: "connected" },
          capabilities: { basic: true, streaming: true, full: true },
          messages: [],
          thinkingSummary: null,
          toolCalls: [],
          approvals: [],
          activities: [{
            type: "artifact",
            id: "frame-1",
            sequence: 1,
            label: "Frame 1",
            status: "available",
            kind: "image",
            mimeType: "image/png",
            preview: { previewId: "opaque-preview-2", timecodeSeconds: 1.25 },
          }],
        }}
      />,
    );

    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByText(/visual preview could not be loaded/i)).toBeInTheDocument();
  });
});
