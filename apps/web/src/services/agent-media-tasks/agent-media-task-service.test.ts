import { describe, expect, it } from "vitest";
import {
  AGENT_MEDIA_TASKS_UPDATED_EVENT,
  AgentMediaTaskService,
  type AgentMediaTaskCreateInput,
  subscribeAgentMediaTasks,
} from "./agent-media-task-service";
import { decideTaskAutoConfirmation } from "./auto-confirm";
import { AgentTaskStorageUnavailableError, type AgentTaskStorage } from "./storage";
import type { AgentMediaTaskRecord } from "./types";

/** In-memory storage standing in for IndexedDB, with commit journaling. */
class MemoryAgentTaskStorage implements AgentTaskStorage {
  readonly rows = new Map<string, AgentMediaTaskRecord>();
  readonly commits: Array<{
    upserts: readonly AgentMediaTaskRecord[];
    deletes: readonly string[];
  }> = [];

  async loadAll(): Promise<unknown[]> {
    return [...this.rows.values()];
  }

  async commit(
    upserts: readonly AgentMediaTaskRecord[],
    deletes: readonly string[],
  ): Promise<void> {
    this.commits.push({ upserts, deletes });
    for (const record of upserts) this.rows.set(record.id, record);
    for (const id of deletes) this.rows.delete(id);
  }
}

class UnavailableStorage implements AgentTaskStorage {
  async loadAll(): Promise<unknown[]> {
    throw new AgentTaskStorageUnavailableError("no idb");
  }

  async commit(): Promise<void> {
    throw new AgentTaskStorageUnavailableError("no idb");
  }
}

const NOW = "2026-06-01T00:00:00.000Z";
const RECEIPT = decideTaskAutoConfirmation({ formalReply: "supported" });
const MANUAL = decideTaskAutoConfirmation({ formalReply: "unsupported" });

function makeService(storage: AgentTaskStorage = new MemoryAgentTaskStorage()) {
  return new AgentMediaTaskService(storage);
}

function createBase(
  service: AgentMediaTaskService,
  overrides: Partial<AgentMediaTaskCreateInput> = {},
) {
  return service.createTask({
    kind: "tts",
    promptText: "欢迎收听本期节目。",
    targetProjectId: "proj-1",
    targetProjectName: "Demo",
    insertIntent: "timeline",
    capabilityBits: { formalReply: "supported" },
    recommendedRoot: "C:\\media-root",
    now: NOW,
    ...overrides,
  });
}

