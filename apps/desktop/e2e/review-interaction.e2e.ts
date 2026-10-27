import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, value, type ExternalAgent } from "./harness/cli-client";
import { ARTIFACTS_DIR } from "./harness/paths";

describe("review navigation and decision loop", () => {
  let app: LaunchedApp;
  let agent: ExternalAgent;
  afterAll(async () => { await agent?.close(); await app?.close(); });
  test("reveals the opened item, cancels rework safely, submits a reason and finishes the batch", async () => {
    app = await launchApp(); await app.waitForEndpointFile();
    agent = await connectExternalAgent(app.endpointFile);
    const page = app.page;
    await page.evaluate(() => localStorage.setItem("openreel-locale", "zh-CN"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "审阅工作台", exact: true }).click();
    await page.getByTestId("review-empty-create").click();
    await page.getByLabel("任务名称").fill("交互回归");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    expect(await page.getByTestId("review-access-status").textContent()).toContain("只读");
    await page.getByTestId("review-access-toggle").click();
    let context: ReviewContext;
    await vi.waitFor(async () => { context = value(await agent.callCommand<ReviewContext>("review.context")); expect(context.access).toBe("write"); });
    const node = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context!.target })).nodes[0];
    const target = { ...context!.target, nodeId: node.id };
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    value(await agent.callCommand("review.ingest", { target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), batchId: crypto.randomUUID(), name: "实验批次",
      items: ids.map((id, i) => ({ id, title: `文档${i + 1}`, type: "text", content: { type: "text", entryId: id, title: `文档${i + 1}`, speakerOrContext: "", text: `# 正文${i + 1}\n\n**内容**与说明` },
        lineage: { upstreamGroupId: "reports", upstreamGroupTitle: "实验报告", upstreamSourceNode: "实验报告", basedOnLabel: "输入", connectorEdgeLabel: "来源", failStreak: 0, steps: [{ version: 1, outcome: "current", edgeLabel: "当前", summary: "待审" }] } })) }));
    const tree = page.getByTestId("workbench-tree-panel");
    await tree.getByText("实验报告", { exact: true }).click();
    await tree.getByTitle("收拢分类子项").click();
    const board = page.getByTestId("adaptive-board-workspace");
    await board.getByRole("heading", { name: "正文2", exact: true }).waitFor();
    const first = board.getByTestId(`board-card-${ids[0]}`);
    await first.click();
    await board.getByTestId(`board-card-${ids[1]}`).click({ modifiers: ["Control"] });
    await first.focus(); await page.keyboard.press("ArrowRight");
    expect(await board.getByTestId(`board-card-${ids[1]}`).evaluate(element => element === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    const body = page.getByTestId("text-body");
    await body.getByRole("heading", { name: "正文2", exact: true }).waitFor();
    expect(await body.count()).toBe(1);
    const row = tree.locator(`[data-tree-item-id="${ids[1]}"]`);
    expect(await row.getAttribute("aria-current")).toBe("true");
    expect(await row.isVisible()).toBe(true);
    await page.getByRole("button", { name: "上一项", exact: true }).click();
    await body.getByRole("heading", { name: "正文1", exact: true }).waitFor();
    const dock = page.getByTestId("workbench-bottom-dock");
    const statuses = async () => value(await agent.callCommand<{ items: Array<{ id: string; status: string }> }>("review.get", { target })).items;
    await dock.getByRole("button", { name: "返工", exact: true }).click();
    const reason = page.getByRole("textbox", { name: /共同修改要求/ });
    await reason.waitFor(); await page.keyboard.press("Escape");
    expect((await statuses()).every(item => item.status === "pending")).toBe(true);
    await dock.getByRole("button", { name: "返工", exact: true }).click();
    await reason.fill("补充实验结论"); await reason.press("Enter");
    await vi.waitFor(async () => expect((await statuses()).find(item => item.id === ids[0])?.status).toBe("rework"));
    const detail = value(await agent.callCommand<{ feedback: Array<{ text: string }> }>("review.get", { target, itemId: ids[0] }));
    expect(detail.feedback.some(entry => entry.text === "补充实验结论")).toBe(true);
    await body.getByRole("heading", { name: "正文2", exact: true }).waitFor();
    await dock.getByRole("button", { name: "保留", exact: true }).click();
    await page.getByTestId("review-complete").waitFor();
    expect(await tree.locator(`[data-tree-item-id="${ids[0]}"]`).textContent()).toContain("↺ 返工");
    expect(await tree.locator(`[data-tree-item-id="${ids[1]}"]`).textContent()).toContain("✓ 保留");
    await page.getByRole("button", { name: "发布本批结果", exact: true }).click();
    const dialog = page.getByTestId("workbench-handoff-dialog"); await dialog.waitFor();
    expect(await dialog.textContent()).not.toContain("互斥计数守恒");
    expect(await dialog.textContent()).not.toContain(ids[0]);
    await page.getByRole("button", { name: /发布交接结果 \(2 项\)/ }).click();
    await dialog.getByText(/发布时间/).waitFor();
    await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
    const revision = value(await agent.callCommand<{ node: ReviewNode }>("review.get", { target, itemId: ids[1] })).node.revision;
    const stepId = crypto.randomUUID();
    value(await agent.callCommand("review.steps.start", { target, expectedNodeRevision: revision, requestId: crypto.randomUUID(), stepId, runId: crypto.randomUUID(), label: "文本对照",
      inputs: [{ nodeId: node.id, itemId: ids[0], version: 1, role: "source" }], method: { kind: "algorithm", name: "Fixture" }, parameters: {} }));
    value(await agent.callCommand("review.steps.complete", { target, expectedNodeRevision: revision + 1, requestId: crypto.randomUUID(), stepId,
      ops: [{ op: "workbench.content.update", itemId: ids[1], expectedItemVersion: 1, kind: "text", text: "# 正文2\n\n对照修订" }],
      outputs: [{ nodeId: node.id, itemId: ids[1], version: 2, role: "result" }] }));
    await page.getByRole("button", { name: /处理记录/ }).click();
    await vi.waitFor(async () => {
      expect(await page.getByTestId("review-comparison-left").textContent()).toContain("正文1");
      expect(await page.getByTestId("review-comparison-right").textContent()).toContain("正文2");
    });
    await page.getByRole("button", { name: "内容审阅", exact: true }).click();
    await page.getByTestId("workbench-new-batch").click();
    await page.getByRole("button", { name: "粘贴文本", exact: true }).click();
    expect(await page.getByRole("textbox", { name: "批次名称", exact: true }).inputValue()).toBe("文本批次");
    await page.getByTestId("review-paste-text").fill("# 补充说明");
    expect(await page.getByTestId("review-import-submit").isEnabled()).toBe(true);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-interaction-complete.png") });
  }, 180_000);
});
