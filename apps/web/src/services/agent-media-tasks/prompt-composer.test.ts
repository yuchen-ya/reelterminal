import { describe, expect, it } from "vitest";
import {
  AGENT_TASK_PROMPT_MAX_LENGTH,
  AGENT_TASK_RECEIPT_PREFIX,
  composeFailureDetail,
  composeTaskPrompt,
  taskOutputDirectory,
} from "./prompt-composer";

const BASE = {
  requestId: "req_abc123",
  taskId: "amt_task1",
  kind: "tts" as const,
  promptText: "今天天气不错。",
  recommendedRoot: "C:\\Users\\u\\Videos\\ReelTerminal Agent Workspace",
};

describe("taskOutputDirectory", () => {
  it("precasts under <root>/jobs/<taskId>/output with windows separators", () => {
    expect(taskOutputDirectory("C:\\media-root", "amt_1")).toBe(
      "C:\\media-root\\jobs\\amt_1\\output",
    );
  });

  it("does not double separators when the root ends with one", () => {
    expect(taskOutputDirectory("C:\\media-root\\", "amt_1")).toBe(
      "C:\\media-root\\jobs\\amt_1\\output",
    );
  });

  it("keeps posix separators for posix roots", () => {
    expect(taskOutputDirectory("/home/u/media-root", "amt_1")).toBe(
      "/home/u/media-root/jobs/amt_1/output",
    );
  });
});

describe("composeFailureDetail", () => {
  it("describes failures with parameters and no internal implementation names", () => {
    const tooLong = composeTaskPrompt({
      ...BASE,
      promptText: "好".repeat(AGENT_TASK_PROMPT_MAX_LENGTH),
    });
    if (tooLong.ok || tooLong.code !== "PROMPT_TOO_LONG") {
      throw new Error("expected failure");
    }
    expect(composeFailureDetail(tooLong)).toBe(
      `hand-off text is ${tooLong.length} characters, over the limit of ${tooLong.maxLength}`,
    );

    const noRoot = composeTaskPrompt({ ...BASE, recommendedRoot: " " });
    if (noRoot.ok) throw new Error("expected failure");
    expect(composeFailureDetail(noRoot)).toBe(
      "the session did not advertise a media root",
    );

    const emptyField = composeTaskPrompt({ ...BASE, requestId: "  " });
    if (emptyField.ok) throw new Error("expected failure");
    expect(composeFailureDetail(emptyField)).toBe(
      "required field is empty: requestId",
    );
  });

  it("keeps every failure detail free of Chinese prose and internal API names", () => {
    const failures = [
      composeTaskPrompt({ ...BASE, requestId: "" }),
      composeTaskPrompt({ ...BASE, recommendedRoot: "" }),
      composeTaskPrompt({
        ...BASE,
        promptText: "好".repeat(AGENT_TASK_PROMPT_MAX_LENGTH),
      }),
    ];
    for (const failure of failures) {
      if (failure.ok) throw new Error("expected failure");
      const detail = composeFailureDetail(failure);
      expect(detail).toMatch(/^[\x20-\x7E]+$/);
      expect(detail).not.toMatch(/capabilities_get|media_import|prompt/i);
    }
  });
});

