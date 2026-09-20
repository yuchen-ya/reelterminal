/**
 * Panel-level tests for the task row actions: guarded import, timeline
 * insertion, project-mismatch hints, and the manual confirmation buttons.
 * The controller logic itself is covered in task-import / task-insert tests;
 * here we verify the row renders the right affordances and wires them up.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMediaTaskService, setAgentMediaTaskServiceForTests } from "../../../services/agent-media-tasks/agent-media-task-service";
import type { AgentTaskStorage } from "../../../services/agent-media-tasks/storage";
import type { AgentMediaTaskRecord } from "../../../services/agent-media-tasks/types";
import type { MediaItem } from "@reelterminal/core";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { useExternalConversationStore } from "../../../stores/external-conversation-store";
import {
  AGENT_MEDIA_TASK_MODAL_ID,
  AgentMediaTaskDialog,
} from "./AgentMediaTaskDialog";

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

function stubDesktopApi(lifecycle: string, importArtifact: unknown) {
  (window as unknown as { openreel?: unknown }).openreel = {
    platform: "desktop",
    publicOrigin: "https://desktop.test",
    conversation: {
      getState: async () => conversationState(lifecycle),
      attach: async () => conversationState(lifecycle),
      prompt: async () => conversationState(lifecycle),
      resolveApproval: async () => conversationState(lifecycle),
      cancel: async () => conversationState(lifecycle),
      detach: async () => conversationState(lifecycle),
      onEvent: () => () => undefined,
      inspectSetup: async () => SETUP_STATE,
      startSetup: async () => SETUP_STATE,
    },
    agentTasks: {
      getMediaRoots: async () => ({
        recommendedRoot: "C:\\agent-workspace",
        mediaRoots: ["C:\\agent-workspace"],
      }),
      scanTaskOutput: async () => ({ files: [] }),
      importArtifact,
    },
  };
}

/**
 * A working stand-in for the projects database: the global test setup mocks
 * indexedDB.open with a never-settling request, which would stall the real
 * existence oracle. Any seeded key counts as an existing project.
 */