describe("createTask", () => {
  it("creates a queued record with the creation-time snapshot", async () => {
    const service = makeService();
    const result = await createBase(service);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replayed).toBe(false);
    const record = result.value.record;
    expect(record.id).toMatch(/^amt_/);
    expect(record.requestId).toMatch(/^req_/);
    expect(record.status).toBe("queued");
    expect(record.attempt).toBe(0);
    expect(record.revision).toBe(1);
    expect(record.recordVersion).toBe(1);
    expect(record.autoConfirm).toBe("receipt");
    expect(record.targetProjectId).toBe("proj-1");
    expect(record.insertIntent).toBe("timeline");
    // Precast output directory snapshot under the recommended root.
    expect(record.outputDirectory).toBe("C:\\media-root\\jobs\\" + record.id + "\\output");
  });

  it("is idempotent per requestId (replay returns the existing record)", async () => {
    const service = makeService();
    const first = await createBase(service, { requestId: "req_fixed" });
    const second = await createBase(service, { requestId: "req_fixed", promptText: "changed" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.replayed).toBe(true);
    expect(second.value.record.id).toBe(first.value.record.id);
    // The replay must not overwrite the original user content.
    expect(second.value.record.promptText).toBe("欢迎收听本期节目。");

    const count = (await service.list());
    expect(count.ok && count.value.tasks).toHaveLength(1);
  });

  it("persists a manual-only decision when formal_reply is unsupported", async () => {
    const service = makeService();
    const result = await createBase(service, { capabilityBits: { formalReply: "unsupported" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.record.autoConfirm).toBe("manual-only");
    expect(result.value.record.autoConfirmNotice).toBeTruthy();
  });

  it("accepts a music task whose brief lives only in the requirements", async () => {
    const storage = new MemoryAgentTaskStorage();
    const service = makeService(storage);
    const result = await service.createTask({
      kind: "music",
      promptText: "  ",
      requirementsText: "30 秒左右的轻快钢琴",
      targetProjectId: "proj-1",
      insertIntent: "library-only",
      capabilityBits: { formalReply: "supported" },
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.record.promptText).toBe("");
    // The blank-description record must survive a conservative reload.
    const reloaded = makeService(storage);
    await reloaded.ensureLoaded();
    expect((await reloaded.get(result.value.record.id)).ok).toBe(true);
  });

  it("still rejects a music task with neither description nor requirements", async () => {
    const service = makeService();
    expect(
      await service.createTask({
        kind: "music",
        promptText: "",
        targetProjectId: "proj-1",
        insertIntent: "library-only",
        capabilityBits: { formalReply: "supported" },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  it("rejects invalid inputs", async () => {
    const service = makeService();
    expect(await createBase(service, { kind: "video" as never })).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(await createBase(service, { promptText: "  " })).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(await createBase(service, { targetProjectId: "" })).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(await createBase(service, { insertIntent: "replace-all" as never })).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(await createBase(service, { requestId: " " })).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
  });

  it("maps storage failure to UNAVAILABLE", async () => {
    const service = makeService(new UnavailableStorage());
    const result = await createBase(service);
    expect(result).toMatchObject({ ok: false, code: "UNAVAILABLE" });
  });
});

describe("status flow", () => {
  it("walks queued → submitted → running → awaiting_import → done", async () => {
    const service = makeService();
    const created = await createBase(service);
    if (!created.ok) throw new Error("create failed");
    const id = created.value.record.id;

    const submitted = await service.markSubmitted(id, { autoConfirm: RECEIPT, now: NOW });
    expect(submitted.ok && submitted.value.status).toBe("submitted");
    if (!submitted.ok) return;
    expect(submitted.value.submittedAt).toBe(NOW);

    const running = await service.markRunning(id, { now: NOW });
    expect(running.ok && running.value.status).toBe("running");

    const awaiting = await service.markAwaitingImport(id, {
      resultPath: "C:\\media-root\\jobs\\x\\output\\a.wav",
      now: NOW,
    });
    expect(awaiting.ok && awaiting.value.status).toBe("awaiting_import");
    expect(awaiting.ok && awaiting.value.resultPath).toBe(
      "C:\\media-root\\jobs\\x\\output\\a.wav",
    );

    const done = await service.markDone(id, { resultMediaId: "media-9", now: NOW });
    expect(done.ok && done.value.status).toBe("done");
    expect(done.ok && done.value.resultMediaId).toBe("media-9");
    expect(done.ok && done.value.completedAt).toBe(NOW);
    // The artifact path found during awaiting_import is retained.
    expect(done.ok && done.value.resultPath).toBe("C:\\media-root\\jobs\\x\\output\\a.wav");

    const final = await service.get(id);
    expect(final.ok && final.value.revision).toBe(5);
  });

  it("rejects backward, same-status and post-terminal moves", async () => {
    const service = makeService();
    const created = await createBase(service);
    if (!created.ok) throw new Error("create failed");
    const id = created.value.record.id;
    await service.markSubmitted(id, { autoConfirm: RECEIPT, now: NOW });
    await service.markRunning(id, { now: NOW });

    expect(
      await service.markSubmitted(id, { autoConfirm: RECEIPT, now: NOW }),
    ).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
    expect(await service.markRunning(id, { now: NOW })).toMatchObject({
      ok: false,
      code: "INVALID_TRANSITION",
    });
    expect((await service.get(id)).ok).toBe(true);

    // Late ERROR receipt after done is frozen out.
    await service.markDone(id, { now: NOW });
    expect(
      await service.markError(id, { code: "LATE", message: "late error", now: NOW }),
    ).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
    const frozen = await service.get(id);
    expect(frozen.ok && frozen.value.status).toBe("done");
  });

  it("clears artifact references when a task fails mid-flight", async () => {
    const service = makeService();
    const created = await createBase(service);
    if (!created.ok) throw new Error("create failed");
    const id = created.value.record.id;
    await service.markSubmitted(id, { autoConfirm: RECEIPT, now: NOW });
    await service.markAwaitingImport(id, { resultPath: "C:\\x\\a.wav", now: NOW });

    const failed = await service.markError(id, {
      code: "IMPORT_FAILED",
      message: "文件已消失",
      now: NOW,
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.status).toBe("error");
    expect(failed.value.resultPath).toBeUndefined();
    expect(failed.value.error).toEqual({ code: "IMPORT_FAILED", message: "文件已消失" });
    expect(failed.value.failureReason).toBe("文件已消失");
  });

  it("records an optional cancel reason", async () => {
    const service = makeService();
    const created = await createBase(service);
    if (!created.ok) throw new Error("create failed");
    const cancelled = await service.markCancelled(created.value.record.id, {
      reason: "用户取消了回合",
      now: NOW,
    });
    expect(cancelled.ok && cancelled.value.status).toBe("cancelled");
    expect(cancelled.ok && cancelled.value.failureReason).toBe("用户取消了回合");
  });

  it("rejects awaiting_import without a result path", async () => {
    const service = makeService();
    const created = await createBase(service);
    if (!created.ok) throw new Error("create failed");
    await service.markSubmitted(created.value.record.id, { autoConfirm: RECEIPT, now: NOW });
    const result = await service.markAwaitingImport(created.value.record.id, {
      resultPath: "  ",
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });
});

describe("CAS", () => {
  it("rejects concurrent writers with CONFLICT and accepts the current revision", async () => {
    const service = makeService();
    const created = await createBase(service);
    if (!created.ok) throw new Error("create failed");
    const record = created.value.record;

    const stale = await service.markSubmitted(record.id, {
      autoConfirm: RECEIPT,
      expectedRevision: record.revision + 5,
      now: NOW,
    });
    expect(stale).toMatchObject({ ok: false, code: "CONFLICT" });

    const good = await service.markSubmitted(record.id, {
      autoConfirm: RECEIPT,
      expectedRevision: record.revision,
      now: NOW,
    });
    expect(good.ok && good.value.revision).toBe(record.revision + 1);
  });
});

describe("requestId lifecycle across retries", () => {
  it("retry mints a fresh requestId, bumps attempt, and retires the old key", async () => {
    const service = makeService();
    const created = await createBase(service, { requestId: "req_attempt0" });
    if (!created.ok) throw new Error("create failed");
    const original = created.value.record;
    await service.markSubmitted(original.id, { autoConfirm: RECEIPT, now: NOW });
    await service.markError(original.id, { code: "AGENT_FAILED", message: "超时", now: NOW });

    const retried = await service.retryTask(original.id, { now: NOW });
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.status).toBe("queued");
    expect(retried.value.attempt).toBe(1);
    expect(retried.value.requestId).not.toBe("req_attempt0");
    expect(retried.value.requestId).toMatch(/^req_/);
    expect(retried.value.error).toBeUndefined();
    expect(retried.value.submittedAt).toBeUndefined();

    // The dead attempt's requestId no longer resolves.
    expect(await service.getByRequestId("req_attempt0")).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    const live = await service.getByRequestId(retried.value.requestId);
    expect(live.ok && live.value.id).toBe(original.id);

    // Retry from done is not allowed.
    await service.markSubmitted(retried.value.id, { autoConfirm: RECEIPT, now: NOW });
    await service.markDone(retried.value.id, { now: NOW });
    expect(await service.retryTask(retried.value.id, { now: NOW })).toMatchObject({
      ok: false,
      code: "INVALID_TRANSITION",
    });
  });
});

describe("sanitizedInfo", () => {
  it("stores a redacted summary, never credentials or full paths", async () => {
    const service = makeService();
    const created = await createBase(service);
    if (!created.ok) throw new Error("create failed");
    const id = created.value.record.id;
    const result = await service.setSanitizedInfo(
      id,
      "Agent 1.0 generated C:\\Users\\u\\secret\\voice.wav with api_key=sk-secret123",
      { now: NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.sanitizedInfo ?? "";
    expect(info).not.toContain("C:\\Users\\u\\secret\\voice.wav");
    expect(info).not.toContain("sk-secret123");
    expect(info).toContain("Agent 1.0");
  });
});

describe("R1: submission without auto-confirm capability", () => {
  it("parks the task at submitted with an explicit notice and no receipt expectation", async () => {
    const service = makeService();
    const created = await createBase(service);
    if (!created.ok) throw new Error("create failed");
    const id = created.value.record.id;

    const submitted = await service.markSubmitted(id, { autoConfirm: MANUAL, now: NOW });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.status).toBe("submitted");
    expect(submitted.value.autoConfirm).toBe("manual-only");
    expect(submitted.value.autoConfirmNotice).toContain("无法自动确认");
  });

  it("treats the submission-time decision as authoritative (receipt clears a stale notice)", async () => {
    const service = makeService();
    // Created while the session lacked formal_reply: manual-only + notice.
    const created = await createBase(service, {
      capabilityBits: { formalReply: "unsupported" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.record.id;
    expect(created.value.record.autoConfirm).toBe("manual-only");
    expect(created.value.record.autoConfirmNotice).toBeTruthy();

    const submitted = await service.markSubmitted(id, { autoConfirm: RECEIPT, now: NOW });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.autoConfirm).toBe("receipt");
    expect(submitted.value.autoConfirmNotice).toBeUndefined();
  });
});

describe("R2: target project verification before import", () => {
  async function awaitingTask(service: AgentMediaTaskService) {
    const created = await createBase(service);
    if (!created.ok) throw new Error("create failed");
    const id = created.value.record.id;
    await service.markSubmitted(id, { autoConfirm: RECEIPT, now: NOW });
    await service.markAwaitingImport(id, { resultPath: "C:\\x\\a.wav", now: NOW });
    return id;
  }

  it("passes without mutation while the target project exists", async () => {
    const service = makeService();
    const id = await awaitingTask(service);
    const before = await service.get(id);
    const check = await service.verifyTargetProjectBeforeImport(id, ["proj-1", "proj-2"]);
    expect(check.ok && check.value.failedAsMissing).toBe(false);
    expect(check.ok && check.value.projectId).toBe("proj-1");
    const after = await service.get(id);
    if (!before.ok || !after.ok) return;
    expect(after.value.revision).toBe(before.value.revision);
    expect(after.value.status).toBe("awaiting_import");
  });

  it("fails the task honestly when the target project was deleted", async () => {
    const service = makeService();
    const id = await awaitingTask(service);
    const check = await service.verifyTargetProjectBeforeImport(id, ["other-project"]);
    expect(check.ok && check.value.failedAsMissing).toBe(true);
    const record = await service.get(id);
    if (!record.ok) return;
    expect(record.value.status).toBe("error");
    expect(record.value.error?.code).toBe("TARGET_PROJECT_MISSING");
    expect(record.value.failureReason).toContain("不会转投其他项目");
    expect(record.value.resultPath).toBeUndefined();
  });

  it("only applies to awaiting_import tasks", async () => {
    const service = makeService();
    const created = await createBase(service);
    if (!created.ok) throw new Error("create failed");
    const result = await service.verifyTargetProjectBeforeImport(
      created.value.record.id,
      ["proj-1"],
    );
    expect(result).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
  });
});

describe("CRUD, events and reload", () => {
  it("gets by id and requestId, removes, and reports alreadyGone", async () => {
    const service = makeService();
    const created = await createBase(service, { requestId: "req_lookup" });
    if (!created.ok) throw new Error("create failed");
    const record = created.value.record;

    expect((await service.get(record.id)).ok).toBe(true);
    expect(await service.get("amt_missing")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const byRequestId = await service.getByRequestId("req_lookup");
    expect(byRequestId.ok && byRequestId.value.id).toBe(record.id);

    const removed = await service.remove(record.id);
    expect(removed.ok && removed.value.alreadyGone).toBe(false);
    const again = await service.remove(record.id);
    expect(again.ok && again.value.alreadyGone).toBe(true);
    expect(await service.getByRequestId("req_lookup")).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("broadcasts a window event on every successful mutation", async () => {
    const service = makeService();
    let events = 0;
    const unsubscribe = subscribeAgentMediaTasks(() => {
      events += 1;
    });
    const created = await createBase(service);
    if (!created.ok) throw new Error("create failed");
    await service.markSubmitted(created.value.record.id, { autoConfirm: RECEIPT, now: NOW });
    await service.remove(created.value.record.id);
    expect(events).toBe(3);
    expect(typeof AGENT_MEDIA_TASKS_UPDATED_EVENT).toBe("string");
    unsubscribe();
  });

  it("reloads persisted records through a fresh service instance", async () => {
    const storage = new MemoryAgentTaskStorage();
    const first = makeService(storage);
    const created = await createBase(first, { requestId: "req_reload" });
    if (!created.ok) throw new Error("create failed");
    await first.markSubmitted(created.value.record.id, { autoConfirm: MANUAL, now: NOW });

    const second = makeService(storage);
    const reloaded = await second.list();
    expect(reloaded.ok && reloaded.value.tasks).toHaveLength(1);
    const byKey = await second.getByRequestId("req_reload");
    expect(byKey.ok && byKey.value.status).toBe("submitted");
    expect(byKey.ok && byKey.value.autoConfirm).toBe("manual-only");
  });

  it("quarantines unreadable rows instead of failing the load", async () => {
    const storage = new MemoryAgentTaskStorage();
    storage.rows.set("amt_newer", {
      id: "amt_newer",
      recordVersion: 99,
      requestId: "req_newer",
      kind: "tts",
      promptText: "x",
      status: "queued",
      targetProjectId: "p",
      insertIntent: "timeline",
      autoConfirm: "receipt",
      attempt: 0,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as AgentMediaTaskRecord);
    storage.rows.set("amt_broken", { id: "amt_broken", junk: true } as unknown as AgentMediaTaskRecord);

    const service = makeService(storage);
    const list = await service.list();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.tasks).toHaveLength(0);
    expect(list.value.unreadable.map((entry) => entry.id).sort()).toEqual([
      "amt_broken",
      "amt_newer",
    ]);
    // The newer record is skipped, never silently misread or dropped to users
    // as a task — and a valid task created afterwards still persists.
    const created = await createBase(service);
    expect(created.ok).toBe(true);
  });
});
