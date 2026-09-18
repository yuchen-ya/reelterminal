/**
 * Pure composer for the hand-off prompt text of an agent media task.
 *
 * The external Agent conversation only understands plain text — there is no
 * first-class "task" object on the wire — so the entire contract is cast
 * into one message: what to generate, where the artifact must be written
 * (a precast output directory under the agent workspace job layout), how to
 * report the result back (a receipt line carrying the requestId), and what
 * is forbidden (calling media_import or any project-mutating tool — the
 * product imports the artifact itself; leaking credentials or model/vendor
 * names).
 *
 * `recommendedRoot` comes from `capabilities_get.mediaImport`
 * (`recommendedRoot` is `mediaRoots[0]`, the agent workspace root advertised
 * by the desktop host). The composer only formats it; callers snapshot the
 * directory onto the task record at creation time.
 *
 * The prose body follows the app UI language (`zh`/`en`); the task marker,
 * the receipt line format, and every binding constraint are semantically
 * identical in both templates.
 */

/** Matches the conversation prompt IPC zod limit (text 1..32_000). */
export const AGENT_TASK_PROMPT_MAX_LENGTH = 32_000;

export const AGENT_TASK_RECEIPT_PREFIX = "openreel-task:";

/** UI language the hand-off prose is written in (follows the app locale). */
export type ComposeTaskPromptLanguage = "zh" | "en";

export type ComposeTaskPromptField =
  | "requestId"
  | "taskId"
  | "promptText"
  | "requirements";

/**
 * Failure is a code plus structured parameters; UI layers translate it. The
 * composer never embeds user-facing prose or internal API names in the
 * failure itself, so the same value is safe to store on a task record.
 */
export type ComposeTaskPromptFailure =
  | {
      readonly ok: false;
      readonly code: "EMPTY_FIELD";
      readonly field: ComposeTaskPromptField;
    }
  | { readonly ok: false; readonly code: "NO_RECOMMENDED_ROOT" }
  | {
      readonly ok: false;
      readonly code: "PROMPT_TOO_LONG";
      readonly length: number;
      readonly maxLength: number;
    };

export type ComposeTaskPromptOutcome =
  | {
      readonly ok: true;
      readonly prompt: string;
      readonly outputDirectory: string;
    }
  | ComposeTaskPromptFailure;

/**
 * Language-neutral, storable detail for a compose failure (ledger record and
 * fallback display). Deliberately free of internal implementation names.
 */
export function composeFailureDetail(
  failure: ComposeTaskPromptFailure,
): string {
  switch (failure.code) {
    case "EMPTY_FIELD":
      return `required field is empty: ${failure.field}`;
    case "NO_RECOMMENDED_ROOT":
      return "the session did not advertise a media root";
    case "PROMPT_TOO_LONG":
      return `hand-off text is ${failure.length} characters, over the limit of ${failure.maxLength}`;
  }
}

export interface ComposeTaskPromptInput {
  readonly requestId: string;
  readonly taskId: string;
  readonly kind: "tts" | "music";
  /**
   * Read-aloud text (tts) / music description (music). A music task may
   * leave this blank when its brief is carried entirely by the requirement
   * wording; a voiceover task always needs the text itself.
   */
  readonly promptText: string;
  readonly requirementsText?: string;
  readonly overrides?: {
    readonly language?: string;
    readonly targetDurationSeconds?: number;
    readonly styleHint?: string;
  };
  /** `capabilities_get.mediaImport.recommendedRoot`; null → cannot precast. */
  readonly recommendedRoot: string | null;
  /**
   * UI language for the prose body. Omitted → "zh" (the historical
   * behavior), so existing callers and records stay byte-identical.
   */
  readonly language?: ComposeTaskPromptLanguage;
}

/**
 * Deterministic artifact output directory for a task:
 * `<recommendedRoot>/jobs/<taskId>/output`. The separator follows the root
 * (Windows roots keep their backslashes; POSIX roots use slashes) so the
 * composed path stays a literal prefix of the eventual artifact path.
 */
