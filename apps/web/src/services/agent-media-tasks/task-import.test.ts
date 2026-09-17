/**
 * Controller tests for artifact receiving: receipt matching (RESULT / ERROR
 * / manual-only), import gating (project guard, real existence oracle,
 * artifact presence), idempotent imports, restart recovery, and manual
 * confirmation.
 */
import { describe, expect, it } from "vitest";
import {
  AgentMediaTaskService,
} from "./agent-media-task-service";
import { decideTaskAutoConfirmation } from "./auto-confirm";
import type { AgentTaskStorage } from "./storage";
import type { AgentMediaTaskRecord } from "./types";
import { createReceiptCorrelator } from "./receipt-correlator";
import type { ConversationEventLike } from "./receipt-correlator";
import {
  confirmTaskArtifactManually,
  importAwaitingTask,
  markTaskFailedManually,
  recoverInterruptedTasks,
  reconcileAwaitingImportTargets,
  type AgentTaskRuntimeDeps,
} from "./task-import";

/** In-memory storage standing in for IndexedDB. */
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

interface ImportCall {
  readonly path: string;
  readonly idempotencyKey: string;
}

interface RuntimeHarnessOptions {
  readonly currentProjectId?: string | null;
  readonly importOutcome?:
    | { readonly ok: true; readonly mediaId: string }
    | { readonly ok: false; readonly code: string; readonly message: string };
  readonly checkProjectStatus?: "exists" | "missing" | "unknown";
  readonly artifactPresent?: boolean | null;
  readonly scannedFiles?: readonly {
    path: string;
    name: string;
    sizeBytes: number;
    lastModifiedMs: number;
  }[];
}

function buildHarness(options: RuntimeHarnessOptions = {}): {
  service: AgentMediaTaskService;
  deps: AgentTaskRuntimeDeps;
  importCalls: ImportCall[];
} {
  const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
  const importCalls: ImportCall[] = [];
  const importOutcome = options.importOutcome ?? {
    ok: true as const,
    mediaId: "media-1",
  };
  const deps: AgentTaskRuntimeDeps = {
    service,
    getCurrentProjectId: () =>
      options.currentProjectId === undefined
        ? "proj-1"
        : options.currentProjectId,
    importArtifact: async (args) => {
      importCalls.push({ path: args.path, idempotencyKey: args.idempotencyKey });
      return importOutcome.ok
        ? {
            ok: true,
            mediaId: importOutcome.mediaId,
            name: "voice.wav",
            revision: 7,
            replayed: false,
          }
        : { ok: false, code: importOutcome.code, message: importOutcome.message };
    },
    scanOutput: async () => ({
      files:
        options.scannedFiles ??
        [
          {
            path: "C:\\ws\\jobs\\amt_x\\output\\scanned.wav",
            name: "scanned.wav",
            sizeBytes: 1,
            lastModifiedMs: 5,
          },
        ],
    }),
    artifactExists: async () =>
      options.artifactPresent === undefined ? true : options.artifactPresent,
    checkProject: async () => ({
      status: options.checkProjectStatus ?? "exists",
    }),
  };
  return { service, deps, importCalls };
}

function agentMessageEvent(
  sequence: number,
  text: string,
): ConversationEventLike {
  return {
    type: "session_update",
    sequence,
    update: {
      sessionUpdate: "agent_message",
      content: [{ type: "text", text }],
    },
  };
}

/**
 * Correlator installed before any traffic (the app-start pattern): start()
 * marks the empty store as seen, receipts arrive afterwards.
 */
function makeLiveCorrelator(deps: AgentTaskRuntimeDeps) {
  const updates: ConversationEventLike[] = [];
  const correlator = createReceiptCorrelator({
    ...deps,
    getUpdates: () => updates,
  });
  correlator.start();
  return {
    receive: (sequence: number, text: string) => {
      updates.push(agentMessageEvent(sequence, text));
    },
    poll: () => correlator.poll(),
  };
}

