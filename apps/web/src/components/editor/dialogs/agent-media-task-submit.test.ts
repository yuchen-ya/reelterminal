import { afterEach, describe, expect, it } from "vitest";
import {
  AgentMediaTaskService,
} from "../../../services/agent-media-tasks/agent-media-task-service";
import { AgentTaskStorageUnavailableError, type AgentTaskStorage } from "../../../services/agent-media-tasks/storage";
import type { AgentMediaTaskRecord } from "../../../services/agent-media-tasks/types";
import {
  cancelAgentMediaTask,
  retryAgentMediaTask,
  setPromptLanguageResolver,
  submitAgentMediaTask,
  type AgentMediaTaskFormDraft,
  type AgentMediaTaskSubmitDeps,
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
    if (this.failCommits) {
      throw new AgentTaskStorageUnavailableError("no idb");
    }
    for (const record of upserts) this.rows.set(record.id, record);
    for (const id of deletes) this.rows.delete(id);
  }

  failCommits = false;
}

const ROOT = "C:\\agent-workspace";
const RECEIPT = { formalReply: "supported" } as const;

function makeDraft(overrides: Partial<AgentMediaTaskFormDraft> = {}): AgentMediaTaskFormDraft {
  return {
    kind: "tts",
    promptText: "欢迎收听本期节目。",
    targetProjectId: "proj-1",
    targetProjectName: "Demo",
    insertIntent: "timeline",
    ...overrides,
  };
}

function makeDeps(service: AgentMediaTaskService, options: { root?: string | null; failPrompt?: boolean } = {}) {
  const prompts: string[] = [];
  const deps: AgentMediaTaskSubmitDeps = {
    service,
    sendPrompt: async (text) => {
      if (options.failPrompt) throw new Error("lane busy");
      prompts.push(text);
      return {};
    },
    capabilityBits: RECEIPT,
    resolveRecommendedRoot: async () => options.root === undefined ? ROOT : options.root,
  };
  return { deps, prompts };
}

