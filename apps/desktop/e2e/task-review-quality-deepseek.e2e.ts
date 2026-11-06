/** Opt-in real-provider observations on public synthetic text, never a benchmark. */
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { ElectronApplication, Page } from "playwright-core";
import { isTextTaskUnit, type TaskReviewSnapshot } from "../src/shared/task-review";
import { validateTaskEvidence, type TaskEvidenceRef } from "../src/shared/task-review-context";
import { prepareTaskReviewBatches, validateTaskReviewBatchResponse, type PreparedTaskReviewBatch } from "../src/main/task-review-context-model";
import type { TaskAgentState } from "../src/shared/task-review-runtime-types";
import { createEvidence } from "./harness/evidence";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { ARTIFACTS_DIR, MAIN_BUNDLE_PATH } from "./harness/paths";
import { configureTaskReviewDeepSeekProfile, TASK_REVIEW_DEEPSEEK } from "./harness/task-review-deepseek";

interface Observation {
  purpose: "review" | "completion" | "search" | "expansion";
  caseId: string;
  model: string;
  startedAt: string;
  headersElapsedMs?: number;
  streamElapsedMs?: number;
  status?: number;
  networkError?: boolean;
  streamError?: boolean;
  searchOutput?: unknown;
  preparedBatchText?: string;
  assistantOutput?: string;
  finishReasons?: (string | null)[];
}
interface Network { requests: Observation[]; refusedOverBudget: boolean; caseId: string }

async function observe(app: ElectronApplication, diagnostic: boolean) {
  await app.evaluate((_electron, diagnostic) => {
    const scope = globalThis as typeof globalThis & { textQualityNetwork?: Network };
    const network: Network = { requests: [], refusedOverBudget: false, caseId: "setup" };
    scope.textQualityNetwork = network;
    const nativeFetch = globalThis.fetch;
    let providerFailed = false;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== "https://api.deepseek.com" || url.pathname !== "/chat/completions") return nativeFetch(input, init);
      if (providerFailed) throw new Error("Real-provider acceptance stopped after its first failed request");
      if (network.requests.length >= (diagnostic ? 1 : 6)) { network.refusedOverBudget = true; throw new Error("Real text quality request limit reached"); }
      const body = JSON.parse(String(init?.body)) as { model: string; max_tokens: number; messages: { role: string; content: string }[] };
      const system = body.messages.find(message => message.role === "system")?.content ?? "";
      const purpose = system.includes("Expand only the supplied search query") ? "expansion" : system.includes("Find semantic matches") ? "search" : body.max_tokens === 800 ? "completion" : "review";
      const record: Observation = { purpose, caseId: network.caseId, model: body.model, startedAt: new Date().toISOString() };
      // This opt-in spec supplies only our public synthetic material. Never
      // install this capture observer in ordinary user/project sessions.
      record.preparedBatchText = body.messages.find(message => message.role === "user")?.content;
      network.requests.push(record);
      const started = Date.now();
      try {
        const response = await nativeFetch(input, init);
        record.status = response.status;
        if (!response.ok) providerFailed = true;
        record.headersElapsedMs = Date.now() - started;
        // Observe a native response clone without replacing production bytes.
        void response.clone().text().then(text => {
          record.streamElapsedMs = Date.now() - started;
          const finishReasons: (string | null)[] = [];
          const content = text.split(/\r?\n/).filter(line => line.startsWith("data: ") && !line.includes("[DONE]")).map(line => {
            const item = JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string }; finish_reason?: string | null }[] };
            if (item.choices?.[0]?.finish_reason) finishReasons.push(item.choices[0].finish_reason!);
            return item.choices?.[0]?.delta?.content ?? "";
          }).join("");
          record.assistantOutput = content; record.finishReasons = finishReasons;
          if (purpose === "search") record.searchOutput = JSON.parse(content);
        }).catch(() => { record.streamError = true; });
        return response;
      } catch (error) { providerFailed = true; record.networkError = true; record.headersElapsedMs = Date.now() - started; throw error; }
    };
  }, diagnostic);
}
const networkAt = (app: ElectronApplication) => app.evaluate(() => (globalThis as typeof globalThis & { textQualityNetwork: Network }).textQualityNetwork);
const snapshotAt = async (root: string): Promise<TaskReviewSnapshot> => ({ root, ...JSON.parse(await readFile(path.join(root, ".reelterminal", "task-review.json"), "utf8")) });
const globalScene = async (page: Page) => { await page.getByTestId("task-review-scene-switch").getByRole("button", { name: "全局", exact: true }).click(); };
const showGlobalPanel = async (page: Page, panel: "goal" | "import" | "model") => {
  const button = page.getByTestId(`task-review-show-${panel}`);
  if (await button.getAttribute("aria-expanded") !== "true") await button.click();
};
const savePublicCapture = async (app: ElectronApplication) => writeFile(path.join(ARTIFACTS_DIR, "task-review-quality-deepseek-batches.json"), JSON.stringify({ syntheticOnly: true, ...(await networkAt(app)) }, null, 2));

