import { expect, test, vi } from "vitest";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import type { WorkbenchItem } from "@reelterminal/core/types/workbench";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, value } from "./harness/cli-client";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createImageFixture, createVideoFixture } from "./harness/workbench-fixtures";

test("task branches isolate source review and adopt through reversible human history", async () => {
  const launched = await launchApp();
  await launched.waitForEndpointFile();
  const agent = await connectExternalAgent(launched.endpointFile);
  try {
    const page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await page.getByTestId("review-new-task").click();
    await page.getByLabel(/Task name|任务名称/).fill("Branch source");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    const context = value(await agent.callCommand<ReviewContext>("review.context"));
    const source = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context.target })).nodes[0];
    const target = { ...context.target, nodeId: source.id };
    const itemId = crypto.randomUUID(), otherId = crypto.randomUUID();
    value(await agent.callCommand("review.ingest", { target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), batchId: crypto.randomUUID(), name: "Source inputs",
      items: [itemId, otherId].map((id, index) => ({ id, title: index ? "Other review" : "Edit target", type: "text",
        content: { type: "text", entryId: crypto.randomUUID(), title: "Text", speakerOrContext: "", text: "original" } })) }));
    const create = { target, expectedNodeRevision: 1, expectedWorkspaceRevision: 1, taskId: crypto.randomUUID(), requestId: crypto.randomUUID(), name: "Agent edit" };
    const branch = value(await agent.callCommand<{ node: ReviewNode; target: ReviewContext["target"] }>("review.branches.create", create));
    expect(value(await agent.callCommand<typeof branch>("review.branches.create", create)).node.id).toBe(branch.node.id);
    expect(await page.getByTestId("review-node-title").getAttribute("data-node-id")).toBe(source.id);
    const branchItems = value(await agent.callCommand<{ node: ReviewNode; items: Array<{ id: string; title: string }> }>("review.get", { target: branch.target }));
    const resultId = branchItems.items.find(item => item.title === "Edit target")!.id;
    await page.getByTestId("workbench-tree-panel").getByText("Other review", { exact: true }).click();
    await page.getByTestId("workbench-bottom-dock").getByRole("button", { name: /^(保留|Keep)$/ }).click();
    const readSource = async (id: string) => value(await agent.callCommand<{ item: WorkbenchItem }>("review.get", { target, itemId: id })).item;
    await vi.waitFor(async () => expect((await readSource(otherId)).status).toBe("kept"));
    value(await agent.callCommand("review.apply", { target: branch.target, expectedNodeRevision: branchItems.node.revision, requestId: crypto.randomUUID(),
      ops: [{ op: "workbench.content.update", itemId: resultId, expectedItemVersion: 1, kind: "text", text: "branch result" }] }));
    expect((await readSource(itemId)).version).toBe(1);
    await page.getByTestId("workbench-page").focus();
    await page.keyboard.press("Control+z");
    await vi.waitFor(async () => expect((await readSource(otherId)).status).toBe("pending"));
    // Decisions advance the cursor; undo restores data, not the UI selection.
    await page.getByTestId("workbench-tree-panel").getByText("Other review", { exact: true }).click();
    await page.getByTestId("workbench-bottom-dock").getByRole("button", { name: /^(保留|Keep)$/ }).click();
    await vi.waitFor(async () => expect((await readSource(otherId)).status).toBe("kept"));
    await page.getByTestId("review-branches-open").click();
    await page.getByTestId(`review-branch-compare-${branch.node.id}`).click();
    await page.getByTestId("review-text-diff").waitFor();
    expect(await page.getByTestId("review-text-diff").textContent()).toContain("branch result");
    await page.getByRole("checkbox", { name: /^(选择|Select) Edit target$/ }).check();
    const adoptionId = crypto.randomUUID();
    const pinRequestId = async () => page.evaluate(id => {
      Object.defineProperty(globalThis, "__branchOriginalUUID", { value: crypto.randomUUID, configurable: true });
      Object.defineProperty(crypto, "randomUUID", { value: () => id, configurable: true });
    }, adoptionId);
    const restoreRequestId = async () => page.evaluate(() => {
      const scope = globalThis as typeof globalThis & { __branchOriginalUUID: typeof crypto.randomUUID };
      Object.defineProperty(crypto, "randomUUID", { value: scope.__branchOriginalUUID, configurable: true });
      Reflect.deleteProperty(globalThis, "__branchOriginalUUID");
    });
    await pinRequestId();
    await page.getByTestId("review-branch-adopt").click();
    await vi.waitFor(async () => expect((await readSource(itemId)).version).toBe(2));
    await restoreRequestId();
    expect((await readSource(otherId)).status).toBe("kept");
    await page.keyboard.press("Escape");
    await page.getByTestId("workbench-page").focus();
    await page.keyboard.press("Control+z");
    await vi.waitFor(async () => expect((await readSource(itemId)).version).toBe(1));
    expect((await readSource(otherId)).status).toBe("kept");
    const beforeReplay = value(await agent.callCommand<{ node: ReviewNode }>("review.get", { target })).node.revision;
    await page.getByTestId("review-branches-open").click();
    await page.getByTestId(`review-branch-compare-${branch.node.id}`).click();
    await page.getByRole("checkbox", { name: /^(选择|Select) Edit target$/ }).check();
    // Repeat the actual human UI request with its original UUID in this isolated profile.
    await pinRequestId();
    await page.getByTestId("review-branch-adopt").click();
    await vi.waitFor(async () => expect(await page.getByRole("checkbox", { name: /^(选择|Select) Edit target$/ }).isChecked()).toBe(false));
    await restoreRequestId();
    expect(value(await agent.callCommand<{ node: ReviewNode }>("review.get", { target })).node.revision).toBe(beforeReplay);
    expect(value(await agent.callCommand<{ replayed: boolean }>("review.branches.create", create)).replayed).toBe(true);
    expect((await readSource(itemId)).version).toBe(1);
  } finally { await agent.close(); await launched.close(); }
}, 120_000);

