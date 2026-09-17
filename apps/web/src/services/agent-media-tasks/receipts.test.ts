import { describe, expect, it } from "vitest";
import {
  agentMessageText,
  parseTaskReceipts,
  pickArtifactFromScan,
} from "./receipts";

describe("parseTaskReceipts", () => {
  it("parses a RESULT line with an artifact path", () => {
    const receipts = parseTaskReceipts(
      "openreel-task:req_abc-123 RESULT C:\\ws\\jobs\\amt_1\\output\\voice.wav",
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toEqual({
      requestId: "req_abc-123",
      verdict: "RESULT",
      detail: "C:\\ws\\jobs\\amt_1\\output\\voice.wav",
    });
  });

  it("parses an ERROR line and keeps the reason", () => {
    const receipts = parseTaskReceipts(
      "openreel-task:req_x ERROR provider quota exhausted",
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.verdict).toBe("ERROR");
    expect(receipts[0]?.detail).toBe("provider quota exhausted");
  });

  it("parses a RESULT line without a trailing path", () => {
    const receipts = parseTaskReceipts("openreel-task:req_x RESULT");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.detail).toBe("");
  });

  it("finds receipts among conversational noise across lines", () => {
    const text = [
      "好的，我来处理这个任务。",
      "openreel-task:req_a RESULT /ws/jobs/amt_a/output/a.mp3",
      "另外附上一些说明文字。",
      "openreel-task:req_b ERROR 生成超时",
    ].join("\n");
    const receipts = parseTaskReceipts(text);
    expect(receipts.map((receipt) => receipt.requestId)).toEqual(["req_a", "req_b"]);
    expect(receipts[0]?.verdict).toBe("RESULT");
    expect(receipts[1]?.verdict).toBe("ERROR");
  });

  it("ignores lines without the receipt marker", () => {
    expect(parseTaskReceipts("openreel-task: RESULT nothing")).toHaveLength(0);
    expect(parseTaskReceipts("task:req_x RESULT /tmp/a.wav")).toHaveLength(0);
    expect(parseTaskReceipts("")).toHaveLength(0);
  });

  it("bounds a pathological detail field", () => {
    const receipts = parseTaskReceipts(
      `openreel-task:req_x RESULT ${"x".repeat(5000)}`,
    );
    expect(receipts[0]?.detail.length).toBeLessThanOrEqual(1024);
  });
});

describe("agentMessageText", () => {
  it("joins text content blocks so a receipt on one line is preserved", () => {
    const text = agentMessageText([
      { type: "text", text: "openreel-task:req_a RESULT /tmp/a.wav" },
      { type: "text", text: "附言：还有其他说明。" },
    ]);
    const receipts = parseTaskReceipts(text);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.requestId).toBe("req_a");
    expect(receipts[0]?.detail).toBe("/tmp/a.wav");
  });

  it("returns empty for non-array content", () => {
    expect(agentMessageText(undefined)).toBe("");
    expect(agentMessageText("openreel-task:req_a RESULT")).toBe("");
  });
});

describe("pickArtifactFromScan", () => {
  it("takes the first (newest) candidate", () => {
    const picked = pickArtifactFromScan({
      files: [
        { path: "/ws/jobs/amt_1/output/new.wav", name: "new.wav", sizeBytes: 10, lastModifiedMs: 20 },
        { path: "/ws/jobs/amt_1/output/old.wav", name: "old.wav", sizeBytes: 10, lastModifiedMs: 10 },
      ],
    });
    expect(picked).toEqual({ ok: true, path: "/ws/jobs/amt_1/output/new.wav" });
  });

  it("fails honestly when the scan found nothing", () => {
    const picked = pickArtifactFromScan({ files: [] });
    expect(picked.ok).toBe(false);
    if (!picked.ok) expect(picked.code).toBe("NO_ARTIFACT_FILE");
  });
});