interface DiagnosticInput { snapshot: TaskReviewSnapshot; authorizedSourceVersionIds: string[]; batch: PreparedTaskReviewBatch; assistantOutput: string }
function offlineDiagnosis(input: DiagnosticInput) {
  let validation: { accepted: boolean; name?: string; message?: string; stack?: string };
  try { validateTaskReviewBatchResponse(input.snapshot, input.snapshot.contextHistory!, input.batch, input.assistantOutput, input.authorizedSourceVersionIds); validation = { accepted: true }; }
  catch (error) { validation = error instanceof Error ? { accepted: false, name: error.name, message: error.message, stack: error.stack } : { accepted: false, message: String(error) }; }
  const evidenceErrors: unknown[] = [];
  const inspect = (value: unknown, location: string) => {
    if (Array.isArray(value)) { value.forEach((child, index) => inspect(child, `${location}[${index}]`)); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "sourceRefs" && Array.isArray(child)) child.forEach((ref: TaskEvidenceRef, index) => {
        try { validateTaskEvidence(input.snapshot, [ref], input.authorizedSourceVersionIds); }
        catch (error) {
          const unit = input.snapshot.units.filter(isTextTaskUnit).find(unit => unit.id === ref.unitId && unit.sourceVersionId === ref.sourceVersionId);
          evidenceErrors.push({ path: `${location}.sourceRefs[${index}]`, ref, actualSubstring: unit?.text.slice(ref.start, ref.end), unitText: unit?.text, message: error instanceof Error ? error.message : String(error) });
        }
      });
      inspect(child, `${location}.${key}`);
    }
  };
  try { inspect(JSON.parse(input.assistantOutput), "$" ); }
  catch (error) { evidenceErrors.push({ path: "$", parseError: error instanceof Error ? error.message : String(error) }); }
  return { validation, evidenceErrors };
}

