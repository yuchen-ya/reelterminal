import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";

/** Synthetic protocol fixture, never a quality evaluation of a real model. */
export const TASK_REVIEW_FIXTURE_KEY = "synthetic-review-e2e-key";
export const TASK_REVIEW_COMPLETION = " 请核对语境与受众，再明确这一条需要保留还是返工。";

const requestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.enum(["system", "user"]), content: z.string() })),
  stream: z.literal(true),
  store: z.literal(false),
  max_completion_tokens: z.number().int().positive(),
}).strict();
const targetInput = z.object({ unitId: z.string(), sourceVersionId: z.string() });
const batchInput = z.object({
  purpose: z.string(),
  units: z.array(targetInput.extend({ text: z.string(), criteriaVersionIds: z.array(z.string()) })),
  coverage: z.object({ targets: z.array(targetInput).min(1) }),
});
const completionInput = z.object({ reviewFeedbackDraft: z.string(), source: z.string() });
const searchInput = z.object({
  query: z.string(),
  units: z.array(targetInput.extend({ id: z.string(), start: z.number().int(), end: z.number().int(), text: z.string() }).strict()),
  coverage: z.object({ scopeUnitCount: z.number().int(), candidateUnitCount: z.number().int(), complete: z.boolean() }).strict(),
}).strict();
const data = (content: string, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;

export interface TaskReviewFixtureRequest {
  kind: "review" | "completion" | "search";
  model: string;
  maxOutputTokens: number;
  instructionBoundaryPresent: boolean;
  unitIds?: string[];
  protocol?: "batch";
  searchPhase?: "expansion" | "ranking";
  scopeUnitCount?: number;
  candidateUnitCount?: number;
}

export async function startTaskReviewModelFixture(options: { completionResponse?: string } = {}) {
  const completionResponse = options.completionResponse ?? TASK_REVIEW_COMPLETION;
  const requests: TaskReviewFixtureRequest[] = [];
  const errors: string[] = [];
  const pendingCompletions = new Map<ServerResponse, () => void>();
  let holdCompletions = false;
  let cancelledCompletions = 0;
  let deliveredCompletionChunks = 0;
  let unknownReviewPrefix: string | undefined;

  const stream = (response: ServerResponse, text: string, slow = false) => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    if (!slow) { response.end(data(text) + data("", "stop") + "data: [DONE]\n\n"); return; }
    const parts = text.match(/.{1,6}/gu) ?? [];
    let index = 0;
    const timer = setInterval(() => {
      if (index < parts.length) {
        response.write(data(parts[index++]));
        deliveredCompletionChunks++;
      }
      else {
        clearInterval(timer);
        response.end(data("", "stop") + "data: [DONE]\n\n");
      }
    }, 120);
    response.once("close", () => {
      clearInterval(timer);
      if (!response.writableEnded) cancelledCompletions++;
      pendingCompletions.delete(response);
    });
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end(); return;
    }
    if (request.headers.authorization !== `Bearer ${TASK_REVIEW_FIXTURE_KEY}`) {
      response.writeHead(401).end(); return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 256 * 1024) { response.writeHead(413).end(); return; }
      chunks.push(bytes);
    }
    const body = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const instruction = body.messages.find(message => message.role === "system")?.content ?? "";
    const input: unknown = JSON.parse(body.messages.find(message => message.role === "user")!.content);
    const metadata = { model: body.model, maxOutputTokens: body.max_completion_tokens, instructionBoundaryPresent: instruction.includes("untrusted data") };
    const batch = batchInput.safeParse(input);
    if (batch.success) {
      const { purpose, units, coverage } = batch.data;
      requests.push({ kind: "review", ...metadata, unitIds: coverage.targets.map(target => target.unitId), protocol: "batch" });
      const entries = coverage.targets.map((target, index) => {
        const unit = units.find(unit => unit.unitId === target.unitId && unit.sourceVersionId === target.sourceVersionId);
        if (!unit) throw new Error("Synthetic batch target is absent from its supplied units");
        const sourceRef = { ...target, start: 0, end: unit.text.length, text: unit.text };
        const unknown = Boolean(unknownReviewPrefix && unit.text.startsWith(unknownReviewPrefix));
        const flagged = !unknown && unit.text.includes("A:");
        return { target, index, unit, sourceRef, unknown, flagged };
      });
      const issues = entries.filter(entry => entry.flagged).map(entry => ({
        id: `synthetic-issue-${entry.index}`, targets: [entry.target], severity: "high",
        title: "合成测试：需要核对受众", hypothesis: "仅用于检查证据、假设和理由的呈现，不代表模型判断质量。",
        sourceRefs: [entry.sourceRef], criteriaRefs: entry.unit.criteriaVersionIds,
        options: [{ label: "核对语境后保留", reason: "合成候选：先核对任务口径，再由人工判断。" }],
      }));
      const compare = entries.filter(entry => /^[XY]:/.test(entry.unit.text));
      const group = entries.filter(entry => /^[LMN]:/.test(entry.unit.text) && !entry.unknown && !entry.flagged);
      const sceneMembers = new Set([...compare, ...group].map(entry => entry.target.unitId));
      const scenes = entries.filter(entry => !sceneMembers.has(entry.target.unitId)).map(entry => ({
        id: `synthetic-scene-${entry.index}`, kind: "single", targets: [entry.target], purpose, decisionMode: "per-unit",
        checkIntent: entry.flagged ? "核对具体风险" : "逐条人工审阅",
        reason: entry.unknown ? "AI 预审未完成，风险未知，可继续人工审阅" : entry.flagged ? "合成测试：需要核对受众" : "合成测试：已分析未发现具体风险，等待人工扫阅",
        issueIds: entry.flagged ? [`synthetic-issue-${entry.index}`] : [], criteriaRefs: entry.unit.criteriaVersionIds, sourceRefs: [entry.sourceRef],
      }));
      for (const [kind, members] of [["compare", compare], ["lowRiskGroup", group]] as const) {
        // These fixed arrangements exercise scene contracts, not model reasoning.
        if (members.length < 2) continue;
        scenes.push({ id: `synthetic-${kind}`, kind, targets: members.map(entry => entry.target), purpose, decisionMode: "per-unit",
          checkIntent: kind === "compare" ? "合成测试：同时对照两条原文" : "合成测试：明确选择后逐项确认",
          reason: "仅验证场景编排和人工判断边界，不代表模型质量。", issueIds: [],
          criteriaRefs: [...new Set(members.flatMap(entry => entry.unit.criteriaVersionIds))], sourceRefs: members.map(entry => entry.sourceRef) });
      }
      stream(response, JSON.stringify({
        understanding: {
          groundedClaims: [{ content: "材料中包含用户提供的待审台词。", sourceRefs: [entries[0].sourceRef] }],
          hypotheses: entries.filter(entry => entry.flagged).map(entry => ({ content: "合成测试：需核对目标受众。", targets: [entry.target], sourceRefs: [entry.sourceRef] })),
          openQuestions: entries.filter(entry => entry.unknown).map(entry => ({ question: "合成测试：此条证据不足，风险未知。", targets: [entry.target] })),
        },
        coverage: entries.map(entry => ({ ...entry.target, status: entry.unknown ? "unknown" : "analyzed", reason: entry.unknown ? "合成测试：此条未完成分析，风险未知。" : "合成测试：已对所提供的条目完成结构化分析。" })),
        issues,
        scenes,
      }));
      return;
    }
    const completion = completionInput.safeParse(input);
    if (completion.success) {
      requests.push({ kind: "completion", ...metadata });
      if (holdCompletions) {
        pendingCompletions.set(response, () => stream(response, completionResponse, true));
        response.once("close", () => {
          if (pendingCompletions.delete(response) && !response.writableEnded) cancelledCompletions++;
        });
      } else stream(response, completionResponse, true);
      return;
    }
    if (instruction.includes("Expand only the supplied search query")) {
      const expansion = z.object({ query: z.string() }).strict().parse(input);
      requests.push({ kind: "search", searchPhase: "expansion", ...metadata });
      stream(response, JSON.stringify({ terms: [expansion.query.slice(0, 60)] }));
      return;
    }
    if (!instruction.includes("Find semantic matches")) throw new Error("Unknown synthetic model request contract");
    const search = searchInput.parse(input);
    requests.push({ kind: "search", searchPhase: "ranking", ...metadata, unitIds: search.units.map(unit => unit.unitId), ...search.coverage });
    // The fixture is deterministic; it does not claim to understand semantics.
    const match = search.units.find(unit => unit.text.includes("G:")) ?? search.units[0];
    const sourceRefs = match ? [{ unitId: match.unitId, sourceVersionId: match.sourceVersionId, start: match.start, end: match.start + Math.min(2, match.text.length), text: match.text.slice(0, 2) }] : [];
    stream(response, JSON.stringify({ matches: match ? [{ unitId: match.unitId, sourceVersionId: match.sourceVersionId, reason: "合成检索结果：用于验证跳转与目标身份。", sourceRefs }] : [] }));
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic model fixture did not bind TCP");
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    requests,
    errors,
    get cancelledCompletions() { return cancelledCompletions; },
    get deliveredCompletionChunks() { return deliveredCompletionChunks; },
    leaveReviewsUnknownStartingWith(prefix: string) { unknownReviewPrefix = prefix; },
    pauseCompletions() { holdCompletions = true; },
    resumeCompletions() {
      holdCompletions = false;
      for (const [response, resume] of pendingCompletions) {
        pendingCompletions.delete(response);
        if (!response.destroyed) resume();
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
