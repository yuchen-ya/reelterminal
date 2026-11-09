import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog";
import { useSettingsStore } from "../../../stores/settings-store";

vi.mock("./AgentModelSettingsPanel", () => ({
  AgentModelSettingsPanel: () => <div data-testid="mock-agent-model-settings-panel">Agent Panel Content</div>,
}));

vi.mock("./AudioEnvironmentPanel", () => ({
  AudioEnvironmentPanel: () => <div data-testid="mock-audio-env-panel">Audio Panel Content</div>,
}));

vi.mock("./GeneralPanel", () => ({
  GeneralPanel: () => <div data-testid="mock-general-panel">General Panel Content</div>,
}));

vi.mock("./SavingPanel", () => ({
  SavingPanel: () => <div data-testid="mock-saving-panel">Saving Panel Content</div>,
}));

vi.mock("./StoragePanel", () => ({
  StoragePanel: () => <div data-testid="mock-storage-panel">Storage Panel Content</div>,
}));

vi.mock("./KeyboardShortcutsPanel", () => ({
  KeyboardShortcutsPanel: () => <div data-testid="mock-shortcuts-panel">Shortcuts Panel Content</div>,
}));

describe("SettingsDialog", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settingsOpen: true,
      settingsTab: "general",
    });
  });

  it("renders the agent tab option in the segmented control", () => {
    render(<SettingsDialog />);

    const agentTab = screen.getByRole("radio", { name: /内置 Agent|Built-in Agent/i });
    expect(agentTab).toBeInTheDocument();
  });

  it("switches to AgentModelSettingsPanel when agent tab is clicked", () => {
    render(<SettingsDialog />);

    const agentTab = screen.getByRole("radio", { name: /内置 Agent|Built-in Agent/i });
    fireEvent.click(agentTab);

    expect(screen.getByTestId("mock-agent-model-settings-panel")).toBeInTheDocument();
  });

  it("renders the active panel according to settingsTab", () => {
    useSettingsStore.setState({
      settingsOpen: true,
      settingsTab: "models",
    });

    render(<SettingsDialog />);

    expect(screen.getByTestId("mock-audio-env-panel")).toBeInTheDocument();
  });
});
