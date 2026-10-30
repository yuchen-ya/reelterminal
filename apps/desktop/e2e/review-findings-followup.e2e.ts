import { expect, test, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchApp } from "./harness/launch";
import { createEvidence } from "./harness/evidence";
import { createImageFixture } from "./harness/workbench-fixtures";
import { openOrCreateBoard, openWorkspaceDirectory } from "./harness/workspace-tabs";
import { connectExternalAgent, value } from "./harness/cli-client";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import type { WorkbenchItem } from "@reelterminal/core/types/workbench";
import { createRepairAcceptanceFixture } from "./harness/repair-acceptance-fixtures";

test("Markdown percent references keep the private board usable across tab close and restart", async () => {
  let launched = await launchApp();
  let page = launched.page;
  const evidence = createEvidence("review-findings-percent-markdown", page);
  try {
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await openOrCreateBoard(page);
    const boardId = (await page.getByTestId("human-board-canvas").getAttribute("data-board-id"))!;
    const directory = path.join(launched.runDir, "percent-document");
    await mkdir(directory);
    createImageFixture(directory, "100%.png");
    const source = "# Percent reference regression\n![malformed](100%.png)\n![encoded](100%25.png)\nStill usable after the missing reference.";
    const filename = path.join(directory, "notes.md");
    await writeFile(filename, source);
    await page.getByTestId("human-board-import-files").setInputFiles(filename);
    const verifyPreview = async () => {
      const preview = page.getByTestId("human-board-document");
      await preview.getByRole("heading", { name: "Percent reference regression" }).waitFor({ timeout: 30_000 });
      await vi.waitFor(async () => expect(await preview.getByAltText("encoded").evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true));
      expect(await preview.getByAltText("malformed").evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(0);
      expect(await preview.innerText()).toContain("Still usable");
      expect(await page.getByTestId(`board-tab-${boardId}`).count()).toBe(1);
      await vi.waitFor(async () => expect(await page.getByTestId("human-board-canvas").getAttribute("data-save-state")).toBe("saved"));
    };
    await verifyPreview();
    await evidence.screenshot("imported-missing-and-valid-reference");
    launched = await launched.relaunch();
    page = launched.page;
    evidence.bindPage(page);
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await verifyPreview();
    await evidence.screenshot("restored-private-board");
    await page.getByTestId(`close-tab-board-${boardId}`).click();
    await page.getByTestId("workbench-empty").waitFor();
    expect(launched.output.rendererConsole.filter(entry => /URIError|URI malformed/.test(entry))).toEqual([]);
    evidence.record("verified", { malformedReferenceMissing: true, encodedReferenceLoads: true, persistedBoardReopens: true, closeTabUsable: true });
  } finally {
    evidence.record("rendererConsole", launched.output.rendererConsole);
    if (!page.isClosed()) await evidence.screenshot("terminal");
    evidence.flush();
    await launched.close();
  }
});

test("a first repair decode failure shows the original and its reason, then a new repair loads", async () => {
  const launched = await launchApp();
  await launched.waitForEndpointFile();
  const agent = await connectExternalAgent(launched.endpointFile);
  const page = launched.page;
  const evidence = createEvidence("review-findings-first-repair", page);
  try {
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await openWorkspaceDirectory(page);
    await page.getByTestId("review-new-task").click();
    await page.getByLabel(/Task name|任务名称/).fill("First repair failure acceptance");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    const context = value(await agent.callCommand<ReviewContext>("review.context"));
    const node = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context.target })).nodes[0];
    const target = { ...context.target, nodeId: node.id };
    const fixture = createRepairAcceptanceFixture(path.join(launched.runDir, "first-repair-fixture"));
    const itemId = crypto.randomUUID(), sourceId = crypto.randomUUID();
    value(await agent.callCommand("review.ingest", { target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), batchId: crypto.randomUUID(), name: "First-open repair",
      files: [{ resourceId: sourceId, sourcePath: fixture.damagedPath, mime: "image/png" }],
      items: [{ id: itemId, title: "First-open house", type: "image", content: { type: "image", mediaId: sourceId, naturalWidth: fixture.width, naturalHeight: fixture.height } }] }));
    const read = async () => value(await agent.callCommand<{ item: WorkbenchItem; node: ReviewNode }>("review.get", { target, itemId }));
    const apply = async (color: string) => {
      const current = await read();
      value(await agent.callCommand("review.repair.apply", { target, expectedNodeRevision: current.node.revision, expectedItemVersion: current.item.version,
        itemId, requestId: crypto.randomUUID(), region: { space: "source-pixels", x: 0, y: 0, width: fixture.width, height: fixture.height },
        operations: [{ kind: "brush", color, size: 18, points: [{ x: 126, y: 90, pressure: 1 }] }] }));
      return (await read()).item.revisions.at(-1)!.mediaId;
    };
    const failedId = await apply("#ff2040");
    // Inject a browser decoder failure for the real managed repair only. The
    // source, persistent revisions and replacement are produced by the real CLI.
    await page.evaluate(resourceId => {
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = async function () {
        await decode.call(this);
        if (this.dataset.testid === "image-stage-pending-image" && this.src.includes(resourceId)) {
          throw new DOMException("Synthetic first repair decode failure", "EncodingError");
        }
      };
    }, failedId);
    // Ingest may already have selected and decoded the item. Closing its tab
    // removes that retained frame, making this a genuine first-open failure.
    await page.getByTestId(`close-tab-review-${node.id}`).click();
    await openWorkspaceDirectory(page);
    await page.getByTestId("review-node-list").getByText("First repair failure acceptance", { exact: true }).click();
    await page.getByTestId("workbench-tree-panel").getByText("First-open house", { exact: true }).click();
    const image = page.getByTestId("image-stage-image");
    await vi.waitFor(async () => expect(await image.getAttribute("src")).toContain(sourceId));
    expect(await page.getByTestId("repair-notice").innerText()).toMatch(/已回退原图.*图片解码失败/);
    expect(await image.getAttribute("data-display-mode")).toBe("original");
    await evidence.screenshot("first-repair-fallback-visible");
    const replacementId = await apply("#40ff20");
    await vi.waitFor(async () => expect(await image.getAttribute("src")).toContain(replacementId));
    expect(await image.getAttribute("data-display-mode")).toBe("repaired");
    expect(await page.getByTestId("repair-notice").count()).toBe(0);
    await evidence.screenshot("replacement-repair-loaded");
    evidence.record("verified", { firstRepairFailureInjectedAtDecode: true, originalVisible: true, failureReasonVisible: true, laterRepairLoads: true });
  } finally {
    evidence.record("rendererConsole", launched.output.rendererConsole);
    if (!page.isClosed()) await evidence.screenshot("terminal");
    evidence.flush();
    await agent.close();
    await launched.close();
  }
});
