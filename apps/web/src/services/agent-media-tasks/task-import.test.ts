/** Tests for guarded artifact import and manual confirmation of saved tasks. */
import { describe, expect, it } from "vitest";
import {
  AgentMediaTaskService,
} from "./agent-media-task-service";
import { decideTaskAutoConfirmation } from "./auto-confirm";
import type { AgentTaskStorage } from "./storage";
import type { AgentMediaTaskRecord } from "./types";
import {
  confirmTaskArtifactManually,
  importAwaitingTask,
  markTaskFailedManually,
  type AgentTaskActionDeps,
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
  deps: AgentTaskActionDeps;
  importCalls: ImportCall[];
} {
  const service = new AgentMediaTaskService(new MemoryAgentTaskStorage());
  const importCalls: ImportCall[] = [];
  const importOutcome = options.importOutcome ?? {
    ok: true as const,
    mediaId: "media-1",
  };
  const deps: AgentTaskActionDeps = {
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

  it("lands the facade error on the saved task record", async () => {
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
    const deps: AgentTaskActionDeps = {
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
