import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentMediaTaskService,
  setAgentMediaTaskServiceForTests,
} from "../../../services/agent-media-tasks/agent-media-task-service";
import type { AgentTaskStorage } from "../../../services/agent-media-tasks/storage";
import type { AgentMediaTaskRecord } from "../../../services/agent-media-tasks/types";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { AGENT_MEDIA_TASK_MODAL_ID, AgentMediaTaskDialog } from "./AgentMediaTaskDialog";

class MemoryAgentTaskStorage implements AgentTaskStorage {
  readonly rows = new Map<string, AgentMediaTaskRecord>();
  async loadAll(): Promise<unknown[]> {
    return [...this.rows.values()];
  }
  async commit(upserts: readonly AgentMediaTaskRecord[], deletes: readonly string[]): Promise<void> {
    for (const record of upserts) this.rows.set(record.id, record);
    for (const id of deletes) this.rows.delete(id);
  }
}

function useMemoryService(): AgentMediaTaskService {
  const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
  setAgentMediaTaskServiceForTests(service);
  return service;
}

async function seedTask(
  service: AgentMediaTaskService,
  id: string,
): Promise<AgentMediaTaskRecord> {
  const created = await service.createTask({
    id,
    kind: "tts",
    promptText: `saved task ${id}`,
    targetProjectId: "proj-1",
    targetProjectName: "Demo",
    insertIntent: "timeline",
  });
  if (!created.ok) throw new Error(created.message);
  return created.value.record;
}

function openDialog(): void {
  useUIStore.setState({ activeModal: AGENT_MEDIA_TASK_MODAL_ID });
}

describe("AgentMediaTaskDialog state", () => {
  beforeEach(() => {
    useProjectStore.setState({ project: createEmptyProject("Dialog Demo") });
    useUIStore.setState({ activeModal: null });
  });

  afterEach(() => {
    setAgentMediaTaskServiceForTests(null);
    delete (window as unknown as { reelterminal?: unknown }).reelterminal;
    useUIStore.setState({ activeModal: null });
  });

  it("pauses new submission and retry while leaving the saved error record untouched", async () => {
    const service = useMemoryService();
    const saved = await seedTask(service, "amt_saved-error");
    await service.markError(saved.id, { code: "APP_RESTART", message: "legacy task record" });
    const before = await service.get(saved.id);
    if (!before.ok) throw new Error(before.message);

    openDialog();
    render(<AgentMediaTaskDialog />);

    expect(await screen.findByTestId("amt-generation-paused")).toHaveTextContent(
      "submission and retry are temporarily paused",
    );
    expect(screen.queryByTestId("amt-submit")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Text to read aloud")).not.toBeInTheDocument();
    expect(await screen.findByTestId(`amt-row-${saved.id}`)).toBeInTheDocument();
    expect(screen.getByTestId("amt-retry-paused-note")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();

    const after = await service.get(saved.id);
    expect(after).toEqual(before);
  });

  it("continues to display stored task states and artifacts", async () => {
    const service = useMemoryService();
    await seedTask(service, "amt_saved-queued");
    const done = await seedTask(service, "amt_saved-done");
    await service.markSubmitted(done.id, { autoConfirm: { mode: "receipt" } });
    await service.markRunning(done.id);
    await service.markAwaitingImport(done.id, { resultPath: "C:\\jobs\\voice.wav" });
    await service.markDone(done.id, { resultMediaId: "media_saved" });

    openDialog();
    render(<AgentMediaTaskDialog />);

    expect(await screen.findByTestId("amt-status-queued")).toBeInTheDocument();
    expect(screen.getByTestId("amt-status-done")).toBeInTheDocument();
    expect(screen.getByText(/media_saved/)).toBeInTheDocument();
  });

  it("closes from Escape after the history dialog is open", async () => {
    useMemoryService();
    render(<AgentMediaTaskDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    openDialog();
    await screen.findByRole("dialog", { name: "Voiceover & music tasks" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUIStore.getState().activeModal).toBeNull();
  });
});
