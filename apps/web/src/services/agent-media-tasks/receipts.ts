/**
 * Pure parsing for task receipt lines.
 *
 * A completed task is reported by the external Agent as one plain-text line
 * inside its reply (an `agent_message` update): the precast marker, a
 * RESULT/ERROR verdict, and one trailing detail field. Parsing is
 * line-based and defensive: only the text after the marker on the same line
 * is treated as detail, so an agent cannot inject extra instructions into
 * product state by reformatting its reply.
 */

import { AGENT_TASK_RECEIPT_PREFIX } from "./prompt-composer";

export type TaskReceiptVerdict = "RESULT" | "ERROR";

export interface TaskReceipt {
  readonly requestId: string;
  readonly verdict: TaskReceiptVerdict;
  /** Trailing same-line text: the artifact path (RESULT) / reason (ERROR). */
  readonly detail: string;
}

/** One line, bounded so a pathological reply cannot stall matching. */
const RECEIPT_LINE_PATTERN = new RegExp(
  `^${escapeRegExp(AGENT_TASK_RECEIPT_PREFIX)}(\\S+)[ \\t]+(RESULT|ERROR)(?:[ \\t]+(.*))?$`,
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MAX_RECEIPT_DETAIL_LENGTH = 1024;

/**
 * Extract every receipt line from one message text, in order of appearance.
 * Repeated receipts for the same requestId are preserved; the correlator is
 * responsible for idempotency.
 */
export function parseTaskReceipts(text: string): readonly TaskReceipt[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const receipts: TaskReceipt[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = RECEIPT_LINE_PATTERN.exec(rawLine.trim());
    if (!match) continue;
    const [, requestId, verdict, detail] = match;
    receipts.push({
      requestId: requestId ?? "",
      verdict: verdict as TaskReceiptVerdict,
      detail: (detail ?? "").trim().slice(0, MAX_RECEIPT_DETAIL_LENGTH),
    });
  }
  return receipts;
}

/** Text of an agent_message update content block list, in order. */
export function agentMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

export interface PickArtifactOutcome {
  readonly ok: true;
  readonly path: string;
}
export interface PickArtifactFailure {
  readonly ok: false;
  readonly code: "NO_ARTIFACT_FILE";
  readonly message: string;
}

/**
 * Choose the artifact to import: an explicit path from a RESULT receipt when
 * given, otherwise the newest audio candidate found in the precast output
 * directory scan. An empty scan is a real failure, never a guess.
 */
export function pickArtifactFromScan(
  scanned: ScanResultLike,
): PickArtifactOutcome | PickArtifactFailure {
  const first = scanned.files[0];
  if (!first) {
    return {
      ok: false,
      code: "NO_ARTIFACT_FILE",
      message:
        "任务回执未携带产物路径，且预铸产物目录中没有可导入的音频文件",
    };
  }
  return { ok: true, path: first.path };
}

/** Structural subset of the desktop scan result (kept dependency-free). */
interface ScanResultLike {
  readonly files: readonly {
    readonly path: string;
    readonly name?: string;
    readonly sizeBytes?: number;
    readonly lastModifiedMs?: number;
  }[];
}
