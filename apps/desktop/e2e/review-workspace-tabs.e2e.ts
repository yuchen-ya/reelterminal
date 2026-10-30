import { expect, test, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import { LEGACY_IDB_MATERIAL_LIBRARY } from "@reelterminal/core/legacy/physical-identifiers";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, value } from "./harness/cli-client";
import { createEvidence } from "./harness/evidence";
import { openOrCreateBoard, openWorkspaceDirectory } from "./harness/workspace-tabs";

async function createTask(page: Page, name: string) {
  await openWorkspaceDirectory(page);
  await page.getByTestId("review-new-task").click();
  await page.getByLabel(/Task name|任务名称/).fill(name);
  await page.getByTestId("review-create-node").click();
  await vi.waitFor(async () => expect(await page.getByTestId("review-node-title").textContent()).toBe(name), { timeout: 20_000 });
  return (await page.getByTestId("review-node-title").getAttribute("data-node-id"))!;
}

async function importTexts(page: Page, runDir: string, prefix: string) {
  const files = [path.join(runDir, `${prefix}-one.txt`), path.join(runDir, `${prefix}-two.txt`)];
  await Promise.all(files.map((file, index) => writeFile(file, `${prefix} original body ${index + 1}`)));
  await page.getByTestId("workbench-new-batch").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("review-files-input").setInputFiles(files);
  await dialog.getByTestId("review-import-preview").waitFor();
  await dialog.getByTestId("review-import-submit").click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByTestId("text-body").waitFor({ timeout: 20_000 });
}

