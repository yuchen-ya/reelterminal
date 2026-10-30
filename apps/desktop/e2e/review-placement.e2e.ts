import { expect, test, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import type { WorkbenchItem } from "@reelterminal/core/types/workbench";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, value } from "./harness/cli-client";
import { createEvidence } from "./harness/evidence";

test("review row drag moves a complete subtree, keeps original content, undoes once and appends external files to the chosen group", async () => {
  const launched = await launchApp(); await launched.waitForEndpointFile();
  const agent = await connectExternalAgent(launched.endpointFile);
  const page = launched.page, evidence = createEvidence("review-placement", page);
  try {
    await page.evaluate(() => localStorage.setItem("openreel-locale", "zh-CN")); await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/ }).click();
    await page.getByTestId("review-new-task").click(); await page.getByLabel("任务名称", { exact: true }).fill("拖放归类验收");
    await page.getByTestId("review-create-node").click(); await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    let context: ReviewContext;
    await vi.waitFor(async () => { context = value(await agent.callCommand<ReviewContext>("review.context")); expect(context.access).toBe("write"); });
    const { nodes } = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context!.target }));
    const target = { ...context!.target, nodeId: nodes[0].id }, batchId = crypto.randomUUID();
    const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
    value(await agent.callCommand("review.ingest", { target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), batchId, name: "Full source tree",
      items: ids.map((id, index) => ({ id, title: ["父节点", "子节点", "孙节点", "目标节点"][index], type: "text",
        content: { type: "text", entryId: crypto.randomUUID(), title: id, speakerOrContext: "", text: `Original body ${index}` },
        groupMode: index === 0 ? "category" : undefined,
        lineage: { upstreamGroupId: index < 3 ? "source-a" : "source-b", upstreamGroupTitle: index < 3 ? "来源甲" : "来源乙", upstreamSourceNode: id,
          ...(index === 1 ? { parentNodeId: ids[0] } : index === 2 ? { parentNodeId: ids[1] } : {}),
          basedOnLabel: "原始来源", connectorEdgeLabel: "派生", failStreak: 0, steps: [{ version: 1, outcome: "current", edgeLabel: "当前", summary: "待审" }] } })),
    }));
    const read = async () => value(await agent.callCommand<{ node: ReviewNode; items: Array<{ id: string; batchId: string; placement?: { groupId: string | null } }> }>("review.get", { target }));
    const details = async () => Promise.all(ids.map(async itemId => value(await agent.callCommand<{ item: WorkbenchItem }>("review.get", { target, itemId })).item));
    const before = await details();
    const tree = page.getByTestId("workbench-tree-panel");
    const parent = tree.getByText("父节点", { exact: true }).locator('xpath=ancestor::*[@draggable="true"][1]');
    await parent.waitFor();
    const destination = tree.locator('[data-review-drop-group="source-b"]').first(); await destination.waitFor();
    await parent.dragTo(destination);
    await vi.waitFor(async () => expect((await details()).slice(0, 3).map(item => item.placement?.groupId)).toEqual(["source-b", "source-b", "source-b"]), { timeout: 20_000 });
    const moved = await details();
    for (let index = 0; index < ids.length; index++) {
      expect(moved[index]).toMatchObject({ id: before[index].id, batchId: before[index].batchId, version: before[index].version,
        lineage: before[index].lineage, content: before[index].content, status: before[index].status,
        revisions: before[index].revisions, decisionLog: before[index].decisionLog });
    }
    expect(await page.getByTestId("collection-drag-status").count()).toBe(0);
    await evidence.screenshot("subtree-reclassified");
    const movedRevision = (await read()).node.revision;
    await parent.dragTo(destination);
    expect((await read()).node.revision).toBe(movedRevision);
    await launched.app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu()!.items.flatMap(menu => menu.submenu?.items ?? []).find(item => item.label === "Undo");
      if (!item) throw new Error("Undo menu missing"); item.click(item, BrowserWindow.getAllWindows()[0], { triggeredByAccelerator: false });
    });
    await vi.waitFor(async () => expect((await details()).map(item => item.placement)).toEqual(before.map(item => item.placement)), { timeout: 20_000 });
    expect((await details()).map(item => item.lineage)).toEqual(before.map(item => item.lineage));
    const file = path.join(launched.runDir, "dropped-notes.txt"); await writeFile(file, "Append into the existing target group");
    await page.evaluate(() => { const input = document.createElement("input"); input.type = "file"; input.dataset.testid = "placement-file-input"; input.hidden = true; document.body.append(input); });
    await page.getByTestId("placement-file-input").setInputFiles(file);
    // Path-backed external-file event exercises the GUI drop contract; OS receipt is a separate manual native-drag test.
    await destination.evaluate(element => {
      const input = document.querySelector('[data-testid="placement-file-input"]') as HTMLInputElement;
      const data = new DataTransfer(); data.items.add(input.files![0]);
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data })); input.remove();
    });
    await vi.waitFor(async () => expect((await read()).items).toHaveLength(5), { timeout: 20_000 });
    const imported = (await read()).items.find(item => !ids.includes(item.id))!;
    const importedItem = value(await agent.callCommand<{ item: WorkbenchItem }>("review.get", { target, itemId: imported.id })).item;
    expect(importedItem.batchId).toBe(batchId); expect(importedItem.placement).toEqual({ groupId: "source-b" });
    expect(importedItem.content).toMatchObject({ type: "text", versions: [{ text: "Append into the existing target group" }] });
    evidence.record("placement", { ids, moved: moved.map(item => ({ id: item.id, placement: item.placement, lineage: item.lineage })), imported: { id: imported.id, batchId: importedItem.batchId, placement: importedItem.placement }, undoRestoredCompleteSubtree: true });
    await evidence.screenshot("external-file-appended");
    const beforeCategory = await details();
    await page.getByRole("button", { name: "撤销目录操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "管理分类", exact: true }).click();
    await page.getByLabel("新分类名称").fill("目录拖放目标"); await page.getByRole("button", { name: "创建", exact: true }).click();
    const category = page.locator("[data-review-node-drop-group]").filter({ hasText: "目录拖放目标" });
    await category.waitFor(); const groupId = await category.getAttribute("data-review-node-drop-group");
    await page.getByRole("button", { name: "完成管理", exact: true }).click();
    await page.getByRole("button", { name: "搜索任务", exact: true }).click();
    await category.getByRole("button", { name: "目录拖放目标", exact: true }).waitFor({ state: "visible" });
    await page.locator(`[data-review-node-drop="${target.nodeId}"]`).first().dragTo(category);
    const nodeGroup = async () => value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context!.target })).nodes.find(node => node.id === target.nodeId)?.groupId;
    await vi.waitFor(async () => expect(await nodeGroup()).toBe(groupId), { timeout: 15_000 });
    expect(await details()).toEqual(beforeCategory);
    await evidence.screenshot("node-category-dropped");
    await page.getByRole("button", { name: "撤销目录操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "撤销目录操作", exact: true }).click();
    await vi.waitFor(async () => expect(await nodeGroup()).toBeUndefined());
    evidence.record("directoryDrag", { groupId, undoRestoredOriginalCategory: true });
  } finally {
    evidence.record("rendererConsole", launched.output.rendererConsole); evidence.record("alerts", await page.getByRole("alert").allTextContents());
    if (!page.isClosed()) await evidence.screenshot("terminal"); evidence.flush(); await agent.close(); await launched.close();
  }
});
