/** Explicit, paid-provider opt-in: one synthetic unit, real main runtime and GUI. */
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { ElectronApplication } from "playwright-core";
import type { TaskReviewSnapshot } from "../src/shared/task-review";
import type { TaskAgentBridge } from "../src/shared/task-review-runtime-types";
import { createEvidence } from "./harness/evidence";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { configureTaskReviewDeepSeekProfile, TASK_REVIEW_DEEPSEEK } from "./harness/task-review-deepseek";
import { openGlobalScene, openNoteTab } from "./harness/task-review-shell";

const SOURCE = "讲解员：现在是2026年，我们刚刚抵达展馆。";
const GOAL = "公开原创合成测试。已知设定：当前年份固定为2025年；讲解员说的是本场现在，没有说谎、梦境、回忆或跨年情节。请核对台词与明确年份设定的一致性；矛盾请给出精确原话证据和待人工确认的假设，不替人工做决定。";
const FEEDBACK = "这里的年份与已知设定不一致，建议";

interface RequestObservation {
  kind: "review-or-search" | "completion";
  model: string;
  startedAt: string;
  elapsedMs?: number;
  status?: number;
  networkError?: boolean;
}
interface NetworkObservation { requests: RequestObservation[]; refusedOverBudget: boolean }

/** Counts and caps real forwarding requests; never reads headers or credentials. */
async function observeProvider(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const scope = globalThis as typeof globalThis & { taskReviewAcceptanceNetwork?: NetworkObservation };
    const observations: NetworkObservation = { requests: [], refusedOverBudget: false };
    scope.taskReviewAcceptanceNetwork = observations;
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const address = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (address.origin !== "https://api.deepseek.com" || address.pathname !== "/chat/completions") return nativeFetch(input, init);
      if (observations.requests.length >= 6) {
        observations.refusedOverBudget = true;
        throw new Error("Real-provider acceptance request budget exhausted");
      }
      const body = JSON.parse(String(init?.body)) as { model: string; max_tokens: number };
      const record: RequestObservation = { kind: body.max_tokens === 800 ? "completion" : "review-or-search", model: body.model, startedAt: new Date().toISOString() };
      observations.requests.push(record);
      const started = Date.now();
      try {
        const response = await nativeFetch(input, init);
        record.status = response.status;
        record.elapsedMs = Date.now() - started;
        return response;
      } catch (error) {
        record.networkError = true;
        record.elapsedMs = Date.now() - started;
        throw error;
      }
    };
  });
}
async function observeNetwork(app: ElectronApplication): Promise<NetworkObservation> {
  return app.evaluate(() => (globalThis as typeof globalThis & { taskReviewAcceptanceNetwork: NetworkObservation }).taskReviewAcceptanceNetwork);
}
async function snapshot(root: string): Promise<TaskReviewSnapshot> {
  return { root, ...JSON.parse(await readFile(path.join(root, ".reelterminal", "task-review.json"), "utf8")) };
}

