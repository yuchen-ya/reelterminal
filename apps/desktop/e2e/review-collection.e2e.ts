import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import type { WorkbenchItem } from "@reelterminal/core/types/workbench";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, value, type ExternalAgent } from "./harness/cli-client";
import { ARTIFACTS_DIR } from "./harness/paths";
import { createImageFixture } from "./harness/workbench-fixtures";

describe("review collection scopes", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  afterAll(async () => {
    if (launched && !launched.page.isClosed()) {
      await mkdir(ARTIFACTS_DIR, { recursive: true });
      await launched.page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-collection.png") });
      await writeFile(path.join(ARTIFACTS_DIR, "review-collection-diagnostic.json"), JSON.stringify({ console: launched.output.rendererConsole,
        alerts: await launched.page.getByRole("alert").allTextContents() }, null, 2));
    }
    await agent?.close(); await launched?.close();
  });

  test("keeps selection, keyboard, parent actions and exports bound to one collection", async () => {
    launched = await launchApp();
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
    const page = launched.page;
    await page.evaluate(() => localStorage.setItem("openreel-locale", "zh-CN"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/ }).click();
    await page.getByTestId("review-new-task").click();
    await page.getByLabel("任务名称").fill("集合交互回归");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    let context: ReviewContext;
    await vi.waitFor(async () => { context = value(await agent.callCommand<ReviewContext>("review.context")); expect(context.access).toBe("write"); });
    const { nodes } = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context!.target }));
    const target = { ...context!.target, nodeId: nodes[0].id };
    const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
    const resources = ids.map(() => crypto.randomUUID());
    value(await agent.callCommand("review.ingest", { target, expectedNodeRevision: 0, requestId: crypto.randomUUID(),
      batchId: crypto.randomUUID(), name: "两个分组",
      files: resources.map((resourceId, index) => ({ resourceId, mime: "image/png", sourcePath: createImageFixture(launched.runDir, `collection-${index}.png`) })),
      items: ids.map((id, index) => ({ id, title: `图片${index + 1}`, type: "image", content: { type: "image", mediaId: resources[index] },
        lineage: { upstreamGroupId: index < 3 ? "group-a" : "group-b", upstreamGroupTitle: index < 3 ? "分组甲" : "分组乙",
          upstreamSourceNode: index < 3 ? "分组甲" : "分组乙", basedOnLabel: "输入", connectorEdgeLabel: "来源", failStreak: 0, steps: [{ version: 1, outcome: "current", edgeLabel: "当前", summary: "待审" }] } })),
    }));
    const tree = page.getByTestId("workbench-tree-panel");
    await tree.getByText("分组甲", { exact: true }).click();
    const board = page.getByTestId("adaptive-board-workspace");
    await vi.waitFor(async () => expect(await board.locator('[data-testid^="board-card-"]').count()).toBe(3));
    await vi.waitFor(async () => expect(await board.locator("img").evaluateAll(images => images.every(element => {
      const image = element as HTMLImageElement;
      const box = image.parentElement!;
      return image.complete && image.naturalWidth > 0 && box.scrollHeight <= box.clientHeight && box.scrollWidth <= box.clientWidth;
    }))).toBe(true));
    await board.getByLabel("图片预览方式").selectOption("pixel");
    await board.getByTestId(`board-card-${ids[0]}`).click();
    await board.getByTestId(`board-card-${ids[1]}`).click({ modifiers: ["Control"] });
    await board.getByTestId(`board-open-item-${ids[0]}`).click();
    await page.getByTestId("image-stage").waitFor();
    await page.getByTitle("返回当前集合 (3)，点击选择，双击放大查看").click();
    expect(await board.getByText("已选 2 项", { exact: true }).isVisible()).toBe(true);
    expect(await board.getByLabel("图片预览方式").inputValue()).toBe("pixel");
    expect(await board.getByTestId(`board-card-${ids[3]}`).count()).toBe(0);
    await board.getByTestId(`board-open-item-${ids[2]}`).click();
    await page.getByTestId("image-stage-pointer-surface").click();
    await page.keyboard.press("ArrowDown");
    expect(await page.locator('[data-testid="image-stage"] img').getAttribute("src")).toBe(`app://reelterminal/review-media/${resources[2]}`);
    await page.getByRole("button", { name: "返回集合：分组甲", exact: true }).click();

    const read = async () => value(await agent.callCommand<{ items: Array<{ id: string; status: string }> }>("review.get", { target }));
    const statuses = async () => { const result = await read(); return ids.map(id => result.items.find(item => item.id === id)!.status); };
    await board.getByTestId(`board-card-${ids[0]}`).click();
    await vi.waitFor(async () => expect(await board.evaluate(element => element.closest("[inert]") === null)).toBe(true));
    await board.getByTestId(`board-card-${ids[0]}`).focus();
    await page.keyboard.press("1");
    await vi.waitFor(async () => expect(await statuses()).toEqual(["kept", "pending", "pending", "pending"]));
    await board.getByTestId("board-keep-all").click();
    await vi.waitFor(async () => expect(await statuses()).toEqual(["kept", "kept", "kept", "pending"]));
    expect(await board.getByTestId("board-keep-all").isDisabled()).toBe(true);
    await board.getByTestId(`board-card-${ids[0]}`).focus();
    await page.keyboard.press("Control+z");
    await vi.waitFor(async () => expect(await statuses()).toEqual(["kept", "pending", "pending", "pending"]));

    await tree.getByText("分组甲", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "批量返工…（3）", exact: true }).click();
    await page.getByRole("textbox", { name: /共同修改要求/ }).fill("统一调整边缘，保留已有圈注");
    await page.getByRole("button", { name: "确认返工", exact: true }).click();
    await vi.waitFor(async () => expect(await statuses()).toEqual(["rework", "rework", "rework", "pending"]));
    for (const id of ids.slice(0, 3)) {
      const detail = value(await agent.callCommand<{ item: WorkbenchItem; feedback: Array<{ text: string }> }>("review.get", { target, itemId: id }));
      expect(detail.feedback.some(entry => entry.text === "统一调整边缘，保留已有圈注")).toBe(true);
    }
    await tree.getByRole("button", { name: "分组甲的操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "将已处理项恢复待审（3）", exact: true }).click();
    await vi.waitFor(async () => expect(await statuses()).toEqual(["pending", "pending", "pending", "pending"]));
    await board.getByTestId(`board-card-${ids[0]}`).focus();
    await page.keyboard.press("Control+z");
    await vi.waitFor(async () => expect(await statuses()).toEqual(["rework", "rework", "rework", "pending"]));

    const groupBounds = await tree.getByText("分组甲", { exact: true }).boundingBox();
    await page.mouse.move(groupBounds!.x + 10, groupBounds!.y + groupBounds!.height / 2);
    await page.mouse.down();
    await page.mouse.move(groupBounds!.x + 90, groupBounds!.y + 45, { steps: 5 });
    await page.mouse.up();
    const dragStatus = page.getByTestId("collection-drag-status");
    await vi.waitFor(async () => expect(await dragStatus.textContent()).toContain("已就绪，可以拖出"));
    expect(await dragStatus.getByRole("button", { name: "拖出文件夹", exact: true }).isVisible()).toBe(true);
    await dragStatus.getByRole("button", { name: "关闭", exact: true }).click();

    await tree.getByRole("button", { name: "分组甲的操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "导出此范围…（3）", exact: true }).click();
    expect(await page.getByTestId("review-export-mode").inputValue()).toBe("current");
    await page.getByTestId("review-export-prepare").click();
    await vi.waitFor(async () => expect(await page.getByTestId("review-export-status").getAttribute("data-state")).toBe("ready"));
    expect(await page.getByTestId("review-export-status").locator("li").count()).toBe(3);
    await page.getByRole("button", { name: "关闭", exact: true }).last().click();
    await tree.getByText("分组乙", { exact: true }).click();
    expect(await board.locator('[data-testid^="board-card-"]').count()).toBe(1);
    expect(await board.getByText("已选 0 项", { exact: true }).isVisible()).toBe(true);
    await board.getByTestId(`board-card-${ids[3]}`).focus();
    await page.keyboard.press("1");
    expect(await statuses()).toEqual(["rework", "rework", "rework", "pending"]);
    await page.keyboard.press("Control+a");
    expect(await board.getByText("已选 1 项", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByTestId("workbench-bottom-dock").getByText("已选 1 项", { exact: true }).isVisible()).toBe(true);
    await page.getByTestId("workbench-bottom-dock").getByRole("button", { name: "保留", exact: true }).click();
    await vi.waitFor(async () => expect(await statuses()).toEqual(["rework", "rework", "rework", "kept"]));
  }, 180_000);
});