export function taskOutputDirectory(
  recommendedRoot: string,
  taskId: string,
): string {
  const separator = recommendedRoot.includes("\\") ? "\\" : "/";
  const trimmedRoot = recommendedRoot.replace(/[\\/]+$/, "");
  return [
    trimmedRoot,
    "jobs",
    taskId,
    "output",
  ].join(separator);
}

/**
 * MARKER STABILITY CONSTRAINT: the opening line
 * `[ReelTerminal 任务 openreel-task:<requestId>]` and the receipt verbs
 * (`RESULT` / `ERROR`) are an external parsing contract — external Agents,
 * `receipts.ts`, and docs/AGENT-GUIDE.md all match the literal marker, and
 * the zh/en forms must stay byte-identical or receipt correlation breaks.
 * Only the prose body below the marker is translated per UI language.
 */
const TASK_MARKER_LABEL = "ReelTerminal 任务";

/**
 * Per-language wording for the hand-off prompt. The two templates are kept
 * semantically identical field for field (kind, content, requirements relay,
 * artifact constraints, receipt protocol, sanitization demand); only the
 * prose differs. The zh wording is the historical text and must not drift.
 */
const PROMPT_WORDING: Record<
  ComposeTaskPromptLanguage,
  {
    readonly kindTts: string;
    readonly kindMusic: string;
    readonly typeLabel: string;
    readonly contentLabel: string;
    readonly contentNone: string;
    readonly requirementsHeader: string;
    readonly languagePreference: string;
    readonly targetDuration: (seconds: number) => string;
    readonly styleHint: string;
    readonly artifactConstraintsHeader: string;
    readonly artifactSingleFile: (outputDirectory: string) => string;
    readonly artifactReceipt: (receiptId: string) => string;
    readonly artifactSanitization: string;
  }
> = {
  zh: {
    kindTts: "配音（朗读文本转语音）",
    kindMusic: "音乐（按描述生成音乐）",
    typeLabel: "类型",
    contentLabel: "内容",
    contentNone: "内容:（无单独描述，以下方要求为准）",
    requirementsHeader: "要求（请原样作为生成要求对待）:",
    languagePreference: "语言偏好",
    targetDuration: (seconds) => `目标时长: 约 ${seconds} 秒`,
    styleHint: "风格提示",
    artifactConstraintsHeader: "产物约束:",
    artifactSingleFile: (dir) =>
      `1. 生成结果只写入 ${dir} 目录下的单个音频文件；不要调用 media_import 或任何修改项目的工具，不要插入时间线。`,
    artifactReceipt: (receiptId) =>
      `2. 完成后回复一行 "${receiptId} RESULT <产物绝对路径>"；失败则回复一行 "${receiptId} ERROR <一句话原因>"。`,
    artifactSanitization:
      "3. 回复和产物信息中不要包含凭据、密钥、模型或供应商名称。",
  },
  en: {
    kindTts: "Voiceover (read-aloud text to speech)",
    kindMusic: "Music (description to music)",
    typeLabel: "Type",
    contentLabel: "Content",
    contentNone:
      "Content: (no separate description; treat the requirements below as the brief)",
    requirementsHeader: "Requirements (treat verbatim as the generation requirements):",
    languagePreference: "Language preference",
    targetDuration: (seconds) => `Target duration: about ${seconds} seconds`,
    styleHint: "Style hint",
    artifactConstraintsHeader: "Artifact constraints:",
    artifactSingleFile: (dir) =>
      `1. Write the result as a single audio file under the ${dir} directory only; do not call media_import or any project-mutating tool, and do not insert anything into the timeline.`,
    artifactReceipt: (receiptId) =>
      `2. When done, reply with one line "${receiptId} RESULT <absolute artifact path>"; on failure, reply with one line "${receiptId} ERROR <one-line reason>".`,
    artifactSanitization:
      "3. Keep credentials, keys, model, or vendor names out of the reply and the artifact information.",
  },
};

function kindLabel(
  kind: "tts" | "music",
  language: ComposeTaskPromptLanguage,
): string {
  const wording = PROMPT_WORDING[language];
  return kind === "tts" ? wording.kindTts : wording.kindMusic;
}

function appendRequirement(
  lines: string[],
  requirement: string | undefined,
): void {
  if (typeof requirement === "string" && requirement.trim().length > 0) {
    lines.push(requirement.trim());
  }
}

