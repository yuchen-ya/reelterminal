import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { ARTIFACTS_DIR } from "./harness/paths";

describe("review tasks, categories and content batches", () => {
  let launched: LaunchedApp;
  afterAll(async () => {
    if (launched && !launched.page.isClosed()) {
      await mkdir(ARTIFACTS_DIR, { recursive: true });
      await launched.page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-navigation.png"), animations: "disabled" });
    }
    await launched?.close();
  });

  test("creates tasks on demand, categorizes them and switches readable batches with mouse and keyboard", async () => {
    launched = await launchApp();
    const page = launched.page;
    await page.evaluate(() => localStorage.setItem("openreel-locale", "zh-CN"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "审阅工作台", exact: true }).click();
    expect(await page.getByLabel("任务名称", { exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "全部任务", exact: true }).count()).toBe(0);
    await page.getByTestId("review-new-task").click();
    await page.getByLabel("任务名称", { exact: true }).fill("取消的任务");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    expect(await page.getByTestId("review-node-list").locator("button").count()).toBe(0);

    for (const name of ["角色动画审阅", "场景审阅"]) {
      await page.getByTestId("review-new-task").click();
      await page.getByLabel("任务名称", { exact: true }).fill(name);
      await page.getByTestId("review-create-node").click();
      await vi.waitFor(async () => expect(await page.getByTestId("review-node-title").textContent()).toBe(name), { timeout: 15_000 });
    }
    await page.getByTestId("review-node-list").getByText("角色动画审阅", { exact: true }).click();
    await page.getByRole("button", { name: "撤销目录操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "管理分类", exact: true }).click();
    await page.getByLabel("新分类名称").fill("角色动画");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("button", { name: "角色动画", exact: true }).waitFor();
    await page.getByRole("button", { name: "完成管理", exact: true }).click();
    await page.getByTestId("review-node-list").getByText("角色动画审阅", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "移到任务分类", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("menuitem", { name: "角色动画", exact: true }).press("Enter");
    await page.getByRole("button", { name: "搜索任务", exact: true }).click();
    await page.getByRole("button", { name: "角色动画", exact: true }).click();
    await vi.waitFor(async () => expect(await page.getByTestId("review-node-list").locator(":scope > div.group").count()).toBe(1));
    expect(await page.getByTestId("review-node-list").innerText()).toContain("角色动画审阅");

    const names = ["运动连续性：接缝证据与修改设计（第一轮完整审阅材料）", "当前监督修订版：运动审查基线（第二轮完整审阅材料）"];
    const bodies = ["第一批的审阅内容", "第二批的审阅内容"];
    for (let index = 0; index < names.length; index++) {
      await page.getByTestId("workbench-new-batch").click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "粘贴文本", exact: true }).click();
      await dialog.getByLabel("批次名称").fill(names[index]);
      await dialog.getByTestId("review-paste-text").fill(bodies[index]);
      await vi.waitFor(async () => expect(await dialog.getByTestId("review-paste-text").inputValue()).toBe(bodies[index]));
      await dialog.getByTestId("review-paste-text").press("Tab");
      await dialog.getByTestId("review-import-submit").click();
      await dialog.waitFor({ state: "hidden" });
      await vi.waitFor(async () => expect(await page.getByTestId("text-body").innerText()).toContain(bodies[index]));
    }
    const expand = page.getByRole("button", { name: "展开审阅任务侧栏", exact: true });
    if (await expand.count()) await expand.first().click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByTestId("workbench-batch-select").click();
    const menu = page.getByTestId("workbench-batch-menu");
    await menu.waitFor();
    const options = menu.getByRole("menuitemradio");
    expect(await options.count()).toBe(2);
    expect(await menu.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe("rgb(255, 255, 255)");
    expect(await options.evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth))).toBe(true);
    await options.filter({ hasText: names[0] }).click();
    await menu.waitFor({ state: "hidden" });
    await vi.waitFor(async () => expect(await page.getByTestId("text-body").innerText()).toContain(bodies[0]));
    expect(await page.getByTestId("workbench-tree-panel").innerText()).toContain("未分组");

    await page.getByTestId("workbench-batch-select").focus();
    await page.keyboard.press("Enter");
    await menu.waitFor();
    await vi.waitFor(async () => expect(await menu.evaluate(element => element.contains(document.activeElement))).toBe(true));
    expect(await options.filter({ hasText: names[0] }).getAttribute("aria-checked")).toBe("true");
    const lastName = (await options.last().innerText()).trim();
    await page.keyboard.press("End");
    await vi.waitFor(async () => expect(await options.last().evaluate(element => element === document.activeElement)).toBe(true));
    await page.keyboard.press("Enter");
    await menu.waitFor({ state: "hidden" });
    await vi.waitFor(async () => expect(await page.getByTestId("text-body").innerText()).toContain(bodies[names.indexOf(lastName)]));
    await page.getByTestId("workbench-batch-select").click();
    await menu.waitFor();
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    expect(await page.getByTestId("workbench-batch-select").evaluate(element => element === document.activeElement)).toBe(true);
    await page.getByTestId("workbench-batch-select").click();
    await menu.waitFor();
  }, 90_000);
});
