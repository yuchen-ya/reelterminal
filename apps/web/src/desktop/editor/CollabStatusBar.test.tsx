import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollabStatusBar } from "./CollabStatusBar";
import { useUIStore } from "../../stores/ui-store";
import { useCollabStore } from "../../stores/collab-store";
import { REQUIREMENT_BOARD_MODAL_ID } from "./RequirementBoardDialog";
import { useProjectStore } from "../../stores/project-store";
import { useNotificationStore } from "../../stores/notification-store";
import { ToastContainer } from "../../components/Toast";

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
  const getStartupInfo = vi.fn(async () => ({
    cliCommand: "& 'C:/ReelTerminal/reelctl.cmd'",
    shell: "PowerShell",
    workspaceRoot: "E:/Data/agent-workspace",
  }));
  openreelWindow.reelterminal = {
    platform: "desktop",
    collabControl: {
      getStartupInfo,
      enable: vi.fn(async () => current),
      disable: vi.fn(async () => current),
      setAccess,
      getStatus: async () => current,
      openWorkspace: async () => "",
    },
  } as unknown as TestBridge;
  return { setAccess, getStartupInfo };
}

async function renderBar(): Promise<void> {
  await act(async () => {
    render(<CollabStatusBar />);
    await Promise.resolve();
  });
}

describe("CollabStatusBar Agent Access status", () => {
  beforeEach(() => {
    delete openreelWindow.reelterminal;
    useUIStore.setState({ activeModal: null });
    useProjectStore.setState((state) => ({ project: { ...state.project, requirements: undefined } }));
    useCollabStore.setState({ sequence: 0, enabled: false, access: "write", currentAction: null });
    useCollabStore.setState({ startupHintShown: false });
    useNotificationStore.getState().clearAll();
  });

  afterEach(() => {
    delete openreelWindow.reelterminal;
    act(() => {
      useUIStore.setState({ activeModal: null });
      useCollabStore.setState({ sequence: 0, enabled: false, access: "write", currentAction: null });
    });
  });

  it("shows CLI availability, read-only access and current operation", async () => {
    installBridge({ enabled: true, access: "read-only", currentAction: "edit.apply" });
    await renderBar();

    expect(await screen.findByText("Agent")).toBeInTheDocument();
    expect(screen.getByTestId("agent-access-mode")).toHaveTextContent("Read-only");
    expect(screen.getByTestId("agent-current-action")).toHaveTextContent("edit.apply");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /agent panel/i })).not.toBeInTheDocument();
  });

  it("lets the user switch the command API access mode", async () => {
    const { setAccess } = installBridge({ enabled: true, access: "read-only" });
    await renderBar();

    fireEvent.click(screen.getByTestId("agent-access-toggle"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(setAccess).toHaveBeenCalledWith("write"));
  });

  it("offers one startup hint per launch and copies live paths on activation", async () => {
    const { getStartupInfo } = installBridge({ access: "read-only" });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await renderBar();
    render(<ToastContainer />);

    fireEvent.click(screen.getByTestId("agent-access-toggle"));
    fireEvent.click(await screen.findByRole("button", { name: /Copy Agent startup prompt/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(getStartupInfo).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0][0]).toContain("& 'C:/ReelTerminal/reelctl.cmd' status");
    expect(writeText.mock.calls[0][0]).toContain("E:/Data/agent-workspace");
    expect(writeText.mock.calls[0][0]).toContain("call capabilities.get");
    expect(writeText.mock.calls[0][0]).toContain("PowerShell");
    await screen.findByText("Startup prompt copied");

    useNotificationStore.getState().clearAll();
    fireEvent.click(screen.getByTestId("agent-access-toggle"));
    await waitFor(() => expect(screen.getByTestId("agent-access-mode")).toHaveTextContent("Read-only"));
    fireEvent.click(screen.getByTestId("agent-access-toggle"));
    await waitFor(() => expect(screen.getByTestId("agent-access-mode")).toHaveTextContent("Editable"));
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it("does not offer a startup hint if granting write access fails", async () => {
    const { setAccess } = installBridge({ access: "read-only" });
    setAccess.mockRejectedValueOnce(new Error("IPC rejected"));
    await renderBar();
    fireEvent.click(screen.getByTestId("agent-access-toggle"));
    await waitFor(() => expect(screen.getByTestId("agent-access-toggle")).not.toBeDisabled());
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it("shows a short starting state while the always-on service initializes", async () => {
    installBridge({ enabled: false });
    await renderBar();

    expect(await screen.findByText("Agent connecting")).toBeInTheDocument();
    expect(screen.getByTestId("agent-access-toggle")).toBeDisabled();
  });

  it("revokes editing without stopping the command service", async () => {
    const { setAccess } = installBridge({ enabled: true, access: "write" });
    await renderBar();

    fireEvent.click(screen.getByTestId("agent-access-toggle"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(setAccess).toHaveBeenCalledWith("read-only"));
  });
});

describe("CollabStatusBar requirements access", () => {
  afterEach(() => act(() => useUIStore.setState({ activeModal: null })));

  it("opens the project requirement board", async () => {
    await renderBar();
    fireEvent.click(screen.getByTestId("requirement-board-entry"));
    expect(useUIStore.getState().activeModal).toBe(REQUIREMENT_BOARD_MODAL_ID);
  });
});