test.runIf(process.env.REELTERMINAL_TASK_REVIEW_DEEPSEEK_ACCEPTANCE === "1")("DeepSeek real channel reviews one synthetic year conflict and continues inline feedback", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "task-review-deepseek-"));
  const evidence = createEvidence("task-review-deepseek");
  const started = Date.now();
  let launched: LaunchedApp | undefined;
  evidence.record("scope", { model: TASK_REVIEW_DEEPSEEK.model, date: new Date().toISOString(), synthetic: true, unitCount: 1, requestLimit: 6, qualityClaim: "Single-case channel acceptance only; no general or cross-source quality claim" });
  try {
    launched = await launchApp({ runDir });
    evidence.bindPage(launched.page);
    await observeProvider(launched.app);
    const configured = await configureTaskReviewDeepSeekProfile(launched.app);
    expect(configured).toMatchObject({ endpoint: TASK_REVIEW_DEEPSEEK.endpoint, completionModel: TASK_REVIEW_DEEPSEEK.model, hasApiKey: true });
    const page = launched.page;
    evidence.bindPage(page);
    // The existing main model store reads its file on demand; verify this
    // instance sees the helper-written profile before opening/authorizing a task.
    expect(await page.evaluate(() => {
      const scope = window as unknown as { reelterminal: { taskAgent: Pick<TaskAgentBridge, "getModelConfig"> } };
      return scope.reelterminal.taskAgent.getModelConfig();
    })).toMatchObject(configured);
    await page.evaluate(() => localStorage.setItem("openreel-locale", "zh-CN"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: /审阅工作台/ }).click();
    await page.getByTestId("review-workspace-open").click();
    await page.getByTestId("folder-task-new").click();
    const create = page.getByRole("dialog", { name: "新建任务" });
    await create.getByLabel("任务名称").fill("DeepSeek公开合成单例");
    await create.getByLabel("文件夹名称").fill("deepseek-single-case");
    await create.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByTestId("task-review-workspace").waitFor();
    const root = path.join(launched.userDataDir, "review", "tasks", "deepseek-single-case");
    await openGlobalScene(page);
    // Panels are collapsed by default in the rewritten overview; expand each
    // section through its own toggle before filling it.
    await page.getByTestId("task-review-show-goal").click();
    await page.getByLabel("任务目标口径", { exact: true }).fill(GOAL);
    await page.getByRole("button", { name: "保存目标口径", exact: true }).click();
    await page.getByTestId("task-review-show-import").click();
    await page.getByLabel("原文名称", { exact: true }).fill("公开合成年份矛盾");
    await page.getByLabel("原文格式", { exact: true }).selectOption("txt");
    await page.getByLabel("粘贴文本内容", { exact: true }).fill(SOURCE);
    await page.getByTestId("task-review-import-text").click();
    await vi.waitFor(async () => expect((await snapshot(root)).units).toHaveLength(1));
    expect((await observeNetwork(launched.app)).requests).toEqual([]);
    await page.getByTestId("task-review-show-model").click();
    await page.getByTestId("task-review-authorize").click();
    await page.getByTestId("task-review-grant").waitFor();
    await vi.waitFor(async () => {
      const jobs = JSON.parse(await readFile(path.join(root, ".reelterminal", "task-review-jobs.json"), "utf8")) as { jobs: { status: string }[] };
      expect(jobs.jobs.length).toBeGreaterThan(0);
      expect(jobs.jobs.every(job => ["completed", "failed", "cancelled"].includes(job.status))).toBe(true);
    }, { timeout: 150000, interval: 500 });
    const jobs = JSON.parse(await readFile(path.join(root, ".reelterminal", "task-review-jobs.json"), "utf8")) as { jobs: { status: string; error?: string; attempts: number }[] };
    evidence.record("jobs", jobs.jobs.map(({ status, error, attempts }) => ({ status, error, attempts })));
    expect(jobs.jobs.every(job => job.status === "completed"), JSON.stringify(jobs.jobs.map(({ status, error }) => ({ status, error })))).toBe(true);
    const task = await snapshot(root);
    evidence.record("syntheticCase", { goal: GOAL, source: SOURCE, issues: task.issues });
    expect(task.issues.length).toBeGreaterThan(0);
    expect(task.issues.every(issue => issue.evidence.trim() && SOURCE.includes(issue.evidence))).toBe(true);
    expect(task.issues.some(issue => /202[56]|年份/.test(`${issue.title} ${issue.evidence} ${issue.hypothesis}`))).toBe(true);
    expect(task.decisions).toEqual([]);
    await page.getByTestId("task-review-unit-row").filter({ hasText: SOURCE }).click();
    await page.getByTestId("task-review-issue").first().waitFor();
    await evidence.screenshot("real-issue-default-node");
    // The note editor lives behind the card's 批注 tab in the rewritten shell.
    await openNoteTab(page);
    const beforeCompletion = (await observeNetwork(launched.app)).requests.length;
    const feedback = page.getByTestId("task-review-unit-note");
    await feedback.fill(FEEDBACK);
    // No explicit completion click: the real provider follows the default
    // scene's one-second pause trigger through the normal runtime.
    await vi.waitFor(async () => expect((await observeNetwork(launched!.app)).requests.length).toBeGreaterThan(beforeCompletion), { timeout: 10000 });
    await vi.waitFor(async () => expect(await page.getByTestId("task-review-complete-status").textContent()).toContain("候选生成完毕"), { timeout: 40000 });
    const suggestion = await page.getByTestId("task-review-suggestion").textContent();
    expect(suggestion?.trim()).toBeTruthy();
    expect(await feedback.inputValue()).toBe(FEEDBACK);
    expect(await page.getByTestId("task-review-unit-text").textContent()).toBe(SOURCE);
    expect((await snapshot(root)).sources[0].text).toBe(SOURCE);
    expect((await snapshot(root)).decisions).toEqual([]);
    const network = await observeNetwork(launched.app);
    expect(network.requests.length).toBeLessThanOrEqual(6);
    expect(network.refusedOverBudget).toBe(false);
    evidence.record("network", network);
    evidence.record("inlineFeedback", {
      input: FEEDBACK, suggestion, explicitGenerationClicks: 0, sourceUnchanged: true, inputUnchanged: true,
      repeatsDraftPrefix: suggestion!.trimStart().startsWith(FEEDBACK.trimStart()),
      qualityLimit: "Repeated draft prefixes are reported, not treated as general completion-quality acceptance",
    });
    await evidence.screenshot("real-inline-candidate");
    evidence.flush({ passed: true, elapsedMs: Date.now() - started });
  } catch (error) {
    if (launched) {
      evidence.record("network", await observeNetwork(launched.app));
      await evidence.screenshot("failure").catch((problem: unknown) => {
        evidence.record("screenshotError", problem instanceof Error ? problem.message : String(problem));
      });
    }
    evidence.flush({ passed: false, elapsedMs: Date.now() - started, failure: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await launched?.close();
  }
});
