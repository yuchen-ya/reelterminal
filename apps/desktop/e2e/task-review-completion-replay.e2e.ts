/** Recorded real output over local SSE; zero remote provider calls or keys. */
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { isTextTaskUnit, type TaskReviewSnapshot } from "../src/shared/task-review";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { createEvidence } from "./harness/evidence";
import { startTaskReviewModelFixture, TASK_REVIEW_FIXTURE_KEY } from "./harness/task-review-model-fixture";
import { openGlobalScene, openNoteTab } from "./harness/task-review-shell";

const snapshotAt = async (root: string): Promise<TaskReviewSnapshot> => ({ root, ...JSON.parse(await readFile(path.join(root, ".reelterminal", "task-review.json"), "utf8")) });

test.runIf(Boolean(process.env.REELTERMINAL_E2E_APP_EXECUTABLE))("packaged GUI replays the exact real quoted completion and adopts only its suffix", async () => {
  const captured = JSON.parse(await readFile(path.join(import.meta.dirname, "../src/main/__fixtures__/task-review-deepseek-completion-response.json"), "utf8")) as {
    syntheticOnly: boolean; preparedInput: { goal: string; source: string; reviewFeedbackDraft: string }; response: string;
  };
  expect(captured.syntheticOnly).toBe(true);
  const draft = captured.preparedInput.reviewFeedbackDraft;
  expect(captured.response.startsWith(`“${draft}`)).toBe(true);
  expect(captured.response.endsWith("”")).toBe(true);
  const expectedSuffix = captured.response.slice(1, -1).slice(draft.length);
  const internalQuote = "‘我小时候每个夏天都在地球这片海里游泳’";
  expect(expectedSuffix).toContain(internalQuote);
  const model = await startTaskReviewModelFixture({ completionResponse: captured.response });
  const runDir = await mkdtemp(path.join(os.tmpdir(), "task-review-completion-replay-"));
  const evidence = createEvidence("task-review-completion-replay");
  let launched: LaunchedApp | undefined;
  try {
    launched = await launchApp({ runDir, env: { DEEPSEEK_API_KEY: "", REELTERMINAL_TASK_REVIEW_DEEPSEEK_ACCEPTANCE: "0" } });
    const page = launched.page;
    evidence.bindPage(page);
    const application = await launched.app.evaluate(async ({ app }) => {
      const fs = process.getBuiltinModule("fs/promises") as typeof import("node:fs/promises");
      const path = process.getBuiltinModule("path") as typeof import("node:path");
      const directory = path.join(process.resourcesPath, "segmentation", "mobilesam");
      const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")) as { modelVersion: string; files: Record<string, { name: string; bytes: number }> };
      const models = await Promise.all(Object.values(manifest.files).map(async file => ({ name: file.name, expectedBytes: file.bytes, actualBytes: (await fs.stat(path.join(directory, file.name))).size })));
      return { version: app.getVersion(), packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(), executable: process.execPath,
        resources: { modelVersion: manifest.modelVersion, models, workerBytes: (await fs.stat(path.join(process.resourcesPath, "app.asar.unpacked", "dist", "main", "segmentation", "worker.js"))).size } };
    });
    evidence.record("application", application);
    expect(application).toMatchObject({ version: "1.4.0", packaged: true });
    expect(path.resolve(application.executable).toLowerCase()).toBe(path.resolve(process.env.REELTERMINAL_E2E_APP_EXECUTABLE!).toLowerCase());
    expect(application.resources.workerBytes).toBeGreaterThan(0);
    expect(application.resources.models.every(model => model.actualBytes === model.expectedBytes)).toBe(true);
    await page.evaluate(() => localStorage.setItem("openreel-locale", "zh-CN"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: /审阅工作台/ }).click();
    await page.getByTestId("review-workspace-open").click();
    await page.getByTestId("folder-task-new").click();
    const creation = page.getByRole("dialog", { name: "新建任务" });
    await creation.getByLabel("任务名称").fill("真实响应离线回放");
    await creation.getByLabel("文件夹名称").fill("completion-replay");
    await creation.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByTestId("task-review-workspace").waitFor();
    const root = path.join(launched.userDataDir, "review", "tasks", "completion-replay");
    await openGlobalScene(page);
    await page.getByTestId("task-review-show-goal").click();
    await page.getByLabel("任务目标口径", { exact: true }).fill(captured.preparedInput.goal);
    await page.getByRole("button", { name: "保存目标口径", exact: true }).click();
    await page.getByTestId("task-review-show-import").click();
    await page.getByLabel("原文名称", { exact: true }).fill("公开合成真实响应回放");
    await page.getByLabel("原文格式", { exact: true }).selectOption("txt");
    await page.getByLabel("粘贴文本内容", { exact: true }).fill(captured.preparedInput.source);
    await page.getByTestId("task-review-import-text").click();
    await vi.waitFor(async () => expect((await snapshotAt(root)).units).toHaveLength(1));
    const unit = (await snapshotAt(root)).units.find(isTextTaskUnit)!;
    await page.getByTestId("task-review-show-model").click();
    await page.getByLabel("模型接口地址", { exact: true }).fill(model.endpoint);
    await page.getByLabel("后台分析模型名称", { exact: true }).fill("synthetic-review");
    await page.getByLabel("续写模型名称", { exact: true }).fill("recorded-real-response");
    await page.getByLabel("模型 API 密钥", { exact: true }).fill(TASK_REVIEW_FIXTURE_KEY);
    await page.getByTestId("task-review-model-save").click();
    await vi.waitFor(async () => expect(await page.getByTestId("task-review-model-status").textContent()).toContain("已保存"));
    await page.getByTestId("task-review-authorize").click();
    await vi.waitFor(async () => expect((await snapshotAt(root)).contextHistory?.proposals.length).toBeGreaterThan(0));
    await page.getByRole("button", { name: "返回总览", exact: true }).click();
    await page.getByTestId("task-review-unit-row").filter({ hasText: unit.text }).click();
    // The note editor lives behind the card's 批注 tab in the rewritten shell.
    await openNoteTab(page);
    const feedback = page.getByTestId("task-review-unit-note");
    await feedback.fill(draft);
    const beforeSelection = await feedback.evaluate(node => ({ start: (node as HTMLTextAreaElement).selectionStart, end: (node as HTMLTextAreaElement).selectionEnd }));
    await vi.waitFor(async () => expect(await page.getByTestId("task-review-complete-status").textContent()).toContain("候选生成完毕"), { timeout: 10000 });
    expect(model.requests.filter(request => request.kind === "completion")).toHaveLength(1);
    expect(await page.getByTestId("task-review-suggestion").textContent()).toBe(expectedSuffix);
    expect(expectedSuffix).not.toContain(draft);
    expect(await feedback.inputValue()).toBe(draft);
    expect(await feedback.evaluate(node => ({ start: (node as HTMLTextAreaElement).selectionStart, end: (node as HTMLTextAreaElement).selectionEnd }))).toEqual(beforeSelection);
    expect(await page.getByTestId("task-review-unit-text").textContent()).toBe(captured.preparedInput.source);
    await evidence.screenshot("exact-recorded-response-suffix-before-adoption");
    await page.getByTestId("task-review-adopt-all").click();
    expect(await feedback.inputValue()).toBe(draft + expectedSuffix);
    await vi.waitFor(async () => expect((await snapshotAt(root)).drafts.find(saved => saved.unitId === unit.id)?.text).toBe(draft + expectedSuffix));
    const task = await snapshotAt(root);
    expect(task.units.find(isTextTaskUnit)?.text).toBe(captured.preparedInput.source);
    expect(task.decisions).toEqual([]);
    expect(model.errors).toEqual([]);
    await evidence.screenshot("explicit-adoption-draft-plus-exact-suffix");
    evidence.record("replay", { capturedResponse: captured.response, originalDraft: draft, expectedSuffix, adoptedDraft: draft + expectedSuffix, internalQuotePreserved: true, selectionBefore: beforeSelection, sourceUnchanged: true, humanDecisions: task.decisions, providerRequests: 0, localSseRequests: model.requests });
    evidence.flush({ passed: true, evidenceLimit: "Exact previously captured real response replayed over local SSE; not a new provider-quality sample or the eleventh remote request" });
  } catch (error) {
    if (launched) await evidence.screenshot("failure");
    evidence.flush({ passed: false, failure: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally { try { await launched?.close(); } finally { await model.close(); } }
});
