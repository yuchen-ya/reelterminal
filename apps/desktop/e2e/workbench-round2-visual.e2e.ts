import { switchToWorkbench, selectTreeItem } from "./harness/workbench-fixtures";
/**
 * Round-2 workbench visual + interaction acceptance (isolated profile).
 *
 * Restores and verifies the user's prototype hierarchy with REAL data:
 * empty workspace → real PNG/MP4 imported through `media.import` → Agent
 * `workbench.ingest` batch → image grid/zoom + in-canvas issue editing →
 * text/data layouts (no forced right column) → video marker creation and
 * source-time seeking → handoff preview → resizable/collapsible layout.
 *
 * Every screenshot is taken from the running Electron app at a 1440x900
 * content viewport (same aspect as the prototype baseline); no mock store or
 * demo media is involved. The companion
 * `workbench-round2-media.e2e.ts` covers image-repair derivatives and reopen.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/cli-client";
import {
  createProjectViaUI,
  enableAgentSessionViaUI,
  waitForEditorReady,
} from "./harness/ui";
import { createEvidence, type EvidenceRecord } from "./harness/evidence";
import {
  createImageFixture,
  createVideoFixture,
  importMedia,
  ingestBatch,
  readIdentity,
  readProjectState,
  waitForStableWorkspace,
  type WorkbenchIdentity,
} from "./harness/workbench-fixtures";

const BATCH_ID = "r2-visual-batch";
const IMAGE_ID = "r2-img-1";
const VIDEO_ID = "r2-vid-1";
const TEXT_ID = "r2-txt-1";
const DATA_ID = "r2-data-1";
const MASTER_TAG = "prov-master-v2";

const PROVENANCE = [
  {
    id: MASTER_TAG,
    category: "model",
    shortName: "母版",
    version: "v2",
    verification: "verified",
    detailSummary: "母版 v2 基线模型",
  },
  {
    id: "prov-edge-clean",
    category: "algorithm",
    shortName: "边缘清理",
    verification: "declared",
    detailSummary: "边缘清理算法（声明）",
  },
];

const GUIDANCE = {
  triageGroup: "need_verdict",
  branchName: "图片组",
  nodeSlotLabel: "真实图片",
  whatHappened: "Agent 导入了一张真实图片",
  whatToDoNext: "请核对边缘并给出反馈",
  nodButtonLabel: "点头保留",
  nodDecision: "kept",
};



/**
 * Wait until the decoded bitmap has been measured AND the stage has a real
 * display box (the component keeps a 1px img while `ready` is false, so
 * `img.complete` alone can resolve one React commit too early).
 */
async function waitForImageStage(page: LaunchedApp["page"]): Promise<void> {
  await page.getByTestId("image-stage").waitFor({ timeout: 15_000 });
  await page.waitForFunction(
    () => {
      const stage = document.querySelector<HTMLElement>("[data-testid='image-stage']");
      const img = stage?.querySelector<HTMLImageElement>("img");
      const rect = stage?.getBoundingClientRect();
      return (
        stage !== null &&
        img !== null &&
        img !== undefined &&
        img.complete &&
        img.naturalWidth > 0 &&
        rect !== undefined &&
        rect.width > 100 &&
        rect.height > 100
      );
    },
    undefined,
    { timeout: 20_000 },
  );
}

async function waitForNoHorizontalOverflow(page: LaunchedApp["page"]): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

/** Close persistent app notifications so screenshots show only the workbench. */
async function dismissNotifications(page: LaunchedApp["page"]): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dismiss = page.getByRole("button", { name: /Dismiss notification/i });
    if ((await dismiss.count()) === 0) return;
    await dismiss.first().click().catch(() => undefined);
    await page.waitForTimeout(150);
  }
}

