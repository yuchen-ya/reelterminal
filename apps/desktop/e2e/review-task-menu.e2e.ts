import { openWorkspaceDirectory } from "./harness/workspace-tabs";
import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { ARTIFACTS_DIR } from "./harness/paths";

describe("review task context menu", () => {
  let launched: LaunchedApp;
  afterAll(async () => { await launched?.close(); });

  test("acts on the right-clicked task and confirms permanent deletion", async () => {
    launched = await launchApp();
    const page = launched.page;
    await page.evaluate(() => localStorage.setItem("openreel-locale", "zh-CN"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "审阅工作台", exact: true }).click();
    for (const name of ["待删除任务", "保留任务"]) {
      await openWorkspaceDirectory(page);
      await page.getByTestId("review-new-task").click();
      await page.getByLabel("任务名称", { exact: true }).fill(name);
      await page.getByTestId("review-create-node").click();
      await vi.waitFor(async () => expect(await page.getByTestId("review-node-title").textContent()).toBe(name));
    }
    await openWorkspaceDirectory(page);
    const list = page.getByTestId("review-node-list");
    await list.getByText("待删除任务", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "移到回收站", exact: true }).waitFor();
    expect(await page.getByTestId("review-node-title").textContent()).toBe("保留任务");
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-task-menu.png"), animations: "disabled" });
    await page.getByRole("menuitem", { name: "移到回收站", exact: true }).click();
    const confirmation = page.getByTestId("review-trash-dialog");
    await confirmation.waitFor();
    expect(await page.getByRole("dialog").filter({ has: confirmation }).innerText()).toContain("待删除任务");
    expect(await list.getByText("待删除任务", { exact: true }).count()).toBe(1);
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();
    expect(await list.getByText("待删除任务", { exact: true }).count()).toBe(1);
    // The visible menu button uses the same confirmation as right-click.
    await list.locator("div.group").filter({ hasText: "待删除任务" }).getByTestId("review-node-menu-trigger").click();
    await page.getByRole("menuitem", { name: "移到回收站", exact: true }).click();
    await page.getByTestId("review-trash-submit").click();
    await confirmation.waitFor({ state: "hidden" });
    await vi.waitFor(async () => expect(await list.getByText("待删除任务", { exact: true }).count()).toBe(0));
    expect(await page.getByTestId("review-node-title").textContent()).toBe("保留任务");
    await page.getByRole("button", { name: "打开回收站", exact: true }).click();
    await list.getByText("待删除任务", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "永久删除任务", exact: true }).click();
    await page.getByTestId("review-purge-confirm").waitFor();
    expect(await page.getByTestId("review-purge-dialog").innerText()).toContain("待删除任务");
    expect(await page.getByTestId("review-purge-submit").isEnabled()).toBe(false);
    await page.getByTestId("review-purge-confirm").check();
    await page.getByTestId("review-purge-submit").click();
    await page.getByTestId("review-purge-dialog").waitFor({ state: "hidden" });
    await vi.waitFor(async () => expect(await list.getByText("待删除任务", { exact: true }).count()).toBe(0));
    await page.getByRole("button", { name: "最近", exact: true }).click();
    await list.getByText("保留任务", { exact: true }).waitFor();
  }, 60_000);
});
