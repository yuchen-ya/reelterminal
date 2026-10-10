import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Project } from "@reelterminal/core";
import type { JobStatusView } from "@reelterminal/agent-facade";

export interface DurableTaskInput {
  readonly jobId: string;
  readonly kind: "export" | "analysis";
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sourceRevision: number;
  readonly inputProject: Project;
  readonly parameters: unknown;
}

export interface DurableTaskRecord extends DurableTaskInput {
  readonly formatVersion: 1;
  readonly status: JobStatusView;
}

const terminalStates = new Set(["done", "error", "cancelled"]);
const taskStates = new Set(["queued", "running", "done", "error", "cancelled"]);

/** A fixed task input and its latest status survive a desktop restart. */
export class DurableTaskLedger {
  private readonly records = new Map<string, DurableTaskRecord>();

  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
    for (const file of readdirSync(root)) {
      if (!file.endsWith(".json")) continue;
      try {
        const record = JSON.parse(readFileSync(path.join(root, file), "utf8")) as DurableTaskRecord;
        if (record.formatVersion !== 1 || record.inputProject?.id !== record.projectId ||
            record.status?.jobId !== record.jobId || record.status.kind !== record.kind ||
            !taskStates.has(record.status.state) || !Number.isSafeInteger(record.sourceRevision) || record.sourceRevision < 0 || !record.workspaceId ||
            file !== `${this.validId(record.jobId)}.json`) {
          throw new Error(`Invalid durable task record: ${file}`);
        }
        if (terminalStates.has(record.status.state)) {
          this.records.set(record.jobId, record);
        } else {
          this.commit({ ...record, status: { ...record.status, state: "error",
            artifact: null, result: null, deliveredTo: null,
            error: { code: "INTERRUPTED", message: "Desktop restarted before this task completed. Its fixed input is retained; start a new task to retry." },
            updatedAt: new Date().toISOString() } });
        }
      } catch (error) {
        // One damaged record file must not wedge every later live task, so
        // quarantine it beside the others and keep loading the rest.
        renameSync(path.join(root, file), path.join(root, `${file}.corrupt-${Date.now()}`));
        console.warn(`[task-ledger] quarantined damaged task record ${file}:`, error);
      }
    }
  }

  private validId(jobId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) throw new Error("Invalid task ID");
    return jobId;
  }

  private commit(record: DurableTaskRecord): void {
    const target = path.join(this.root, `${this.validId(record.jobId)}.json`);
    const temporary = `${target}.tmp`;
    const serialized = JSON.stringify(record);
    writeFileSync(temporary, serialized, { encoding: "utf8", flush: true });
    renameSync(temporary, target);
    this.records.set(record.jobId, JSON.parse(serialized) as DurableTaskRecord);
  }

  begin(input: DurableTaskInput): void {
    if (this.records.has(input.jobId)) throw new Error(`Task already exists: ${input.jobId}`);
    if (input.inputProject.id !== input.projectId) throw new Error("Task input project does not match its target");
    const now = new Date().toISOString();
    this.commit({ ...input, formatVersion: 1, status: {
      jobId: input.jobId, kind: input.kind, sourceRevision: input.sourceRevision,
      state: "queued", progress: null, artifact: null, result: null, error: null,
      deliveredTo: null, deliveryError: null, route: null,
      upscalingRequestedButInactive: false, cancelRequested: false,
      createdAt: now, updatedAt: now,
    } });
  }

  update(status: JobStatusView): void {
    const record = this.records.get(status.jobId);
    if (!record) throw new Error(`Unknown durable task: ${status.jobId}`);
    if (status.sourceRevision !== record.sourceRevision || status.kind !== record.kind ||
        !taskStates.has(status.state)) {
      throw new Error("Task status does not match its fixed input");
    }
    this.commit({ ...record, status });
  }

  get(jobId: string): DurableTaskRecord | null {
    const record = this.records.get(jobId);
    return record ? structuredClone(record) : null;
  }

  getState(jobId: string): JobStatusView["state"] | null {
    return this.records.get(jobId)?.status.state ?? null;
  }

  list(): DurableTaskRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }
}