describe("workbench round 2: prototype hierarchy with real media", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  let identity: WorkbenchIdentity;
  let evidence: EvidenceRecord;
  let videoMediaId = "";
  let markerStartPts = 0;

  beforeAll(async () => {
    launched = await launchApp();
    await createProjectViaUI(launched.page);
    await waitForEditorReady(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
    await waitForStableWorkspace(agent);
    identity = await readIdentity(agent);
    // Compare against the prototype's 1440x900 viewport (same aspect ratio;
    // the OS scale factor may still produce a larger pixel buffer).
    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    await dismissNotifications(launched.page);
    evidence = createEvidence("workbench-round2-visual", launched.page);
  }, 300_000);

  afterAll(async () => {
    evidence?.flush();
    await agent?.close();
    await launched?.close();
  });

  test("empty state keeps the four-region workspace and a real start entry", async () => {
    const page = launched.page;
    await switchToWorkbench(page, 15_000);

    // All regions stay mounted; no developer-facing "mock data" text.
    await page.getByTestId("workbench-tree-empty").waitFor({ state: "visible" });
    await page.getByTestId("workbench-start-panel").waitFor({ state: "visible" });
    await page.getByText("节点详情").first().waitFor({ state: "visible" });
    expect(await page.getByText(/这里不提供模拟数据入口/).count()).toBe(0);

    // No target ⇒ publishing / mind-map are disabled, not dead.
    expect(await page.getByRole("button", { name: /交回本轮决策/ }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: /全景血缘导图/ }).isDisabled()).toBe(true);

    await page.getByTestId("workbench-ingest-help").click();
    expect(
      await page.getByTestId("workbench-ingest-help-panel").getAttribute("open"),
    ).not.toBeNull();

    const emptyShot = await evidence.screenshot("01-empty-state");
    evidence.record("emptyScreenshot", emptyShot);
    await waitForNoHorizontalOverflow(page);
  }, 120_000);

  test("copy button sends the displayed instructions and reports clipboard rejection", async () => {
    const page = launched.page;
    const clipboardHandle = await page.evaluateHandle(() => {
      const original = navigator.clipboard.writeText;
      const calls: string[] = [];
      navigator.clipboard.writeText = async (text) => { calls.push(text); };
      return { original, calls };
    });
    try {
      await page.getByTestId("workbench-copy-ingest").click();
      await page.getByText("已复制接入说明").waitFor({ state: "visible" });
      const calls = await clipboardHandle.evaluate(state => state.calls);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toBe(await page.getByTestId("workbench-ingest-help-panel").locator("pre").textContent());
      expect(calls[0]).toContain("workbench.ingest");
      expect(calls[0]).toContain("media.import");
      expect(calls[0]).not.toMatch(/token|Bearer/i);
      await page.evaluate(() => {
        navigator.clipboard.writeText = async () => { throw new DOMException("Denied", "NotAllowedError"); };
      });
      await page.getByTestId("workbench-copy-ingest").click();
      await page.getByText("复制失败，请展开下方命令手动复制", { exact: true }).waitFor({ state: "visible" });
      expect(await page.getByText("已复制接入说明").count()).toBe(0);
      evidence.record("clipboardInternal", { payloadMatchesDisplayedInstructions: true, rejectionShown: true, adapterStub: true });
    } finally {
      await clipboardHandle.evaluate(state => { navigator.clipboard.writeText = state.original; });
      await clipboardHandle.dispose();
    }
  });

  test("copies real ingress instructions through the system clipboard", async (context) => {
    // Probe the host independently of the renderer's copy implementation.
    const available = await launched.app.evaluate(async ({ clipboard }) => {
      const previous = await clipboard.readText();
      try {
        await clipboard.writeText("reelterminal-e2e-clipboard-probe");
        return await clipboard.readText() === "reelterminal-e2e-clipboard-probe";
      } finally { await clipboard.writeText(previous); }
    });
    if (!available) {
      evidence.record("clipboardLimit", "Host Electron clipboard write/read round trip failed independently of the renderer; external paste requires manual acceptance.");
      context.skip();
    }
    const page = launched.page;
    await page.getByTestId("workbench-copy-ingest").click();
    await page.getByText("已复制接入说明").waitFor({ state: "visible", timeout: 10_000 });
    let clipboardText = "";
    await vi.waitFor(async () => {
      clipboardText = await launched.app.evaluate(({ clipboard }) => clipboard.readText());
      expect(clipboardText).toContain("workbench.ingest");
    });
    expect(clipboardText).toContain("media.import");
    expect(clipboardText).not.toMatch(/token|Bearer/i);
    await page.waitForTimeout(3400);
  });

  test("real PNG/MP4 import and Agent ingest create the four item types", async () => {
    const imagePath = createImageFixture(launched.runDir);
    const videoPath = createVideoFixture(launched.runDir);
    const image = await importMedia(agent, identity, imagePath, "r2-import-image");
    const video = await importMedia(agent, identity, videoPath, "r2-import-video");
    videoMediaId = video.mediaId;

    const ingested = await ingestBatch(
      agent,
      identity,
      BATCH_ID,
      "第二轮真实媒体验收",
      [
        {
          id: IMAGE_ID,
          title: "真实图片",
          type: "image",
          content: {
            type: "image",
            mediaId: image.mediaId,
            naturalWidth: image.metadata.width,
            naturalHeight: image.metadata.height,
          },
          provenanceTags: PROVENANCE,
          agentGuidance: GUIDANCE,
        },
        {
          id: VIDEO_ID,
          title: "真实视频",
          type: "video",
          content: {
            type: "video",
            mediaId: video.mediaId,
            durationSec: video.metadata.durationSec,
            resolution: `${video.metadata.width}x${video.metadata.height}`,
          },
          provenanceTags: PROVENANCE,
        },
        {
          id: TEXT_ID,
          title: "多行语料",
          type: "text",
          content: {
            type: "text",
            entryId: "entry-r2",
            title: "多行语料",
            speakerOrContext: "旁白",
            text: "第一段落包含重复短语。第二段落也有重复短语。\n第三行用于验证跨行编辑与 emoji 🙂。",
          },
          provenanceTags: PROVENANCE,
        },
        {
          id: DATA_ID,
          title: "清洗数据表",
          type: "data",
          content: {
            type: "data",
            datasetId: "r2-dataset",
            columns: [
              { columnId: "c-date", title: "日期" },
              { columnId: "c-note", title: "备注" },
            ],
            rows: [
              { rowId: "r1", cells: { "c-date": "2026/1/5", "c-note": "首行" } },
              { rowId: "r2", cells: { "c-date": "2026-01-06", "c-note": "次行" } },
            ],
            proposals: [
              {
                proposalId: "p1",
                rowId: "r1",
                columnId: "c-date",
                originalValue: "2026/1/5",
                proposedValue: "2026-01-05",
                reason: "日期归一",
                provenanceTagId: MASTER_TAG,
                status: "proposed",
              },
            ],
          },
          provenanceTags: PROVENANCE,
        },
      ],
      "r2-ingest-1",
    );
    expect(ingested.acceptedItemIds.sort()).toEqual(
      [IMAGE_ID, VIDEO_ID, TEXT_ID, DATA_ID].sort(),
    );

    await switchToWorkbench(launched.page, 15_000);
    for (const title of ["真实图片", "真实视频", "多行语料", "清洗数据表"]) {
      await launched.page
        .getByTestId("workbench-tree-panel")
        .getByText(title, { exact: true })
        .first()
        .waitFor({ timeout: 15_000 });
    }
    const state = await readProjectState(agent, identity);
    evidence.record("importedMedia", {
      image: { ...image.metadata, mediaId: image.mediaId },
      video: { ...video.metadata, mediaId: video.mediaId },
      projectRevision: state.revision,
    });
  }, 180_000);

  test("image viewer + issue panel are side by side and the bottom dock spans both", async () => {
    const page = launched.page;
    await selectTreeItem(page, "真实图片");
    await waitForImageStage(page);

    const contentBox = await page.getByTestId("workbench-content").boundingBox();
    const panelBox = await page.getByTestId("workbench-issue-panel").boundingBox();
    const bottomBox = await page.getByTestId("workbench-bottom-dock").boundingBox();
    expect(contentBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    expect(bottomBox).not.toBeNull();
    // Issue panel lives INSIDE the centre content column (viewer + issue).
    expect(panelBox!.x).toBeGreaterThan(contentBox!.x);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(
      contentBox!.x + contentBox!.width + 1,
    );
    // Bottom details spans the full centre width (viewer + issue panel).
    expect(bottomBox!.width).toBeGreaterThan(contentBox!.width - 40);
    // The removed page-level review column must not exist.
    expect(await page.getByTestId("workbench-review-panel").count()).toBe(0);

    const zoomShot = await evidence.screenshot("02-image-zoom-issue-panel");
    evidence.record("imageLayout", { contentBox, panelBox, bottomBox, zoomShot });

    // Grid view keeps the card-level quick decisions from the prototype.
    await page.getByRole("button", { name: /网格筛选/ }).click();
    await page.getByTestId("image-card-keep").first().waitFor({ state: "visible" });
    await page.getByTestId("image-card-discard").first().waitFor({ state: "visible" });
    const gridShot = await evidence.screenshot("03-image-grid");
    evidence.record("imageGridShot", gridShot);
    await page.getByRole("button", { name: /画板精审/ }).click();
    await waitForImageStage(page);
    await waitForNoHorizontalOverflow(page);
  }, 120_000);

  test("image issue edit: select → draft → tag reference → save (read back)", async () => {
    const page = launched.page;
    const stage = page.getByTestId("image-stage");
    const box = await stage.boundingBox();
    expect(box).not.toBeNull();
    const x1 = box!.x + box!.width * 0.28;
    const y1 = box!.y + box!.height * 0.3;
    const x2 = box!.x + box!.width * 0.55;
    const y2 = box!.y + box!.height * 0.6;
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 8 });
    await page.mouse.up();

    const panel = page.getByTestId("workbench-issue-panel");
    await panel.getByTestId("workbench-issue-card").first().waitFor({ timeout: 10_000 });
    expect(await panel.getByTestId("workbench-issue-card").count()).toBe(1);

    const textarea = panel.getByLabel("问题建议");
    const note = "边缘溢色与毛刺，请按来源标签处理";
    await textarea.fill(note);
    await panel.getByRole("button", { name: /母版/ }).click();
    expect((await textarea.inputValue()).includes("@母版")).toBe(true);
    const draftShot = await evidence.screenshot("04-image-issue-edit");
    evidence.record("imageIssueDraftShot", draftShot);

    await panel.getByTestId("workbench-issue-save").click();
    await page.getByText(/反馈已保存/).first().waitFor({ state: "visible", timeout: 15_000 });

    const state = await readProjectState(agent, identity);
    const item = state.project.workbench.items.find((candidate) => candidate.id === IMAGE_ID)!;
    const annotations = (item.content as { annotations: Array<{ id: string; label?: string }> })
      .annotations;
    expect(annotations).toHaveLength(1);
    // Clicking the provenance chip inserts an @ reference into the saved note.
    const imageSavedText = `${note} @母版`;
    expect(annotations[0].label).toBe(imageSavedText);
    const feedback = [...state.project.workbench.feedback]
      .filter((entry) => entry.itemId === IMAGE_ID)
      .reverse()[0];
    expect(feedback).toBeDefined();
    expect(feedback!.text).toBe(imageSavedText);
    expect(feedback!.state).toBe("confirmed");
    expect(feedback!.referencedTagIds).toContain(MASTER_TAG);
    expect(feedback!.target).toMatchObject({
      kind: "pixel-region",
      annotationId: annotations[0].id,
    });
    evidence.record("imageIssueFeedback", { itemVersion: item.version, feedback });
  }, 120_000);

  test("text keeps its own full-width layout and saves a revision", async () => {
    const page = launched.page;
    await selectTreeItem(page, "多行语料");
    expect(await page.getByTestId("workbench-issue-panel").count()).toBe(0);
    const textShot = await evidence.screenshot("05-text-multiline");
    evidence.record("textShot", textShot);

    await page.getByRole("button", { name: "直接改文" }).first().click();
    const editor = page.getByTestId("workbench-content").locator("textarea").first();
    await editor.fill("人工修订后的正文。\n第二行保留 emoji 🙂。");
    await page.getByRole("button", { name: /保存修改/ }).first().click();
    await page.getByText(/已修改/).first().waitFor({ state: "visible", timeout: 15_000 });

    const state = await readProjectState(agent, identity);
    const item = state.project.workbench.items.find((candidate) => candidate.id === TEXT_ID)!;
    expect(item.version).toBe(2);
    expect(item.status).toBe("modified");
  }, 120_000);

  test("data confirms exactly the selected proposal cell and keeps other rows", async () => {
    const page = launched.page;
    await selectTreeItem(page, "清洗数据表");
    expect(await page.getByTestId("workbench-issue-panel").count()).toBe(0);
    await page.getByTestId("workbench-content").getByText("2026/1/5").first().waitFor({
      timeout: 10_000,
    });
    const dataShot = await evidence.screenshot("06-data-table");
    evidence.record("dataShot", dataShot);

    await page.getByRole("button", { name: /全选待清洗建议/ }).first().click();
    await page.getByRole("button", { name: /^确认建议 \(/ }).first().click();
    await page.getByTestId("workbench-content").getByText("2026-01-05").first().waitFor({
      timeout: 15_000,
    });

    const state = await readProjectState(agent, identity);
    const item = state.project.workbench.items.find((candidate) => candidate.id === DATA_ID)!;
    const rows = (
      item.content as { rows: Array<{ rowId: string; cells: Record<string, string> }> }
    ).rows;
    expect(rows.find((row) => row.rowId === "r1")!.cells["c-date"]).toBe("2026-01-05");
    expect(rows.find((row) => row.rowId === "r2")!.cells["c-date"]).toBe("2026-01-06");
    expect(item.status).toBe("modified");
  }, 120_000);

  test("video marker saves a real PTS and the issue card seeks back to it", async () => {
    const page = launched.page;
    await selectTreeItem(page, "真实视频");
    const video = page.locator("[data-workbench-player='true'] video");
    await video.waitFor({ timeout: 20_000 });
    await page.waitForFunction(
      () => {
        const element = document.querySelector<HTMLVideoElement>(
          "[data-workbench-player='true'] video",
        );
        return (
          element !== null && element.readyState >= 2 && Number.isFinite(element.duration)
        );
      },
      undefined,
      { timeout: 30_000 },
    );
    await page.getByText(/帧索引不可用/).first().waitFor({ state: "visible" });

    // Seek to ~50% through the real 2 s fixture, then mark the frame.
    const scrubber = page.locator("[title='点击/拖动跳转播放位置']");
    const scrubBox = await scrubber.boundingBox();
    expect(scrubBox).not.toBeNull();
    await page.mouse.click(
      scrubBox!.x + scrubBox!.width * 0.5,
      scrubBox!.y + scrubBox!.height / 2,
    );
    const seekedTime = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
    expect(seekedTime).toBeGreaterThan(0.5);

    await page.getByRole("button", { name: /标问题帧/ }).click();
    const panel = page.getByTestId("workbench-issue-panel");
    await panel.getByTestId("workbench-issue-card").first().waitFor({ timeout: 10_000 });
    expect(await panel.getByTestId("workbench-issue-card").count()).toBe(1);

    const state = await readProjectState(agent, identity);
    const item = state.project.workbench.items.find((candidate) => candidate.id === VIDEO_ID)!;
    const markers = (
      item.content as {
        markers: Array<{ id: string; startPtsSec: number; startFrameIndex?: number }>;
      }
    ).markers;
    expect(markers).toHaveLength(1);
    markerStartPts = markers[0].startPtsSec;
    expect(markerStartPts).toBeGreaterThan(0.5);
    expect(markers[0].startFrameIndex).toBeUndefined();

    // Move the playhead away, then select the issue card: it must seek back.
    await page.mouse.click(
      scrubBox!.x + scrubBox!.width * 0.1,
      scrubBox!.y + scrubBox!.height / 2,
    );
    await panel.getByTestId("workbench-issue-card").first().click();
    await page.waitForFunction(
      (expected) => {
        const element = document.querySelector<HTMLVideoElement>(
          "[data-workbench-player='true'] video",
        );
        return element !== null && Math.abs(element.currentTime - expected) <= 0.05;
      },
      markerStartPts,
      { timeout: 10_000 },
    );
    const currentTime = await video.evaluate((element: HTMLVideoElement) => element.currentTime);

    // Edit the marker note, reference a tag and save through the controller.
    const textarea = panel.getByLabel("问题建议");
    const note = "该处画面撕裂，请按来源标签重修";
    await textarea.fill(note);
    await panel.getByRole("button", { name: /边缘清理/ }).click();
    const videoShot = await evidence.screenshot("07-video-issue-panel");
    await panel.getByTestId("workbench-issue-save").click();
    await page.getByText(/反馈已保存/).first().waitFor({ state: "visible", timeout: 15_000 });

    const after = await readProjectState(agent, identity);
    const videoItem = after.project.workbench.items.find(
      (candidate) => candidate.id === VIDEO_ID,
    )!;
    const savedMarker = (
      videoItem.content as { markers: Array<{ note: string; startPtsSec: number }> }
    ).markers[0];
    expect(savedMarker.note).toBe(`${note} @边缘清理`);
    const feedback = [...after.project.workbench.feedback]
      .filter((entry) => entry.itemId === VIDEO_ID)
      .reverse()[0];
    expect(feedback!.state).toBe("confirmed");
    expect(feedback!.target).toMatchObject({ kind: "video-marker", markerId: markers[0].id });
    expect(currentTime).toBeCloseTo(markerStartPts, 1);

    // Real CFR probe: only claim frame accuracy from the probed facts.
    const frameIndex = Math.round(markerStartPts * 30);
    const frames = await agent.callCommand<{
      frames: Array<{ frame: number; ptsTimeSec: number }>;
      facts: Record<string, unknown>;
    }>("frames.extract", {
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      source: { mediaId: videoMediaId },
      selection: { frames: [frameIndex] },
    });
    evidence.record("videoMarker", {
      markerStartPts,
      currentTime,
      videoShot,
      frameIndex,
      frames: frames.ok ? frames.value : frames.error,
    });
    if (frames.ok && frames.value?.frames?.[0]) {
      expect(
        Math.abs(frames.value.frames[0].ptsTimeSec - markerStartPts),
      ).toBeLessThanOrEqual(1 / 30 + 0.02);
    }
  }, 180_000);

  test("handoff preview shows the real confirmed feedback, not drafts", async () => {
    const page = launched.page;
    // Decide the image so the batch has something publishable.
    await selectTreeItem(page, "真实图片");
    await page.getByRole("button", { name: /^保留$/ }).first().click();
    await page.getByText(/已执行决定/).first().waitFor({ state: "visible", timeout: 10_000 });
    // Let the decision toast clear before opening the dialog.
    await page.waitForTimeout(3400);

    const handoffButton = page.getByRole("button", { name: /交回本轮决策/ });
    expect(await handoffButton.isEnabled()).toBe(true);
    await handoffButton.click();
    const dialog = page.getByRole("dialog");
    try {
      await dialog.getByText("交回本轮审阅结果", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
      await dialog.getByText(/边缘溢色与毛刺/).first().waitFor({ state: "visible", timeout: 10_000 });
      await dialog.getByText(/@母版/).first().waitFor({ state: "visible" });
      // Wait for the dialog's open animation to settle (screenshot evidence).
      await page.waitForTimeout(500);
      const handoffShot = await evidence.screenshot("08-handoff-preview");
      evidence.record("handoffShot", handoffShot);
    } finally {
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    }
  }, 120_000);

  test("layout: separator drag, collapse and size persistence stay inside the viewport", async () => {
    const page = launched.page;
    const panel = page.getByTestId("workbench-issue-panel");
    const before = await panel.boundingBox();
    const handle = page.getByTestId("workbench-content").locator("[role='separator']").first();
    const handleBox = await handle.boundingBox();
    expect(before).not.toBeNull();
    expect(handleBox).not.toBeNull();
    await handle.hover();
    await page.mouse.move(
      handleBox!.x + handleBox!.width / 2,
      handleBox!.y + handleBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(handleBox!.x - 70, handleBox!.y + handleBox!.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await page.waitForTimeout(200);
    let after = await panel.boundingBox();
    if (after!.width <= before!.width + 5) {
      // Second attempt with an explicit incremental pointer sequence.
      await page.mouse.move(
        handleBox!.x + handleBox!.width / 2,
        handleBox!.y + handleBox!.height / 2,
      );
      await page.waitForTimeout(100);
      await page.mouse.down();
      for (let dx = 10; dx <= 70; dx += 10) {
        await page.mouse.move(handleBox!.x - dx, handleBox!.y + handleBox!.height / 2);
        await page.waitForTimeout(20);
      }
      await page.mouse.up();
      await page.waitForTimeout(200);
      after = await panel.boundingBox();
    }
    expect(after!.width).toBeGreaterThan(before!.width + 20);

    // Drag the left queue divider wide and raise the bottom dock so all three
    // useResizable values are actually persisted (not just their defaults).
    const treeHandle = page.getByTitle("拖拽调整队列宽度");
    const treeBox = await treeHandle.boundingBox();
    expect(treeBox).not.toBeNull();
    await page.mouse.move(treeBox!.x + treeBox!.width / 2, treeBox!.y + treeBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(treeBox!.x + 50, treeBox!.y + treeBox!.height / 2, { steps: 8 });
    await page.mouse.up();

    // In Phase 4, bottom dock starts collapsed; expand it to reach the resize handle.
    await page.getByRole("button", { name: /节点详情/ }).first().click();

    const rowHandle = page.getByTitle("拖拽调整底部详情高度");
    const rowBox = await rowHandle.boundingBox();
    expect(rowBox).not.toBeNull();
    await page.mouse.move(rowBox!.x + rowBox!.width / 2, rowBox!.y + rowBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(rowBox!.x + rowBox!.width / 2, rowBox!.y - 40, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    // Left queue collapse/expand.
    await page.getByTitle("折叠侧栏").click();
    expect(await page.getByTestId("workbench-tree-panel").count()).toBe(0);
    await page.getByTitle("展开上游血缘树").click();
    await page.getByTestId("workbench-tree-panel").waitFor({ state: "visible" });

    // Bottom dock collapse/expand: collapse to verify < 60, then re-expand.
    const dock = page.getByTestId("workbench-bottom-dock");
    await page.getByRole("button", { name: /节点详情/ }).first().click();
    const collapsedHeight = (await dock.boundingBox())!.height;
    expect(collapsedHeight).toBeLessThan(60);
    await page.getByRole("button", { name: /节点详情/ }).first().click();
    const expandedHeight = (await dock.boundingBox())!.height;
    expect(expandedHeight).toBeGreaterThan(100);

    await waitForNoHorizontalOverflow(page);

    // useResizable persists on pointer-up; the relaunch leg asserts the
    // applied width survives.
    const stored = await page.evaluate(() => ({
      tree: localStorage.getItem("reelterminal-workbench-tree-w"),
      issue: localStorage.getItem("reelterminal-workbench-issue-w"),
      bottom: localStorage.getItem("reelterminal-workbench-bottom-h"),
    }));
    expect(Number(stored.issue)).toBeGreaterThan(300);
    expect(Number(stored.tree)).toBeGreaterThan(300);
    expect(Number(stored.bottom)).toBeGreaterThan(150);
    evidence.record("layout", { before, after, stored });
    evidence.flush();
  }, 180_000);
});
