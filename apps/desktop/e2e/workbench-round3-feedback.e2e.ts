import { switchToWorkbench, selectTreeItem } from "./harness/workbench-fixtures";
/**
 * Batch C acceptance: feedback reliability.
 *
 * Verifies the real GUI/controller/store path for:
 * - geometry edits not creating implicit feedback;
 * - per-issue save/upsert (same version+target keeps one record);
 * - one undo/redo covering annotation + feedback + rework decision;
 * - text range offsets on the SECOND repeated phrase, tag ids, and version
 *   retention after a text revision;
 * - unresolved tag references being preserved and surfaced, not filtered.
 *
 * The atomic "feedback validation fails → no partial annotations/decision"
 * case is covered at the slice level (workbench-slice.test.ts), where a batch
 * with an invalid feedback action is submitted directly.
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
  applyOp,
  createImageFixture,
  importMedia,
  ingestBatch,
  readIdentity,
  readProjectState,
  waitForStableWorkspace,
  type WorkbenchIdentity,
} from "./harness/workbench-fixtures";

const BATCH_ID = "r3-feedback-batch";
const IMAGE_ID = "r3-img-1";
const TEXT_ID = "r3-txt-1";
const MASTER_TAG = "prov-master-v2";
const EDGE_TAG = "prov-edge-clean";

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
    id: EDGE_TAG,
    category: "algorithm",
    shortName: "边缘清理",
    verification: "declared",
    detailSummary: "边缘清理算法",
  },
];



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

async function waitForItem(
  agent: ExternalAgent,
  identity: WorkbenchIdentity,
  itemId: string,
  predicate: (item: { status: string; version: number; content: Record<string, unknown> }) => boolean,
  timeoutMs = 10_000,
): Promise<{ status: string; version: number; content: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readProjectState(agent, identity);
    const item = state.project.workbench.items.find((candidate) => candidate.id === itemId);
    if (item && predicate(item)) return item;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`item ${itemId} did not reach the expected state`);
}

function imageAnnotations(item: { content: Record<string, unknown> }): Array<{
  id: string;
  label?: string;
}> {
  return (item.content as { annotations?: Array<{ id: string; label?: string }> })
    .annotations ?? [];
}

function feedbackFor(
  state: Awaited<ReturnType<typeof readProjectState>>,
  itemId: string,
): Array<{
  id: string;
  text: string;
  itemVersion: number;
  referencedTagIds: string[];
  target?: Record<string, unknown>;
}> {
  return state.project.workbench.feedback.filter((record) => record.itemId === itemId);
}

describe("workbench round 3 batch C: feedback reliability", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  let identity: WorkbenchIdentity;
  let evidence: EvidenceRecord;

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
    evidence = createEvidence("workbench-round3-feedback", launched.page);
  }, 300_000);

  afterAll(async () => {
    evidence?.flush();
    await agent?.close();
    await launched?.close();
  });

  test("real image/text batch is ingested", async () => {
    const image = await importMedia(
      agent,
      identity,
      createImageFixture(launched.runDir, "r3-image.png"),
      "r3-import-image",
    );
    const ingested = await ingestBatch(
      agent,
      identity,
      BATCH_ID,
      "第三批反馈可靠性",
      [
        {
          id: IMAGE_ID,
          title: "反馈图片",
          type: "image",
          content: {
            type: "image",
            mediaId: image.mediaId,
            naturalWidth: image.metadata.width,
            naturalHeight: image.metadata.height,
          },
          provenanceTags: PROVENANCE,
        },
        {
          id: TEXT_ID,
          title: "反馈语料",
          type: "text",
          content: {
            type: "text",
            entryId: "entry-r3",
            title: "反馈语料",
            speakerOrContext: "旁白",
            text: "第一段落包含重复短语。第二段落也有重复短语。\n第三行包含 emoji 🙂。",
          },
          provenanceTags: PROVENANCE,
        },
      ],
      "r3-ingest",
    );
    expect(ingested.acceptedItemIds.sort()).toEqual([IMAGE_ID, TEXT_ID].sort());
    await switchToWorkbench(launched.page);
    await launched.page
      .getByTestId("workbench-tree-panel")
      .getByText("反馈图片", { exact: true })
      .first()
      .waitFor({ timeout: 15_000 });
  }, 180_000);

  test("two issues save independently, repeat saves upsert, geometry writes no feedback", async () => {
    const page = launched.page;
    await selectTreeItem(page, "反馈图片");
    await waitForImageStage(page);
    const stage = page.getByTestId("image-stage");

    const draw = async (
      x1p: number,
      y1p: number,
      x2p: number,
      y2p: number,
    ): Promise<void> => {
      const box = await stage.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.move(box!.x + box!.width * x1p, box!.y + box!.height * y1p);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width * x2p, box!.y + box!.height * y2p, {
        steps: 8,
      });
      await page.mouse.up();
    };

    await draw(0.18, 0.2, 0.38, 0.4);
    const panel = page.getByTestId("workbench-issue-panel");
    await panel.getByTestId("workbench-issue-card").first().waitFor({ timeout: 10_000 });
    expect(await panel.getByTestId("workbench-issue-card").count()).toBe(1);

    // Drawing is a content edit only: no implicit feedback record.
    let state = await readProjectState(agent, identity);
    expect(feedbackFor(state, IMAGE_ID)).toHaveLength(0);

    const textarea = panel.getByLabel("问题建议");
    await textarea.fill("第一条建议");
    await panel.getByRole("button", { name: /母版/ }).click();
    await panel.getByTestId("workbench-issue-save").click();
    await page.getByText(/反馈已保存/).first().waitFor({ state: "visible", timeout: 15_000 });

    await draw(0.55, 0.2, 0.75, 0.4);
    await panel.getByTestId("workbench-issue-card").nth(1).waitFor({ timeout: 10_000 });
    expect(await panel.getByTestId("workbench-issue-card").count()).toBe(2);
    await textarea.fill("第二条建议");
    await panel.getByRole("button", { name: /边缘清理/ }).click();
    await panel.getByTestId("workbench-issue-save").click();
    await page.getByText(/反馈已保存/).first().waitFor({ state: "visible", timeout: 15_000 });

    state = await readProjectState(agent, identity);
    const item = state.project.workbench.items.find((candidate) => candidate.id === IMAGE_ID)!;
    const annotations = imageAnnotations(item);
    expect(annotations).toHaveLength(2);
    let records = feedbackFor(state, IMAGE_ID);
    expect(records).toHaveLength(2);
    expect(records[0].text).toContain("第一条建议");
    expect(records[0].referencedTagIds).toContain(MASTER_TAG);
    expect(records[0].target).toMatchObject({
      kind: "pixel-region",
      annotationId: annotations[0].id,
    });
    expect(records[1].text).toContain("第二条建议");
    expect(records[1].referencedTagIds).toContain(EDGE_TAG);
    expect(records[1].target).toMatchObject({
      kind: "pixel-region",
      annotationId: annotations[1].id,
    });

    // Re-open issue #1 and update it: still exactly two records.
    await panel.getByTestId("workbench-issue-card").nth(0).click();
    await textarea.waitFor();
    expect(await textarea.inputValue()).toContain("第一条建议");
    await expect(panel.getByTestId("workbench-issue-saved-state").isVisible()).resolves.toBe(true);
    await textarea.fill("第一条建议（更新）");
    await panel.getByTestId("workbench-issue-save").click();
    await page.getByText(/反馈已保存/).first().waitFor({ state: "visible", timeout: 15_000 });

    state = await readProjectState(agent, identity);
    records = feedbackFor(state, IMAGE_ID);
    expect(records).toHaveLength(2);
    expect(records[0].text).toContain("第一条建议（更新）");
    expect(records[1].text).toContain("第二条建议");

    const shot = await evidence.screenshot("01-two-issues-saved");
    evidence.record("twoIssues", {
      annotations,
      records,
      shot,
    });
  }, 180_000);

  test("one undo and redo restore annotation + feedback + rework together", async () => {
    const page = launched.page;
    const panel = page.getByTestId("workbench-issue-panel");
    await panel.getByTestId("workbench-issue-card").nth(0).click();
    const textarea = panel.getByLabel("问题建议");
    await textarea.fill("返工建议");
    await panel.getByTestId("workbench-issue-rework").click();
    await page.getByText(/反馈已保存/).first().waitFor({ state: "visible", timeout: 15_000 });

    const reworked = await waitForItem(agent, identity, IMAGE_ID, (item) => item.status === "rework");
    expect(imageAnnotations(reworked)[0].label).toContain("返工建议");
    let state = await readProjectState(agent, identity);
    expect(feedbackFor(state, IMAGE_ID)[0].text).toContain("返工建议");

    // One history entry: undo the whole save (annotation + feedback + rework).
    await page.getByTitle("撤销上一次决定(宿主历史)").click();
    const undone = await waitForItem(agent, identity, IMAGE_ID, (item) => item.status === "pending");
    expect(imageAnnotations(undone)[0].label).toContain("第一条建议（更新）");
    state = await readProjectState(agent, identity);
    expect(feedbackFor(state, IMAGE_ID)[0].text).toContain("第一条建议（更新）");

    const redoShot = await evidence.screenshot("02-undo-restored");
    await page.getByTestId("workbench-redo").click();
    const redone = await waitForItem(agent, identity, IMAGE_ID, (item) => item.status === "rework");
    expect(imageAnnotations(redone)[0].label).toContain("返工建议");
    state = await readProjectState(agent, identity);
    expect(feedbackFor(state, IMAGE_ID)[0].text).toContain("返工建议");

    evidence.record("undoRedo", {
      reworkedStatus: reworked.status,
      undoneStatus: undone.status,
      redoneStatus: redone.status,
      annotations: imageAnnotations(redone),
      redoShot,
    });
  }, 120_000);

  test("text range uses the second repeated phrase, tag ids, and keeps its version", async () => {
    const page = launched.page;
    await selectTreeItem(page, "反馈语料");
    const body = page.locator(`[data-testid='text-body'][data-item-id='${TEXT_ID}']`);
    await body.waitFor({ timeout: 15_000 });

    const selectionInfo = await body.evaluate((element) => {
      const text = element.textContent ?? "";
      const start = text.lastIndexOf("重复短语");
      const node = element.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) {
        throw new Error("text body is not a single text node");
      }
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 4);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return { start, quoted: text.slice(start, start + 4) };
    });
    expect(selectionInfo.quoted).toBe("重复短语");

    const floatingInput = page.getByPlaceholder(/输入针对该字符区间的修改建议/);
    await floatingInput.waitFor({ timeout: 10_000 });
    await floatingInput.fill("第二处重复短语建议压缩");
    await page.getByRole("button", { name: /母版/ }).click();
    await page.getByRole("button", { name: /锚定区间批注/ }).click();
    await page.waitForTimeout(400);

    let state = await readProjectState(agent, identity);
    const comment = state.project.workbench.feedback.find(
      (record) => record.itemId === TEXT_ID && record.target?.kind === "text-range",
    );
    expect(comment).toBeDefined();
    expect(comment!.target).toMatchObject({
      kind: "text-range",
      version: 1,
      startOffset: selectionInfo.start,
      endOffset: selectionInfo.start + 4,
    });
    expect(comment!.referencedTagIds).toEqual([MASTER_TAG]);
    const shot = await evidence.screenshot("03-text-range-second-phrase");

    // Save a text revision: the old comment stays bound to v1.
    await page.getByRole("button", { name: "直接改文" }).first().click();
    const editor = page.getByTestId("workbench-content").locator("textarea").first();
    await editor.fill("第一段落包含重复短语。第二段落也有重复短语。\n第三行包含 emoji 🙂。修订版");
    await page.getByRole("button", { name: /保存修改/ }).first().click();
    const revised = await waitForItem(agent, identity, TEXT_ID, (item) => item.version === 2);
    expect(revised.version).toBe(2);
    state = await readProjectState(agent, identity);
    const stored = state.project.workbench.feedback.find((record) => record.id === comment!.id)!;
    expect(stored.target).toMatchObject({ kind: "text-range", version: 1 });
    await page.getByText(/旧版本批注/).first().waitFor({ state: "visible", timeout: 10_000 });

    evidence.record("textRange", {
      selectionInfo,
      comment,
      revisedVersion: revised.version,
      storedTarget: stored.target,
      shot,
    });
  }, 180_000);

  test("unresolved tag references are surfaced and preserved on save", async () => {
    const page = launched.page;
    await selectTreeItem(page, "反馈图片");
    await waitForImageStage(page);
    const state = await readProjectState(agent, identity);
    const item = state.project.workbench.items.find((candidate) => candidate.id === IMAGE_ID)!;
    const annotation = imageAnnotations(item)[0];

    const injected = await applyOp(agent, identity, [
      {
        op: "workbench.feedback.save",
        feedback: {
          id: "fb-r3-unresolved",
          itemId: IMAGE_ID,
          itemVersion: item.version,
          text: "未知来源引用",
          referencedTagIds: ["missing-tag"],
          target: {
            kind: "pixel-region",
            annotationId: annotation.id,
            x: 0.2,
            y: 0.3,
            w: 0.2,
            h: 0.2,
          },
          state: "confirmed",
        },
      },
    ]);
    expect(injected.ok).toBe(true);
    await page.waitForTimeout(500);

    const panel = page.getByTestId("workbench-issue-panel");
    await panel.getByTestId("workbench-issue-card").nth(0).click();
    const unresolved = panel.getByTestId("workbench-issue-unresolved-tag");
    await unresolved.waitFor({ timeout: 10_000 });
    expect(await unresolved.textContent()).toContain("引用失效");
    const shot = await evidence.screenshot("04-unresolved-tag");

    await panel.getByTestId("workbench-issue-save").click();
    await page.getByText(/反馈已保存/).first().waitFor({ state: "visible", timeout: 15_000 });
    const after = await readProjectState(agent, identity);
    const savedRecord = feedbackFor(after, IMAGE_ID).find(
      (record) => record.id === "fb-r3-unresolved",
    );
    expect(savedRecord).toBeDefined();
    expect(savedRecord!.referencedTagIds).toContain("missing-tag");

    evidence.record("unresolvedTag", {
      injected: injected.value,
      savedRecord,
      shot,
    });
    evidence.flush();
  }, 120_000);
});