async function createSubmittedTask(
  service: AgentMediaTaskService,
  overrides: {
    readonly capabilityBits?: { formalReply: "supported" | "unsupported" };
    readonly recommendedRoot?: string | null;
    readonly targetProjectId?: string;
    readonly now?: string;
  } = {},
): Promise<AgentMediaTaskRecord> {
  const now = overrides.now;
  const created = await service.createTask({
    kind: "tts",
    promptText: "欢迎收听本期节目。",
    targetProjectId: overrides.targetProjectId ?? "proj-1",
    targetProjectName: "Demo",
    insertIntent: "timeline",
    capabilityBits: overrides.capabilityBits ?? { formalReply: "supported" },
    recommendedRoot:
      overrides.recommendedRoot === undefined
        ? "C:\\ws"
        : overrides.recommendedRoot,
    ...(now !== undefined ? { now } : {}),
  });
  if (!created.ok) throw new Error(created.message);
  const submitted = await service.markSubmitted(created.value.record.id, {
    autoConfirm: decideTaskAutoConfirmation(
      overrides.capabilityBits ?? { formalReply: "supported" },
    ),
    ...(now !== undefined ? { now } : {}),
  });
  if (!submitted.ok) throw new Error(submitted.message);
  return submitted.value;
}

describe("receipt correlator (RESULT)", () => {
  it("advances a submitted receipt-mode task to done and imports once", async () => {
    const { service, deps, importCalls } = buildHarness();
    const record = await createSubmittedTask(service);
    const live = makeLiveCorrelator(deps);

    live.receive(
      1,
      `openreel-task:${record.requestId} RESULT C:\\ws\\jobs\\${record.id}\\output\\voice.wav`,
    );
    await live.poll();

    const after = await service.get(record.id);
    expect(after.ok && after.value.status).toBe("done");
    expect(after.ok && after.value.resultMediaId).toBe("media-1");
    expect(after.ok && after.value.resultPath).toBe(
      `C:\\ws\\jobs\\${record.id}\\output\\voice.wav`,
    );
    expect(importCalls).toHaveLength(1);
    expect(importCalls[0]?.idempotencyKey).toBe(record.requestId);
  });

  it("does not replay events that already existed at install time", async () => {
    const { service, deps, importCalls } = buildHarness();
    const record = await createSubmittedTask(service);
    const updates: ConversationEventLike[] = [
      agentMessageEvent(1, `openreel-task:${record.requestId} RESULT C:\\a.wav`),
    ];
    const correlator = createReceiptCorrelator({ ...deps, getUpdates: () => updates });
    correlator.start();
    await correlator.poll();

    const after = await service.get(record.id);
    expect(after.ok && after.value.status).toBe("submitted");
    expect(importCalls).toHaveLength(0);
  });

  it("ignores a duplicate receipt after the task reached a terminal state", async () => {
    const { service, deps, importCalls } = buildHarness();
    const record = await createSubmittedTask(service);
    const live = makeLiveCorrelator(deps);

    live.receive(1, `openreel-task:${record.requestId} RESULT C:\\a.wav`);
    live.receive(2, `openreel-task:${record.requestId} RESULT C:\\a.wav`);
    await live.poll();

    // A truly late receipt, after the task already reached done.
    live.receive(3, `openreel-task:${record.requestId} RESULT C:\\a.wav`);
    await live.poll();

    expect(importCalls).toHaveLength(1);
    const after = await service.get(record.id);
    expect(after.ok && after.value.status).toBe("done");
  });

  it("falls back to the newest scan candidate when the receipt has no path", async () => {
    const { service, deps, importCalls } = buildHarness();
    const record = await createSubmittedTask(service);
    const scanningDeps: AgentTaskRuntimeDeps = {
      ...deps,
      scanOutput: async () => ({
        files: [
          { path: "C:\\ws\\new.wav", name: "new.wav", sizeBytes: 1, lastModifiedMs: 9 },
          { path: "C:\\ws\\old.wav", name: "old.wav", sizeBytes: 1, lastModifiedMs: 1 },
        ],
      }),
    };
    const live = makeLiveCorrelator(scanningDeps);
    live.receive(1, `openreel-task:${record.requestId} RESULT`);
    await live.poll();

    const after = await service.get(record.id);
    expect(after.ok && after.value.resultPath).toBe("C:\\ws\\new.wav");
    expect(importCalls[0]?.path).toBe("C:\\ws\\new.wav");
  });

  it("fails honestly on a path-less RESULT with no output directory", async () => {
    const { service, deps, importCalls } = buildHarness();
    const record = await createSubmittedTask(service, {
      recommendedRoot: null,
    });
    const live = makeLiveCorrelator(deps);
    live.receive(1, `openreel-task:${record.requestId} RESULT`);
    await live.poll();

    const after = await service.get(record.id);
    expect(after.ok && after.value.status).toBe("error");
    expect(after.ok && after.value.error?.code).toBe("NO_ARTIFACT_FILE");
    expect(importCalls).toHaveLength(0);
  });
});

