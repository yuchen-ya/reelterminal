import { openWorkspaceDirectory } from "./harness/workspace-tabs";
import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, value, type ExternalAgent } from "./harness/cli-client";
import { ARTIFACTS_DIR } from "./harness/paths";
import { createImageFixture } from "./harness/workbench-fixtures";

describe("review image loading and controls", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  const selectionTimes: number[] = [];
  afterAll(async () => {
    if (launched && !launched.page.isClosed()) {
      await mkdir(ARTIFACTS_DIR, { recursive: true });
      await launched.page.screenshot({ path: path.join(ARTIFACTS_DIR, "review-image-loading.png") });
      await writeFile(path.join(ARTIFACTS_DIR, "review-image-loading.json"), JSON.stringify({
        selectionTimesMs: selectionTimes,
        console: launched.output.rendererConsole,
        images: await launched.page.locator('[data-testid="workbench-content"] img').evaluateAll(images => images.map(element => {
          const image = element as HTMLImageElement;
          return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight,
            rect: image.getBoundingClientRect().toJSON() };
        })),
      }, null, 2));
    }
    await agent?.close();
    await launched?.close();
  });

  test("displays consecutive images and keeps controls reachable at desktop widths", async () => {
    launched = await launchApp();
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
    const page = launched.page;
    await page.evaluate(() => localStorage.setItem("openreel-locale", "zh-CN"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/ }).click();
    await openWorkspaceDirectory(page);
    await page.getByTestId("review-new-task").click();
    await page.getByLabel("任务名称").fill("图片加载回归");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor();
    await page.getByTestId("review-access-toggle").click();
    let context: ReviewContext;
    await vi.waitFor(async () => {
      context = value(await agent.callCommand<ReviewContext>("review.context"));
      expect(context.access).toBe("write");
    });
    const { nodes } = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: context!.target }));
    const target = { ...context!.target, nodeId: nodes[0].id };
    const resourceIds = [crypto.randomUUID(), crypto.randomUUID()];
    const titles = ["第一张图片", "第二张图片"];
    value(await agent.callCommand("review.ingest", {
      target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), batchId: crypto.randomUUID(), name: "图片批次",
      files: resourceIds.map((resourceId, index) => ({ resourceId, mime: "image/png",
        sourcePath: createImageFixture(launched.runDir, `image-${index}.png`) })),
      items: resourceIds.map((mediaId, index) => ({ id: crypto.randomUUID(), title: titles[index], type: "image",
        content: { type: "image", mediaId } })),
    }));
    for (const index of [0, 1, 0, 1]) {
      const start = performance.now();
      await page.getByTestId("workbench-tree-panel").getByText(titles[index], { exact: true }).click();
      await vi.waitFor(async () => {
        const image = page.locator('[data-testid="image-stage"] img');
        expect(await image.count()).toBe(1);
        expect(await image.getAttribute("src")).toBe(`app://reelterminal/review-media/${resourceIds[index]}`);
        expect(await image.evaluate(element => {
          const img = element as HTMLImageElement;
          return img.complete && img.naturalWidth > 0 && img.getBoundingClientRect().width > 10;
        })).toBe(true);
        expect(await page.getByTestId("image-stage-pointer-surface").count()).toBe(1);
      }, { timeout: 10_000 });
      selectionTimes.push(performance.now() - start);
    }
    expect(await page.getByRole("button", { name: "如何审阅", exact: true }).count()).toBe(0);
    expect(await page.getByTestId("workbench-agent-details").count()).toBe(0);

    for (const width of [1280, 1600]) {
      await page.setViewportSize({ width, height: 900 });
      for (const mode of ["annotate", "repair", "navigate"]) {
        await page.getByTestId(`image-mode-${mode}`).click();
        const inaccessible = await page.getByTestId("image-toolbar").locator("button").evaluateAll(buttons => buttons.filter(button => {
          const rect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return rect.x < 0 || rect.right > innerWidth || !hit || !button.contains(hit);
        }).map(button => button.textContent || button.getAttribute("title")));
        expect(inaccessible).toEqual([]);
      }
    }
    await page.getByTestId("image-mode-annotate").click();
    const stage = await page.getByTestId("image-stage-pointer-surface").boundingBox();
    expect(stage!.width).toBeGreaterThan(10);
    await page.mouse.move(stage!.x + stage!.width * 0.2, stage!.y + stage!.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(stage!.x + stage!.width * 0.6, stage!.y + stage!.height * 0.6, { steps: 4 });
    await page.mouse.up();
    await vi.waitFor(async () => expect(await page.getByTestId("image-mode-annotate").textContent()).toContain("(1)"));
    await page.getByTestId("image-stage-pointer-surface").waitFor();
  }, 120_000);
});
