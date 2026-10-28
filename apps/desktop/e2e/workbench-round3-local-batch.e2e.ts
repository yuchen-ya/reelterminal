import { switchToWorkbench } from "./harness/workbench-fixtures";
/**
 * Round 3 batch B: create a workbench batch from project media without an
 * Agent. Media enters the project through the real GUI file picker; the batch
 * is created from the new local dialog and read back through project state.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
  readIdentity,
  readProjectState,
  waitForStableWorkspace,
  type WorkbenchIdentity,
} from "./harness/workbench-fixtures";


describe("workbench round 3 batch B: local media batch", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  let identity: WorkbenchIdentity;
  let evidence: EvidenceRecord;

  beforeAll(async () => {
    launched = await launchApp();
    await createProjectViaUI(launched.page);
    await waitForEditorReady(launched.page);
    await launched.page.getByRole("button", { name: "Project assets", exact: true }).click();
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
    await waitForStableWorkspace(agent);
    identity = await readIdentity(agent);
    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    evidence = createEvidence("workbench-round3-local-batch", launched.page);
  }, 300_000);

  afterAll(async () => {
    evidence?.flush();
    await agent?.close();
    await launched?.close();
  });

  test("GUI imports a real PNG/MP4 and the local dialog creates a batch", async () => {
    const page = launched.page;
    const imagePath = createImageFixture(launched.runDir, "local-batch.png");
    const videoPath = createVideoFixture(launched.runDir, "local-batch.mp4");

    await page
      .locator('input[type="file"][aria-label="Import media"]')
      .setInputFiles([imagePath, videoPath]);

    let state = await readProjectState(agent, identity);
    const deadline = Date.now() + 30_000;
    while (
      Date.now() < deadline &&
      !(
        state.project.mediaLibrary.items.some((item) => item.name === "local-batch.png") &&
        state.project.mediaLibrary.items.some((item) => item.name === "local-batch.mp4")
      )
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      state = await readProjectState(agent, identity);
    }
    expect(
      state.project.mediaLibrary.items.filter((item) =>
        ["local-batch.png", "local-batch.mp4"].includes(item.name),
      ),
    ).toHaveLength(2);

    await switchToWorkbench(page);
    const createButton = page.getByTestId("workbench-create-batch");
    await createButton.waitFor({ timeout: 15_000 });
    await createButton.click();

    const dialog = page.getByTestId("create-workbench-batch-dialog");
    await dialog.waitFor({ timeout: 10_000 });
    const cards = dialog.getByTestId("create-batch-media-card");
    await cards.first().waitFor({ timeout: 10_000 });
    expect(await cards.count()).toBe(2);
    await dialog.getByTestId("create-batch-name").fill("本地素材批 E2E");
    await cards.nth(0).click();
    await cards.nth(1).click();
    await dialog.getByTestId("create-batch-submit").click();
    await dialog.waitFor({ state: "detached", timeout: 20_000 });

    state = await readProjectState(agent, identity);
    const batch = state.project.workbench.batches.find((candidate) => candidate.name === "本地素材批 E2E");
    expect(batch).toBeDefined();
    const items = state.project.workbench.items.filter((item) => item.batchId === batch!.id);
    expect(items).toHaveLength(2);
    const image = items.find((item) => item.type === "image")!;
    const video = items.find((item) => item.type === "video")!;
    expect(image.id).toMatch(/^wb-item-/);
    expect(video.id).toMatch(/^wb-item-/);
    expect(image.content).toMatchObject({ type: "image", mediaId: expect.any(String) });
    expect(video.content).toMatchObject({ type: "video", mediaId: expect.any(String) });
    expect((image.content as { naturalWidth?: number }).naturalWidth).toBe(1024);
    expect((video.content as { durationSec?: number }).durationSec).toBeGreaterThan(0);
    expect(image.provenanceTags.map((tag) => tag.id)).toContain(`prov-media-${ (image.content as { mediaId: string }).mediaId }`);
    expect(image.provenanceTags.some((tag) => tag.category === "batch")).toBe(true);

    await page.getByTestId("workbench-tree-panel").getByText(image.title, { exact: true }).waitFor({
      timeout: 15_000,
    });
    await page.waitForTimeout(3_400);
    const shot = await evidence.screenshot("01-local-batch-created");
    evidence.record("firstBatch", { batch, image, video, shot });
  }, 180_000);

  test("a second batch shows pending vs processed media separately and can reuse media", async () => {
    const page = launched.page;
    const state = await readProjectState(agent, identity);
    const firstBatch = state.project.workbench.batches.find(
      (candidate) => candidate.name === "本地素材批 E2E",
    )!;
    const imageItem = state.project.workbench.items.find(
      (item) => item.batchId === firstBatch.id && item.type === "image",
    )!;

    // Process the image through the real GUI decision path.
    await page
      .getByTestId("workbench-tree-panel")
      .getByText(imageItem.title, { exact: true })
      .first()
      .click();
    await page.getByTestId("workbench-bottom-dock").getByRole("button", { name: "保留", exact: true }).click();
    await page.getByTitle(/已处理 1 \/ 2/).waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForTimeout(3_400);

    await page.getByTestId("workbench-new-batch").click();
    const dialog = page.getByTestId("create-workbench-batch-dialog");
    await dialog.waitFor({ timeout: 10_000 });
    const cards = dialog.getByTestId("create-batch-media-card");
    await cards.first().waitFor({ timeout: 10_000 });

    const processed = dialog.getByText("已审阅", { exact: true });
    const pending = dialog.getByText("已在工作台 · 待处理", { exact: true });
    await processed.waitFor({ timeout: 10_000 });
    await pending.waitFor({ timeout: 10_000 });
    await dialog.getByTestId("create-batch-name").fill("本地素材批 E2E 第二轮");
    await cards.nth(0).click();
    await cards.nth(1).click();
    await page.waitForTimeout(400);
    const shot = await evidence.screenshot("02-pending-vs-processed");
    await dialog.getByTestId("create-batch-submit").click();
    await dialog.waitFor({ state: "detached", timeout: 20_000 });

    const after = await readProjectState(agent, identity);
    const second = after.project.workbench.batches.find(
      (candidate) => candidate.name === "本地素材批 E2E 第二轮",
    );
    expect(second).toBeDefined();
    expect(second!.id).not.toBe(firstBatch.id);
    expect(
      after.project.workbench.items.filter((item) => item.batchId === second!.id),
    ).toHaveLength(2);
    // The first batch and its decisions are untouched.
    expect(after.project.workbench.batches.some((batch) => batch.id === firstBatch.id)).toBe(true);
    expect(
      after.project.workbench.items.find((item) => item.id === imageItem.id)?.status,
    ).toBe("kept");

    evidence.record("secondBatch", {
      firstBatchId: firstBatch.id,
      secondBatchId: second!.id,
      shot,
    });
    evidence.flush();
  }, 180_000);
});