describe("submitAgentMediaTask", () => {
  // The prompt-language resolver is module state; restore the historical
  // default after every test so language stubs never leak across cases.
  afterEach(() => setPromptLanguageResolver(() => "zh"));

  it("creates the record, precasts the prompt, and submits over the conversation lane", async () => {
    const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
    const { deps, prompts } = makeDeps(service);

    const result = await submitAgentMediaTask(makeDraft(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe("submitted");
    expect(result.record.outputDirectory).toBe(`${ROOT}\\jobs\\${result.record.id}\\output`);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`openreel-task:${result.record.requestId}`);
    expect(prompts[0]).toContain(result.record.outputDirectory);
  });

  it("replays the same requestId without sending the prompt twice", async () => {
    const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
    const { deps, prompts } = makeDeps(service);

    const first = await submitAgentMediaTask(makeDraft(), deps, "req_fixed");
    const second = await submitAgentMediaTask(makeDraft(), deps, "req_fixed");

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.replayed).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(prompts).toHaveLength(1);
  });

  it("fails the record honestly when no recommended root can be resolved", async () => {
    const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
    const { deps, prompts } = makeDeps(service, { root: null });

    const result = await submitAgentMediaTask(makeDraft(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NO_RECOMMENDED_ROOT");
    expect(prompts).toHaveLength(0);
    const list = await service.list();
    expect(list.ok && list.value.tasks[0]?.status).toBe("error");
    expect(list.ok && list.value.tasks[0]?.error?.code).toBe("NO_RECOMMENDED_ROOT");
  });

  it("lands a prompt-lane failure on the record as a retryable error", async () => {
    const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
    const { deps, prompts } = makeDeps(service, { failPrompt: true });

    const result = await submitAgentMediaTask(makeDraft(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PROMPT_SEND_FAILED");
    expect(prompts).toHaveLength(0);
    const list = await service.list();
    expect(list.ok && list.value.tasks[0]?.error?.code).toBe("PROMPT_SEND_FAILED");
  });

  it("rejects a voiceover draft without read-aloud text before anything is stored", async () => {
    const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
    const { deps, prompts } = makeDeps(service);

    const result = await submitAgentMediaTask(makeDraft({ promptText: "  " }), deps);

    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(prompts).toHaveLength(0);
    const list = await service.list();
    expect(list.ok && list.value.tasks).toHaveLength(0);
  });

  it("accepts a music draft whose brief lives only in the requirements", async () => {
    const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
    const { deps, prompts } = makeDeps(service);

    const result = await submitAgentMediaTask(
      makeDraft({ kind: "music", promptText: "", requirementsText: "轻快的钢琴" }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("轻快的钢琴");
  });

  it("composes the hand-off prose in the installed UI language with a stable marker", async () => {
    const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
    const { deps, prompts } = makeDeps(service);
    // Simulate an English UI locale (the agent-task runtime installs the
    // i18n reader in the app; tests install a stub directly).
    setPromptLanguageResolver(() => "en");

    const result = await submitAgentMediaTask(makeDraft(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(prompts).toHaveLength(1);
    // Marker is a parsing contract: identical in every language.
    expect(prompts[0]).toContain(
      `[ReelTerminal 任务 openreel-task:${result.record.requestId}]`,
    );
    expect(prompts[0]).toContain("Type: Voiceover (read-aloud text to speech)");
    expect(prompts[0]).toContain(
      `${result.record.requestId} RESULT <absolute artifact path>`,
    );
  });

  it("keeps the historical zh prose when no language resolver is installed", async () => {
    setPromptLanguageResolver(() => "zh");
    const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
    const { deps, prompts } = makeDeps(service);

    const result = await submitAgentMediaTask(makeDraft(), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("类型: 配音");
    expect(prompts[0]).toContain(
      `[ReelTerminal 任务 openreel-task:${result.record.requestId}]`,
    );
  });
});

describe("retryAgentMediaTask", () => {
  it("re-arms a failed task with a fresh requestId and resubmits it", async () => {
    const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
    const { deps, prompts } = makeDeps(service);
    const created = await submitAgentMediaTask(makeDraft(), deps);
    if (!created.ok) throw new Error("setup failed");
    await service.markError(created.record.id, { code: "X", message: "boom" });
    const oldRequestId = created.record.requestId;

    const result = await retryAgentMediaTask(created.record.id, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe("submitted");
    expect(result.record.attempt).toBe(1);
    expect(result.record.requestId).not.toBe(oldRequestId);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(`openreel-task:${result.record.requestId}`);
    // The dead attempt's requestId must never resolve again.
    expect(await service.getByRequestId(oldRequestId)).toMatchObject({ ok: false });
  });

  it("refuses to retry a task that is not in a terminal failure state", async () => {
    const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
    const { deps, prompts } = makeDeps(service);
    const created = await submitAgentMediaTask(makeDraft(), deps);
    if (!created.ok) throw new Error("setup failed");

    const result = await retryAgentMediaTask(created.record.id, deps);

    expect(result).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
    expect(prompts).toHaveLength(1);
  });
});

describe("cancelAgentMediaTask", () => {
  it("marks only the local record cancelled and keeps the reason", async () => {
    const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
    const { deps } = makeDeps(service);
    const created = await submitAgentMediaTask(makeDraft(), deps);
    if (!created.ok) throw new Error("setup failed");

    const result = await cancelAgentMediaTask(created.record.id, service, "user requested");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe("cancelled");
    expect(result.record.failureReason).toBe("user requested");
    expect(result.record.resultPath).toBeUndefined();
  });

  it("rejects cancelling an already-terminal task", async () => {
    const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
    const { deps } = makeDeps(service);
    const created = await submitAgentMediaTask(makeDraft(), deps);
    if (!created.ok) throw new Error("setup failed");
    await service.markError(created.record.id, { code: "X", message: "boom" });

    const result = await cancelAgentMediaTask(created.record.id, service);

    expect(result).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
  });
});
