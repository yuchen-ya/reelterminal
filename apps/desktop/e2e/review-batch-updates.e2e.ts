import { openWorkspaceDirectory } from "./harness/workspace-tabs";
import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, value, type ExternalAgent } from "./harness/cli-client";
import { ARTIFACTS_DIR } from "./harness/paths";

describe("compact batch picker updates", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  afterAll(async () => { await agent?.close(); await launched?.close(); });
  test("keeps the active batch, persists read state and distinguishes new versions from decisions", async () => {
    launched = await launchApp();
    const page = launched.page;
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
    await page.evaluate(() => localStorage.setItem("openreel-locale", "zh-CN"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "审阅工作台", exact: true }).click();
    await openWorkspaceDirectory(page);
    await page.getByTestId("review-new-task").click();
    await page.getByLabel("任务名称").fill("模式识别1");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    let context: ReviewContext;
    await vi.waitFor(async () => { context = value(await agent.callCommand<ReviewContext>("review.context")); expect(context.access).toBe("write"); });
    const node = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context!.target })).nodes[0];
    let target = { ...context!.target, nodeId: node.id };
    const batches = [crypto.randomUUID(), crypto.randomUUID()];
    const items = [crypto.randomUUID(), crypto.randomUUID()];
    const names = ["实验与汇报成果", "补充验证与修订"];
    for (let i = 0; i < 2; i++) {
      value(await agent.callCommand("review.ingest", { target, expectedNodeRevision: i, requestId: crypto.randomUUID(), batchId: batches[i], name: names[i],
        items: [{ id: items[i], title: i ? "修订方案" : "实验报告与讲稿", type: "text", content: { type: "text", entryId: items[i], title: names[i], speakerOrContext: "", text: "# " + names[i] } }] }));
      if (i === 0) await vi.waitFor(async () => expect(await page.getByTestId("workbench-batch-select").getAttribute("data-batch-id")).toBe(batches[0]));
    }
    const picker = page.getByTestId("workbench-batch-select");
    await page.getByTestId("workbench-batch-new").waitFor();
    expect(await picker.getAttribute("data-batch-id")).toBe(batches[0]);
    const badge = await page.getByTestId("workbench-batch-new").boundingBox();
    const button = await picker.boundingBox();
    expect(badge!.x).toBeGreaterThan(button!.x);
    expect(badge!.x + badge!.width).toBeLessThan(button!.x + button!.width);
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-batch-picker.png"), animations: "disabled" });
    await picker.click();
    const menu = page.getByTestId("workbench-batch-menu");
    expect(await menu.getByRole("menuitemradio").first().innerText()).toContain(names[1]);
    expect(await menu.getByRole("menuitemradio").first().innerText()).toContain("NEW");
    await menu.getByRole("menuitemradio").filter({ hasText: names[1] }).click();
    await vi.waitFor(async () => expect(await page.getByTestId("workbench-batch-new").count()).toBe(0));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("workbench-batch-select").waitFor();
    expect(await page.getByTestId("workbench-batch-new").count()).toBe(0);
    // Reading a background-arriving version requires explicit navigation.
    const access = page.getByTestId("review-access-toggle");
    if (await access.isChecked()) await access.click();
    await access.click();
    context = value(await agent.callCommand<ReviewContext>("review.context"));
    target = { ...context.target, nodeId: node.id };
    value(await agent.callCommand("review.items.submit", { target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), results: [{ itemId: items[1], expectedItemVersion: 1,
      content: { type: "text", entryId: items[1], title: names[1], speakerOrContext: "", text: "# 修订版" } }] }));
    await page.getByTestId("workbench-batch-new").waitFor();
    await picker.click();
    await menu.getByRole("menuitemradio").filter({ hasText: names[1] }).click();
    await vi.waitFor(async () => expect(await page.getByTestId("workbench-batch-new").count()).toBe(0));
    value(await agent.callCommand("review.apply", { target, expectedNodeRevision: 3, requestId: crypto.randomUUID(), ops: [{ op: "workbench.decide", batchId: batches[1], decisions: [{ itemId: items[1], decision: "kept", expectedItemVersion: 2 }] }] }));
    await vi.waitFor(async () => expect(value(await agent.callCommand<{ node: ReviewNode }>("review.get", { target, itemId: items[1] })).node.revision).toBe(4));
    expect(await page.getByTestId("workbench-batch-new").count()).toBe(0);
  }, 90_000);
});
