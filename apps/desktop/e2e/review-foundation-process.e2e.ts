import { value } from "./harness/cli-client";
import { afterAll, describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import type { ReviewExportStatus } from "@reelterminal/core/review/export";
import path from "node:path";
import type { ReviewContext, ReviewNode, ReviewStep } from "@reelterminal/core/review/types";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/cli-client";
import { ARTIFACTS_DIR } from "./harness/paths";
import { createVideoFixture } from "./harness/workbench-fixtures";


describe("recorded review processing and native version comparisons", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  afterAll(async () => {
    if (launched && !launched.page.isClosed()) {
      await mkdir(ARTIFACTS_DIR, { recursive: true });
      await launched.page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-process-terminal.png") });
      await writeFile(path.join(ARTIFACTS_DIR, "review-process-console.json"), JSON.stringify(launched.output.rendererConsole, null, 2));
    }
    await agent?.close(); await launched?.close();
  });

  test("eight actual local image stages, a second pose input, a branch, failure, missing file and restart", async () => {
    launched = await launchApp(); await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
    let context: ReviewContext;
    await vi.waitFor(async () => { context = value(await agent.callCommand<ReviewContext>("review.context")); }, { timeout: 15_000 });
    const page = launched.page;
    await page.getByRole("tab", { name: /Review Workspace/i }).click();
    await page.getByTestId("review-new-task").click();
    await page.getByLabel("Task name").fill("Eight-stage pixel fixture");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    await vi.waitFor(async () => { context = value(await agent.callCommand<ReviewContext>("review.context")); expect(context.access).toBe("write"); });
    const node = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context.target })).nodes[0];
    const target = { ...context.target, nodeId: node.id };
    let revision = node.revision;
    const runId = randomUUID();
    const files = path.join(launched.runDir, "actual-processing"); await mkdir(files);
    const original = path.join(files, "01-original.png");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.04", "-vf", "drawbox=x=16:y=8:w=32:h=48:color=0x33aa88:t=fill,drawbox=x=24:y=22:w=4:h=4:color=white:t=fill,drawbox=x=36:y=22:w=4:h=4:color=white:t=fill", "-frames:v", "1", "-threads", "1", original], { windowsHide: true });
    const posePath = path.join(files, "pose-reference.png");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", original, "-vf", "hflip", "-frames:v", "1", "-threads", "1", posePath], { windowsHide: true });
    const poseItem = randomUUID(), poseResource = randomUUID();
    value(await agent.callCommand("review.ingest", { target, expectedNodeRevision: revision++, requestId: randomUUID(), batchId: randomUUID(), name: "Pose reference",
      files: [{ resourceId: poseResource, sourcePath: posePath, mime: "image/png" }], items: [{ id: poseItem, title: "Pose reference", type: "image", content: { type: "image", mediaId: poseResource, naturalWidth: 64, naturalHeight: 64 } }] }));
    const stages: Array<{ stepId: string; itemId: string; resourceId: string; file: string; label: string }> = [];
    const labels = ["原像素素材", "平滑参考", "姿势参考叠加（本地验证）", "放大提质（Lanczos）", "去背景", "补眼睛", "缩小量化", "最终补点"];
    const filters = ["", "scale=128:128:flags=bilinear,scale=64:64:flags=area", "", "scale=256:256:flags=lanczos", "format=rgba,colorkey=0x000000:0.08:0", "drawbox=x=100:y=88:w=8:h=8:color=white:t=fill", "scale=64:64:flags=neighbor", "drawbox=x=26:y=23:w=1:h=1:color=black:t=fill"];
    for (let index = 0; index < labels.length; index++) {
      const stepId = randomUUID(), itemId = randomUUID(), resourceId = randomUUID();
      const output = index === 0 ? original : path.join(files, `${String(index + 1).padStart(2, "0")}.png`);
      const previous = stages.at(-1);
      const inputs = previous ? [{ nodeId: node.id, itemId: previous.itemId, version: 1, role: "source", ...(index === 5 ? { region: { space: "source-pixels", x: 96, y: 80, width: 24, height: 24 } } : {}) }, ...(index === 2 ? [{ nodeId: node.id, itemId: poseItem, version: 1, role: "pose" }] : [])] : [];
      value(await agent.callCommand("review.steps.start", { target, expectedNodeRevision: revision++, requestId: randomUUID(), stepId, runId, label: labels[index], inputs,
        method: { kind: "algorithm", name: index === 0 ? "Native managed import" : "FFmpeg", version: index === 0 ? "1" : "8.1.1" }, parameters: { fixture: true, ...(filters[index] ? { filter: filters[index] } : {}) },
        ...(previous && index !== 2 ? { mapping: { kind: "image-bounds", inputIndex: 0, outputIndex: 0 } } : {}) }));
      if (index === 2) execFileSync("ffmpeg", ["-y", "-v", "error", "-i", previous!.file, "-i", posePath, "-filter_complex", "[0:v][1:v]blend=all_mode=screen:all_opacity=0.15", "-frames:v", "1", "-threads", "1", output], { windowsHide: true });
      else if (index > 0) execFileSync("ffmpeg", ["-y", "-v", "error", "-i", previous!.file, "-vf", filters[index], "-frames:v", "1", "-threads", "1", output], { windowsHide: true });
      const dimension = index >= 3 && index <= 5 ? 256 : 64;
      value(await agent.callCommand("review.steps.complete", { target, expectedNodeRevision: revision++, requestId: randomUUID(), stepId,
        files: [{ resourceId, sourcePath: output, mime: "image/png" }], ingest: { batchId: randomUUID(), name: labels[index], items: [{ id: itemId, title: labels[index], type: "image", content: { type: "image", mediaId: resourceId, naturalWidth: dimension, naturalHeight: dimension } }] }, outputs: [{ nodeId: node.id, itemId, version: 1, role: "result" }] }));
      stages.push({ stepId, itemId, resourceId, file: output, label: labels[index] });
    }
    const failedId = randomUUID();
    value(await agent.callCommand("review.steps.start", { target, expectedNodeRevision: revision++, requestId: randomUUID(), stepId: failedId, runId, label: "失败尝试（真实命令错误）", inputs: [{ nodeId: node.id, itemId: stages[4].itemId, version: 1, role: "source" }], method: { kind: "algorithm", name: "FFmpeg" }, parameters: {} }));
    expect(() => execFileSync("ffmpeg", ["-v", "error", "-i", path.join(files, "actually-missing.png"), "-f", "null", "-"], { windowsHide: true, stdio: "pipe" })).toThrow();
    value(await agent.callCommand("review.steps.fail", { target, expectedNodeRevision: revision++, requestId: randomUUID(), stepId: failedId, error: "FFmpeg rejected the missing input file" }));
    const branchFile = path.join(files, "candidate.png");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", stages[4].file, "-vf", "hflip", "-frames:v", "1", "-threads", "1", branchFile], { windowsHide: true });
    const branchItem = randomUUID(), branchResource = randomUUID();
    value(await agent.callCommand("review.ingest", { target, expectedNodeRevision: revision++, requestId: randomUUID(), batchId: randomUUID(), name: "Candidate branch", files: [{ resourceId: branchResource, sourcePath: branchFile, mime: "image/png" }],
      items: [{ id: branchItem, title: "Unadopted mirrored candidate", type: "image", content: { type: "image", mediaId: branchResource, naturalWidth: 256, naturalHeight: 256 } }],
      steps: [{ id: randomUUID(), runId, label: "候选分支（hflip）", inputs: [{ nodeId: node.id, itemId: stages[4].itemId, version: 1, role: "source" }], outputs: [{ nodeId: node.id, itemId: branchItem, version: 1, role: "candidate" }], method: { kind: "algorithm", name: "FFmpeg", version: "8.1.1" }, parameters: { filter: "hflip" }, startedAt: Date.now() - 20, finishedAt: Date.now() }] }));
    const textId = randomUUID(), dataId = randomUUID(), rowId = randomUUID(), columnId = randomUUID(), videoId = randomUUID(), videoResource = randomUUID();
    const videoPath = createVideoFixture(files, "compare-input.mp4");
    value(await agent.callCommand("review.ingest", { target, expectedNodeRevision: revision++, requestId: randomUUID(), batchId: randomUUID(), name: "Comparison sources", files: [{ resourceId: videoResource, sourcePath: videoPath, mime: "video/mp4" }], items: [
      { id: textId, title: "Diff source", type: "text", content: { type: "text", entryId: randomUUID(), title: "Diff source", speakerOrContext: "", text: "Original 👀\r\nSame phrase\nSame phrase" } },
      { id: dataId, title: "Stable cells", type: "data", content: { type: "data", datasetId: randomUUID(), columns: [{ columnId, title: "Value" }], rows: [{ rowId, cells: { [columnId]: null } }], proposals: [] } },
      { id: videoId, title: "Video source", type: "video", content: { type: "video", mediaId: videoResource, durationSec: 2, resolution: "320x180" } },
    ] }));
    const otherNode = value(await agent.callCommand<ReviewNode>("review.nodes.create", { target: context.target, expectedWorkspaceRevision: 1, requestId: randomUUID(), name: "Shared-source ownership boundary" }));
    await page.evaluate(async target => window.reelterminal!.collabControl!.setReviewAccess!({ access: "read-only", reviewWorkspaceId: target.reviewWorkspaceId, instanceId: target.instanceId }), target);
    const inspection = value(await agent.callCommand<{ nodeRevision: number; resource: { id: string; metadata: { width: number; height: number } } }>("review.media.inspect", {
      target, expectedNodeRevision: revision, reference: { nodeId: node.id, itemId: videoId, version: 1, role: "source" },
    }));
    expect(inspection).toMatchObject({ nodeRevision: revision, resource: { id: videoResource, metadata: { width: 320, height: 180 } } });
    expect((await agent.callCommand("review.media.inspect", { target: { ...target, nodeId: otherNode.id }, expectedNodeRevision: 0, reference: { resourceId: videoResource, role: "source" } })).error?.code).toBe("NOT_FOUND");
    const sharedFrames = value(await agent.callCommand<{ target: typeof target; nodeRevision: number; frames: Array<{ frame: number; ptsTimeSec: number; artifact: { path: string } }> }>("review.frames.extract", {
      target, expectedNodeRevision: revision, reference: { resourceId: videoResource, role: "source" }, frames: [0, 30, 59],
    }));
    expect(sharedFrames.target).toEqual(target);
    expect(sharedFrames.nodeRevision).toBe(revision);
    expect(sharedFrames.frames.map(frame => frame.frame)).toEqual([0, 30, 59]);
    expect(sharedFrames.frames[1].ptsTimeSec).toBeCloseTo(1, 5);
    for (const frame of sharedFrames.frames) {
      expect((await readFile(frame.artifact.path)).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(frame.artifact.path).toContain(`${path.sep}review${path.sep}jobs${path.sep}`);
    }
    expect(value(await agent.callCommand<{ node: ReviewNode }>("review.get", { target })).node.revision).toBe(revision);
    expect((await agent.callCommand("editor.get_context")).error?.message).toBe("No project is open");
    await page.evaluate(async target => window.reelterminal!.collabControl!.setReviewAccess!({ access: "write", reviewWorkspaceId: target.reviewWorkspaceId, instanceId: target.instanceId }), target);
    for (const [itemId, kind, label] of [[textId, "text", "真实文字差异"], [dataId, "data", "稳定单元格差异"]] as const) {
      const stepId = randomUUID();
      value(await agent.callCommand("review.steps.start", { target, expectedNodeRevision: revision++, requestId: randomUUID(), stepId, runId, label, inputs: [{ nodeId: node.id, itemId, version: 1, role: "source" }], method: { kind: "algorithm", name: "Deterministic fixture revision" }, parameters: {} }));
      value(await agent.callCommand("review.steps.complete", { target, expectedNodeRevision: revision++, requestId: randomUUID(), stepId, ops: [{ op: "workbench.content.update", itemId, expectedItemVersion: 1, kind, ...(kind === "text" ? { text: "Edited 👀\r\nSame phrase\nFinal phrase" } : { patches: [{ rowId, columnId, value: "" }] }) }], outputs: [{ nodeId: node.id, itemId, version: 2, role: "result" }] }));
    }
    const videoStep = randomUUID(), videoOutput = randomUUID(), videoOutputResource = randomUUID();
    value(await agent.callCommand("review.steps.start", { target, expectedNodeRevision: revision++, requestId: randomUUID(), stepId: videoStep, runId, label: "真实视频复制与时间映射", inputs: [{ nodeId: node.id, itemId: videoId, version: 1, role: "source", range: { startSec: 0, endSec: 2 } }], method: { kind: "algorithm", name: "node:fs copyFile" }, parameters: {}, mapping: { kind: "time-range", inputIndex: 0, outputIndex: 0 } }));
    const videoCopy = path.join(files, "compare-output.mp4"); await copyFile(videoPath, videoCopy);
    value(await agent.callCommand("review.steps.complete", { target, expectedNodeRevision: revision++, requestId: randomUUID(), stepId: videoStep, files: [{ resourceId: videoOutputResource, sourcePath: videoCopy, mime: "video/mp4" }], ingest: { batchId: randomUUID(), name: "Video copy", items: [{ id: videoOutput, title: "Copied video", type: "video", content: { type: "video", mediaId: videoOutputResource, durationSec: 2, resolution: "320x180" } }] }, outputs: [{ nodeId: node.id, itemId: videoOutput, version: 1, role: "result", range: { startSec: 0, endSec: 2 } }] }));
    const recorded = value(await agent.callCommand<{ steps: ReviewStep[] }>("review.steps.list", { target }));
    expect(recorded.steps).toHaveLength(13);
    expect(recorded.steps.find(step => step.id === failedId)).toMatchObject({ state: "failed", outputs: [] });
    expect(recorded.steps.find(step => step.id === stages[2].stepId)!.inputs[1].role).toBe("pose");
    await page.getByTestId("review-process-tab").click();
    await page.getByTestId("review-process-view").waitFor();
    const compare = async (label: string) => page.getByTestId("review-step-card").filter({ hasText: label }).getByTestId("review-step-compare").click();
    await compare("真实文字差异");
    await vi.waitFor(async () => expect(await page.getByTestId("review-text-diff").textContent()).toContain("Edited 👀"));
    await compare("稳定单元格差异");
    await vi.waitFor(async () => expect(await page.getByTestId("review-data-diff").textContent()).toContain(rowId));
    expect(await page.getByTestId("review-data-diff").textContent()).toContain("null");
    await compare("真实视频复制与时间映射");
    await page.getByRole("button", { name: "Play mapped pair" }).click();
    await vi.waitFor(async () => {
      const times = await page.getByTestId("review-comparison").locator("video").evaluateAll(videos => videos.map(video => (video as HTMLVideoElement).currentTime));
      expect(times[0]).toBeGreaterThan(0.05); expect(Math.abs(times[0] - times[1])).toBeLessThan(0.2);
    });
    const eyeStep = page.getByTestId("review-step-card").filter({ hasText: "补眼睛" });
    await eyeStep.getByTestId("review-step-compare").click();
    await page.getByTestId("review-comparison-left").locator("img").waitFor();
    await page.getByTestId("review-comparison-right").locator("img").waitFor();
    await page.getByRole("checkbox", { name: "Nearest-neighbor pixels and grid" }).check();
    await page.getByRole("combobox", { name: "Scale" }).selectOption("4");
    await page.getByRole("button", { name: "Focus recorded region" }).click();
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-process-eye.png") });
    await page.getByTestId("review-step-detail").getByTestId("review-step-export").last().click();
    await page.getByTestId("review-export-prepare").click();
    await vi.waitFor(async () => expect(await page.getByTestId("review-export-status").getAttribute("data-state")).toBe("ready"));
    const exactExportId = await page.getByTestId("review-export-status").getAttribute("data-export-id");
    const exactExport = value(await agent.callCommand<ReviewExportStatus>("review.export.status", { target, exportId: exactExportId }));
    expect(exactExport.manifest).toMatchObject({ mode: "version", entries: [{ itemId: stages[5].itemId, itemVersion: 1, resourceId: stages[5].resourceId }] });
    const exactCopy = value(await agent.callCommand<{ directory: string }>("review.export.copy", { target, exportId: exactExportId, directory: files }));
    expect((await readFile(path.join(exactCopy.directory, exactExport.manifest!.entries[0].relativePath))).equals(await readFile(stages[5].file))).toBe(true);
    await page.keyboard.press("Escape");
    const missing = await page.evaluate(id => window.reelterminal!.reviewFiles!.resolve(id), stages[4].resourceId);
    if (!missing.ok) throw new Error(missing.error.message);
    const relative = path.relative(launched.runDir, missing.value.path);
    expect(relative.startsWith("..") || path.isAbsolute(relative)).toBe(false);
    await unlink(missing.value.path);
    await eyeStep.getByTestId("review-step-compare").click();
    await page.getByTestId("review-comparison-left").getByRole("alert").waitFor();
    await page.getByTestId("review-step-card").filter({ hasText: "最终补点" }).getByTestId("review-step-compare").click();
    await page.getByTestId("review-comparison-right").locator("img").waitFor();
    await agent.close(); launched = await launched.relaunch(); agent = await connectExternalAgent(launched.endpointFile);
    await launched.page.getByTestId("review-process-view").waitFor({ timeout: 20_000 });
    await launched.page.getByTestId("review-comparison-right").locator("img").waitFor();
    const reopened = value(await agent.callCommand<ReviewContext>("review.context"));
    const retained = value(await agent.callCommand<{ steps: ReviewStep[] }>("review.steps.list", { target: { ...reopened.target, nodeId: node.id } }));
    expect(retained.steps).toEqual(recorded.steps);
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1024, 700));
    await launched.page.getByTestId("review-step-detail").getByTestId("review-step-export").last().scrollIntoViewIfNeeded();
    const small = await launched.page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, dpr: devicePixelRatio }));
    expect(small.scrollWidth).toBeLessThanOrEqual(small.width + 1);
    const exportButton = await launched.page.getByTestId("review-step-detail").getByTestId("review-step-export").last().boundingBox();
    expect(exportButton!.y).toBeGreaterThanOrEqual(0); expect(exportButton!.y + exportButton!.height).toBeLessThanOrEqual(701);
    await launched.page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-process-minimum-window.png") });
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
    await launched.page.getByTestId("review-new-task").click();
    await launched.page.getByLabel("Task name").fill("Final-only fixture");
    await launched.page.getByTestId("review-create-node").click();
    await vi.waitFor(async () => expect(await launched.page.getByTestId("review-node-title").textContent()).toBe("Final-only fixture"));
    const finalNodeId = await launched.page.getByTestId("review-node-title").getAttribute("data-node-id");
    await launched.page.getByTestId("review-access-toggle").click();
    const finalTarget = { ...reopened.target, nodeId: finalNodeId };
    value(await agent.callCommand("review.ingest", { target: finalTarget, expectedNodeRevision: 0, requestId: randomUUID(), batchId: randomUUID(), name: "Only a final file, no process report",
      items: [{ id: randomUUID(), title: "Final-only image", type: "image", content: { type: "image", mediaId: poseResource, naturalWidth: 64, naturalHeight: 64 } }] }));
    await launched.page.getByTestId("review-process-tab").click();
    await launched.page.getByTestId("review-process-empty").waitFor();
    expect(await launched.page.getByTestId("review-process-empty").textContent()).toContain("No processing steps were recorded");
    await launched.page.getByTestId("review-content-tab").click();
    await launched.page.getByTestId("workbench-content").locator("img").first().waitFor();
    expect(value(await agent.callCommand<{ steps: ReviewStep[] }>("review.steps.list", { target: finalTarget })).steps).toHaveLength(0);
    await launched.page.getByTestId("review-node-list").getByRole("button", { name: /Eight-stage pixel fixture/ }).click();
    await launched.page.getByTestId("review-process-view").waitFor();
    await launched.page.getByTestId("review-comparison-right").locator("img").waitFor();
    await writeFile(path.join(ARTIFACTS_DIR, "review-process.json"), JSON.stringify({ measuredAt: new Date().toISOString(), node, recorded, stages, inspection, sharedFrames, exactExport, exactCopy, reopened, retained, note: "Deterministic local FFmpeg fixtures exercise process/data contracts; they do not validate model-generated pose transfer or perceptual super-resolution quality." }, null, 2));
  });
});
