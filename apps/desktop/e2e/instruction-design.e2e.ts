import { expect, test } from "vitest";
import { launchApp } from "./harness/launch";
import { createProjectViaUI } from "./harness/ui";
import { createEvidence } from "./harness/evidence";

test("Chinese instruction workflow remains usable in a narrow inspector", async () => {
  const launched = await launchApp();
  const page = launched.page;
  const evidence = createEvidence("instruction-design-zh", page);
  const snapshot = async (name: string) => {
    await page.waitForTimeout(250); // inspect settled UI, not entering/exiting animations
    await evidence.screenshot(name);
  };
  try {
    await createProjectViaUI(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("zh-CN");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "看板", exact: true }).click();
    const board = page.getByTestId("collaboration-board");
    const add = board.getByRole("button", { name: "添加指令", exact: true });
    const separator = page.locator('[role="separator"][aria-orientation="vertical"]').last();
    const separatorBox = (await separator.boundingBox())!;
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.mouse.move(separatorBox.x + 2, separatorBox.y + 80);
    await page.mouse.down();
    await page.mouse.move(viewport.width - 300, separatorBox.y + 80, { steps: 8 });
    await page.mouse.up();
    expect(await add.count()).toBe(1);
    expect(await board.getByRole("button", { name: "新建指令" }).count()).toBe(0);
    await snapshot("empty");
    await add.click();
    let picker = page.getByRole("dialog", { name: "添加指令", exact: true });
    await picker.getByRole("button", { name: "可视化沟通", exact: true }).waitFor();
    await snapshot("selector");
    const bounds = (await picker.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    await picker.getByRole("button", { name: "可视化沟通", exact: true }).click();
    const chip = board.getByRole("button", { name: "可视化沟通", exact: true });
    await chip.waitFor();
    await chip.hover();
    await page.getByRole("tooltip").waitFor();
    await snapshot("hover");
    await chip.click();
    const editor = page.getByRole("dialog", { name: "编辑指令", exact: true });
    await editor.getByRole("textbox", { name: "标题", exact: true }).fill("先看视觉样片");
    await snapshot("editor");
    const editBounds = (await editor.boundingBox())!;
    expect(editBounds.x).toBeGreaterThanOrEqual(0);
    expect(editBounds.y + editBounds.height).toBeLessThanOrEqual(viewport.height);
    await editor.getByRole("button", { name: "保存修改" }).click();
    await add.click();
    picker = page.getByRole("dialog", { name: "添加指令", exact: true });
    await picker.getByRole("button", { name: "保留已认可部分", exact: true }).click();
    const second = board.getByRole("button", { name: "保留已认可部分", exact: true });
    await second.click({ button: "right" });
    await snapshot("context-menu");
    await page.getByRole("menuitem", { name: "停用", exact: true }).click();
    for (const title of ["先试一小段", "比较方案"]) {
      await add.click();
      await page.getByRole("dialog", { name: "添加指令", exact: true }).getByRole("button", { name: title, exact: true }).click();
      await board.getByRole("button", { name: title, exact: true }).waitFor();
    }
    const chips = board.locator("[data-instruction-id]");
    const before = await chips.evaluateAll(elements => elements.map(element => ({ id: element.getAttribute("data-instruction-id"), color: (element as HTMLElement).style.borderColor })));
    expect(new Set(before.map(item => item.color)).size).toBe(4);
    const from = (await chips.first().boundingBox())!;
    const to = (await chips.nth(1).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await snapshot("drag-position");
    await page.mouse.up();
    await expect.poll(() => chips.first().getAttribute("data-instruction-id")).toBe(before[1].id);
    const after = await chips.evaluateAll(elements => elements.map(element => ({ id: element.getAttribute("data-instruction-id"), color: (element as HTMLElement).style.borderColor })));
    for (const item of before) expect(after.find(entry => entry.id === item.id)?.color).toBe(item.color);
    await add.focus();
    await page.mouse.move(800, 200);
    await snapshot("chips");
    await add.click();
    await page.getByRole("button", { name: "管理素材库", exact: true }).click();
    await page.getByRole("textbox", { name: /搜索.*名称|搜索.*内容/ }).first().waitFor();
    await snapshot("library");
    evidence.record("selectorBounds", bounds);
    evidence.record("editorBounds", editBounds);
    evidence.flush();
  } catch (error) {
    await snapshot("failure");
    throw error;
  } finally { await launched.close(); }
}, 120_000);