test.runIf(process.env.REELTERMINAL_TASK_REVIEW_DEEPSEEK_ACCEPTANCE === "1")("observes four synthetic text cases using real DeepSeek batch, inline completion and scoped search", async () => {
  const dataset = JSON.parse(await readFile(path.join(import.meta.dirname, "fixtures", "task-review-quality.zh.json"), "utf8")) as {
    cases: { id: string; title: string; goal: string; source: { format: string; text: string }; humanCheckpoints: string[] }[];
  };
  const runDir = await mkdtemp(path.join(os.tmpdir(), "task-review-quality-"));
  const diagnostic = process.env.REELTERMINAL_TASK_REVIEW_DEEPSEEK_DIAGNOSTIC === "1";
  const cases = diagnostic ? dataset.cases.slice(0, 1) : dataset.cases;
  const evidence = createEvidence(diagnostic ? "task-review-quality-deepseek-diagnostic" : "task-review-quality-deepseek");
  const results: unknown[] = [];
  let launched: LaunchedApp | undefined;
  let currentRoot: string | undefined;
  const started = Date.now();
  evidence.record("scope", { date: new Date().toISOString(), model: TASK_REVIEW_DEEPSEEK.model, requestLimit: diagnostic ? 1 : 6, priorRequestsInAuthorizedBudget: 4, cumulativeAuthorizedLimit: 10, synthetic: true, cases: cases.length, buildTimestamp: (await stat(MAIN_BUNDLE_PATH)).mtime.toISOString(), qualityClaim: "Public synthetic cases only; human interpretation required, no statistical accuracy or final media-package claim" });
  try {
    launched = await launchApp({ runDir });
    evidence.bindPage(launched.page);
    await observe(launched.app, diagnostic);
    await configureTaskReviewDeepSeekProfile(launched.app);
    const page = launched.page;
    expect(await page.evaluate(() => window.reelterminal!.taskAgent!.getModelConfig())).toMatchObject({ endpoint: TASK_REVIEW_DEEPSEEK.endpoint, backgroundModel: TASK_REVIEW_DEEPSEEK.model, hasApiKey: true });
    await page.evaluate(() => localStorage.setItem("openreel-locale", "zh-CN"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: /审阅工作台/ }).click();
    for (const [index, item] of cases.entries()) {
      await launched.app.evaluate((_electron, caseId) => { (globalThis as typeof globalThis & { textQualityNetwork: Network }).textQualityNetwork.caseId = caseId; }, item.id);
      await page.getByTestId("review-workspace-open").click();
      await page.getByTestId("folder-task-new").click();
      const create = page.getByRole("dialog", { name: "新建任务" });
      const folderName = `deepseek-quality-${index + 1}`;
      await create.getByLabel("任务名称").fill(`公开合成质量检查：${item.title}`);
      await create.getByLabel("文件夹名称").fill(folderName);
      await create.getByRole("button", { name: "创建", exact: true }).click();
      await page.getByTestId("task-review-workspace").waitFor();
      currentRoot = path.join(launched.userDataDir, "review", "tasks", folderName);
      await globalScene(page);
      await showGlobalPanel(page, "goal");
      await page.getByLabel("任务目标口径", { exact: true }).fill(item.goal);
      await page.getByRole("button", { name: "保存目标口径", exact: true }).click();
      const inputs = index === 0 ? item.source.text.split("\n") : [item.source.text];
      for (const [sourceIndex, text] of inputs.entries()) {
        await showGlobalPanel(page, "import");
        await page.getByLabel("原文名称", { exact: true }).fill(`${item.id}-${sourceIndex + 1}`);
        await page.getByLabel("原文格式", { exact: true }).selectOption(item.source.format);
        await page.getByLabel("粘贴文本内容", { exact: true }).fill(text);
        await page.getByTestId("task-review-import-text").click();
        await vi.waitFor(async () => expect((await snapshotAt(currentRoot!)).sources).toHaveLength(sourceIndex + 1));
      }
      const beforeAuthorization = (await networkAt(launched.app)).requests.length;
      const snapshotBeforeAnalysis = await snapshotAt(currentRoot);
      await showGlobalPanel(page, "model");
      await page.getByTestId("task-review-authorize").click();
      await page.getByTestId("task-review-grant").waitFor();
      await vi.waitFor(async () => {
        const jobs = JSON.parse(await readFile(path.join(currentRoot!, ".reelterminal", "task-review-jobs.json"), "utf8")) as { jobs: { status: string }[] };
        expect(jobs.jobs.length).toBeGreaterThan(0);
        expect(jobs.jobs.every(job => ["completed", "failed", "cancelled"].includes(job.status))).toBe(true);
      }, { timeout: 150000, interval: 500 });
      const jobs = JSON.parse(await readFile(path.join(currentRoot, ".reelterminal", "task-review-jobs.json"), "utf8")) as { jobs: { status: string; error?: string; attempts: number }[] };
      let task = await snapshotAt(currentRoot);
      await vi.waitFor(async () => expect((await networkAt(launched!.app)).requests.at(-1)?.assistantOutput).toBeDefined(), { timeout: 5000 });
      if (!diagnostic) await savePublicCapture(launched.app);
      const publicState: TaskAgentState = await page.evaluate(target => window.reelterminal!.taskAgent!.getState(target), { root: currentRoot, taskId: task.taskId });
      const completed = new Set(publicState.jobs.flatMap(job => job.completedUnitIds));
      const scenes = task.planRevisions.at(-1)?.scenes ?? [];
      results.push({ id: item.id, goal: item.goal, snapshotBeforeAnalysis, snapshot: task, sources: task.sources, units: task.units, humanCheckpoints: item.humanCheckpoints, jobs: jobs.jobs.map(({ status, error, attempts }) => ({ status, error, attempts })), understanding: task.contextHistory?.proposals, issues: task.issues, scenes, completedUnitIds: [...completed] });
      evidence.record("cases", results);
      if (diagnostic) {
        await vi.waitFor(async () => expect((await networkAt(launched!.app)).requests[0]?.assistantOutput).toBeDefined(), { timeout: 5000 });
        const network = await networkAt(launched.app);
        const request = network.requests[0];
        const outbound = JSON.parse(request.preparedBatchText!);
        const authorizedSourceVersionIds = task.sources.map(source => source.id);
        const prepared = prepareTaskReviewBatches({ snapshot: task, history: task.contextHistory!, authorizedSourceVersionIds, purpose: outbound.purpose, targets: outbound.coverage.targets });
        expect(prepared.batches).toHaveLength(1);
        const batch = { ...prepared.batches[0], input: request.preparedBatchText! };
        const input: DiagnosticInput = { snapshot: task, authorizedSourceVersionIds, batch, assistantOutput: request.assistantOutput! };
        const output = { syntheticOnly: true, network, outboundPreparedBatch: outbound, input, diagnosis: offlineDiagnosis(input), regeneratedPreparedInputMatches: JSON.stringify(JSON.parse(prepared.batches[0].input)) === JSON.stringify(outbound) };
        const diagnosticPath = path.join(ARTIFACTS_DIR, "task-review-quality-deepseek-diagnostic-raw.json");
        await writeFile(diagnosticPath, JSON.stringify(output, null, 2));
        expect(network.requests).toHaveLength(1);
        expect(network.refusedOverBudget).toBe(false);
        evidence.record("diagnostic", { path: diagnosticPath, result: output.diagnosis, regeneratedPreparedInputMatches: output.regeneratedPreparedInputMatches });
        evidence.record("network", network.requests.map(({ preparedBatchText: _input, assistantOutput: _output, ...request }) => request));
        await evidence.screenshot("single-batch-result");
        evidence.flush({ diagnosticCaptured: true, elapsedMs: Date.now() - started, executionPassed: jobs.jobs.every(job => job.status === "completed") });
        return;
      }
      expect(jobs.jobs.every(job => job.status === "completed"), JSON.stringify(jobs.jobs.map(({ status, error }) => ({ status, error })))).toBe(true);
      await page.getByRole("button", { name: "返回总览", exact: true }).click();
      expect((await networkAt(launched.app)).requests.length).toBeGreaterThan(beforeAuthorization);
      expect(task.decisions).toEqual([]);
      for (const issue of task.issues) for (const ref of issue.sourceRefs ?? []) {
        const unit = task.units.filter(isTextTaskUnit).find(unit => unit.id === ref.unitId && unit.sourceVersionId === ref.sourceVersionId)!;
        expect(unit.text.slice(ref.start, ref.end)).toBe(ref.text);
      }
      for (const scene of scenes.filter(scene => scene.kind === "lowRiskGroup")) {
        expect(scene.targets.every(target => completed.has(target.unitId))).toBe(true);
        expect(scene.targets.every(target => !task.issues.some(issue => issue.unitId === target.unitId))).toBe(true);
      }
      await evidence.screenshot(`${item.id}-global-understanding-plan`);
      const chosen = index === 0 ? task.units.filter(isTextTaskUnit).find(unit => unit.text.includes("小时候"))! : task.units.filter(isTextTaskUnit)[0];
      await page.getByTestId("task-review-unit-row").filter({ hasText: chosen.text }).click();
      await evidence.screenshot(`${item.id}-source-and-issues`);
      if (index === 0) {
        const feedbackText = "这段童年经历与已知背景冲突，建议";
        const feedback = page.getByTestId("task-review-unit-note");
        const beforeCompletion = (await networkAt(launched.app)).requests.length;
        await feedback.fill(feedbackText);
        await vi.waitFor(async () => expect((await networkAt(launched!.app)).requests.length).toBeGreaterThan(beforeCompletion), { timeout: 10000 });
        await vi.waitFor(async () => expect(await page.getByTestId("task-review-complete-status").textContent()).toContain("候选生成完毕"), { timeout: 60000 });
        const suggestion = await page.getByTestId("task-review-suggestion").textContent();
        expect(suggestion?.trim()).toBeTruthy();
        expect(await feedback.inputValue()).toBe(feedbackText);
        expect(await page.getByTestId("task-review-unit-text").textContent()).toBe(chosen.text);
        task = await snapshotAt(currentRoot);
        expect(task.decisions).toEqual([]);
        evidence.record("completion", { input: feedbackText, suggestion, explicitGenerationClicks: 0, draftUnchanged: true, sourceUnchanged: true, literalPrefixCheck: suggestion!.trimStart().startsWith(feedbackText), repeatedPrefix: suggestion!.trimStart().replace(/^[“"‘'「『]+/u, "").startsWith(feedbackText), candidateCharacters: suggestion!.length });
        await evidence.screenshot("character-continuity-inline-completion");
        await globalScene(page);
        await page.getByLabel("语义搜索范围", { exact: true }).selectOption("task");
        await page.getByLabel("搜索条目文本", { exact: true }).fill("童年反复到真实地球海边嬉水的经历");
        await page.getByTestId("task-review-semantic-search").click();
        await page.getByTestId("task-review-semantic-result").waitFor({ timeout: 60000 });
        evidence.record("searchVisibleCoverage", await page.getByTestId("task-review-semantic-result").textContent());
        await evidence.screenshot("character-continuity-semantic-coverage");
        const hit = page.getByTestId("task-review-unit-row").filter({ hasText: chosen.text });
        const matchTitle = await hit.getAttribute("title");
        expect(matchTitle).toContain("引文：");
        const visibleQuotes = matchTitle!.split("引文：")[1].split(" / ");
        expect(visibleQuotes.every(quote => chosen.text.includes(quote))).toBe(true);
        evidence.record("searchVisibleCitations", { matchTitle, exactQuotes: visibleQuotes, unitId: chosen.id, sourceVersionId: chosen.sourceVersionId });
        await hit.click();
        expect(await page.getByTestId("task-review-unit-text").textContent()).toBe(chosen.text);
        expect((await snapshotAt(currentRoot)).decisions).toEqual([]);
        await evidence.screenshot("character-continuity-semantic-jump");
      }
    }
    const network = await networkAt(launched.app);
    expect(network.requests.length).toBeLessThanOrEqual(6);
    expect(network.refusedOverBudget).toBe(false);
    expect(network.requests.every(request => request.status === 200 && !request.networkError)).toBe(true);
    evidence.record("network", network);
    await savePublicCapture(launched.app);
    evidence.flush({ executionPassed: true, elapsedMs: Date.now() - started, qualityJudgment: "Review actual issues, quotes, scene choices and uncertainty manually; passing invariants is not an accuracy claim" });
  } catch (error) {
    if (launched) {
      evidence.record("network", await networkAt(launched.app));
      if (!diagnostic) await savePublicCapture(launched.app);
      if (currentRoot) evidence.record("failureSnapshot", await snapshotAt(currentRoot));
      await evidence.screenshot("failure");
    }
    evidence.flush({ executionPassed: false, elapsedMs: Date.now() - started, failure: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally { await launched?.close(); }
});

test.runIf(process.env.REELTERMINAL_TASK_REVIEW_DEEPSEEK_REPLAY === "1")("replays the captured public synthetic batch through the production validator without a model", async () => {
  const artifact = JSON.parse(await readFile(path.join(ARTIFACTS_DIR, "task-review-quality-deepseek-diagnostic-raw.json"), "utf8")) as { input: DiagnosticInput; diagnosis: ReturnType<typeof offlineDiagnosis> };
  const replay = offlineDiagnosis(artifact.input);
  expect(replay.validation.accepted).toBe(true);
  expect(replay.evidenceErrors).toEqual(artifact.diagnosis.evidenceErrors);
  await writeFile(path.join(ARTIFACTS_DIR, "task-review-quality-deepseek-offline-replay.json"), JSON.stringify({ modelRequests: 0, ...replay }, null, 2));
});

test.runIf(process.env.REELTERMINAL_TASK_REVIEW_DEEPSEEK_REPLAY === "latest")("diagnoses the latest public batch offline without a model request", async () => {
  const capture = JSON.parse(await readFile(path.join(ARTIFACTS_DIR, "task-review-quality-deepseek-batches.json"), "utf8")) as Network;
  const observed = JSON.parse(await readFile(path.join(ARTIFACTS_DIR, "task-review-quality-deepseek.json"), "utf8")) as { cases?: { snapshot?: TaskReviewSnapshot }[]; failureSnapshot?: TaskReviewSnapshot };
  const request = capture.requests.find(request => request.purpose === "review")!;
  const outbound = JSON.parse(request.preparedBatchText!);
  const snapshot = observed.cases?.[0]?.snapshot ?? observed.failureSnapshot!;
  const authorizedSourceVersionIds = snapshot.sources.map(source => source.id);
  const prepared = prepareTaskReviewBatches({ snapshot, history: snapshot.contextHistory!, authorizedSourceVersionIds, purpose: outbound.purpose, targets: outbound.coverage.targets });
  expect(prepared.batches).toHaveLength(1);
  const input: DiagnosticInput = { snapshot, authorizedSourceVersionIds, batch: { ...prepared.batches[0], input: request.preparedBatchText! }, assistantOutput: request.assistantOutput! };
  const diagnosis = offlineDiagnosis(input);
  await writeFile(path.join(ARTIFACTS_DIR, "task-review-quality-deepseek-latest-offline.json"), JSON.stringify({ modelRequests: 0, input, diagnosis }, null, 2));
  expect(diagnosis.validation.accepted).toBe(false);
  expect(diagnosis.validation.message).toBe("Model response invalid [SCHEMA_INVALID] at $");
});
