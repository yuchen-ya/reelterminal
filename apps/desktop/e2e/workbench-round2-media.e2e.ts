import { switchToWorkbench, selectTreeItem } from "./harness/workbench-fixtures";
/**
 * Round-2 real-media closure: image repair derivative + video marker time,
 * then save → relaunch → reopen. Isolated profile, real files only.
 *
 * Honest limits are asserted, not hidden:
 * - the repaired PNG is an app-managed media-library asset (derived media),
 *   read back from `project.get_state` and the filesystem;
 * - markers store `video.currentTime` seconds and never invent a frame index;
 *   CFR/VFR is only reported from a real `frames.extract` probe.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/cli-client";
import {
  createProjectViaUI,
  enableAgentSessionViaUI,
  openRecentProjectViaUI,
  waitForEditorReady,
} from "./harness/ui";
import { createEvidence, type EvidenceRecord } from "./harness/evidence";
import {
  createImageFixture,
  createVideoFixture,
  currentRevision,
  importMedia,
  ingestBatch,
  readIdentity,
  readProjectState,
  waitForStableWorkspace,
  type WorkbenchIdentity,
} from "./harness/workbench-fixtures";

const BATCH_ID = "r2-media-batch";
const IMAGE_ID = "r2-media-img";
const VIDEO_ID = "r2-media-vid";
const PROJECT_NAME = "Horizontal";



/** The component keeps a 1px img until `ready`; wait for the real stage. */
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

