import { describe, expect, it } from "vitest";
import {
  applyTaskRetry,
  applyTaskStatusTransition,
  canRetryTask,
  canTransitionTaskStatus,
  isTerminalTaskStatus,
} from "./task-machine";
import type { AgentMediaTaskRecord, AgentMediaTaskStatus } from "./types";

const CHAIN: readonly AgentMediaTaskStatus[] = [
  "queued",
  "submitted",
  "running",
  "awaiting_import",
  "done",
];

function makeRecord(status: AgentMediaTaskStatus): AgentMediaTaskRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "amt_test",
    recordVersion: 1,
    requestId: "req_test",
    kind: "tts",
    promptText: "hello",
    status,
    targetProjectId: "proj-1",
    insertIntent: "timeline",
    autoConfirm: "receipt",
    attempt: 0,
    revision: 1,
    resultPath: "C:\\job\\output\\a.wav",
    resultMediaId: "media-1",
    insertedClipId: "clip-1",
    createdAt: now,
    updatedAt: now,
    submittedAt: status === "queued" ? undefined : now,
  };
}

describe("isTerminalTaskStatus", () => {
  it("marks done/error/cancelled as terminal", () => {
    expect(isTerminalTaskStatus("done")).toBe(true);
    expect(isTerminalTaskStatus("error")).toBe(true);
    expect(isTerminalTaskStatus("cancelled")).toBe(true);
    expect(isTerminalTaskStatus("queued")).toBe(false);
    expect(isTerminalTaskStatus("submitted")).toBe(false);
    expect(isTerminalTaskStatus("running")).toBe(false);
    expect(isTerminalTaskStatus("awaiting_import")).toBe(false);
  });
});

describe("canTransitionTaskStatus", () => {
  it("allows every strictly forward move in the chain", () => {
    for (let from = 0; from < CHAIN.length; from += 1) {
      for (let to = from + 1; to < CHAIN.length; to += 1) {
        expect(canTransitionTaskStatus(CHAIN[from], CHAIN[to])).toBe(true);
      }
    }
  });

  it("rejects same-status and backward moves", () => {
    for (let from = 0; from < CHAIN.length; from += 1) {
      for (let to = 0; to <= from; to += 1) {
        expect(canTransitionTaskStatus(CHAIN[from], CHAIN[to])).toBe(false);
      }
    }
  });

  it("allows error/cancelled from every non-terminal state", () => {
    for (const from of CHAIN.slice(0, -1)) {
      expect(canTransitionTaskStatus(from, "error")).toBe(true);
      expect(canTransitionTaskStatus(from, "cancelled")).toBe(true);
    }
  });

  it("freezes terminal states", () => {
    for (const from of ["done", "error", "cancelled"] as const) {
      for (const to of CHAIN) {
        expect(canTransitionTaskStatus(from, to)).toBe(false);
      }
      expect(canTransitionTaskStatus(from, "error")).toBe(false);
      expect(canTransitionTaskStatus(from, "cancelled")).toBe(false);
    }
  });
});