describe("receipt correlator (ERROR)", () => {
  it("marks the task failed with a sanitized reason", async () => {
    const { service, deps } = buildHarness();
    const record = await createSubmittedTask(service);
    const live = makeLiveCorrelator(deps);
    live.receive(
      1,
      `openreel-task:${record.requestId} ERROR 生成失败：C:\\secret\\key.wav 不可写`,
    );
    await live.poll();

    const after = await service.get(record.id);
    expect(after.ok && after.value.status).toBe("error");
    expect(after.ok && after.value.error?.code).toBe("AGENT_REPORTED_ERROR");
    expect(after.ok && after.value.failureReason).not.toContain("C:\\secret");
  });
});

describe("receipt correlator (manual-only and unknown requestIds)", () => {
  it("never auto-advances a manual-only task", async () => {
    const { service, deps, importCalls } = buildHarness();
    const record = await createSubmittedTask(service, {
      capabilityBits: { formalReply: "unsupported" },
    });
    expect(record.autoConfirm).toBe("manual-only");
    const live = makeLiveCorrelator(deps);
    live.receive(1, `openreel-task:${record.requestId} RESULT C:\\a.wav`);
    await live.poll();

    const after = await service.get(record.id);
    expect(after.ok && after.value.status).toBe("submitted");
    expect(importCalls).toHaveLength(0);
  });

  it("ignores receipts whose requestId resolves to no task", async () => {
    const { service, deps } = buildHarness();
    await createSubmittedTask(service);
    const live = makeLiveCorrelator(deps);
    live.receive(1, "openreel-task:req_unknown RESULT C:\\a.wav");
    await live.poll();

    const after = await service.list();
    const statuses = after.ok ? after.value.tasks.map((task) => task.status) : [];
    expect(statuses).toEqual(["submitted"]);
  });
});