test("CLI submits real inherited media results and the GUI displays, adopts and undoes them", async () => {
  const launched = await launchApp();
  await launched.waitForEndpointFile();
  const agent = await connectExternalAgent(launched.endpointFile);
  try {
    const page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await page.getByTestId("review-new-task").click();
    await page.getByLabel(/Task name|任务名称/).fill("Media source");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    const context = value(await agent.callCommand<ReviewContext>("review.context"));
    const source = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context.target })).nodes[0];
    const target = { ...context.target, nodeId: source.id };
    const imagePath = createImageFixture(launched.runDir, "branch-original.png");
    const videoPath = createVideoFixture(launched.runDir, "branch-original.mp4");
    const imageOutput = path.join(launched.runDir, "branch-result.png"), videoOutput = path.join(launched.runDir, "branch-result.mp4");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", imagePath, "-vf", "hflip", "-frames:v", "1", "-threads", "1", imageOutput], { windowsHide: true });
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", videoPath, "-vf", "hflip", "-c:v", "libx264", "-preset", "veryfast", videoOutput], { windowsHide: true });
    const image = crypto.randomUUID(), video = crypto.randomUUID(), originalImage = crypto.randomUUID(), originalVideo = crypto.randomUUID();
    const nextImage = crypto.randomUUID(), nextVideo = crypto.randomUUID();
    value(await agent.callCommand("review.ingest", { target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), batchId: crypto.randomUUID(), name: "Media",
      files: [{ resourceId: originalImage, sourcePath: imagePath, mime: "image/png" }, { resourceId: originalVideo, sourcePath: videoPath, mime: "video/mp4" }],
      items: [{ id: image, title: "Media image", type: "image", content: { type: "image", mediaId: originalImage } },
        { id: video, title: "Media video", type: "video", content: { type: "video", mediaId: originalVideo } }] }));
    const branch = value(await agent.callCommand<{ node: ReviewNode; target: ReviewContext["target"] }>("review.branches.create", {
      target, expectedNodeRevision: 1, expectedWorkspaceRevision: 1, requestId: crypto.randomUUID(), taskId: crypto.randomUUID(), name: "Media edits" }));
    const branchItems = value(await agent.callCommand<{ items: Array<{ id: string; title: string }> }>("review.get", { target: branch.target })).items;
    const branchImage = branchItems.find(item => item.title === "Media image")!.id, branchVideo = branchItems.find(item => item.title === "Media video")!.id;
    const submit = { target: branch.target, expectedNodeRevision: 1, requestId: crypto.randomUUID(),
      files: [{ resourceId: nextImage, sourcePath: imageOutput, mime: "image/png" }, { resourceId: nextVideo, sourcePath: videoOutput, mime: "video/mp4" }],
      results: [{ itemId: branchImage, expectedItemVersion: 1, content: { type: "image", mediaId: nextImage } },
        { itemId: branchVideo, expectedItemVersion: 1, content: { type: "video", mediaId: nextVideo } }] };
    value(await agent.callCommand("review.branches.submit", submit));
    expect(value(await agent.callCommand<{ replayed: boolean }>("review.branches.submit", submit)).replayed).toBe(true);
    await page.getByTestId("review-branches-open").click();
    await page.getByTestId(`review-branch-compare-${branch.node.id}`).click();
    const dialog = page.getByTestId("review-branch-dialog");
    await page.getByTestId(`review-branch-result-${branchImage}`).click();
    await vi.waitFor(async () => expect(await dialog.locator("img").evaluateAll(images => images.length === 2 && images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true));
    await page.getByTestId(`review-branch-result-${branchVideo}`).click();
    await vi.waitFor(async () => expect(await dialog.locator("video").evaluateAll(videos => videos.length === 2 && videos.every(video => (video as HTMLVideoElement).readyState >= 1))).toBe(true));
    await page.getByRole("checkbox", { name: /^(选择|Select) Media image$/ }).check();
    await page.getByRole("checkbox", { name: /^(选择|Select) Media video$/ }).check();
    await page.getByTestId("review-branch-adopt").click();
    const read = async (itemId: string) => value(await agent.callCommand<{ item: WorkbenchItem }>("review.get", { target, itemId })).item;
    await vi.waitFor(async () => expect((await read(image)).content).toMatchObject({ mediaId: nextImage }));
    expect((await read(video)).content).toMatchObject({ mediaId: nextVideo });
    await page.keyboard.press("Escape");
    await page.getByTestId("workbench-tree-panel").getByText("Media image", { exact: true }).click();
    await vi.waitFor(async () => expect(await page.getByTestId("workbench-content").locator("img").first().getAttribute("src")).toContain(nextImage));
    await page.getByTestId("workbench-tree-panel").getByText("Media video", { exact: true }).click();
    await vi.waitFor(async () => expect(await page.getByTestId("workbench-content").locator("video").last().getAttribute("src")).toContain(nextVideo));
    await page.getByTestId("workbench-page").focus();
    await page.keyboard.press("Control+z");
    await vi.waitFor(async () => expect((await read(image)).content).toMatchObject({ mediaId: originalImage }));
    expect((await read(video)).content).toMatchObject({ mediaId: originalVideo });
    const old = value(await agent.callCommand<{ content: { mediaId: string } }>("review.versions.get", { target, itemId: image, version: 2 }));
    expect(old.content.mediaId).toBe(nextImage);
  } finally { await agent.close(); await launched.close(); }
}, 150_000);
