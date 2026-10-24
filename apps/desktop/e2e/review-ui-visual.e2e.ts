/**
 * Visual regression baseline spec for Review Workbench (isolated profile).
 *
 * Captures settled screenshots across 12 distinct UI states at fixed 1600x1000:
 * 1. empty-workspace: No nodes exist in Review Workspace
 * 2. empty-node: Node created, but no content ingested yet
 * 3. video: Video item selected (single node, ungrouped, multiple items)
 * 4. image: Image item selected
 * 5. text: Text corpus item selected
 * 6. data: Data table item selected
 * 7. model3d: 3D model item selected
 * 8. process: Process view (ReviewProcessView)
 * 9. sidebar-collapsed: Review node sidebar collapsed
 * 10. dialog-import: Review import modal dialog
 * 11. dialog-export: Review export modal dialog
 * 12. dialog-handoff: Handoff modal dialog (with >= 1 item in decided state)
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import { modelFixture } from "../../../packages/core/src/review/glb-fixtures.test-helper";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent, value } from "./harness/cli-client";
import { DESKTOP_DIR } from "./harness/paths";
import { createImageFixture } from "./harness/workbench-fixtures";

const PHASE = process.env.REVIEW_UI_PHASE ?? "0";
const OUTPUT_DIR = path.resolve(DESKTOP_DIR, "e2e/.artifacts/review-ui", `phase-${PHASE}`);

function createCustomVideoFixture(
  runDir: string,
  fileName: string,
  width = 1280,
  height = 640,
  durationSec = 4,
): string {
  const target = path.join(runDir, fileName);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${width}x${height}:rate=30:duration=${durationSec}`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      target,
    ],
    { windowsHide: true },
  );
  return target;
}

async function dismissNotifications(page: LaunchedApp["page"]): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dismiss = page.getByRole("button", { name: /Dismiss notification/i });
    if ((await dismiss.count()) === 0) return;
    await dismiss.first().click().catch(() => undefined);
    await page.waitForTimeout(150);
  }
}

async function captureScreenshot(
  page: LaunchedApp["page"],
  stateName: string,
): Promise<string> {
  await dismissNotifications(page);

  // Wait for loading status text or indicators to disappear
  await vi.waitFor(
    async () => {
      const loadingCount = await page.locator('[role="status"]').count();
      if (loadingCount > 0) {
        const texts = await page.locator('[role="status"]').allTextContents();
        const hasActiveLoading = texts.some((t) => /正在|loading/i.test(t));
        expect(hasActiveLoading).toBe(false);
      }
    },
    { timeout: 10_000 },
  ).catch(() => {});

  // Wait for inert attributes on review-node-editor to clear
  await vi.waitFor(
    async () => {
      const inerts = await page.locator('[data-testid="review-node-editor"][inert]').count();
      expect(inerts).toBe(0);
    },
    { timeout: 10_000 },
  ).catch(() => {});

  // Settle frame animations and transitions
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.waitForTimeout(400);

  const filePath = path.join(OUTPUT_DIR, `${stateName}.png`);
  await page.screenshot({ path: filePath });
  return filePath;
}

describe("review workbench visual baseline captures", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;

  beforeAll(async () => {
    await mkdir(OUTPUT_DIR, { recursive: true });

    launched = await launchApp();
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);

    const page = launched.page;

    // Switch UI language to Chinese via persisted preference + reload
    await page.evaluate(() => {
      localStorage.setItem("openreel-locale", "zh-CN");
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.documentElement.lang === "zh-CN");

    // Fix window size to 1600x1000
    await launched.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setContentSize(1600, 1000);
    });
    await page.waitForTimeout(500);
    await dismissNotifications(page);
  }, 300_000);

  afterAll(async () => {
    await agent?.close();
    await launched?.close();
  });

  test("captures 12 sequential visual states of review workbench", async () => {
    const page = launched.page;

    // Navigate to Review Workspace
    const reviewTab = page.getByRole("tab", { name: /Review Workspace|审阅工作台/i });
    await reviewTab.waitFor({ state: "visible", timeout: 20_000 });
    await reviewTab.click();
    await page.getByTestId("review-page").waitFor({ state: "visible", timeout: 20_000 });

    // -------------------------------------------------------------
    // State 1: empty-workspace (no nodes)
    // -------------------------------------------------------------
    await page.getByText("创建一个数据节点").waitFor({ state: "visible", timeout: 20_000 });
    await captureScreenshot(page, "empty-workspace");

    // -------------------------------------------------------------
    // State 2: empty-node (node created, no items)
    // -------------------------------------------------------------
    await page.getByLabel("新节点名称").fill("视频与全格式审阅");
    await page.getByTestId("review-create-node").click();
    await page.getByTestId("review-node-title").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByText("把待审内容放到这个节点").waitFor({ state: "visible", timeout: 20_000 });
    await captureScreenshot(page, "empty-node");

    // -------------------------------------------------------------
    // Data Preparation: ingest video, image, text, data, model3d, steps
    // -------------------------------------------------------------
    await page.getByTestId("review-access-toggle").click();
    let context: ReviewContext;
    await vi.waitFor(
      async () => {
        context = value(await agent.callCommand<ReviewContext>("review.context"));
        expect(context.access).toBe("write");
      },
      { timeout: 15_000 },
    );

    const nodesRes = value(
      await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", {
        target: context!.target,
      }),
    );
    const target = { ...context!.target, nodeId: nodesRes.nodes[0].id };

    const videoResourceId = crypto.randomUUID();
    const imageResourceId = crypto.randomUUID();
    const modelResourceId = crypto.randomUUID();

    const videoItemId = crypto.randomUUID();
    const imageItemId = crypto.randomUUID();
    const textItemId = crypto.randomUUID();
    const dataItemId = crypto.randomUUID();
    const modelItemId = crypto.randomUUID();

    const videoPath = createCustomVideoFixture(
      launched.runDir,
      "sample-1280x640.mp4",
      1280,
      640,
      5,
    );
    const imagePath = createImageFixture(launched.runDir, "sample-image.png");
    const modelGlb = modelFixture({ animated: false });
    const modelPath = path.join(launched.runDir, "sample-model.glb");
    await writeFile(modelPath, modelGlb.bytes);

    const batchId = crypto.randomUUID();

    value(
      await agent.callCommand("review.ingest", {
        target,
        expectedNodeRevision: 0,
        requestId: crypto.randomUUID(),
        batchId,
        name: "首轮全媒体审阅批次",
        files: [
          { resourceId: videoResourceId, sourcePath: videoPath, mime: "video/mp4" },
          { resourceId: imageResourceId, sourcePath: imagePath, mime: "image/png" },
          { resourceId: modelResourceId, sourcePath: modelPath, mime: "model/gltf-binary" },
        ],
        items: [
          {
            id: videoItemId,
            title: "1280x640_演示样片.mp4",
            type: "video",
            content: {
              type: "video",
              mediaId: videoResourceId,
              durationSec: 5,
              resolution: "1280x640",
            },
            provenanceTags: [
              {
                id: "prov-m1",
                category: "model",
                shortName: "母版",
                version: "v1",
                verification: "verified",
                detailSummary: "母版生成视频",
              },
            ],
          },
          {
            id: imageItemId,
            title: "高保真原画.png",
            type: "image",
            content: {
              type: "image",
              mediaId: imageResourceId,
              naturalWidth: 256,
              naturalHeight: 256,
            },
            provenanceTags: [
              {
                id: "prov-a1",
                category: "algorithm",
                shortName: "超分增强",
                version: "v2",
                verification: "declared",
                detailSummary: "超分辨率增强",
              },
            ],
          },
          {
            id: textItemId,
            title: "台词与语料.txt",
            type: "text",
            content: {
              type: "text",
              entryId: crypto.randomUUID(),
              title: "台词语料",
              speakerOrContext: "旁白",
              text: "第一段落：这是测试语料的内容。\n第二段落：包含多行文本以验证排版展示。\n第三行：emoji 🙂 与标点符号符号展示。",
            },
          },
          {
            id: dataItemId,
            title: "清洗数据表.csv",
            type: "data",
            content: {
              type: "data",
              datasetId: crypto.randomUUID(),
              columns: [
                { columnId: "col-date", title: "日期" },
                { columnId: "col-event", title: "事件" },
                { columnId: "col-score", title: "评分" },
              ],
              rows: [
                {
                  rowId: "r-1",
                  cells: { "col-date": "2026-10-24", "col-event": "基线验收", "col-score": "100" },
                },
                {
                  rowId: "r-2",
                  cells: { "col-date": "2026-10-25", "col-event": "模型训练", "col-score": "98" },
                },
              ],
              proposals: [],
            },
          },
          {
            id: modelItemId,
            title: "角色3D模型.glb",
            type: "model3d",
            content: {
              type: "model3d",
              resourceId: modelResourceId,
            },
          },
        ],
        steps: [
          {
            id: crypto.randomUUID(),
            runId: crypto.randomUUID(),
            label: "生成视频分镜与渲染",
            inputs: [],
            outputs: [{ nodeId: target.nodeId, itemId: videoItemId, version: 1, role: "result" }],
            method: {
              kind: "algorithm",
              name: "FFmpeg lavfi",
              version: "8.1.1",
            },
            parameters: { size: "1280x640", rate: 30 },
            startedAt: Date.now() - 60_000,
            finishedAt: Date.now() - 50_000,
          },
          {
            id: crypto.randomUUID(),
            runId: crypto.randomUUID(),
            label: "原画超分辨率增强",
            inputs: [{ resourceId: imageResourceId, role: "source" }],
            outputs: [{ nodeId: target.nodeId, itemId: imageItemId, version: 1, role: "result" }],
            method: {
              kind: "model",
              name: "Real-ESRGAN",
              version: "v0.3.0",
            },
            parameters: { scale: 4 },
            startedAt: Date.now() - 40_000,
            finishedAt: Date.now() - 30_000,
          },
        ],
      }),
    );

    // Wait for all tree items to render in sidebar
    for (const title of [
      "1280x640_演示样片.mp4",
      "高保真原画.png",
      "台词与语料.txt",
      "清洗数据表.csv",
      "角色3D模型.glb",
    ]) {
      await page
        .getByTestId("workbench-tree-panel")
        .getByText(title, { exact: true })
        .first()
        .waitFor({ state: "visible", timeout: 20_000 });
    }

    // -------------------------------------------------------------
    // State 3: video (video item selected)
    // -------------------------------------------------------------
    await page
      .getByTestId("workbench-tree-panel")
      .getByText("1280x640_演示样片.mp4", { exact: true })
      .first()
      .click();
    await page.locator("video").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForFunction(
      () => {
        const v = document.querySelector("video");
        return v !== null && v.readyState >= 2;
      },
      undefined,
      { timeout: 20_000 },
    );
    await captureScreenshot(page, "video");

    // -------------------------------------------------------------
    // State 4: image (image item selected)
    // -------------------------------------------------------------
    await page
      .getByTestId("workbench-tree-panel")
      .getByText("高保真原画.png", { exact: true })
      .first()
      .click();
    await page.getByTestId("image-stage").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForFunction(
      () => {
        const img = document.querySelector<HTMLImageElement>("[data-testid='image-stage'] img");
        return img !== null && img.complete && img.naturalWidth > 0;
      },
      undefined,
      { timeout: 20_000 },
    );
    await captureScreenshot(page, "image");

    // -------------------------------------------------------------
    // State 5: text (text corpus item selected)
    // -------------------------------------------------------------
    await page
      .getByTestId("workbench-tree-panel")
      .getByText("台词与语料.txt", { exact: true })
      .first()
      .click();
    await page.getByTestId("text-body").waitFor({ state: "visible", timeout: 20_000 });
    await captureScreenshot(page, "text");

    // -------------------------------------------------------------
    // State 6: data (data table item selected)
    // -------------------------------------------------------------
    await page
      .getByTestId("workbench-tree-panel")
      .getByText("清洗数据表.csv", { exact: true })
      .first()
      .click();
    await page.getByTestId("workbench-data-mark-rework").waitFor({
      state: "visible",
      timeout: 20_000,
    });
    await captureScreenshot(page, "data");

    // -------------------------------------------------------------
    // State 7: model3d (3D model item selected)
    // -------------------------------------------------------------
    await page
      .getByTestId("workbench-tree-panel")
      .getByText("角色3D模型.glb", { exact: true })
      .first()
      .click();
    await vi.waitFor(
      async () => {
        const phase = await page.getByTestId("model-preview").getAttribute("data-phase");
        expect(phase).toBe("ready");
      },
      { timeout: 30_000 },
    );
    await captureScreenshot(page, "model3d");

    // -------------------------------------------------------------
    // State 8: process (ReviewProcessView)
    // -------------------------------------------------------------
    await page.getByTestId("review-process-tab").click();
    await page.getByTestId("review-step-card").first().waitFor({
      state: "visible",
      timeout: 20_000,
    });
    await captureScreenshot(page, "process");

    // Switch back to content view for remaining states
    await page.getByTestId("review-content-tab").click();
    await page.getByTestId("workbench-tree-panel").waitFor({ state: "visible", timeout: 20_000 });

    // -------------------------------------------------------------
    // State 9: sidebar-expanded (expand sidebar from default collapsed)
    // -------------------------------------------------------------
    // Switch to video item so it directly compares with State 3
    await page
      .getByTestId("workbench-tree-panel")
      .getByText("1280x640_演示样片.mp4", { exact: true })
      .first()
      .click();
    await page.locator("video").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForFunction(
      () => {
        const v = document.querySelector("video");
        return v !== null && v.readyState >= 2;
      },
      undefined,
      { timeout: 20_000 },
    );

    const expandSidebarBtn = page.getByRole("button", { name: /展开数据节点侧栏|展开侧栏/i }).first();
    if (await expandSidebarBtn.isVisible()) {
      await expandSidebarBtn.click();
    }
    await page.locator('[data-review-directory="true"]').waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await captureScreenshot(page, "sidebar-expanded");

    // Collapse sidebar again
    const collapseBtn = page.getByRole("button", { name: /收起侧栏/i }).first();
    if (await collapseBtn.isVisible()) {
      await collapseBtn.click();
    }
    await page.waitForTimeout(300);

    // -------------------------------------------------------------
    // State: node-menu-open (node action dropdown menu open)
    // -------------------------------------------------------------
    await page.getByTestId("review-node-menu-trigger").click();
    await page.getByText("重命名").waitFor({ state: "visible", timeout: 10_000 });
    await captureScreenshot(page, "node-menu-open");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // -------------------------------------------------------------
    // State: admin-menu-open (more admin options dropdown menu open)
    // -------------------------------------------------------------
    await page.getByTestId("review-admin-menu-trigger").click();
    await page.getByTestId("review-backup-open").waitFor({ state: "visible", timeout: 10_000 });
    await captureScreenshot(page, "admin-menu-open");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // -------------------------------------------------------------
    // State 10: dialog-import (import modal dialog)
    // -------------------------------------------------------------
    await page.getByTestId("workbench-new-batch").click();
    await page.getByTestId("review-import-submit").waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await captureScreenshot(page, "dialog-import");
    await page.keyboard.press("Escape");
    await page.getByTestId("review-import-submit").waitFor({
      state: "hidden",
      timeout: 15_000,
    });

    // -------------------------------------------------------------
    // State 11: dialog-export (export modal dialog)
    // -------------------------------------------------------------
    await page.getByTestId("review-export-open").click();
    await page.getByTestId("review-export-dialog").waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await captureScreenshot(page, "dialog-export");
    await page.keyboard.press("Escape");
    await page.getByTestId("review-export-dialog").waitFor({
      state: "hidden",
      timeout: 15_000,
    });

    // -------------------------------------------------------------
    // State 12: dialog-handoff (handoff modal dialog)
    // -------------------------------------------------------------
    // Select video item and commit a decision to make >= 1 item processed
    await page
      .getByTestId("workbench-tree-panel")
      .getByText("1280x640_演示样片.mp4", { exact: true })
      .first()
      .click();
    await page.locator("video").waitFor({ state: "visible", timeout: 20_000 });

    // Click '保留' button
    await page
      .getByTestId("workbench-bottom-dock")
      .getByRole("button", { name: "保留", exact: true })
      .click();

    // Handoff button becomes enabled
    const handoffBtn = page.getByRole("button", { name: /交回本轮决策/ });
    await vi.waitFor(
      async () => {
        expect(await handoffBtn.isEnabled()).toBe(true);
      },
      { timeout: 15_000 },
    );
    // Wait for the transient decision toast to fade away completely (3000ms duration)
    await page.waitForTimeout(3600);

    await handoffBtn.click();
    await page.getByText("互斥计数守恒").waitFor({ state: "visible", timeout: 15_000 });
    await captureScreenshot(page, "dialog-handoff");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // -------------------------------------------------------------
    // State 13: editor-shell (switch to video editing mode to verify shell)
    // -------------------------------------------------------------
    const videoEditTab = page.getByRole("tab", { name: /Video edit|视频编辑/i });
    await videoEditTab.click();
    await page.waitForFunction(() => {
      const tab = document.querySelector('[role="tab"][aria-selected="true"]');
      return tab !== null && /视频编辑|Video edit/i.test(tab.textContent ?? "");
    }, undefined, { timeout: 10_000 });
    await captureScreenshot(page, "editor-shell");

    // Switch back to review workspace tab
    await page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await page.getByTestId("review-page").waitFor({ state: "visible", timeout: 10_000 });
  }, 300_000);
});
