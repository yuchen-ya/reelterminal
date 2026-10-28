import { value } from "./harness/cli-client";
import { expect, test, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import type { WorkbenchItem, WorkbenchHandoff } from "@reelterminal/core/types/workbench";
import { launchApp } from "./harness/launch";
import { connectExternalAgent } from "./harness/cli-client";
import { createImageFixture, createVideoFixture } from "./harness/workbench-fixtures";
import { ARTIFACTS_DIR } from "./harness/paths";
import { evidenceJsonReplacer } from "./harness/evidence";


test("four independent content types complete human review, partial rework, history and reopen", async () => {
  let launched = await launchApp();
  await launched.waitForEndpointFile();
  let agent = await connectExternalAgent(launched.endpointFile);
  try {
    let page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await page.getByTestId("review-new-task").click();
    await page.getByLabel(/Task name|任务名称/).fill("Four-type rework acceptance");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    const context = value(await agent.callCommand<ReviewContext>("review.context"));
    const node = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context.target })).nodes[0];
    const target = { ...context.target, nodeId: node.id };
    let revision = 0;
    const image = crypto.randomUUID(), video = crypto.randomUUID(), text = crypto.randomUUID(), data = crypto.randomUUID();
    const imageResource = crypto.randomUUID(), videoResource = crypto.randomUUID(), column = crypto.randomUUID(), row = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const originalImage = createImageFixture(launched.runDir, "rework-source.png");
    const originalVideo = createVideoFixture(launched.runDir, "rework-source.mp4");
    value(await agent.callCommand("review.ingest", { target, expectedNodeRevision: revision++, requestId: crypto.randomUUID(), batchId, name: "Four real sources",
      files: [{ resourceId: imageResource, sourcePath: originalImage, mime: "image/png" }, { resourceId: videoResource, sourcePath: originalVideo, mime: "video/mp4" }], items: [
        { id: image, title: "Rework image", type: "image", content: { type: "image", mediaId: imageResource, naturalWidth: 1024, naturalHeight: 1024 } },
        { id: video, title: "Rework video", type: "video", content: { type: "video", mediaId: videoResource, durationSec: 2 } },
        { id: text, title: "Rework text", type: "text", content: { type: "text", entryId: crypto.randomUUID(), title: "Text", speakerOrContext: "", text: "Original 👀\n001" } },
        { id: data, title: "Rework data", type: "data", content: { type: "data", datasetId: crypto.randomUUID(), columns: [{ columnId: column, title: "Value" }], rows: [{ rowId: row, cells: { [column]: "001" } }], proposals: [] } },
      ] }));
    const readItem = async (id: string) => value(await agent.callCommand<{ item: WorkbenchItem }>("review.get", { target, itemId: id })).item;
    const select = async (title: string) => page.getByTestId("workbench-tree-panel").getByText(title, { exact: true }).click();
    for (const title of ["Rework image", "Rework video", "Rework text", "Rework data"]) {
      await select(title);
      await page.getByTestId("workbench-bottom-dock").getByRole("button", { name: "返工", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel(/共同修改要求/).fill("请保留已有内容并提交修订结果");
      await dialog.getByRole("button", { name: "确认返工", exact: true }).click();
    }
    await vi.waitFor(async () => expect((await readItem(data)).status).toBe("rework"));
    await page.getByTitle("预览本轮已处理结果，确认后发布给 Agent 读取", { exact: true }).click();
    await page.getByRole("button", { name: /发布交接结果|更新交接结果/ }).click();
    await page.getByText(/等待 Agent 读取/).first().waitFor();
    await page.keyboard.press("Escape");
    const changes = value(await agent.callCommand<{ entries: Array<{ handoffIds?: string[] }> }>("review.changes", { target, afterSequence: 0 }));
    const handoffId = changes.entries.flatMap(entry => entry.handoffIds ?? []).at(-1)!;
    const handoff = value(await agent.callCommand<{ handoff: WorkbenchHandoff }>("review.handoff.get", { target, handoffId })).handoff;
    expect(handoff.items).toHaveLength(4);
    const apply = async (ops: unknown[], files?: unknown[]) => {
      const current = value(await agent.callCommand<{ node: ReviewNode }>("review.get", { target }));
      return agent.callCommand("review.apply", { target, expectedNodeRevision: current.node.revision, requestId: crypto.randomUUID(), ops, ...(files ? { files } : {}) });
    };
    value(await apply([{ op: "workbench.handoff.ack", handoffId }]));
    const beforeText = await readItem(text);
    if (beforeText.content.type !== "text") throw new Error("Expected text");
    value(await apply([{ op: "workbench.rework", handoffId, results: [{ sourceItemId: text, previousVersion: 1, content: { type: "text", entryId: beforeText.content.entryId, title: "Text", speakerOrContext: "", text: "Reworked 👀\n002" } }] }]));
    expect((await readItem(text)).status).toBe("pending");
    expect((await readItem(image)).status).toBe("rework");
    expect(value(await agent.callCommand<{ handoff: WorkbenchHandoff }>("review.handoff.get", { target, handoffId })).handoff.deliveryState).not.toBe("rework_returned");
    const imageOutput = path.join(launched.runDir, "rework-result.png"), videoOutput = path.join(launched.runDir, "rework-result.mp4");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", originalImage, "-vf", "hflip", "-frames:v", "1", "-threads", "1", imageOutput], { windowsHide: true });
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", originalVideo, "-vf", "hflip", "-c:v", "libx264", "-preset", "veryfast", videoOutput], { windowsHide: true });
    const nextImage = crypto.randomUUID(), nextVideo = crypto.randomUUID();
    const beforeData = await readItem(data);
    if (beforeData.content.type !== "data") throw new Error("Expected data");
    value(await apply([{ op: "workbench.rework", handoffId, results: [
      { sourceItemId: image, previousVersion: 1, content: { type: "image", mediaId: nextImage, naturalWidth: 1024, naturalHeight: 1024 } },
      { sourceItemId: video, previousVersion: 1, content: { type: "video", mediaId: nextVideo, durationSec: 2 } },
      { sourceItemId: data, previousVersion: 1, content: { ...beforeData.content, rows: [{ rowId: row, cells: { [column]: "002" } }] } },
    ] }], [{ resourceId: nextImage, sourcePath: imageOutput, mime: "image/png" }, { resourceId: nextVideo, sourcePath: videoOutput, mime: "video/mp4" }]));
    const after = await Promise.all([image, video, text, data].map(readItem));
    expect(after.every(item => item.version === 2 && item.status === "pending" && item.reworkOrigin?.fromHandoffId === handoffId)).toBe(true);
    expect(value(await agent.callCommand<{ handoff: WorkbenchHandoff }>("review.handoff.get", { target, handoffId })).handoff.deliveryState).toBe("rework_returned");
    expect((await apply([{ op: "workbench.rework", handoffId, results: [{ sourceItemId: text, previousVersion: 1, content: { type: "text", entryId: beforeText.content.entryId, title: "Text", speakerOrContext: "", text: "Stale result" } }] }])).error?.code).toBe("CONFLICT");
    await select("Rework text");
    await vi.waitFor(async () => expect(await page.getByTestId("text-body").textContent()).toContain("Reworked 👀"));
    await page.getByTestId("workbench-bottom-dock").getByRole("button", { name: "保留", exact: true }).click();
    await vi.waitFor(async () => expect((await readItem(text)).status).toBe("kept"));
    await vi.waitFor(async () => expect(await page.getByTestId("review-node-editor").locator("[inert]").count()).toBe(0));
    await page.getByTestId("workbench-page").focus();
    await page.keyboard.press("Control+z");
    await vi.waitFor(async () => expect((await readItem(text)).status).toBe("pending"));
    await agent.close();
    launched = await launched.relaunch();
    agent = await connectExternalAgent(launched.endpointFile);
    page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    const reopened = value(await agent.callCommand<ReviewContext>("review.context"));
    const readbacks = [];
    for (const original of after) {
      const item = value(await agent.callCommand<{ item: WorkbenchItem }>("review.get", { target: { ...reopened.target, nodeId: node.id }, itemId: original.id })).item;
      expect(item.content).toEqual(original.content);
      expect(item.status).toBe("pending");
      await select(item.title);
      readbacks.push(item);
    }
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-rework.png") });
    await writeFile(path.join(ARTIFACTS_DIR, "review-rework.json"), JSON.stringify({ target, handoff, readbacks }, evidenceJsonReplacer, 2));
  } finally { await agent.close(); await launched.close(); }
}, 180_000);
