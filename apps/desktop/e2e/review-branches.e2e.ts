import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import type { WorkbenchItem } from "@reelterminal/core/types/workbench";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, value, type ExternalAgent } from "./harness/cli-client";
import { ARTIFACTS_DIR } from "./harness/paths";

// Branch creation is retired; historical comparison/adoption remains covered by branch-service.test.ts.
describe("same-task updates, parent ordering and Markdown", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  afterAll(async () => {
    if (launched && !launched.page.isClosed()) {
      await mkdir(ARTIFACTS_DIR, { recursive: true });
      await launched.page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-markdown-task-flow.png") });
      await writeFile(path.join(ARTIFACTS_DIR, "review-markdown-task-flow.json"), JSON.stringify({
        rendererConsole: launched.output.rendererConsole,
        alerts: await launched.page.getByRole("alert").allTextContents(),
      }, null, 2));
    }
    await agent?.close(); await launched?.close();
  });

  test("continues one task, sorts edited parents first and reads/edits real Markdown", async () => {
    launched = await launchApp();
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
    const page = launched.page;
    await page.evaluate(() => localStorage.setItem("openreel-locale", "zh-CN"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/ }).click();
    await page.getByTestId("review-new-task").click();
    await page.getByLabel("任务名称").fill("统一动作工作流");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    let context: ReviewContext;
    await vi.waitFor(async () => {
      context = value(await agent.callCommand<ReviewContext>("review.context"));
      expect(context.access).toBe("write");
    });
    const nodes = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context!.target })).nodes;
    const target = { ...context!.target, nodeId: nodes[0].id };
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const batchId = crypto.randomUUID();
    const document = "# 动作方案\n\n## 工作步骤\n\n1. **检查**原图\n2. 生成对照\n\n| 项目 | 状态 |\n| --- | --- |\n| 原图 | 待审核 |\n\n> 保留来源\n\n\x60\x60\x60json\n{\"ready\": true}\n\x60\x60\x60";
    value(await agent.callCommand("review.ingest", { target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), batchId, name: "第一轮",
      items: ids.map((id, index) => ({ id, title: index ? "工作方案" : "原始说明", type: "text",
        ...(index ? { subtitle: "只调整节奏，不改姿势" } : {}),
        content: { type: "text", entryId: id, title: index ? "工作方案" : "原始说明", speakerOrContext: "", text: index ? "# 初始方案" : "原始说明" },
        lineage: { upstreamGroupId: index ? "plan" : "source", upstreamGroupTitle: index ? "方案组" : "原始批次",
          upstreamSourceNode: "同一个任务", basedOnLabel: "输入", connectorEdgeLabel: "归属", failStreak: 0,
          steps: [{ version: 1, outcome: "current", edgeLabel: "当前", summary: "待审" }] },
      })) }));
    const create = await agent.callCommand("review.branches.create", { target, expectedNodeRevision: 1, expectedWorkspaceRevision: 1,
      requestId: crypto.randomUUID(), taskId: crypto.randomUUID(), name: "不应新建" });
    expect(create.error?.code).toBe("UNSUPPORTED");
    const submit = { target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), results: [{ itemId: ids[1], expectedItemVersion: 1,
      content: { type: "text", entryId: ids[1], title: "工作方案", speakerOrContext: "", text: document } }] };
    value(await agent.callCommand("review.items.submit", submit));
    expect(value(await agent.callCommand<{ replayed: boolean }>("review.items.submit", submit)).replayed).toBe(true);
    expect(value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target })).nodes).toHaveLength(1);
    expect((await agent.callCommand("review.items.submit", { ...submit, requestId: crypto.randomUUID() })).error?.code).toBe("CONFLICT");
    const tree = page.getByTestId("workbench-tree-panel");
    await tree.getByText("工作方案", { exact: true }).click();
    const content = page.getByTestId("workbench-content");
    await content.getByRole("heading", { name: "动作方案", exact: true }).waitFor();
    const headingContrast = await content.getByRole("heading", { name: "动作方案", exact: true }).evaluate(element => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      const luminance = (color: string) => {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const rgb = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      const foreground = luminance(getComputedStyle(element).color);
      const background = luminance(getComputedStyle(element.closest(".wmde-markdown")!).backgroundColor);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
    expect(headingContrast).toBeGreaterThanOrEqual(4.5);
    expect(await content.getByRole("table").innerText()).toContain("待审核");
    expect(await content.locator("pre code:visible").innerText()).toContain('"ready": true');
    expect(await tree.getByText("只调整节奏，不改姿势", { exact: true }).isVisible()).toBe(true);
    expect(await tree.getByText("无备注", { exact: true }).count()).toBe(0);
    const planBox = await tree.getByText("方案组", { exact: true }).boundingBox();
    const originalBox = await tree.getByText("原始批次", { exact: true }).boundingBox();
    expect(planBox!.y).toBeLessThan(originalBox!.y);
    expect(await page.getByRole("button", { name: "任务分支", exact: true }).count()).toBe(0);

    await page.getByRole("button", { name: "原文与批注", exact: true }).click();
    expect(await content.getByTestId("text-body").textContent()).toBe(document);
    await page.getByRole("button", { name: "直接改文", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Markdown 原文" });
    await editor.fill(document + "\n\n## 人工补充\n\n- 保留现有素材");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const read = async () => value(await agent.callCommand<{ item: WorkbenchItem; node: ReviewNode }>("review.get", { target, itemId: ids[1] }));
    await vi.waitFor(async () => expect((await read()).item.version).toBe(3));
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await content.getByRole("heading", { name: "人工补充", exact: true }).waitFor();
    await page.getByTestId("workbench-page").focus();
    await page.keyboard.press("Control+z");
    await vi.waitFor(async () => expect((await read()).item.version).toBe(2));
    expect(await content.getByRole("heading", { name: "人工补充", exact: true }).count()).toBe(0);
    expect((await read()).node.id).toBe(target.nodeId);
    await page.getByRole("button", { name: "直接改文", exact: true }).click();
    await editor.waitFor();
  }, 120_000);
});
