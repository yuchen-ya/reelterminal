import { describe, expect, it } from "vitest";
import {
  AGENT_TASK_SANITIZED_INFO_MAX_LENGTH,
  sanitizeGenerationInfo,
} from "./sanitize";

describe("sanitizeGenerationInfo", () => {
  it("keeps display-grade agent summaries untouched", () => {
    expect(sanitizeGenerationInfo("GPT Voice Agent 1.2.0 — 语音生成完成")).toBe(
      "GPT Voice Agent 1.2.0 — 语音生成完成",
    );
  });

  it("collapses absolute windows/posix paths and file URIs", () => {
    const out = sanitizeGenerationInfo(
      "generated C:\\Users\\u\\secret\\voice.wav done",
    );
    expect(out).not.toContain("C:\\Users\\u\\secret\\voice.wav");
    expect(out).toContain("[路径已省略]");

    const posix = sanitizeGenerationInfo("written to /home/u/secret/take1.wav");
    expect(posix).not.toContain("/home/u/secret/take1.wav");
    expect(posix).toContain("[路径已省略]");

    const uri = sanitizeGenerationInfo("saved file:///C:/secret/a.mp3 ok");
    expect(uri).not.toContain("file:///C:/secret/a.mp3");
  });

  it("removes credential-shaped assignments", () => {
    const out = sanitizeGenerationInfo("used api_key=sk-abc123 and token: t-xyz; done");
    expect(out).not.toContain("sk-abc123");
    expect(out).not.toContain("t-xyz");
    expect(out).toContain("[凭据已移除]");
  });

  it("redacts long opaque token runs", () => {
    const out = sanitizeGenerationInfo("ref aGVsbG93b3JsZGhlbGxvd29ybGQxMjM0NTY3ODkw ok");
    expect(out).not.toContain("aGVsbG93b3JsZGhlbGxvd29ybGQxMjM0NTY3ODkw");
    expect(out).toContain("[已脱敏]");
  });

  it("bounds the stored summary length", () => {
    const out = sanitizeGenerationInfo("x".repeat(AGENT_TASK_SANITIZED_INFO_MAX_LENGTH + 500));
    expect(out.length).toBeLessThanOrEqual(AGENT_TASK_SANITIZED_INFO_MAX_LENGTH);
  });
});