describe("composeTaskPrompt", () => {
  it("casts the full hand-off contract into one text message", () => {
    const result = composeTaskPrompt(BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prompt = result.prompt;

    // Header carries the requestId receipt marker.
    expect(prompt).toContain(`[ReelTerminal 任务 ${AGENT_TASK_RECEIPT_PREFIX}req_abc123]`);
    expect(prompt).toContain("类型: 配音");
    expect(prompt).toContain("内容: 今天天气不错。");
    // Precast output directory from the recommended root.
    expect(result.outputDirectory).toBe(
      "C:\\Users\\u\\Videos\\ReelTerminal Agent Workspace\\jobs\\amt_task1\\output",
    );
    expect(prompt).toContain(result.outputDirectory);
    // Product owns the import: the agent is told not to touch the project.
    expect(prompt).toContain("不要调用 media_import 或任何修改项目的工具，不要插入时间线");
    // Receipt protocol.
    expect(prompt).toContain(
      `${AGENT_TASK_RECEIPT_PREFIX}req_abc123 RESULT <产物绝对路径>`,
    );
    expect(prompt).toContain(
      `${AGENT_TASK_RECEIPT_PREFIX}req_abc123 ERROR <一句话原因>`,
    );
    // Sanitization demand.
    expect(prompt).toContain("不要包含凭据、密钥、模型或供应商名称");
  });

  it("renders music tasks with the music label", () => {
    const result = composeTaskPrompt({ ...BASE, kind: "music" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt).toContain("类型: 音乐");
  });

  it("relays requirements and overrides as wording, not provider parameters", () => {
    const result = composeTaskPrompt({
      ...BASE,
      requirementsText: "语气要沉稳",
      overrides: {
        language: "中文（普通话）",
        targetDurationSeconds: 12.4,
        styleHint: "温暖的播客风格",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt).toContain("要求（请原样作为生成要求对待）:");
    expect(result.prompt).toContain("语气要沉稳");
    expect(result.prompt).toContain("语言偏好: 中文（普通话）");
    expect(result.prompt).toContain("目标时长: 约 12 秒");
    expect(result.prompt).toContain("风格提示: 温暖的播客风格");
    // Never leaks raw provider-ish parameter names.
    expect(result.prompt).not.toContain("targetDurationSeconds");
  });

  it("skips blank or invalid overrides", () => {
    const result = composeTaskPrompt({
      ...BASE,
      overrides: { language: "  ", targetDurationSeconds: -3, styleHint: "" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt).not.toContain("要求（请原样作为生成要求对待）:");
  });

  it("fails without a recommended root — nothing safe to precast", () => {
    expect(composeTaskPrompt({ ...BASE, recommendedRoot: null })).toMatchObject({
      ok: false,
      code: "NO_RECOMMENDED_ROOT",
    });
    expect(composeTaskPrompt({ ...BASE, recommendedRoot: "   " })).toMatchObject({
      ok: false,
      code: "NO_RECOMMENDED_ROOT",
    });
  });

  it("fails on empty required fields", () => {
    expect(composeTaskPrompt({ ...BASE, requestId: " " })).toMatchObject({
      ok: false,
      code: "EMPTY_FIELD",
    });
    expect(composeTaskPrompt({ ...BASE, taskId: "" })).toMatchObject({
      ok: false,
      code: "EMPTY_FIELD",
    });
    expect(composeTaskPrompt({ ...BASE, promptText: "  " })).toMatchObject({
      ok: false,
      code: "EMPTY_FIELD",
    });
  });

  it("lets a music task lean on its requirements when the description is blank", () => {
    const result = composeTaskPrompt({
      ...BASE,
      kind: "music",
      promptText: "  ",
      requirementsText: "30 秒左右的轻快钢琴",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt).toContain("内容:（无单独描述，以下方要求为准）");
    expect(result.prompt).toContain("30 秒左右的轻快钢琴");
  });

  it("still rejects a music task with neither description nor requirements", () => {
    expect(
      composeTaskPrompt({ ...BASE, kind: "music", promptText: "" }),
    ).toMatchObject({ ok: false, code: "EMPTY_FIELD" });
    expect(
      composeTaskPrompt({
        ...BASE,
        kind: "music",
        promptText: "",
        overrides: { language: "  " },
      }),
    ).toMatchObject({ ok: false, code: "EMPTY_FIELD" });
  });

  it("pre-checks the total composed length against the prompt limit", () => {
    const longText = "好".repeat(AGENT_TASK_PROMPT_MAX_LENGTH);
    const result = composeTaskPrompt({ ...BASE, promptText: longText });
    expect(result).toMatchObject({ ok: false, code: "PROMPT_TOO_LONG" });
    if (result.ok || result.code !== "PROMPT_TOO_LONG") return;
    expect(result.length).toBeGreaterThan(AGENT_TASK_PROMPT_MAX_LENGTH);
    expect(result.maxLength).toBe(AGENT_TASK_PROMPT_MAX_LENGTH);
  });

  it("accepts a composed prompt within the limit", () => {
    const result = composeTaskPrompt({
      ...BASE,
      promptText: "好".repeat(AGENT_TASK_PROMPT_MAX_LENGTH - 2000),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt.length).toBeLessThanOrEqual(AGENT_TASK_PROMPT_MAX_LENGTH);
  });
});

describe("composeTaskPrompt bilingual templates", () => {
  // The marker is an external parsing contract (receipts.ts + external
  // Agents): it must stay byte-identical across zh/en templates.
  const MARKER = `[ReelTerminal 任务 ${AGENT_TASK_RECEIPT_PREFIX}req_abc123]`;

  it("keeps the zh wording byte-identical whether the language is omitted or explicit", () => {
    const omitted = composeTaskPrompt(BASE);
    const explicit = composeTaskPrompt({ ...BASE, language: "zh" });
    expect(omitted.ok && explicit.ok).toBe(true);
    if (!omitted.ok || !explicit.ok) return;
    expect(explicit.prompt).toBe(omitted.prompt);
    expect(omitted.prompt).toContain(MARKER);
    expect(omitted.prompt).toContain("类型: 配音");
    expect(omitted.prompt).toContain("产物约束:");
  });

  it("renders the en template with the same contract and an identical marker", () => {
    const result = composeTaskPrompt({
      ...BASE,
      promptText: "Welcome to the show.",
      language: "en",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prompt = result.prompt;
    expect(prompt).toContain(MARKER);
    expect(prompt).toContain("Type: Voiceover (read-aloud text to speech)");
    expect(prompt).toContain("Content: Welcome to the show.");
    expect(prompt).toContain(
      "C:\\Users\\u\\Videos\\ReelTerminal Agent Workspace\\jobs\\amt_task1\\output",
    );
    expect(prompt).toContain(
      "do not call media_import or any project-mutating tool",
    );
    expect(prompt).toContain(
      `${AGENT_TASK_RECEIPT_PREFIX}req_abc123 RESULT <absolute artifact path>`,
    );
    expect(prompt).toContain(
      `${AGENT_TASK_RECEIPT_PREFIX}req_abc123 ERROR <one-line reason>`,
    );
    expect(prompt).toContain("Keep credentials, keys, model, or vendor names");
    // Apart from the stable marker line, the en template carries no Chinese.
    const body = prompt.split("\n").slice(1).join("\n");
    expect(body).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it("renders the en music label and relays requirements in en", () => {
    const result = composeTaskPrompt({
      ...BASE,
      kind: "music",
      promptText: "  ",
      language: "en",
      requirementsText: "calm piano, around half a minute",
      overrides: {
        language: "Mandarin Chinese",
        targetDurationSeconds: 12.4,
        styleHint: "warm podcast",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt).toContain("Type: Music (description to music)");
    expect(result.prompt).toContain("Content: (no separate description");
    expect(result.prompt).toContain(
      "Requirements (treat verbatim as the generation requirements):",
    );
    expect(result.prompt).toContain("calm piano, around half a minute");
    expect(result.prompt).toContain("Language preference: Mandarin Chinese");
    expect(result.prompt).toContain("Target duration: about 12 seconds");
    expect(result.prompt).toContain("Style hint: warm podcast");
    // Never leaks raw provider-ish parameter names in either language.
    expect(result.prompt).not.toContain("targetDurationSeconds");
  });
});
