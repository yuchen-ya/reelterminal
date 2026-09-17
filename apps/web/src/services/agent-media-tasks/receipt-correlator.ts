/**
 * Receipt correlator: watches the external Agent conversation's display
 * event stream and advances the matching task when a receipt line arrives.
 *
 * The correlator is the only automatic consumer of receipts; manual-only
 * tasks are deliberately left alone — the correlator skips them before any
 * mutation, so a human confirms them from the task panel. Terminal and
 * already-advanced states short-circuit before any mutation, so repeated
 * and late receipts are inert by construction.
 */

import type { AgentMediaTaskService } from "./agent-media-task-service";
import type { AgentMediaTaskRecord } from "./types";
import { isTerminalTaskStatus } from "./task-machine";
import { sanitizeGenerationInfo } from "./sanitize";
import { agentMessageText, parseTaskReceipts, pickArtifactFromScan } from "./receipts";
import type { TaskReceipt } from "./receipts";
import { importAwaitingTask } from "./task-import";
import type { AgentTaskRuntimeDeps } from "./task-import";
import { scanTaskOutputDirectory } from "./desktop-channel";

/** Structural subset of a conversation display event. */
export interface ConversationEventLike {
  readonly type: string;
  readonly sequence: number;
  readonly update?: {
    readonly sessionUpdate?: string;
    readonly content?: unknown;
  };
}

export interface ReceiptCorrelatorDeps extends AgentTaskRuntimeDeps {
  /** Conversation display events (any order; only `sequence` matters). */
  readonly getUpdates: () => readonly ConversationEventLike[];
}

export interface ReceiptCorrelator {
  /** Mark events already in the store at install time as seen. */
  start(): void;
  /** Process unseen events; resolves once settling work has been kicked off. */
  poll(): Promise<number>;
}

function bestEffortMarkRunning(
  service: AgentMediaTaskService,
  taskId: string,
): Promise<void> {
  // Running is a cosmetic forward step; races with receipts that already
  // moved further are tolerated silently.
  return service
    .markRunning(taskId)
    .then(() => undefined, () => undefined);
}

export function createReceiptCorrelator(
  deps: ReceiptCorrelatorDeps,
): ReceiptCorrelator {
  const { service, getUpdates } = deps;
  const scanOutputDir = deps.scanOutput ?? scanTaskOutputDirectory;
  let lastSequence = 0;

  const resolveArtifactPath = async (
    receipt: TaskReceipt,
    outputDirectory: string | undefined,
  ): Promise<{ ok: true; path: string } | { ok: false; message: string }> => {
    if (receipt.detail) return { ok: true, path: receipt.detail };
    if (!outputDirectory) {
      return { ok: false, message: "任务回执未携带产物路径，也没有预铸产物目录" };
    }
    const scanned = await scanOutputDir(outputDirectory);
    const picked = pickArtifactFromScan(scanned);
    return picked.ok
      ? { ok: true, path: picked.path }
      : { ok: false, message: "任务回执未携带产物路径，且预铸产物目录中没有可导入的音频文件" };
  };

  const handleReceipt = async (
    record: AgentMediaTaskRecord,
    receipt: TaskReceipt,
  ): Promise<void> => {
    // Manual-only tasks are never auto-advanced, whatever channel a receipt
    // line arrives on (agent_message, or a chunk from a streaming session);
    // a human confirms them from the panel instead.
    if (record.autoConfirm === "manual-only") return;
    // Terminal freeze + already-advanced states: late or duplicate receipts
    // must not re-trigger import or overwrite an honest error.
    if (isTerminalTaskStatus(record.status)) return;

    await bestEffortMarkRunning(service, record.id);

    if (receipt.verdict === "ERROR") {
      const reason =
        sanitizeGenerationInfo(receipt.detail) || "外部智能体报告任务失败";
      await service.markError(record.id, {
        code: "AGENT_REPORTED_ERROR",
        message: reason,
      });
      return;
    }

    const resolved = await resolveArtifactPath(receipt, record.outputDirectory);
    if (!resolved.ok) {
      await service.markError(record.id, {
        code: "NO_ARTIFACT_FILE",
        message: resolved.message,
      });
      return;
    }
    const parked = await service.markAwaitingImport(record.id, {
      resultPath: resolved.path,
    });
    if (!parked.ok) return; // A racing transition won; nothing to advance.
    await importAwaitingTask(record.id, deps);
  };

  return {
    start() {
      let max = 0;
      for (const event of getUpdates()) {
        if (event.sequence > max) max = event.sequence;
      }
      lastSequence = max;
    },

    async poll() {
      const updates = getUpdates();
      const pending = updates
        .filter((event) => event.sequence > lastSequence)
        .sort((first, second) => first.sequence - second.sequence);
      if (pending.length === 0) return 0;
      lastSequence = pending[pending.length - 1]!.sequence;

      const settling: Array<Promise<unknown>> = [];
      for (const event of pending) {
        if (event.type !== "session_update") continue;
        const update = event.update;
        if (!update) continue;
        if (
          update.sessionUpdate !== "agent_message" &&
          update.sessionUpdate !== "agent_message_chunk"
        ) {
          continue;
        }
        const text = agentMessageText(update.content);
        for (const receipt of parseTaskReceipts(text)) {
          const loaded = await service.getByRequestId(receipt.requestId);
          if (!loaded.ok) continue; // Not a task this renderer minted.
          settling.push(handleReceipt(loaded.value, receipt));
        }
      }
      await Promise.all(settling);
      return settling.length;
    },
  };
}
