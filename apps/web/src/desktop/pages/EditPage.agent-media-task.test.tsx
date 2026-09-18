/**
 * G13 desktop entry: the desktop Edit page must mount the shared
 * voiceover/music task dialog + runtime, and the CollabStatusBar entry
 * button must open it through the standard ui-store modal id. Heavy page
 * panels are stubbed; the strip and the dialog run for real.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";

import { EditPage } from "./EditPage";
import { useUIStore } from "../../stores/ui-store";
import { useProjectStore } from "../../stores/project-store";
import { createEmptyProject } from "../../stores/project/project-helpers";
import {
  AgentMediaTaskService,
  setAgentMediaTaskServiceForTests,
} from "../../services/agent-media-tasks/agent-media-task-service";
import type { AgentTaskStorage } from "../../services/agent-media-tasks/storage";
import type { AgentMediaTaskRecord } from "../../services/agent-media-tasks/types";
import { AGENT_MEDIA_TASK_MODAL_ID } from "../../components/editor/dialogs/AgentMediaTaskDialog";

vi.mock("../../components/editor/AssetsPanel", () => ({
  AssetsPanel: (): React.ReactElement => <div data-testid="stub-assets" />,
}));
vi.mock("../../components/editor/InspectorPanel", () => ({
  InspectorPanel: (): React.ReactElement => <div data-testid="stub-inspector" />,
}));
vi.mock("../../components/editor/Preview", () => ({
  Preview: (): React.ReactElement => <div data-testid="stub-preview" />,
}));
vi.mock("../../components/editor/Timeline", () => ({
  Timeline: (): React.ReactElement => <div data-testid="stub-timeline" />,
}));
vi.mock("../../components/editor/agent/ExternalAgentFloatingWindow", () => ({
  ExternalAgentFloatingWindow: (): React.ReactElement | null => null,
}));
vi.mock("../editor/AgentInspectionPanel", () => ({
  AgentInspectionPanel: (): React.ReactElement | null => null,
}));

class MemoryAgentTaskStorage implements AgentTaskStorage {
  readonly rows = new Map<string, AgentMediaTaskRecord>();

  async loadAll(): Promise<unknown[]> {
    return [...this.rows.values()];
  }

  async commit(
    upserts: readonly AgentMediaTaskRecord[],
    deletes: readonly string[],
  ): Promise<void> {
    for (const record of upserts) this.rows.set(record.id, record);
    for (const id of deletes) this.rows.delete(id);
  }
}

describe("EditPage agent media task entry (G13 desktop)", () => {
  beforeEach(() => {
    useProjectStore.setState({ project: createEmptyProject("Desktop Demo") });
    useUIStore.setState({ activeModal: null });
    // jsdom has neither the desktop bridge nor IndexedDB here; the dialog
    // and the runtime run against an in-memory ledger like the dialog tests.
    setAgentMediaTaskServiceForTests(
      new AgentMediaTaskService(new MemoryAgentTaskStorage()),
    );
  });

  afterEach(() => {
    setAgentMediaTaskServiceForTests(null);
    useUIStore.setState({ activeModal: null });
    delete (window as unknown as { openreel?: unknown }).openreel;
  });

  it("mounts the dialog closed and opens it from the strip entry", () => {
    render(<EditPage />);

    // The strip hosts the desktop entry button.
    const entry = screen.getByTestId("collab-agent-media-entry");
    // Closed dialog renders null — no layout footprint until opened.
    expect(screen.queryByTestId("amt-desktop-notice")).not.toBeInTheDocument();

    fireEvent.click(entry);

    expect(useUIStore.getState().activeModal).toBe(AGENT_MEDIA_TASK_MODAL_ID);
    // With no desktop conversation API the dialog renders its desktop
    // notice — proving the shared dialog is live on the desktop page.
    expect(screen.getByTestId("amt-desktop-notice")).toBeInTheDocument();
  });

  it("does not open the dialog from unrelated strip buttons", () => {
    render(<EditPage />);

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));

    expect(useUIStore.getState().activeModal).toBeNull();
    expect(screen.queryByTestId("amt-desktop-notice")).not.toBeInTheDocument();
  });
});