describe("workbench round 2: real media repair and marker persistence", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  let identity: WorkbenchIdentity;
  let evidence: EvidenceRecord;
  let derivativeMediaId = "";
  let derivativePath = "";
  let markerStartPts = 0;
  let markerNote = "";
  let persistedIssueWidth = 0;

  beforeAll(async () => {
    launched = await launchApp();
    await createProjectViaUI(launched.page);
    await waitForEditorReady(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
    await waitForStableWorkspace(agent);
    identity = await readIdentity(agent);
    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    evidence = createEvidence("workbench-round2-media", launched.page);
  }, 300_000);

  afterAll(async () => {
    evidence?.flush();
    await agent?.close().catch(() => undefined);
    await launched?.close();
  });

  test("import real PNG/MP4 and ingest the media batch", async () => {
    const image = await importMedia(
      agent,
      identity,
      createImageFixture(launched.runDir, "r2-media-image.png"),
      "r2-media-import-image",
    );
    const video = await importMedia(
      agent,
      identity,
      createVideoFixture(launched.runDir, "r2-media-video.mp4"),
      "r2-media-import-video",
    );
    const ingested = await ingestBatch(
      agent,
      identity,
      BATCH_ID,
      "第二轮真实媒体闭环",
      [
        {
          id: IMAGE_ID,
          title: "待修补图片",
          type: "image",
          content: {
            type: "image",
            mediaId: image.mediaId,
            naturalWidth: image.metadata.width,
            naturalHeight: image.metadata.height,
          },
        },
        {
          id: VIDEO_ID,
          title: "待标记视频",
          type: "video",
          content: {
            type: "video",
            mediaId: video.mediaId,
            durationSec: video.metadata.durationSec,
            resolution: `${video.metadata.width}x${video.metadata.height}`,
          },
        },
      ],
      "r2-media-ingest",
    );
    expect(ingested.acceptedItemIds.sort()).toEqual([IMAGE_ID, VIDEO_ID].sort());
    await switchToWorkbench(launched.page);
    await launched.page
      .getByTestId("workbench-tree-panel")
      .getByText("待修补图片", { exact: true })
      .first()
      .waitFor({ timeout: 15_000 });
    evidence.record("fixtures", { image: image.metadata, video: video.metadata });
  }, 180_000);

  test("image repair saves a reopenable derivative media file", async () => {
    const page = launched.page;
    await selectTreeItem(page, "待修补图片");
    await waitForImageStage(page);

    await page.getByRole("button", { name: /画笔修补/ }).click();
    const stage = page.getByTestId("image-stage");
    const box = await stage.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width * 0.4, box!.y + box!.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5, {
      steps: 10,
    });
    await page.mouse.up();
    await page.getByRole("button", { name: /保存修补/ }).click();
    await page.getByText(/修改|已修改/).first().waitFor({ state: "visible", timeout: 30_000 });

    await expect.poll(async () => {
      const current = await readProjectState(agent, identity);
      return current.project.workbench.items.find((candidate) => candidate.id === IMAGE_ID)?.version;
    }, { timeout: 15_000 }).toBe(2);
    const state = await readProjectState(agent, identity);
    const item = state.project.workbench.items.find((candidate) => candidate.id === IMAGE_ID)!;
    expect(item.version).toBe(2);
    expect(item.status).toBe("modified");
    const revision = (item.revisions ?? []).find((entry) => entry.kind === "image-repair");
    expect(revision?.mediaId).toBeTruthy();
    derivativeMediaId = revision!.mediaId!;

    const mediaItem = state.project.mediaLibrary.items.find(
      (candidate) => candidate.id === derivativeMediaId,
    );
    expect(mediaItem).toBeDefined();
    expect(mediaItem!.name).toMatch(/^wb-repair-/);
    expect(mediaItem!.contentUrl).toBeTruthy();
    derivativePath = mediaItem!.contentUrl!;
    expect(existsSync(derivativePath)).toBe(true);
    const png = readFileSync(derivativePath);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);

    const shot = await evidence.screenshot("01-image-repair-saved");
    evidence.record("imageRepair", {
      itemVersion: item.version,
      status: item.status,
      revision,
      derivedMediaId: derivativeMediaId,
      derivativePath,
      derivativeSize: png.length,
      width,
      height,
      shot,
    });
  }, 180_000);

  test("video marker stores currentTime seconds and seeks back to it", async () => {
    const page = launched.page;
    await selectTreeItem(page, "待标记视频");
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
    const scrubber = page.locator("[title='点击/拖动跳转播放位置']");
    const scrubBox = await scrubber.boundingBox();
    expect(scrubBox).not.toBeNull();
    await page.mouse.click(
      scrubBox!.x + scrubBox!.width * 0.45,
      scrubBox!.y + scrubBox!.height / 2,
    );
    await page.getByRole("button", { name: /标问题帧/ }).click();

    const panel = page.getByTestId("workbench-issue-panel");
    await panel.getByTestId("workbench-issue-card").first().waitFor({ timeout: 10_000 });
    expect(await panel.getByTestId("workbench-issue-card").count()).toBe(1);
    markerNote = "真实视频问题帧：请重算该处 Alpha";
    await panel.getByLabel("问题建议").fill(markerNote);
    await panel.getByTestId("workbench-issue-save").click();
    await page.getByText(/反馈已保存/).first().waitFor({ state: "visible", timeout: 15_000 });

    const state = await readProjectState(agent, identity);
    const item = state.project.workbench.items.find((candidate) => candidate.id === VIDEO_ID)!;
    const markers = (
      item.content as {
        markers: Array<{
          id: string;
          note: string;
          startPtsSec: number;
          startFrameIndex?: number;
        }>;
      }
    ).markers;
    expect(markers).toHaveLength(1);
    expect(markers[0].note).toBe(markerNote);
    expect(markers[0].startFrameIndex).toBeUndefined();
    markerStartPts = markers[0].startPtsSec;

    await page.mouse.click(
      scrubBox!.x + scrubBox!.width * 0.08,
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
    evidence.record("videoMarker", {
      markerStartPts,
      note: markerNote,
      itemVersion: item.version,
    });
  }, 180_000);

  test("publish exposes the derivative in the immutable handoff snapshot", async () => {
    const page = launched.page;
    // Drag the issue separator and record the persisted width; the reopen leg
    // must restore this value (useResizable localStorage).
    const panel = page.getByTestId("workbench-issue-panel");
    const handle = page.getByTestId("workbench-content").locator("[role='separator']").first();
    const handleBox = await handle.boundingBox();
    const before = await panel.boundingBox();
    expect(handleBox).not.toBeNull();
    expect(before).not.toBeNull();
    await handle.hover();
    await page.mouse.move(
      handleBox!.x + handleBox!.width / 2,
      handleBox!.y + handleBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(handleBox!.x - 60, handleBox!.y + handleBox!.height / 2, {
      steps: 10,
    });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const resizedWidth = (await panel.boundingBox())!.width;
    persistedIssueWidth = resizedWidth;
    expect(resizedWidth).toBeGreaterThan(before!.width + 20);

    await page.getByRole("button", { name: /发布审阅结果/ }).click();
    const publish = page
      .getByRole("button", { name: /发布交接结果|更新交接结果/ });
    await publish.waitFor({ timeout: 10_000 });
    await publish.click();
    await page.getByText(/等待 Agent 读取/).first().waitFor({ state: "visible", timeout: 15_000 });
    await page.keyboard.press("Escape");

    const changes = await agent.callCommand<{
      handoffEvents: Array<{ handoffId: string; deliveryState: string }>;
    }>("workbench.changes", { batchId: BATCH_ID });
    expect(changes.ok).toBe(true);
    const handoffId = changes.value!.handoffEvents[0].handoffId;
    const snapshot = await agent.callCommand<{
      handoff: { items: Array<{ itemId: string; derivedMediaId?: string; decision: string }> };
    }>("workbench.handoff.get", { handoffId });
    expect(snapshot.ok).toBe(true);
    const repaired = snapshot.value!.handoff.items.find((item) => item.itemId === IMAGE_ID);
    expect(repaired?.decision).toBe("modified");
    expect(repaired?.derivedMediaId).toBe(derivativeMediaId);
    evidence.record("handoff", { handoffId, repaired });
  }, 120_000);

  test("save + relaunch + reopen preserves the derivative and the marker", async () => {
    const revision = await currentRevision(agent);
    const saved = await agent.callCommand("project.save", {
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      expectedRevision: revision,
      idempotencyKey: "r2-media-save-before-relaunch",
    });
    expect(saved.ok).toBe(true);
    await agent.close();

    launched = await launched.relaunch();
    evidence.bindPage(launched.page);
    await launched.waitForEndpointFile(60_000);
    agent = await connectExternalAgent(launched.endpointFile);
    // The relaunch lands on the project library: open the saved project first,
    // then bind the agent identity to it.
    await openRecentProjectViaUI(launched.page, PROJECT_NAME);
    await waitForStableWorkspace(agent);
    identity = await readIdentity(agent);

    // The derived PNG is an ordinary project asset and the file still exists.
    await launched.page.getByRole("button", { name: "Project assets", exact: true }).click();
    await launched.page
      .locator(`[data-live-media-id="${derivativeMediaId}"]`)
      .waitFor({ timeout: 30_000 });
    expect(existsSync(derivativePath)).toBe(true);

    await switchToWorkbench(launched.page);
    await launched.page
      .getByTestId("workbench-tree-panel")
      .getByText("待修补图片", { exact: true })
      .first()
      .waitFor({ timeout: 20_000 });
    await selectTreeItem(launched.page, "待修补图片");
    await launched.page
      .getByText(/已修改/)
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    const reopenIssuePanel = launched.page.getByTitle("展开问题面板", { exact: true });
    if (await reopenIssuePanel.isVisible()) await reopenIssuePanel.click();
    const reopenedPanelWidth = (await launched.page
      .getByTestId("workbench-issue-panel")
      .boundingBox())!.width;
    expect(Math.abs(reopenedPanelWidth - persistedIssueWidth)).toBeLessThanOrEqual(2);

    // Marker survives and still seeks the real video back to its saved time.
    await selectTreeItem(launched.page, "待标记视频");
    const video = launched.page.locator("[data-workbench-player='true'] video");
    await video.waitFor({ timeout: 20_000 });
    await launched.page.waitForFunction(
      () => {
        const element = document.querySelector<HTMLVideoElement>(
          "[data-workbench-player='true'] video",
        );
        return element !== null && element.readyState >= 2;
      },
      undefined,
      { timeout: 30_000 },
    );
    const panel = launched.page.getByTestId("workbench-issue-panel");
    await panel.getByTestId("workbench-issue-card").first().waitFor({ timeout: 15_000 });
    expect(await panel.getByTestId("workbench-issue-card").count()).toBe(1);
    await panel.getByTestId("workbench-issue-card").first().click();
    await launched.page.waitForFunction(
      (expected) => {
        const element = document.querySelector<HTMLVideoElement>(
          "[data-workbench-player='true'] video",
        );
        return element !== null && Math.abs(element.currentTime - expected) <= 0.08;
      },
      markerStartPts,
      { timeout: 15_000 },
    );

    const reopened = await readProjectState(agent, identity);
    const imageItem = reopened.project.workbench.items.find(
      (candidate) => candidate.id === IMAGE_ID,
    )!;
    const videoItem = reopened.project.workbench.items.find(
      (candidate) => candidate.id === VIDEO_ID,
    )!;
    expect(imageItem.version).toBe(2);
    expect(
      (imageItem.revisions ?? []).some(
        (entry) => entry.kind === "image-repair" && entry.mediaId === derivativeMediaId,
      ),
    ).toBe(true);
    expect(
      (videoItem.content as { markers: Array<{ note: string; startPtsSec: number }> })
        .markers[0],
    ).toMatchObject({ note: markerNote, startPtsSec: markerStartPts });

    const shot = await evidence.screenshot("02-reopened-media");
    evidence.record("reopened", {
      imageVersion: imageItem.version,
      videoMarker: markerStartPts,
      derivativeExists: existsSync(derivativePath),
      persistedIssueWidth,
      reopenedPanelWidth,
      shot,
    });
    evidence.flush();
  }, 300_000);

  test("adding a video marker republishes execution content without changing the old snapshot", async () => {
    const page = launched.page;
    await page.getByRole("button", { name: "返工", exact: true }).click();
    const reworkDialog = page.getByRole("dialog");
    if (await reworkDialog.isVisible()) {
      await reworkDialog.getByLabel(/共同修改要求/).fill("保留问题标记并提交修订结果");
      await reworkDialog.getByRole("button", { name: "确认返工", exact: true }).click();
    }
    const publish = async () => {
      await page.getByRole("button", { name: /发布审阅结果/ }).click();
      await page.getByRole("button", { name: /发布交接结果|更新交接结果/ }).click();
      await page.getByRole("button", { name: "关闭窗口" }).click();
      const result = await agent.callCommand<{ handoffEvents: Array<{ handoffId: string }> }>("workbench.changes", { batchId: BATCH_ID });
      expect(result.ok).toBe(true);
      return result.value!.handoffEvents[0].handoffId;
    };
    type Snapshot = { handoff: { items: Array<{ itemId: string; videoMarkers?: unknown[] }> } };
    const firstId = await publish();
    const first = await agent.callCommand<Snapshot>("workbench.handoff.get", { handoffId: firstId });
    expect(first.value!.handoff.items.find((item) => item.itemId === VIDEO_ID)?.videoMarkers).toHaveLength(1);
    await selectTreeItem(page, "待标记视频");
    const scrub = await page.locator("[title='点击/拖动跳转播放位置']").boundingBox();
    expect(scrub).not.toBeNull();
    await page.mouse.click(scrub!.x + scrub!.width * 0.7, scrub!.y + scrub!.height / 2);
    await page.getByRole("button", { name: /标问题帧/ }).click();
    await expect.poll(async () => {
      const state = await readProjectState(agent, identity);
      return (state.project.workbench.items.find((item) => item.id === VIDEO_ID)!.content as { markers: unknown[] }).markers.length;
    }).toBe(2);
    const secondId = await publish();
    expect(secondId).not.toBe(firstId);
    const second = await agent.callCommand<Snapshot>("workbench.handoff.get", { handoffId: secondId });
    expect(second.value!.handoff.items.find((item) => item.itemId === VIDEO_ID)?.videoMarkers).toHaveLength(2);
    const old = await agent.callCommand<Snapshot>("workbench.handoff.get", { handoffId: firstId });
    expect(old.value!.handoff.items).toEqual(first.value!.handoff.items);
    expect(await publish()).toBe(secondId);
    evidence.record("markerRepublish", { firstId, secondId, first: first.value, second: second.value });
    evidence.flush();
  }, 120_000);
});