describe("applyTaskStatusTransition", () => {
  it("advances and stamps timestamps", () => {
    const now = "2026-06-01T12:00:00.000Z";
    const submitted = applyTaskStatusTransition(makeRecord("queued"), "submitted", {}, now);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.record.status).toBe("submitted");
    expect(submitted.record.submittedAt).toBe(now);
    expect(submitted.record.updatedAt).toBe(now);

    const done = applyTaskStatusTransition(submitted.record, "done", {}, now);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.record.completedAt).toBe(now);
  });

  it("carries artifact fields through forward moves (awaiting_import → done)", () => {
    const awaiting = applyTaskStatusTransition(makeRecord("running"), "awaiting_import", {
      resultPath: "C:\\job\\output\\take2.wav",
    });
    expect(awaiting.ok).toBe(true);
    if (!awaiting.ok) return;
    expect(awaiting.record.resultPath).toBe("C:\\job\\output\\take2.wav");

    const done = applyTaskStatusTransition(awaiting.record, "done", {
      resultMediaId: "media-2",
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    // The confirmed artifact path survives the final transition.
    expect(done.record.resultPath).toBe("C:\\job\\output\\take2.wav");
    expect(done.record.resultMediaId).toBe("media-2");
  });

  it("rejects same-status and backward moves", () => {
    expect(applyTaskStatusTransition(makeRecord("running"), "running").ok).toBe(false);
    expect(applyTaskStatusTransition(makeRecord("running"), "queued").ok).toBe(false);
    expect(applyTaskStatusTransition(makeRecord("awaiting_import"), "running").ok).toBe(false);
  });

  it("clears artifact references on error and records code + reason", () => {
    const result = applyTaskStatusTransition(makeRecord("running"), "error", {
      error: { code: "AGENT_FAILED", message: "provider failed" },
      failureReason: "provider failed",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe("error");
    expect(result.record.resultPath).toBeUndefined();
    expect(result.record.resultMediaId).toBeUndefined();
    expect(result.record.insertedClipId).toBeUndefined();
    expect(result.record.error).toEqual({ code: "AGENT_FAILED", message: "provider failed" });
    expect(result.record.failureReason).toBe("provider failed");
    expect(result.record.completedAt).toBeTruthy();
    // Non-artifact metadata survives for audit.
    expect(result.record.sanitizedInfo).toBeUndefined(); // was never set
    expect(result.record.targetProjectId).toBe("proj-1");
    expect(result.record.promptText).toBe("hello");
  });

  it("clears artifact references on cancelled and keeps an optional reason", () => {
    const withoutReason = applyTaskStatusTransition(makeRecord("awaiting_import"), "cancelled");
    expect(withoutReason.ok).toBe(true);
    if (!withoutReason.ok) return;
    expect(withoutReason.record.resultPath).toBeUndefined();
    expect(withoutReason.record.failureReason).toBeUndefined();

    const withReason = applyTaskStatusTransition(makeRecord("running"), "cancelled", {
      failureReason: "user cancelled the turn",
    });
    expect(withReason.ok).toBe(true);
    if (!withReason.ok) return;
    expect(withReason.record.failureReason).toBe("user cancelled the turn");
    expect(withReason.record.resultMediaId).toBeUndefined();
  });

  it("never moves a terminal record (late callbacks are rejected)", () => {
    expect(applyTaskStatusTransition(makeRecord("done"), "done").ok).toBe(false);
    expect(applyTaskStatusTransition(makeRecord("done"), "error").ok).toBe(false);
    expect(applyTaskStatusTransition(makeRecord("error"), "done").ok).toBe(false);
  });

  it("does not touch revision or attempt", () => {
    const result = applyTaskStatusTransition(makeRecord("queued"), "submitted");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.revision).toBe(1);
    expect(result.record.attempt).toBe(0);
  });
});

describe("retry", () => {
  it("re-arms an error task with a fresh requestId and attempt+1", () => {
    const failed = applyTaskStatusTransition(makeRecord("running"), "error", {
      error: { code: "X", message: "boom" },
      failureReason: "boom",
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(canRetryTask(failed.record)).toBe(true);

    const retried = applyTaskRetry(failed.record, "req_next", "2026-06-02T00:00:00.000Z");
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.record.status).toBe("queued");
    expect(retried.record.requestId).toBe("req_next");
    expect(retried.record.attempt).toBe(1);
    expect(retried.record.error).toBeUndefined();
    expect(retried.record.failureReason).toBeUndefined();
    expect(retried.record.resultPath).toBeUndefined();
    expect(retried.record.completedAt).toBeUndefined();
    expect(retried.record.submittedAt).toBeUndefined();
    expect(retried.record.createdAt).toBe(failed.record.createdAt);
  });

  it("also allows retry from cancelled but never from done or live states", () => {
    expect(canRetryTask(makeRecord("cancelled"))).toBe(true);
    expect(canRetryTask(makeRecord("done"))).toBe(false);
    expect(canRetryTask(makeRecord("running"))).toBe(false);
    expect(applyTaskRetry(makeRecord("done"), "req_x").ok).toBe(false);
    expect(applyTaskRetry(makeRecord("running"), "req_x").ok).toBe(false);
  });
});
