import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentMediaTaskService, setAgentMediaTaskServiceForTests } from "../../../services/agent-media-tasks/agent-media-task-service";
import type { AgentTaskStorage } from "../../../services/agent-media-tasks/storage";
import type { AgentMediaTaskRecord } from "../../../services/agent-media-tasks/types";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { useExternalConversationStore } from "../../../stores/external-conversation-store";
import {
  AGENT_MEDIA_TASK_MODAL_ID,
  AgentMediaTaskDialog,
} from "./AgentMediaTaskDialog";
import {
  defaultResolveRecommendedRoot,
  setRecommendedRootResolver,
} from "./agent-media-task-submit";

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

const SETUP_STATE = {
  codex: { state: "ready", code: "ok" },
  authentication: { state: "ready", code: "ok" },
  liveConnector: { state: "ready", code: "ok" },
  externalAdapter: { state: "missing", code: "adapter-missing" },
  threads: [],
  managedSessionId: null,
};

function conversationState(lifecycle: string) {
  return {
    sequence: 2,
    adapter: {
      availability: "available",
      agentLabel: "Test Agent",
      adapterName: "test",
      sessionId: "s1",
      capabilityLevel: "observable",
      message: null,
    },
    conversation: {
      lifecycle,
      connectionId: "c1",
      sessionId: "s1",
      agent: null,
      capabilities: { formalReply: "supported" },
      ownership: null,
      fallback: null,
      lastError: null,
      updates: [],
      lastEventSequence: 0,
    },
  };
}

function stubConversationApi(lifecycle: string) {
  const prompts: string[] = [];
  const api = {
    getState: async () => conversationState(lifecycle),
    attach: async () => conversationState(lifecycle),
    prompt: async (text: string) => {
      prompts.push(text);
      return conversationState(lifecycle);
    },
    resolveApproval: async () => conversationState(lifecycle),
    cancel: async () => conversationState(lifecycle),
    detach: async () => conversationState(lifecycle),
    onEvent: () => () => undefined,
    inspectSetup: async () => SETUP_STATE,
    startSetup: async () => SETUP_STATE,
  };
  (window as unknown as { reelterminal?: unknown }).reelterminal = {
    platform: "desktop",
    publicOrigin: "https://desktop.test",
    conversation: api,
  };
  return { prompts };
}

function openDialog(): void {
  useUIStore.setState({ activeModal: AGENT_MEDIA_TASK_MODAL_ID });
}

function useMemoryService(): AgentMediaTaskService {
  const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
  setAgentMediaTaskServiceForTests(service);
  return service;
}

async function seedTask(
  service: AgentMediaTaskService,
  kind: "tts" | "music" = "tts",
): Promise<AgentMediaTaskRecord> {
  const created = await service.createTask({
    kind,
    promptText: "seed text",
    targetProjectId: "proj-1",
    targetProjectName: "Demo",
    insertIntent: "timeline",
    capabilityBits: null,
    now: "2026-06-01T00:00:00.000Z",
  });
  if (!created.ok) throw new Error(created.message);
  return created.value.record;
}

