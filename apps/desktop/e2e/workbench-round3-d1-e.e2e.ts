import { switchToWorkbench, selectTreeItem } from "./harness/workbench-fixtures";
/**
 * Round 3 batch D1 + E: explicit per-cell data rework, execution-level handoff
 * snapshots, member-scoped supersede, partial rework returns, expiry rejection
 * and save/reopen. Real GUI mouse input + independent CLI reads; no fabricated
 * counts and no user instance.
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
  applyOp,
  currentRevision,
  ingestBatch,
  readIdentity,
  readProjectState,
  waitForStableWorkspace,
  type WorkbenchIdentity,
} from "./harness/workbench-fixtures";

const PROJECT_NAME = "Horizontal";
const BATCH_ID = "r3-d1e-batch";
const ITEM_A = "r3-data-a";
const ITEM_B = "r3-data-b";

interface StoredFeedback {
  id: string;
  itemId: string;
  itemVersion: number;
  text: string;
  intent?: string;
  state: string;
  clearedBy?: string;
  target?: Record<string, unknown>;
}

interface StoredHandoffItem {
  itemId: string;
  itemVersion: number;
  decision: string;
  decisionRevision: number;
  issues?: Array<{
    feedbackId: string;
    issueId: string;
    itemVersion: number;
    intent: string;
    text: string;
    target: Record<string, unknown>;
    referencedTags: unknown[];
  }>;
  videoMarkers?: unknown;
  imageAnnotations?: unknown;
}

interface StoredHandoff {
  handoffId: string;
  snapshotSchemaVersion?: number;
  supersedesHandoffId?: string;
  deliveryState: string;
  returnedItemIds?: string[];
  items: StoredHandoffItem[];
}

function dataContent(
  datasetId: string,
  rows: Array<{ rowId: string; value: string }>,
  proposal?: {
    proposalId: string;
    rowId: string;
    originalValue: string;
    proposedValue: string;
  },
): Record<string, unknown> {
  return {
    type: "data",
    datasetId,
    columns: [{ columnId: "c1", title: "名称" }],
    rows: rows.map((row) => ({ rowId: row.rowId, cells: { c1: row.value } })),
    proposals: proposal
      ? [
          {
            proposalId: proposal.proposalId,
            rowId: proposal.rowId,
            columnId: "c1",
            originalValue: proposal.originalValue,
            proposedValue: proposal.proposedValue,
            reason: "清洗测试",
            provenanceTagId: "prov-test",
            status: "proposed",
          },
        ]
      : [],
  };
}

function reworkContent(
  datasetId: string,
  rows: Array<{ rowId: string; value: string }>,
  proposals: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    type: "data",
    datasetId,
    columns: [{ columnId: "c1", title: "名称" }],
    rows: rows.map((row) => ({ rowId: row.rowId, cells: { c1: row.value } })),
    proposals: proposals.map((proposal) => ({ ...proposal })),
  };
}



async function itemState(
  agent: ExternalAgent,
  identity: WorkbenchIdentity,
  itemId: string,
): Promise<Awaited<ReturnType<typeof readProjectState>>["project"]["workbench"]["items"][number]> {
  const state = await readProjectState(agent, identity);
  const item = state.project.workbench.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`item ${itemId} missing`);
  return item;
}

async function handoffs(
  agent: ExternalAgent,
  identity: WorkbenchIdentity,
): Promise<StoredHandoff[]> {
  const state = await readProjectState(agent, identity);
  return (state.project.workbench as unknown as { handoffs?: StoredHandoff[] }).handoffs ?? [];
}

async function waitForHandoffCount(
  agent: ExternalAgent,
  identity: WorkbenchIdentity,
  count: number,
  timeoutMs = 15_000,
): Promise<StoredHandoff[]> {
  const deadline = Date.now() + timeoutMs;
  let current = await handoffs(agent, identity);
  while (current.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    current = await handoffs(agent, identity);
  }
  expect(current.length).toBeGreaterThanOrEqual(count);
  return current;
}

async function markTwoCellsRework(page: LaunchedApp["page"], firstValue: string, secondValue: string): Promise<void> {
  await page.getByText(firstValue, { exact: true }).and(page.locator("td:visible span.text-fg")).click();
  await page.getByText(secondValue, { exact: true }).and(page.locator("td:visible span.text-fg")).click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  await page.getByTestId("workbench-data-mark-rework").click();
}

async function publishFromDialog(page: LaunchedApp["page"], expectedCount: number): Promise<void> {
  await page.getByRole("button", { name: /发布审阅结果/ }).click();
  const publish = page.getByRole("button", {
    name: new RegExp(`(?:发布|更新)交接结果.*${expectedCount} 项`),
  });
  await publish.waitFor({ timeout: 10_000 });
  await publish.click();
  await page.getByRole("button", { name: "关闭窗口" }).click();
  await page.waitForTimeout(400);
}

describe("workbench round 3 D1+E: data rework and execution-level handoff", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  let identity: WorkbenchIdentity;
  let evidence: EvidenceRecord;
  let firstHandoffId = "";
  let firstHandoffItems = "";
  let secondHandoffId = "";

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
    evidence = createEvidence("workbench-round3-d1-e", launched.page);
  }, 300_000);

  afterAll(async () => {
    evidence?.flush();
    await agent?.close();
    await launched?.close();
  });

  test("explicit two-cell rework changes no values and publishes execution issues", async () => {
    const page = launched.page;
    await ingestBatch(
      agent,
      identity,
      BATCH_ID,
      "第三轮数据返工",
      [
        {
          id: ITEM_A,
          title: "数据 A",
          type: "data",
          content: dataContent(
            "ds-a",
            [
              { rowId: "a1", value: "A初值一" },
              { rowId: "a2", value: "A初值二" },
            ],
            { proposalId: "p-a", rowId: "a1", originalValue: "A初值一", proposedValue: "A建议" },
          ),
        },
        {
          id: ITEM_B,
          title: "数据 B",
          type: "data",
          content: dataContent(
            "ds-b",
            [
              { rowId: "b1", value: "B初值一" },
              { rowId: "b2", value: "B初值二" },
            ],
            { proposalId: "p-b", rowId: "b1", originalValue: "B初值一", proposedValue: "B建议" },
          ),
        },
      ],
      "r3-d1e-ingest",
    );

    await switchToWorkbench(page);
    await selectTreeItem(page, "数据 A");
    const itemABefore = await itemState(agent, identity, ITEM_A);
    await markTwoCellsRework(page, "A初值一", "A初值二");
    await page.getByTestId("workbench-data-rework-badge").first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);

    let state = await readProjectState(agent, identity);
    let itemA = state.project.workbench.items.find((candidate) => candidate.id === ITEM_A)!;
    expect(itemA.version).toBe(itemABefore.version);
    expect(itemA.status).toBe("rework");
    const feedbackA = state.project.workbench.feedback.filter(
      (record) => record.itemId === ITEM_A,
    ) as StoredFeedback[];
    expect(feedbackA).toHaveLength(2);
    expect(feedbackA.every((record) => record.intent === "rework" && record.state === "confirmed")).toBe(true);
    expect(feedbackA.map((record) => record.target)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "data-cell", rowId: "a1", columnId: "c1", proposalId: "p-a" }),
        expect.objectContaining({ kind: "data-cell", rowId: "a2", columnId: "c1" }),
      ]),
    );
    // Values and proposals are untouched by a rework marker.
    expect(itemA.content).toEqual(itemABefore.content);
    const shotMarked = await evidence.screenshot("01-two-cells-marked");

    // Mark B too, then publish H1 with both items.
    await selectTreeItem(page, "数据 B");
    await markTwoCellsRework(page, "B初值一", "B初值二");
    await page.waitForTimeout(300);
    await publishFromDialog(page, 2);
    const published = await waitForHandoffCount(agent, identity, 1);
    const h1 = published[0];
    firstHandoffId = h1.handoffId;
    firstHandoffItems = JSON.stringify(h1.items);
    expect(h1.snapshotSchemaVersion).toBe(2);
    expect(h1.items.map((item) => item.itemId).sort()).toEqual([ITEM_A, ITEM_B]);
    const issueA = h1.items.find((item) => item.itemId === ITEM_A)?.issues ?? [];
    expect(issueA).toHaveLength(2);
    expect(issueA.map((issue) => issue.issueId).sort()).toEqual([
      "cell-2:a1:c1",
      "cell-2:a2:c1",
    ]);
    expect(issueA.every((issue) => issue.intent === "rework" && issue.itemVersion === 1)).toBe(true);
    const shotPublished = await evidence.screenshot("02-published-execution-issues");

    // Agent reads the same immutable snapshot through the formal read verb.
    const read = await agent.callCommand<{ handoff?: StoredHandoff }>("workbench.handoff.get", {
      snapshotId: firstHandoffId,
    });
    expect(read.ok).toBe(true);
    expect(read.value?.handoff?.items.map((item) => item.itemId).sort()).toEqual([ITEM_A, ITEM_B]);
    expect(JSON.stringify(read.value?.handoff?.items)).toBe(firstHandoffItems);
    const latest = await agent.callCommand<{ latest?: { snapshotId: string } }>(
      "workbench.handoff.get",
      {},
    );
    expect(latest.ok).toBe(true);
    expect(latest.value?.latest?.snapshotId).toBe(firstHandoffId);

    evidence.record("markAndPublish", {
      itemAVersion: itemA.version,
      feedbackA,
      handoff: h1,
      read: read.value,
      shotMarked,
      shotPublished,
    });
  }, 240_000);

  test("A returns alone, B stays executable, and stale/superseded results are rejected", async () => {
    const beforeA = await itemState(agent, identity, ITEM_A);
    const proposalsA =
      (beforeA.content as { proposals?: unknown[] }).proposals ?? [];
    const returnA = await applyOp(agent, identity, [
      {
        op: "workbench.rework",
        handoffId: firstHandoffId,
        results: [
          {
            sourceItemId: ITEM_A,
            previousVersion: beforeA.version,
            content: reworkContent(
              "ds-a",
              [
                { rowId: "a1", value: "A返工一" },
                { rowId: "a2", value: "A返工二" },
              ],
              proposalsA as Record<string, unknown>[],
            ),
            reworkSummary: "A 按两格反馈返工",
          },
        ],
      },
    ]);
    expect(returnA.ok).toBe(true);

    let itemA = await itemState(agent, identity, ITEM_A);
    expect(itemA.version).toBe(2);
    expect(itemA.status).toBe("pending");
    let current = await handoffs(agent, identity);
    let h1 = current.find((handoff) => handoff.handoffId === firstHandoffId)!;
    expect(h1.returnedItemIds).toEqual([ITEM_A]);
    expect(h1.deliveryState).not.toBe("rework_returned");

    // The duplicate return must not bump the version or overwrite the result.
    const duplicate = await applyOp(agent, identity, [
      {
        op: "workbench.rework",
        handoffId: firstHandoffId,
        results: [
          {
            sourceItemId: ITEM_A,
            previousVersion: 2,
            content: reworkContent("ds-a", [
              { rowId: "a1", value: "覆盖" },
              { rowId: "a2", value: "覆盖" },
            ]),
          },
        ],
      },
    ]);
    expect(duplicate.ok).toBe(false);
    expect((await itemState(agent, identity, ITEM_A)).version).toBe(2);

    // A supplementary note changes the snapshot content for H2.
    const note = await applyOp(agent, identity, [
      {
        op: "workbench.feedback.save",
        feedback: {
          id: "fb-b-note",
          itemId: ITEM_B,
          itemVersion: 1,
          text: "B 的补充说明",
          referencedTagIds: ["missing-prov"],
          target: { kind: "whole-item" },
          state: "confirmed",
        },
      },
    ]);
    expect(note.ok).toBe(true);
    await publishFromDialog(launched.page, 1);
    current = await waitForHandoffCount(agent, identity, 2);
    const h2 = current[0];
    secondHandoffId = h2.handoffId;
    expect(h2.items.map((item) => item.itemId)).toEqual([ITEM_B]);
    expect(h2.supersedesHandoffId).toBe(firstHandoffId);
    expect(h2.items[0].issues?.some((issue) => issue.feedbackId === "fb-b-note")).toBe(true);
    expect(h2.items[0].issues?.find((issue) => issue.feedbackId === "fb-b-note")?.referencedTags).toEqual([
      { id: "missing-prov", referenceState: "unresolved", raw: "missing-prov" },
    ]);
    // H1 content is immutable even though H2 supersedes it for B.
    h1 = current.find((handoff) => handoff.handoffId === firstHandoffId)!;
    expect(JSON.stringify(h1.items)).toBe(firstHandoffItems);

    // B's OLD task (H1) is superseded; A's already-returned task is closed.
    const staleB = await applyOp(agent, identity, [
      {
        op: "workbench.rework",
        handoffId: firstHandoffId,
        results: [
          {
            sourceItemId: ITEM_B,
            previousVersion: 1,
            content: reworkContent("ds-b", [
              { rowId: "b1", value: "B返工一" },
              { rowId: "b2", value: "B返工二" },
            ]),
          },
        ],
      },
    ]);
    expect(staleB.ok).toBe(false);
    const staleA = await applyOp(agent, identity, [
      {
        op: "workbench.rework",
        handoffId: firstHandoffId,
        results: [
          {
            sourceItemId: ITEM_A,
            previousVersion: 1,
            content: reworkContent("ds-a", [
              { rowId: "a1", value: "迟到" },
              { rowId: "a2", value: "迟到" },
            ]),
          },
        ],
      },
    ]);
    expect(staleA.ok).toBe(false);
    const shotSuperseded = await evidence.screenshot("03-superseded-and-partial");

    // B returns through H2 → H2 completes; H1 (A returned, B superseded)
    // never claims a false "all returned" state.
    const returnB = await applyOp(agent, identity, [
      {
        op: "workbench.rework",
        handoffId: secondHandoffId,
        results: [
          {
            sourceItemId: ITEM_B,
            previousVersion: 1,
            content: reworkContent("ds-b", [
              { rowId: "b1", value: "B返工一" },
              { rowId: "b2", value: "B返工二" },
            ]),
          },
        ],
      },
    ]);
    expect(returnB.ok).toBe(true);
    const itemB = await itemState(agent, identity, ITEM_B);
    expect(itemB.version).toBe(2);
    expect(itemB.status).toBe("pending");
    current = await handoffs(agent, identity);
    const h2After = current.find((handoff) => handoff.handoffId === secondHandoffId)!;
    expect(h2After.deliveryState).toBe("rework_returned");
    expect(h2After.returnedItemIds).toEqual([ITEM_B]);
    const h1After = current.find((handoff) => handoff.handoffId === firstHandoffId)!;
    expect(h1After.returnedItemIds).toEqual([ITEM_A]);
    expect(h1After.deliveryState).not.toBe("rework_returned");

    evidence.record("partialAndSupersede", {
      itemA: { version: itemA.version, status: itemA.status },
      itemB: { version: itemB.version, status: itemB.status },
      h1: h1After,
      h2: h2After,
      duplicate,
      staleA,
      staleB,
      shotSuperseded,
    });
  }, 240_000);

  test("accepting one cell keeps the other rework executable through a new handoff", async () => {
    const page = launched.page;
    await ingestBatch(agent, identity, "partial-accept-batch", "部分接受回归", [{
      id: "partial-accept-item", title: "部分接受数据", type: "data",
      content: dataContent("partial-ds", [
        { rowId: "r1", value: "部分原值" }, { rowId: "r2", value: "剩余原值" },
      ], { proposalId: "partial-p", rowId: "r1", originalValue: "部分原值", proposedValue: "部分新值" }),
    }], "partial-accept-ingest");
    await page.getByTestId("workbench-batch-select").click();
    await page.getByRole("menuitemradio", { name: "部分接受回归", exact: true }).click();
    await selectTreeItem(page, "部分接受数据");
    await markTwoCellsRework(page, "部分原值", "剩余原值");
    await page.getByText("部分原值", { exact: true }).and(page.locator("td:visible span.text-fg")).click();
    await page.getByRole("button", { name: "确认建议 (1 项)", exact: true }).click();
    await expect.poll(async () => (await itemState(agent, identity, "partial-accept-item")).version).toBe(2);
    expect((await itemState(agent, identity, "partial-accept-item")).status).toBe("rework");
    await publishFromDialog(page, 1);
    const published = (await handoffs(agent, identity)).find((h) => h.items.some((i) => i.itemId === "partial-accept-item"))!;
    expect(published.items[0].decision).toBe("rework");
    expect(published.items[0].issues?.filter((issue) => issue.intent === "rework")).toHaveLength(1);
    const returned = await applyOp(agent, identity, [{
      op: "workbench.rework", handoffId: published.handoffId,
      results: [{ sourceItemId: "partial-accept-item", previousVersion: 2,
        content: reworkContent("partial-ds", [
          { rowId: "r1", value: "部分新值" }, { rowId: "r2", value: "剩余返工完成" },
        ]),
      }],
    }]);
    expect(returned.ok).toBe(true);
    expect((await itemState(agent, identity, "partial-accept-item")).status).toBe("pending");
    evidence.record("partialAccept", { published, returned });
    await page.getByTestId("workbench-batch-select").click();
    await page.getByRole("menuitemradio", { name: "第三轮数据返工", exact: true }).click();
  }, 180_000);

  test("save + relaunch keeps rework results and immutable snapshots readable", async () => {
    const revision = await currentRevision(agent);
    const saved = await agent.callCommand("project.save", {
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      expectedRevision: revision,
      idempotencyKey: "r3-d1e-save",
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

    const itemA = await itemState(agent, identity, ITEM_A);
    const itemB = await itemState(agent, identity, ITEM_B);
    expect(itemA.version).toBe(2);
    expect(itemB.version).toBe(2);
    expect(itemA.status).toBe("pending");
    expect(itemB.status).toBe("pending");

    const reopened = await agent.callCommand<{ handoff?: StoredHandoff }>(
      "workbench.handoff.get",
      { snapshotId: firstHandoffId },
    );
    expect(reopened.ok).toBe(true);
    expect(JSON.stringify(reopened.value?.handoff?.items)).toBe(firstHandoffItems);
    expect(reopened.value?.handoff?.returnedItemIds).toEqual([ITEM_A]);
    const second = await agent.callCommand<{ handoff?: StoredHandoff }>(
      "workbench.handoff.get",
      { snapshotId: secondHandoffId },
    );
    expect(second.ok).toBe(true);
    expect(second.value?.handoff?.deliveryState).toBe("rework_returned");
    expect(second.value?.handoff?.returnedItemIds).toEqual([ITEM_B]);

    await switchToWorkbench(launched.page);
    await selectTreeItem(launched.page, "数据 A");
    const shotReopen = await evidence.screenshot("04-reopened-data");
    evidence.record("reopen", {
      itemA: { version: itemA.version, status: itemA.status },
      itemB: { version: itemB.version, status: itemB.status },
      h1Returned: reopened.value?.handoff?.returnedItemIds,
      h2State: second.value?.handoff?.deliveryState,
      shotReopen,
    });
    evidence.flush();
  }, 300_000);
});