/**
 * True when the requirement wording (free-form text or any override) carries
 * enough of a brief to stand in for a blank music description. A voiceover
 * task can never substitute requirements for its read-aloud text.
 */
export function taskHasRequirementText(
  requirementsText?: string,
  overrides?: ComposeTaskPromptInput["overrides"],
): boolean {
  if (typeof requirementsText === "string" && requirementsText.trim().length > 0) {
    return true;
  }
  if (!overrides) return false;
  if (typeof overrides.language === "string" && overrides.language.trim()) return true;
  if (
    typeof overrides.targetDurationSeconds === "number" &&
    Number.isFinite(overrides.targetDurationSeconds) &&
    overrides.targetDurationSeconds > 0
  ) {
    return true;
  }
  if (typeof overrides.styleHint === "string" && overrides.styleHint.trim()) return true;
  return false;
}

/**
 * Compose the hand-off prompt. Fails before any submission when the total
 * length would exceed the conversation prompt limit, when the recommended
 * root is unavailable (nothing safe to precast), or when a required field
 * is empty.
 */
export function composeTaskPrompt(
  input: ComposeTaskPromptInput,
): ComposeTaskPromptOutcome {
  const requestId = input.requestId.trim();
  const taskId = input.taskId.trim();
  const promptText = input.promptText.trim();
  if (!requestId) {
    return { ok: false, code: "EMPTY_FIELD", field: "requestId" };
  }
  if (!taskId) {
    return { ok: false, code: "EMPTY_FIELD", field: "taskId" };
  }
  if (!promptText && input.kind !== "music") {
    return { ok: false, code: "EMPTY_FIELD", field: "promptText" };
  }
  if (!promptText && !taskHasRequirementText(input.requirementsText, input.overrides)) {
    return { ok: false, code: "EMPTY_FIELD", field: "requirements" };
  }
  const recommendedRoot = input.recommendedRoot?.trim();
  if (!recommendedRoot) {
    return { ok: false, code: "NO_RECOMMENDED_ROOT" };
  }
  const outputDirectory = taskOutputDirectory(recommendedRoot, taskId);
  // Prose language follows the app UI language; omitted → historical zh.
  const language = input.language ?? "zh";
  const wording = PROMPT_WORDING[language];
  const receiptId = `${AGENT_TASK_RECEIPT_PREFIX}${requestId}`;

  const lines: string[] = [
    // Marker stays byte-identical across languages (see TASK_MARKER_LABEL).
    `[${TASK_MARKER_LABEL} ${receiptId}]`,
    `${wording.typeLabel}: ${kindLabel(input.kind, language)}`,
    promptText
      ? `${wording.contentLabel}: ${promptText}`
      : wording.contentNone,
  ];

  const requirementLines: string[] = [];
  appendRequirement(requirementLines, input.requirementsText);
  const overrides = input.overrides;
  if (overrides) {
    if (overrides.language && overrides.language.trim()) {
      requirementLines.push(
        `${wording.languagePreference}: ${overrides.language.trim()}`,
      );
    }
    if (
      typeof overrides.targetDurationSeconds === "number" &&
      Number.isFinite(overrides.targetDurationSeconds) &&
      overrides.targetDurationSeconds > 0
    ) {
      requirementLines.push(
        wording.targetDuration(Math.round(overrides.targetDurationSeconds)),
      );
    }
    if (overrides.styleHint && overrides.styleHint.trim()) {
      requirementLines.push(`${wording.styleHint}: ${overrides.styleHint.trim()}`);
    }
  }
  if (requirementLines.length > 0) {
    lines.push(`${wording.requirementsHeader}\n${requirementLines.join("\n")}`);
  }

  lines.push(
    wording.artifactConstraintsHeader,
    wording.artifactSingleFile(outputDirectory),
    wording.artifactReceipt(receiptId),
    wording.artifactSanitization,
  );

  const prompt = lines.join("\n");
  if (prompt.length > AGENT_TASK_PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      code: "PROMPT_TOO_LONG",
      length: prompt.length,
      maxLength: AGENT_TASK_PROMPT_MAX_LENGTH,
    };
  }
  return { ok: true, prompt, outputDirectory };
}
