import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollabStatusBar } from "./CollabStatusBar";
import { useUIStore } from "../../stores/ui-store";
import { useCollabStore } from "../../stores/collab-store";
import { AGENT_MEDIA_TASK_MODAL_ID } from "../../components/editor/dialogs/AgentMediaTaskDialog";

type TestBridge = {
  readonly platform: "desktop";
  readonly collabControl: {
    enable: () => Promise<unknown>;
    disable: () => Promise<unknown>;
    setAccess: (access: "read-only" | "write") => Promise<unknown>;
    getStatus: () => Promise<unknown>;
    openWorkspace: () => Promise<string>;
  };
};
type OpenReelWindow = { reelterminal?: TestBridge };
const openreelWindow = window as unknown as OpenReelWindow;

function installBridge(
  over: Partial<{
    enabled: boolean;
    access: "read-only" | "write";
    currentAction: string | null;
  }> = {},
) {
  const current = {
    sequence: 1,
    enabled: true,
    externalConnected: false,
    writer: null,
    access: "write" as const,
    currentAction: null,
    ...over,
  };
  const setAccess = vi.fn(async (access: "read-only" | "write") => ({
    ...current,
    sequence: current.sequence + 1,
    access,
  }));
  openreelWindow.reelterminal = {
    platform: "desktop",
    collabControl: {
      enable: vi.fn(async () => current),
      disable: vi.fn(async () => current),
      setAccess,
      getStatus: async () => current,
      openWorkspace: async () => "",
    },
  } as unknown as TestBridge;
  return { setAccess };
}

describe("CollabStatusBar Agent Access status", () => {
  beforeEach(() => {
    delete openreelWindow.reelterminal;
    useUIStore.setState({ activeModal: null });
    useCollabStore.setState({ sequence: 0, enabled: false, access: "write", currentAction: null });
  });

  afterEach(() => {
    delete openreelWindow.reelterminal;
    useUIStore.setState({ activeModal: null });
    useCollabStore.setState({ sequence: 0, enabled: false, access: "write", currentAction: null });
  });

  it("shows CLI availability, read-only access and current operation", async () => {
    installBridge({ enabled: true, access: "read-only", currentAction: "edit.apply" });
    render(<CollabStatusBar />);

    expect(await screen.findByText("CLI available")).toBeInTheDocument();
    expect(screen.getByTestId("agent-access-mode")).toHaveTextContent("Read-only");
    expect(screen.getByTestId("agent-current-action")).toHaveTextContent("edit.apply");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /agent panel/i })).not.toBeInTheDocument();
  });

  it("lets the user switch the command API access mode", async () => {
    const { setAccess } = installBridge({ enabled: true, access: "read-only" });
    render(<CollabStatusBar />);

    fireEvent.click(await screen.findByRole("button", { name: "Enable editing" }));
    await waitFor(() => expect(setAccess).toHaveBeenCalledWith("write"));
  });

  it("shows unavailable status when the local command service is disabled", async () => {
    installBridge({ enabled: false });
    render(<CollabStatusBar />);

    expect(await screen.findByText("CLI unavailable")).toBeInTheDocument();
  });

  it("keeps the local command service switch operable", async () => {
    const { setAccess } = installBridge({ enabled: false });
    const disable = vi.fn();
    const enable = vi.fn(async () => ({
      sequence: 2,
      enabled: true,
      externalConnected: false,
      writer: null,
      access: "write" as const,
      currentAction: null,
    }));
    const bridge = openreelWindow.reelterminal!;
    bridge.collabControl.enable = enable;
    bridge.collabControl.disable = disable;
    render(<CollabStatusBar />);

    fireEvent.click(await screen.findByRole("switch", { name: "Agent Access" }));
    await waitFor(() => expect(enable).toHaveBeenCalledOnce());
    expect(disable).not.toHaveBeenCalled();
    expect(setAccess).not.toHaveBeenCalled();
  });
});

describe("CollabStatusBar task history access", () => {
  afterEach(() => useUIStore.setState({ activeModal: null }));

  it("keeps the stored voiceover/music task ledger reachable", () => {
    render(<CollabStatusBar />);
    fireEvent.click(screen.getByTestId("collab-agent-media-entry"));
    expect(useUIStore.getState().activeModal).toBe(AGENT_MEDIA_TASK_MODAL_ID);
  });
});
