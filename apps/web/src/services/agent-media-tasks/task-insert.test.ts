/**
 * Timeline insertion tests for done agent media tasks: target-project
 * guard, single-shot insert, and honest failures.
 */
import { describe, expect, it } from "vitest";
import { AgentMediaTaskService } from "./agent-media-task-service";
import type { AgentTaskStorage } from "./storage";
import type { AgentMediaTaskRecord } from "./types";
import {
  insertDoneTaskTimeline,
  type AgentTaskInsertDeps,
} from "./task-insert";

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

interface InsertHarness {
  readonly service: AgentMediaTaskService;
  readonly deps: AgentTaskInsertDeps;
  readonly addCalls: string[];
  clipIds: string[];
}

function buildHarness(options: {
  readonly currentProjectId?: string | null;
  readonly mediaPresent?: boolean;
  readonly addSucceeds?: boolean;
} = {}): InsertHarness {
  const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
  const addCalls: string[] = [];
  const state = {
    clipIds: ["clip-existing-1"] as string[],
  };
  const deps: AgentTaskInsertDeps = {
    service,
    getCurrentProjectId: () =>
      options.currentProjectId === undefined
        ? "proj-1"
        : options.currentProjectId,
    getMediaItem: (mediaId: string) =>
      options.mediaPresent === false
        ? undefined
        : { id: mediaId, type: "audio" },
    addClipToNewTrack: async (mediaId: string) => {
      addCalls.push(mediaId);
      if (options.addSucceeds === false) {
        return { success: false, error: { code: "TRACK_NOT_FOUND" as const } };
      }
      const clipId = `clip-${addCalls.length}`;
      state.clipIds = [...state.clipIds, clipId];
      return { success: true };
    },
    collectClipIds: () => state.clipIds,
  };
  return { service, deps, addCalls, clipIds: state.clipIds };
}

async function createDoneTask(
  service: AgentMediaTaskService,
): Promise<AgentMediaTaskRecord> {
  const created = await service.createTask({
    kind: "music",
    promptText: "30 秒放松的钢琴曲",
    targetProjectId: "proj-1",
    insertIntent: "timeline",
    capabilityBits: { formalReply: "supported" },
    recommendedRoot: "C:\\ws",
  });
  if (!created.ok) throw new Error(created.message);
  const submitted = await service.markSubmitted(created.value.record.id, {
    autoConfirm: { mode: "receipt" },
  });
  if (!submitted.ok) throw new Error(submitted.message);
  await service.markAwaitingImport(submitted.value.id, {
    resultPath: "C:\\ws\\output\\music.wav",
  });
  const done = await service.markDone(submitted.value.id, {
    resultMediaId: "media-done-1",
  });
  if (!done.ok) throw new Error(done.message);
  return done.value;
}

describe("insertDoneTaskTimeline", () => {
  it("inserts once, records the created clip id, and skips a second call", async () => {
    const harness = buildHarness();
    const record = await createDoneTask(harness.service);

    const first = await insertDoneTaskTimeline(record.id, harness.deps);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.clipId).toMatch(/^clip-/);
    const afterFirst = await harness.service.get(record.id);
    expect(afterFirst.ok && afterFirst.value.insertedClipId).toMatch(/^clip-/);

    const second = await insertDoneTaskTimeline(record.id, harness.deps);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.skipped).toBe(true);
    expect(harness.addCalls).toHaveLength(1);
    expect(harness.addCalls[0]).toBe("media-done-1");
  });

  it("refuses a task that is not done", async () => {
    const harness = buildHarness();
    const created = await harness.service.createTask({
      kind: "tts",
      promptText: "文本",
      targetProjectId: "proj-1",
      insertIntent: "timeline",
    });
    if (!created.ok) throw new Error(created.message);
    const outcome = await insertDoneTaskTimeline(created.value.record.id, harness.deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("INVALID_STATUS");
    expect(harness.addCalls).toHaveLength(0);
  });

  it("never inserts into a different project than the target", async () => {
    const harness = buildHarness({ currentProjectId: "proj-2" });
    const record = await createDoneTask(harness.service);
    const outcome = await insertDoneTaskTimeline(record.id, harness.deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("PROJECT_MISMATCH");
    expect(harness.addCalls).toHaveLength(0);
    const after = await harness.service.get(record.id);
    expect(after.ok && after.value.insertedClipId).toBeUndefined();
  });

  it("fails honestly when the media is no longer in the project", async () => {
    const harness = buildHarness({ mediaPresent: false });
    const record = await createDoneTask(harness.service);
    const outcome = await insertDoneTaskTimeline(record.id, harness.deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("MEDIA_NOT_FOUND");
    expect(harness.addCalls).toHaveLength(0);
  });

  it("records nothing when the clip/add action fails", async () => {
    const harness = buildHarness({ addSucceeds: false });
    const record = await createDoneTask(harness.service);
    const outcome = await insertDoneTaskTimeline(record.id, harness.deps);
    expect(outcome.ok).toBe(false);
    const after = await harness.service.get(record.id);
    expect(after.ok && after.value.insertedClipId).toBeUndefined();
  });
});
