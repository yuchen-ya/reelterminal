import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, value, type ExternalAgent } from "./harness/cli-client";
import { createVideoFixture } from "./harness/workbench-fixtures";
import { ARTIFACTS_DIR } from "./harness/paths";

describe("review issue quick actions and Agent details", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  afterAll(async () => {
    if (launched && !launched.page.isClosed()) {
      await mkdir(ARTIFACTS_DIR, { recursive: true });
      await launched.page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-issue-actions.png"), animations: "disabled" });
    }
    await agent?.close();
    await launched?.close();
  });

  test("has one sidebar opener, shows real guidance, and locates/deletes individual video issues", async () => {
    launched = await launchApp();
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
    const page = launched.page;
    await page.evaluate(() => localStorage.setItem("openreel-locale", "zh-CN"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.getByRole("tab", { name: "审阅工作台", exact: true }).click();
    await page.getByTestId("review-new-task").click();
    await page.getByLabel("任务名称", { exact: true }).fill("问题卡片与审阅说明");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    const sidebarOpener = page.getByRole("button", { name: "展开审阅任务侧栏", exact: true });
    expect(await sidebarOpener.count()).toBe(1);
    await sidebarOpener.click();
    await page.getByTestId("review-access-toggle").click();
    let context: ReviewContext;
    await vi.waitFor(async () => {
      context = value(await agent.callCommand<ReviewContext>("review.context"));
      expect(context.access).toBe("write");
    });
    const { nodes } = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context!.target }));
    const target = { ...context!.target, nodeId: nodes[0].id };
    const resourceId = crypto.randomUUID();
    value(await agent.callCommand("review.ingest", {
      target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), batchId: crypto.randomUUID(), name: "动作连续性检查",
      files: [{ resourceId, mime: "video/mp4", sourcePath: createVideoFixture(launched.runDir) }],
      items: [
        { id: crypto.randomUUID(), type: "video", title: "测试视频", content: { type: "video", mediaId: resourceId },
          agentGuidance: { triageGroup: "need_verdict", branchName: "动作审查", nodeSlotLabel: "测试视频",
            whatToDoNext: "重点检查 0.4 秒和 1.2 秒处的动作衔接。", whatHappened: "当前版本仍有两处接缝需要人工确认。",
            nodButtonLabel: "建议返工", nodDecision: "rework" } },
        { id: crypto.randomUUID(), type: "text", title: "无说明条目", content: { type: "text", entryId: crypto.randomUUID(), title: "无说明条目", speakerOrContext: "", text: "没有附带 Agent 说明。" } },
        { id: crypto.randomUUID(), type: "text", title: "长说明条目", content: { type: "text", entryId: crypto.randomUUID(), title: "长说明条目", speakerOrContext: "", text: "长说明验证" },
          agentGuidance: { triageGroup: "need_verdict", branchName: "审查", nodeSlotLabel: "长说明条目",
            whatToDoNext: Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 项：检查动作衔接与画面连续性。`).join("\n"),
            whatHappened: "需要按各项观察重点确认。", nodButtonLabel: "建议返工", nodDecision: "rework" } },
      ],
    }));
    const tree = page.getByTestId("workbench-tree-panel");
    await tree.getByText("测试视频", { exact: true }).click();
    await page.getByTestId("workbench-agent-details").waitFor();
    await page.getByTitle("查看审阅重点与溯源详情", { exact: true }).click();
    expect(await page.getByTestId("workbench-review-focus").innerText()).toContain("0.4 秒和 1.2 秒");
    expect(await page.getByTestId("workbench-review-conclusion").innerText()).toContain("两处接缝");
    const player = page.locator("[data-workbench-player] video");
    await vi.waitFor(async () => expect(await player.evaluate((video: HTMLVideoElement) => video.readyState >= 2)).toBe(true));
    for (const [index, time] of [0.4, 1.2, 1.6].entries()) {
      const strip = (await page.getByTitle("点击/拖动跳转播放位置").boundingBox())!;
      await page.mouse.click(strip.x + strip.width * time / 2, strip.y + strip.height / 2);
      await vi.waitFor(async () => expect(await player.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(time, 1));
      await page.getByRole("button", { name: /标问题帧 @/ }).click();
      await vi.waitFor(async () => expect(await page.getByTestId("workbench-issue-card").count()).toBe(index + 1));
    }
    await page.getByTitle("展开问题面板", { exact: true }).click();
    const rows = page.getByTestId("workbench-issue-row");
    await page.getByTestId("workbench-batch-select").focus();
    await page.mouse.move(10, 10);
    const locate = rows.nth(1).getByRole("button", { name: "定位问题 #2" });
    await vi.waitFor(async () => expect(await locate.evaluate(button => getComputedStyle(button.parentElement!).opacity)).toBe("0"));
    await rows.nth(1).hover();
    await vi.waitFor(async () => expect(await locate.evaluate(button => getComputedStyle(button.parentElement!).opacity)).toBe("1"));
    await locate.click();
    await vi.waitFor(async () => {
      expect(await player.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(1.2, 1);
      expect(await player.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
    });
    await rows.nth(0).hover();
    await rows.nth(0).getByRole("button", { name: "删除问题 #1" }).click();
    await vi.waitFor(async () => expect(await page.getByTestId("workbench-issue-card").count()).toBe(2));
    const reopenIssues = page.getByTitle("展开问题面板", { exact: true });
    if (await reopenIssues.isVisible()) await reopenIssues.click();
    await vi.waitFor(async () => expect(await rows.count()).toBe(2));
    expect(await page.getByTestId("workbench-issue-card").allTextContents()).toEqual([
      expect.stringContaining("1.200"), expect.stringContaining("1.600"),
    ]);
    await tree.getByText("无说明条目", { exact: true }).click();
    await page.getByTestId("text-body").waitFor();
    await vi.waitFor(async () => expect(await page.getByTestId("workbench-agent-details").count()).toBe(0));
    expect((await page.getByTestId("workbench-bottom-dock").boundingBox())!.height).toBeLessThan(80);
    expect(await page.getByRole("button", { name: /审阅详情|如何审阅/ }).count()).toBe(0);
    expect(await page.getByTestId("review-attach-open").count()).toBe(0);
    await page.getByTestId("review-export-menu-trigger").click();
    expect(await page.getByRole("menuitem", { name: "导出文件", exact: true }).count()).toBe(1);
    expect(await page.getByRole("menuitem", { name: "添加采用版本到项目", exact: true }).count()).toBe(1);
    await page.keyboard.press("Escape");
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-no-details.png"), animations: "disabled" });
    await tree.getByText("长说明条目", { exact: true }).click();
    const details = page.getByTestId("workbench-agent-details");
    await details.waitFor();
    const openDetails = page.getByTitle("查看审阅重点与溯源详情", { exact: true });
    if (await openDetails.isVisible()) await openDetails.click();
    for (const [width, height] of [[1000, 700], [1280, 800], [1600, 1000]]) {
      await page.setViewportSize({ width, height });
      const box = (await details.boundingBox())!;
      expect(box.height).toBeLessThanOrEqual(Math.min(height * 0.28, 240) + 1);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(await details.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await details.evaluate(element => { element.scrollTop = 0; });
      await details.hover();
      await page.mouse.wheel(0, 400);
      await vi.waitFor(async () => expect(await details.evaluate(element => element.scrollTop)).toBeGreaterThan(0));
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, `review-details-${width}.png`), animations: "disabled" });
    }
    await tree.getByText("测试视频", { exact: true }).click();
    await page.getByTitle("展开问题面板", { exact: true }).click();
    await rows.first().waitFor();
    await rows.first().hover();
  }, 90_000);
});
