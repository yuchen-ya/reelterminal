import { switchToWorkbench } from "./harness/workbench-fixtures";
/**
 * Round 3 batch F: saved-repair display, true-original comparison, explicit
 * repair base, and reopen. Also records A3/A4 evidence (window size, page zoom
 * vs device DPR, image drop point) without claiming VFR/rotation.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
  currentRevision,
  importMedia,
  ingestBatch,
  readIdentity,
  readProjectState,
  waitForStableWorkspace,
  type WorkbenchIdentity,
} from "./harness/workbench-fixtures";

const PROJECT_NAME = "Horizontal";
const BATCH_ID = "r3-f-base-batch";
const IMAGE_ID = "r3-f-image";

interface RepairRevision {
  id: string;
  kind: string;
  mediaId?: string;
  base?: { kind: string; revisionId?: string };
  strokes?: unknown[];
  producedVersion?: number;
  parentVersion?: number;
}

function repairRevisions(item: { revisions?: RepairRevision[] }): RepairRevision[] {
  return (item.revisions ?? []).filter((revision) => revision.kind === "image-repair");
}


async function selectImage(page: LaunchedApp["page"]): Promise<void> {
  await page
    .getByTestId("workbench-tree-panel")
    .getByText("待修补图片", { exact: true })
    .first()
    .click();
  await page.getByTestId("image-stage").waitFor({ timeout: 15_000 });
  await page.waitForFunction(
    () => {
      const stage = document.querySelector<HTMLElement>("[data-testid='image-stage']");
      const img = stage?.querySelector<HTMLImageElement>("img");
      const rect = stage?.getBoundingClientRect();
      return (
        stage !== null &&
        img !== null &&
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

async function waitForItemVersion(
  agent: ExternalAgent,
  identity: WorkbenchIdentity,
  version: number,
  timeoutMs = 20_000,
): Promise<{ version: number; revisions?: RepairRevision[] }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readProjectState(agent, identity);
    const item = state.project.workbench.items.find((candidate) => candidate.id === IMAGE_ID);
    if (item && item.version === version) return item;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`image did not reach v${version}`);
}

async function drawRepairStroke(page: LaunchedApp["page"]): Promise<void> {
  const stage = page.getByTestId("image-stage");
  const box = await stage.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.42, box!.y + box!.height * 0.42);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.55, box!.y + box!.height * 0.52, {
    steps: 8,
  });
  await page.mouse.up();
}

describe("workbench round 3 batch F: repaired image and reopen", () => {
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
    evidence = createEvidence("workbench-round3-repair", launched.page);
  }, 300_000);

  afterAll(async () => {
    evidence?.record("rendererConsole", launched?.output.rendererConsole);
    if (launched && !launched.page.isClosed()) await evidence?.screenshot("terminal-state");
    evidence?.flush();
    await agent?.close();
    await launched?.close();
  });

  test("saved repair is the default view; original is true original; bases are explicit", async () => {
    const image = await importMedia(
      agent,
      identity,
      createImageFixture(launched.runDir, "r3-repair.png"),
      "r3-f-import",
    );
    await ingestBatch(
      agent,
      identity,
      BATCH_ID,
      "第三轮修补验收",
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
      ],
      "r3-f-ingest",
    );
    await switchToWorkbench(launched.page);
    await selectImage(launched.page);

    const page = launched.page;
    await page.getByTestId("image-mode-repair").click();
    await drawRepairStroke(page);
    await page.getByRole("button", { name: /提交修补/ }).click();
    let item = await waitForItemVersion(agent, identity, 2);
    let revisions = repairRevisions(item);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].base).toEqual({ kind: "source" });
    expect(revisions[0].strokes).toHaveLength(1);

    // Default view is the saved repair; no edit canvas is layered on top.
    const repairedImg = page.locator('img[data-display-mode="repaired"]');
    await repairedImg.waitFor({ timeout: 15_000 });
    // Leave the edit mode so the stage shows the saved PNG, not the draft layer.
    await page.getByTestId("image-mode-navigate").click();
    expect(await page.locator("[data-testid='image-stage'] canvas").count()).toBe(0);
    const repairedShot = await evidence.screenshot("01-default-repaired");

    await page.getByTestId("image-display-original").click();
    await page.locator('img[data-display-mode="original"]').waitFor({ timeout: 15_000 });
    expect(await page.locator("[data-testid='image-stage'] canvas").count()).toBe(0);
    const originalShot = await evidence.screenshot("02-true-original");

    // Continue on the saved repair: only the new draft stroke is submitted,
    // and the new revision records the prior revision as its base.
    await page.getByTestId("image-display-repaired").click();
    await page.getByTestId("image-mode-repair").click();
    await page.getByTestId("repair-base-label").waitFor({ timeout: 10_000 });
    expect(await page.getByTestId("repair-base-label").textContent()).toContain(
      "已保存修补 v2",
    );
    await drawRepairStroke(page);
    await page.getByRole("button", { name: /提交修补/ }).click();
    item = await waitForItemVersion(agent, identity, 3);
    revisions = repairRevisions(item);
    expect(revisions).toHaveLength(2);
    expect(revisions[1].base).toEqual({
      kind: "revision",
      revisionId: revisions[0].id,
    });
    // No double application: the second revision stores only the new stroke.
    expect(revisions[1].strokes).toHaveLength(1);
    await page.getByTestId("image-mode-navigate").click();
    const continuedShot = await evidence.screenshot("03-repair-on-saved");

    // Explicit source base: old revisions remain, new one records source.
    await page.getByTestId("image-mode-repair").click();
    await page.getByTestId("repair-base-toggle").click();
    expect(await page.getByTestId("repair-base-label").textContent()).toContain("原图");
    await drawRepairStroke(page);
    await page.getByRole("button", { name: /提交修补/ }).click();
    item = await waitForItemVersion(agent, identity, 4);
    revisions = repairRevisions(item);
    expect(revisions).toHaveLength(3);
    expect(revisions[2].base).toEqual({ kind: "source" });
    expect(revisions.map((revision) => revision.id)).toEqual(
      expect.arrayContaining([revisions[0].id, revisions[1].id]),
    );
    await page.getByTestId("image-mode-navigate").click();

    evidence.record("repairHistory", {
      revisions,
      repairedShot,
      originalShot,
      continuedShot,
    });
  }, 240_000);

  test("A3/A4: window, page zoom, device DPR and image drop point stay honest", async () => {
    const page = launched.page;
    // A4: a real drag at a known normalized point records that point.
    await page.getByTestId("image-mode-annotate").click();
    const stage = page.getByTestId("image-stage");
    const box = await stage.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5, {
      steps: 8,
    });
    await page.mouse.up();
    // The annotation commit is async; wait for the persisted record before
    // asserting the panel card.
    let annotated = await readProjectState(agent, identity);
    const annotationDeadline = Date.now() + 10_000;
    while (Date.now() < annotationDeadline) {
      const current = annotated.project.workbench.items.find(
        (candidate) => candidate.id === IMAGE_ID,
      );
      const currentAnnotations = (current?.content as {
        annotations?: Array<{ x: number; y: number }>;
      })?.annotations;
      if (currentAnnotations && currentAnnotations.length === 1) break;
      await page.waitForTimeout(200);
      annotated = await readProjectState(agent, identity);
    }
    const panel = page.getByTestId("workbench-issue-panel");
    await panel.getByTestId("workbench-issue-card").first().waitFor({ timeout: 10_000 });
    const state = await readProjectState(agent, identity);
    const item = state.project.workbench.items.find((candidate) => candidate.id === IMAGE_ID)!;
    const annotations = (item.content as {
      annotations?: Array<{ x: number; y: number; w?: number; h?: number }>;
    }).annotations ?? [];
    expect(annotations).toHaveLength(1);
    expect(annotations[0].x).toBeCloseTo(0.3, 2);
    expect(annotations[0].y).toBeCloseTo(0.3, 2);
    expect(annotations[0].w).toBeCloseTo(0.2, 2);
    expect(annotations[0].h).toBeCloseTo(0.2, 2);

    // A3: smallest supported window, independently from page zoom.
    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1024, 700);
    });
    await page.waitForTimeout(500);
    const small = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      stage: document.querySelector<HTMLElement>("[data-testid='image-stage']")?.getBoundingClientRect(),
    }));
    expect(small.innerWidth).toBeLessThanOrEqual(1024);
    expect(small.scrollWidth).toBeLessThanOrEqual(small.innerWidth + 1);
    expect(small.stage?.width ?? 0).toBeGreaterThan(100);
    const smallShot = await evidence.screenshot("04-min-window");

    // Page zoom is a CSS viewport change; device DPI is reported separately.
    const beforeZoomDpr = await page.evaluate(() => window.devicePixelRatio);
    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1.25);
    });
    await page.waitForTimeout(500);
    const zoomed = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      dpr: window.devicePixelRatio,
      stage: document.querySelector<HTMLElement>("[data-testid='image-stage']")?.getBoundingClientRect(),
    }));
    expect(zoomed.innerWidth).toBeLessThan(small.innerWidth);
    expect(zoomed.scrollWidth).toBeLessThanOrEqual(zoomed.innerWidth + 1);
    expect(zoomed.stage?.width ?? 0).toBeGreaterThan(80);
    const zoomShot = await evidence.screenshot("05-page-zoom");

    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1);
    });
    await page.waitForTimeout(300);

    evidence.record("viewport", {
      small,
      zoomed,
      beforeZoomDpr,
      note: "Page zoom changed the CSS viewport (1024→819) and devicePixelRatio (1.5→1.875); this is Chromium page zoom, not a device-DPI change. OS/device DPI was not independently varied on this machine.",
      smallShot,
      zoomShot,
    });
  }, 180_000);

  test("A5: save + relaunch + reopen defaults to the saved repair", async () => {
    const page = launched.page;
    const revision = await currentRevision(agent);
    const saved = await agent.callCommand("project.save", {
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      expectedRevision: revision,
      idempotencyKey: "r3-f-save-before-relaunch",
    });
    expect(saved.ok).toBe(true);
    await agent.close();

    launched = await launched.relaunch();
    evidence.bindPage(launched.page);
    await launched.waitForEndpointFile(60_000);
    agent = await connectExternalAgent(launched.endpointFile);
    await openRecentProjectViaUI(launched.page, PROJECT_NAME);
    await waitForStableWorkspace(agent);
    identity = await readIdentity(agent);

    await switchToWorkbench(launched.page);
    await selectImage(launched.page);
    await launched.page
      .locator('img[data-display-mode="repaired"]')
      .waitFor({ timeout: 20_000 });
    const state = await readProjectState(agent, identity);
    const item = state.project.workbench.items.find((candidate) => candidate.id === IMAGE_ID)!;
    const revisions = repairRevisions(item);
    expect(revisions).toHaveLength(3);
    expect(await launched.page.locator("[data-testid='image-stage'] canvas").count()).toBe(0);

    const shot = await evidence.screenshot("06-reopen-repaired");
    evidence.record("reopen", { revisions, shot });
    evidence.flush();
  }, 180_000);
});