describe("importAwaitingTask guards", () => {
  async function createAwaiting(
    service: AgentMediaTaskService,
  ): Promise<AgentMediaTaskRecord> {
    const record = await createSubmittedTask(service);
    const parked = await service.markAwaitingImport(record.id, {
      resultPath: "C:\\ws\\jobs\\amt_x\\output\\voice.wav",
    });
    if (!parked.ok) throw new Error(parked.message);
    return parked.value;
  }

  it("keeps the task awaiting when another project is open (no import)", async () => {
    const { service, deps, importCalls } = buildHarness({
      currentProjectId: "proj-2",
    });
    const record = await createAwaiting(service);
    const outcome = await importAwaitingTask(record.id, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("PROJECT_MISMATCH");
    const after = await service.get(record.id);
    expect(after.ok && after.value.status).toBe("awaiting_import");
    expect(importCalls).toHaveLength(0);
  });

  it("fails the task for real when the target project is gone (N1 oracle)", async () => {
    const { service, deps, importCalls } = buildHarness({
      checkProjectStatus: "missing",
    });
    const record = await createAwaiting(service);
    const outcome = await importAwaitingTask(record.id, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("TARGET_PROJECT_MISSING");
    const after = await service.get(record.id);
    expect(after.ok && after.value.status).toBe("error");
    expect(after.ok && after.value.resultPath).toBeUndefined();
    expect(after.ok && after.value.resultMediaId).toBeUndefined();
    expect(importCalls).toHaveLength(0);
  });

  it("continues without a destructive verdict when the oracle is unknown", async () => {
    const { service, deps, importCalls } = buildHarness({
      checkProjectStatus: "unknown",
    });
    const record = await createAwaiting(service);
    const outcome = await importAwaitingTask(record.id, deps);
    expect(outcome.ok).toBe(true);
    expect(importCalls).toHaveLength(1);
  });

  it("skips the import when the media is already on the record", async () => {
    const { service, deps, importCalls } = buildHarness();
    const record = await createAwaiting(service);
    const first = await importAwaitingTask(record.id, deps);
    expect(first.ok).toBe(true);
    const second = await importAwaitingTask(record.id, deps);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.skipped).toBe(true);
    expect(importCalls).toHaveLength(1);
  });

  it("fails the task when the artifact file has vanished", async () => {
    const { service, deps, importCalls } = buildHarness({
      artifactPresent: false,
    });
    const record = await createAwaiting(service);
    const outcome = await importAwaitingTask(record.id, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("ARTIFACT_MISSING");
    const after = await service.get(record.id);
    expect(after.ok && after.value.status).toBe("error");
    expect(importCalls).toHaveLength(0);
  });

  it("lands the facade error on the record as a retryable failure", async () => {
    const { service, deps } = buildHarness({
      importOutcome: {
        ok: false,
        code: "UNSUPPORTED",
        message: "live collaboration is disabled",
      },
    });
    const record = await createAwaiting(service);
    const outcome = await importAwaitingTask(record.id, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("UNSUPPORTED");
    const after = await service.get(record.id);
    expect(after.ok && after.value.status).toBe("error");
    expect(after.ok && after.value.error?.code).toBe("UNSUPPORTED");
  });

  it("collapses concurrent triggers into one import", async () => {
    const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
    const importCalls: ImportCall[] = [];
    let releaseImport!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const deps: AgentTaskRuntimeDeps = {
      service,
      getCurrentProjectId: () => "proj-1",
      // Stubs keep this test off the real IndexedDB oracle (the global test
      // setup mocks indexedDB.open with a never-settling request).
      checkProject: async () => ({ status: "unknown" }),
      artifactExists: async () => true,
      importArtifact: async (args) => {
        importCalls.push({ path: args.path, idempotencyKey: args.idempotencyKey });
        await gate;
        return { ok: true, mediaId: "media-1", name: "v.wav", revision: 1, replayed: false };
      },
    };
    const record = await createSubmittedTask(service);
    await service.markAwaitingImport(record.id, { resultPath: "C:\\a.wav" });

    const first = importAwaitingTask(record.id, deps);
    const second = await importAwaitingTask(record.id, deps);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("IMPORT_IN_PROGRESS");
    releaseImport();
    const settled = await first;
    expect(settled.ok).toBe(true);
    expect(importCalls).toHaveLength(1);
  });
});

describe("restart recovery", () => {
  it("fails mid-flight tasks as interrupted and keeps importable artifacts", async () => {
    const { service, deps } = buildHarness();
    const restartAt = "2026-01-01T00:00:00.000Z";
    const submitted = await createSubmittedTask(service, { now: restartAt });
    const running = await createSubmittedTask(service, { now: restartAt });
    await service.markRunning(running.id);

    const record = await createSubmittedTask(service, { now: restartAt });
    await service.markAwaitingImport(record.id, { resultPath: "C:\\keep.wav" });

    // Created after the recovery cutoff: belongs to the running session.
    const createdLate = await createSubmittedTask(service, {
      now: "2099-01-01T00:00:00.000Z",
    });

    const result = await recoverInterruptedTasks(deps, "2026-06-01T00:00:00.000Z");
    expect([...result.interrupted].sort()).toEqual(
      [submitted.id, running.id].sort(),
    );
    expect(result.artifactMissing).toEqual([]);

    const keptAlive = await service.get(record.id);
    expect(keptAlive.ok && keptAlive.value.status).toBe("awaiting_import");

    const untouched = await service.get(createdLate.id);
    expect(untouched.ok && untouched.value.status).toBe("submitted");

    const interruptedRecord = await service.get(submitted.id);
    expect(interruptedRecord.ok && interruptedRecord.value.error?.code).toBe(
      "APP_RESTART",
    );
  });

  it("fails an awaiting artifact that no longer exists, with a reason", async () => {
    const { service, deps } = buildHarness({ artifactPresent: false });
    const record = await createSubmittedTask(service);
    await service.markAwaitingImport(record.id, { resultPath: "C:\\gone.wav" });

    const result = await recoverInterruptedTasks(deps);
    expect(result.artifactMissing).toEqual([record.id]);
    const after = await service.get(record.id);
    expect(after.ok && after.value.error?.code).toBe("ARTIFACT_MISSING");
  });
});

describe("reconcileAwaitingImportTargets", () => {
  it("fails awaiting tasks whose target project no longer exists", async () => {
    const { service, deps } = buildHarness({ checkProjectStatus: "missing" });
    const record = await createSubmittedTask(service);
    await service.markAwaitingImport(record.id, { resultPath: "C:\\a.wav" });

    const result = await reconcileAwaitingImportTargets(deps);
    expect(result.checked).toBe(1);
    expect(result.failedAsMissing).toEqual([record.id]);
    const after = await service.get(record.id);
    expect(after.ok && after.value.status).toBe("error");
    expect(after.ok && after.value.resultPath).toBeUndefined();
  });
});

describe("manual confirmation (manual-only flow)", () => {
  it("scans the precast directory, parks awaiting, imports, and finishes", async () => {
    const { service, deps, importCalls } = buildHarness();
    const record = await createSubmittedTask(service, {
      capabilityBits: { formalReply: "unsupported" },
    });

    const outcome = await confirmTaskArtifactManually(record.id, deps);
    expect(outcome.ok).toBe(true);
    expect(importCalls).toHaveLength(1);
    const after = await service.get(record.id);
    expect(after.ok && after.value.status).toBe("done");
    expect(after.ok && after.value.resultPath).toBe(
      "C:\\ws\\jobs\\amt_x\\output\\scanned.wav",
    );
  });

  it("changes nothing when the scan finds no artifact", async () => {
    const { service, deps, importCalls } = buildHarness({
      scannedFiles: [],
    });
    const record = await createSubmittedTask(service, {
      capabilityBits: { formalReply: "unsupported" },
    });

    const outcome = await confirmTaskArtifactManually(record.id, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("NO_ARTIFACT_FILE");
    const after = await service.get(record.id);
    expect(after.ok && after.value.status).toBe("submitted");
    expect(importCalls).toHaveLength(0);
  });

  it("marks a manual failure with an honest reason", async () => {
    const { service, deps } = buildHarness();
    const record = await createSubmittedTask(service, {
      capabilityBits: { formalReply: "unsupported" },
    });

    const outcome = await markTaskFailedManually(record.id, deps);
    expect(outcome.ok).toBe(true);
    const after = await service.get(record.id);
    expect(after.ok && after.value.status).toBe("error");
    expect(after.ok && after.value.error?.code).toBe("MANUAL_MARKED_FAILED");
  });
});