describe("AgentMediaTaskDialog", () => {
  beforeEach(() => {
    useProjectStore.setState({ project: createEmptyProject("Dialog Demo") });
    useUIStore.setState({ activeModal: null });
    useExternalConversationStore.setState({
      busy: false,
      sending: false,
      cancelling: false,
      error: null,
    });
    // jsdom has no desktop media-roots channel, so tests install a stand-in
    // resolver; the "no root yet" case resets it explicitly.
    setRecommendedRootResolver(async () => "C:\\agent-workspace");
  });

  afterEach(() => {
    setRecommendedRootResolver(defaultResolveRecommendedRoot);
    setAgentMediaTaskServiceForTests(null);
    delete (window as unknown as { reelterminal?: unknown }).reelterminal;
    useUIStore.setState({ activeModal: null });
  });

  it("guides to the desktop app when there is no conversation API at all", () => {
    useMemoryService();
    openDialog();
    render(<AgentMediaTaskDialog />);

    expect(screen.getByTestId("amt-desktop-notice")).toBeInTheDocument();
    expect(screen.queryByTestId("amt-submit")).not.toBeInTheDocument();
  });

  it("renders the connection guide in place while the session is not ready", async () => {
    useMemoryService();
    stubConversationApi("idle");
    openDialog();
    render(<AgentMediaTaskDialog />);

    expect(await screen.findByTestId("amt-connection-guide")).toBeInTheDocument();
    expect(screen.getByText("Connect an Agent")).toBeInTheDocument();
    expect(screen.queryByTestId("amt-submit")).not.toBeInTheDocument();
  });

  it("explains a blank required field instead of submitting", async () => {
    useMemoryService();
    stubConversationApi("ready");
    openDialog();
    render(<AgentMediaTaskDialog />);
    await screen.findByTestId("amt-submit");

    fireEvent.click(screen.getByTestId("amt-submit"));

    expect(screen.getByTestId("amt-submit-error")).toHaveTextContent(
      "Enter the text to read aloud.",
    );
    expect(screen.queryByTestId(/^amt-row-/)).not.toBeInTheDocument();
  });

  it("rejects a music task with neither description nor requirements", async () => {
    useMemoryService();
    stubConversationApi("ready");
    openDialog();
    render(<AgentMediaTaskDialog />);
    await screen.findByTestId("amt-submit");

    fireEvent.click(screen.getByTestId("amt-kind-music"));
    fireEvent.click(screen.getByTestId("amt-submit"));

    expect(screen.getByTestId("amt-submit-error")).toHaveTextContent(
      "Describe the music or add free-form requirements.",
    );
  });

  it("submits the composed prompt and shows the task as submitted", async () => {
    const service = useMemoryService();
    const { prompts } = stubConversationApi("ready");
    openDialog();
    render(<AgentMediaTaskDialog />);
    await screen.findByTestId("amt-submit");

    fireEvent.change(screen.getByTestId("amt-text"), {
      target: { value: "Hello from the test" },
    });
    fireEvent.click(screen.getByTestId("amt-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("amt-status-submitted")).toBeInTheDocument(),
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("openreel-task:");
    expect(prompts[0]).toContain("Hello from the test");
    const list = await service.list();
    expect(list.ok && list.value.tasks[0]?.status).toBe("submitted");
    expect(list.ok && list.value.tasks[0]?.autoConfirm).toBe("receipt");
  });

  it("disables submission while the conversation lane is busy and explains it", async () => {
    useMemoryService();
    stubConversationApi("ready");
    openDialog();
    render(<AgentMediaTaskDialog />);
    await screen.findByTestId("amt-submit");

    act(() => {
      useExternalConversationStore.setState({ sending: true });
    });

    expect(screen.getByTestId("amt-session-busy")).toBeInTheDocument();
    expect(screen.getByTestId("amt-submit")).toBeDisabled();

    act(() => {
      useExternalConversationStore.setState({ sending: false });
    });
    expect(screen.getByTestId("amt-submit")).not.toBeDisabled();
  });

  it("renders the ledger across all task states", async () => {
    const service = useMemoryService();
    const awaiting = await seedTask(service);
    await service.markRunning(awaiting.id);
    await service.markAwaitingImport(awaiting.id, {
      resultPath: "C:\\root\\jobs\\a\\out.wav",
    });
    const done = await seedTask(service);
    await service.markRunning(done.id);
    await service.markAwaitingImport(done.id, { resultPath: "C:\\root\\jobs\\d\\out.wav" });
    await service.markDone(done.id, { resultMediaId: "med_1" });
    const failed = await seedTask(service);
    await service.markError(failed.id, { code: "AGENT_FAILED", message: "no provider" });
    await seedTask(service);

    stubConversationApi("ready");
    openDialog();
    render(<AgentMediaTaskDialog />);

    expect(screen.getByTestId("amt-status-awaiting_import")).toBeInTheDocument();
    expect(screen.getByTestId("amt-status-done")).toBeInTheDocument();
    expect(screen.getByTestId("amt-status-error")).toBeInTheDocument();
    expect(screen.getByTestId("amt-status-queued")).toBeInTheDocument();
    expect(screen.getByText(/AGENT_FAILED/)).toBeInTheDocument();
    // Failure offers a retry; the active task offers the local cancel.
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel task" })).toBeInTheDocument();
  });

  it("never fakes success when no recommended root is available yet", async () => {
    const service = useMemoryService();
    setRecommendedRootResolver(async () => null);
    const { prompts } = stubConversationApi("ready");
    openDialog();
    render(<AgentMediaTaskDialog />);
    await screen.findByTestId("amt-submit");

    fireEvent.change(screen.getByTestId("amt-text"), {
      target: { value: "Hello from the test" },
    });
    fireEvent.click(screen.getByTestId("amt-submit"));

    expect(await screen.findByTestId("amt-submit-error")).toHaveTextContent(
      "did not advertise a media root",
    );
    expect(prompts).toHaveLength(0);
    expect(screen.queryByTestId("amt-status-submitted")).not.toBeInTheDocument();
    expect(screen.getByTestId("amt-status-error")).toBeInTheDocument();
    // The task row shows the stored code with the neutral, name-free detail.
    expect(screen.getByText(/NO_RECOMMENDED_ROOT/)).toBeInTheDocument();
    expect(screen.queryByText(/capabilities_get/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    const list = await service.list();
    expect(list.ok && list.value.tasks[0]?.error?.code).toBe("NO_RECOMMENDED_ROOT");
  });

  it("cancels a queued task locally and shows the honest session-side caveat", async () => {
    const service = useMemoryService();
    const queued = await seedTask(service);
    stubConversationApi("ready");
    openDialog();
    render(<AgentMediaTaskDialog />);
    await screen.findByTestId(`amt-row-${queued.id}`);

    fireEvent.click(screen.getByRole("button", { name: "Cancel task" }));

    await waitFor(() =>
      expect(screen.getByTestId("amt-status-cancelled")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/agent session may still be running its turn/i),
    ).toBeInTheDocument();
    const record = await service.get(queued.id);
    expect(record.ok && record.value.status).toBe("cancelled");
  });

  it("retries a failed task with a new request id and lands it back on submitted", async () => {
    const service = useMemoryService();
    const failed = await seedTask(service);
    await service.markError(failed.id, { code: "AGENT_FAILED", message: "no provider" });
    const { prompts } = stubConversationApi("ready");
    openDialog();
    render(<AgentMediaTaskDialog />);
    await screen.findByTestId(`amt-row-${failed.id}`);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(screen.getByTestId("amt-status-submitted")).toBeInTheDocument(),
    );
    expect(prompts).toHaveLength(1);
    const record = await service.get(failed.id);
    expect(record.ok && record.value.status).toBe("submitted");
    expect(record.ok && record.value.attempt).toBe(1);
    expect(record.ok && record.value.requestId).not.toBe(failed.requestId);
  });

  it("surfaces the manual-confirmation notice verbatim on the task row", async () => {
    const service = useMemoryService();
    const record = await seedTask(service);
    await service.markSubmitted(record.id, {
      autoConfirm: {
        mode: "manual-only",
        reason: "此会话未声明正式回复能力，无法自动确认。",
      },
    });
    stubConversationApi("ready");
    openDialog();
    render(<AgentMediaTaskDialog />);

    expect(await screen.findByTestId("amt-auto-confirm-notice")).toHaveTextContent(
      "此会话未声明正式回复能力，无法自动确认。",
    );
  });
});