async function savedBoards(page: Page) {
  return page.evaluate(async databaseName => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<Array<{ id: string; name: string }>>((resolve, reject) => {
        const transaction = db.transaction("humanBoards", "readonly");
        const request = transaction.objectStore("humanBoards").getAll();
        transaction.oncomplete = () => resolve(request.result); transaction.onabort = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }, LEGACY_IDB_MATERIAL_LIBRARY);
}

test("mixed workspace tabs isolate review state, flush closing boards, reopen and restore order", async () => {
  let launched = await launchApp();
  await launched.waitForEndpointFile();
  let agent = await connectExternalAgent(launched.endpointFile);
  const evidence = createEvidence("review-workspace-tabs", launched.page);
  try {
    let page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    expect(await page.getByTestId("review-surface-tab").count()).toBe(0);
    expect(await page.getByTestId("human-board-tab").count()).toBe(0);
    expect(await page.getByTestId("review-node-list").count()).toBe(0);

    const alpha = await createTask(page, "Alpha review");
    await importTexts(page, launched.runDir, "alpha");
    await page.getByTestId("workbench-tree-panel").getByText("alpha-two.txt", { exact: true }).click();
    await vi.waitFor(async () => expect(await page.getByTestId("text-body").innerText()).toContain("alpha original body 2"));
    await page.getByTitle("筛选与检索条目", { exact: true }).click();
    await page.getByPlaceholder("筛选条目...").fill("alpha-two");

    const beta = await createTask(page, "Beta review");
    await importTexts(page, launched.runDir, "beta");
    expect(await page.getByPlaceholder("筛选条目...").inputValue()).toBe("");
    await page.getByTestId("workbench-tree-panel").getByText("beta-one.txt", { exact: true }).click();
    await page.getByTestId(`review-tab-${alpha}`).click();
    await vi.waitFor(async () => expect(await page.getByPlaceholder("筛选条目...").inputValue()).toBe("alpha-two"));
    await vi.waitFor(async () => expect(await page.getByTestId("text-body").innerText()).toContain("alpha original body 2"));
    await page.getByTestId(`review-tab-${beta}`).click();
    await vi.waitFor(async () => expect(await page.getByPlaceholder("筛选条目...").inputValue()).toBe(""));
    await vi.waitFor(async () => expect(await page.getByTestId("text-body").innerText()).toContain("beta original body 1"));
    const reviewContext = value(await agent.callCommand<ReviewContext>("review.context"));
    const expectedCommands = await page.evaluate(async ({ target, ids }) => Promise.all(ids.map(async nodeId => {
      const info = await window.reelterminal!.collabControl!.getStartupInfo({ ...target, nodeId });
      return info.startCommand;
    })), { target: reviewContext.target, ids: [alpha, beta] });
    for (const [index, id] of [alpha, beta, alpha, beta].entries()) {
      await page.getByTestId(`review-tab-${id}`).click();
      const command = expectedCommands[index % 2];
      await vi.waitFor(async () => expect(await page.getByTestId("review-start-command").textContent()).toBe(command));
      expect(command).toContain("start --target");
      await page.getByTestId("review-start-command").click();
      await vi.waitFor(async () => expect(await launched.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(command));
    }
    expect(expectedCommands[0]).not.toBe(expectedCommands[1]);
    await evidence.screenshot("review-address-command");
    await page.getByTestId(`close-tab-review-${alpha}`).click();
    await openWorkspaceDirectory(page);
    await page.getByTestId("review-node-list").getByText("Alpha review", { exact: true }).click();
    await vi.waitFor(async () => expect(await page.getByPlaceholder("筛选条目...").inputValue()).toBe("alpha-two"));
    await vi.waitFor(async () => expect(await page.getByTestId("text-body").innerText()).toContain("alpha original body 2"));

    await openOrCreateBoard(page);
    const boardId = (await page.getByTestId("human-board-canvas").getAttribute("data-board-id"))!;
    const boardTab = page.getByTestId(`board-tab-${boardId}`);
    expect(await page.getByTestId("review-start-command").count()).toBe(0);
    expect(await page.getByTestId("workbench-private-board").innerText()).toContain("没有 Agent target");
    expect(await page.getByTestId("human-board-list").count()).toBe(0);
    await page.getByTestId("human-board-name").fill("Private unsaved board");
    // Close immediately while the 500ms autosave is still pending.
    await page.getByTestId(`close-tab-board-${boardId}`).click();
    await boardTab.waitFor({ state: "hidden" });
    expect((await savedBoards(page)).find(board => board.id === boardId)?.name).toBe("Private unsaved board");
    await openWorkspaceDirectory(page);
    await page.getByTestId(`human-board-open-${boardId}`).click();
    await page.getByTestId("human-board-canvas").waitFor();
    expect(await page.getByTestId("human-board-name").inputValue()).toBe("Private unsaved board");

    // Opening an existing task focuses its tab without creating a duplicate.
    await openWorkspaceDirectory(page);
    await page.getByTestId("review-node-list").getByText("Alpha review", { exact: true }).click();
    expect(await page.getByTestId(`review-tab-${alpha}`).count()).toBe(1);
    await boardTab.dragTo(page.getByTestId(`review-tab-${beta}`));
    const tabs = page.locator('[data-testid^="review-tab-"], [data-testid^="board-tab-"]');
    const order = await tabs.evaluateAll(elements => elements.map(element => element.getAttribute("data-testid")));
    expect(order.indexOf(`board-tab-${boardId}`)).toBeLessThan(order.indexOf(`review-tab-${alpha}`));
    await boardTab.click();
    const context = value(await agent.callCommand<ReviewContext>("review.context"));
    expect(JSON.stringify(context)).not.toContain("Private unsaved board");
    expect(value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context.target })).nodes).toHaveLength(2);
    await evidence.screenshot("mixed-tabs-private-board");

    await agent.close();
    launched = await launched.relaunch(); page = launched.page; evidence.bindPage(page);
    agent = await connectExternalAgent(launched.endpointFile);
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await page.getByTestId("human-board-canvas").waitFor({ timeout: 30_000 });
    expect(await page.getByTestId("human-board-name").inputValue()).toBe("Private unsaved board");
    expect(await page.locator('[data-testid^="review-tab-"], [data-testid^="board-tab-"]').evaluateAll(elements => elements.map(element => element.getAttribute("data-testid")))).toEqual(order);
    for (const [kind, id] of [["review", alpha], ["review", beta], ["board", boardId]]) {
      await page.getByTestId(`close-tab-${kind}-${id}`).click();
    }
    expect(await page.locator('[data-testid^="review-tab-"], [data-testid^="board-tab-"]').count()).toBe(0);
    expect(await page.getByTestId("human-board-canvas").count()).toBe(0);
    await page.getByTestId("workbench-empty").waitFor();
    await evidence.screenshot("last-tab-empty");
    await openWorkspaceDirectory(page);
    expect(await page.getByTestId("review-node-list").innerText()).toContain("Alpha review");
    expect(await page.getByTestId(`human-board-open-${boardId}`).count()).toBe(1);
    evidence.record("verified", { alpha, beta, boardId, order, closePreservesEntities: true, pendingSaveFlushed: true, taskStateIsolated: true, restartRestoresMixedTabs: true, taskStartupClipboardMatchesTarget: true });
  } finally {
    evidence.record("rendererConsole", launched.output.rendererConsole);
    if (!launched.page.isClosed()) await evidence.screenshot("terminal");
    evidence.flush(); await agent.close(); await launched.close();
  }
});