function stubProjectsDb(knownIds: readonly string[]): void {
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const request: {
        result: unknown;
        error: unknown;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      } = {
        result: null,
        error: null,
        onsuccess: null,
        onerror: null,
      };
      setTimeout(() => {
        request.result = {
          version: 1,
          objectStoreNames: { contains: () => true },
          transaction: () => ({
            objectStore: () => ({
              count: (key: string) => {
                const countRequest = {
                  result: 0,
                  onsuccess: null as (() => void) | null,
                  onerror: null as (() => void) | null,
                };
                setTimeout(() => {
                  countRequest.result = knownIds.includes(key) ? 1 : 0;
                  countRequest.onsuccess?.();
                }, 0);
                return countRequest;
              },
            }),
          }),
          close: () => undefined,
        };
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
}

function openDialog(): void {
  useUIStore.setState({ activeModal: AGENT_MEDIA_TASK_MODAL_ID });
}

function useMemoryService(): AgentMediaTaskService {
  const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
  setAgentMediaTaskServiceForTests(service);
  return service;
}

function openProjectWithMedia(): { projectId: string; mediaId: string } {
  const project = createEmptyProject("Dialog Demo");
  const mediaId = "media-task-result";
  const mediaItem: MediaItem = {
    id: mediaId,
    name: "generated.wav",
    type: "audio",
    fileHandle: null,
    blob: new Blob(["fake-bytes"], { type: "audio/wav" }),
    metadata: {
      duration: 3,
      width: 0,
      height: 0,
      frameRate: 0,
      codec: "pcm",
      sampleRate: 44100,
      channels: 1,
      fileSize: 10,
    },
    thumbnailUrl: null,
    waveformData: null,
  };
  act(() => {
    useProjectStore.setState({
      project: {
        ...project,
        mediaLibrary: { ...project.mediaLibrary, items: [mediaItem] },
      },
      hasOpenProject: true,
    });
  });
  const state = useProjectStore.getState();
  return { projectId: state.project.id, mediaId };
}

async function seedSubmittedTask(
  service: AgentMediaTaskService,
  projectId: string,
  capabilityBits: { formalReply: "supported" | "unsupported" } = {
    formalReply: "supported",
  },
): Promise<AgentMediaTaskRecord> {
  const created = await service.createTask({
    kind: "tts",
    promptText: "seed text",
    targetProjectId: projectId,
    targetProjectName: "Dialog Demo",
    insertIntent: "timeline",
    capabilityBits,
  });
  if (!created.ok) throw new Error(created.message);
  const submitted = await service.markSubmitted(created.value.record.id, {
    autoConfirm: capabilityBits.formalReply === "unsupported"
      ? { mode: "manual-only", reason: "manual" }
      : { mode: "receipt" },
  });
  if (!submitted.ok) throw new Error(submitted.message);
  return submitted.value;
}

describe("AgentMediaTaskDialog row actions", () => {
  beforeAll(() => {
    // jsdom has no object-URL implementation; the preview only needs a string.
    URL.createObjectURL = vi.fn(() => "blob:mock-audio");
    URL.revokeObjectURL = vi.fn(() => undefined);
  });

  beforeEach(() => {
    useExternalConversationStore.setState({
      busy: false,
      sending: false,
      cancelling: false,
      error: null,
    });
    useUIStore.setState({ activeModal: null });
  });

  afterEach(() => {
    setAgentMediaTaskServiceForTests(null);
    delete (window as unknown as { openreel?: unknown }).openreel;
    useUIStore.setState({ activeModal: null });
  });

  it("imports an awaiting artifact into the matching open project", async () => {
    const service = useMemoryService();
    const { projectId } = openProjectWithMedia();
    const submitted = await seedSubmittedTask(service, projectId);
    await service.markAwaitingImport(submitted.id, {
      resultPath: "C:\\agent-workspace\\jobs\\amt_x\\output\\voice.wav",
    });
    stubDesktopApi("ready", async () => ({
      ok: true,
      value: { mediaId: "media-task-result", name: "voice.wav", revision: 4, replayed: false },
    }));
    stubProjectsDb([projectId]);
    openDialog();
    render(<AgentMediaTaskDialog />);

    fireEvent.click(await screen.findByTestId("amt-import", {}, { timeout: 4000 }));

    await waitFor(
      () => {
        expect(screen.getByTestId("amt-status-done")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    // The preview mounts in an effect after the done state lands.
    expect(
      await screen.findByTestId("amt-audio-preview", {}, { timeout: 4000 }),
    ).toBeInTheDocument();
  });

  it("offers a done timeline task the insert button and records the clip", async () => {
    const service = useMemoryService();
    const { projectId } = openProjectWithMedia();
    const submitted = await seedSubmittedTask(service, projectId);
    await service.markAwaitingImport(submitted.id, { resultPath: "C:\\a.wav" });
    await service.markDone(submitted.id, { resultMediaId: "media-task-result" });
    stubDesktopApi("ready", async () => ({
      ok: true,
      value: { mediaId: "media-task-result", name: "voice.wav", revision: 4, replayed: false },
    }));
    stubProjectsDb([projectId]);
    openDialog();
    render(<AgentMediaTaskDialog />);

    fireEvent.click(await screen.findByTestId("amt-insert", {}, { timeout: 4000 }));

    await waitFor(
      () => {
        expect(screen.getByTestId("amt-inserted-note")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.queryByTestId("amt-insert")).not.toBeInTheDocument();
    const row = await service.get(submitted.id);
    expect(row.ok && row.value.insertedClipId).toBeTruthy();
  });

  it("keeps an awaiting task waiting with a hint while another project is open", async () => {
    const service = useMemoryService();
    openProjectWithMedia();
    const submitted = await seedSubmittedTask(service, "proj-other-open");
    await service.markAwaitingImport(submitted.id, { resultPath: "C:\\a.wav" });
    stubDesktopApi("ready", async () => ({
      ok: true,
      value: { mediaId: "m", name: "n", revision: 1, replayed: false },
    }));
    stubProjectsDb(["proj-other-open"]);
    openDialog();
    render(<AgentMediaTaskDialog />);

    expect(
      await screen.findByTestId(`amt-row-${submitted.id}`, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("amt-import")).not.toBeInTheDocument();
    expect(
      screen.getByText(/切换回目标项目|Switch back to the target project/),
    ).toBeInTheDocument();
  });

  it("keeps retry disabled with an explanation while the session lane is busy", async () => {
    const service = useMemoryService();
    const { projectId } = openProjectWithMedia();
    const submitted = await seedSubmittedTask(service, projectId);
    await service.markError(submitted.id, {
      code: "APP_RESTART",
      message: "interrupted by restart",
    });
    stubDesktopApi("ready", async () => ({
      ok: true,
      value: { mediaId: "m", name: "n", revision: 1, replayed: false },
    }));
    stubProjectsDb([projectId]);
    act(() => {
      useExternalConversationStore.setState({ sending: true });
    });
    openDialog();
    render(<AgentMediaTaskDialog />);

    const retry = await screen.findByTestId("amt-retry", {}, { timeout: 4000 });
    expect(retry).toBeDisabled();
    expect(screen.getByTestId("amt-retry-busy-note")).toBeInTheDocument();

    // Clicking a disabled button is a no-op: no attempt is burned.
    fireEvent.click(retry);
    const row = await service.get(submitted.id);
    expect(row.ok && row.value.attempt).toBe(0);
    expect(row.ok && row.value.requestId).toBe(submitted.requestId);
  });

  it("offers manual confirm / fail buttons for a manual-only task", async () => {
    const service = useMemoryService();
    const { projectId } = openProjectWithMedia();
    const submitted = await seedSubmittedTask(service, projectId, {
      formalReply: "unsupported",
    });
    stubDesktopApi("ready", async () => ({
      ok: true,
      value: { mediaId: "m", name: "n", revision: 1, replayed: false },
    }));
    stubProjectsDb([projectId]);
    openDialog();
    render(<AgentMediaTaskDialog />);

    expect(
      await screen.findByTestId("amt-manual-confirm", {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("amt-manual-fail")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("amt-manual-fail"));
    await waitFor(
      () => {
        expect(screen.getByTestId("amt-status-error")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    const row = await service.get(submitted.id);
    expect(row.ok && row.value.error?.code).toBe("MANUAL_MARKED_FAILED");
  });
});
