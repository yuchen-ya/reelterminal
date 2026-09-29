import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultOutputDirectory, type FacadeResult } from "./client";

const LARGE_RESULT_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectFields<T>(result: FacadeResult<T>, fields: readonly string[]): unknown {
  if (!result.ok) return result;
  const selected: Record<string, unknown> = {};
  const mandatory = new Set([
    "revision", "projectRevision", "sourceRevision", "contextRevision", "identity",
    "projectId", "projectEpoch", "expectedRevision", "expectedContextRevision",
    "cursor", "nextCursor", "hasMore", "offset", "limit", "total", "count",
  ]);
  if (isRecord(result.value)) {
    for (const key of mandatory) {
      if (Object.prototype.hasOwnProperty.call(result.value, key)) selected[key] = result.value[key];
    }
  }
  for (const field of fields) {
    if (field === "ok") {
      selected.ok = true;
      continue;
    }
    if (field === "value") {
      selected.value = result.value;
      continue;
    }
    const keys = field.split(".").filter(Boolean);
    let from: unknown = result.value;
    for (const key of keys) {
      if (!isRecord(from) || !Object.prototype.hasOwnProperty.call(from, key)) {
        from = undefined;
        break;
      }
      from = from[key];
    }
    if (from !== undefined) selected[field] = from;
  }
  return { ok: true, value: selected };
}

function atomicWrite(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, data, { encoding: "utf8", flag: "wx" });
  renameSync(temp, file);
}

export function formatResult<T>(
  result: FacadeResult<T>,
  options: {
    readonly human: boolean;
    readonly compact: boolean;
    readonly outputFields?: readonly string[];
    readonly outputFile?: string;
  },
): string {
  let value: unknown = options.outputFields?.length ? projectFields(result, options.outputFields) : result;
  let serialized = JSON.stringify(value);
  const explicitPath = options.outputFile === undefined ? undefined : path.resolve(options.outputFile);
  if (explicitPath !== undefined || (result.ok && Buffer.byteLength(serialized) >= LARGE_RESULT_BYTES)) {
    const file = explicitPath ?? path.join(defaultOutputDirectory(), `result-${Date.now()}-${randomUUID()}.json`);
    const written = `${JSON.stringify(result, null, 2)}\n`;
    atomicWrite(file, written);
    const bytes = Buffer.byteLength(written);
    const sha256 = createHash("sha256").update(written).digest("hex");
    const receipt = {
      savedTo: file,
      sizeBytes: bytes,
      sha256,
      summary: result.ok && options.outputFields?.length ? value : summarize(result),
    };
    value = result.ok ? { ok: true, value: receipt } : { ok: false, error: { ...result.error, ...receipt } };
    serialized = JSON.stringify(value);
  }
  if (options.human && !options.compact) {
    return JSON.stringify(value, null, 2);
  }
  return serialized;
}

function summarize(result: FacadeResult<unknown>): unknown {
  if (!result.ok) return result;
  const value = result.value;
  if (!isRecord(value)) return { type: typeof value };
  const summary: Record<string, unknown> = {};
  for (const key of ["revision", "contextRevision", "jobId", "state", "createdIds", "mediaId", "count", "total"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) summary[key] = value[key];
  }
  if (Object.keys(summary).length === 0) summary.keys = Object.keys(value).slice(0, 32);
  return summary;
}

export function successResult<T>(value: T): FacadeResult<T> {
  return { ok: true, value };
}

export function compactContextResult(result: FacadeResult<unknown>): FacadeResult<unknown> {
  if (!result.ok || !isRecord(result.value)) return result;
  const value = result.value;
  const keys = [
    "mode", "contextAvailable", "projectRevision", "contextRevision", "playheadSeconds",
    "selectedClipIds", "selectedTextIds", "selectedMediaIds", "timeRange", "canvasPoint", "identity", "references", "requirements",
  ];
  const compact: Record<string, unknown> = {};
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(value, key)) compact[key] = value[key];
  return { ...result, value: compact };
}
